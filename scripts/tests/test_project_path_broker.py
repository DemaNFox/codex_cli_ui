from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/project-path-broker.py"
SPEC = importlib.util.spec_from_file_location("project_path_broker", SCRIPT)
assert SPEC and SPEC.loader
BROKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BROKER)


class FakeSocket:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def recv(self, size: int) -> bytes:
        chunk, self.payload = self.payload[:size], self.payload[size:]
        return chunk


class ProjectPathBrokerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.allowed = self.root / "allowed"
        self.outside = self.root / "outside"
        self.allowed.mkdir()
        self.outside.mkdir()
        self.roots_file = self.root / "project-roots"
        self._write_roots(str(self.allowed))
        trusted_uid = os.getuid() if hasattr(os, "getuid") else 0
        self.broker = BROKER.ProjectPathBroker(
            roots_path=self.roots_file, trusted_uid=trusted_uid
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_roots(self, *roots: str) -> None:
        self.roots_file.write_text("".join(f"{root}\n" for root in roots), encoding="utf-8")
        if os.name == "posix":
            self.roots_file.chmod(0o600)

    @staticmethod
    def _request(path: Path, kind: str = "existing") -> dict[str, object]:
        return {
            "version": 1,
            "requestId": "test-request-1",
            "action": "canonicalize",
            "path": str(path),
            "kind": kind,
        }

    def test_canonicalizes_files_and_enforces_directory_kind(self) -> None:
        directory = self.allowed / "project"
        directory.mkdir()
        file = directory / "README.md"
        file.write_text("test", encoding="utf-8")

        self.assertEqual(
            self.broker.handle(self._request(file)),
            {"ok": True, "canonicalPath": str(file.resolve())},
        )
        self.assertEqual(
            self.broker.handle(self._request(directory, "directory"))["canonicalPath"],
            str(directory.resolve()),
        )
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.handle(self._request(file, "directory"))
        self.assertEqual(raised.exception.code, "PATH_NOT_DIRECTORY")

    def test_symlink_escape_is_rejected_after_realpath(self) -> None:
        escape = self.allowed / "escape"
        try:
            escape.symlink_to(self.outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation is unavailable: {error}")
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.handle(self._request(escape))
        self.assertEqual(raised.exception.code, "PATH_OUTSIDE_ROOTS")

    def test_filesystem_root_allows_existing_descendants(self) -> None:
        filesystem_root = Path(self.root.anchor)
        self._write_roots(str(filesystem_root))
        result = self.broker.handle(self._request(self.allowed, "directory"))
        self.assertEqual(result["canonicalPath"], str(self.allowed.resolve()))

    def test_missing_outside_and_not_directory_have_stable_errors(self) -> None:
        cases = (
            (self.allowed / "missing", "existing", "PATH_NOT_FOUND"),
            (self.outside, "directory", "PATH_OUTSIDE_ROOTS"),
        )
        file = self.allowed / "file"
        file.write_text("test", encoding="utf-8")
        cases += ((file, "directory", "PATH_NOT_DIRECTORY"),)
        for path, kind, code in cases:
            with self.subTest(code=code), self.assertRaises(BROKER.BrokerError) as raised:
                self.broker.handle(self._request(path, kind))
            self.assertEqual(raised.exception.code, code)

    def test_request_grammar_is_exact_and_bounded(self) -> None:
        valid = self._request(self.allowed)
        invalid = (
            {**valid, "extra": True},
            {**valid, "version": True},
            {**valid, "requestId": "space is invalid"},
            {**valid, "action": "read"},
            {**valid, "kind": "file"},
            {**valid, "path": "relative/project"},
            {**valid, "path": f"{self.allowed}\x00suffix"},
            {**valid, "path": "\ud800"},
            {**valid, "path": "/" + "a" * (BROKER.MAX_PATH_BYTES + 1)},
        )
        for request in invalid:
            with self.subTest(request=request), self.assertRaises(BROKER.BrokerError) as raised:
                self.broker.handle(request)
            self.assertEqual(raised.exception.code, "REQUEST_INVALID")

    def test_socket_protocol_rejects_multiple_and_oversized_requests(self) -> None:
        encoded = json.dumps(self._request(self.allowed)).encode()
        self.assertEqual(BROKER._read_socket_request(FakeSocket(encoded + b"\n")), self._request(self.allowed))
        invalid = (
            encoded,
            encoded + b"\n" + encoded + b"\n",
            b"{" + b"x" * BROKER.MAX_REQUEST_BYTES + b"}\n",
            b"[]\n",
            b'{"version":1,"version":1}\n',
        )
        for payload in invalid:
            with self.subTest(size=len(payload)), self.assertRaises(BROKER.BrokerError) as raised:
                BROKER._read_socket_request(FakeSocket(payload))
            self.assertEqual(raised.exception.code, "REQUEST_INVALID")

    def test_roots_file_and_peer_boundary_are_fail_closed(self) -> None:
        self._write_roots("relative")
        with self.assertRaises(BROKER.BrokerError) as raised:
            self.broker.handle(self._request(self.allowed))
        self.assertEqual(raised.exception.code, "ROOTS_INVALID")

        if os.name == "posix":
            self._write_roots(str(self.allowed))
            self.roots_file.chmod(0o644)
            with self.assertRaises(BROKER.BrokerError) as raised:
                self.broker.handle(self._request(self.allowed))
            self.assertEqual(raised.exception.code, "ROOTS_INVALID")

        source = SCRIPT.read_text(encoding="utf-8")
        service = (
            ROOT / "infra/systemd/codex-web-ui-project-path-broker@.service"
        ).read_text(encoding="utf-8")
        socket_unit = (
            ROOT / "infra/systemd/codex-web-ui-project-path-broker.socket"
        ).read_text(encoding="utf-8")
        self.assertIn("socket.SO_PEERCRED", source)
        self.assertIn("uid != expected_uid", source)
        self.assertIn('ROOTS_PATH = Path("/etc/codex-web-ui/project-roots")', source)
        self.assertNotIn("--roots-file", source)
        self.assertIn("CapabilityBoundingSet=CAP_DAC_READ_SEARCH", service)
        self.assertIn("ProtectHome=read-only", service)
        self.assertIn("ReadOnlyPaths=/", service)
        self.assertNotIn("PrivateTmp=yes", service)
        self.assertIn("RestrictAddressFamilies=AF_UNIX", service)
        self.assertIn("-/root/.codex", service)
        self.assertIn("SocketUser=codex-web-ui-api", socket_unit)
        self.assertIn("SocketMode=0600", socket_unit)

    def test_root_broker_reaches_a_project_the_api_identity_cannot_traverse(self) -> None:
        if os.name != "posix" or not hasattr(os, "geteuid") or os.geteuid() != 0:
            self.skipTest("root Linux integration requires euid 0")
        if shutil.which("runuser") is None:
            self.skipTest("runuser is unavailable")
        probe = subprocess.run(
            ["runuser", "-u", BROKER.API_USER, "--", "stat", str(self.allowed)],
            capture_output=True,
            check=False,
        )
        if probe.returncode == 0:
            self.skipTest("fixture is unexpectedly traversable by the API identity")
        result = self.broker.handle(self._request(self.allowed, "directory"))
        self.assertEqual(result["canonicalPath"], str(self.allowed.resolve()))
        self.assertIn("(info.st_dev, info.st_ino)", SCRIPT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
