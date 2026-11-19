#!/usr/bin/env python3
"""Check the Codex methods used by Web UI against a reviewed protocol baseline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


# Keep this list aligned with ALLOWED_REQUESTS in apps/server/src/app-server.ts.
REQUIRED_REQUESTS = {
    "initialize",
    "account/login/cancel",
    "account/login/start",
    "account/read",
    "account/rateLimits/read",
    "account/rateLimitResetCredit/consume",
    "account/usage/read",
    "model/list",
    "skills/list",
    "thread/start",
    "thread/resume",
    "thread/read",
    "thread/turns/list",
    "thread/list",
    "thread/name/set",
    "thread/archive",
    "thread/unarchive",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
}
AGGREGATES = (
    "codex_app_server_protocol.schemas.json",
    "codex_app_server_protocol.v2.schemas.json",
)


class IncompatibleProtocol(ValueError):
    pass


def _method_branches(definitions: dict, name: str) -> dict[str, object]:
    branches = definitions.get(name, {}).get("oneOf")
    if not isinstance(branches, list):
        raise IncompatibleProtocol(f"{name} is missing")
    result = {}
    for branch in branches:
        method = branch.get("properties", {}).get("method", {}).get("enum")
        if not isinstance(method, list) or len(method) != 1 or not isinstance(method[0], str):
            raise IncompatibleProtocol(f"{name} has an invalid method branch")
        if method[0] in result:
            raise IncompatibleProtocol(f"{name} contains a duplicate method")
        result[method[0]] = branch
    return result


def _semantic(value: object) -> object:
    if isinstance(value, dict):
        return {key: _semantic(item) for key, item in value.items() if key not in {"description", "title"}}
    if isinstance(value, list):
        return [_semantic(item) for item in value]
    return value


def verify(baseline: Path, generated: Path) -> None:
    for name in AGGREGATES:
        try:
            old = json.loads((baseline / name).read_text(encoding="utf-8"))
            new = json.loads((generated / name).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise IncompatibleProtocol(f"invalid aggregate schema: {name}") from error
        if not isinstance(old, dict) or not isinstance(new, dict):
            raise IncompatibleProtocol(f"invalid aggregate schema: {name}")
        old_defs = old.get("definitions")
        new_defs = new.get("definitions")
        if not isinstance(old_defs, dict) or not isinstance(new_defs, dict):
            raise IncompatibleProtocol(f"definitions are missing: {name}")
        old_requests = _method_branches(old_defs, "ClientRequest")
        new_requests = _method_branches(new_defs, "ClientRequest")
        for method in REQUIRED_REQUESTS:
            if method not in old_requests or method not in new_requests:
                raise IncompatibleProtocol(f"required request is missing: {method}")
            if _semantic(old_requests[method]) != _semantic(new_requests[method]):
                raise IncompatibleProtocol(f"required request changed: {method}")
        old_events = _method_branches(old_defs, "ServerNotification")
        new_events = _method_branches(new_defs, "ServerNotification")
        for method, branch in old_events.items():
            if method not in new_events or _semantic(branch) != _semantic(new_events[method]):
                raise IncompatibleProtocol(f"existing notification changed: {method}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--generated", required=True, type=Path)
    args = parser.parse_args()
    try:
        verify(args.baseline, args.generated)
    except IncompatibleProtocol as error:
        parser.exit(1, f"Codex protocol incompatible: {error}\n")
    print("Codex protocol methods used by Web UI are compatible")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
