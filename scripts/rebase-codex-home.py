#!/usr/bin/env python3
"""Rebase persisted Codex rollout paths after moving CODEX_HOME."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path, PurePosixPath


class RebaseError(RuntimeError):
    pass


ROLLOUT_ROOTS = ("sessions", "archived_sessions")


def profile_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise RebaseError("profile root must be an absolute path")
    return path


def target_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if not path.is_absolute() or "." in path.parts or ".." in path.parts:
        raise RebaseError("target home must be an absolute normalized POSIX path")
    return path


def rollout_relative(path: PurePosixPath, homes: tuple[PurePosixPath, ...]) -> PurePosixPath:
    if not path.is_absolute() or "." in path.parts or ".." in path.parts:
        raise RebaseError("stored rollout path is not an absolute normalized POSIX path")
    matches: list[PurePosixPath] = []
    for home in homes:
        try:
            relative = path.relative_to(home)
        except ValueError:
            continue
        if (
            len(relative.parts) >= 2
            and relative.parts[0] in ROLLOUT_ROOTS
            and relative.suffix == ".jsonl"
        ):
            matches.append(relative)
    if len(matches) != 1:
        raise RebaseError("stored rollout path is outside the configured Codex homes")
    return matches[0]


def rebase(
    profile_root: Path,
    target_home: PurePosixPath,
    source_homes: tuple[PurePosixPath, ...],
) -> int:
    if not profile_root.is_dir() or profile_root.is_symlink():
        raise RebaseError("profile root must be an existing real directory")
    profile_root = profile_root.resolve(strict=True)
    database_path = profile_root / "state_5.sqlite"
    if not database_path.exists():
        return 0
    if not database_path.is_file() or database_path.is_symlink():
        raise RebaseError("Codex state_5.sqlite is missing or unsafe")

    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("BEGIN IMMEDIATE")
        try:
            rows = connection.execute("SELECT id, rollout_path FROM threads").fetchall()
            updates: list[tuple[str, str]] = []
            recognized_homes = (target_home, *source_homes)
            for thread_id, raw_path in rows:
                if not isinstance(raw_path, str):
                    raise RebaseError("stored rollout path is not text")
                relative = rollout_relative(PurePosixPath(raw_path), recognized_homes)
                copied_path = (profile_root / Path(*relative.parts)).resolve(strict=True)
                try:
                    copied_path.relative_to(profile_root)
                except ValueError as error:
                    raise RebaseError("copied rollout escapes the Codex profile") from error
                if not copied_path.is_file() or copied_path.is_symlink():
                    raise RebaseError("copied rollout is missing or unsafe")
                rebased_path = (target_home / relative).as_posix()
                if raw_path != rebased_path:
                    updates.append((rebased_path, thread_id))

            connection.executemany(
                "UPDATE threads SET rollout_path=? WHERE id=?",
                updates,
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        return len(updates)
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-root", required=True)
    parser.add_argument("--target-home", required=True)
    parser.add_argument("--source-home", action="append", default=[])
    arguments = parser.parse_args()
    try:
        profile_root = profile_path(arguments.profile_root)
        target_home = target_path(arguments.target_home)
        source_homes = tuple(target_path(value) for value in arguments.source_home)
        if target_home in source_homes:
            raise RebaseError("source home must differ from target home")
        updated = rebase(profile_root, target_home, source_homes)
    except (OSError, sqlite3.Error, RebaseError) as error:
        parser.error(str(error))
    print(f"Rebased {updated} Codex rollout path(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
