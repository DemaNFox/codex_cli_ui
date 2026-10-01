#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

config=/etc/codex-web-ui/codex-web-ui.env
runner_config=/etc/codex-web-ui/codex-runner.env
host_admin_unit="$SCRIPT_DIR/../infra/systemd/codex-web-ui-app-server-host-admin@.service"
target_codex_home=/root/.codex

usage() {
  cat <<'EOF'
Usage: sudo scripts/migrate-runner-host-admin.sh [options]

  --config FILE              Installed Web UI environment
  --runner-config FILE       Installed runner environment
  --host-admin-unit FILE     Reviewed host-admin systemd template
  --target-codex-home DIR    New destination (default: /root/.codex; must not exist)

The migration drains and stops the Web UI, copies the complete existing Codex
profile without merging, verifies its inventory and authentication, and only
then switches the runner to root. The Web database and application config are
not modified. Any failure restores the previous runner and services.
EOF
}

while (($#)); do
  case "$1" in
    --config) config=${2:?}; shift 2 ;;
    --runner-config) runner_config=${2:?}; shift 2 ;;
    --host-admin-unit) host_admin_unit=${2:?}; shift 2 ;;
    --target-codex-home) target_codex_home=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
for command in cp chown chmod install mv rm realpath runuser stat systemctl python3 mktemp sed getent cut grep dirname basename id; do
  require_command "$command"
done
[[ -f $config && ! -L $config ]] || die 'installed Web UI configuration is missing or unsafe'
[[ -f $runner_config && ! -L $runner_config ]] || die 'installed runner configuration is missing or unsafe'
[[ -f $host_admin_unit && ! -L $host_admin_unit ]] || die 'host-admin systemd template is missing or unsafe'

read_single_value() {
  local key=${1:?key required} file=${2:?file required} values
  values=$(sed -n "s/^${key}=//p" "$file")
  [[ -n $values && $values != *$'\n'* ]] || die "runner configuration has a missing or ambiguous $key"
  printf '%s\n' "$values"
}

