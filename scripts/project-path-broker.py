#!/usr/bin/env python3
"""Narrow root broker for canonicalizing allowlisted project paths."""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import Any

try:
    import pwd
except ModuleNotFoundError:  # Unit tests import the Linux broker on Windows.
    pwd = None  # type: ignore[assignment]

SCHEMA_VERSION = 1
API_USER = "codex-web-ui-api"
ROOTS_PATH = Path("/etc/codex-web-ui/project-roots")
MAX_REQUEST_BYTES = 8192
MAX_PATH_BYTES = 4096
MAX_ROOTS_BYTES = 64 * 1024
MAX_ROOTS = 256
REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class BrokerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ProjectPathBroker:
    def __init__(self, *, roots_path: Path = ROOTS_PATH, trusted_uid: int = 0) -> None:
        self.roots_path = roots_path
        self.trusted_uid = trusted_uid

    def _read_roots(self) -> list[Path]:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(self.roots_path, flags)
        except OSError as error:
            raise BrokerError("ROOTS_INVALID", "project roots file is missing or unsafe") from error
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise BrokerError("ROOTS_INVALID", "project roots file is not regular")
            if os.name == "posix" and (
                info.st_uid != self.trusted_uid or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise BrokerError("ROOTS_INVALID", "project roots file ownership or mode is unsafe")
            payload = bytearray()
            while len(payload) <= MAX_ROOTS_BYTES:
                chunk = os.read(descriptor, min(4096, MAX_ROOTS_BYTES + 1 - len(payload)))
                if not chunk:
                    break
                payload.extend(chunk)
            if len(payload) > MAX_ROOTS_BYTES:
                raise BrokerError("ROOTS_INVALID", "project roots file is too large")
        finally:
            os.close(descriptor)
        try:
            lines = bytes(payload).decode("utf-8").splitlines()
        except UnicodeDecodeError as error:
            raise BrokerError("ROOTS_INVALID", "project roots file is not UTF-8") from error
        if not lines or len(lines) > MAX_ROOTS or any(not line for line in lines):
            raise BrokerError("ROOTS_INVALID", "project roots file entries are invalid")
        roots: list[Path] = []
        for line in lines:
            if "\x00" in line or len(line.encode("utf-8")) > MAX_PATH_BYTES:
                raise BrokerError("ROOTS_INVALID", "project root entry is invalid")
            root = Path(line)
            if not root.is_absolute():
                raise BrokerError("ROOTS_INVALID", "project root entry is not absolute")
            try:
                canonical = root.resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise BrokerError("ROOTS_INVALID", "project root cannot be resolved") from error
            if not canonical.is_dir():
                raise BrokerError("ROOTS_INVALID", "project root is not a directory")
            if canonical not in roots:
                roots.append(canonical)
        return roots

    @staticmethod
    def _validate_request(request: dict[str, Any]) -> tuple[Path, str]:
        expected = {"version", "requestId", "action", "path", "kind"}
        if set(request) != expected or type(request.get("version")) is not int:
            raise BrokerError("REQUEST_INVALID", "request fields are invalid")
        request_id = request.get("requestId")
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise BrokerError("REQUEST_INVALID", "requestId is invalid")
        if request["version"] != SCHEMA_VERSION or request.get("action") != "canonicalize":
            raise BrokerError("REQUEST_INVALID", "request operation is unsupported")
        kind = request.get("kind")
        if kind not in {"existing", "directory"}:
            raise BrokerError("REQUEST_INVALID", "path kind is invalid")
        raw_path = request.get("path")
        try:
            encoded_path = raw_path.encode("utf-8") if isinstance(raw_path, str) else b""
        except UnicodeEncodeError as error:
            raise BrokerError("REQUEST_INVALID", "path is invalid") from error
        if (
            not isinstance(raw_path, str)
            or not raw_path
            or "\x00" in raw_path
            or len(encoded_path) > MAX_PATH_BYTES
        ):
            raise BrokerError("REQUEST_INVALID", "path is invalid")
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            raise BrokerError("REQUEST_INVALID", "path must be absolute")
        return candidate, kind

    @staticmethod
    def _resolve_candidate(candidate: Path, kind: str) -> Path:
        if not hasattr(os, "O_PATH"):
            try:
                canonical = candidate.resolve(strict=True)
            except FileNotFoundError as error:
                raise BrokerError("PATH_NOT_FOUND", "project path does not exist") from error
            except NotADirectoryError as error:
                raise BrokerError("PATH_NOT_DIRECTORY", "project path component is not a directory") from error
            info = canonical.stat()
        else:
            flags = os.O_PATH | getattr(os, "O_CLOEXEC", 0)
            if kind == "directory":
                flags |= getattr(os, "O_DIRECTORY", 0)
            try:
                descriptor = os.open(candidate, flags)
            except FileNotFoundError as error:
                raise BrokerError("PATH_NOT_FOUND", "project path does not exist") from error
            except NotADirectoryError as error:
                raise BrokerError("PATH_NOT_DIRECTORY", "project path component is not a directory") from error
            except OSError as error:
                code = "PATH_NOT_DIRECTORY" if error.errno == errno.ENOTDIR else "PATH_UNAVAILABLE"
                raise BrokerError(code, "project path cannot be opened") from error
            try:
                info = os.fstat(descriptor)
                raw = os.readlink(f"/proc/self/fd/{descriptor}")
                if raw.endswith(" (deleted)"):
                    raise BrokerError("PATH_UNAVAILABLE", "project path changed during validation")
                canonical = Path(raw)
                final = os.stat(canonical)
                if (info.st_dev, info.st_ino) != (final.st_dev, final.st_ino):
                    raise BrokerError("PATH_UNAVAILABLE", "project path changed during validation")
            finally:
                os.close(descriptor)
        if kind == "directory" and not stat.S_ISDIR(info.st_mode):
            raise BrokerError("PATH_NOT_DIRECTORY", "project path is not a directory")
        if kind == "existing" and not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise BrokerError("PATH_UNAVAILABLE", "project path type is unsupported")
        return canonical

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        candidate, kind = self._validate_request(request)
        roots = self._read_roots()
        try:
            canonical = self._resolve_candidate(candidate, kind)
        except BrokerError:
            raise
        except (OSError, RuntimeError) as error:
            raise BrokerError("PATH_UNAVAILABLE", "project path cannot be resolved") from error
        if not any(canonical == root or root in canonical.parents for root in roots):
            raise BrokerError("PATH_OUTSIDE_ROOTS", "project path is outside configured roots")
        return {"ok": True, "canonicalPath": str(canonical)}


def _read_socket_request(sock: socket.socket) -> dict[str, Any]:
    payload = bytearray()
    while len(payload) <= MAX_REQUEST_BYTES:
        chunk = sock.recv(min(1024, MAX_REQUEST_BYTES + 1 - len(payload)))
        if not chunk:
            break
        payload.extend(chunk)
        if b"\n" in chunk:
            break
    if len(payload) > MAX_REQUEST_BYTES or b"\n" not in payload:
        raise BrokerError("REQUEST_INVALID", "request framing is invalid")
    line, remainder = bytes(payload).split(b"\n", 1)
    if remainder.strip():
        raise BrokerError("REQUEST_INVALID", "only one request is allowed")

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise BrokerError("REQUEST_INVALID", "request keys must be unique")
            value[key] = item
        return value

    try:
        value = json.loads(line, object_pairs_hook=unique_object)
    except BrokerError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BrokerError("REQUEST_INVALID", "request JSON is invalid") from error
    if not isinstance(value, dict):
        raise BrokerError("REQUEST_INVALID", "request must be an object")
    return value


def _serve(fd: int, broker: ProjectPathBroker, api_user: str = API_USER) -> int:
    if not hasattr(os, "geteuid") or os.geteuid() != 0 or pwd is None:
        raise BrokerError("BROKER_NOT_ROOT", "project path broker must run as root")
    try:
        expected_uid = pwd.getpwnam(api_user).pw_uid
    except KeyError as error:
        raise BrokerError("PEER_IDENTITY_INVALID", "project path API identity does not exist") from error
    sock = socket.socket(fileno=fd)
    credentials = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", credentials)
    if uid != expected_uid:
        raise BrokerError("PEER_DENIED", "project path broker peer is not the API identity")
    try:
        response = broker.handle(_read_socket_request(sock))
    except BrokerError as error:
        response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
    try:
        sock.sendall((json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n").encode())
    except BrokenPipeError:
        return 0
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve-fd", type=int, required=True)
    arguments = parser.parse_args()
    try:
        return _serve(arguments.serve_fd, ProjectPathBroker())
    except BrokerError as error:
        sys.stderr.write(f"project path broker: {error.code}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
