from __future__ import annotations

import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/install-local-host-instructions.py"
SPEC = importlib.util.spec_from_file_location("local_host_instructions", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ManagedBlockTest(unittest.TestCase):
    def test_adds_block_without_changing_existing_content(self) -> None:
        original = "# Personal instructions\n\nKeep this exact text.\n"
        updated = MODULE.update_managed_block(original)
        self.assertTrue(updated.startswith(original))
        self.assertEqual(updated.count(MODULE.BEGIN_MARKER), 1)
        self.assertIn("Never use SSH to localhost", updated)
        self.assertIn("different remote host", updated)

    def test_replaces_only_existing_managed_block_and_is_idempotent(self) -> None:
        original = (
            "before\n\n"
            + MODULE.BEGIN_MARKER
            + "\nold managed wording\n"
            + MODULE.END_MARKER
            + "\n\nafter\n"
        )
        updated = MODULE.update_managed_block(original)
        self.assertEqual(updated, MODULE.update_managed_block(updated))
        self.assertTrue(updated.startswith("before\n\n"))
        self.assertTrue(updated.endswith("\n\nafter\n"))
        self.assertNotIn("old managed wording", updated)

    def test_requires_project_relative_links_for_created_deliverables(self) -> None:
        updated = MODULE.update_managed_block("# Personal\n\nKeep me.\n")

        self.assertIn("project-relative Markdown links", updated)
        self.assertIn("If you create a\nrequested archive, link the archive too", updated)
        self.assertIn("Do not link arbitrary host files", updated)
        self.assertIn("verify that every\nlinked deliverable still exists", updated)
        self.assertIn("instead of emitting a broken link", updated)
        self.assertTrue(updated.startswith("# Personal\n\nKeep me.\n"))

    def test_rejects_malformed_or_duplicate_markers(self) -> None:
        for value in (
            MODULE.BEGIN_MARKER,
            MODULE.END_MARKER,
            f"{MODULE.MANAGED_BLOCK}\n{MODULE.MANAGED_BLOCK}",
        ):
            with self.subTest(value=value):
                with self.assertRaises(MODULE.InstallError):
                    MODULE.update_managed_block(value)


@unittest.skipUnless(os.name == "posix", "secure filesystem integration requires POSIX")
class InstallerFilesystemTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name) / "codex-home"
        self.home.mkdir(mode=0o700)
        import pwd

        self.user = pwd.getpwuid(os.getuid()).pw_name

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_preserves_content_owner_and_enforces_private_mode(self) -> None:
        agents = self.home / "AGENTS.md"
        agents.write_text("# Mine\n", encoding="utf-8")
        os.chmod(agents, 0o644)
        before = agents.stat()

        MODULE.install(self.home, self.user)
        after_first = agents.read_text(encoding="utf-8")
        MODULE.install(self.home, self.user)
        after_second = agents.read_text(encoding="utf-8")

        after = agents.stat()
        lock = (self.home / ".codex-web-ui-instructions.lock").stat()
        self.assertEqual(after_first, after_second)
        self.assertTrue(after_first.startswith("# Mine\n"))
        self.assertEqual(after.st_uid, before.st_uid)
        self.assertEqual(after.st_gid, before.st_gid)
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o600)
        self.assertEqual(lock.st_uid, os.getuid())
        self.assertEqual(stat.S_IMODE(lock.st_mode), 0o600)

    def test_rejects_symlink_target_without_touching_victim(self) -> None:
        victim = Path(self.temporary.name) / "victim"
        victim.write_text("secret\n", encoding="utf-8")
        (self.home / "AGENTS.md").symlink_to(victim)
        with self.assertRaises(MODULE.InstallError):
            MODULE.install(self.home, self.user)
        self.assertEqual(victim.read_text(encoding="utf-8"), "secret\n")

    def test_rejects_codex_home_reached_through_symlink(self) -> None:
        linked_home = Path(self.temporary.name) / "linked-home"
        linked_home.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(MODULE.InstallError):
            MODULE.install(linked_home, self.user)
        self.assertFalse((self.home / "AGENTS.md").exists())


if __name__ == "__main__":
    unittest.main()