source_mode=$(sed -n 's/^CODEX_WEB_RUNNER_MODE=//p' "$runner_config")
[[ -n $source_mode ]] || source_mode=restricted
[[ $source_mode == restricted ]] || die 'runner is not in restricted mode'
source_codex_home=$(canonical_existing_dir "$(read_single_value CODEX_HOME "$runner_config")")
codex_bin=$(canonical_existing_file "$(read_single_value CODEX_BIN "$runner_config")")
version_pin=$(read_single_value CODEX_WEB_CODEX_VERSION_PIN "$runner_config")
version_pin=${version_pin#\"}
version_pin=${version_pin%\"}
source_user=$(stat -c '%U' "$source_codex_home")
validate_service_user "$source_user"
source_group=$(stat -c '%G' "$source_codex_home")
source_dir_mode=$(stat -c '%a' "$source_codex_home")
source_uid=$(id -u "$source_user")
source_gid=$(stat -c '%g' "$source_codex_home")
python3 "$SCRIPT_DIR/install-local-host-instructions.py" \
  --codex-home "$source_codex_home" --service-user "$source_user"
SOURCE_HOME=$source_codex_home SOURCE_UID=$source_uid SOURCE_GID=$source_gid python3 - <<'PY'
import os
from pathlib import Path

root = Path(os.environ["SOURCE_HOME"])
uid = int(os.environ["SOURCE_UID"])
gid = int(os.environ["SOURCE_GID"])
for path in (root, *root.rglob("*")):
    metadata = path.lstat()
    if metadata.st_uid != uid or metadata.st_gid != gid:
        raise SystemExit(f"Codex profile ownership is not uniform: {path}")
PY

[[ $target_codex_home = /* ]] || die 'target CODEX_HOME must be absolute'
[[ ! $target_codex_home =~ [[:space:],:] ]] || die 'target CODEX_HOME contains unsupported characters'
target_parent=$(canonical_existing_dir "$(dirname -- "$target_codex_home")")
[[ $target_parent != / ]] || die 'target CODEX_HOME must be below a protected root-owned directory'
[[ $(stat -c '%u' "$target_parent") == 0 ]] || die 'target CODEX_HOME parent must be owned by root'
target_parent_mode=$(stat -c '%a' "$target_parent")
(( (8#$target_parent_mode & 8#022) == 0 )) || \
  die 'target CODEX_HOME parent must not be writable by group or other users'
target_codex_home="$target_parent/$(basename -- "$target_codex_home")"
[[ $target_codex_home != / ]] || die 'target CODEX_HOME must not be the filesystem root'
[[ ! -e $target_codex_home && ! -L $target_codex_home ]] || die 'target CODEX_HOME already exists; profiles are never merged'
paths_overlap "$source_codex_home" "$target_codex_home" && die 'source and target CODEX_HOME overlap'

unit=/etc/systemd/system/codex-web-ui-app-server@.service
runner_dropin=/etc/systemd/system/codex-web-ui-app-server@.service.d/runner.conf
api_dropin=/etc/systemd/system/codex-web-ui@api.service.d/paths.conf
rollback_dir=$(mktemp -d /var/lib/codex-web-ui/.activation-rollback.host-admin.XXXXXX)
chmod 0700 "$rollback_dir"
snapshot_activation_file "$rollback_dir" runner-config "$runner_config"
snapshot_activation_file "$rollback_dir" app-server-unit "$unit"
snapshot_activation_file "$rollback_dir" runner-drop-in "$runner_dropin"
snapshot_activation_file "$rollback_dir" api-paths-drop-in "$api_dropin"

drain_engaged=false
target_created=false
stage=
migration_complete=false
source_revocation_started=false
rollback_migration() {
  local status=$?
  trap - EXIT INT TERM
  if ! $migration_complete; then
    printf 'Host-admin migration failed; restoring the restricted runner.\n' >&2
    systemctl stop codex-web-ui-app-server.socket codex-web-ui@api.service >/dev/null 2>&1 || true
    systemctl stop 'codex-web-ui-app-server@*.service' >/dev/null 2>&1 || true
    restore_activation_file "$rollback_dir" runner-config "$runner_config" || true
    restore_activation_file "$rollback_dir" app-server-unit "$unit" || true
    restore_activation_file "$rollback_dir" runner-drop-in "$runner_dropin" || true
    restore_activation_file "$rollback_dir" api-paths-drop-in "$api_dropin" || true
    if $source_revocation_started; then
      chown -hR "$source_user:$source_group" "$source_codex_home" || true
      chmod "$source_dir_mode" "$source_codex_home" || true
    fi
    if $target_created; then
      case "$target_codex_home" in
        "$target_parent"/*) rm -rf --one-file-system -- "$target_codex_home" || true ;;
        *) printf 'Refusing unsafe target cleanup: %s\n' "$target_codex_home" >&2 ;;
      esac
    fi
    if [[ -n $stage && -d $stage && ! -L $stage ]]; then
      case "$stage" in
        "${target_codex_home}.stage."*) rm -rf --one-file-system -- "$stage" || true ;;
        *) printf 'Refusing unsafe migration-stage cleanup: %s\n' "$stage" >&2 ;;
      esac
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart codex-web-ui-app-server.socket codex-web-ui@api.service >/dev/null 2>&1 || true
    if $drain_engaged; then
      bash "$SCRIPT_DIR/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45 >/dev/null 2>&1 || \
        printf 'The previous runner was restored, but the upgrade drain remains engaged.\n' >&2
    fi
  fi
  remove_activation_backup "$rollback_dir" || \
    printf 'Migration rollback evidence remains at %s\n' "$rollback_dir" >&2
  exit "$status"
}
trap rollback_migration EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bash "$SCRIPT_DIR/graceful-drain.sh" --begin --config "$config" --service-user api
drain_engaged=true
systemctl stop codex-web-ui-app-server.socket codex-web-ui@api.service
systemctl stop 'codex-web-ui-app-server@*.service' >/dev/null 2>&1 || true
systemctl is-active --quiet codex-web-ui@api.service && die 'API service did not stop'
systemctl is-active --quiet codex-web-ui-app-server.socket && die 'app-server socket did not stop'
if systemctl list-units --state=active --plain --no-legend 'codex-web-ui-app-server@*.service' | grep -q .; then
  die 'an app-server runner remained active after stop'
fi

stage=$(mktemp -d "${target_codex_home}.stage.XXXXXX")
chmod 0700 "$stage"
cp -a --no-preserve=ownership -- "$source_codex_home/." "$stage/"
chown -R root:root "$stage"
chmod 0700 "$stage"
SOURCE_HOME=$source_codex_home TARGET_HOME=$stage python3 - <<'PY'
import hashlib
import os
import stat
from pathlib import Path

def inventory(root: Path):
    values = []
    for path in sorted(root.rglob("*"), key=lambda value: value.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            values.append((relative, "dir", ""))
        elif stat.S_ISREG(metadata.st_mode):
            values.append((relative, "file", hashlib.sha256(path.read_bytes()).hexdigest()))
        elif stat.S_ISLNK(metadata.st_mode):
            raise SystemExit(f"Codex profile contains a symlink and cannot cross the privilege boundary: {relative}")
        else:
            raise SystemExit(f"Codex profile contains unsupported special file: {relative}")
    return values

if inventory(Path(os.environ["SOURCE_HOME"])) != inventory(Path(os.environ["TARGET_HOME"])):
    raise SystemExit("copied Codex profile inventory differs from the source")
PY

python3 "$SCRIPT_DIR/rebase-codex-home.py" \
  --profile-root "$stage" --target-home "$target_codex_home" \
  --source-home "$source_codex_home"

root_home=$(getent passwd root | cut -d: -f6)
[[ $(runuser -u root -- env HOME="$root_home" CODEX_HOME="$stage" "$codex_bin" --version) == "$version_pin" ]] || \
  die 'copied Codex profile cannot run the pinned CLI'
runuser -u root -- env HOME="$root_home" CODEX_HOME="$stage" "$codex_bin" login status >/dev/null 2>&1 || \
  die 'copied Codex profile is not authenticated'
# Rename and ownership-state bookkeeping are one interruption-free critical
# section. Ignoring INT/TERM for these few local operations prevents a copied
# credential tree from becoming untracked between mv(1) and the rollback flags.
trap '' INT TERM
mv -T -- "$stage" "$target_codex_home"
target_created=true
stage=
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(realpath -e -- "$target_codex_home") == "$target_codex_home" ]] || \
  die 'migrated CODEX_HOME did not activate at the expected path'
python3 "$SCRIPT_DIR/install-local-host-instructions.py" \
  --codex-home "$target_codex_home" --service-user root

RUNNER_CONFIG=$runner_config TARGET_HOME=$target_codex_home python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["RUNNER_CONFIG"])
lines = path.read_text(encoding="utf-8").splitlines()
result = []
seen_mode = False
seen_home = False
for line in lines:
    if line.startswith("CODEX_WEB_RUNNER_MODE="):
        if seen_mode:
            raise SystemExit("runner mode is ambiguous")
        result.append("CODEX_WEB_RUNNER_MODE=host-admin")
        seen_mode = True
    elif line.startswith("CODEX_HOME="):
        if seen_home:
            raise SystemExit("CODEX_HOME is ambiguous")
        result.append(f"CODEX_HOME={os.environ['TARGET_HOME']}")
        seen_home = True
    else:
        result.append(line)
if not seen_mode:
    result.insert(0, "CODEX_WEB_RUNNER_MODE=host-admin")
if not seen_home:
    raise SystemExit("CODEX_HOME is missing")
temporary = path.with_name(path.name + ".migration")
temporary.write_text("\n".join(result) + "\n", encoding="utf-8")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
chown root:root "$runner_config"
install -m 0644 "$host_admin_unit" "$unit"
rm -f -- "$runner_dropin"
install -d -m 0755 "$(dirname -- "$api_dropin")"
printf '[Service]\nInaccessiblePaths=%s\n' "$target_codex_home" >"$api_dropin"
chmod 0644 "$api_dropin"

systemctl daemon-reload
systemctl restart codex-web-ui-app-server.socket codex-web-ui@api.service
"$SCRIPT_DIR/health-check.sh" --service-user api --timeout 45
source_revocation_started=true
chown -hR root:root "$source_codex_home"
chmod 0700 "$source_codex_home"
bash "$SCRIPT_DIR/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45
drain_engaged=false
migration_complete=true
remove_activation_backup "$rollback_dir"
trap - EXIT INT TERM
printf 'Codex runner migration committed independently of the package upgrade.\n'
printf 'Previous profile retained root-only at %s; keep it for offline recovery until the new runner is accepted.\n' "$source_codex_home"
