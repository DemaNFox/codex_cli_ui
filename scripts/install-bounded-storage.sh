#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

readonly IMAGE_PATH=/var/lib/codex-web-ui-storage/codex-web-ui.ext4
readonly VOLUME_ROOT=/mnt/codex-web-ui-bounded
readonly FSTAB=/etc/fstab
readonly FSTAB_BEGIN='# codex-web-ui bounded storage begin'
readonly FSTAB_END='# codex-web-ui bounded storage end'

service_user=ai-chat-agent
size_bytes=
inode_count=
dry_run=false

usage() {
  cat <<'EOF'
Usage: sudo scripts/install-bounded-storage.sh --size-bytes BYTES --inode-count COUNT [options]

Create a dedicated ext4 loop-backed volume and persistently bind its bounded
storage into the Codex Web UI state, project and release paths.

Required:
  --size-bytes BYTES       Exact upper size of the backing image (>= 1 GiB)
  --inode-count COUNT      Explicit filesystem inode count (>= 4096)

Options:
  --service-user USER      Existing non-root service user (default: ai-chat-agent)
  --dry-run                Print the fixed storage plan without changing the host
  --help                   Show this help

The installer preserves each original directory as a timestamped backup. It
does not delete source data. A failed migration unmounts the new boundary,
restores the original paths and restarts services that were active beforehand.
EOF
}

while (($#)); do
  case "$1" in
    --size-bytes) size_bytes=${2:?}; shift 2 ;;
    --inode-count) inode_count=${2:?}; shift 2 ;;
    --service-user) service_user=${2:?}; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ ${size_bytes:-} =~ ^[1-9][0-9]*$ ]] || die '--size-bytes must be a positive integer'
[[ ${inode_count:-} =~ ^[1-9][0-9]*$ ]] || die '--inode-count must be a positive integer'
((size_bytes >= 1073741824)) || die '--size-bytes must be at least 1073741824'
((inode_count >= 4096)) || die '--inode-count must be at least 4096'
[[ $service_user =~ ^[a-z_][a-z0-9_-]{0,30}$ && $service_user != root ]] || die 'invalid service user'

if $dry_run; then
  cat <<EOF
Codex Web UI bounded storage plan (no changes made)
  image: $IMAGE_PATH ($size_bytes bytes)
  filesystem: ext4 ($inode_count inodes requested)
  volume root: $VOLUME_ROOT
  bind: $VOLUME_ROOT/state -> /var/lib/codex-web-ui
  bind: $VOLUME_ROOT/projects -> /srv/codex-projects
  bind: $VOLUME_ROOT/releases -> /opt/codex-web-ui/releases
  persistence: $FSTAB (loop,nodev,nosuid plus bind mounts)
  service user: $service_user
EOF
  exit 0
fi

require_root
for command in awk cat chmod chown curl date df fallocate findmnt getent grep id install \
  mkfs.ext4 mktemp mount mountpoint mv realpath rmdir rsync seq sleep stat systemctl umount; do
  require_command "$command"
done
validate_service_user "$service_user"
service_group=$(id -gn "$service_user")

readonly -a TARGETS=(
  /var/lib/codex-web-ui
  /srv/codex-projects
  /opt/codex-web-ui/releases
)
readonly -a VOLUME_DIRS=(state projects releases)

[[ -f $FSTAB && ! -L $FSTAB ]] || die "$FSTAB must be a regular non-symlink file"
if grep -Fqx -- "$FSTAB_BEGIN" "$FSTAB" || grep -Fqx -- "$FSTAB_END" "$FSTAB"; then
  die 'bounded storage is already registered in /etc/fstab'
fi
[[ ! -e $IMAGE_PATH ]] || die "backing image already exists: $IMAGE_PATH"
[[ ! -e $VOLUME_ROOT ]] || die "volume root already exists: $VOLUME_ROOT"

for target in "${TARGETS[@]}"; do
  [[ -d $target && ! -L $target ]] || die "storage source must be an existing non-symlink directory: $target"
  target=$(realpath -e -- "$target")
  case "$target" in
    /var/lib/codex-web-ui|/srv/codex-projects|/opt/codex-web-ui/releases) ;;
    *) die "storage source resolves outside its fixed path: $target" ;;
  esac
  mountpoint -q -- "$target" && die "storage source is already a mount point: $target"
