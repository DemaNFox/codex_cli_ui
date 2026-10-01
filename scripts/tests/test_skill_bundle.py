from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "skill-bundle.py"
SPEC = importlib.util.spec_from_file_location("skill_bundle", MODULE_PATH)
assert SPEC and SPEC.loader
skill_bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(skill_bundle)


class SkillBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.requirements = self.root / "requirements.json"
        self.required = ("first-skill", "second-skill")
        self.requirements.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "required_skills": list(self.required),
                    "bundle_manifest": "bundle.manifest.json",
                    "install_subdirectory": "skills",
                }
            ),
            encoding="utf-8",
        )
        self.sources = self.root / "sources"
        for name in self.required:
            skill = self.sources / name
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_build_and_verify_exact_required_bundle(self) -> None:
        output = self.root / "bundle"
        required = skill_bundle.requirements(self.requirements)
        skill_bundle.build(self.sources, output, required)
        result = skill_bundle.verify(output, required)
        self.assertEqual([item["name"] for item in result["skills"]], list(self.required))

    def test_checksum_tampering_is_rejected(self) -> None:
        output = self.root / "bundle"
        skill_bundle.build(self.sources, output, self.required)
        (output / "first-skill" / "SKILL.md").write_text("tampered\n", encoding="utf-8")
        with self.assertRaisesRegex(skill_bundle.BundleError, "checksum mismatch"):
            skill_bundle.verify(output, self.required)

    def test_unmanifested_file_is_rejected(self) -> None:
        output = self.root / "bundle"
        skill_bundle.build(self.sources, output, self.required)
        (output / "first-skill" / "extra.txt").write_text("extra\n", encoding="utf-8")
        with self.assertRaisesRegex(skill_bundle.BundleError, "unmanifested"):
            skill_bundle.verify(output, self.required)

    def test_codex_state_name_is_rejected(self) -> None:
        (self.sources / "first-skill" / "auth.json").write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(skill_bundle.BundleError, "forbidden"):
            skill_bundle.build(self.sources, self.root / "bundle", self.required)

    def test_repository_vendored_bundle_matches_pinned_manifest(self) -> None:
        repository = Path(__file__).resolve().parents[2]
        required = skill_bundle.requirements(repository / "skills" / "manifest.json")
        result = skill_bundle.verify(repository / "skills" / "bundle", required)
        self.assertEqual([item["name"] for item in result["skills"]], list(required))
        react_entrypoint = (
            repository / "skills" / "bundle" / "react-best-practices" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("name: vercel-react-best-practices", react_entrypoint)
        self.assertIn("react-best-practices", required)

    def test_root_is_a_valid_host_admin_service_user(self) -> None:
        skill_bundle.validate_service_user("root")
        with self.assertRaisesRegex(skill_bundle.BundleError, "invalid service user"):
            skill_bundle.validate_service_user("bad,user")


if __name__ == "__main__":
    unittest.main()
