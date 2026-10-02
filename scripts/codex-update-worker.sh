#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${1:-} != --relocated ]]; then
  relocated="/run/codex-web-ui/.codex-update-worker.$$"
  install -m 0700 -o root -g root -- "$0" "$relocated"
  exec bash "$relocated" --relocated
fi
[[ $0 =~ ^/run/codex-web-ui/\.codex-update-worker\.[0-9]+$ ]] || exit 1
self_copy=$0
cleanup_self() { rm -f -- "$self_copy"; }
trap cleanup_self EXIT

current_link=/opt/codex-web-ui/current
runtime_root=/opt/codex-web-ui/runtime
result_path=/var/lib/codex-web-ui/codex-update-result.json
config=/etc/codex-web-ui/codex-web-ui.env
runner_config=/etc/codex-web-ui/codex-runner.env
broker=/usr/local/libexec/codex-web-ui-codex-update-broker
api_user=codex-web-ui-api
[[ ${EUID:-$(id -u)} -eq 0 ]] || { printf 'Codex update worker must run as root.\n' >&2; exit 1; }
for command in flock readlink stat python3 install date runuser systemctl mktemp mv chmod chown rm sed awk uname bash; do command -v "$command" >/dev/null || exit 1; done
exec 9>/run/codex-web-ui/codex-update.lock
flock -n 9 || { printf 'Another Codex update is already running.\n' >&2; exit 1; }
exec 8>/run/codex-web-ui/codex-update-candidate.lock
previous=$(readlink -f -- "$current_link") || exit 1
flock 8
update_json=$($broker --resolve-update-json) || { printf 'Codex update target validation failed.\n' >&2; exit 1; }
flock -u 8
eval "$(UPDATE_JSON=$update_json python3 - <<'PY'
import json,os,re,shlex
v=json.loads(os.environ['UPDATE_JSON']); kind=v.get('kind'); version=v.get('version'); cid=v.get('candidateReleaseId')
if kind not in {'full-package','runtime'} or not isinstance(version,str) or not re.fullmatch(r'\d+\.\d+\.\d+',version): raise SystemExit(1)
if not isinstance(cid,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',cid): raise SystemExit(1)
print('update_kind='+shlex.quote(kind)); print('target_version='+shlex.quote(version)); print('candidate_id='+shlex.quote(cid))
key='path' if kind=='full-package' else 'packageRoot'; path=v.get(key)
if not isinstance(path,str) or not re.fullmatch(r'/opt/codex-web-ui/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}',path): raise SystemExit(1)
print(('candidate=' if kind=='full-package' else 'package_root=')+shlex.quote(path))
PY
)" || exit 1

write_result() {
  local temporary; temporary=$(mktemp /var/lib/codex-web-ui/.codex-update-result.XXXXXX)
  STATUS=$1 MESSAGE=$2 COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) CANDIDATE_ID=$candidate_id RESULT_FILE=$temporary python3 - <<'PY'
import json,os
from pathlib import Path
v={'schemaVersion':1,'candidateReleaseId':os.environ['CANDIDATE_ID'],'status':os.environ['STATUS'],'message':os.environ['MESSAGE'][:240],'completedAt':os.environ['COMPLETED_AT']}
Path(os.environ['RESULT_FILE']).write_text(json.dumps(v,separators=(',',':'),sort_keys=True)+'\n',encoding='utf-8')
PY
  chmod 0600 "$temporary"; chown root:root "$temporary"; mv -f -- "$temporary" "$result_path"
}

apply_full_package() {
  local verified origin active
  flock 8; verified=$($broker --validate-candidate-path) || verified=; flock -u 8
  [[ $verified == "$candidate" ]] || return 1
  [[ -f $config && ! -L $config && $(stat -c '%u' "$config") == 0 ]] || return 1
  origin=$(sed -n 's/^CODEX_WEB_PUBLIC_ORIGIN=//p' "$config"); [[ -n $origin ]] || return 1
  bash "$candidate/scripts/install-package.sh" --package "$candidate" --upgrade --public-origin "$origin" --external-proxy
  active=$(readlink -f -- "$current_link"); [[ $active != "$previous" ]] || return 1
  "$active/scripts/health-check.sh" --service-user api --timeout 45
}

runtime_stage=
runtime_schemas=
runtime_backups=
runtime_dir=
runtime_drain=false
runtime_switched=false
runtime_created=false

