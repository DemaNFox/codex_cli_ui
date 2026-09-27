#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

codex_bin=
bwrap_bin=
profile_path=/etc/apparmor.d/codex-web-ui
template="$REPO_ROOT/infra/apparmor/codex-web-ui.template"
temporary=
backup=

usage() {
  cat <<'EOF'
Usage: sudo scripts/install-apparmor.sh --codex-bin FILE [--bwrap-bin FILE]

Installs and loads exact-path AppArmor userns exceptions for the native Codex
executable and bubblewrap. Both files must be root-owned executables and must
not be writable by group or other. The script does not weaken global AppArmor
or unprivileged-userns policy.
EOF
}

while (($#)); do
  case "$1" in
    --codex-bin) codex_bin=${2:?}; shift 2 ;;
    --bwrap-bin) bwrap_bin=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
for command in apparmor_parser install mktemp readelf realpath stat; do
  require_command "$command"
done
[[ -r $template && -f $template && ! -L $template ]] || die "AppArmor template is missing: $template"

validate_root_parent_chain() {
  local label=${1:?label required} path=${2:?path required} parent owner mode
  parent=${path%/*}
  [[ -n $parent ]] || parent=/
  while :; do
    [[ -d $parent && ! -L $parent ]] || die "$label parent must be a non-symlink directory: $parent"
    owner=$(stat -Lc '%u' -- "$parent")
    [[ $owner == 0 ]] || die "$label parent must be owned by root: $parent"
    mode=$(stat -Lc '%a' -- "$parent")
    (( (8#$mode & 8#022) == 0 )) || die "$label parent must not be writable by group or other: $parent"
    [[ $parent == / ]] && break
    parent=${parent%/*}
    [[ -n $parent ]] || parent=/
  done
}

validate_root_executable() {
  local label=${1:?label required} input=${2:?path required} path owner mode
  path=$(canonical_existing_file "$input")
  [[ $path =~ ^/[A-Za-z0-9._/@+-]+$ ]] || die "$label path contains unsupported AppArmor characters: $path"
  [[ -x $path ]] || die "$label is not executable: $path"
  readelf -h -- "$path" >/dev/null 2>&1 || die "$label must be a native ELF executable: $path"
  owner=$(stat -Lc '%u' -- "$path")
  [[ $owner == 0 ]] || die "$label must be owned by root: $path"
  mode=$(stat -Lc '%a' -- "$path")
  (( (8#$mode & 8#022) == 0 )) || die "$label must not be writable by group or other: $path"
  validate_root_parent_chain "$label" "$path"
  printf '%s\n' "$path"
}

codex_bin=$(validate_root_executable 'Codex executable' "${codex_bin:?--codex-bin is required}")
if [[ -z $bwrap_bin ]]; then
  bwrap_bin=$(command -v bwrap || true)
  [[ -n $bwrap_bin ]] || die 'bwrap was not found; pass --bwrap-bin FILE'
fi
bwrap_bin=$(validate_root_executable 'bwrap executable' "$bwrap_bin")
[[ $codex_bin != "$bwrap_bin" ]] || die 'Codex and bwrap executable paths must differ'

cleanup() {
  [[ -z ${temporary:-} || ! -e $temporary ]] || rm -f -- "$temporary"
  [[ -z ${backup:-} || ! -e $backup ]] || rm -f -- "$backup"
}
trap cleanup EXIT

temporary=$(mktemp /etc/apparmor.d/codex-web-ui.new.XXXXXX)
chmod 0644 "$temporary"
sed \
  -e "s|@@CODEX_BIN@@|$codex_bin|g" \
  -e "s|@@BWRAP_BIN@@|$bwrap_bin|g" \
  "$template" >"$temporary"
chown root:root "$temporary"

# Parse completely before replacing the active policy on disk.
apparmor_parser -Q "$temporary"

if [[ -e $profile_path ]]; then
  [[ -f $profile_path && ! -L $profile_path ]] || die "installed profile is not a regular file: $profile_path"
  backup=$(mktemp /etc/apparmor.d/codex-web-ui.backup.XXXXXX)
  cp -a -- "$profile_path" "$backup"
fi

mv -f -- "$temporary" "$profile_path"
temporary=
if ! apparmor_parser -r "$profile_path"; then
  if [[ -n $backup ]]; then
    mv -f -- "$backup" "$profile_path"
    backup=
    apparmor_parser -r "$profile_path" || true
  else
    apparmor_parser -R "$profile_path" >/dev/null 2>&1 || true
    rm -f -- "$profile_path"
  fi
  die 'failed to load AppArmor profile; the previous installed profile was restored'
fi

rm -f -- "${backup:-}"
backup=
printf 'Installed AppArmor userns profiles for %s and %s.\n' "$codex_bin" "$bwrap_bin"
