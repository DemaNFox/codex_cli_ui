#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

service_user=ai-chat-agent
release_id=
health_timeout=60

while (($#)); do
  case "$1" in
    --release-id) release_id=${2:?}; shift 2 ;;
    --service-user) service_user=${2:?}; shift 2 ;;
    --health-timeout) health_timeout=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: sudo scripts/rollback-ubuntu.sh [--release-id ID] [--service-user USER]\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
validate_service_user "$service_user"
service_group=$(id -gn "$service_user")
if [[ -n $release_id ]]; then
  validate_release_id "$release_id"
  target="/opt/codex-web-ui/releases/$release_id"
else
  [[ -r /var/lib/codex-web-ui/previous-release ]] || die 'no previous release is recorded'
  target=$(< /var/lib/codex-web-ui/previous-release)
fi

target=$(canonical_existing_dir "$target")
case "$target" in /opt/codex-web-ui/releases/*) ;; *) die 'rollback target escapes release directory' ;; esac
[[ -f "$target/apps/server/dist/index.js" ]] || die 'rollback target is not a complete release'
[[ -f "$target/apps/web/dist/index.html" ]] || die 'rollback target is not a complete release'
current=$(readlink -f /opt/codex-web-ui/current) || die 'current release link is missing'
[[ $target != "$current" ]] || die 'rollback target is already current'

printf '%s\n' "$current" >/var/lib/codex-web-ui/previous-release
chown root:"$service_group" /var/lib/codex-web-ui/previous-release
chmod 0640 /var/lib/codex-web-ui/previous-release
atomic_symlink "$target" /opt/codex-web-ui/current
current_web=$(readlink -f /opt/codex-web-ui/web-current 2>/dev/null || true)
if [[ -n $current_web ]]; then
  case "$current_web" in /opt/codex-web-ui/releases/*/apps/web/dist) ;; *) die 'current web release escapes release directory' ;; esac
  printf '%s\n' "$current_web" >/var/lib/codex-web-ui/previous-web-release
  chown root:root /var/lib/codex-web-ui/previous-web-release
  chmod 0600 /var/lib/codex-web-ui/previous-web-release
fi
atomic_symlink "$target/apps/web/dist" /opt/codex-web-ui/web-current
systemctl restart "codex-web-ui@${service_user}.service"
"$SCRIPT_DIR/health-check.sh" --timeout "$health_timeout" --service-user "$service_user" || \
  die 'rollback target failed health check; inspect the service before another transition'
printf 'Rolled back Codex Web UI to %s.\n' "$target"
