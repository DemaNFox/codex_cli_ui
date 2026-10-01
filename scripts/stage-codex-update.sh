#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  sudo codex-web-ui-stage-codex-update --source /absolute/prepared/package --release-id RELEASE_ID
  sudo codex-web-ui-stage-codex-update --release-id EXISTING_RELEASE_ID

The source path is accepted only by this local root CLI. The browser and API
can select neither a path nor a release identifier.
EOF
}

source_dir=
release_id=
while (($#)); do
  case "$1" in
    --source) source_dir=${2:?--source requires a path}; shift 2 ;;
    --release-id) release_id=${2:?--release-id requires a value}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || { printf 'This command must run as root.\n' >&2; exit 1; }
[[ $release_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || {
  printf 'A safe --release-id is required.\n' >&2
  exit 1
}
for command in chmod chown cp find flock install ln mv python3 readlink realpath rm stat uname; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done

releases=/opt/codex-web-ui/releases
candidate_link=/opt/codex-web-ui/codex-update-candidate
target="$releases/$release_id"
stage="$releases/.codex-update-stage-$release_id.$$"
link_temporary="/opt/codex-web-ui/.codex-update-candidate.$$"
current=$(readlink -f -- /opt/codex-web-ui/current) || {
  printf 'Installed release is unavailable.\n' >&2
  exit 1
}
case "$current" in "$releases"/*) ;; *) printf 'Installed release escaped managed releases.\n' >&2; exit 1 ;; esac
for trusted_directory in "$releases" "$current"; do
  [[ -d $trusted_directory && ! -L $trusted_directory && $(stat -c '%u' "$trusted_directory") == 0 && $((8#$(stat -c '%a' "$trusted_directory") & 8#022)) == 0 ]] || {
    printf 'Installed release directory is missing or unsafe.\n' >&2
    exit 1
  }
done
verifier="$current/scripts/prepare-package.sh"
storage_guard="$current/scripts/storage-guard.py"
for trusted in "$verifier" "$storage_guard"; do
  [[ -f $trusted && ! -L $trusted && $(stat -c '%u' "$trusted") == 0 && $((8#$(stat -c '%a' "$trusted") & 8#022)) == 0 ]] || {
    printf 'Installed update verifier is missing or unsafe.\n' >&2
    exit 1
  }
done
case "$(uname -m)" in
  x86_64) target_arch=linux-x64 ;;
  aarch64) target_arch=linux-arm64 ;;
  *) printf 'Unsupported CPU architecture.\n' >&2; exit 1 ;;
esac

# Serialize copying with an in-flight update, and candidate-link replacement
# with broker reads. The worker uses the same two fixed lock files.
exec 7>/run/codex-web-ui/codex-update.lock
flock 7
exec 9>/run/codex-web-ui/codex-update-candidate.lock
flock 9

previous=$(readlink -- "$candidate_link" 2>/dev/null || true)
switched=false
created=false
committed=false
rollback_stage() {
  local status=$?
  rm -f -- "$link_temporary"
  if $switched && ! $committed; then
    if [[ -n $previous ]]; then
      ln -s -- "$previous" "$link_temporary"
      mv -Tf -- "$link_temporary" "$candidate_link"
    else
      rm -f -- "$candidate_link"
    fi
  fi
  case "$stage" in "$releases"/.codex-update-stage-*)
    if [[ -d $stage && ! -L $stage ]]; then rm -rf --one-file-system -- "$stage"; fi
    ;;
  esac
  if $created && ! $committed; then
    case "$target" in "$releases"/*)
      if [[ -d $target && ! -L $target ]]; then rm -rf --one-file-system -- "$target"; fi
      ;;
    esac
  fi
  exit "$status"
}
trap rollback_stage EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n $source_dir ]]; then
  [[ $source_dir = /* && -d $source_dir && ! -L $source_dir ]] || {
    printf 'Prepared package source must be an absolute real directory.\n' >&2
    exit 1
  }
  source_dir=$(realpath -e -- "$source_dir")
  case "$source_dir" in "$releases"|"$releases"/*)
    printf 'Use existing-release mode for a package already under managed releases.\n' >&2
    exit 1
    ;;
  esac
  [[ ! -e $target && ! -L $target ]] || { printf 'Release identifier already exists.\n' >&2; exit 1; }
  "$verifier" --verify "$source_dir" --arch "$target_arch" >/dev/null || {
    printf 'Prepared package source failed verification.\n' >&2
    exit 1
  }
  python3 "$storage_guard" \
    --config /etc/codex-web-ui/codex-web-ui.env \
    --check-releases \
    --additional-releases 1 >/dev/null
  install -d -m 0700 -o root -g root "$stage"
  cp -a --no-preserve=ownership -- "$source_dir/." "$stage/"
  chown -R root:root "$stage"
  chmod -R go-w "$stage"
  "$verifier" --verify "$stage" --arch "$target_arch" >/dev/null || {
    printf 'Copied package failed verification.\n' >&2
    exit 1
  }
  created=true
  mv -- "$stage" "$target"
else
  [[ -d $target && ! -L $target ]] || { printf 'Prepared release does not exist.\n' >&2; exit 1; }
fi

[[ $(stat -c '%u' "$target") == 0 && $((8#$(stat -c '%a' "$target") & 8#022)) == 0 ]] || {
  printf 'Prepared release ownership or mode is unsafe.\n' >&2
  exit 1
}
ln -s -- "$target" "$link_temporary"
mv -Tf -- "$link_temporary" "$candidate_link"
switched=true
if ! /usr/local/libexec/codex-web-ui-codex-update-broker --validate-candidate-path >/dev/null; then
  printf 'Prepared release failed verification and was not staged.\n' >&2
  exit 1
fi
committed=true
trap - EXIT INT TERM
printf 'Prepared Codex update: %s\n' "$release_id"
