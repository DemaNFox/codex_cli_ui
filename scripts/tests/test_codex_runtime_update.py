from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "codex_runtime_update_stage", ROOT / "scripts/codex-runtime-update-stage.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CodexRuntimeUpdateTest(unittest.TestCase):
    def test_integrity_requires_published_and_reviewed_sha512(self) -> None:
        payload = b"fixed codex archive"
        digest = hashlib.sha512(payload).digest()
        integrity = "sha512-" + base64.b64encode(digest).decode("ascii")
        MODULE._verify_archive(payload, integrity, digest.hex())
        with self.assertRaises(MODULE.StageError):
            MODULE._verify_archive(payload, integrity, "0" * 128)
        with self.assertRaises(MODULE.StageError):
            MODULE._verify_archive(payload + b"changed", integrity, digest.hex())

    def test_target_accepts_only_fixed_package_and_complete_architecture_pins(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "infra/codex-update-target.json"
            path.parent.mkdir()
            target = json.loads((ROOT / "infra/codex-update-target.json").read_text(encoding="utf-8"))
            path.write_text(json.dumps(target), encoding="utf-8")
            self.assertEqual(MODULE._load_target(root)["package"], "@openai/codex")
            target["package"] = "attacker/package"
            path.write_text(json.dumps(target), encoding="utf-8")
            with self.assertRaises(MODULE.StageError):
                MODULE._load_target(root)

    def test_latest_must_equal_reviewed_target(self) -> None:
        response = json.dumps({"name": "@openai/codex", "version": "0.161.0"}).encode()
        with mock.patch.object(MODULE, "_fetch", return_value=response):
            with self.assertRaisesRegex(MODULE.StageError, "full app package"):
                MODULE._require_latest("0.160.0")

    def test_worker_executes_candidate_unprivileged_and_keeps_full_package_path(self) -> None:
        worker = (ROOT / "scripts/codex-update-worker.sh").read_text(encoding="utf-8")
        self.assertIn('update_kind == full-package', worker)
        self.assertIn('runuser -u "$api_user"', worker)
        self.assertIn("app-server generate-json-schema", worker)
        self.assertIn("protocol differs from the supported snapshot", worker)
        self.assertIn("--resolve-update-json", worker)
        self.assertIn("if $runtime_created", worker)
        self.assertIn("rm -rf --one-file-system -- \"$runtime_dir\"", worker)
        self.assertIn("if $runtime_created && $can_remove", worker)
        self.assertIn("if $restore_ok; then can_remove=true; else failed=true; fi", worker)
        commit_point = worker.index("runtime_committed=true")
        backup_removal = worker.index(
            'rm -rf --one-file-system -- "$runtime_schemas" "$runtime_backups"'
        )
        success_result = worker.index("write_result succeeded")
        self.assertLess(commit_point, backup_removal)
        self.assertLess(backup_removal, success_result)
        self.assertIn('if ! rm -rf --one-file-system -- "$runtime_schemas" "$runtime_backups"', worker)
        self.assertIn("$runtime_committed && return 0", worker)
        self.assertIn(
            "if [[ ${update_kind:-} == runtime ]] && $runtime_committed; then", worker
        )
        self.assertIn("or set(t) !=", worker)
        self.assertNotIn("trap rollback RETURN", worker)
        for forbidden in ("$URL", "$COMMAND", "browser_version", "request_path"):
            self.assertNotIn(forbidden, worker)

    def test_python_helpers_compile(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", str(ROOT / "scripts/codex-update-broker.py"), str(ROOT / "scripts/codex-runtime-update-stage.py")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
