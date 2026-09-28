#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PACKAGE_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

load_toolchain_pins() {
  local file=${1:?pin file required} line key value required
  local -A seen=()
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]]+)$ ]] || die 'invalid toolchain pin file'
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case "$key" in
      NODE_VERSION|PNPM_VERSION|CODEX_CLI_VERSION|NODE_LINUX_X64_SHA256|NODE_LINUX_ARM64_SHA256|PNPM_TARBALL_SHA512|CODEX_TARBALL_SHA512|CODEX_LINUX_X64_TARBALL_SHA512|CODEX_LINUX_ARM64_TARBALL_SHA512) ;;
      *) die "unsupported toolchain pin: $key" ;;
    esac
    [[ -z ${seen[$key]+x} ]] || die "duplicate toolchain pin: $key"
    seen[$key]=1
    printf -v "$key" '%s' "$value"
  done <"$file"
  for required in NODE_VERSION PNPM_VERSION CODEX_CLI_VERSION NODE_LINUX_X64_SHA256 NODE_LINUX_ARM64_SHA256 PNPM_TARBALL_SHA512 CODEX_TARBALL_SHA512 CODEX_LINUX_X64_TARBALL_SHA512 CODEX_LINUX_ARM64_TARBALL_SHA512; do
    [[ -n ${seen[$required]+x} ]] || die "missing toolchain pin: $required"
  done
}

load_toolchain_pins "$PACKAGE_ROOT/infra/toolchain.env"

package=$PACKAGE_ROOT
runner_user=
codex_home=
codex_bin=
public_origin=
project_roots=()
tls_cert=
tls_key=
external_proxy=false
mode=install
start_service=true
resuming_bootstrap=false
drain_marker=/var/lib/codex-web-ui/data/upgrade-drain

usage() {
  cat <<'EOF'
Usage: sudo scripts/install-package.sh [options]

  --runner-user USER       Existing non-root OS user for Codex (default: sudo caller)
  --codex-home DIR         Its existing CODEX_HOME (default: USER_HOME/.codex)
  --codex-bin FILE         Codex executable (default: managed repository-pinned CLI)
  --project-root DIR       Allowed project root; repeatable (default: /srv/codex-projects)
  --public-origin URL      Required HTTPS origin, for example https://codex.example.com
  --external-proxy         TLS terminates in an existing reverse proxy
  --tls-cert FILE          Install bundled Nginx edge with this certificate
  --tls-key FILE           Install bundled Nginx edge with this private key
  --upgrade                Explicitly replace an existing release, preserving config
  --no-start               Install only; use this while provisioning hard storage quotas

The command bootstraps the pinned Node.js/pnpm/Codex toolchain, verifies the
checksummed inventory and Codex version/login, creates an isolated API identity,
prompts locally for the administrator credentials, and starts the service.
Plain HTTP and automatically generated public certificates are unsupported.
EOF
}

while (($#)); do
  case "$1" in
    --package) package=${2:?}; shift 2 ;;
    --runner-user) runner_user=${2:?}; shift 2 ;;
    --codex-home) codex_home=${2:?}; shift 2 ;;
    --codex-bin) codex_bin=${2:?}; shift 2 ;;
    --project-root) project_roots+=("${2:?}"); shift 2 ;;
    --public-origin) public_origin=${2:?}; shift 2 ;;
    --external-proxy) external_proxy=true; shift ;;
    --tls-cert) tls_cert=${2:?}; shift 2 ;;
    --tls-key) tls_key=${2:?}; shift 2 ;;
    --upgrade) mode=upgrade; shift ;;
    --no-start) start_service=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
[[ -f /etc/os-release ]] && . /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} =~ ^(22\.04|24\.04)$ ]] || die 'supported OS is Ubuntu 22.04 or 24.04'
[[ -n $public_origin ]] || die '--public-origin is required'
if $external_proxy; then
  [[ -z $tls_cert && -z $tls_key ]] || die 'choose either --external-proxy or --tls-cert/--tls-key'
else
  [[ -n $tls_cert && -n $tls_key ]] || die 'provide --external-proxy or both --tls-cert and --tls-key'
