#!/usr/bin/env bash

set -euo pipefail

config=/etc/codex-web-ui/codex-web-ui.env
marker=/run/codex-web-ui/upgrade-drain
legacy_marker=/var/lib/codex-web-ui/data/upgrade-drain
legacy_stopped_marker=/run/codex-web-ui/legacy-upgrade-api-stopped
mode=begin
timeout=1800
service_user=api

usage() {
  cat <<'EOF'
Usage: scripts/graceful-drain.sh --begin|--release [options]

  --config FILE                  Protected Web UI configuration
  --timeout SECONDS              Maximum wait (default: 1800)
  --service-user USER            systemd instance owner (default: api)
Begin creates the fixed upgrade-drain marker and waits until /api/health proves
that new turns are blocked and no active or pending turn starts remain. Release
removes the marker and waits until the new API accepts turns again.
EOF
}

while (($#)); do
  case "$1" in
    --begin) mode=begin; shift ;;
    --release) mode=release; shift ;;
    --config) config=${2:?}; shift 2 ;;
    --timeout) timeout=${2:?}; shift 2 ;;
    --service-user) service_user=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'graceful drain: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  printf 'graceful drain must run as root\n' >&2
  exit 1
}
[[ $timeout =~ ^[1-9][0-9]{0,3}$ ]] || {
  printf 'graceful drain timeout must be 1-9999 seconds\n' >&2
  exit 2
}
[[ $service_user =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || {
  printf 'graceful drain service user is invalid\n' >&2
  exit 2
}
[[ -r $config ]] || { printf 'graceful drain configuration is not readable\n' >&2; exit 1; }
host=$(sed -n 's/^CODEX_WEB_HOST=//p' "$config")
port=$(sed -n 's/^CODEX_WEB_PORT=//p' "$config")
path=$(sed -n 's/^CODEX_WEB_HEALTH_PATH=//p' "$config")
[[ $host == 127.0.0.1 || $host == ::1 ]] || {
  printf 'graceful drain health host is not loopback\n' >&2
  exit 1
}
[[ $port =~ ^[0-9]{2,5}$ ]] || { printf 'graceful drain health port is invalid\n' >&2; exit 1; }
[[ $path =~ ^/[A-Za-z0-9_./-]{1,127}$ && $path != *..* ]] || {
  printf 'graceful drain health path is invalid\n' >&2
  exit 1
}
if [[ $host == ::1 ]]; then base="http://[::1]:$port"; else base="http://$host:$port"; fi

marker_parent=${marker%/*}
install -d -m 0755 -o root -g root "$marker_parent"
[[ -d $marker_parent && ! -L $marker_parent && $(stat -c '%u' "$marker_parent") == 0 && $((8#$(stat -c '%a' "$marker_parent") & 8#022)) == 0 ]] || {
  printf 'graceful drain marker parent is not a real directory\n' >&2
  exit 1
}
create_marker() {
  MARKER_PATH=$1 python3 - <<'PY'
import os
import stat
from pathlib import Path

path = Path(os.environ["MARKER_PATH"])
try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
except FileExistsError:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit("existing drain marker is unsafe")
else:
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o644)
    finally:
        os.close(descriptor)
PY
}

legacy_handoff=false
current_release=$(readlink -f -- /opt/codex-web-ui/current 2>/dev/null || true)
if [[ $mode == begin && -f $current_release/scripts/graceful-drain.sh ]] && \
  grep -Fxq 'marker=/var/lib/codex-web-ui/data/upgrade-drain' "$current_release/scripts/graceful-drain.sh"; then
  legacy_handoff=true
  legacy_parent=${legacy_marker%/*}
  [[ -d $legacy_parent && ! -L $legacy_parent ]] || {
    printf 'legacy drain marker parent is unavailable\n' >&2
    exit 1
  }
fi

response=$(mktemp /tmp/codex-web-ui-upgrade-drain-health.XXXXXX)
cleanup_response() { rm -f -- "$response"; }
trap cleanup_response EXIT

health_state() {
  local expected=$1 code
  code=$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 5 --noproxy '*' "$base$path" 2>/dev/null || true)
  [[ $code == 200 ]] || { printf 'unavailable'; return; }
  EXPECTED_DRAIN_STATE=$expected python3 - "$response" <<'PY' 2>/dev/null || printf 'invalid'
import json
import os
import sys

try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
if not isinstance(value, dict) or value.get("status") != "ready" or value.get("appServerReady") is not True:
    print("unavailable", end="")
    raise SystemExit(0)
drain = value.get("upgradeDrain")
if "upgradeDrain" not in value:
    print("legacy", end="")
    raise SystemExit(0)
if not isinstance(drain, dict) or drain.get("supported") is not True:
    raise SystemExit(1)
active = drain.get("activeTurns")
pending = drain.get("pendingTurnStarts")
if type(active) is not int or type(pending) is not int or active < 0 or pending < 0:
    raise SystemExit(1)
expected = os.environ["EXPECTED_DRAIN_STATE"]
if expected == "requested":
    ready = (
        drain.get("requested") is True
        and drain.get("acceptingNewTurns") is False
        and drain.get("idle") is True
        and active == 0
        and pending == 0
    )
else:
    ready = (
        drain.get("requested") is False
        and drain.get("acceptingNewTurns") is True
        and drain.get("idle") is False
    )
print("ready" if ready else "waiting", end="")
PY
}

if [[ $mode == begin ]]; then
  api_state=$(systemctl is-active "codex-web-ui@${service_user}.service" 2>/dev/null || true)
  if [[ $api_state != active ]]; then
    active_runners=$(systemctl list-units --type=service --state=active \
      'codex-web-ui-app-server@*.service' --no-legend --plain 2>/dev/null || true)
    [[ -z $active_runners ]] || {
      printf 'cannot prove idle: API is not active but an app-server runner is active\n' >&2
      exit 1
    }
    printf 'upgrade drain: API and app-server runners are inactive\n'
    exit 0
  fi

  marker_owned=false
  legacy_api_stopped=false
  rollback_marker() {
    local status=$?
    trap - EXIT INT TERM
    cleanup_response
    if [[ $status -ne 0 && $marker_owned == true ]]; then
      rm -f -- "$marker" "$legacy_marker" "$legacy_stopped_marker"
      if $legacy_api_stopped; then systemctl start "codex-web-ui@${service_user}.service" >/dev/null 2>&1 || true; fi
    fi
    exit "$status"
  }
  trap rollback_marker EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The marker carries no secret data. O_EXCL|O_NOFOLLOW prevents an
  # unprivileged parent owner from redirecting the one-time legacy handoff.
  create_marker "$marker"
  marker_owned=true
  if $legacy_handoff; then create_marker "$legacy_marker"; fi
  expected=requested
else
  rm -f -- "$marker" "$legacy_marker"
  if [[ -f $legacy_stopped_marker ]]; then
    if [[ $(systemctl is-active "codex-web-ui@${service_user}.service" 2>/dev/null || true) != active ]]; then
      systemctl start "codex-web-ui@${service_user}.service"
    fi
    rm -f -- "$legacy_stopped_marker"
  fi
  expected=released
fi

deadline=$((SECONDS + timeout))
while (( SECONDS < deadline )); do
  state=$(health_state "$expected")
  case "$state" in
    ready)
      if [[ $mode == begin && $legacy_handoff == true ]]; then
        systemctl stop "codex-web-ui@${service_user}.service"
        legacy_api_stopped=true
        for _attempt in {1..10}; do
          active_runners=$(systemctl list-units --type=service --state=active \
            'codex-web-ui-app-server@*.service' --no-legend --plain 2>/dev/null || true)
          [[ -z $active_runners ]] && break
          sleep 1
        done
        [[ -z $active_runners ]] || {
          printf 'legacy handoff could not stop all app-server runners\n' >&2
          exit 1
        }
        create_marker "$legacy_stopped_marker"
      fi
      if [[ $mode == begin ]]; then marker_owned=false; fi
      printf 'upgrade drain: %s state confirmed\n' "$expected"
      exit 0
      ;;
    legacy)
      printf '%s\n' 'upgrade drain: installed API lacks drain telemetry; fence external turn admission, wait for idle, stop the legacy API, verify all app-server runners are inactive, then rerun the upgrade' >&2
      exit 1
      ;;
    invalid)
      printf 'upgrade drain: health response has an invalid drain contract\n' >&2
      exit 1
      ;;
    waiting|unavailable) ;;
    *) printf 'upgrade drain: unexpected health state\n' >&2; exit 1 ;;
  esac
  sleep 1
done

printf 'upgrade drain timed out after %s seconds; activation was not attempted\n' "$timeout" >&2
exit 1
