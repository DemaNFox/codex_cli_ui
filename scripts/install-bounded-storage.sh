#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

readonly IMAGE_PATH=/var/lib/codex-web-ui-storage/codex-web-ui.ext4
readonly VOLUME_ROOT=/mnt/codex-web-ui-bounded
readonly FSTAB=/etc/fstab
readonly CONFIG=/etc/codex-web-ui/codex-web-ui.env
readonly BOUNDED_CODEX_HOME=/var/lib/codex-web-ui/codex-home
readonly FSTAB_BEGIN='# codex-web-ui bounded storage begin'
readonly FSTAB_END='# codex-web-ui bounded storage end'

service_user=ai-chat-agent
size_bytes=
inode_count=
dry_run=false
project_roots=()

usage() {
  cat <<'EOF'
Usage: sudo scripts/install-bounded-storage.sh --size-bytes BYTES --inode-count COUNT --project-root DIR [options]

Create a dedicated ext4 loop-backed volume and persistently bind its bounded
storage into the Codex Web UI state, project and release paths.

Required:
  --size-bytes BYTES       Exact upper size of the backing image (>= 1 GiB)
  --inode-count COUNT      Explicit filesystem inode count (>= 4096)
  --project-root DIR       Configured project root; repeat for every allowed root

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
    --project-root) project_roots+=("${2:?}"); shift 2 ;;
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
[[ ${#project_roots[@]} -gt 0 ]] || die 'at least one --project-root is required'

if $dry_run; then
  cat <<EOF
Codex Web UI bounded storage plan (no changes made)
  image: $IMAGE_PATH ($size_bytes bytes)
  filesystem: ext4 ($inode_count inodes requested)
  volume root: $VOLUME_ROOT
  bind: $VOLUME_ROOT/state -> /var/lib/codex-web-ui
  bind: $VOLUME_ROOT/releases -> /opt/codex-web-ui/releases
  CODEX_HOME: $BOUNDED_CODEX_HOME
  persistence: $FSTAB (loop,nodev,nosuid plus bind mounts)
  service user: $service_user
EOF
  for index in "${!project_roots[@]}"; do
    printf '  bind: %s/projects/%s -> %s\n' "$VOLUME_ROOT" "$index" "${project_roots[$index]}"
  done
  exit 0
fi

require_root
for command in awk cat chmod chown cp curl date df fallocate find findmnt getent grep id install \
  mkfs.ext4 mktemp mount mountpoint mv python3 realpath rmdir rsync sed stat systemctl umount unlink; do
  require_command "$command"
done
validate_service_user "$service_user"
service_group=$(id -gn "$service_user")

[[ -f $CONFIG && ! -L $CONFIG ]] || die "$CONFIG must be a regular non-symlink file"
[[ $(stat -c %U:%G -- "$CONFIG") == root:root ]] || die 'configuration must be root-owned'
[[ $(stat -c %a -- "$CONFIG") == 600 ]] || die 'configuration permissions must be 0600'

mapfile -t configured_home_values < <(sed -n 's/^CODEX_HOME=//p' "$CONFIG")
mapfile -t configured_root_values < <(sed -n 's/^CODEX_WEB_PROJECT_ROOTS=//p' "$CONFIG")
[[ ${#configured_home_values[@]} -eq 1 && -n ${configured_home_values[0]} ]] || \
  die 'configuration must contain exactly one non-empty CODEX_HOME'
[[ ${#configured_root_values[@]} -eq 1 && -n ${configured_root_values[0]} ]] || \
  die 'configuration must contain exactly one non-empty CODEX_WEB_PROJECT_ROOTS'

configured_codex_home=$(canonical_existing_dir "${configured_home_values[0]}")
[[ $configured_codex_home =~ ^/[A-Za-z0-9._/@+-]+$ ]] || \
  die 'configured CODEX_HOME contains unsupported systemd path characters'
IFS=, read -r -a configured_roots <<<"${configured_root_values[0]}"
[[ ${#configured_roots[@]} -gt 0 ]] || die 'configured project roots are empty'

canonical_roots=()
for root in "${project_roots[@]}"; do
  root=$(validate_project_root "$root")
  [[ $root =~ ^/[A-Za-z0-9._/@+-]+$ ]] || \
    die "project root contains unsupported persistent-mount characters: $root"
  for existing in "${canonical_roots[@]}"; do
    paths_overlap "$root" "$existing" && die "project roots overlap: $root and $existing"
  done
  for protected in /var/lib/codex-web-ui /var/lib/codex-web-ui-storage \
    /opt/codex-web-ui/releases "$VOLUME_ROOT"; do
    paths_overlap "$root" "$protected" && die "project root overlaps protected storage: $root"
  done
  paths_overlap "$root" "$configured_codex_home" && die "project root overlaps CODEX_HOME: $root"
  canonical_roots+=("$root")
done

canonical_configured_roots=()
for root in "${configured_roots[@]}"; do
  root=$(validate_project_root "$root")
  for existing in "${canonical_configured_roots[@]}"; do
    paths_overlap "$root" "$existing" && die "configured project roots overlap: $root and $existing"
  done
  canonical_configured_roots+=("$root")
done
[[ ${#canonical_roots[@]} -eq ${#canonical_configured_roots[@]} ]] || \
  die 'explicit project roots do not match configured project roots'
for configured_root in "${canonical_configured_roots[@]}"; do
  matched=false
  for root in "${canonical_roots[@]}"; do
    [[ $root == "$configured_root" ]] && matched=true
  done
  $matched || die "configured project root was not explicitly bounded: $configured_root"
done
for root in "${canonical_roots[@]}"; do
  matched=false
  for configured_root in "${canonical_configured_roots[@]}"; do
    [[ $root == "$configured_root" ]] && matched=true
  done
  $matched || die "explicit project root is not configured: $root"
done

declare -a TARGETS=(/var/lib/codex-web-ui /opt/codex-web-ui/releases)
declare -a VOLUME_DIRS=(state releases)
for index in "${!canonical_roots[@]}"; do
  TARGETS+=("${canonical_roots[$index]}")
  VOLUME_DIRS+=("projects/$index")
done

[[ -f $FSTAB && ! -L $FSTAB ]] || die "$FSTAB must be a regular non-symlink file"
if grep -Fqx -- "$FSTAB_BEGIN" "$FSTAB" || grep -Fqx -- "$FSTAB_END" "$FSTAB"; then
  die 'bounded storage is already registered in /etc/fstab'
fi
[[ ! -e $IMAGE_PATH ]] || die "backing image already exists: $IMAGE_PATH"
[[ ! -e $VOLUME_ROOT ]] || die "volume root already exists: $VOLUME_ROOT"

for target in "${TARGETS[@]}"; do
  [[ -d $target && ! -L $target ]] || die "storage source must be an existing non-symlink directory: $target"
  target=$(realpath -e -- "$target")
  mountpoint -q -- "$target" && die "storage source is already a mount point: $target"
done

[[ $configured_codex_home != /var/lib/codex-web-ui ]] || \
  die 'CODEX_HOME must not be the Web UI state root'
if [[ $configured_codex_home != "$BOUNDED_CODEX_HOME" ]]; then
  find -P "$configured_codex_home" -type l -print -quit | grep -q . && \
    die 'configured CODEX_HOME contains a symlink; refusing bounded copy'
  [[ ! -e $BOUNDED_CODEX_HOME ]] || \
    die "bounded CODEX_HOME destination already exists: $BOUNDED_CODEX_HOME"
fi

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
config_changed=false
dropin_changed=false
config_backup=
dropin_backup=
dropin_path="/etc/systemd/system/codex-web-ui@${service_user}.service.d/paths.conf"
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
  if $config_changed; then
    cp -a -- "$config_backup" "$CONFIG" || rollback_ok=false
  fi
  if $dropin_changed; then
    if [[ -n $dropin_backup ]]; then
      cp -a -- "$dropin_backup" "$dropin_path" || rollback_ok=false
    else
      unlink -- "$dropin_path" || rollback_ok=false
    fi
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
install -d -m 0755 -o root -g root "$VOLUME_ROOT/releases"
install -d -m 0750 -o "$service_user" -g "$service_group" "$VOLUME_ROOT/projects"
for index in "${!canonical_roots[@]}"; do
  install -d -m 0750 -o "$service_user" -g "$service_group" "$VOLUME_ROOT/projects/$index"
done

systemctl stop "$guard_timer" "$service_unit"

for index in "${!TARGETS[@]}"; do
  source_path=${TARGETS[$index]}
  destination="$VOLUME_ROOT/${VOLUME_DIRS[$index]}"
  rsync -aHAX --numeric-ids --one-file-system -- "$source_path/" "$destination/"
  differences=$(rsync -aHAXn --numeric-ids --one-file-system --delete --checksum --out-format='%i %n%L' \
    -- "$source_path/" "$destination/")
  [[ -z $differences ]] || die "copied data failed checksum verification: $source_path"
done

if [[ $configured_codex_home != "$BOUNDED_CODEX_HOME" ]]; then
  install -d -m 0700 -o "$service_user" -g "$service_group" "$VOLUME_ROOT/state/codex-home"
  rsync -aHAX --numeric-ids --one-file-system -- \
    "$configured_codex_home/" "$VOLUME_ROOT/state/codex-home/"
  differences=$(rsync -aHAXn --numeric-ids --one-file-system --delete --checksum --out-format='%i %n%L' \
    -- "$configured_codex_home/" "$VOLUME_ROOT/state/codex-home/")
  [[ -z $differences ]] || die 'copied CODEX_HOME failed checksum verification'
fi
[[ -d $VOLUME_ROOT/state/codex-home && ! -L $VOLUME_ROOT/state/codex-home ]] || \
  die 'bounded CODEX_HOME was not populated as a real directory'

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
$VOLUME_ROOT/releases /opt/codex-web-ui/releases none bind,nodev,nosuid,x-systemd.requires-mounts-for=$VOLUME_ROOT 0 0
EOF
for index in "${!canonical_roots[@]}"; do
  printf '%s/projects/%s %s none bind,nodev,nosuid,x-systemd.requires-mounts-for=%s 0 0\n' \
    "$VOLUME_ROOT" "$index" "${canonical_roots[$index]}" "$VOLUME_ROOT" >>"$fstab_temporary"
done
printf '%s\n' "$FSTAB_END" >>"$fstab_temporary"
chown root:root "$fstab_temporary"
chmod 0644 "$fstab_temporary"
mv -f -- "$fstab_temporary" "$FSTAB"
fstab_changed=true
findmnt --verify --tab-file "$FSTAB" >/dev/null

config_backup="/etc/codex-web-ui/codex-web-ui.env.pre-bounded-${backup_suffix}"
[[ ! -e $config_backup ]] || die "configuration backup already exists: $config_backup"
cp -a -- "$CONFIG" "$config_backup"
chown root:root "$config_backup"
chmod 0600 "$config_backup"
config_temporary=$(mktemp /etc/codex-web-ui/codex-web-ui.env.XXXXXX)
awk -v codex_home="$BOUNDED_CODEX_HOME" '
  /^CODEX_HOME=/ { print "CODEX_HOME=" codex_home; found++; next }
  { print }
  END { if (found != 1) exit 42 }
' "$CONFIG" >"$config_temporary"
chown root:root "$config_temporary"
chmod 0600 "$config_temporary"
mv -f -- "$config_temporary" "$CONFIG"
config_changed=true

if [[ -e $dropin_path ]]; then
  [[ -f $dropin_path && ! -L $dropin_path ]] || die "systemd path drop-in is not a regular file: $dropin_path"
  dropin_backup="/etc/codex-web-ui/codex-web-ui.paths.pre-bounded-${backup_suffix}"
  [[ ! -e $dropin_backup ]] || die "systemd path backup already exists: $dropin_backup"
  cp -a -- "$dropin_path" "$dropin_backup"
fi
write_path_drop_in "$service_user" "$BOUNDED_CODEX_HOME" "${canonical_roots[@]}"
dropin_changed=true
if [[ $configured_codex_home != "$BOUNDED_CODEX_HOME" ]]; then
  printf 'InaccessiblePaths=%s\n' "$configured_codex_home" >>"$dropin_path"
  chown root:root "$dropin_path"
  chmod 0644 "$dropin_path"
fi
systemctl daemon-reload

for target in "${TARGETS[@]}"; do
  mountpoint -q -- "$target" || die "persistent storage target is not mounted: $target"
done
[[ $(stat -c %a -- "$IMAGE_PATH") == 600 ]] || die 'backing image permissions are not 0600'
[[ $(stat -c %U:%G -- "$IMAGE_PATH") == root:root ]] || die 'backing image is not root-owned'

$timer_was_active && systemctl start "$guard_timer"
if $service_was_active; then
  systemctl start "$service_unit"
  "$SCRIPT_DIR/health-check.sh" \
    --service-user "$service_user" \
    --timeout 30 \
    --config "$CONFIG" || die 'service did not become healthy after bounded storage migration'
fi
migration_complete=true
trap - EXIT INT TERM

printf 'Installed bounded Codex Web UI storage: %s bytes, at most %s inodes.\n' \
  "$actual_bytes" "$actual_inodes"
printf 'Original data remains in rollback backups:\n'
printf '  %s\n' "${backups[@]}"
printf 'Verify the service and backups before removing any original data manually.\n'