fi
bootstrap_args=()
$external_proxy || bootstrap_args+=(--install-nginx)
"$SCRIPT_DIR/bootstrap-ubuntu.sh" "${bootstrap_args[@]}"
export PATH="/usr/local/bin:$PATH"
for command in getent install realpath sha256sum systemctl runuser python3 node stat groupadd useradd cut date readlink find chown chmod sed rm curl mktemp sleep; do require_command "$command"; done
[[ -x /usr/local/bin/node && $(/usr/local/bin/node -p 'process.versions.node.split(".")[0]') == 22 ]] || die 'managed Node.js 22 is required at /usr/local/bin/node'
package=$(canonical_existing_dir "$package")
case "$(uname -m)" in x86_64) target=linux-x64 ;; aarch64) target=linux-arm64 ;; *) die 'unsupported CPU architecture' ;; esac
managed_codex_bin="/opt/codex-web-ui/runtime/toolchain-pnpm-${PNPM_VERSION}-codex-${CODEX_CLI_VERSION}-${target#linux-}/bin/codex"
"$package/scripts/prepare-package.sh" --verify "$package" --arch "$target" || die 'package verification failed'
python3 - "$package/release.json" <<'PY'
import json, platform, sys
m=json.load(open(sys.argv[1], encoding='utf-8'))
expected={'x86_64':'x64','aarch64':'arm64'}.get(platform.machine())
if m.get('schemaVersion') != 1 or m.get('target') != {'platform':'linux','architecture':expected}:
    raise SystemExit('package manifest does not match this Linux architecture')
PY

config=/etc/codex-web-ui/codex-web-ui.env
runner_config=/etc/codex-web-ui/codex-runner.env
if [[ -e $config && $mode == install ]]; then
  if [[ -e $runner_config || -n $(sed -n 's/^CODEX_WEB_ADMIN_PASSWORD_HASH=//p' "$config") ]]; then
    die 'installation exists; rerun with --upgrade to preserve its administrator and configuration'
  fi
  printf 'Resuming an interrupted administrator bootstrap.\n' >&2
  resuming_bootstrap=true
fi
if [[ ! -e $config && $mode == upgrade ]]; then die '--upgrade requires an existing installation'; fi
if [[ $mode == upgrade ]]; then
  [[ -f $runner_config && ! -L $runner_config ]] || die 'installed runner configuration is missing or unsafe'
  persisted_home=$(sed -n 's/^CODEX_HOME=//p' "$runner_config")
  persisted_bin=$(sed -n 's/^CODEX_BIN=//p' "$runner_config")
  persisted_user=$(stat -c '%U' "$persisted_home")
  [[ -z $runner_user || $runner_user == "$persisted_user" ]] || die 'changing the runner user requires an explicit migration workflow'
  [[ -z $codex_home || $codex_home == "$persisted_home" ]] || die 'changing CODEX_HOME requires an explicit migration workflow'
  if [[ -n $codex_bin ]]; then
    [[ $(realpath -e -- "$codex_bin") == "$persisted_bin" ]] || die 'changing CODEX_BIN requires an explicit migration workflow'
  else
    case "$persisted_bin" in
      /opt/codex-web-ui/runtime/toolchain-pnpm-*-codex-*-${target#linux-}/bin/codex) codex_bin=$managed_codex_bin ;;
      *) codex_bin=$persisted_bin ;;
    esac
  fi
  runner_user=$persisted_user
  codex_home=$persisted_home
fi
[[ -n $runner_user ]] || runner_user=${SUDO_USER:-}

[[ -n $runner_user ]] || die '--runner-user is required when there is no sudo caller'
validate_service_user "$runner_user"
runner_group=$(id -gn "$runner_user")
runner_home=$(getent passwd "$runner_user" | cut -d: -f6)
if [[ -z $codex_home ]]; then
  codex_home="$runner_home/.codex"
  if [[ ! -e $codex_home ]]; then install -d -m 0700 -o "$runner_user" -g "$runner_group" "$codex_home"; fi
else
  [[ -e $codex_home ]] || die 'an explicit --codex-home must already exist'
