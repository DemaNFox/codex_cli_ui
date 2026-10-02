#!/usr/bin/env python3
"""Narrow root broker for applying a pre-staged Codex Web UI release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import socket
import struct
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
    import pwd
except ModuleNotFoundError:  # Tests import this Linux helper on Windows.
    fcntl = None  # type: ignore[assignment]
    pwd = None  # type: ignore[assignment]

SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 4096
API_USER = "codex-web-ui-api"
OPT_ROOT = Path("/opt/codex-web-ui")
CANDIDATE_LINK = OPT_ROOT / "codex-update-candidate"
RELEASES_ROOT = OPT_ROOT / "releases"
CURRENT_LINK = OPT_ROOT / "current"
RESULT_PATH = Path("/var/lib/codex-web-ui/codex-update-result.json")
RUNNER_CONFIG = Path("/etc/codex-web-ui/codex-runner.env")
API_CONFIG = Path("/etc/codex-web-ui/codex-web-ui.env")
SYSTEMCTL = "/usr/bin/systemctl"
UPDATE_SERVICE = "codex-web-ui-codex-update.service"
CANDIDATE_LOCK_PATH = Path("/run/codex-web-ui/codex-update-candidate.lock")
SAFE_RELEASE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")

CommandRunner = Callable[[list[str]], subprocess.CompletedProcess[str]]


def _version_tuple(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"codex-cli (\d+)\.(\d+)\.(\d+)", value)
    if match is None:
        raise BrokerError("INSTALLATION_INVALID", "installed Codex version is invalid")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


class BrokerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def run_command(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
    )


@dataclass(frozen=True)
class Candidate:
    path: Path
    release_id: str
    version: str


@dataclass(frozen=True)
class RuntimeCandidate:
    package_root: Path
    release_id: str
    version: str


def _owned_non_writable(path: Path, *, symlink: bool = False) -> os.stat_result:
    try:
        info = path.lstat() if symlink else path.stat()
    except OSError as error:
        raise BrokerError("UPDATE_UNAVAILABLE", "prepared update is unavailable") from error
    if os.name == "posix" and (info.st_uid != 0 or (not symlink and info.st_mode & 0o022)):
        raise BrokerError("CANDIDATE_UNSAFE", "prepared update ownership or mode is unsafe")
    return info


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BrokerError("CANDIDATE_INVALID", "prepared update manifest is invalid") from error
    if not isinstance(value, dict):
        raise BrokerError("CANDIDATE_INVALID", "prepared update manifest is invalid")
    return value


def _trusted_regular_file(path: Path, code: str, message: str) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise BrokerError(code, message) from error
    if not path.is_file() or path.is_symlink():
        raise BrokerError(code, message)
    if os.name == "posix" and (info.st_uid != 0 or info.st_mode & 0o022):
        raise BrokerError(code, message)


class CodexUpdateBroker:
    def __init__(
        self,
        *,
        opt_root: Path = OPT_ROOT,
        result_path: Path = RESULT_PATH,
        command_runner: CommandRunner = run_command,
        machine: str | None = None,
        runner_config: Path = RUNNER_CONFIG,
        api_config: Path = API_CONFIG,
    ) -> None:
        self.opt_root = opt_root
        self.releases_root = opt_root / "releases"
        self.current_link = opt_root / "current"
        self.candidate_link = opt_root / "codex-update-candidate"
        self.result_path = result_path
        self.command_runner = command_runner
        self.machine = machine or platform.machine()
        self.runner_config = runner_config
        self.api_config = api_config

    @property
    def expected_arch(self) -> str:
        architectures = {"x86_64": "linux-x64", "aarch64": "linux-arm64"}
        try:
            return architectures[self.machine]
        except KeyError as error:
            raise BrokerError("ARCH_UNSUPPORTED", "host architecture is unsupported") from error

    def _resolve_managed_link(self, link: Path, *, candidate: bool) -> tuple[Path, str]:
        _owned_non_writable(link, symlink=True)
        if not link.is_symlink():
            code = "UPDATE_UNAVAILABLE" if candidate else "INSTALLATION_INVALID"
            raise BrokerError(code, "managed release link is missing or unsafe")
        try:
            target = link.resolve(strict=True)
            relative = target.relative_to(self.releases_root.resolve(strict=True))
        except (OSError, ValueError, RuntimeError) as error:
            code = "UPDATE_UNAVAILABLE" if candidate else "INSTALLATION_INVALID"
            raise BrokerError(code, "managed release link escapes the release directory") from error
        if len(relative.parts) != 1 or not SAFE_RELEASE_ID.fullmatch(relative.name):
            raise BrokerError("CANDIDATE_UNSAFE", "prepared release identifier is unsafe")
        info = _owned_non_writable(target)
        if not target.is_dir() or target.is_symlink() or not info:
            raise BrokerError("CANDIDATE_UNSAFE", "prepared update is not a safe directory")
        return target, relative.name

    def current(self) -> tuple[Path, str, dict[str, Any]]:
        path, release_id = self._resolve_managed_link(self.current_link, candidate=False)
        _trusted_regular_file(
            path / "release.json",
            "INSTALLATION_INVALID",
            "installed release manifest is missing or unsafe",
        )
        return path, release_id, _load_manifest(path / "release.json")

    def validate_candidate(self) -> Candidate:
        current_path, _current_id, current_manifest = self.current()
        candidate_path, release_id = self._resolve_managed_link(self.candidate_link, candidate=True)
        # The inventory hashes are meaningful only if no unprivileged identity can
        # replace either the manifest or a checked payload after verification.
        for entry in candidate_path.rglob("*"):
            _owned_non_writable(entry, symlink=entry.is_symlink())
        verifier = current_path / "scripts/prepare-package.sh"
        _trusted_regular_file(
            verifier, "VERIFIER_UNSAFE", "installed package verifier is unavailable"
        )
        if not os.access(verifier, os.X_OK):
            raise BrokerError("VERIFIER_UNSAFE", "installed package verifier is unavailable")
        result = self.command_runner(
            [str(verifier), "--verify", str(candidate_path), "--arch", self.expected_arch]
        )
        if result.returncode != 0:
            raise BrokerError("CANDIDATE_INVALID", "prepared update failed package verification")
        manifest = _load_manifest(candidate_path / "release.json")
        if manifest.get("apiCompatibility") != current_manifest.get("apiCompatibility"):
            raise BrokerError("API_INCOMPATIBLE", "prepared update is not API-compatible")
        current_target = current_manifest.get("target")
        if manifest.get("target") != current_target:
            raise BrokerError("ARCH_MISMATCH", "prepared update architecture does not match")
        version = manifest.get("runtime", {}).get("codex", {}).get("versionPin")
        if not isinstance(version, str) or not re.fullmatch(r"codex-cli \d+\.\d+\.\d+", version):
            raise BrokerError("CANDIDATE_INVALID", "prepared update Codex version is invalid")
        for relative in (
            "scripts/install-package.sh",
            "scripts/codex-update-broker.py",
            "scripts/codex-update-worker.sh",
            "infra/systemd/codex-web-ui-codex-update-broker.socket",
            "infra/systemd/codex-web-ui-codex-update-broker@.service",
            "infra/systemd/codex-web-ui-codex-update.service",
        ):
            if not (candidate_path / relative).is_file():
                raise BrokerError("CANDIDATE_INVALID", "prepared update lacks the update boundary")
        return Candidate(candidate_path, release_id, version)

    def _current_version(self) -> str:
        _path, _release_id, manifest = self.current()
        configured: list[str] = []
        for path in (self.runner_config, self.api_config):
            if not path.exists():
                continue
            _trusted_regular_file(path, "INSTALLATION_INVALID", "installed configuration is unsafe")
            values = [
                match.group(1)
                for line in path.read_text(encoding="utf-8").splitlines()
                if (match := re.fullmatch(r'CODEX_WEB_CODEX_VERSION_PIN="(codex-cli \d+\.\d+\.\d+)"', line))
            ]
            if len(values) != 1:
                raise BrokerError("INSTALLATION_INVALID", "installed Codex version is invalid")
            configured.append(values[0])
        if configured and len(set(configured)) != 1:
            raise BrokerError("INSTALLATION_INVALID", "installed Codex version pins disagree")
        value = configured[0] if configured else manifest.get("runtime", {}).get("codex", {}).get("versionPin")
        if not isinstance(value, str):
            raise BrokerError("INSTALLATION_INVALID", "installed Codex version is invalid")
        return value

    def runtime_candidate(self) -> RuntimeCandidate:
        package_root, _release_id, _manifest = self.current()
        target_path = package_root / "infra/codex-update-target.json"
        try:
            _trusted_regular_file(
                target_path,
                "UPDATE_UNAVAILABLE",
                "reviewed runtime update pins are unavailable",
            )
            try:
                target = json.loads(target_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed runtime update target is invalid") from error
            if not isinstance(target, dict):
                raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed runtime update target is invalid")
            if set(target) != {"schemaVersion", "package", "version", "tarballs", "protocolFiles"}:
                raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed runtime update target fields are invalid")
            version = target.get("version")
            tarballs = target.get("tarballs")
            checksums = tuple(
                value.get("sha512") if isinstance(value, dict) and set(value) == {"sha512"} else None
                for value in tarballs.values()
            ) if isinstance(tarballs, dict) and set(tarballs) == {"main", "linux-x64", "linux-arm64"} else (None,)
            if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
                raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed runtime version is invalid")
            if target.get("schemaVersion") != 1 or target.get("package") != "@openai/codex" or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{128}", value) for value in checksums):
                raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed runtime integrity pins are invalid")
            files = target.get("protocolFiles")
            if not isinstance(files, dict) or set(files) != {
                "codex_app_server_protocol.schemas.json",
                "codex_app_server_protocol.v2.schemas.json",
            } or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in files.values()):
                raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed protocol snapshot is invalid")
            for name, expected in files.items():
                snapshot = package_root / "protocol" / version / name
                _trusted_regular_file(snapshot, "RUNTIME_UPDATE_INVALID", "reviewed protocol snapshot is unavailable")
                if hashlib.sha256(snapshot.read_bytes()).hexdigest() != expected:
                    raise BrokerError("RUNTIME_UPDATE_INVALID", "reviewed protocol snapshot checksum mismatch")
        except OSError as error:
            raise BrokerError("UPDATE_UNAVAILABLE", "reviewed runtime update is unavailable") from error
        return RuntimeCandidate(package_root, f"runtime-{version}", f"codex-cli {version}")

    def available_candidate(self) -> Candidate | RuntimeCandidate:
        try:
            return self.validate_candidate()
        except BrokerError as error:
            if error.code != "UPDATE_UNAVAILABLE":
                raise
        return self.runtime_candidate()

    def _worker_active(self) -> bool:
        result = self.command_runner(
            [SYSTEMCTL, "show", "--property=ActiveState", "--value", UPDATE_SERVICE]
        )
        state = result.stdout.strip()
        if result.returncode == 0 and state in {"active", "activating", "reloading", "deactivating"}:
            return True
        if result.returncode == 0 and state in {"inactive", "failed"}:
            job = self.command_runner(
                [SYSTEMCTL, "list-jobs", "--no-legend", "--plain", UPDATE_SERVICE]
            )
            if job.returncode == 0:
                return bool(job.stdout.strip())
        raise BrokerError("SYSTEMD_OPERATION_FAILED", "cannot read update worker state")

    def _last_result(self) -> tuple[dict[str, str] | None, str | None]:
        try:
            info = self.result_path.lstat()
            if not self.result_path.is_file() or self.result_path.is_symlink():
                raise BrokerError("RESULT_INVALID", "stored update result is unsafe")
            if os.name == "posix" and (info.st_uid != 0 or info.st_mode & 0o077):
                raise BrokerError("RESULT_INVALID", "stored update result is unsafe")
            raw = json.loads(self.result_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None, None
        except (OSError, json.JSONDecodeError) as error:
            raise BrokerError("RESULT_INVALID", "stored update result is invalid") from error
        expected = {"schemaVersion", "candidateReleaseId", "status", "message", "completedAt"}
        if not isinstance(raw, dict) or set(raw) != expected or raw.get("schemaVersion") != 1:
            raise BrokerError("RESULT_INVALID", "stored update result is invalid")
        status = raw.get("status")
        message = raw.get("message")
        completed_at = raw.get("completedAt")
        release_id = raw.get("candidateReleaseId")
        if status not in {"succeeded", "failed", "rollback_failed"}:
            raise BrokerError("RESULT_INVALID", "stored update result is invalid")
        if not isinstance(message, str) or not (1 <= len(message) <= 240):
            raise BrokerError("RESULT_INVALID", "stored update result is invalid")
        if not isinstance(release_id, str) or not SAFE_RELEASE_ID.fullmatch(release_id):
            raise BrokerError("RESULT_INVALID", "stored update result is invalid")
        if not isinstance(completed_at, str):
            raise BrokerError("RESULT_INVALID", "stored update result is invalid")
        try:
            datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise BrokerError("RESULT_INVALID", "stored update result is invalid") from error
        return {"status": status, "message": message, "completedAt": completed_at}, release_id

    def snapshot(self) -> dict[str, Any]:
        current_version = self._current_version()
        last_result, result_release_id = self._last_result()
        if self._worker_active():
            try:
                candidate = self.available_candidate()
                available_version, candidate_id = candidate.version, candidate.release_id
            except BrokerError:
                available_version, candidate_id = None, None
            state = "applying"
        else:
            try:
                candidate = self.available_candidate()
            except BrokerError as error:
                if error.code == "UPDATE_UNAVAILABLE":
                    candidate = None
                else:
                    raise
            if candidate is None:
                state, available_version, candidate_id = "unavailable", None, None
            else:
                available_version, candidate_id = candidate.version, candidate.release_id
                if result_release_id == candidate.release_id and last_result is not None and last_result["status"] != "succeeded":
                    state = "rollback_failed" if last_result["status"] == "rollback_failed" else "failed"
                elif _version_tuple(candidate.version) <= _version_tuple(current_version):
                    state = "current"
                else:
                    state = "ready"
        return {
            "ok": True,
            "snapshot": {
                "state": state,
                "currentVersion": current_version,
                "availableVersion": available_version,
                "candidateReleaseId": candidate_id,
                "lastResult": last_result,
            },
        }

    @staticmethod
    def _validate_request(request: dict[str, Any]) -> tuple[str, str]:
        if (
            set(request) != {"version", "requestId", "action"}
            or type(request.get("version")) is not int
            or request.get("version") != 1
        ):
            raise BrokerError("REQUEST_INVALID", "request fields are invalid")
        request_id = request.get("requestId")
        try:
            parsed = uuid.UUID(request_id) if isinstance(request_id, str) else None
        except ValueError as error:
            raise BrokerError("REQUEST_INVALID", "requestId is invalid") from error
        if parsed is None or str(parsed) != request_id.lower():
            raise BrokerError("REQUEST_INVALID", "requestId is invalid")
        action = request.get("action")
        if action not in {"status", "apply"}:
            raise BrokerError("REQUEST_INVALID", "action is invalid")
        return request_id, action

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        _request_id, action = self._validate_request(request)
        if action == "status":
            return self.snapshot()
        snapshot = self.snapshot()["snapshot"]
        if snapshot["state"] not in {"ready", "failed"}:
            raise BrokerError("UPDATE_NOT_READY", "prepared update is not ready")
        result = self.command_runner([SYSTEMCTL, "start", "--no-block", UPDATE_SERVICE])
        if result.returncode != 0:
            raise BrokerError("SYSTEMD_OPERATION_FAILED", "update worker could not be started")
        snapshot["state"] = "applying"
        return {"ok": True, "snapshot": snapshot}


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
    try:
        value = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BrokerError("REQUEST_INVALID", "request JSON is invalid") from error
    if not isinstance(value, dict):
        raise BrokerError("REQUEST_INVALID", "request must be an object")
    return value


def _serve(fd: int, broker: CodexUpdateBroker, api_user: str = API_USER) -> int:
    if not hasattr(os, "geteuid") or os.geteuid() != 0 or pwd is None or fcntl is None:
        raise BrokerError("BROKER_NOT_ROOT", "Codex update broker must run as root")
    try:
        expected_uid = pwd.getpwnam(api_user).pw_uid
    except KeyError as error:
        raise BrokerError("PEER_IDENTITY_INVALID", "configured API identity does not exist") from error
    sock = socket.socket(fileno=fd)
    credentials = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", credentials)
    if uid != expected_uid:
        raise BrokerError("PEER_DENIED", "update broker peer is not the API identity")
    CANDIDATE_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with CANDIDATE_LOCK_PATH.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            response = broker.handle(_read_socket_request(sock))
        except BrokerError as error:
            response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
        except Exception:
            response = {
                "ok": False,
                "error": {"code": "INTERNAL_ERROR", "message": "update status is unavailable"},
            }
    sock.sendall((json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n").encode())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-user", default=API_USER)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--serve-fd", type=int)
    group.add_argument("--validate-candidate-path", action="store_true")
    group.add_argument("--runtime-candidate-json", action="store_true")
    group.add_argument("--resolve-update-json", action="store_true")
    arguments = parser.parse_args()
    try:
        if not hasattr(os, "geteuid") or os.geteuid() != 0:
            raise BrokerError("BROKER_NOT_ROOT", "Codex update broker must run as root")
        broker = CodexUpdateBroker()
        if arguments.validate_candidate_path:
            print(broker.validate_candidate().path)
            return 0
        if arguments.runtime_candidate_json:
            candidate = broker.runtime_candidate()
            print(
                json.dumps(
                    {
                        "candidateReleaseId": candidate.release_id,
                        "packageRoot": str(candidate.package_root),
                        "version": candidate.version.removeprefix("codex-cli "),
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
            return 0
        if arguments.resolve_update_json:
            candidate = broker.available_candidate()
            if _version_tuple(candidate.version) <= _version_tuple(broker._current_version()):
                raise BrokerError("UPDATE_NOT_READY", "reviewed update is not newer than installed Codex")
            if isinstance(candidate, Candidate):
                value = {"candidateReleaseId": candidate.release_id, "kind": "full-package", "path": str(candidate.path), "version": candidate.version.removeprefix("codex-cli ")}
            else:
                value = {"candidateReleaseId": candidate.release_id, "kind": "runtime", "packageRoot": str(candidate.package_root), "version": candidate.version.removeprefix("codex-cli ")}
            print(json.dumps(value, separators=(",", ":"), sort_keys=True))
            return 0
        assert arguments.serve_fd is not None
        return _serve(arguments.serve_fd, broker, arguments.api_user)
    except BrokerError as error:
        sys.stderr.write(f"codex update broker: {error.code}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
