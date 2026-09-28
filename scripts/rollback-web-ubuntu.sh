#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

release_id=
while (($#)); do
  case "$1" in
    --release-id) release_id=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: sudo scripts/rollback-web-ubuntu.sh [--release-id ID]\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
for command in readlink realpath chown chmod mv ln; do require_command "$command"; done
if [[ -n $release_id ]]; then
  validate_release_id "$release_id"
  target="/opt/codex-web-ui/releases/$release_id/apps/web/dist"
else
  [[ -r /var/lib/codex-web-ui/previous-web-release ]] || die 'no previous web release is recorded'
  target=$(< /var/lib/codex-web-ui/previous-web-release)
fi
target=$(canonical_existing_dir "$target")
case "$target" in /opt/codex-web-ui/releases/*/apps/web/dist) ;; *) die 'web rollback target escapes release directory' ;; esac
[[ -f $target/index.html ]] || die 'web rollback target is incomplete'

current=$(readlink -f /opt/codex-web-ui/web-current) || die 'current web release link is missing'
case "$current" in /opt/codex-web-ui/releases/*/apps/web/dist) ;; *) die 'current web release escapes release directory' ;; esac
[[ $target != "$current" ]] || die 'web rollback target is already current'

printf '%s\n' "$current" >/var/lib/codex-web-ui/previous-web-release
chown root:root /var/lib/codex-web-ui/previous-web-release
chmod 0600 /var/lib/codex-web-ui/previous-web-release
atomic_symlink "$target" /opt/codex-web-ui/web-current
[[ $(readlink -f /opt/codex-web-ui/web-current) == "$target" ]] || die 'web rollback verification failed'
printf 'Rolled back Web UI only to %s. Backend was not restarted.\n' "$target"
