#!/usr/bin/env python3
"""Install the Codex Web UI same-host guidance into CODEX_HOME/AGENTS.md.

This helper is intentionally Linux-only.  It is run by the privileged package
installer after the operator has selected the Codex runner identity.
"""

from __future__ import annotations

import argparse
import os
import secrets
import stat
import sys
from pathlib import Path

try:
    import fcntl
    import pwd
except ImportError:  # pragma: no cover - guarded by the Linux platform check
    fcntl = None
    pwd = None


BEGIN_MARKER = "<!-- BEGIN CODEX WEB UI: SAME-HOST RUNNER -->"
END_MARKER = "<!-- END CODEX WEB UI: SAME-HOST RUNNER -->"
MAX_AGENTS_BYTES = 1024 * 1024
MANAGED_BLOCK = f"""{BEGIN_MARKER}
## Codex Web UI same-host execution

This Codex runner executes directly on the physical host that serves Codex Web UI.
Use the local filesystem and the local service manager for work on this machine.
Never use SSH to localhost, a loopback address, the current hostname, or any local
address to manage this same machine. Use SSH only when the user explicitly identifies
a different remote host.
{END_MARKER}"""


class InstallError(RuntimeError):
    """A safe managed update could not be completed."""


def update_managed_block(original: str) -> str:
    """Return *original* with exactly one canonical managed block."""
    begin_count = original.count(BEGIN_MARKER)
    end_count = original.count(END_MARKER)
    if begin_count != end_count or begin_count > 1:
        raise InstallError("AGENTS.md contains malformed or duplicate same-host markers")

    if begin_count == 1:
        start = original.index(BEGIN_MARKER)
        end = original.index(END_MARKER, start) + len(END_MARKER)
        return original[:start] + MANAGED_BLOCK + original[end:]

    if not original:
        return MANAGED_BLOCK + "\n"
    separator = "" if original.endswith("\n\n") else "\n" if original.endswith("\n") else "\n\n"
    return original + separator + MANAGED_BLOCK + "\n"


def _open_directory(path: Path) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open("/", flags)
    try:
        for component in path.parts[1:]:
            if component in {"", ".", ".."}:
                raise InstallError("--codex-home must be an absolute normalized path")
            next_descriptor = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
    except (OSError, InstallError) as error:
        os.close(descriptor)
        if isinstance(error, InstallError):
            raise
        raise InstallError(f"CODEX_HOME must be an existing real directory: {error}") from error
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode):
        os.close(descriptor)
        raise InstallError("CODEX_HOME is not a directory")
    return descriptor


def _read_existing(
    directory_fd: int, expected_uid: int
) -> tuple[str, tuple[int, int] | None, tuple[int, int]]:
    try:
        before = os.stat("AGENTS.md", dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return "", None, (expected_uid, -1)
    if not stat.S_ISREG(before.st_mode):
        raise InstallError("AGENTS.md must be a regular file and must not be a symlink")
    if before.st_uid != expected_uid:
        raise InstallError("AGENTS.md is not owned by the selected Codex service user")
    if before.st_size > MAX_AGENTS_BYTES:
        raise InstallError("AGENTS.md exceeds the safe managed size limit")

    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open("AGENTS.md", flags, dir_fd=directory_fd)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise InstallError("AGENTS.md changed while it was being opened")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_AGENTS_BYTES:
                raise InstallError("AGENTS.md exceeds the safe managed size limit")
            chunks.append(chunk)
    finally:
        os.close(descriptor)
    try:
        return (
            b"".join(chunks).decode("utf-8"),
            (before.st_dev, before.st_ino),
            (before.st_uid, before.st_gid),
        )
    except UnicodeDecodeError as error:
        raise InstallError("AGENTS.md must contain valid UTF-8 text") from error


def install(codex_home: Path, service_user: str) -> None:
    if os.name != "posix" or fcntl is None or pwd is None:
        raise InstallError("same-host instructions can only be installed on Linux")
    if not codex_home.is_absolute():
        raise InstallError("--codex-home must be an absolute path")
    try:
        account = pwd.getpwnam(service_user)
    except KeyError as error:
        raise InstallError(f"service user does not exist: {service_user}") from error

    directory_fd = _open_directory(codex_home)
    lock_fd: int | None = None
    temporary_name: str | None = None
    try:
        home_info = os.fstat(directory_fd)
        if home_info.st_uid != account.pw_uid:
            raise InstallError("CODEX_HOME is not owned by the selected Codex service user")
        lock_flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        lock_fd = os.open(".codex-web-ui-instructions.lock", lock_flags, 0o600, dir_fd=directory_fd)
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise InstallError("instruction lock is not a regular file")
        fcntl.flock(lock_fd, fcntl.LOCK_EX)

        original, original_identity, original_owner = _read_existing(directory_fd, account.pw_uid)
        target_uid, target_gid = (
            original_owner if original_identity is not None else (account.pw_uid, account.pw_gid)
        )
        updated = update_managed_block(original).encode("utf-8")
        if len(updated) > MAX_AGENTS_BYTES:
            raise InstallError("managed AGENTS.md would exceed the safe size limit")

        temporary_name = f".AGENTS.md.tmp.{os.getpid()}.{secrets.token_hex(8)}"
        write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        output_fd = os.open(temporary_name, write_flags, 0o600, dir_fd=directory_fd)
        try:
            offset = 0
            while offset < len(updated):
                offset += os.write(output_fd, updated[offset:])
            os.fchmod(output_fd, 0o600)
            os.fchown(output_fd, target_uid, target_gid)
            os.fsync(output_fd)
        finally:
            os.close(output_fd)

        try:
            current = os.stat("AGENTS.md", dir_fd=directory_fd, follow_symlinks=False)
            current_identity = (current.st_dev, current.st_ino)
        except FileNotFoundError:
            current_identity = None
        if current_identity != original_identity:
            raise InstallError("AGENTS.md changed during the managed update")

        os.replace(temporary_name, "AGENTS.md", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        temporary_name = None
        os.fsync(directory_fd)
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(directory_fd)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, required=True)
    parser.add_argument("--service-user", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    options = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        install(options.codex_home, options.service_user)
    except (InstallError, OSError) as error:
        print(f"install-local-host-instructions: {error}", file=sys.stderr)
        return 1
    print(f"Installed managed same-host instructions in {options.codex_home / 'AGENTS.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
