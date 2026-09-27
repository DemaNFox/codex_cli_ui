#!/usr/bin/env bash

set -euo pipefail

service_user=ai-chat-agent
timeout=30
config=/etc/codex-web-ui/codex-web-ui.env

while (($#)); do
  case "$1" in
    --service-user) service_user=${2:?}; shift 2 ;;
    --timeout) timeout=${2:?}; shift 2 ;;
    --config) config=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: scripts/health-check.sh [--service-user USER] [--timeout SECONDS] [--config FILE]\n'
      exit 0
      ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  printf 'health check must run as root to read the protected configuration\n' >&2
  exit 1
}
[[ $service_user =~ ^[a-z_][a-z0-9_-]{0,30}$ && $service_user != root ]] || {
  printf 'invalid service user\n' >&2
  exit 2
}
[[ $timeout =~ ^[1-9][0-9]{0,3}$ ]] || { printf 'invalid timeout\n' >&2; exit 2; }
[[ -r $config ]] || { printf 'configuration is not readable\n' >&2; exit 1; }
python3 "$SCRIPT_DIR/storage-guard.py" --config "$config"

host=$(sed -n 's/^CODEX_WEB_HOST=//p' "$config")
port=$(sed -n 's/^CODEX_WEB_PORT=//p' "$config")
path=$(sed -n 's/^CODEX_WEB_HEALTH_PATH=//p' "$config")
[[ $host == 127.0.0.1 || $host == ::1 ]] || { printf 'health host is not loopback\n' >&2; exit 1; }
[[ $port =~ ^[0-9]{2,5}$ ]] || { printf 'invalid health port\n' >&2; exit 1; }
[[ $path =~ ^/[A-Za-z0-9_./-]{1,127}$ && $path != *..* ]] || { printf 'invalid health path\n' >&2; exit 1; }

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet "codex-web-ui@${service_user}.service" || {
    printf 'service is not active\n' >&2
    exit 1
  }
fi

if [[ $host == ::1 ]]; then base="http://[::1]:$port"; else base="http://$host:$port"; fi
deadline=$((SECONDS + timeout))
while (( SECONDS < deadline )); do
  code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 5 --noproxy '*' "$base$path" 2>/dev/null || true)
  if [[ $code =~ ^2[0-9][0-9]$ ]]; then
    printf 'healthy: %s%s (%s)\n' "$base" "$path" "$code"
    exit 0
  fi
  sleep 1
done
printf 'health check timed out after %s seconds\n' "$timeout" >&2
exit 1
