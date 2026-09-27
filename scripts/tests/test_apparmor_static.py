from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class AppArmorStaticTest(unittest.TestCase):
    def test_profile_is_exact_path_and_userns_only(self) -> None:
        profile = (ROOT / "infra/apparmor/codex-web-ui.template").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            'profile codex-web-ui-codex "@@CODEX_BIN@@" flags=(unconfined)', profile
        )
        self.assertIn(
            'profile codex-web-ui-bwrap "@@BWRAP_BIN@@" flags=(unconfined)', profile
        )
        self.assertEqual(profile.count("  userns,"), 2)
        for forbidden in ("capability,", "network,", "mount,", "file,"):
            self.assertNotIn(forbidden, profile)

    def test_installer_validates_binaries_and_loads_without_global_weakening(self) -> None:
        installer = (ROOT / "scripts/install-apparmor.sh").read_text(encoding="utf-8")
        for expected in (
            "canonical_existing_file",
            "must be a native ELF executable",
            "must be owned by root",
            "must not be writable by group or other",
            'apparmor_parser -Q "$temporary"',
            'apparmor_parser -r "$profile_path"',
            'apparmor_parser -R "$profile_path"',
            "profile_path=/etc/apparmor.d/codex-web-ui",
            "the previous installed profile was restored",
        ):
            self.assertIn(expected, installer)
        for forbidden in (
            "kernel.apparmor_restrict_unprivileged_userns",
            "/proc/sys",
            "aa-disable",
            "systemctl disable apparmor",
        ):
            self.assertNotIn(forbidden, installer)


if __name__ == "__main__":
    unittest.main()
