#!/usr/bin/env bash

set -Eeuo pipefail

if [[ ${1:-} != --relocated ]]; then
  relocated="/run/codex-web-ui/.codex-update-worker.$$"
  install -m 0700 -o root -g root -- "$0" "$relocated"
  exec bash "$relocated" --relocated
fi
[[ $0 =~ ^/run/codex-web-ui/\.codex-update-worker\.[0-9]+$ ]] || {
  printf 'Codex update worker relocation is invalid.\n' >&2
  exit 1
}
self_copy=$0
cleanup_self() { rm -f -- "$self_copy"; }
trap cleanup_self EXIT

candidate_link=/opt/codex-web-ui/codex-update-candidate
current_link=/opt/codex-web-ui/current
result_path=/var/lib/codex-web-ui/codex-update-result.json
lock_path=/run/codex-web-ui/codex-update.lock
candidate_lock_path=/run/codex-web-ui/codex-update-candidate.lock
broker=/usr/local/libexec/codex-web-ui-codex-update-broker
config=/etc/codex-web-ui/codex-web-ui.env

[[ ${EUID:-$(id -u)} -eq 0 ]] || { printf 'Codex update worker must run as root.\n' >&2; exit 1; }
for command in flock readlink stat python3 install date; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done

exec 9>"$lock_path"
flock -n 9 || { printf 'Another Codex update is already running.\n' >&2; exit 1; }
exec 8>"$candidate_lock_path"

previous=$(readlink -f -- "$current_link") || { printf 'Installed release is unavailable.\n' >&2; exit 1; }
flock 8
candidate=$($broker --validate-candidate-path) || { printf 'Prepared update validation failed.\n' >&2; exit 1; }
flock -u 8
case "$candidate" in /opt/codex-web-ui/releases/*) ;; *) printf 'Prepared update escaped managed releases.\n' >&2; exit 1 ;; esac
candidate_id=${candidate##*/}
[[ $candidate =~ ^/opt/codex-web-ui/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || {
  printf 'Prepared update identifier is unsafe.\n' >&2
  exit 1
}
write_result() {
  local status=${1:?status required} message=${2:?message required} temporary
  temporary=$(mktemp /var/lib/codex-web-ui/.codex-update-result.XXXXXX)
  STATUS=$status MESSAGE=$message COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    CANDIDATE_ID=$candidate_id RESULT_FILE=$temporary python3 - <<'PY'
import json
import os
from pathlib import Path

value = {
    "schemaVersion": 1,
    "candidateReleaseId": os.environ["CANDIDATE_ID"],
    "status": os.environ["STATUS"],
    "message": os.environ["MESSAGE"][:240],
    "completedAt": os.environ["COMPLETED_AT"],
}
Path(os.environ["RESULT_FILE"]).write_text(
    json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8"
)
PY
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$result_path"
}

status=failed
message='Codex update failed; the previous healthy release was restored.'
finish() {
  local code=$?
  if ((code != 0)); then
    active=$(readlink -f -- "$current_link" 2>/dev/null || true)
    if [[ $active != "$previous" ]] || \
      ! "$previous/scripts/health-check.sh" --service-user api --timeout 45 >/dev/null 2>&1; then
      status=rollback_failed
      message='Codex update failed and automatic rollback could not be verified.'
    fi
    write_result "$status" "$message"
  fi
  cleanup_self
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -f $config && ! -L $config && $(stat -c '%u' "$config") == 0 ]] || {
  printf 'Installed configuration is unsafe.\n' >&2
  exit 1
}
public_origin=$(sed -n 's/^CODEX_WEB_PUBLIC_ORIGIN=//p' "$config")
[[ -n $public_origin ]] || { printf 'Installed public origin is unavailable.\n' >&2; exit 1; }

# Revalidate immediately before the fixed installer entry point. The browser
# never supplies this path or any argument passed to it.
flock 8
validated_candidate=$($broker --validate-candidate-path) || validated_candidate=
flock -u 8
[[ $validated_candidate == "$candidate" ]] || {
  printf 'Prepared update changed during validation.\n' >&2
  exit 1
}
bash "$candidate/scripts/install-package.sh" \
  --package "$candidate" \
  --upgrade \
  --public-origin "$public_origin" \
  --external-proxy

active=$(readlink -f -- "$current_link")
[[ $active != "$previous" ]] || { printf 'Update did not activate a new release.\n' >&2; exit 1; }
"$active/scripts/health-check.sh" --service-user api --timeout 45
write_result succeeded 'Codex update completed successfully.'
cleanup_self
trap - EXIT INT TERM
