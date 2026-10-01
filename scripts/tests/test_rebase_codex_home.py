import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "rebase-codex-home.py"


class RebaseCodexHomeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.profile = Path(self.temporary.name) / "profile"
        self.profile.mkdir()
        self.database = self.profile / "state_5.sqlite"
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)"
            )
            connection.commit()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def add_thread(self, thread_id: str, rollout_path: Path) -> None:
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "INSERT INTO threads(id, rollout_path) VALUES(?, ?)",
                (thread_id, rollout_path.as_posix()),
            )
            connection.commit()

    def run_script(
        self, target: str, *source_homes: str
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(SCRIPT),
            "--profile-root",
            str(self.profile),
            "--target-home",
            target,
        ]
        for source_home in source_homes:
            command.extend(("--source-home", source_home))
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )

    def stored_path(self, thread_id: str) -> str:
        with closing(sqlite3.connect(self.database)) as connection:
            return connection.execute(
                "SELECT rollout_path FROM threads WHERE id=?", (thread_id,)
            ).fetchone()[0]

    def test_rebases_copied_session_to_final_home(self) -> None:
        rollout = self.profile / "sessions" / "2026" / "10" / "01" / "rollout.jsonl"
        rollout.parent.mkdir(parents=True)
        rollout.write_text("{}\n", encoding="utf-8")
        self.add_thread("thread-1", Path("/old/home") / rollout.relative_to(self.profile))
        target = "/root/.codex-web-ui"

        result = self.run_script(target, "/old/home")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Rebased 1", result.stdout)
        self.assertEqual(
            self.stored_path("thread-1"),
            f"{target}/{rollout.relative_to(self.profile).as_posix()}",
        )

    def test_preserves_an_already_rebased_session(self) -> None:
        rollout = self.profile / "archived_sessions" / "rollout.jsonl"
        rollout.parent.mkdir()
        rollout.write_text("{}\n", encoding="utf-8")
        target = "/target/home"
        stored = Path(target) / rollout.relative_to(self.profile)
        self.add_thread("thread-1", stored)

        result = self.run_script(target)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Rebased 0", result.stdout)
        self.assertEqual(self.stored_path("thread-1"), stored.as_posix())

    def test_rejects_a_stale_path_without_a_copied_rollout(self) -> None:
        original = Path("/old/home/sessions/missing.jsonl")
        self.add_thread("thread-1", original)

        result = self.run_script("/root/.codex-web-ui", "/old/home")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.stored_path("thread-1"), original.as_posix())

    def test_rejects_a_missing_rollout_already_under_the_target(self) -> None:
        original = Path("/root/.codex-web-ui/sessions/missing.jsonl")
        self.add_thread("thread-1", original)

        result = self.run_script("/root/.codex-web-ui")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.stored_path("thread-1"), original.as_posix())

    def test_rolls_back_all_rows_when_one_rollout_is_invalid(self) -> None:
        valid = self.profile / "sessions" / "valid.jsonl"
        valid.parent.mkdir()
        valid.write_text("{}\n", encoding="utf-8")
        first = Path("/old/home/sessions/valid.jsonl")
        second = Path("/untrusted/sessions/missing.jsonl")
        self.add_thread("thread-1", first)
        self.add_thread("thread-2", second)

        result = self.run_script("/root/.codex-web-ui", "/old/home")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.stored_path("thread-1"), first.as_posix())
        self.assertEqual(self.stored_path("thread-2"), second.as_posix())

    def test_allows_a_fresh_profile_before_the_first_thread(self) -> None:
        self.database.unlink()

        result = self.run_script("/root/.codex-web-ui")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Rebased 0", result.stdout)


if __name__ == "__main__":
    unittest.main()
