#!/usr/bin/env python3
"""Narrow root broker for Codex Web UI systemd resource controls."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
    import pwd
except ModuleNotFoundError:  # Unit tests import the Linux broker on Windows.
    fcntl = None  # type: ignore[assignment]
    pwd = None  # type: ignore[assignment]

SCHEMA_VERSION = 1
TARGET_SLICE = "codex-web-ui-workload.slice"
API_USER = "codex-web-ui-api"
POLICY_PATH = Path("/etc/codex-web-ui/resource-limits.json")
DROP_IN_PATH = Path(
    "/etc/systemd/system/codex-web-ui-workload.slice.d/50-resource-limits.conf"
)
LOCK_PATH = Path("/run/codex-web-ui/resource-broker.lock")
SYSTEMCTL = "/usr/bin/systemctl"
CGROUP_ROOT = Path("/sys/fs/cgroup")
PROC_ROOT = Path("/proc")

MIN_MEMORY_BYTES = 256 * 1024 * 1024
MEMORY_CURRENT_MARGIN_BYTES = 256 * 1024 * 1024
MIN_TASKS = 32
TASKS_CURRENT_MARGIN = 8
ONE_GIB = 1024 * 1024 * 1024
MAX_REQUEST_BYTES = 4096


class BrokerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Limits:
    cpu_quota_percent: int | None
    memory_max_bytes: int | None
    tasks_max: int | None

    def json(self) -> dict[str, int | None]:
        return {
            "cpuQuotaPercent": self.cpu_quota_percent,
            "memoryMaxBytes": self.memory_max_bytes,
            "tasksMax": self.tasks_max,
        }


@dataclass(frozen=True)
class Capacity:
    cpu_quota_percent: int
    memory_max_bytes: int
    memory_available_bytes: int
    tasks_max: int

    def json(self) -> dict[str, int]:
        return {
            "cpuQuotaPercent": self.cpu_quota_percent,
            "memoryBytes": self.memory_max_bytes,
            "memoryAvailableBytes": self.memory_available_bytes,
            "tasks": self.tasks_max,
            "measuredAt": datetime.now(timezone.utc).isoformat(),
        }


@dataclass(frozen=True)
class Current:
    limits: Limits
    memory_current_bytes: int
    tasks_current: int

    def json(self) -> dict[str, Any]:
        return {
            **self.limits.json(),
            "memoryCurrentBytes": self.memory_current_bytes,
            "tasksCurrent": self.tasks_current,
        }


CommandRunner = Callable[[list[str]], subprocess.CompletedProcess[str]]


def run_command(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
    )


def _finite_cgroup_value(path: Path) -> int | None:
    try:
        value = path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return None
    if value == "max":
        return None
    if not re.fullmatch(r"[0-9]+", value):
        raise BrokerError("CAPACITY_UNAVAILABLE", f"invalid cgroup value in {path.name}")
    return int(value)


def _self_cgroup(proc_root: Path, cgroup_root: Path) -> Path:
    try:
        lines = (proc_root / "self/cgroup").read_text(encoding="ascii").splitlines()
    except OSError as error:
        raise BrokerError("CAPACITY_UNAVAILABLE", "cannot read process cgroup") from error
    unified = next((line[3:] for line in lines if line.startswith("0::")), None)
    if unified is None or not unified.startswith("/") or ".." in Path(unified).parts:
        raise BrokerError("CAPACITY_UNAVAILABLE", "unified cgroup path is unavailable")
    candidate = cgroup_root / unified.lstrip("/")
    try:
        candidate.relative_to(cgroup_root)
    except ValueError as error:
        raise BrokerError("CAPACITY_UNAVAILABLE", "cgroup path escapes its root") from error
    return candidate


def _capacity_ancestors(proc_root: Path, cgroup_root: Path) -> tuple[Path, list[Path]]:
    target = cgroup_root / TARGET_SLICE
    if not target.is_dir():
        raise BrokerError("CAPACITY_UNAVAILABLE", "workload slice cgroup is unavailable")
    # Exclude the target leaf: its current policy is not host capacity.
    current = target.parent
    paths: list[Path] = []
    while True:
        paths.append(current)
        if current == cgroup_root:
            break
        if cgroup_root not in current.parents:
            raise BrokerError("CAPACITY_UNAVAILABLE", "invalid cgroup ancestry")
        current = current.parent
    return target, paths


def _cpu_set_size(value: str) -> int:
    cpus: set[int] = set()
    for part in value.strip().split(","):
        if not part:
            continue
        match = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", part)
        if not match:
            raise BrokerError("CAPACITY_UNAVAILABLE", "invalid effective CPU set")
        start = int(match.group(1))
        end = start if match.group(2) is None else int(match.group(2))
        if end < start:
            raise BrokerError("CAPACITY_UNAVAILABLE", "invalid effective CPU set")
        cpus.update(range(start, end + 1))
    return len(cpus)


def detect_capacity(proc_root: Path = PROC_ROOT, cgroup_root: Path = CGROUP_ROOT) -> Capacity:
    target, ancestors = _capacity_ancestors(proc_root, cgroup_root)
    try:
        cpu_count = _cpu_set_size((target / "cpuset.cpus.effective").read_text(encoding="ascii"))
    except FileNotFoundError:
        try:
            cpu_count = len(os.sched_getaffinity(0))
        except AttributeError:
            cpu_count = os.cpu_count() or 0
    if cpu_count < 1:
        raise BrokerError("CAPACITY_UNAVAILABLE", "CPU capacity is unavailable")
    cpu_percent = cpu_count * 100

    mem_total_kib: int | None = None
    mem_available_kib: int | None = None
    try:
        for line in (proc_root / "meminfo").read_text(encoding="ascii").splitlines():
            match = re.fullmatch(r"MemTotal:\s+([0-9]+) kB", line)
            if match:
                mem_total_kib = int(match.group(1))
            available_match = re.fullmatch(r"MemAvailable:\s+([0-9]+) kB", line)
            if available_match:
                mem_available_kib = int(available_match.group(1))
    except OSError as error:
        raise BrokerError("CAPACITY_UNAVAILABLE", "memory capacity is unavailable") from error
    if not mem_total_kib or mem_available_kib is None:
        raise BrokerError("CAPACITY_UNAVAILABLE", "memory capacity is unavailable")
    memory_bytes = mem_total_kib * 1024

    try:
        tasks_max = int((proc_root / "sys/kernel/pid_max").read_text(encoding="ascii").strip())
    except (OSError, ValueError) as error:
        raise BrokerError("CAPACITY_UNAVAILABLE", "task capacity is unavailable") from error

    for ancestor in ancestors:
        memory_limit = _finite_cgroup_value(ancestor / "memory.max")
        if memory_limit is not None:
            memory_bytes = min(memory_bytes, memory_limit)
        tasks_limit = _finite_cgroup_value(ancestor / "pids.max")
        if tasks_limit is not None:
            tasks_max = min(tasks_max, tasks_limit)
        try:
            cpu_max = (ancestor / "cpu.max").read_text(encoding="ascii").strip().split()
        except FileNotFoundError:
            cpu_max = []
        if cpu_max and cpu_max[0] != "max":
            if len(cpu_max) != 2 or not all(re.fullmatch(r"[0-9]+", item) for item in cpu_max):
                raise BrokerError("CAPACITY_UNAVAILABLE", "invalid cgroup CPU capacity")
            quota, period = map(int, cpu_max)
            if quota < 1 or period < 1:
                raise BrokerError("CAPACITY_UNAVAILABLE", "invalid cgroup CPU capacity")
            cpu_percent = min(cpu_percent, max(1, quota * 100 // period))

    if memory_bytes < MIN_MEMORY_BYTES or tasks_max < MIN_TASKS:
        raise BrokerError("CAPACITY_TOO_SMALL", "host capacity is below the operational floor")
    memory_available_bytes = min(memory_bytes, mem_available_kib * 1024)
    return Capacity(cpu_percent, memory_bytes, memory_available_bytes, tasks_max)


def _parse_duration_microseconds(value: str) -> int | None:
    value = value.strip()
    if value in {"infinity", "[not set]", ""}:
        return None
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(us|ms|s|min)", value)
    if not match:
        if value.isdigit():
            return int(value)
        raise BrokerError("SYSTEMD_READBACK_INVALID", "invalid CPU quota readback")
    multiplier = {"us": 1, "ms": 1_000, "s": 1_000_000, "min": 60_000_000}[match.group(2)]
    return int(float(match.group(1)) * multiplier)


def _parse_limit(value: str) -> int | None:
    value = value.strip()
    if value in {"infinity", "[not set]", ""}:
        return None
    if not value.isdigit():
        raise BrokerError("SYSTEMD_READBACK_INVALID", "invalid systemd limit readback")
    return int(value)


def _parse_current(value: str) -> int:
    parsed = _parse_limit(value)
    return 0 if parsed is None else parsed


def _parse_systemctl_show(output: str) -> Current:
    values: dict[str, str] = {}
    for line in output.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    required = {
        "CPUQuotaPerSecUSec",
        "MemoryMax",
        "TasksMax",
        "MemoryCurrent",
        "TasksCurrent",
    }
    if not required.issubset(values):
        raise BrokerError("SYSTEMD_READBACK_INVALID", "systemd readback is incomplete")
    cpu_microseconds = _parse_duration_microseconds(values["CPUQuotaPerSecUSec"])
    cpu_percent = None if cpu_microseconds is None else math.ceil(cpu_microseconds / 10_000)
    return Current(
        Limits(cpu_percent, _parse_limit(values["MemoryMax"]), _parse_limit(values["TasksMax"])),
        _parse_current(values["MemoryCurrent"]),
        _parse_current(values["TasksCurrent"]),
    )


def _systemd_value(value: int | None, suffix: str = "") -> str:
    return "infinity" if value is None else f"{value}{suffix}"


def _systemd_cpu_value(value: int | None) -> str:
    return "" if value is None else f"{value}%"


class ResourceBroker:
    def __init__(
        self,
        *,
        policy_path: Path = POLICY_PATH,
        drop_in_path: Path = DROP_IN_PATH,
        proc_root: Path = PROC_ROOT,
        cgroup_root: Path = CGROUP_ROOT,
        command_runner: CommandRunner = run_command,
    ) -> None:
        self.policy_path = policy_path
        self.drop_in_path = drop_in_path
        self.proc_root = proc_root
        self.cgroup_root = cgroup_root
        self.command_runner = command_runner

    def _command(self, *arguments: str) -> str:
        result = self.command_runner([SYSTEMCTL, *arguments])
        if result.returncode != 0:
            raise BrokerError("SYSTEMD_OPERATION_FAILED", "systemd rejected the resource operation")
        return result.stdout

    def current(self) -> Current:
        output = self._command(
            "show",
            TARGET_SLICE,
            "--property=CPUQuotaPerSecUSec",
            "--property=MemoryMax",
            "--property=TasksMax",
            "--property=MemoryCurrent",
            "--property=TasksCurrent",
        )
        return _parse_systemctl_show(output)

    def _load_policy(self) -> dict[str, Any] | None:
        try:
            info = self.policy_path.lstat()
            if not self.policy_path.is_file() or self.policy_path.is_symlink():
                raise BrokerError("POLICY_INVALID", "resource policy is not a regular file")
            if os.name == "posix" and (info.st_uid != 0 or info.st_mode & 0o077):
                raise BrokerError("POLICY_INVALID", "resource policy ownership or mode is unsafe")
            value = json.loads(self.policy_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as error:
            raise BrokerError("POLICY_INVALID", "resource policy cannot be read") from error
        if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION:
            raise BrokerError("POLICY_INVALID", "resource policy schema is invalid")
        return value

    def snapshot(self) -> dict[str, Any]:
        capacity = detect_capacity(self.proc_root, self.cgroup_root)
        policy = self._load_policy()
        current = self.current()
        generation = 0 if policy is None else int(policy.get("generation", 0))
        public_policy = {
            "mode": "auto" if policy is None else policy.get("mode"),
            "cpuQuotaPercent": None,
            "memoryMaxBytes": None,
            "tasksMax": None,
        }
        if policy is not None and policy.get("mode") == "custom":
            requested = policy.get("requested")
            if not isinstance(requested, dict):
                raise BrokerError("POLICY_INVALID", "stored custom policy is invalid")
            public_policy.update(requested)
        return {
            "ok": True,
            "snapshot": {
                "capacity": capacity.json(),
                "effective": current.limits.json(),
                "policy": public_policy,
                "generation": generation,
            },
        }

    @staticmethod
    def _validate_request(request: dict[str, Any]) -> tuple[str, str, Limits | None]:
        request_id = request.get("requestId")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", request_id):
            raise BrokerError("REQUEST_INVALID", "requestId is invalid")
        if request.get("version") != SCHEMA_VERSION:
            raise BrokerError("REQUEST_INVALID", "request version is unsupported")
        action = request.get("action")
        if action == "snapshot":
            if set(request) != {"version", "requestId", "action"}:
                raise BrokerError("REQUEST_INVALID", "snapshot fields are invalid")
            return request_id, "snapshot", None
        if action != "apply":
            raise BrokerError("REQUEST_INVALID", "action is unsupported")
        mode = request.get("mode")
        if mode == "auto":
            base = {"version", "requestId", "action", "mode"}
            nullable = base | {"cpuQuotaPercent", "memoryMaxBytes", "tasksMax"}
            if set(request) == nullable and all(
                request[name] is None
                for name in ("cpuQuotaPercent", "memoryMaxBytes", "tasksMax")
            ):
                return request_id, "auto", None
            if set(request) != base:
                raise BrokerError("REQUEST_INVALID", "auto policy fields are invalid")
            return request_id, "auto", None
        expected = {
            "version",
            "requestId",
            "action",
            "mode",
            "cpuQuotaPercent",
            "memoryMaxBytes",
            "tasksMax",
        }
        if mode != "custom" or set(request) != expected:
            raise BrokerError("REQUEST_INVALID", "custom policy fields are invalid")
        values = (request["cpuQuotaPercent"], request["memoryMaxBytes"], request["tasksMax"])
        if any(type(value) is not int or value < 1 for value in values):
            raise BrokerError("REQUEST_INVALID", "custom limits must be positive integers")
        return request_id, "custom", Limits(*values)

    @staticmethod
    def _effective(mode: str, requested: Limits | None, capacity: Capacity) -> Limits:
        if mode == "auto":
            cpu = capacity.cpu_quota_percent
            if cpu > 100:
                cpu -= 100
            reserve = max(ONE_GIB, math.ceil(capacity.memory_max_bytes * 0.15))
            memory = capacity.memory_max_bytes - reserve
            if memory < MIN_MEMORY_BYTES:
                raise BrokerError("CAPACITY_TOO_SMALL", "automatic RAM reserve leaves no safe workload")
            return Limits(cpu, memory, capacity.tasks_max)
        assert requested is not None
        if requested.cpu_quota_percent > capacity.cpu_quota_percent:
            raise BrokerError("LIMIT_EXCEEDS_CAPACITY", "CPU limit exceeds live capacity")
        if requested.memory_max_bytes > capacity.memory_max_bytes:
            raise BrokerError("LIMIT_EXCEEDS_CAPACITY", "RAM limit exceeds live capacity")
        if requested.tasks_max > capacity.tasks_max:
            raise BrokerError("LIMIT_EXCEEDS_CAPACITY", "task limit exceeds live capacity")
        if requested.memory_max_bytes < MIN_MEMORY_BYTES or requested.tasks_max < MIN_TASKS:
            raise BrokerError("LIMIT_BELOW_FLOOR", "custom limit is below the operational floor")
        return requested

    @staticmethod
    def _validate_current(effective: Limits, current: Current) -> None:
        assert effective.memory_max_bytes is not None and effective.tasks_max is not None
        if effective.memory_max_bytes < current.memory_current_bytes + MEMORY_CURRENT_MARGIN_BYTES:
            raise BrokerError("LIMIT_BELOW_CURRENT", "RAM limit is too close to current use")
        if effective.tasks_max < current.tasks_current + TASKS_CURRENT_MARGIN:
            raise BrokerError("LIMIT_BELOW_CURRENT", "task limit is too close to current use")

    def _set_runtime(self, limits: Limits) -> None:
        self._command(
            "set-property",
            "--runtime",
            TARGET_SLICE,
            f"CPUQuota={_systemd_cpu_value(limits.cpu_quota_percent)}",
            f"MemoryMax={_systemd_value(limits.memory_max_bytes)}",
            f"TasksMax={_systemd_value(limits.tasks_max)}",
        )

    @staticmethod
    def _assert_readback(expected: Limits, actual: Limits) -> None:
        if expected != actual:
            raise BrokerError("SYSTEMD_READBACK_MISMATCH", "systemd did not apply the requested limits")

    @staticmethod
    def _atomic_write(path: Path, content: bytes, mode: int) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            if not hasattr(os, "fchmod"):
                os.chmod(temporary, mode)
            os.replace(temporary, path)
            if os.name == "posix":
                directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _restore_file(path: Path, previous: bytes | None, mode: int) -> None:
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            ResourceBroker._atomic_write(path, previous, mode)

    @staticmethod
    def _drop_in(limits: Limits) -> bytes:
        return (
            "[Slice]\n"
            f"CPUQuota={_systemd_value(limits.cpu_quota_percent, '%')}\n"
            f"MemoryMax={_systemd_value(limits.memory_max_bytes)}\n"
            f"TasksMax={_systemd_value(limits.tasks_max)}\n"
        ).encode("ascii")

    def apply(self, request_id: str, mode: str, requested: Limits | None) -> dict[str, Any]:
        old_policy = self._load_policy()
        if old_policy is not None and old_policy.get("requestId") == request_id:
            previous_requested = old_policy.get("requested")
            expected_requested = None if requested is None else requested.json()
            if old_policy.get("mode") != mode or previous_requested != expected_requested:
                raise BrokerError("IDEMPOTENCY_CONFLICT", "requestId was used for another policy")
            return self.snapshot()
        capacity = detect_capacity(self.proc_root, self.cgroup_root)
        current = self.current()
        effective = self._effective(mode, requested, capacity)
        self._validate_current(effective, current)
        generation = 1 if old_policy is None else int(old_policy.get("generation", 0)) + 1
        policy = {
            "schemaVersion": SCHEMA_VERSION,
            "generation": generation,
            "mode": mode,
            "requested": None if requested is None else requested.json(),
            "effective": effective.json(),
            "capacityAtApply": capacity.json(),
            "requestId": request_id,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        policy_bytes = (json.dumps(policy, separators=(",", ":"), sort_keys=True) + "\n").encode()
        previous_policy = self.policy_path.read_bytes() if self.policy_path.exists() else None
        previous_drop_in = self.drop_in_path.read_bytes() if self.drop_in_path.exists() else None
        runtime_changed = False
        try:
            self._set_runtime(effective)
            runtime_changed = True
            self._assert_readback(effective, self.current().limits)
            self._atomic_write(self.drop_in_path, self._drop_in(effective), 0o644)
            self._atomic_write(self.policy_path, policy_bytes, 0o600)
            self._command("daemon-reload")
            self._assert_readback(effective, self.current().limits)
        except Exception as error:
            rollback_error: Exception | None = None
            try:
                self._restore_file(self.drop_in_path, previous_drop_in, 0o644)
                self._restore_file(self.policy_path, previous_policy, 0o600)
                self._command("daemon-reload")
                if runtime_changed:
                    self._set_runtime(current.limits)
                    self._assert_readback(current.limits, self.current().limits)
            except Exception as nested:
                rollback_error = nested
            if rollback_error is not None:
                raise BrokerError(
                    "ROLLBACK_FAILED", "resource update failed and rollback could not be verified"
                ) from rollback_error
            if isinstance(error, BrokerError):
                raise
            raise BrokerError("APPLY_FAILED", "resource update failed and was rolled back") from error
        applied = self.current()
        public_policy = {
            "mode": mode,
            "cpuQuotaPercent": None,
            "memoryMaxBytes": None,
            "tasksMax": None,
        }
        if requested is not None:
            public_policy.update(requested.json())
        return {
            "ok": True,
            "snapshot": {
                "capacity": capacity.json(),
                "effective": applied.limits.json(),
                "policy": public_policy,
                "generation": generation,
            },
        }

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id, action, requested = self._validate_request(request)
        if action == "snapshot":
            return self.snapshot()
        return self.apply(request_id, action, requested)

    def initialize(self) -> dict[str, Any]:
        policy = self._load_policy()
        request_id = f"installer-reconcile-{time.time_ns()}"
        if policy is None:
            return self.apply(request_id, "auto", None)
        mode = policy.get("mode")
        if mode == "auto":
            return self.apply(request_id, "auto", None)
        requested = policy.get("requested")
        if mode != "custom" or not isinstance(requested, dict):
            raise BrokerError("POLICY_INVALID", "stored resource policy is invalid")
        request = {
            "version": SCHEMA_VERSION,
            "requestId": request_id,
            "action": "apply",
            "mode": "custom",
            **requested,
        }
        request_id, parsed_mode, parsed_limits = self._validate_request(request)
        return self.apply(request_id, parsed_mode, parsed_limits)


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


def _serve(fd: int, broker: ResourceBroker) -> int:
    if not hasattr(os, "geteuid") or os.geteuid() != 0 or pwd is None:
        raise BrokerError("BROKER_NOT_ROOT", "resource broker must run as root")
    expected_uid = pwd.getpwnam(API_USER).pw_uid
    sock = socket.socket(fileno=fd)
    credentials = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", credentials)
    if uid != expected_uid:
        raise BrokerError("PEER_DENIED", "resource broker peer is not the API identity")
    request_id: str | None = None
    request: dict[str, Any] = {}
    try:
        request = _read_socket_request(sock)
        if isinstance(request.get("requestId"), str):
            request_id = request["requestId"]
        response = broker.handle(request)
    except BrokerError as error:
        response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
    if request_id is not None and request.get("action") == "apply":
        outcome = "applied" if response.get("ok") is True else response["error"]["code"]
        generation = response.get("snapshot", {}).get("generation", "unchanged")
        sys.stderr.write(
            f"resource broker: request={request_id} peer_uid={uid} outcome={outcome} generation={generation}\n"
        )
    sock.sendall((json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n").encode())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--serve-fd", type=int)
    group.add_argument("--initialize", action="store_true")
    arguments = parser.parse_args()
    if fcntl is None:
        sys.stderr.write("resource broker: BROKER_UNSUPPORTED: Linux is required\n")
        return 1
    broker = ResourceBroker()
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with LOCK_PATH.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if arguments.initialize:
                if not hasattr(os, "geteuid") or os.geteuid() != 0:
                    raise BrokerError("BROKER_NOT_ROOT", "resource broker must run as root")
                response = broker.initialize()
                sys.stdout.write(json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n")
                return 0
            assert arguments.serve_fd is not None
            return _serve(arguments.serve_fd, broker)
        except BrokerError as error:
            sys.stderr.write(f"resource broker: {error.code}: {error}\n")
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
