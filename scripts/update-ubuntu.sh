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
for command in python3 install stat mktemp rm rmdir grep systemctl; do require_command "$command"; done
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
drain_marker=/var/lib/codex-web-ui/data/upgrade-drain
bash "$SCRIPT_DIR/graceful-drain.sh" \
  --begin --config "$config" --service-user "$service_user" --timeout "$health_timeout"
drain_engaged=false
[[ -f $drain_marker ]] && drain_engaged=true
pre_activation_cleanup() {
  local status=${1:-$?}
  trap - EXIT INT TERM
  if [[ -e $release_dir ]]; then
    printf 'Pre-activation cleanup retained incomplete release: %s\n' "$release_dir" >&2
  fi
  if $drain_engaged && ! bash "$SCRIPT_DIR/graceful-drain.sh" \
    --release --config "$config" --service-user "$service_user" --timeout "$health_timeout"; then
    printf 'Failed to release the pre-activation drain cleanly.\n' >&2
  fi
  exit "$status"
}
trap pre_activation_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$SCRIPT_DIR/storage-guard.py" --config "$config" --check-releases --additional-releases 1
copy_release "$source_dir" "$release_dir"
previous=$(readlink -f /opt/codex-web-ui/current) || die 'current release link is missing'
case "$previous" in /opt/codex-web-ui/releases/*) ;; *) die 'current release escapes release directory' ;; esac
printf '%s\n' "$previous" >/var/lib/codex-web-ui/previous-release
chown root:"$service_group" /var/lib/codex-web-ui/previous-release
chmod 0640 /var/lib/codex-web-ui/previous-release

resource_units=(
  codex-web-ui-workload.slice
)
resource_rollback_keys=(
  broker-socket-unit
  broker-service-unit
  workload-slice-unit
  broker-helper
  resource-policy
  resource-drop-in
  legacy-resource-drop-in
)
legacy_resource_drop_in="/etc/systemd/system/codex-web-ui@${service_user}.service.d/50-resource-boundary.conf"
legacy_resource_drop_in_dir=${legacy_resource_drop_in%/*}
legacy_resource_drop_in_dir_was_present=false
if [[ -d $legacy_resource_drop_in_dir && ! -L $legacy_resource_drop_in_dir ]]; then
  legacy_resource_drop_in_dir_was_present=true
fi
resource_rollback_paths=(
  /etc/systemd/system/codex-web-ui-resource-broker.socket
  /etc/systemd/system/codex-web-ui-resource-broker@.service
  /etc/systemd/system/codex-web-ui-workload.slice
  /usr/local/libexec/codex-web-ui-resource-broker
  /etc/codex-web-ui/resource-limits.json
  /etc/systemd/system/codex-web-ui-workload.slice.d/50-resource-limits.conf
  "$legacy_resource_drop_in"
)
resource_rollback_dir=
cleanup_resource_snapshot() {
  local status=$?
  trap - EXIT INT TERM
  remove_activation_backup "$resource_rollback_dir" || \
    printf 'Incomplete resource snapshot could not be removed: %s\n' "$resource_rollback_dir" >&2
  pre_activation_cleanup "$status"
}
resource_rollback_dir=$(mktemp -d /var/lib/codex-web-ui/.activation-rollback.XXXXXX)
trap cleanup_resource_snapshot EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for index in "${!resource_rollback_paths[@]}"; do
  snapshot_activation_file \
    "$resource_rollback_dir" "${resource_rollback_keys[$index]}" "${resource_rollback_paths[$index]}"
done
broker_socket_was_active=false
if systemctl is-active --quiet codex-web-ui-resource-broker.socket; then broker_socket_was_active=true; fi
broker_socket_was_enabled=false
if systemctl is-enabled --quiet codex-web-ui-resource-broker.socket; then broker_socket_was_enabled=true; fi
workload_slice_was_active=false
if systemctl is-active --quiet codex-web-ui-workload.slice; then workload_slice_was_active=true; fi

restore_resource_boundary() {
  if systemctl is-active --quiet codex-web-ui-resource-broker.socket; then
    systemctl stop codex-web-ui-resource-broker.socket || return 1
  fi
  systemctl stop 'codex-web-ui-resource-broker@*.service' >/dev/null 2>&1 || true
  if systemctl is-active --quiet codex-web-ui-workload.slice; then
    systemctl stop codex-web-ui-workload.slice || return 1
  fi
  if ! $broker_socket_was_enabled && systemctl is-enabled --quiet codex-web-ui-resource-broker.socket; then
    systemctl disable codex-web-ui-resource-broker.socket || return 1
  fi
  local index
  for index in "${!resource_rollback_paths[@]}"; do
    restore_activation_file \
      "$resource_rollback_dir" "${resource_rollback_keys[$index]}" "${resource_rollback_paths[$index]}" || return 1
  done
  if ! $legacy_resource_drop_in_dir_was_present && \
    [[ -e $legacy_resource_drop_in_dir || -L $legacy_resource_drop_in_dir ]]; then
    [[ -d $legacy_resource_drop_in_dir && ! -L $legacy_resource_drop_in_dir ]] || return 1
    rmdir -- "$legacy_resource_drop_in_dir" || return 1
  fi
  systemctl daemon-reload || return 1
  if $workload_slice_was_active; then systemctl start codex-web-ui-workload.slice || return 1; fi
  if $broker_socket_was_enabled; then systemctl enable codex-web-ui-resource-broker.socket || return 1; fi
  if $broker_socket_was_active; then
    systemctl restart codex-web-ui-resource-broker.socket || return 1
  else
    systemctl stop codex-web-ui-resource-broker.socket >/dev/null 2>&1 || true
  fi
}

activation_complete=false
rollback_activation() {
  local status=$?
  trap - EXIT INT TERM
  if ! $activation_complete; then
    printf 'Activation failed; restoring the previous release.\n' >&2
    atomic_symlink "$previous" /opt/codex-web-ui/current
    resource_boundary_restored=true
    if ! restore_resource_boundary; then
      resource_boundary_restored=false
      printf 'Rollback could not restore the previous resource boundary exactly.\n' >&2
    fi
    if systemctl restart "codex-web-ui@${service_user}.service"; then
      if "$SCRIPT_DIR/health-check.sh" --timeout "$health_timeout" --service-user "$service_user"; then
        if $drain_engaged; then
          bash "$SCRIPT_DIR/graceful-drain.sh" \
            --release --config "$config" --service-user "$service_user" --timeout "$health_timeout" || \
            printf 'Rollback is healthy but the drain could not be released.\n' >&2
        fi
      else
        printf 'Rollback release failed its health check; the drain remains engaged.\n' >&2
      fi
    else
      printf 'Rollback release could not be restarted.\n' >&2
    fi
    if $resource_boundary_restored; then
      remove_activation_backup "$resource_rollback_dir" || \
        printf 'Rollback backup could not be removed: %s\n' "$resource_rollback_dir" >&2
    else
      printf 'Rollback backup retained for recovery: %s\n' "$resource_rollback_dir" >&2
    fi
  fi
  exit "$status"
}
trap rollback_activation EXIT
atomic_symlink "$release_dir" /opt/codex-web-ui/current
systemctl stop codex-web-ui-resource-broker.socket 'codex-web-ui-resource-broker@*.service' >/dev/null 2>&1 || true
for unit in "${resource_units[@]}"; do
  install -m 0644 "$release_dir/infra/systemd/$unit" "/etc/systemd/system/$unit"
done
socket_unit="$resource_rollback_dir/broker-socket.rendered"
sed "s/^SocketUser=codex-web-ui-api$/SocketUser=$service_user/" \
  "$release_dir/infra/systemd/codex-web-ui-resource-broker.socket" >"$socket_unit"
grep -qx "SocketUser=$service_user" "$socket_unit" || die 'resource broker socket user rendering failed'
install -m 0644 "$socket_unit" /etc/systemd/system/codex-web-ui-resource-broker.socket
broker_service_unit="$resource_rollback_dir/broker-service.rendered"
sed "s|--serve-fd 0$|--serve-fd 0 --api-user $service_user|" \
  "$release_dir/infra/systemd/codex-web-ui-resource-broker@.service" >"$broker_service_unit"
grep -q -- "--serve-fd 0 --api-user $service_user$" "$broker_service_unit" || \
  die 'resource broker API identity rendering failed'
install -m 0644 "$broker_service_unit" /etc/systemd/system/codex-web-ui-resource-broker@.service
install -d -m 0755 "$legacy_resource_drop_in_dir"
printf '[Service]\nSlice=codex-web-ui-workload.slice\n' >"$legacy_resource_drop_in"
chmod 0644 "$legacy_resource_drop_in"
install -m 0755 "$release_dir/scripts/resource-broker.py" /usr/local/libexec/codex-web-ui-resource-broker
systemctl daemon-reload
systemctl start codex-web-ui-workload.slice
systemctl enable codex-web-ui-resource-broker.socket
systemctl restart codex-web-ui-resource-broker.socket
/usr/local/libexec/codex-web-ui-resource-broker --initialize >/dev/null
systemctl restart "codex-web-ui@${service_user}.service"
if ! "$SCRIPT_DIR/health-check.sh" --timeout "$health_timeout" --service-user "$service_user"; then
  die 'update failed health check and will be rolled back'
fi
if $drain_engaged; then
  bash "$SCRIPT_DIR/graceful-drain.sh" \
    --release --config "$config" --service-user "$service_user" --timeout "$health_timeout"
fi
activation_complete=true
remove_activation_backup "$resource_rollback_dir" || \
  printf 'Activation backup could not be removed: %s\n' "$resource_rollback_dir" >&2
trap - EXIT INT TERM
printf 'Updated Codex Web UI to %s. Previous release retained at %s.\n' "$release_id" "$previous"
