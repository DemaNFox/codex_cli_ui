#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

service_user=ai-chat-agent
source_dir=
release_id=
health_timeout=60

while (($#)); do
  case "$1" in
    --source) source_dir=${2:?}; shift 2 ;;
    --release-id) release_id=${2:?}; shift 2 ;;
    --service-user) service_user=${2:?}; shift 2 ;;
    --health-timeout) health_timeout=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: sudo scripts/update-ubuntu.sh --source DIR --release-id ID [--service-user USER] [--health-timeout SECONDS]\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
require_command python3
validate_service_user "$service_user"
service_group=$(id -gn "$service_user")
validate_release_id "$release_id"
[[ $health_timeout =~ ^[1-9][0-9]{0,3}$ ]] || die 'invalid health timeout'

config=/etc/codex-web-ui/codex-web-ui.env
[[ -r $config ]] || die 'installed configuration is missing'
codex_home=$(sed -n 's/^CODEX_HOME=//p' "$config")
[[ -n $codex_home ]] || die 'CODEX_HOME is missing from installed configuration'
codex_home=$(canonical_existing_dir "$codex_home")
source_dir=$(validate_release_source "${source_dir:?--source is required}" "$codex_home")

release_dir="/opt/codex-web-ui/releases/$release_id"
python3 "$SCRIPT_DIR/storage-guard.py" --config "$config" --check-releases --additional-releases 1
copy_release "$source_dir" "$release_dir"
previous=$(readlink -f /opt/codex-web-ui/current) || die 'current release link is missing'
case "$previous" in /opt/codex-web-ui/releases/*) ;; *) die 'current release escapes release directory' ;; esac
printf '%s\n' "$previous" >/var/lib/codex-web-ui/previous-release
chown root:"$service_group" /var/lib/codex-web-ui/previous-release
chmod 0640 /var/lib/codex-web-ui/previous-release

atomic_symlink "$release_dir" /opt/codex-web-ui/current
systemctl restart "codex-web-ui@${service_user}.service"
if ! "$SCRIPT_DIR/health-check.sh" --timeout "$health_timeout" --service-user "$service_user"; then
  printf 'New release failed health check; restoring %s\n' "$previous" >&2
  atomic_symlink "$previous" /opt/codex-web-ui/current
  systemctl restart "codex-web-ui@${service_user}.service"
  "$SCRIPT_DIR/health-check.sh" --timeout "$health_timeout" --service-user "$service_user" || \
    die 'rollback release also failed health check'
  die 'update rolled back after failed health check'
fi
printf 'Updated Codex Web UI to %s. Previous release retained at %s.\n' "$release_id" "$previous"