done

service_unit="codex-web-ui@${service_user}.service"
guard_timer="codex-web-ui-storage-guard@${service_user}.timer"
service_was_active=false
timer_was_active=false
systemctl is-active --quiet "$service_unit" && service_was_active=true
systemctl is-active --quiet "$guard_timer" && timer_was_active=true

declare -a backups=()
declare -a bound_targets=()
volume_mounted=false
fstab_changed=false
migration_complete=false

remove_fstab_block() {
  local temporary
  temporary=$(mktemp /etc/fstab.codex-web-ui.XXXXXX)
  awk -v begin="$FSTAB_BEGIN" -v end="$FSTAB_END" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$FSTAB" >"$temporary"
  chown root:root "$temporary"
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$FSTAB"
}

rollback() {
  local exit_code=$?
  local rollback_ok=true
  $migration_complete && return
  trap - EXIT INT TERM
  set +e
  printf 'codex-web-ui: bounded storage migration failed; restoring original paths\n' >&2
  systemctl stop "$guard_timer" "$service_unit" || rollback_ok=false
  if $fstab_changed; then
    remove_fstab_block || rollback_ok=false
  fi
  for ((index=${#bound_targets[@]} - 1; index >= 0; index--)); do
    if mountpoint -q -- "${bound_targets[$index]}"; then
      umount -- "${bound_targets[$index]}" || rollback_ok=false
    fi
  done
  for ((index=${#backups[@]} - 1; index >= 0; index--)); do
    target=${TARGETS[$index]}
    backup=${backups[$index]}
    if [[ -d $target && ! -L $target ]]; then
      rmdir -- "$target" || rollback_ok=false
    fi
    if [[ -d $backup && ! -L $backup && ! -e $target ]]; then
      mv -- "$backup" "$target" || rollback_ok=false
    else
      rollback_ok=false
    fi
  done
  if $volume_mounted && mountpoint -q -- "$VOLUME_ROOT"; then
    umount -- "$VOLUME_ROOT" || rollback_ok=false
  fi
  if [[ -d $VOLUME_ROOT && ! -L $VOLUME_ROOT ]]; then
    rmdir -- "$VOLUME_ROOT" || rollback_ok=false
  fi
  systemctl daemon-reload || rollback_ok=false
  if $rollback_ok; then
    $timer_was_active && systemctl start "$guard_timer"
    $service_was_active && systemctl start "$service_unit"
  else
    printf 'codex-web-ui: rollback needs administrator recovery; service remains stopped\n' >&2
  fi
  exit "$exit_code"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -m 0700 -o root -g root "$(dirname -- "$IMAGE_PATH")"
fallocate --length "$size_bytes" "$IMAGE_PATH"
chown root:root "$IMAGE_PATH"
chmod 0600 "$IMAGE_PATH"
mkfs.ext4 -F -q -N "$inode_count" -L codex-web-ui-bounded "$IMAGE_PATH"
install -d -m 0755 -o root -g root "$VOLUME_ROOT"
mount -o loop,nodev,nosuid -- "$IMAGE_PATH" "$VOLUME_ROOT"
volume_mounted=true

actual_bytes=$(df -B1 --output=size "$VOLUME_ROOT" | awk 'NR == 2 { print $1 }')
actual_inodes=$(df -i --output=itotal "$VOLUME_ROOT" | awk 'NR == 2 { print $1 }')
[[ $actual_bytes =~ ^[0-9]+$ && $actual_bytes -le $size_bytes ]] || \
  die 'mounted filesystem exceeds the requested byte boundary'
[[ $actual_inodes =~ ^[0-9]+$ && $actual_inodes -le $inode_count ]] || \
  die 'mounted filesystem exceeds the requested inode boundary'
[[ $(findmnt -n -o FSTYPE --target "$VOLUME_ROOT") == ext4 ]] || \
  die 'bounded volume is not mounted as ext4'

install -d -m 0700 -o "$service_user" -g "$service_group" "$VOLUME_ROOT/state"
install -d -m 0750 -o "$service_user" -g "$service_group" "$VOLUME_ROOT/projects"
install -d -m 0755 -o root -g root "$VOLUME_ROOT/releases"

systemctl stop "$guard_timer" "$service_unit"

for index in "${!TARGETS[@]}"; do
  source_path=${TARGETS[$index]}
  destination="$VOLUME_ROOT/${VOLUME_DIRS[$index]}"
  rsync -aHAX --numeric-ids --one-file-system -- "$source_path/" "$destination/"
  differences=$(rsync -aHAXn --numeric-ids --one-file-system --delete --checksum --out-format='%i %n%L' \
    -- "$source_path/" "$destination/")
  [[ -z $differences ]] || die "copied data failed checksum verification: $source_path"
done

backup_suffix=$(date -u +%Y%m%dT%H%M%SZ).$$
for index in "${!TARGETS[@]}"; do
  target=${TARGETS[$index]}
  backup="${target}.pre-bounded-${backup_suffix}"
  [[ ! -e $backup ]] || die "backup path already exists: $backup"
  mv -- "$target" "$backup"
  backups+=("$backup")
  install -d -m 0755 -o root -g root "$target"
  mount --bind "$VOLUME_ROOT/${VOLUME_DIRS[$index]}" "$target"
  mount -o remount,bind,nodev,nosuid "$target"
  bound_targets+=("$target")
  mountpoint -q -- "$target" || die "bind mount validation failed: $target"
  [[ $(stat -c %d -- "$target") == $(stat -c %d -- "$VOLUME_ROOT/${VOLUME_DIRS[$index]}") ]] || \
    die "bind mount device validation failed: $target"
done

fstab_temporary=$(mktemp /etc/fstab.codex-web-ui.XXXXXX)
cat -- "$FSTAB" >"$fstab_temporary"
printf '\n%s\n' "$FSTAB_BEGIN" >>"$fstab_temporary"
cat >>"$fstab_temporary" <<EOF
$IMAGE_PATH $VOLUME_ROOT ext4 loop,nodev,nosuid 0 2
$VOLUME_ROOT/state /var/lib/codex-web-ui none bind,nodev,nosuid,x-systemd.requires-mounts-for=$VOLUME_ROOT 0 0
$VOLUME_ROOT/projects /srv/codex-projects none bind,nodev,nosuid,x-systemd.requires-mounts-for=$VOLUME_ROOT 0 0
$VOLUME_ROOT/releases /opt/codex-web-ui/releases none bind,nodev,nosuid,x-systemd.requires-mounts-for=$VOLUME_ROOT 0 0
$FSTAB_END
EOF
chown root:root "$fstab_temporary"
chmod 0644 "$fstab_temporary"
mv -f -- "$fstab_temporary" "$FSTAB"
fstab_changed=true
findmnt --verify --tab-file "$FSTAB" >/dev/null
systemctl daemon-reload

for target in "${TARGETS[@]}"; do
  mountpoint -q -- "$target" || die "persistent storage target is not mounted: $target"
done
[[ $(stat -c %a -- "$IMAGE_PATH") == 600 ]] || die 'backing image permissions are not 0600'
[[ $(stat -c %U:%G -- "$IMAGE_PATH") == root:root ]] || die 'backing image is not root-owned'

$timer_was_active && systemctl start "$guard_timer"
if $service_was_active; then
  systemctl start "$service_unit"
  healthy=false
  for _ in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:3210/api/health >/dev/null; then
      healthy=true
      break
    fi
    sleep 1
  done
  $healthy || die 'service did not become healthy after bounded storage migration'
fi
migration_complete=true
trap - EXIT INT TERM

printf 'Installed bounded Codex Web UI storage: %s bytes, at most %s inodes.\n' \
  "$actual_bytes" "$actual_inodes"
printf 'Original data remains in rollback backups:\n'
printf '  %s\n' "${backups[@]}"
printf 'Verify the service and backups before removing any original data manually.\n'