rollback_runtime() {
  local failed=false can_remove=true restore_ok=true
  if $runtime_switched; then
    can_remove=false
    [[ -f $runtime_backups/runner && -f $runtime_backups/api ]] || restore_ok=false
    if $restore_ok; then
      install -m 0600 -o root -g root "$runtime_backups/runner" "$runner_config" || restore_ok=false
      install -m 0600 -o root -g root "$runtime_backups/api" "$config" || restore_ok=false
    fi
    if $restore_ok; then
      systemctl restart codex-web-ui-app-server.socket codex-web-ui@api.service || restore_ok=false
      "$previous/scripts/health-check.sh" --service-user api --timeout 45 >/dev/null 2>&1 || restore_ok=false
    fi
    if $restore_ok; then can_remove=true; else failed=true; fi
  fi
  if $runtime_drain; then
    bash "$previous/scripts/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45 >/dev/null 2>&1 || failed=true
  fi
  if $runtime_created && $can_remove; then
    if [[ $runtime_dir =~ ^/opt/codex-web-ui/runtime/toolchain-pnpm-[0-9]+\.[0-9]+\.[0-9]+-codex-[0-9]+\.[0-9]+\.[0-9]+-(x64|arm64)$ ]]; then
      rm -rf --one-file-system -- "$runtime_dir" || failed=true
    else
      failed=true
    fi
  fi
  for path in "$runtime_stage" "$runtime_schemas" "$runtime_backups"; do
    [[ -z $path ]] && continue
    case "$path" in
      /opt/codex-web-ui/runtime/.codex-runtime-stage.*|/var/lib/codex-web-ui/.codex-runtime-schema.*|/run/codex-web-ui/.codex-runtime-backup.*)
        rm -rf --one-file-system -- "$path" 2>/dev/null || failed=true ;;
      *) failed=true ;;
    esac
  done
  ! $failed
}

