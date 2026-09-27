#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  exec "$ROOT/scripts/install-package.sh" --help
fi

if [[ -f "$ROOT/release.json" && -f "$ROOT/SHA256SUMS" ]]; then
  if (( EUID == 0 )); then
    exec "$ROOT/scripts/install-package.sh" --package "$ROOT" "$@"
  fi
  exec sudo "$ROOT/scripts/install-package.sh" --package "$ROOT" "$@"
fi

(( EUID != 0 )) || { printf 'Run the source installer as a normal user; it invokes sudo only after building.\n' >&2; exit 1; }
for command in git pnpm node python3 sudo; do command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 1; }; done
case "$(uname -m)" in
  x86_64) target=linux-x64 ;;
  aarch64|arm64) target=linux-arm64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
temporary=$(mktemp -d "${TMPDIR:-/tmp}/codex-web-ui-package.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT
"$ROOT/scripts/prepare-package.sh" --output "$temporary/package" --arch "$target"
sudo "$temporary/package/scripts/install-package.sh" --package "$temporary/package" "$@"
