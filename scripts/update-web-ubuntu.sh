#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

source_dir=
release_id=

while (($#)); do
  case "$1" in
    --source) source_dir=${2:?}; shift 2 ;;
    --release-id) release_id=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: sudo scripts/update-web-ubuntu.sh --source DIR --release-id ID\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
for command in python3 readlink realpath rm uname cp install chown chmod find grep mv ln; do
  require_command "$command"
done
validate_release_id "$release_id"
source_dir=$(canonical_existing_dir "${source_dir:?--source is required}")
case "$(uname -m)" in
  x86_64) target=linux-x64 ;;
  aarch64) target=linux-arm64 ;;
  *) die 'unsupported CPU architecture' ;;
esac
bash "$SCRIPT_DIR/prepare-package.sh" --verify "$source_dir" --arch "$target" || \
  die 'package verification failed'

backend_release=$(readlink -f /opt/codex-web-ui/current) || die 'current backend release link is missing'
case "$backend_release" in /opt/codex-web-ui/releases/*) ;; *) die 'current backend release escapes release directory' ;; esac
[[ -f $backend_release/release.json && ! -L $backend_release/release.json ]] || \
  die 'current backend release has no trusted manifest; install one full release before web-only updates'

SOURCE_MANIFEST="$source_dir/release.json" BACKEND_MANIFEST="$backend_release/release.json" python3 - <<'PY'
import json
import os

with open(os.environ["SOURCE_MANIFEST"], encoding="utf-8") as source_file:
    source = json.load(source_file)
with open(os.environ["BACKEND_MANIFEST"], encoding="utf-8") as backend_file:
    backend = json.load(backend_file)
source_version = source.get("apiCompatibility")
backend_version = backend.get("apiCompatibility")
if not isinstance(source_version, int) or not isinstance(backend_version, int):
    raise SystemExit("web-only update requires apiCompatibility in both manifests")
if source_version != backend_version:
    raise SystemExit(
        f"web/API compatibility mismatch: web={source_version}, backend={backend_version}; use a full drained update"
    )
PY

config=/etc/codex-web-ui/codex-web-ui.env
[[ -f $config && ! -L $config ]] || die 'installed configuration is missing or unsafe'
python3 "$SCRIPT_DIR/storage-guard.py" --config "$config" --check-releases --additional-releases 1

release_dir="/opt/codex-web-ui/releases/$release_id"
[[ ! -e $release_dir ]] || die "release already exists: $release_dir"
previous_web=$(readlink -f /opt/codex-web-ui/web-current 2>/dev/null || true)
if [[ -z $previous_web ]]; then previous_web="$backend_release/apps/web/dist"; fi
case "$previous_web" in /opt/codex-web-ui/releases/*/apps/web/dist) ;; *) die 'current web release escapes release directory' ;; esac
[[ -f $previous_web/index.html ]] || die 'current web release is incomplete'

activation_complete=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! $activation_complete; then
    if [[ -L /opt/codex-web-ui/web-current ]]; then
      atomic_symlink "$previous_web" /opt/codex-web-ui/web-current || true
    fi
    case "$release_dir" in
      /opt/codex-web-ui/releases/*)
        if [[ -d $release_dir && ! -L $release_dir ]]; then rm -rf --one-file-system -- "$release_dir"; fi
        ;;
      *) printf 'Refusing unsafe web-release cleanup: %s\n' "$release_dir" >&2 ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

copy_release "$source_dir" "$release_dir"
printf '%s\n' "$previous_web" >/var/lib/codex-web-ui/previous-web-release
chown root:root /var/lib/codex-web-ui/previous-web-release
chmod 0600 /var/lib/codex-web-ui/previous-web-release
atomic_symlink "$release_dir/apps/web/dist" /opt/codex-web-ui/web-current

activated=$(readlink -f /opt/codex-web-ui/web-current) || die 'web release link cannot be resolved'
[[ $activated == "$release_dir/apps/web/dist" && -f $activated/index.html ]] || \
  die 'web release activation verification failed'
[[ $(readlink -f /opt/codex-web-ui/current) == "$backend_release" ]] || \
  die 'web-only update changed the backend release'

activation_complete=true
trap - EXIT INT TERM
printf 'Updated Web UI only to %s. Backend remained at %s. Previous Web UI retained at %s.\n' \
  "$release_id" "${backend_release##*/}" "$previous_web"
