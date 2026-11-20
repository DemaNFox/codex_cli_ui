import importlib.util
from io import StringIO
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("keyring", types.SimpleNamespace(get_password=lambda *_: None,
                                                set_password=lambda *_: None))
spec = importlib.util.spec_from_file_location("codex_web_remote",
                                              Path(__file__).with_name("codex_web_remote.py"))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteCliTests(unittest.TestCase):
    def test_configure_rejects_http_and_does_not_save_secret_in_config(self):
        with tempfile.TemporaryDirectory() as temp:
            secret = "cwx_" + "a" * 80
            with patch.object(remote, "config_path", return_value=Path(temp) / "config.json"), \
                 patch.object(remote.keyring, "set_password") as save, \
                 patch.object(remote.getpass, "getpass", return_value=secret):
                with patch("sys.stderr", new=StringIO()):
                    self.assertEqual(remote.main(["configure", "http://example.test"]), 1)
                self.assertEqual(remote.main(["configure", "https://example.test"]), 0)
                save.assert_called_once_with(remote.SERVICE, "https://example.test", secret)
                self.assertNotIn(secret, (Path(temp) / "config.json").read_text())

    def test_submit_reuses_explicit_request_id_and_uploads_once_per_slot(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "note.txt"
            file.write_text("hello")
            calls = []
            def send(_url, _token, method, route, payload=None, _content_type="application/json"):
                calls.append((method, route, payload))
                if route == "/api/remote-tasks":
                    return {"id": "task", "status": "accepted", "threadId": "thread"}
                return {"id": "task", "status": "queued"}
            parser_args = types.SimpleNamespace(file=[str(file)], request_id="fixed-request-id",
                project_id="project", text="do work", model=None, reasoning=None,
                permission=None, approval=None)
            with patch.object(remote, "credentials", return_value=("https://example.test", "secret")), \
                 patch.object(remote, "request", side_effect=send), \
                 patch("sys.stdout", new=StringIO()):
                remote.submit(parser_args)
            self.assertEqual([item[1] for item in calls], ["/api/remote-tasks",
                "/api/remote-tasks/task/attachments/0", "/api/remote-tasks/task/start"])
            self.assertEqual(calls[0][2]["requestId"], "fixed-request-id")
            self.assertEqual(calls[0][2]["attachments"][0]["size"], 5)

    def test_retry_of_already_queued_task_does_not_upload_again(self):
        args = types.SimpleNamespace(file=[], request_id="fixed-request-id",
            project_id="project", text="do work", model=None, reasoning=None,
            permission=None, approval=None)
        with patch.object(remote, "credentials", return_value=("https://example.test", "secret")), \
             patch.object(remote, "request", return_value={"id": "task", "status": "queued"}) as send, \
             patch("sys.stdout", new=StringIO()):
            remote.submit(args)
        self.assertEqual(send.call_count, 1)

    def test_rejects_unsafe_multipart_filename_before_request(self):
        args = types.SimpleNamespace(file=["unsafe"], request_id="fixed-request-id",
            project_id="project", text="do work", model=None, reasoning=None,
            permission=None, approval=None)
        with patch.object(remote, "credentials", return_value=("https://example.test", "secret")), \
             patch.object(remote, "Path") as path, patch.object(remote, "request") as send:
            file = path.return_value.expanduser.return_value.resolve.return_value
            file.name = 'bad"name.txt'
            file.is_file.return_value = True
            file.stat.return_value.st_size = 4
            with self.assertRaises(RuntimeError):
                remote.submit(args)
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
