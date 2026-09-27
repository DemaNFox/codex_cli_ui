#!/usr/bin/env python3
"""Fail-closed soft storage admission checks for Codex Web UI."""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import shlex
import shutil
import stat
import sys
from collections.abc import Mapping

RELEASE_ROOT = pathlib.Path("/opt/codex-web-ui/releases")


class GuardError(ValueError):
    """A safe, operator-facing storage guard failure."""


def parse_config(path: pathlib.Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise GuardError("configuration is not readable UTF-8") from error

    values: dict[str, str] = {}
    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        key = key.strip()
        raw = raw.strip()
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            raise GuardError(f"invalid or duplicate configuration assignment on line {number}")
        if raw.startswith(("'", '"')):
            try:
                parsed = shlex.split(raw, posix=True)
            except ValueError as error:
                raise GuardError(f"invalid quoted value on line {number}") from error
            if len(parsed) != 1:
                raise GuardError(f"configuration value must be one literal on line {number}")
            raw = parsed[0]
        values[key] = raw
    return values


def positive_integer(values: Mapping[str, str], name: str) -> int:
    raw = values.get(name, "")
    if not re.fullmatch(r"[1-9][0-9]*", raw):
        raise GuardError(f"{name} must be a positive integer")
    return int(raw)


def nearest_existing_parent(path: pathlib.Path) -> pathlib.Path:
    candidate = path
    while not candidate.exists():
        parent = candidate.parent
        if parent == candidate:
            raise GuardError("database path has no existing parent")
        candidate = parent
    if candidate.is_symlink() or not candidate.is_dir():
        raise GuardError("database parent must resolve through a real directory")
    return candidate


def check_storage(
    values: Mapping[str, str],
    *,
    release_root: pathlib.Path = RELEASE_ROOT,
    additional_releases: int = 0,
    check_releases: bool = False,
) -> None:
    database_raw = values.get("CODEX_WEB_DATABASE_PATH", "")
    database = pathlib.Path(database_raw)
    if not database_raw or not database.is_absolute():
        raise GuardError("CODEX_WEB_DATABASE_PATH must be absolute")

    minimum_free = positive_integer(values, "CODEX_WEB_MIN_FREE_BYTES")
    maximum_database = positive_integer(values, "CODEX_WEB_MAX_DATABASE_BYTES")
    maximum_releases = positive_integer(values, "CODEX_WEB_MAX_RELEASES")
    if minimum_free < 1024**3:
        raise GuardError("CODEX_WEB_MIN_FREE_BYTES must be at least 1 GiB")
    if maximum_releases < 2 or maximum_releases > 50:
        raise GuardError("CODEX_WEB_MAX_RELEASES must be between 2 and 50")

    database_parent = nearest_existing_parent(database.parent)
    if shutil.disk_usage(database_parent).free < minimum_free:
        raise GuardError("available storage is below CODEX_WEB_MIN_FREE_BYTES")

    if database.exists() or database.is_symlink():
        info = database.lstat()
        if database.is_symlink() or not stat.S_ISREG(info.st_mode):
            raise GuardError("database path must be a regular non-symlink file")
        if info.st_size > maximum_database:
            raise GuardError("database exceeds CODEX_WEB_MAX_DATABASE_BYTES")

    if additional_releases < 0:
        raise GuardError("additional release count cannot be negative")
    if check_releases:
        if not release_root.is_dir() or release_root.is_symlink():
            raise GuardError("release root must be a real directory")
        release_count = sum(
            1
            for entry in release_root.iterdir()
            if entry.is_dir() and not entry.is_symlink()
        )
        if release_count + additional_releases > maximum_releases:
            raise GuardError(
                "release retention limit reached; remove an inactive release through an explicit operator procedure"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=pathlib.Path,
        default=pathlib.Path("/etc/codex-web-ui/codex-web-ui.env"),
    )
    parser.add_argument("--additional-releases", type=int, default=0)
    parser.add_argument("--check-releases", action="store_true")
    args = parser.parse_args()
    try:
        values = parse_config(args.config)
        check_storage(
            values,
            additional_releases=args.additional_releases,
            check_releases=args.check_releases,
        )
    except GuardError as error:
        print(f"storage guard failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
