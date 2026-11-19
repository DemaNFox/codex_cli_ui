from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("protocol_compat", ROOT / "scripts/verify-codex-protocol.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProtocolCompatTest(unittest.TestCase):
    def test_required_requests_track_the_web_adapter(self) -> None:
        source = (ROOT / "apps/server/src/app-server.ts").read_text(encoding="utf-8")
        allowed = source.split("export const ALLOWED_REQUESTS = new Set([", 1)[1].split("]);", 1)[0]
        methods = set(re.findall(r"'([^']+)'", allowed))
        self.assertEqual(MODULE.REQUIRED_REQUESTS, methods | {"initialize"})

    def test_additive_unknown_methods_do_not_block_latest_codex(self) -> None:
        MODULE.verify(ROOT / "protocol/0.167.2", ROOT / "protocol/0.170.0")

    def test_extra_generated_split_schema_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory)
            for name in MODULE.AGGREGATES:
                (generated / name).write_bytes((ROOT / "protocol/0.170.0" / name).read_bytes())
            (generated / "new_optional_method.json").write_text("{}", encoding="utf-8")
            MODULE.verify(ROOT / "protocol/0.170.0", generated)

    def test_changed_required_request_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory)
            for name in MODULE.AGGREGATES:
                document = json.loads((ROOT / "protocol/0.170.0" / name).read_text(encoding="utf-8"))
                requests = document["definitions"]["ClientRequest"]["oneOf"]
                branch = next(item for item in requests if item["properties"]["method"]["enum"] == ["turn/start"])
                branch["required"].append("newMandatoryField")
                (generated / name).write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.IncompatibleProtocol, "turn/start"):
                MODULE.verify(ROOT / "protocol/0.170.0", generated)

    def test_removed_existing_notification_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory)
            for name in MODULE.AGGREGATES:
                document = json.loads((ROOT / "protocol/0.170.0" / name).read_text(encoding="utf-8"))
                document["definitions"]["ServerNotification"]["oneOf"].pop()
                (generated / name).write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.IncompatibleProtocol, "notification changed"):
                MODULE.verify(ROOT / "protocol/0.170.0", generated)


if __name__ == "__main__":
    unittest.main()