apply_runtime() {
  local arch pnpm bin stage_error
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) return 1 ;; esac
  pnpm=$(sed -n 's/^PNPM_VERSION=//p' "$package_root/infra/toolchain.env")
  [[ $pnpm =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  runtime_dir="$runtime_root/toolchain-pnpm-${pnpm}-codex-${target_version}-${arch}"
  [[ ! -e $runtime_dir ]] || { printf 'Reviewed runtime target already exists; install a full app package for recovery.\n' >&2; return 1; }
  install -d -m 0755 -o root -g root "$runtime_root"
  runtime_stage=$(mktemp -d "$runtime_root/.codex-runtime-stage.XXXXXX")
  runtime_schemas=$(mktemp -d /var/lib/codex-web-ui/.codex-runtime-schema.XXXXXX)
  runtime_backups=$(mktemp -d /run/codex-web-ui/.codex-runtime-backup.XXXXXX)
  if ! python3 "$package_root/scripts/codex-runtime-update-stage.py" --package-root "$package_root" --output "$runtime_stage" 2>"$runtime_schemas/stage-error"; then
    stage_error=$(<"$runtime_schemas/stage-error"); printf '%s\n' "$stage_error" >&2
    if [[ $stage_error == *'full app package is required'* ]]; then message='Latest Codex is not the reviewed compatible target; a full app package is required.'; fi
    return 1
  fi
  bin="$runtime_stage/lib/node_modules/@openai/codex/bin/codex.js"
  [[ -f $bin && ! -L $bin && $(stat -c '%u' "$bin") == 0 ]] || return 1
  chown "$api_user:$api_user" "$runtime_schemas"; chmod 0700 "$runtime_schemas"
  install -d -m 0700 -o "$api_user" -g "$api_user" "$runtime_schemas/home" "$runtime_schemas/codex-home" "$runtime_schemas/out"
  [[ $(runuser -u "$api_user" -- env HOME="$runtime_schemas/home" CODEX_HOME="$runtime_schemas/codex-home" "$bin" --version) == "codex-cli $target_version" ]] || return 1
  runuser -u "$api_user" -- env HOME="$runtime_schemas/home" CODEX_HOME="$runtime_schemas/codex-home" "$bin" app-server generate-json-schema --out "$runtime_schemas/out" >/dev/null
  if ! TARGET="$package_root/infra/codex-update-target.json" GENERATED="$runtime_schemas/out" python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
t=json.loads(Path(os.environ['TARGET']).read_text(encoding='utf-8'))['protocolFiles']; g=Path(os.environ['GENERATED'])
outputs=list(g.iterdir())
if any(not p.is_file() or p.is_symlink() for p in outputs) or set(t) != {p.name for p in outputs}: raise SystemExit(1)
if any(hashlib.sha256((g/n).read_bytes()).hexdigest()!=d for n,d in t.items()): raise SystemExit(1)
PY
  then message='Latest Codex requires a full app package because its protocol differs from the supported snapshot.'; printf '%s\n' "$message" >&2; return 1; fi
  mv -- "$runtime_stage" "$runtime_dir"; runtime_created=true; runtime_stage=; bin="$runtime_dir/lib/node_modules/@openai/codex/bin/codex.js"
  install -m 0600 -o root -g root "$runner_config" "$runtime_backups/runner"; install -m 0600 -o root -g root "$config" "$runtime_backups/api"
  bash "$previous/scripts/graceful-drain.sh" --begin --config "$config" --service-user api --timeout 1800; runtime_drain=true
  systemctl stop codex-web-ui-app-server.socket
  mapfile -t units < <(systemctl list-units --state=active --plain --no-legend 'codex-web-ui-app-server@*.service' | awk '{print $1}')
  if ((${#units[@]})); then systemctl stop "${units[@]}"; fi
  # From this point every error restores both protected files from the root-only backup,
  # including a failure between their two atomic replacements.
  runtime_switched=true
  CONFIG=$config RUNNER=$runner_config BIN=$bin VERSION="codex-cli $target_version" python3 - <<'PY'
import os,re,tempfile
from pathlib import Path
def update(path, changes):
 p=Path(path); out=[]; seen=set()
 for line in p.read_text(encoding='utf-8').splitlines():
  key=line.split('=',1)[0]
  if key in changes:
   if key in seen: raise SystemExit('duplicate protected setting')
   out.append(key+'='+changes[key]); seen.add(key)
  else: out.append(line)
 if seen!=set(changes): raise SystemExit('missing protected setting')
 fd,tmp=tempfile.mkstemp(prefix='.'+p.name+'.',dir=p.parent); os.close(fd); Path(tmp).write_text('\n'.join(out)+'\n',encoding='utf-8'); os.chmod(tmp,0o600); os.chown(tmp,0,0); os.replace(tmp,p)
b=os.environ['BIN']; v='"'+os.environ['VERSION']+'"'
if not re.fullmatch(r'/opt/codex-web-ui/runtime/toolchain-pnpm-[0-9.]+-codex-[0-9.]+-(?:x64|arm64)/lib/node_modules/@openai/codex/bin/codex\.js',b): raise SystemExit('unsafe managed path')
update(os.environ['RUNNER'],{'CODEX_BIN':b,'CODEX_WEB_CODEX_VERSION_PIN':v}); update(os.environ['CONFIG'],{'CODEX_WEB_CODEX_VERSION_PIN':v})
PY
  systemctl restart codex-web-ui-app-server.socket codex-web-ui@api.service
  "$previous/scripts/health-check.sh" --service-user api --timeout 45
  bash "$previous/scripts/graceful-drain.sh" --release --config "$config" --service-user api --timeout 45; runtime_drain=false
  # The healthy runtime and both protected configs are now committed. Later
  # result/cleanup failures must not delete the active executable or require a
  # backup that is about to be removed.
  runtime_switched=false; runtime_created=false
  if ! rm -rf --one-file-system -- "$runtime_schemas" "$runtime_backups"; then
    printf 'Codex update succeeded, but temporary verification data could not be removed.\n' >&2
  fi
  runtime_schemas=; runtime_backups=
}

status=failed; message='Codex update failed; the previous healthy release was restored.'
finish() {
  local code=$?
  trap - EXIT INT TERM
  if ((code != 0)); then
    if [[ ${update_kind:-} == runtime ]]; then
      if ! rollback_runtime; then status=rollback_failed; message='Codex update failed and automatic rollback could not be verified.'; fi
    else
      active=$(readlink -f -- "$current_link" 2>/dev/null || true)
      if [[ $active != "$previous" ]] || ! "$previous/scripts/health-check.sh" --service-user api --timeout 45 >/dev/null 2>&1; then
        status=rollback_failed; message='Codex update failed and automatic rollback could not be verified.'
      fi
    fi
    write_result "$status" "$message"
  fi
  cleanup_self
  exit "$code"
}
trap finish EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
if [[ $update_kind == full-package ]]; then
  apply_full_package
else
  apply_runtime
fi
write_result succeeded 'Codex update completed successfully.'
cleanup_self; trap - EXIT INT TERM
