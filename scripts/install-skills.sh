#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

service_user=ai-chat-agent
codex_home=

while (($#)); do
  case "$1" in
    --service-user) service_user=${2:?}; shift 2 ;;
    --codex-home) codex_home=${2:?}; shift 2 ;;
    --help|-h)
      printf 'Usage: sudo scripts/install-skills.sh --codex-home DIR [--service-user USER]\n'
      exit 0
      ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n $codex_home ]] || { printf '%s\n' '--codex-home is required' >&2; exit 2; }
python3 "$SCRIPT_DIR/skill-bundle.py" \
  --requirements "$REPO_ROOT/skills/manifest.json" \
  verify --bundle "$REPO_ROOT/skills/bundle"
python3 "$SCRIPT_DIR/skill-bundle.py" \
  --requirements "$REPO_ROOT/skills/manifest.json" \
  install --bundle "$REPO_ROOT/skills/bundle" --codex-home "$codex_home" --user "$service_user"
printf 'Installed checksum-verified skills for %s without copying Codex auth/config state.\n' "$service_user"
