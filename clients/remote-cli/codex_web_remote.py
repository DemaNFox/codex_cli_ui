"""Small HTTPS client for the server's scoped remote-task API."""

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid
import webbrowser

import keyring

SERVICE = "codex-web-remote"


def config_path():
    base = Path(os.environ.get("APPDATA") or Path.home() / ".config")
    return base / "codex-web-remote" / "config.json"


def save_config(url):
    path = config_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps({"url": url}) + "\n", encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)


def credentials():
    url = json.loads(config_path().read_text(encoding="utf-8"))["url"]
    token = keyring.get_password(SERVICE, url)
    if not token:
        raise RuntimeError("Нет сохранённого ключа. Выполните configure.")
    return url, token


def request(url, token, method, route, payload=None, content_type="application/json"):
    body = None if payload is None else (json.dumps(payload).encode() if content_type == "application/json" else payload)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = content_type
    try:
        with urlopen(Request(url + route, data=body, headers=headers, method=method), timeout=60) as response:
            if response.status == 204:
                return None
            return json.load(response)["data"]
    except HTTPError as exc:
        try:
            details = json.load(exc)
            message = details.get("error", {}).get("code", str(exc))
        except (ValueError, AttributeError):
            message = str(exc)
        raise RuntimeError(f"HTTP {exc.code}: {message}") from exc


def submit(args):
    url, token = credentials()
    files = [Path(item).expanduser().resolve(strict=True) for item in args.file]
    manifests = []
    for file in files:
        if (not file.is_file() or not 0 < file.stat().st_size <= 20 * 1024 * 1024 or
                len(file.name) > 180 or any(character in file.name for character in '"\r\n\\')):
            raise RuntimeError(f"Неподдерживаемый файл: {file}")
        manifests.append({"name": file.name, "size": file.stat().st_size,
                          "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    request_id = args.request_id or str(uuid.uuid4())
    text = args.text if args.text is not None else sys.stdin.read()
    payload = {"requestId": request_id, "projectId": args.project_id,
               "text": text, "attachments": manifests}
    for arg, field in (("model", "model"), ("reasoning", "reasoningEffort"),
                       ("permission", "permissionPreset"), ("approval", "approvalPolicy")):
        value = getattr(args, arg)
        if value:
            payload[field] = value
    print(f"requestId: {request_id}", flush=True)
    task = request(url, token, "POST", "/api/remote-tasks", payload)
    print(json.dumps(task, ensure_ascii=False, indent=2), flush=True)
    if task["status"] != "accepted":
        return
    for slot, file in enumerate(files):
        boundary = "codexremote" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file.name}\"\r\n"
                "Content-Type: application/octet-stream\r\n\r\n").encode() + file.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        request(url, token, "POST", f"/api/remote-tasks/{task['id']}/attachments/{slot}", body,
                f"multipart/form-data; boundary={boundary}")
    if files:
        task = request(url, token, "POST", f"/api/remote-tasks/{task['id']}/start", {})
        print(json.dumps(task, ensure_ascii=False, indent=2))


def watch(args):
    url, token = credentials()
    cursor = args.cursor
    while True:
        state = request(url, token, "GET", f"/api/remote-tasks/{args.id}")
        if state["status"] in ("completed", "failed", "cancelled"):
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return
        if not state.get("threadId"):
            time.sleep(2)
            continue
        headers = {"Authorization": f"Bearer {token}", "Accept": "text/event-stream",
                   "Last-Event-ID": str(cursor)}
        try:
            with urlopen(Request(url + f"/api/remote-tasks/{args.id}/events", headers=headers), timeout=90) as stream:
                data = []
                for raw in stream:
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if line.startswith("id:"):
                        cursor = int(line[3:].strip())
                    elif line.startswith("data:"):
                        data.append(line[5:].strip())
                    elif not line and data:
                        print("\n".join(data), flush=True)
                        data = []
                        state = request(url, token, "GET", f"/api/remote-tasks/{args.id}")
                        if state["status"] in ("completed", "failed", "cancelled"):
                            print(json.dumps(state, ensure_ascii=False, indent=2))
                            return
        except HTTPError as exc:
            raise RuntimeError(f"Поток событий недоступен: HTTP {exc.code}") from exc
        except (URLError, TimeoutError, OSError):
            time.sleep(2)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    configure = commands.add_parser("configure", help="Store server URL and key in OS keyring")
    configure.add_argument("url")
    send = commands.add_parser("submit")
    send.add_argument("--project-id", required=True)
    send.add_argument("--text")
    send.add_argument("--file", action="append", default=[])
    send.add_argument("--request-id")
    send.add_argument("--model")
    send.add_argument("--reasoning")
    send.add_argument("--permission", choices=["read-only", "workspace-write", "full-access"])
    send.add_argument("--approval", choices=["untrusted", "on-request", "never"])
    commands.add_parser("projects")
    for name in ("status", "open", "watch", "cancel"):
        command = commands.add_parser(name)
        command.add_argument("id")
        if name == "watch":
            command.add_argument("--cursor", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        if args.command == "configure":
            parsed = urlparse(args.url)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
                    parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
                raise RuntimeError("Укажите корневой HTTPS-адрес сервера без пути и учётных данных")
            url = args.url.rstrip("/")
            token = getpass.getpass("Ключ внешнего клиента: ").strip()
            if not token.startswith("cwx_") or len(token) < 75:
                raise RuntimeError("Неверный формат ключа внешнего клиента")
            keyring.set_password(SERVICE, url, token)
            save_config(url)
            print("Подключение сохранено в системном хранилище секретов")
        elif args.command == "submit":
            submit(args)
        elif args.command == "watch":
            watch(args)
        elif args.command == "projects":
            url, token = credentials()
            print(json.dumps(request(url, token, "GET", "/api/remote-projects"), ensure_ascii=False, indent=2))
        else:
            url, token = credentials()
            if args.command == "cancel":
                result = request(url, token, "POST", f"/api/remote-tasks/{args.id}/cancel", {})
            else:
                result = request(url, token, "GET", f"/api/remote-tasks/{args.id}")
            if args.command == "open":
                if not result["chatUrl"]:
                    raise RuntimeError("Чат ещё не создан; проверьте статус позже")
                webbrowser.open(result["chatUrl"])
            else:
                print(json.dumps(result, ensure_ascii=False, indent=2))
    except (RuntimeError, URLError, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
