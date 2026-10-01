from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/prepare-package.sh"


def find_bash() -> str | None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    if os.name == "nt" and windows_git_bash.exists():
        return str(windows_git_bash)
    found = shutil.which("bash")
    if found:
        return found
    return str(windows_git_bash) if windows_git_bash.exists() else None


def shell_path(path: Path) -> str:
    resolved = str(path.resolve())
    if os.name == "nt":
        drive, rest = os.path.splitdrive(resolved)
        return f"/{drive[0].lower()}{rest.replace(os.sep, '/')}"
    return resolved


class PreparePackageTest(unittest.TestCase):
    def setUp(self) -> None:
        bash = find_bash()
        if bash is None:
            self.skipTest("bash is not available")
        self.bash = bash
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "package"
        self._write_fixture("x64")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_fixture(self, arch: str) -> None:
        files = {
            "install.sh": "#!/usr/bin/env bash\n",
            "scripts/install-package.sh": "#!/usr/bin/env bash\n",
            "scripts/update-web-ubuntu.sh": "#!/usr/bin/env bash\n",
            "scripts/rollback-web-ubuntu.sh": "#!/usr/bin/env bash\n",
            "scripts/graceful-drain.sh": "#!/usr/bin/env bash\n",
            "scripts/resource-broker.py": "#!/usr/bin/env python3\n",
            "scripts/install-local-host-instructions.py": "#!/usr/bin/env python3\n",
            "scripts/migrate-runner-host-admin.sh": "#!/usr/bin/env bash\n",
            "scripts/bootstrap-ubuntu.sh": "#!/usr/bin/env bash\n",
            "apps/server/dist/index.js": "console.log('server');\n",
            "apps/web/dist/index.html": "<!doctype html>\n",
            "infra/toolchain.env": (
                "NODE_VERSION=22.23.3\n"
                "PNPM_VERSION=10.33.2\n"
                "CODEX_CLI_VERSION=0.153.4\n"
                f"NODE_LINUX_X64_SHA256={'1' * 64}\n"
                f"NODE_LINUX_ARM64_SHA256={'2' * 64}\n"
                f"PNPM_TARBALL_SHA512={'3' * 128}\n"
                f"CODEX_TARBALL_SHA512={'4' * 128}\n"
                f"CODEX_LINUX_X64_TARBALL_SHA512={'5' * 128}\n"
                f"CODEX_LINUX_ARM64_TARBALL_SHA512={'6' * 128}\n"
            ),
            "infra/release-manifest.schema.json": "{}\n",
            "infra/systemd/codex-web-ui-resource-broker.socket": "[Socket]\n",
            "infra/systemd/codex-web-ui-resource-broker@.service": "[Service]\n",
            "infra/systemd/codex-web-ui-workload.slice": "[Slice]\n",
            "infra/systemd/codex-web-ui-app-server-host-admin@.service": "[Service]\nUser=root\n",
        }
        binary_names = (
            ("argon2.glibc.node", "argon2.musl.node")
            if arch == "x64"
            else ("argon2.armv8.glibc.node", "argon2.armv8.musl.node")
        )
        for name in binary_names:
            files[f"apps/server/node_modules/argon2/prebuilds/linux-{arch}/{name}"] = name
        for relative, content in files.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
        protocol_files = {
            "0.153.4/codex_app_server_protocol.schemas.json": "{\"v\":1}\n",
            "0.153.4/codex_app_server_protocol.v2.schemas.json": "{\"v\":2}\n",
        }
        for relative, content in protocol_files.items():
            path = self.root / "protocol" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
        (self.root / "protocol/manifest.json").write_text(
            json.dumps(
                {
                    "codexCliVersion": "0.153.4",
                    "generatedAt": "2026-09-27",
                    "files": {
                        relative: hashlib.sha256(content.encode()).hexdigest()
                        for relative, content in protocol_files.items()
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        manifest = {
            "schemaVersion": 1,
            "name": "codex-web-ui",
            "version": "0.1.0",
            "gitRevision": "a" * 40,
            "apiCompatibility": 1,
            "target": {"platform": "linux", "architecture": arch},
            "runtime": {
                "node": {"major": 22, "range": ">=22 <23"},
                "codex": {"versionPin": "codex-cli 0.153.4"},
                "nativeModules": {
                    "argon2": {
                        "version": "0.44.0",
                        "prebuildDirectory": f"prebuilds/linux-{arch}",
                        "libc": ["glibc", "musl"],
                    }
                },
            },
            "configSchemaVersion": 1,
            "checksumAlgorithm": "sha256",
        }
        (self.root / "release.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
        )
        self._write_checksums()

    def _write_checksums(self) -> None:
        files = sorted(path for path in self.root.rglob("*") if path.is_file() and path.name != "SHA256SUMS")
        content = "".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  ./{path.relative_to(self.root).as_posix()}\n"
            for path in files
        )
        (self.root / "SHA256SUMS").write_text(content, encoding="utf-8", newline="\n")

    def _verify(self, arch: str = "linux-x64") -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        if os.name == "nt":
            environment["PYTHON_BIN"] = shell_path(Path(os.sys.executable))
        return subprocess.run(
            [self.bash, shell_path(SCRIPT), "--verify", shell_path(self.root), "--arch", arch],
            text=True,
            capture_output=True,
            check=False,
            env=environment,
        )

    def test_complete_inventory_verifies_without_root(self) -> None:
        result = self._verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified portable package", result.stdout)

    def test_same_host_instruction_installer_is_required(self) -> None:
        (self.root / "scripts/install-local-host-instructions.py").unlink()
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("package is missing scripts/install-local-host-instructions.py", result.stderr)

    def test_host_admin_migration_assets_are_required(self) -> None:
        for relative in (
            "scripts/migrate-runner-host-admin.sh",
            "infra/systemd/codex-web-ui-app-server-host-admin@.service",
        ):
            with self.subTest(relative=relative):
                self._write_fixture("x64")
                (self.root / relative).unlink()
                self._write_checksums()
                result = self._verify()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"package is missing {relative}", result.stderr)

    def test_tampered_payload_is_rejected(self) -> None:
        (self.root / "apps/server/dist/index.js").write_text("tampered\n", encoding="utf-8")
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)

    def test_unlisted_inventory_file_is_rejected(self) -> None:
        (self.root / "unexpected.txt").write_text("not inventoried\n", encoding="utf-8")
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inventory mismatch", result.stderr)

    def test_wrong_architecture_is_rejected(self) -> None:
        result = self._verify("linux-arm64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match requested", result.stderr)

    def test_codex_manifest_and_toolchain_pin_must_match(self) -> None:
        toolchain = self.root / "infra/toolchain.env"
        toolchain.write_text(
            toolchain.read_text(encoding="utf-8").replace(
                "CODEX_CLI_VERSION=0.153.4", "CODEX_CLI_VERSION=0.153.3"
            ),
            encoding="utf-8",
            newline="\n",
        )
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest and toolchain pins differ", result.stderr)

    def test_protocol_snapshot_and_codex_pin_must_match(self) -> None:
        protocol_path = self.root / "protocol/manifest.json"
        protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
        protocol["codexCliVersion"] = "0.153.3"
        protocol_path.write_text(
            json.dumps(protocol, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("protocol snapshot and Codex pins differ", result.stderr)

    def test_unknown_api_compatibility_is_rejected(self) -> None:
        manifest_path = self.root / "release.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["apiCompatibility"] = 2
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported release or config schema version", result.stderr)

    def test_forbidden_runtime_file_is_rejected_even_if_inventoried(self) -> None:
        (self.root / ".env").write_text("SECRET=value\n", encoding="utf-8")
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden sensitive/runtime file", result.stderr)

    def test_escaping_symlink_is_rejected(self) -> None:
        outside = Path(self.temporary.name) / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        link = self.root / "escape"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest(f"symlinks are unavailable: {error}")
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("broken or escaping symlink", result.stderr)


if __name__ == "__main__":
    unittest.main()
