#!/usr/bin/env python3
"""Build, verify and install a checksum-pinned Codex skill bundle.

Only explicitly required skill directories are copied. The tool never copies a
CODEX_HOME and never reads or modifies Codex authentication/configuration files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
from pathlib import Path, PurePosixPath

try:
    import pwd
except ImportError:  # pragma: no cover - verification/build remain portable on Windows
    pwd = None  # type: ignore[assignment]

NAME = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_FILES_PER_SKILL = 256
MAX_FILE_BYTES = 2 * 1024 * 1024
FORBIDDEN_NAMES = {
    ".codex",
    ".env",
    "auth.json",
    "config.toml",
    "credentials.json",
    "cookies.json",
    "history.jsonl",
    "sessions",
}


class BundleError(ValueError):
    pass


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BundleError(f"invalid JSON file: {path}") from error


def requirements(path: Path) -> tuple[str, ...]:
    value = load_json(path)
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "required_skills",
        "bundle_manifest",
        "install_subdirectory",
    }:
        raise BundleError("invalid requirements manifest shape")
    names = value["required_skills"]
    if value["schema_version"] != 1 or not isinstance(names, list) or not names:
        raise BundleError("invalid requirements manifest values")
    if value["bundle_manifest"] != "bundle.manifest.json" or value["install_subdirectory"] != "skills":
        raise BundleError("unsupported requirements manifest contract")
    if any(not isinstance(name, str) or not NAME.fullmatch(name) for name in names):
        raise BundleError("invalid required skill name")
    if len(set(names)) != len(names):
        raise BundleError("duplicate required skill")
    return tuple(names)


def safe_relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise BundleError("invalid bundle path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise BundleError("unsafe bundle path")
    if any(part in FORBIDDEN_NAMES for part in path.parts):
        raise BundleError("forbidden Codex state in skill bundle")
    return path


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(128 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def collect_skill(path: Path) -> list[dict[str, object]]:
    if not path.is_dir() or path.is_symlink() or not (path / "SKILL.md").is_file():
        raise BundleError(f"skill must be a real directory with SKILL.md: {path}")
    files: list[dict[str, object]] = []
    for root, directories, names in os.walk(path, followlinks=False):
        root_path = Path(root)
        for directory in directories:
            candidate = root_path / directory
            if candidate.is_symlink() or directory in FORBIDDEN_NAMES:
                raise BundleError(f"unsafe skill directory: {candidate}")
        for name in names:
            candidate = root_path / name
            relative = candidate.relative_to(path).as_posix()
            safe_relative(relative)
            info = candidate.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise BundleError(f"skill file must be a single-link regular file: {candidate}")
            if info.st_size > MAX_FILE_BYTES:
                raise BundleError(f"skill file exceeds size limit: {candidate}")
            files.append({"path": relative, "sha256": digest(candidate), "bytes": info.st_size})
    files.sort(key=lambda item: str(item["path"]))
    if not files or len(files) > MAX_FILES_PER_SKILL:
        raise BundleError("invalid skill file count")
    return files


def build(source_root: Path, destination: Path, required: tuple[str, ...]) -> None:
    source_root = source_root.resolve(strict=True)
    if not source_root.is_dir():
        raise BundleError("source root is not a directory")
    if destination.exists() and any(destination.iterdir()):
        raise BundleError("bundle destination must be absent or empty")
    destination.mkdir(parents=True, exist_ok=True)
    skills: list[dict[str, object]] = []
    for name in required:
        source = source_root / name
        files = collect_skill(source)
        target = destination / name
        target.mkdir(mode=0o755)
        for item in files:
            relative = safe_relative(str(item["path"]))
            output = target.joinpath(*relative.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source.joinpath(*relative.parts), output)
            output.chmod(0o755 if os.access(source.joinpath(*relative.parts), os.X_OK) else 0o644)
        skills.append({"name": name, "files": files})
    manifest = {"schema_version": 1, "skills": skills}
    (destination / "bundle.manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    verify(destination, required)


def verify(bundle: Path, required: tuple[str, ...]) -> dict[str, object]:
    bundle = bundle.resolve(strict=True)
    if not bundle.is_dir() or bundle.is_symlink():
        raise BundleError("bundle must be a real directory")
    value = load_json(bundle / "bundle.manifest.json")
    if not isinstance(value, dict) or set(value) != {"schema_version", "skills"} or value["schema_version"] != 1:
        raise BundleError("invalid bundle manifest shape")
    entries = value["skills"]
    if not isinstance(entries, list):
        raise BundleError("invalid bundle skill list")
    if [entry.get("name") if isinstance(entry, dict) else None for entry in entries] != list(required):
        raise BundleError("bundle does not exactly match required skill order")

    listed = {"bundle.manifest.json"}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"name", "files"}:
            raise BundleError("invalid skill manifest entry")
        name = entry["name"]
        files = entry["files"]
        if not isinstance(name, str) or not NAME.fullmatch(name) or not isinstance(files, list):
            raise BundleError("invalid skill manifest values")
        if not 1 <= len(files) <= MAX_FILES_PER_SKILL:
            raise BundleError("invalid skill manifest file count")
        for item in files:
            if not isinstance(item, dict) or set(item) != {"path", "sha256", "bytes"}:
                raise BundleError("invalid file manifest entry")
            relative = safe_relative(item["path"])
            checksum = item["sha256"]
            size = item["bytes"]
            if not isinstance(checksum, str) or not SHA256.fullmatch(checksum):
                raise BundleError("invalid file checksum")
            if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_FILE_BYTES:
                raise BundleError("invalid file size")
            path = bundle / name / Path(*relative.parts)
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise BundleError(f"unsafe bundled file: {path}")
            if info.st_size != size or digest(path) != checksum:
                raise BundleError(f"bundle checksum mismatch: {name}/{relative}")
            listed.add(f"{name}/{relative.as_posix()}")
        if "SKILL.md" not in {str(item["path"]) for item in files}:
            raise BundleError(f"skill has no manifested SKILL.md: {name}")

    actual: set[str] = set()
    for root, directories, names in os.walk(bundle, followlinks=False):
        root_path = Path(root)
        if any((root_path / directory).is_symlink() for directory in directories):
            raise BundleError("bundle contains symlink directory")
        for name in names:
            path = root_path / name
            if path.is_symlink():
                raise BundleError("bundle contains symlink file")
            actual.add(path.relative_to(bundle).as_posix())
    if actual != listed:
        raise BundleError("bundle contains missing or unmanifested files")
    return value


def contained(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def install(bundle: Path, codex_home: Path, user: str, required: tuple[str, ...]) -> None:
    if pwd is None:
        raise BundleError("skill installation requires a POSIX host")
    if os.geteuid() != 0:
        raise BundleError("skill installation must run as root")
    if user == "root" or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,30}", user):
        raise BundleError("invalid non-root service user")
    try:
        account = pwd.getpwnam(user)
    except KeyError as error:
        raise BundleError("service user does not exist") from error
    bundle = bundle.resolve(strict=True)
    codex_home = codex_home.resolve(strict=True)
    if not codex_home.is_dir() or codex_home.is_symlink():
        raise BundleError("CODEX_HOME must be a real directory")
    if contained(bundle, codex_home) or contained(codex_home, bundle):
        raise BundleError("bundle and CODEX_HOME must not overlap")
    verify(bundle, required)

    target = codex_home / "skills"
    target.mkdir(mode=0o700, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".codex-web-ui-skill-stage-", dir=codex_home))
    backup = codex_home / ".skill-backups" / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup.mkdir(parents=True, mode=0o700)
    moved: list[str] = []
    installed: list[str] = []
    try:
        for name in required:
            shutil.copytree(bundle / name, stage / name, symlinks=False)
        for name in required:
            current = target / name
            if current.exists() or current.is_symlink():
                if current.is_symlink() or not current.is_dir():
                    raise BundleError(f"existing skill target is unsafe: {current}")
                os.replace(current, backup / name)
                moved.append(name)
            os.replace(stage / name, current)
            installed.append(name)
    except Exception:
        for name in reversed(installed):
            current = target / name
            if current.exists():
                shutil.rmtree(current)
        for name in reversed(moved):
            if (backup / name).exists():
                os.replace(backup / name, target / name)
        raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    os.chown(backup, account.pw_uid, account.pw_gid)
    os.chown(target, account.pw_uid, account.pw_gid)
    for name in installed:
        installed_root = target / name
        for root, directories, files in os.walk(installed_root, followlinks=False):
            path = Path(root)
            os.chown(path, account.pw_uid, account.pw_gid)
            for child in directories + files:
                candidate = path / child
                if candidate.is_symlink():
                    raise BundleError("installed skill unexpectedly contains a symlink")
                os.chown(candidate, account.pw_uid, account.pw_gid)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument(
        "--requirements",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "skills" / "manifest.json",
    )
    commands = result.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--source-root", type=Path, required=True)
    build_parser.add_argument("--output", type=Path, required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--bundle", type=Path, required=True)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--bundle", type=Path, required=True)
    install_parser.add_argument("--codex-home", type=Path, required=True)
    install_parser.add_argument("--user", required=True)
    return result


def main() -> int:
    arguments = parser().parse_args()
    try:
        required = requirements(arguments.requirements)
        if arguments.command == "build":
            build(arguments.source_root, arguments.output, required)
        elif arguments.command == "verify":
            verify(arguments.bundle, required)
        else:
            install(arguments.bundle, arguments.codex_home, arguments.user, required)
    except (BundleError, OSError) as error:
        print(f"skill-bundle: {error}", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
