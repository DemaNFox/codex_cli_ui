#!/usr/bin/env python3
"""Stage one repository-pinned Codex npm runtime from the fixed npm registry."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import platform
import re
import shutil
import tarfile
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

REGISTRY_ORIGIN = "https://registry.npmjs.org"
PACKAGE_NAME = "@openai/codex"
METADATA_LIMIT = 2 * 1024 * 1024
ARCHIVE_LIMIT = 256 * 1024 * 1024
MEMBER_LIMIT = 4096
EXPANDED_LIMIT = 512 * 1024 * 1024
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")
SHA512_RE = re.compile(r"[0-9a-f]{128}")


class StageError(RuntimeError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _read_bounded(response: Any, limit: int) -> bytes:
    declared = response.headers.get("Content-Length")
    if declared is not None:
        try:
            if int(declared) > limit:
                raise StageError("registry response exceeds the size limit")
        except ValueError as error:
            raise StageError("registry response has an invalid length") from error
    payload = response.read(limit + 1)
    if len(payload) > limit:
        raise StageError("registry response exceeds the size limit")
    return payload


def _fetch(url: str, limit: int) -> bytes:
    if not url.startswith(f"{REGISTRY_ORIGIN}/"):
        raise StageError("registry URL escaped the fixed npm origin")
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "codex-web-ui-updater/1"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=30) as response:
            if response.status != 200 or response.geturl() != url:
                raise StageError("registry response was not the requested fixed resource")
            return _read_bounded(response, limit)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise StageError("fixed npm registry request failed") from error


def _load_target(package_root: Path) -> dict[str, Any]:
    path = package_root / "infra/codex-update-target.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StageError("trusted runtime update target is unavailable or invalid") from error
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion", "package", "version", "tarballs", "protocolFiles"
    }:
        raise StageError("trusted runtime update target fields are invalid")
    version = value.get("version")
    tarballs = value.get("tarballs")
    if (
        value.get("schemaVersion") != 1
        or value.get("package") != PACKAGE_NAME
        or not isinstance(version, str)
        or not VERSION_RE.fullmatch(version)
        or not isinstance(tarballs, dict)
        or set(tarballs) != {"main", "linux-x64", "linux-arm64"}
    ):
        raise StageError("trusted runtime update target is invalid")
    for item in tarballs.values():
        if not isinstance(item, dict) or set(item) != {"sha512"} or not isinstance(item["sha512"], str) or not SHA512_RE.fullmatch(item["sha512"]):
            raise StageError("trusted Codex integrity pin is invalid")
    return value


def _metadata(version: str, suffix: str = "") -> tuple[str, str]:
    published_version = f"{version}{suffix}"
    metadata_url = f"{REGISTRY_ORIGIN}/@openai%2Fcodex/{published_version}"
    try:
        value = json.loads(_fetch(metadata_url, METADATA_LIMIT))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise StageError("npm package metadata is invalid") from error
    expected_tarball = f"{REGISTRY_ORIGIN}/@openai/codex/-/codex-{published_version}.tgz"
    if not isinstance(value, dict) or value.get("name") != PACKAGE_NAME or value.get("version") != published_version:
        raise StageError("npm package identity does not match the trusted Codex package")
    dist = value.get("dist")
    if not isinstance(dist, dict) or dist.get("tarball") != expected_tarball:
        raise StageError("npm package tarball URL is not the fixed Codex resource")
    integrity = dist.get("integrity")
    if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        raise StageError("npm package metadata lacks SHA-512 integrity")
    return expected_tarball, integrity


def _require_latest(version: str) -> None:
    try:
        value = json.loads(_fetch(f"{REGISTRY_ORIGIN}/@openai%2Fcodex/latest", METADATA_LIMIT))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise StageError("npm latest metadata is invalid") from error
    if not isinstance(value, dict) or value.get("name") != PACKAGE_NAME:
        raise StageError("npm latest package identity is invalid")
    if value.get("version") != version:
        raise StageError("npm latest is not the reviewed compatible target; a full app package is required")


def _verify_archive(payload: bytes, published_integrity: str, committed_hex: str) -> None:
    digest = hashlib.sha512(payload).digest()
    try:
        published = base64.b64decode(published_integrity.removeprefix("sha512-"), validate=True)
    except ValueError as error:
        raise StageError("published npm integrity is invalid") from error
    if digest != published:
        raise StageError("downloaded Codex archive does not match published integrity")
    if digest.hex() != committed_hex:
        raise StageError("published Codex archive does not match the reviewed integrity pin")


def _extract_archive(payload: bytes, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    expanded = 0
    try:
        archive = tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz")
    except tarfile.TarError as error:
        raise StageError("Codex archive is invalid") from error
    with archive:
        members = archive.getmembers()
        if len(members) > MEMBER_LIMIT:
            raise StageError("Codex archive contains too many entries")
        for member in members:
            relative = PurePosixPath(member.name)
            if not relative.parts or relative.parts[0] != "package" or any(part in {"", ".", ".."} for part in relative.parts):
                raise StageError("Codex archive contains an unsafe path")
            stripped = relative.parts[1:]
            if not stripped:
                continue
            target = destination.joinpath(*stripped)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o755)
                continue
            if not member.isfile():
                raise StageError("Codex archive contains a non-regular entry")
            expanded += member.size
            if member.size < 0 or expanded > EXPANDED_LIMIT:
                raise StageError("Codex archive expands beyond the size limit")
            source = archive.extractfile(member)
            if source is None:
                raise StageError("Codex archive entry cannot be read")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def stage(package_root: Path, output: Path, machine: str | None = None) -> dict[str, str]:
    if os.name == "posix" and os.geteuid() != 0:
        raise StageError("runtime staging must run as root")
    architecture = {"x86_64": "x64", "aarch64": "arm64"}.get(machine or platform.machine())
    if architecture is None:
        raise StageError("host architecture is unsupported")
    if output.is_symlink() or not output.is_dir() or any(output.iterdir()):
        raise StageError("runtime staging destination is not an empty real directory")
    if os.name == "posix" and output.stat().st_uid != 0:
        raise StageError("runtime staging destination is not root-owned")
    target = _load_target(package_root)
    version = target["version"]
    _require_latest(version)
    platform_suffix = f"-linux-{architecture}"
    main_url, main_integrity = _metadata(version)
    platform_url, platform_integrity = _metadata(version, platform_suffix)
    main = _fetch(main_url, ARCHIVE_LIMIT)
    platform_payload = _fetch(platform_url, ARCHIVE_LIMIT)
    _verify_archive(main, main_integrity, target["tarballs"]["main"]["sha512"])
    _verify_archive(
        platform_payload,
        platform_integrity,
        target["tarballs"][f"linux-{architecture}"]["sha512"],
    )
    try:
        main_dir = output / "lib/node_modules/@openai/codex"
        platform_dir = main_dir / f"node_modules/@openai/codex-linux-{architecture}"
        _extract_archive(main, main_dir)
        _extract_archive(platform_payload, platform_dir)
        bin_dir = output / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").symlink_to("../lib/node_modules/@openai/codex/bin/codex.js")
        output.chmod(0o755)
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise
    return {
        "version": version,
        "architecture": f"linux-{architecture}",
        "codexBin": str(main_dir / "bin/codex.js"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        result = stage(arguments.package_root.resolve(strict=True), arguments.output)
    except (OSError, StageError) as error:
        print(f"Codex runtime staging failed: {error}", file=os.sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
