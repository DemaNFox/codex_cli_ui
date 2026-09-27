#!/usr/bin/env bash

set -euo pipefail

config=${CODEX_WEB_CONFIG:-/etc/codex-web-ui/codex-web-ui.env}
python_args=("$config")
if [[ ${1:-} == --check-admin-hash ]]; then
  python_args=("$@")
fi
exec python3 - "${python_args[@]}" <<'PY'
from __future__ import annotations

import base64
import binascii
import os
import pathlib
import re
import shlex
import shutil
import stat
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def validate_admin_hash(encoded_hash: str) -> None:
    hash_match = re.fullmatch(
        r"\$argon2id\$v=([0-9]+)\$m=([0-9]+),t=([0-9]+),p=([0-9]+)"
        r"\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)",
        encoded_hash,
    )
    if not hash_match:
        fail("admin password hash must be a valid Argon2id PHC string")
    version, memory, iterations, parallelism = map(int, hash_match.group(1, 2, 3, 4))
    if version != 19:
        fail("admin password hash must use Argon2 version 19")
    if not 65536 <= memory <= 262144:
        fail("admin password hash memory cost must be between 65536 and 262144 KiB")
    if not 3 <= iterations <= 6:
        fail("admin password hash time cost must be between 3 and 6")
    if not 1 <= parallelism <= 4:
        fail("admin password hash parallelism must be between 1 and 4")

    def decoded_length(value: str, label: str) -> int:
        try:
            decoded = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
        except (ValueError, binascii.Error):
            fail(f"admin password hash has invalid {label} encoding")
        return len(decoded)

    if not 16 <= decoded_length(hash_match.group(5), "salt") <= 64:
        fail("admin password hash salt must contain 16-64 bytes")
    if not 32 <= decoded_length(hash_match.group(6), "digest") <= 64:
        fail("admin password hash digest must contain 32-64 bytes")


if sys.argv[1:2] == ["--check-admin-hash"]:
    if len(sys.argv) != 3:
        fail("--check-admin-hash requires exactly one PHC string")
    validate_admin_hash(sys.argv[2])
    raise SystemExit(0)


values: dict[str, str] = {}
path = pathlib.Path(sys.argv[1])
if os.access(path, os.R_OK):
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        fail(f"configuration is not readable UTF-8: {path}")
    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        key = key.strip()
        raw = raw.strip()
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            fail(f"invalid or duplicate configuration assignment on line {number}")
        if raw.startswith(("'", '"')):
            try:
                parsed = shlex.split(raw, posix=True)
            except ValueError:
                fail(f"invalid quoted value on line {number}")
            if len(parsed) != 1:
                fail(f"configuration value must be one literal on line {number}")
            raw = parsed[0]
        values[key] = raw
else:
    # systemd loads the root-owned EnvironmentFile before changing to User=%i.
    # The unprivileged ExecStartPre intentionally cannot read the file itself.
    values = {key: value for key, value in os.environ.items() if key.startswith("CODEX_")}

required = (
    "CODEX_WEB_HOST",
    "CODEX_WEB_PORT",
    "CODEX_WEB_PUBLIC_ORIGIN",
    "CODEX_WEB_DATABASE_PATH",
    "CODEX_WEB_PROJECT_ROOTS",
    "CODEX_WEB_ATTACHMENT_STORAGE_PATH",
    "CODEX_WEB_APP_SERVER_SOCKET",
    "CODEX_WEB_CODEX_VERSION_PIN",
    "CODEX_WEB_ADMIN_USERNAME",
    "CODEX_WEB_ADMIN_PASSWORD_HASH",
    "CODEX_WEB_SESSION_SECRET",
    "CODEX_WEB_MIN_FREE_BYTES",
    "CODEX_WEB_MAX_DATABASE_BYTES",
    "CODEX_WEB_MAX_RELEASES",
)
for name in required:
    if not values.get(name):
        fail(f"required setting is empty: {name}")

if values["CODEX_WEB_HOST"] not in {"127.0.0.1", "::1"}:
    fail("CODEX_WEB_HOST must remain loopback-only")
try:
    port = int(values["CODEX_WEB_PORT"])
except ValueError:
    fail("invalid CODEX_WEB_PORT")
if not 1024 <= port <= 65535:
    fail("invalid CODEX_WEB_PORT")
if not re.fullmatch(r"https://[^/]+", values["CODEX_WEB_PUBLIC_ORIGIN"]):
    fail("CODEX_WEB_PUBLIC_ORIGIN must be one HTTPS origin without a path")
if values.get("CODEX_WEB_COOKIE_SECURE", "true") != "true":
    fail("CODEX_WEB_COOKIE_SECURE must remain true")
if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", values["CODEX_WEB_ADMIN_USERNAME"]):
    fail("invalid admin username")
validate_admin_hash(values["CODEX_WEB_ADMIN_PASSWORD_HASH"])
if not re.fullmatch(r"[A-Za-z0-9_-]{43,256}", values["CODEX_WEB_SESSION_SECRET"]):
    fail("session secret must be 43-256 base64url characters")

for name in ("CODEX_WEB_DATABASE_PATH", "CODEX_WEB_ATTACHMENT_STORAGE_PATH", "CODEX_WEB_APP_SERVER_SOCKET"):
    if not pathlib.Path(values[name]).is_absolute():
        fail(f"{name} must be absolute")
if values["CODEX_WEB_APP_SERVER_SOCKET"] != "/run/codex-web-ui/app-server.sock":
    fail("CODEX_WEB_APP_SERVER_SOCKET must use the protected systemd socket")


def positive_integer(name: str) -> int:
    raw = values[name]
    if not re.fullmatch(r"[1-9][0-9]*", raw):
        fail(f"{name} must be a positive integer")
    return int(raw)


minimum_free = positive_integer("CODEX_WEB_MIN_FREE_BYTES")
maximum_database = positive_integer("CODEX_WEB_MAX_DATABASE_BYTES")
maximum_releases = positive_integer("CODEX_WEB_MAX_RELEASES")
if minimum_free < 1024**3:
    fail("CODEX_WEB_MIN_FREE_BYTES must be at least 1 GiB")
if not 2 <= maximum_releases <= 50:
    fail("CODEX_WEB_MAX_RELEASES must be between 2 and 50")
database = pathlib.Path(values["CODEX_WEB_DATABASE_PATH"])
database_parent = database.parent
while not database_parent.exists():
    parent = database_parent.parent
    if parent == database_parent:
        fail("database path has no existing parent")
    database_parent = parent
if database_parent.is_symlink() or not database_parent.is_dir():
    fail("database parent must resolve through a real directory")
if shutil.disk_usage(database_parent).free < minimum_free:
    fail("available storage is below CODEX_WEB_MIN_FREE_BYTES")
if database.exists() or database.is_symlink():
    database_info = database.lstat()
    if database.is_symlink() or not stat.S_ISREG(database_info.st_mode):
        fail("database path must be a regular non-symlink file")
    if database_info.st_size > maximum_database:
        fail("database exceeds CODEX_WEB_MAX_DATABASE_BYTES")
roots = values["CODEX_WEB_PROJECT_ROOTS"].split(",")
if not roots or any(not root for root in roots):
    fail("at least one project root is required")
for root_value in roots:
    root = pathlib.Path(root_value)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        fail(f"project root must be an existing absolute real directory: {root}")
PY