fi
[[ -n $codex_bin ]] || codex_bin=$managed_codex_bin
codex_home=$(canonical_existing_dir "$codex_home")
codex_bin=$(canonical_existing_file "$codex_bin")
[[ $codex_home =~ ^/[A-Za-z0-9_./@+-]+$ && $codex_bin =~ ^/[A-Za-z0-9_./@+-]+$ ]] || die 'Codex paths contain characters unsafe for systemd environment files'
[[ -x $codex_bin && ! -L $codex_bin ]] || die 'Codex executable must resolve to a real executable file'
[[ $(stat -c '%u' "$codex_bin") == 0 ]] || die 'Codex executable must be root-owned; install it system-wide'
[[ $(stat -c '%u' "$codex_home") == $(id -u "$runner_user") ]] || die 'CODEX_HOME must be owned by the runner user'
(( (8#$(stat -c '%a' "$codex_home") & 8#077) == 0 )) || die 'CODEX_HOME must have no group/other permissions'
version_pin=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime"]["codex"]["versionPin"])' "$package/release.json")
[[ $(runuser -u "$runner_user" -- env HOME="$runner_home" CODEX_HOME="$codex_home" "$codex_bin" --version) == "$version_pin" ]] || die "Codex must match package pin: $version_pin"
if ! runuser -u "$runner_user" -- env HOME="$runner_home" CODEX_HOME="$codex_home" "$codex_bin" login status >/dev/null 2>&1; then
  exec {tty_fd}<>/dev/tty || die "Codex login is required; rerun interactively or run: sudo -u $runner_user -H $codex_bin login --device-auth"
  printf 'Codex is not authenticated for %s; starting device login. Never share the displayed device code.\n' "$runner_user" >&${tty_fd}
  runuser -u "$runner_user" -- env HOME="$runner_home" CODEX_HOME="$codex_home" "$codex_bin" login --device-auth <&${tty_fd} >&${tty_fd} 2>&${tty_fd} || \
    die "Codex device login failed; retry with: sudo -u $runner_user -H $codex_bin login --device-auth"
  exec {tty_fd}>&-
  runuser -u "$runner_user" -- env HOME="$runner_home" CODEX_HOME="$codex_home" "$codex_bin" login status >/dev/null 2>&1 || die 'Codex login did not produce an authenticated state'
fi

if [[ $mode == upgrade || $resuming_bootstrap == true ]]; then
  installed_origin=$(sed -n 's/^CODEX_WEB_PUBLIC_ORIGIN=//p' "$config")
  [[ -z $public_origin || $public_origin == "$installed_origin" ]] || die 'changing the public origin requires an explicit reconfiguration workflow'
  public_origin=$installed_origin
fi

PUBLIC_ORIGIN=$public_origin python3 - <<'PY'
import ipaddress, os, re
from urllib.parse import urlsplit
u = urlsplit(os.environ.get('PUBLIC_ORIGIN', ''))
try: port = u.port
except ValueError: raise SystemExit('--public-origin has an invalid port')
host = u.hostname or ''
if u.scheme != 'https' or u.username or u.password or u.path or u.query or u.fragment or not host:
    raise SystemExit('--public-origin must be one HTTPS origin without credentials or a path')
try:
    ipaddress.ip_address(host)
except ValueError:
    labels = host.split('.')
    if len(labels) < 2 or any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', x) for x in labels):
        raise SystemExit('--public-origin must use a valid DNS hostname')
else:
    raise SystemExit('--public-origin must use a DNS name, not a bare IP address')
PY
if $external_proxy; then
  [[ -z $tls_cert && -z $tls_key ]] || die 'choose either --external-proxy or --tls-cert/--tls-key'
else
  [[ -n $tls_cert && -n $tls_key ]] || die 'provide --external-proxy or both --tls-cert and --tls-key'
fi
if [[ ${#project_roots[@]} -eq 0 && ( $mode == upgrade || $resuming_bootstrap == true ) ]]; then
  IFS=, read -r -a project_roots <<<"$(sed -n 's/^CODEX_WEB_PROJECT_ROOTS=//p' "$config")"
fi
[[ ${#project_roots[@]} -gt 0 ]] || project_roots=(/srv/codex-projects)
if [[ ${project_roots[*]} == /srv/codex-projects && ! -e /srv/codex-projects ]]; then
  install -d -m 0750 -o "$runner_user" -g "$runner_group" /srv/codex-projects
fi
canonical_roots=()
for root in "${project_roots[@]}"; do
  root=$(validate_project_root "$root")
  [[ $root =~ ^/[A-Za-z0-9_./@+-]+$ ]] || die "project root contains characters unsafe for systemd units: $root"
  paths_overlap "$root" "$codex_home" && die "project root overlaps CODEX_HOME: $root"
  canonical_roots+=("$root")
done
roots_csv=$(IFS=,; printf '%s' "${canonical_roots[*]}")
if [[ $mode == upgrade || $resuming_bootstrap == true ]]; then
  installed_roots=$(sed -n 's/^CODEX_WEB_PROJECT_ROOTS=//p' "$config")
  [[ $roots_csv == "$installed_roots" ]] || die 'changing project roots requires an explicit reconfiguration workflow'
fi

getent group codex-web-ui >/dev/null || groupadd --system codex-web-ui
getent passwd codex-web-ui-api >/dev/null || useradd --system --gid codex-web-ui --home-dir /var/lib/codex-web-ui --shell /usr/sbin/nologin codex-web-ui-api
install -d -m 0750 -o root -g codex-web-ui /var/lib/codex-web-ui
install -d -m 0750 -o codex-web-ui-api -g codex-web-ui /var/lib/codex-web-ui/data /var/lib/codex-web-ui/data/attachments
chown -R codex-web-ui-api:codex-web-ui /var/lib/codex-web-ui/data
find /var/lib/codex-web-ui/data/attachments -type d -exec chmod 0750 {} +
find /var/lib/codex-web-ui/data/attachments -type f -exec chmod 0640 {} +
install -d -m 0755 /opt/codex-web-ui/releases /etc/codex-web-ui /usr/local/libexec
install -d -m 0755 /etc/systemd/system/codex-web-ui-workload.slice.d

revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gitRevision"][:12])' "$package/release.json")
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$revision"
release_dir="/opt/codex-web-ui/releases/$release_id"
if [[ -e $config ]]; then python3 "$package/scripts/storage-guard.py" --config "$config" --check-releases --additional-releases 1; fi
drain_engaged=false
if [[ $mode == upgrade ]]; then
  drain_args=(--begin --config "$config" --service-user api)
  bash "$package/scripts/graceful-drain.sh" "${drain_args[@]}"
  [[ -f $drain_marker ]] && drain_engaged=true
  clear_pre_activation_drain() {
    local status=${1:-$?}
    trap - EXIT INT TERM
    case "$release_dir" in
      /opt/codex-web-ui/releases/*)
        if [[ -e $release_dir ]] && ! rm -rf --one-file-system -- "$release_dir"; then
          printf 'Pre-activation cleanup retained incomplete release: %s\n' "$release_dir" >&2
        fi
        ;;
      *) printf 'Refusing unsafe incomplete release cleanup: %s\n' "$release_dir" >&2 ;;
    esac
    if $drain_engaged && ! bash "$package/scripts/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45; then
      printf 'Failed to release the pre-activation drain cleanly.\n' >&2
    fi
    exit "$status"
  }
  trap clear_pre_activation_drain EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi
copy_release "$package" "$release_dir"
previous=$(readlink -f /opt/codex-web-ui/current 2>/dev/null || true)
previous_web=$(readlink -f /opt/codex-web-ui/web-current 2>/dev/null || true)
if [[ -n $previous ]]; then
  case "$previous" in /opt/codex-web-ui/releases/*) ;; *) die 'current release escapes the managed release directory' ;; esac
  if [[ -z $previous_web ]]; then previous_web="$previous/apps/web/dist"; fi
  case "$previous_web" in /opt/codex-web-ui/releases/*/apps/web/dist) ;; *) die 'current web release escapes the managed release directory' ;; esac
  [[ -f $previous_web/index.html ]] || die 'current web release is incomplete'
  printf '%s\n' "$previous" >/var/lib/codex-web-ui/previous-release
  chown root:codex-web-ui /var/lib/codex-web-ui/previous-release
  chmod 0640 /var/lib/codex-web-ui/previous-release
fi
runner_config_backup=
if [[ -f $runner_config ]]; then
  runner_config_backup=$(mktemp /etc/codex-web-ui/.runner-config.rollback.XXXXXX)
  install -m 0600 -o root -g root "$runner_config" "$runner_config_backup"
fi
resource_rollback_keys=(
  api-unit
  app-server-unit
  broker-socket-unit
  broker-service-unit
  workload-slice-unit
  broker-helper
  resource-policy
  resource-drop-in
)
resource_rollback_paths=(
  /etc/systemd/system/codex-web-ui@.service
  /etc/systemd/system/codex-web-ui-app-server@.service
  /etc/systemd/system/codex-web-ui-resource-broker.socket
  /etc/systemd/system/codex-web-ui-resource-broker@.service
  /etc/systemd/system/codex-web-ui-workload.slice
  /usr/local/libexec/codex-web-ui-resource-broker
  /etc/codex-web-ui/resource-limits.json
  /etc/systemd/system/codex-web-ui-workload.slice.d/50-resource-limits.conf
)
resource_rollback_dir=
cleanup_resource_snapshot() {
  local status=$?
  trap - EXIT INT TERM
  remove_activation_backup "$resource_rollback_dir" || \
    printf 'Incomplete resource snapshot could not be removed: %s\n' "$resource_rollback_dir" >&2
  if [[ $mode == upgrade ]]; then
    clear_pre_activation_drain "$status"
  else
    case "$release_dir" in
      /opt/codex-web-ui/releases/*)
        if [[ -e $release_dir ]] && ! rm -rf --one-file-system -- "$release_dir"; then
          printf 'Pre-activation cleanup retained incomplete release: %s\n' "$release_dir" >&2
        fi
        ;;
      *) printf 'Refusing unsafe incomplete release cleanup: %s\n' "$release_dir" >&2 ;;
    esac
  fi
  exit "$status"
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
web_switched=false
rollback_activation() {
  local status=$?
  trap - EXIT INT TERM
  if ! $activation_complete; then
    printf 'Activation failed; restoring the previous release.\n' >&2
    if $web_switched; then
      if [[ -n $previous_web ]]; then
        atomic_symlink "$previous_web" /opt/codex-web-ui/web-current
      else
        rm -f -- /opt/codex-web-ui/web-current
      fi
    fi
    if [[ -n $previous ]]; then
      atomic_symlink "$previous" /opt/codex-web-ui/current
    else
      rm -f -- /opt/codex-web-ui/current
    fi
    resource_boundary_restored=true
    if ! restore_resource_boundary; then
      resource_boundary_restored=false
      printf 'Rollback could not restore the previous resource boundary exactly.\n' >&2
    fi
    if [[ -n $runner_config_backup ]]; then
      install -m 0600 -o root -g root "$runner_config_backup" "$runner_config"
    else
      rm -f -- "$runner_config"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if systemctl restart codex-web-ui@api.service >/dev/null 2>&1 && \
      "$package/scripts/health-check.sh" --service-user api --timeout 45 >/dev/null 2>&1; then
      if $drain_engaged; then
        bash "$package/scripts/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45 || \
          printf 'Rollback is healthy but the drain could not be released.\n' >&2
      fi
    else
      printf 'Rollback release failed its health check; the drain remains engaged.\n' >&2
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
if [[ -n $previous_web ]]; then
  printf '%s\n' "$previous_web" >/var/lib/codex-web-ui/previous-web-release
  chown root:root /var/lib/codex-web-ui/previous-web-release
  chmod 0600 /var/lib/codex-web-ui/previous-web-release
fi
atomic_symlink "$release_dir/apps/web/dist" /opt/codex-web-ui/web-current
web_switched=true

for unit in codex-web-ui@.service codex-web-ui-app-server.socket codex-web-ui-app-server@.service codex-web-ui-resource-broker.socket codex-web-ui-resource-broker@.service codex-web-ui-workload.slice codex-web-ui-storage-guard@.service codex-web-ui-storage-guard@.timer; do
  install -m 0644 "$package/infra/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 0755 "$package/scripts/validate-config.sh" /usr/local/libexec/codex-web-ui-validate-config
install -m 0755 "$package/scripts/run-app-server.sh" /usr/local/libexec/codex-web-ui-run-app-server
install -m 0755 "$package/scripts/resource-broker.py" /usr/local/libexec/codex-web-ui-resource-broker
install -m 0755 "$package/scripts/storage-guard.py" /usr/local/libexec/codex-web-ui-storage-guard
install -m 0755 "$package/scripts/storage-enforce.sh" /usr/local/libexec/codex-web-ui-storage-enforce

dropin=/etc/systemd/system/codex-web-ui-app-server@.service.d
install -d -m 0755 "$dropin"
{
  printf '[Service]\nUser=%s\nGroup=%s\n' "$runner_user" "$runner_group"
  printf 'ReadWritePaths=%s\n' "$codex_home"
  for root in "${canonical_roots[@]}"; do printf 'ReadWritePaths=%s\n' "$root"; done
} >"$dropin/runner.conf"
chmod 0644 "$dropin/runner.conf"
api_dropin=/etc/systemd/system/codex-web-ui@api.service.d
install -d -m 0755 "$api_dropin"
printf '[Service]\nInaccessiblePaths=%s\n' "$codex_home" >"$api_dropin/paths.conf"
chmod 0644 "$api_dropin/paths.conf"

if [[ ! -e $config ]]; then
  umask 077
  sed -e "s|^CODEX_WEB_PUBLIC_ORIGIN=.*|CODEX_WEB_PUBLIC_ORIGIN=$public_origin|" \
      -e "s|^CODEX_WEB_PROJECT_ROOTS=.*|CODEX_WEB_PROJECT_ROOTS=$roots_csv|" \
      "$package/infra/env/codex-web-ui.env.example" >"$config"
  chmod 0600 "$config"
fi
if [[ -z $(sed -n 's/^CODEX_WEB_ADMIN_PASSWORD_HASH=//p' "$config") ]]; then
  /usr/local/bin/node "$package/scripts/setup-admin.mjs" --config "$config"
fi
umask 077
{
  printf 'CODEX_BIN=%s\nCODEX_HOME=%s\n' "$codex_bin" "$codex_home"
  printf 'CODEX_WEB_CODEX_VERSION_PIN="%s"\n' "$version_pin"
} >"$runner_config"
chmod 0600 "$runner_config"
chown root:root "$config" "$runner_config"

"$package/scripts/install-skills.sh" --codex-home "$codex_home" --service-user "$runner_user"

CODEX_WEB_CONFIG="$config" /usr/local/libexec/codex-web-ui-validate-config
systemctl daemon-reload
systemctl start codex-web-ui-workload.slice
if ! $external_proxy; then
  domain=${public_origin#https://}
  "$package/scripts/install-nginx.sh" --domain "$domain" --tls-cert "$tls_cert" --tls-key "$tls_key" --reload
fi
if $start_service; then
  systemctl enable codex-web-ui-resource-broker.socket codex-web-ui-app-server.socket codex-web-ui@api.service codex-web-ui-storage-guard@api.timer
  systemctl stop 'codex-web-ui-app-server@*.service' >/dev/null 2>&1 || true
  systemctl restart codex-web-ui-resource-broker.socket codex-web-ui-app-server.socket codex-web-ui@api.service codex-web-ui-storage-guard@api.timer
  /usr/local/libexec/codex-web-ui-resource-broker --initialize >/dev/null
  "$package/scripts/health-check.sh" --service-user api --timeout 45
  if $drain_engaged; then
    bash "$package/scripts/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45
  fi
  printf 'Codex Web UI %s is installed at %s\n' "$release_id" "$public_origin"
else
  if $drain_engaged; then rm -f -- "$drain_marker"; fi
  printf 'Codex Web UI %s is installed but not started; establish hard storage bounds, enable the API, app-server socket, resource-broker socket and storage timer, then run the resource broker with --initialize.\n' "$release_id"
fi
activation_complete=true
if [[ -n $runner_config_backup ]]; then rm -f -- "$runner_config_backup"; fi
remove_activation_backup "$resource_rollback_dir" || \
  printf 'Activation backup could not be removed: %s\n' "$resource_rollback_dir" >&2
trap - EXIT INT TERM
