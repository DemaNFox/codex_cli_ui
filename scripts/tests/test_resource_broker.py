from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/resource-broker.py"
SPEC = importlib.util.spec_from_file_location("resource_broker", SCRIPT)
assert SPEC and SPEC.loader
BROKER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BROKER
SPEC.loader.exec_module(BROKER)


class FakeSystemctl:
    def __init__(self) -> None:
        self.cpu: int | None = None
        self.memory: int | None = None
        self.tasks: int | None = None
        self.memory_current = 128 * 1024 * 1024
        self.tasks_current = 10
        self.fail_next_reload = False
        self.commands: list[list[str]] = []

    def __call__(self, arguments: list[str]) -> subprocess.CompletedProcess[str]:
        self.commands.append(arguments)
        action = arguments[1]
        if action == "show":
            if "--property=ControlGroup" in arguments:
                return subprocess.CompletedProcess(
                    arguments,
                    0,
                    "/codex.slice/codex-web.slice/codex-web-ui.slice/codex-web-ui-workload.slice\n",
                    "",
                )
            output = (
                f"CPUQuotaPerSecUSec={'infinity' if self.cpu is None else self.cpu * 10_000}\n"
                f"MemoryMax={'infinity' if self.memory is None else self.memory}\n"
                f"TasksMax={'infinity' if self.tasks is None else self.tasks}\n"
                f"MemoryCurrent={self.memory_current}\n"
                f"TasksCurrent={self.tasks_current}\n"
            )
            return subprocess.CompletedProcess(arguments, 0, output, "")
        if action == "set-property":
            values = dict(item.split("=", 1) for item in arguments[4:])
            cpu = values["CPUQuota"]
            self.cpu = None if cpu in {"", "infinity"} else int(cpu.removesuffix("%"))
            memory = values["MemoryMax"]
            self.memory = None if memory == "infinity" else int(memory)
            tasks = values["TasksMax"]
            self.tasks = None if tasks == "infinity" else int(tasks)
            return subprocess.CompletedProcess(arguments, 0, "", "")
        if action == "daemon-reload":
            if self.fail_next_reload:
                self.fail_next_reload = False
                return subprocess.CompletedProcess(arguments, 1, "", "injected failure")
            return subprocess.CompletedProcess(arguments, 0, "", "")
        raise AssertionError(arguments)


class ResourceBrokerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.proc = root / "proc"
        self.cgroup = root / "cgroup"
        (self.proc / "self").mkdir(parents=True)
        (self.proc / "sys/kernel").mkdir(parents=True)
        (self.cgroup / "system.slice/broker.service").mkdir(parents=True)
        workload = self.cgroup / (
            "codex.slice/codex-web.slice/codex-web-ui.slice/codex-web-ui-workload.slice"
        )
        workload.mkdir(parents=True)
        (workload / "cpuset.cpus.effective").write_text(
            "0-7\n", encoding="ascii"
        )
        (self.proc / "self/cgroup").write_text("0::/system.slice/broker.service\n", encoding="ascii")
        (self.proc / "meminfo").write_text(
            "MemTotal:       16777216 kB\nMemAvailable:   12582912 kB\n", encoding="ascii"
        )
        (self.proc / "sys/kernel/pid_max").write_text("32768\n", encoding="ascii")
        (self.cgroup / "memory.max").write_text("max\n", encoding="ascii")
        (self.cgroup / "pids.max").write_text("max\n", encoding="ascii")
        (self.cgroup / "cpu.max").write_text("max 100000\n", encoding="ascii")
        (self.cgroup / "system.slice/memory.max").write_text("max\n", encoding="ascii")
        (self.cgroup / "system.slice/pids.max").write_text("max\n", encoding="ascii")
        (self.cgroup / "system.slice/cpu.max").write_text("max 100000\n", encoding="ascii")
        self.policy = root / "etc/resource-limits.json"
        self.drop_in = root / "systemd/50-resource-limits.conf"
        self.systemctl = FakeSystemctl()
        self.broker = BROKER.ResourceBroker(
            policy_path=self.policy,
            drop_in_path=self.drop_in,
            proc_root=self.proc,
            cgroup_root=self.cgroup,
            command_runner=self.systemctl,
        )
        self.affinity = patch.object(
            BROKER.os, "sched_getaffinity", return_value=set(range(8)), create=True
        )
        self.affinity.start()

    def tearDown(self) -> None:
        self.affinity.stop()
        self.temporary.cleanup()

    def test_auto_reserves_one_cpu_and_fifteen_percent_ram(self) -> None:
        result = self.broker.handle(
            {"version": 1, "requestId": "auto-1", "action": "apply", "mode": "auto"}
        )
        snapshot = result["snapshot"]
        expected_memory = 16 * BROKER.ONE_GIB - ((16 * BROKER.ONE_GIB * 15 + 99) // 100)
        self.assertEqual(snapshot["effective"]["cpuQuotaPercent"], 700)
        self.assertEqual(snapshot["effective"]["memoryMaxBytes"], expected_memory)
        self.assertEqual(snapshot["effective"]["tasksMax"], 32768)
        self.assertEqual(snapshot["policy"]["mode"], "auto")
        self.assertIsNone(snapshot["policy"]["memoryMaxBytes"])
        self.assertEqual(snapshot["capacity"]["memoryAvailableBytes"], 12 * BROKER.ONE_GIB)
        self.assertTrue(snapshot["capacity"]["measuredAt"].endswith("Z"))
        self.assertTrue(self.policy.is_file())
        self.assertIn("CPUQuota=700%", self.drop_in.read_text(encoding="ascii"))

    def test_custom_limit_above_parent_capacity_is_rejected_without_systemd_write(self) -> None:
        (self.cgroup / "memory.max").write_text(str(4 * BROKER.ONE_GIB), encoding="ascii")
        with self.assertRaisesRegex(BROKER.BrokerError, "RAM limit exceeds live capacity") as raised:
            self.broker.handle(
                {
                    "version": 1,
                    "requestId": "custom-over",
                    "action": "apply",
                    "mode": "custom",
                    "cpuQuotaPercent": 200,
                    "memoryMaxBytes": 5 * BROKER.ONE_GIB,
                    "tasksMax": 100,
                }
            )
        self.assertEqual(raised.exception.code, "LIMIT_EXCEEDS_CAPACITY")
        self.assertFalse(any(command[1] == "set-property" for command in self.systemctl.commands))

    def test_tasks_and_memory_require_current_usage_margin(self) -> None:
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.handle(
                {
                    "version": 1,
                    "requestId": "too-low",
                    "action": "apply",
                    "mode": "custom",
                    "cpuQuotaPercent": 100,
                    "memoryMaxBytes": self.systemctl.memory_current + 128 * 1024 * 1024,
                    "tasksMax": 64,
                }
            )
        self.assertEqual(raised.exception.code, "LIMIT_BELOW_CURRENT")

    def test_failed_persistent_activation_restores_runtime_and_files(self) -> None:
        self.systemctl.fail_next_reload = True
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.handle(
                {"version": 1, "requestId": "rollback", "action": "apply", "mode": "auto"}
            )
        self.assertEqual(raised.exception.code, "SYSTEMD_OPERATION_FAILED")
        self.assertIsNone(self.systemctl.cpu)
        self.assertIsNone(self.systemctl.memory)
        self.assertIsNone(self.systemctl.tasks)
        self.assertFalse(self.policy.exists())
        self.assertFalse(self.drop_in.exists())

    def test_snapshot_has_fixed_public_shape_and_authoritative_readback(self) -> None:
        self.broker.handle(
            {
                "version": 1,
                "requestId": "custom-ok",
                "action": "apply",
                "mode": "custom",
                "cpuQuotaPercent": 250,
                "memoryMaxBytes": 2 * BROKER.ONE_GIB,
                "tasksMax": 128,
            }
        )
        result = self.broker.handle({"version": 1, "requestId": "read", "action": "snapshot"})
        self.assertEqual(set(result), {"ok", "snapshot"})
        self.assertEqual(
            set(result["snapshot"]), {"capacity", "effective", "policy", "generation"}
        )
        self.assertEqual(result["snapshot"]["effective"]["cpuQuotaPercent"], 250)
        self.assertEqual(result["snapshot"]["policy"]["tasksMax"], 128)

    def test_request_grammar_rejects_extra_fields_and_null_custom_values(self) -> None:
        invalid = [
            {"version": 1, "requestId": "x", "action": "snapshot", "unit": "ssh.service"},
            {
                "version": 1,
                "requestId": "x",
                "action": "apply",
                "mode": "custom",
                "cpuQuotaPercent": None,
                "memoryMaxBytes": BROKER.ONE_GIB,
                "tasksMax": 64,
            },
        ]
        for request in invalid:
            with self.subTest(request=request), self.assertRaises(BROKER.BrokerError) as raised:
                self.broker.handle(request)
            self.assertEqual(raised.exception.code, "REQUEST_INVALID")

        accepted_auto = self.broker.handle(
            {
                "version": 1,
                "requestId": "auto-null",
                "action": "apply",
                "mode": "auto",
                "cpuQuotaPercent": None,
                "memoryMaxBytes": None,
                "tasksMax": None,
            }
        )
        self.assertTrue(accepted_auto["ok"])

    def test_apply_replay_is_idempotent_and_conflicting_reuse_is_rejected(self) -> None:
        request = {"version": 1, "requestId": "same", "action": "apply", "mode": "auto"}
        first = self.broker.handle(request)
        write_count = sum(command[1] == "set-property" for command in self.systemctl.commands)
        second = self.broker.handle(request)
        self.assertEqual(second["snapshot"]["generation"], first["snapshot"]["generation"])
        self.assertEqual(
            sum(command[1] == "set-property" for command in self.systemctl.commands), write_count
        )
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.handle(
                {
                    "version": 1,
                    "requestId": "same",
                    "action": "apply",
                    "mode": "custom",
                    "cpuQuotaPercent": 100,
                    "memoryMaxBytes": BROKER.ONE_GIB,
                    "tasksMax": 64,
                }
            )
        self.assertEqual(raised.exception.code, "IDEMPOTENCY_CONFLICT")

    def test_stored_custom_policy_reconciles_against_new_capacity(self) -> None:
        self.broker.handle(
            {
                "version": 1,
                "requestId": "first",
                "action": "apply",
                "mode": "custom",
                "cpuQuotaPercent": 200,
                "memoryMaxBytes": 2 * BROKER.ONE_GIB,
                "tasksMax": 128,
            }
        )
        (self.cgroup / "memory.max").write_text(str(BROKER.ONE_GIB), encoding="ascii")
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.initialize()
        self.assertEqual(raised.exception.code, "LIMIT_EXCEEDS_CAPACITY")


class ResourceBrokerStaticTest(unittest.TestCase):
    def test_broker_has_fixed_slice_and_no_shell_execution(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('TARGET_SLICE = "codex-web-ui-workload.slice"', source)
        self.assertIn('parser.add_argument("--api-user", default=API_USER)', source)
        self.assertIn("_serve(arguments.serve_fd, broker, arguments.api_user)", source)
        self.assertIn("socket.SO_PEERCRED", source)
        self.assertIn("uid != expected_uid", source)
        self.assertNotIn("shell=True", source)


if __name__ == "__main__":
    unittest.main()
