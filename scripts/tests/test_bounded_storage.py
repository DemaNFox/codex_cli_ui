from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/install-bounded-storage.sh"


def working_bash() -> str | None:
    candidates: list[Path] = []
    discovered = shutil.which("bash")
    if discovered:
        candidates.append(Path(discovered))
    git = shutil.which("git")
    if git:
        git_root = Path(git).resolve().parent.parent
        candidates.extend((git_root / "bin/bash.exe", git_root / "usr/bin/bash.exe"))
    for candidate in candidates:
        try:
            subprocess.run(
                [str(candidate), "--version"],
                check=True,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError):
            continue
        return str(candidate)
    return None


class BoundedStorageInstallerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.source = SCRIPT.read_text(encoding="utf-8")

    def test_installer_requires_explicit_hard_byte_and_inode_bounds(self) -> None:
        for expected in (
            "--size-bytes",
            "--inode-count",
            "fallocate --length",
            'mkfs.ext4 -F -q -N "$inode_count"',
            'actual_bytes -le $size_bytes',
            'actual_inodes -le $inode_count',
        ):
            self.assertIn(expected, self.source)

    def test_installer_uses_root_owned_ext4_and_persistent_fixed_mounts(self) -> None:
        for expected in (
            "require_root",
            "chown root:root \"$IMAGE_PATH\"",
            "chmod 0600 \"$IMAGE_PATH\"",
            "mount -o loop,nodev,nosuid",
            "/var/lib/codex-web-ui",
            "/opt/codex-web-ui/releases",
            "$IMAGE_PATH $VOLUME_ROOT ext4 loop,nodev,nosuid 0 2",
            "none bind,nodev,nosuid,x-systemd.requires-mounts-for=",
            "x-systemd.requires-mounts-for=$VOLUME_ROOT",
            'findmnt --verify --tab-file "$FSTAB"',
        ):
            self.assertIn(expected, self.source)

    def test_all_project_roots_are_explicitly_matched_and_dynamically_bounded(self) -> None:
        for expected in (
            '--project-root) project_roots+=("${2:?}")',
            "at least one --project-root is required",
            "CODEX_WEB_PROJECT_ROOTS=",
            "explicit project roots do not match configured project roots",
            "configured project root was not explicitly bounded",
            "configured project roots overlap",
            "explicit project root is not configured",
            "project root overlaps protected storage",
            "project root contains unsupported persistent-mount characters",
            'VOLUME_DIRS+=("projects/$index")',
            '"$VOLUME_ROOT" "$index" "${canonical_roots[$index]}"',
        ):
            self.assertIn(expected, self.source)
        self.assertNotIn("/srv/codex-projects none bind", self.source)

    def test_codex_home_is_copied_into_bounded_state_and_config_is_switched(self) -> None:
        for expected in (
            "BOUNDED_CODEX_HOME=/var/lib/codex-web-ui/codex-home",
            "project root overlaps CODEX_HOME",
            "configured CODEX_HOME contains a symlink",
            "configured CODEX_HOME contains unsupported systemd path characters",
            '"$configured_codex_home/" "$VOLUME_ROOT/state/codex-home/"',
            "copied CODEX_HOME failed checksum verification",
            'CODEX_HOME=" codex_home',
            'write_path_drop_in "$service_user" "$BOUNDED_CODEX_HOME"',
            "InaccessiblePaths=%s",
            "codex-web-ui.env.pre-bounded-",
            "chmod 0600 \"$config_backup\"",
        ):
            self.assertIn(expected, self.source)

    def test_migration_is_fail_closed_and_keeps_recoverable_sources(self) -> None:
        for expected in (
            "trap rollback EXIT",
            "systemctl stop \"$guard_timer\" \"$service_unit\"",
            "rsync -aHAX --numeric-ids --one-file-system",
            "--delete --checksum",
            ".pre-bounded-${backup_suffix}",
            "bounded storage migration failed; restoring original paths",
            "systemctl start \"$service_unit\"",
            "service did not become healthy after bounded storage migration",
            "Original data remains in rollback backups",
        ):
            self.assertIn(expected, self.source)
        self.assertNotIn("rm -rf", self.source)

    def test_help_and_dry_run_are_non_mutating(self) -> None:
        bash = working_bash()
        if bash is None:
            self.skipTest("bash is unavailable")
        help_result = subprocess.run(
            [bash, "scripts/install-bounded-storage.sh", "--help"],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        self.assertIn("--size-bytes BYTES", help_result.stdout)
        self.assertIn("--project-root DIR", help_result.stdout)
        dry_run = subprocess.run(
            [
                bash,
                "scripts/install-bounded-storage.sh",
                "--size-bytes",
                "1073741824",
                "--inode-count",
                "4096",
                "--project-root",
                "/srv/codex-projects",
                "--dry-run",
            ],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        self.assertIn("no changes made", dry_run.stdout)
        self.assertIn("1073741824 bytes", dry_run.stdout)
        self.assertIn("4096 inodes requested", dry_run.stdout)
        self.assertIn("/srv/codex-projects", dry_run.stdout)

    def test_script_has_valid_bash_syntax(self) -> None:
        bash = working_bash()
        if bash is None:
            self.skipTest("bash is unavailable")
        subprocess.run(
            [bash, "-n", "scripts/install-bounded-storage.sh"], check=True, cwd=ROOT
        )


if __name__ == "__main__":
    unittest.main()
