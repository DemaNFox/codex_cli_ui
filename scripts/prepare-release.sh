#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

output=
while (($#)); do
  case "$1" in
    --output) output=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: scripts/prepare-release.sh --output /absolute/new/directory\n'
      exit 0
      ;;
    *) printf 'prepare-release: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[[ ${output:-} = /* ]] || { printf 'prepare-release: output must be absolute\n' >&2; exit 1; }
[[ ! -e $output ]] || { printf 'prepare-release: output already exists\n' >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { printf 'prepare-release: pnpm is required\n' >&2; exit 1; }

cd "$REPO_ROOT"
pnpm install --frozen-lockfile
pnpm verify
mkdir -p "$output/apps"
pnpm --filter @codex-web/server deploy --prod --legacy "$output/apps/server"
mkdir -p "$output/apps/web"
cp -a apps/web/dist "$output/apps/web/dist"

[[ -f $output/apps/server/dist/index.js ]]
[[ -f $output/apps/web/dist/index.html ]]
printf 'Prepared verified release: %s\n' "$output"
