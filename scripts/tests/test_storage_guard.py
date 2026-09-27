from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("storage_guard", ROOT / "scripts/storage-guard.py")
assert SPEC and SPEC.loader
STORAGE_GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STORAGE_GUARD)


class StorageGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / "data" / "codex.sqlite3"
        self.database.parent.mkdir()
        self.releases = self.root / "releases"
        self.releases.mkdir()
        self.values = {
            "CODEX_WEB_DATABASE_PATH": str(self.database.resolve()),
            "CODEX_WEB_MIN_FREE_BYTES": str(1024**3),
            "CODEX_WEB_MAX_DATABASE_BYTES": "1024",
            "CODEX_WEB_MAX_RELEASES": "2",
        }

    def test_accepts_storage_within_configured_soft_bounds(self) -> None:
        self.database.write_bytes(b"ok")
        (self.releases / "one").mkdir()
        STORAGE_GUARD.check_storage(
            self.values, release_root=self.releases, check_releases=True
        )

    def test_rejects_database_over_bound(self) -> None:
        self.database.write_bytes(b"too large")
        self.values["CODEX_WEB_MAX_DATABASE_BYTES"] = "1"
        with self.assertRaisesRegex(STORAGE_GUARD.GuardError, "database exceeds"):
            STORAGE_GUARD.check_storage(self.values, release_root=self.releases)

    def test_rejects_free_space_below_floor(self) -> None:
        total = shutil.disk_usage(self.database.parent).total
        self.values["CODEX_WEB_MIN_FREE_BYTES"] = str(total + 1)
        with self.assertRaisesRegex(STORAGE_GUARD.GuardError, "available storage"):
            STORAGE_GUARD.check_storage(self.values, release_root=self.releases)

    def test_rejects_projected_release_over_retention_limit(self) -> None:
        (self.releases / "one").mkdir()
        (self.releases / "two").mkdir()
        with self.assertRaisesRegex(STORAGE_GUARD.GuardError, "retention limit"):
            STORAGE_GUARD.check_storage(
                self.values,
                release_root=self.releases,
                additional_releases=1,
                check_releases=True,
            )


if __name__ == "__main__":
    unittest.main()
