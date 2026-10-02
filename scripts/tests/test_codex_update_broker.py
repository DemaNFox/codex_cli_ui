from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "codex_update_broker", ROOT / "scripts/codex-update-broker.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def completed(
    arguments: list[str], code: int = 0, *, stdout: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(arguments, code, stdout, "")


class CodexUpdateBrokerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "opt/codex-web-ui"
        self.releases = self.root / "releases"
        self.releases.mkdir(parents=True)
        self.current = self._release("current", "codex-cli 0.153.4", compatibility=1)
        self.candidate = self._release("candidate-1", "codex-cli 0.154.0", compatibility=1)
        try:
            (self.root / "current").symlink_to(self.current, target_is_directory=True)
            (self.root / "codex-update-candidate").symlink_to(
                self.candidate, target_is_directory=True
            )
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")
        self.commands: list[list[str]] = []

        def runner(arguments: list[str]) -> subprocess.CompletedProcess[str]:
            self.commands.append(arguments)
            if arguments[:2] == [MODULE.SYSTEMCTL, "show"]:
                return completed(arguments, stdout="inactive\n")
            if arguments[:2] == [MODULE.SYSTEMCTL, "list-jobs"]:
                return completed(arguments)
            return completed(arguments)

        self.result_path = Path(self.temp.name) / "result.json"
        self.broker = MODULE.CodexUpdateBroker(
            opt_root=self.root,
            result_path=self.result_path,
            command_runner=runner,
            machine="x86_64",
        )

    def _release(self, release_id: str, version: str, *, compatibility: int) -> Path:
        release = self.releases / release_id
        for relative in (
            "scripts/prepare-package.sh",
            "scripts/install-package.sh",
            "scripts/codex-update-broker.py",
            "scripts/codex-update-worker.sh",
            "infra/systemd/codex-web-ui-codex-update-broker.socket",
            "infra/systemd/codex-web-ui-codex-update-broker@.service",
            "infra/systemd/codex-web-ui-codex-update.service",
        ):
            path = release / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n", encoding="utf-8")
        os.chmod(release / "scripts/prepare-package.sh", 0o755)
        manifest = {
            "apiCompatibility": compatibility,
            "target": {"platform": "linux", "architecture": "x64"},
            "runtime": {"codex": {"versionPin": version}},
        }
        (release / "release.json").write_text(json.dumps(manifest), encoding="utf-8")
        return release

    def request(self, action: str) -> dict[str, object]:
        return {"version": 1, "requestId": str(uuid.uuid4()), "action": action}

    def add_runtime_target(self, version: str = "0.160.0") -> None:
        protocol = {
            "codex_app_server_protocol.schemas.json": b'{"v":1}\n',
            "codex_app_server_protocol.v2.schemas.json": b'{"v":2}\n',
        }
        for name, content in protocol.items():
            path = self.current / "protocol" / version / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        target = {
            "schemaVersion": 1,
            "package": "@openai/codex",
            "version": version,
            "tarballs": {
                "main": {"sha512": "1" * 128},
                "linux-x64": {"sha512": "2" * 128},
                "linux-arm64": {"sha512": "3" * 128},
            },
            "protocolFiles": {
                name: hashlib.sha256(content).hexdigest() for name, content in protocol.items()
            },
        }
        path = self.current / "infra/codex-update-target.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(target), encoding="utf-8")

    def test_status_reports_only_verified_fixed_candidate(self) -> None:
        result = self.broker.handle(self.request("status"))
        self.assertEqual(
            result,
            {
                "ok": True,
                "snapshot": {
                    "state": "ready",
                    "currentVersion": "codex-cli 0.153.4",
                    "availableVersion": "codex-cli 0.154.0",
                    "candidateReleaseId": "candidate-1",
                    "lastResult": None,
                },
            },
        )
        verifier = str(self.current / "scripts/prepare-package.sh")
        self.assertIn(
            [verifier, "--verify", str(self.candidate), "--arch", "linux-x64"],
            self.commands,
        )

    def test_apply_starts_only_fixed_oneshot_without_request_arguments(self) -> None:
        result = self.broker.handle(self.request("apply"))
        self.assertEqual(result["snapshot"]["state"], "applying")
        self.assertEqual(
            self.commands[-1],
            [MODULE.SYSTEMCTL, "start", "--no-block", MODULE.UPDATE_SERVICE],
        )

    def test_activating_worker_is_reported_as_applying(self) -> None:
        original = self.broker.command_runner

        def activating(arguments: list[str]) -> subprocess.CompletedProcess[str]:
            if arguments[:2] == [MODULE.SYSTEMCTL, "show"]:
                return completed(arguments, stdout="activating\n")
            return original(arguments)

        self.broker.command_runner = activating
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "applying")

    def test_queued_worker_job_is_reported_as_applying(self) -> None:
        original = self.broker.command_runner

        def queued(arguments: list[str]) -> subprocess.CompletedProcess[str]:
            if arguments[:2] == [MODULE.SYSTEMCTL, "list-jobs"]:
                return completed(arguments, stdout="17 codex-web-ui-codex-update.service start running\n")
            return original(arguments)

        self.broker.command_runner = queued
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "applying")

    def test_request_grammar_rejects_extra_fields_non_uuid_and_unknown_action(self) -> None:
        bad = self.request("status")
        bad["url"] = "https://attacker.invalid/update"
        for request in (
            bad,
            {"version": 1, "requestId": "not-a-uuid", "action": "status"},
            {"version": 1, "requestId": str(uuid.uuid4()), "action": "run"},
            {"version": True, "requestId": str(uuid.uuid4()), "action": "status"},
        ):
            with self.subTest(request=request):
                with self.assertRaises(MODULE.BrokerError) as caught:
                    self.broker.handle(request)
                self.assertEqual(caught.exception.code, "REQUEST_INVALID")

    def test_candidate_api_compatibility_must_match_installed_release(self) -> None:
        manifest_path = self.candidate / "release.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["apiCompatibility"] = 2
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(MODULE.BrokerError) as caught:
            self.broker.validate_candidate()
        self.assertEqual(caught.exception.code, "API_INCOMPATIBLE")

    def test_failed_result_is_bounded_and_scoped_to_same_candidate(self) -> None:
        self.result_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "candidateReleaseId": "candidate-1",
                    "status": "rollback_failed",
                    "message": "rollback could not be verified",
                    "completedAt": "2026-10-01T12:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        os.chmod(self.result_path, 0o600)
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "rollback_failed")
        self.assertEqual(result["snapshot"]["lastResult"]["status"], "rollback_failed")

    def test_rollback_failure_has_priority_when_candidate_version_is_current(self) -> None:
        current_manifest = self.current / "release.json"
        manifest = json.loads(current_manifest.read_text(encoding="utf-8"))
        manifest["runtime"]["codex"]["versionPin"] = "codex-cli 0.154.0"
        current_manifest.write_text(json.dumps(manifest), encoding="utf-8")
        self.result_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "candidateReleaseId": "candidate-1",
                    "status": "rollback_failed",
                    "message": "rollback could not be verified",
                    "completedAt": "2026-10-01T12:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        os.chmod(self.result_path, 0o600)
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "rollback_failed")

    def test_missing_candidate_is_unavailable(self) -> None:
        (self.root / "codex-update-candidate").unlink()
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "unavailable")
        self.assertIsNone(result["snapshot"]["availableVersion"])

    def test_reviewed_runtime_target_is_ready_without_full_package(self) -> None:
        (self.root / "codex-update-candidate").unlink()
        self.add_runtime_target()
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "ready")
        self.assertEqual(result["snapshot"]["availableVersion"], "codex-cli 0.160.0")
        self.assertEqual(result["snapshot"]["candidateReleaseId"], "runtime-0.160.0")

    def test_runtime_target_equal_or_older_than_installed_is_current(self) -> None:
        (self.root / "codex-update-candidate").unlink()
        for version in ("0.153.4", "0.152.9"):
            with self.subTest(version=version):
                self.add_runtime_target(version)
                result = self.broker.handle(self.request("status"))
                self.assertEqual(result["snapshot"]["state"], "current")

    def test_installed_config_pin_makes_successful_runtime_target_current(self) -> None:
        (self.root / "codex-update-candidate").unlink()
        self.add_runtime_target()
        runner = Path(self.temp.name) / "codex-runner.env"
        runner.write_text(
            'CODEX_WEB_CODEX_VERSION_PIN="codex-cli 0.160.0"\n', encoding="utf-8"
        )
        os.chmod(runner, 0o600)
        self.broker.runner_config = runner
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["state"], "current")

    def test_runtime_target_protocol_snapshot_must_match_reviewed_hash(self) -> None:
        (self.root / "codex-update-candidate").unlink()
        self.add_runtime_target()
        (self.current / "protocol/0.160.0/codex_app_server_protocol.schemas.json").write_text(
            "changed", encoding="utf-8"
        )
        with self.assertRaises(MODULE.BrokerError) as caught:
            self.broker.handle(self.request("status"))
        self.assertEqual(caught.exception.code, "RUNTIME_UPDATE_INVALID")

    def test_full_package_candidate_remains_preferred_over_runtime_target(self) -> None:
        self.add_runtime_target("0.999.0")
        result = self.broker.handle(self.request("status"))
        self.assertEqual(result["snapshot"]["candidateReleaseId"], "candidate-1")

    def test_apply_rejects_candidate_already_at_current_version(self) -> None:
        manifest_path = self.candidate / "release.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["runtime"]["codex"]["versionPin"] = "codex-cli 0.153.4"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(MODULE.BrokerError) as caught:
            self.broker.handle(self.request("apply"))
        self.assertEqual(caught.exception.code, "UPDATE_NOT_READY")

    def test_apply_can_retry_after_verified_rollback_failure_state_is_not_used(self) -> None:
        self.result_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "candidateReleaseId": "candidate-1",
                    "status": "failed",
                    "message": "previous release restored",
                    "completedAt": "2026-10-01T12:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        os.chmod(self.result_path, 0o600)
        result = self.broker.handle(self.request("apply"))
        self.assertEqual(result["snapshot"]["state"], "applying")

    def test_peer_identity_is_checked_with_so_peercred(self) -> None:
        source = (ROOT / "scripts/codex-update-broker.py").read_text(encoding="utf-8")
        self.assertIn("socket.SO_PEERCRED", source)
        self.assertIn("uid != expected_uid", source)
        self.assertIn("MAX_REQUEST_BYTES = 4096", source)
        self.assertIn("codex-update-candidate.lock", source)

    def test_current_manifest_and_verifier_are_required_to_be_trusted_regular_files(self) -> None:
        manifest = self.current / "release.json"
        replacement = self.current / "manifest-target.json"
        manifest.rename(replacement)
        try:
            manifest.symlink_to(replacement)
        except OSError as error:
            self.skipTest(f"file symlinks unavailable: {error}")
        with self.assertRaises(MODULE.BrokerError) as caught:
            self.broker.current()
        self.assertEqual(caught.exception.code, "INSTALLATION_INVALID")

    def test_unsafe_root_owned_checks_are_fail_closed_on_posix(self) -> None:
        with mock.patch.object(MODULE.os, "name", "posix"):
            with mock.patch.object(Path, "lstat") as lstat:
                lstat.return_value = mock.Mock(st_uid=1000, st_mode=0o100755)
                with self.assertRaises(MODULE.BrokerError) as caught:
                    MODULE._owned_non_writable(Path("/tmp/candidate"), symlink=True)
        self.assertEqual(caught.exception.code, "CANDIDATE_UNSAFE")


if __name__ == "__main__":
    unittest.main()
