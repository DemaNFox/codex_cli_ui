#!/usr/bin/env bash

set -euo pipefail

service_user=${1:-}
config=/etc/codex-web-ui/codex-web-ui.env
guard=/usr/local/libexec/codex-web-ui-storage-guard

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  printf 'codex-web-ui storage enforcement must run as root\n' >&2
  exit 1
}
[[ $service_user =~ ^[a-z_][a-z0-9_-]{0,30}$ && $service_user != root ]] || {
  printf 'invalid service user\n' >&2
  exit 2
}

if ! "$guard" --config "$config"; then
  printf 'storage boundary violated; stopping codex-web-ui service\n' >&2
  systemctl stop "codex-web-ui@${service_user}.service"
  exit 1
fi
