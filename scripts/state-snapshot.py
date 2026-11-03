#!/usr/bin/env python3
"""Offline, checksummed snapshot of Web state and the runner's CODEX_HOME.

Run only while the API and app-server are stopped. Restore targets must be
existing, empty directories already owned by their intended service users.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path


FORMAT = "codex-web-ui-state-v1"
STORES = ("web-data", "codex-home")
CODEX_TEMP_DIRS = frozenset(("tmp", ".tmp"))
UNITS = (
    "codex-web-ui@api.service",
    "codex-web-ui-app-server.socket",
    "codex-web-ui-app-server@*.service",
)


def require_offline() -> None:
    if sys.platform != "linux":
        raise ValueError("State snapshots require an Ubuntu/Linux host")
    for unit in UNITS:
        result = subprocess.run(
            ["systemctl", "list-units", "--state=active", "--plain", "--no-legend", unit],
            capture_output=True,
            text=True,
            check=True,
        )
        if result.stdout.strip():
            raise ValueError(f"Stop {unit} and finish active work before a state snapshot")


def require_directory(path: Path, *, empty: bool = False) -> Path:
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"Expected a real directory: {path}")
    if empty and next(path.iterdir(), None) is not None:
        raise ValueError(f"Restore destination is not empty: {path}")
    return path.resolve(strict=True)


def inventory(root: Path, *, ignore_codex_temp: bool = False) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    for path in sorted(root.rglob("*")):
        relative_path = path.relative_to(root)
        if ignore_codex_temp and relative_path.parts[0] in CODEX_TEMP_DIRS:
            continue
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError(f"Unsupported link or special file in state: {path}")
        relative = relative_path.as_posix()
        if stat.S_ISDIR(mode):
            result[relative] = {"type": "dir", "mode": stat.S_IMODE(mode)}
        else:
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            result[relative] = {
                "type": "file",
                "mode": stat.S_IMODE(mode),
                "size": path.stat().st_size,
                "sha256": digest,
            }
    return result


def verify(snapshot: Path) -> dict[str, object]:
    root = require_directory(snapshot)
    manifest_path = root / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("Snapshot manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise ValueError("Unknown snapshot format")
    if set(manifest.get("stores", {})) != set(STORES):
        raise ValueError("Snapshot does not contain both state stores")
    for store in STORES:
        if inventory(require_directory(root / store)) != manifest["stores"][store]:
            raise ValueError(f"Snapshot integrity check failed: {store}")
    if set(path.name for path in root.iterdir()) != {*STORES, "manifest.json"}:
        raise ValueError("Snapshot contains unexpected entries")
    return manifest


def snapshot(web_data: Path, codex_home: Path, output: Path) -> None:
    source = (require_directory(web_data), require_directory(codex_home))
    if source[0] == source[1] or source[0] in source[1].parents or source[1] in source[0].parents:
        raise ValueError("State stores must be separate")
    if output.exists() or output.is_symlink():
        raise ValueError("Snapshot destination already exists")
    resolved_output = output.parent.resolve(strict=True) / output.name
    if any(root == resolved_output or root in resolved_output.parents for root in source):
        raise ValueError("Snapshot destination must be outside state stores")
    # Validate sources before creating output. Stop work first so they remain stable.
    inventory(source[0])
    inventory(source[1], ignore_codex_temp=True)
    output.mkdir(mode=0o700)
    try:
        for store, root in zip(STORES, source, strict=True):
            shutil.copytree(
                root,
                output / store,
                symlinks=True,
                ignore=(
                    (lambda directory, names: CODEX_TEMP_DIRS.intersection(names) if Path(directory) == root else set())
                    if store == "codex-home"
                    else None
                ),
            )
        manifest = {
            "format": FORMAT,
            "stores": {store: inventory(output / store) for store in STORES},
        }
        (output / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.chmod(output / "manifest.json", 0o600)
        verify(output)
    except Exception:
        shutil.rmtree(output)
        raise


def restore(snapshot_dir: Path, web_data: Path, codex_home: Path) -> None:
    verify(snapshot_dir)
    snapshot_dir = require_directory(snapshot_dir)
    targets = (require_directory(web_data, empty=True), require_directory(codex_home, empty=True))
    if targets[0] == targets[1] or targets[0] in targets[1].parents or targets[1] in targets[0].parents:
        raise ValueError("Restore targets must be separate")
    if any(target == snapshot_dir or target in snapshot_dir.parents for target in targets):
        raise ValueError("Restore targets must be outside snapshot")
    for store, target in zip(STORES, targets, strict=True):
        source = snapshot_dir / store
        for entry in sorted(source.rglob("*")):
            relative = entry.relative_to(source)
            destination = target / relative
            if entry.is_dir():
                destination.mkdir()
            else:
                shutil.copy2(entry, destination)
                if sys.platform == "linux":
                    os.chown(destination, target.stat().st_uid, target.stat().st_gid)
        for entry in sorted(target.rglob("*"), key=lambda path: len(path.parts), reverse=True):
            if entry.is_dir():
                os.chmod(entry, stat.S_IMODE((source / entry.relative_to(target)).stat().st_mode))
                if sys.platform == "linux":
                    os.chown(entry, target.stat().st_uid, target.stat().st_gid)
        if inventory(target) != inventory(source):
            raise ValueError(f"Restored store failed integrity check: {store}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--web-data", type=Path, required=True)
    create.add_argument("--codex-home", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("--snapshot", type=Path, required=True)
    recover = commands.add_parser("restore")
    recover.add_argument("--snapshot", type=Path, required=True)
    recover.add_argument("--web-data", type=Path, required=True)
    recover.add_argument("--codex-home", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            verify(args.snapshot)
        else:
            require_offline()
            if args.command == "create":
                snapshot(args.web_data, args.codex_home, args.output)
            else:
                restore(args.snapshot, args.web_data, args.codex_home)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"state-snapshot: {error}\n")
    print(f"state-snapshot: {args.command} verified")


if __name__ == "__main__":
    main()
