#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'codex-web-ui: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die 'this command must run as root'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_service_user() {
  local user=${1:?service user required}
  [[ $user =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die 'invalid service user'
  [[ $user != root ]] || die 'the service user must not be root'
  getent passwd "$user" >/dev/null || die "service user does not exist: $user"
}

canonical_existing_dir() {
  local path=${1:?path required}
  [[ $path = /* ]] || die "path must be absolute: $path"
  [[ ! $path =~ [[:space:],:] ]] || die "path contains unsupported characters: $path"
  [[ -d $path && ! -L $path ]] || die "directory must exist and not be a symlink: $path"
  realpath -e -- "$path"
}

canonical_existing_file() {
  local path=${1:?path required}
  [[ $path = /* ]] || die "path must be absolute: $path"
  [[ -f $path ]] || die "file does not exist: $path"
  realpath -e -- "$path"
}

validate_project_root() {
  local path
  path=$(canonical_existing_dir "$1")
  case "$path" in
    /|/bin|/boot|/dev|/etc|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/usr|/var|/opt)
      die "project root is too broad or protected: $path"
      ;;
  esac
  printf '%s\n' "$path"
}

paths_overlap() {
  local first=${1%/}/ second=${2%/}/
  [[ $first == "$second"* || $second == "$first"* ]]
}

validate_release_id() {
  local value=${1:?release id required}
  [[ $value =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || die 'invalid release id'
}

validate_release_source() {
  local source codex_home entry target
  source=$(canonical_existing_dir "$1")
  codex_home=$(canonical_existing_dir "$2")
  paths_overlap "$source" "$codex_home" && die 'release source and CODEX_HOME must not overlap'
  [[ -f "$source/apps/server/dist/index.js" ]] || die 'prepared release is missing apps/server/dist/index.js'
  [[ -f "$source/apps/web/dist/index.html" ]] || die 'prepared release is missing apps/web/dist/index.html'

  while IFS= read -r -d '' entry; do
    case "${entry##*/}" in
      .env|.env.*|.npmrc|.yarnrc|.git-credentials|auth.json|credentials.json|cookies.json|id_rsa|id_ed25519|*.sqlite|*.sqlite3|*.db)
        [[ ${entry##*/} == .env.example ]] && continue
        die "release source contains forbidden sensitive/runtime file: $entry"
        ;;
    esac
  done < <(find -P "$source" -mindepth 1 \
    \( -type f -o -type d -o -type l \) -print0)

  while IFS= read -r -d '' entry; do
    target=$(realpath -e -- "$entry") || die "broken release symlink: $entry"
    case "$target" in
      "$source"|"$source"/*) ;;
      *) die "release symlink escapes source: $entry" ;;
    esac
  done < <(find -P "$source" -type l -print0)

  if find -P "$source" -mindepth 1 ! -type f ! -type d ! -type l -print -quit | grep -q .; then
    die 'release source contains a special file'
  fi
  printf '%s\n' "$source"
}

atomic_symlink() {
  local target=${1:?target required} link=${2:?link required} temporary
  temporary="${link}.new.$$"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$link"
}

write_path_drop_in() {
  local user=${1:?user required} codex_home=${2:?codex home required}
  shift 2
  local directory="/etc/systemd/system/codex-web-ui@${user}.service.d"
  local temporary root
  install -d -m 0755 "$directory"
  temporary=$(mktemp "$directory/paths.conf.XXXXXX")
  chmod 0644 "$temporary"
  {
    printf '[Service]\n'
    printf 'ReadWritePaths=%s\n' "$codex_home"
    for root in "$@"; do
      printf 'ReadWritePaths=%s\n' "$root"
    done
  } >"$temporary"
  mv -f -- "$temporary" "$directory/paths.conf"
}

copy_release() {
  local source=${1:?source required} destination=${2:?destination required}
  [[ ! -e $destination ]] || die "release already exists: $destination"
  install -d -m 0755 "$destination"
  cp -a --no-preserve=ownership -- "$source/." "$destination/"
  chown -R root:root "$destination"
  chmod -R go-w "$destination"
}
