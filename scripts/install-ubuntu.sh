#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

service_user=ai-chat-agent
source_dir=
release_id=
codex_home=/var/lib/codex-web-ui/codex-home
codex_bin=/usr/local/bin/codex
public_origin=https://codex.example.com
project_roots=()
start_service=false

usage() {
  cat <<'EOF'
Usage: sudo scripts/install-ubuntu.sh --source DIR --release-id ID [options]

Options:
  --service-user USER       Existing non-root user (default: ai-chat-agent)
  --codex-home DIR          Existing server-side CODEX_HOME
  --codex-bin FILE          Existing Codex executable
  --project-root DIR        Allowed project root; repeatable
  --public-origin ORIGIN    HTTPS origin written to a new config template
  --start                   Enable and start after validation

The installer never creates, copies or reads Codex credentials. Authenticate the
chosen service user in CODEX_HOME separately before using --start.
EOF
}

while (($#)); do
  case "$1" in
    --source) source_dir=${2:?}; shift 2 ;;
    --release-id) release_id=${2:?}; shift 2 ;;
    --service-user) service_user=${2:?}; shift 2 ;;
    --codex-home) codex_home=${2:?}; shift 2 ;;
    --codex-bin) codex_bin=${2:?}; shift 2 ;;
    --project-root) project_roots+=("${2:?}"); shift 2 ;;
    --public-origin) public_origin=${2:?}; shift 2 ;;
    --start) start_service=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
for command in realpath getent find install systemctl python3; do require_command "$command"; done
validate_service_user "$service_user"
service_group=$(id -gn "$service_user")
validate_release_id "$release_id"
[[ $public_origin =~ ^https://[^/]+$ ]] || die 'public origin must be one HTTPS origin without a path'
[[ ${#project_roots[@]} -gt 0 ]] || project_roots=(/srv/codex-projects)

install -d -m 0700 -o "$service_user" -g "$service_group" /var/lib/codex-web-ui /var/lib/codex-web-ui/data
if [[ $codex_home == /var/lib/codex-web-ui/codex-home && ! -e $codex_home ]]; then
  install -d -m 0700 -o "$service_user" -g "$service_group" "$codex_home"
fi
if [[ ${#project_roots[@]} -eq 1 && ${project_roots[0]} == /srv/codex-projects && ! -e /srv/codex-projects ]]; then
  install -d -m 0750 -o "$service_user" -g "$service_group" /srv/codex-projects
fi
codex_home=$(canonical_existing_dir "$codex_home")
codex_bin=$(canonical_existing_file "$codex_bin")
[[ -x $codex_bin ]] || die 'Codex executable is not executable'
source_dir=$(validate_release_source "${source_dir:?--source is required}" "$codex_home")

canonical_roots=()
for root in "${project_roots[@]}"; do
  root=$(validate_project_root "$root")
  paths_overlap "$root" "$codex_home" && die "project root overlaps CODEX_HOME: $root"
  canonical_roots+=("$root")
done

install -d -m 0755 /opt/codex-web-ui/releases /etc/codex-web-ui /usr/local/libexec

release_dir="/opt/codex-web-ui/releases/$release_id"
config=/etc/codex-web-ui/codex-web-ui.env
if [[ -e $config ]]; then
  python3 "$SCRIPT_DIR/storage-guard.py" --config "$config" --check-releases --additional-releases 1
fi
copy_release "$source_dir" "$release_dir"
atomic_symlink "$release_dir" /opt/codex-web-ui/current
atomic_symlink "$release_dir/apps/web/dist" /opt/codex-web-ui/web-current

install -m 0644 "$REPO_ROOT/infra/systemd/codex-web-ui@.service" /etc/systemd/system/codex-web-ui@.service
install -m 0644 "$REPO_ROOT/infra/systemd/codex-web-ui-storage-guard@.service" /etc/systemd/system/codex-web-ui-storage-guard@.service
install -m 0644 "$REPO_ROOT/infra/systemd/codex-web-ui-storage-guard@.timer" /etc/systemd/system/codex-web-ui-storage-guard@.timer
install -m 0755 "$REPO_ROOT/scripts/validate-config.sh" /usr/local/libexec/codex-web-ui-validate-config
install -m 0755 "$REPO_ROOT/scripts/storage-guard.py" /usr/local/libexec/codex-web-ui-storage-guard
install -m 0755 "$REPO_ROOT/scripts/storage-enforce.sh" /usr/local/libexec/codex-web-ui-storage-enforce
write_path_drop_in "$service_user" "$codex_home" "${canonical_roots[@]}"

if [[ ! -e $config ]]; then
  roots_csv=$(IFS=,; printf '%s' "${canonical_roots[*]}")
  umask 077
  {
    printf 'CODEX_WEB_HOST=127.0.0.1\n'
    printf 'CODEX_WEB_PORT=3210\n'
    printf 'CODEX_WEB_PUBLIC_ORIGIN=%s\n' "$public_origin"
    printf 'CODEX_WEB_DATABASE_PATH=/var/lib/codex-web-ui/data/codex-web-ui.sqlite3\n'
    printf 'CODEX_WEB_PROJECT_ROOTS=%s\n' "$roots_csv"
    printf 'CODEX_BIN=%s\n' "$codex_bin"
    printf 'CODEX_HOME=%s\n' "$codex_home"
    printf 'CODEX_WEB_CODEX_VERSION_PIN="codex-cli 0.153.4"\n'
    printf 'CODEX_WEB_ADMIN_USERNAME=\n'
    printf 'CODEX_WEB_ADMIN_PASSWORD_HASH=\n'
    printf 'CODEX_WEB_SESSION_SECRET=\n'
    printf '# Reserved backend bounds; systemd applies separate service-level limits.\n'
    printf 'CODEX_WEB_MAX_CONCURRENT_TURNS=2\n'
    printf 'CODEX_WEB_EVENT_RETENTION_PER_THREAD=1000\n'
    printf 'CODEX_WEB_MAX_EVENT_BYTES=32768\n'
    printf 'CODEX_WEB_HEALTH_PATH=/api/health\n'
    printf 'CODEX_WEB_MIN_FREE_BYTES=5368709120\n'
    printf 'CODEX_WEB_MAX_DATABASE_BYTES=2147483648\n'
    printf 'CODEX_WEB_MAX_RELEASES=5\n'
  } >"$config"
fi
[[ -f $config && ! -L $config ]] || die 'configuration must be a regular non-symlink file'
chown root:root "$config"
chmod 0600 "$config"

python3 "$SCRIPT_DIR/storage-guard.py" --config "$config" --check-releases

systemctl daemon-reload
if $start_service; then
  /usr/local/libexec/codex-web-ui-validate-config
  systemctl enable --now "codex-web-ui@${service_user}.service"
else
  printf 'Installed release %s. Populate %s, install HTTPS edge, then start codex-web-ui@%s.service.\n' \
    "$release_id" "$config" "$service_user"
fi
