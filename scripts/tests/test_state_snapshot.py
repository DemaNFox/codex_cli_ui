import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "state-snapshot.py"
SPEC = importlib.util.spec_from_file_location("state_snapshot", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class StateSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.web = self.root / "web"
        self.codex = self.root / "codex"
        self.web.mkdir()
        self.codex.mkdir()
        (self.web / "codex-web-ui.sqlite3").write_bytes(b"sqlite-state")
        (self.web / "attachments").mkdir()
        (self.web / "attachments" / "image.png").write_bytes(b"image")
        (self.codex / "sessions").mkdir()
        (self.codex / "sessions" / "a.jsonl").write_bytes(b"native-turn")
        (self.codex / "auth.json").write_bytes(b"secret")
        self.archive = self.root / "snapshot"

    def test_backup_verify_and_restore_both_stores(self):
        module.snapshot(self.web, self.codex, self.archive)
        module.verify(self.archive)
        recovered_web = self.root / "recovered-web"
        recovered_codex = self.root / "recovered-codex"
        recovered_web.mkdir()
        recovered_codex.mkdir()
        module.restore(self.archive, recovered_web, recovered_codex)
        self.assertEqual(module.inventory(self.web), module.inventory(recovered_web))
        self.assertEqual(module.inventory(self.codex), module.inventory(recovered_codex))

    def test_modified_snapshot_and_missing_store_are_rejected(self):
        module.snapshot(self.web, self.codex, self.archive)
        (self.archive / "codex-home" / "auth.json").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "integrity"):
            module.verify(self.archive)
        (self.archive / "codex-home" / "auth.json").unlink()
        with self.assertRaisesRegex(ValueError, "integrity"):
            module.verify(self.archive)

    def test_restore_refuses_nonempty_destination_and_symlink_source(self):
        module.snapshot(self.web, self.codex, self.archive)
        destination = self.root / "destination"
        destination.mkdir()
        (destination / "old").write_text("must not overwrite")
        with self.assertRaisesRegex(ValueError, "not empty"):
            module.restore(self.archive, destination, self.root / "other")
        (self.codex / "escape").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "link"):
            module.snapshot(self.web, self.codex, self.root / "other-snapshot")

    def test_codex_ephemeral_links_are_excluded(self):
        (self.codex / "tmp").mkdir()
        (self.codex / "tmp" / "codex-linux-sandbox").symlink_to(self.root)
        module.snapshot(self.web, self.codex, self.archive)
        self.assertFalse((self.archive / "codex-home" / "tmp").exists())
        self.assertTrue((self.archive / "codex-home" / "sessions" / "a.jsonl").exists())

    def test_active_unit_blocks_state_operation(self):
        with patch.object(module.sys, "platform", "linux"), patch.object(
            module.subprocess, "run"
        ) as run:
            run.return_value.stdout = "codex-web-ui@api.service loaded active running\n"
            with self.assertRaisesRegex(ValueError, "Stop"):
                module.require_offline()


if __name__ == "__main__":
    unittest.main()
