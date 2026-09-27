#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'codex-web-ui app-server: %s\n' "$*" >&2
  exit 1
}

: "${CODEX_BIN:?CODEX_BIN is required}"
: "${CODEX_HOME:?CODEX_HOME is required}"
: "${CODEX_WEB_CODEX_VERSION_PIN:?CODEX_WEB_CODEX_VERSION_PIN is required}"

[[ $CODEX_BIN = /* && -f $CODEX_BIN && -x $CODEX_BIN && ! -L $CODEX_BIN ]] || \
  die 'CODEX_BIN must be an absolute executable regular non-symlink file'
[[ $(stat -c '%u' "$CODEX_BIN") == 0 ]] || die 'CODEX_BIN must be owned by root'
binary_mode=$(stat -c '%a' "$CODEX_BIN")
(( (8#$binary_mode & 8#022) == 0 )) || die 'CODEX_BIN must not be writable by group or other users'

[[ $CODEX_HOME = /* && -d $CODEX_HOME && ! -L $CODEX_HOME ]] || \
  die 'CODEX_HOME must be an absolute regular directory'
[[ $(stat -c '%u' "$CODEX_HOME") == $(id -u) ]] || die 'CODEX_HOME must be owned by the runner user'
home_mode=$(stat -c '%a' "$CODEX_HOME")
(( (8#$home_mode & 8#077) == 0 )) || die 'CODEX_HOME must not be accessible by group or other users'

actual_version=$($CODEX_BIN --version)
[[ $actual_version == "$CODEX_WEB_CODEX_VERSION_PIN" ]] || \
  die "Codex version mismatch: expected $CODEX_WEB_CODEX_VERSION_PIN"

exec "$CODEX_BIN" app-server --listen stdio://
