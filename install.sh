#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  exec "$ROOT/scripts/install-package.sh" --help
fi

preflight_origin=
preflight_external=false
preflight_cert=
preflight_key=
preflight_args=("$@")
set -- "${preflight_args[@]}"
while (($#)); do
  case "$1" in
    --runner-user|--codex-home|--codex-bin|--project-root)
      [[ $# -ge 2 && -n $2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
      shift 2
      ;;
    --public-origin)
      [[ $# -ge 2 && -n $2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
      preflight_origin=$2
      shift 2
      ;;
    --tls-cert)
      [[ $# -ge 2 && -n $2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
      preflight_cert=$2
      shift 2
      ;;
    --tls-key)
      [[ $# -ge 2 && -n $2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
      preflight_key=$2
      shift 2
      ;;
    --external-proxy) preflight_external=true; shift ;;
    --upgrade|--no-start) shift ;;
    --help|-h) exec "$ROOT/scripts/install-package.sh" --help ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
set -- "${preflight_args[@]}"
[[ -n $preflight_origin ]] || { printf '%s\n' '--public-origin is required' >&2; exit 1; }
if $preflight_external; then
  [[ -z $preflight_cert && -z $preflight_key ]] || { printf '%s\n' 'Choose either --external-proxy or --tls-cert/--tls-key' >&2; exit 1; }
else
  [[ -n $preflight_cert && -n $preflight_key ]] || { printf '%s\n' 'Provide --external-proxy or both --tls-cert and --tls-key' >&2; exit 1; }
fi

if [[ -f "$ROOT/release.json" && -f "$ROOT/SHA256SUMS" ]]; then
  if (( EUID == 0 )); then
    exec "$ROOT/scripts/install-package.sh" --package "$ROOT" "$@"
  fi
  exec sudo "$ROOT/scripts/install-package.sh" --package "$ROOT" "$@"
fi

(( EUID != 0 )) || { printf 'Run the source installer as a normal user; it invokes sudo only after building.\n' >&2; exit 1; }
for command in git sudo; do command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 1; }; done
bootstrap_args=()
$preflight_external || bootstrap_args+=(--install-nginx)
sudo "$ROOT/scripts/bootstrap-ubuntu.sh" "${bootstrap_args[@]}"
export PATH="/usr/local/bin:$PATH"
for command in pnpm node python3; do command -v "$command" >/dev/null || { printf 'Bootstrap did not provide command: %s\n' "$command" >&2; exit 1; }; done
pnpm install --frozen-lockfile
case "$(uname -m)" in
  x86_64) target=linux-x64 ;;
  aarch64|arm64) target=linux-arm64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
temporary=$(mktemp -d "${TMPDIR:-/tmp}/codex-web-ui-package.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT
"$ROOT/scripts/prepare-package.sh" --output "$temporary/package" --arch "$target"
sudo "$temporary/package/scripts/install-package.sh" --package "$temporary/package" "$@"
