#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

die() {
  printf 'prepare-package: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/prepare-package.sh --output /absolute/new/directory --arch linux-x64|linux-arm64 [--archive none|tar.gz|tar.zst]
  scripts/prepare-package.sh --verify /absolute/package/directory [--arch linux-x64|linux-arm64]

Build mode runs the repository verification/build, assembles a self-contained
installer tree, writes release.json and SHA256SUMS, and optionally emits a
deterministic sibling archive. Verify mode needs no root privileges.
EOF
}

output=
verify_dir=
target_arch=
archive=none
python_bin=${PYTHON_BIN:-python3}

while (($#)); do
  case "$1" in
    --output) output=${2:?}; shift 2 ;;
    --verify) verify_dir=${2:?}; shift 2 ;;
    --arch) target_arch=${2:?}; shift 2 ;;
    --archive) archive=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "${target_arch:-}" in
  ''|linux-x64|linux-arm64) ;;
  *) die 'architecture must be linux-x64 or linux-arm64' ;;
esac

validate_tree() {
  local root=${1:?root required} expected_arch=${2:-}
  [[ -d $root && ! -L $root ]] || die "package directory does not exist or is a symlink: $root"
  root=$(cd -- "$root" && pwd -P)
  PACKAGE_ROOT=$root EXPECTED_ARCH=$expected_arch "$python_bin" - <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

root = Path(os.environ["PACKAGE_ROOT"])
expected = os.environ.get("EXPECTED_ARCH", "")
required = (
    "install.sh",
    "scripts/install-package.sh",
    "scripts/bootstrap-ubuntu.sh",
    "apps/server/dist/index.js",
    "apps/web/dist/index.html",
    "infra/toolchain.env",
    "infra/release-manifest.schema.json",
    "release.json",
    "SHA256SUMS",
)
for relative in required:
    if not (root / relative).is_file():
        raise SystemExit(f"prepare-package: package is missing {relative}")

for path in root.rglob("*"):
    relative = path.relative_to(root).as_posix()
    if path.is_symlink():
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(root)
        except (FileNotFoundError, RuntimeError, ValueError):
            raise SystemExit(f"prepare-package: broken or escaping symlink: {relative}")
        continue
    mode = path.stat().st_mode
    if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
        raise SystemExit(f"prepare-package: package contains special file: {relative}")
    name = path.name
    forbidden = (
        name == ".env"
        or (name.startswith(".env.") and name != ".env.example")
        or name in {".npmrc", ".yarnrc", ".git-credentials", "auth.json", "credentials.json", "cookies.json", "id_rsa", "id_ed25519"}
        or name.endswith((".sqlite", ".sqlite3", ".db"))
    )
    if forbidden:
        raise SystemExit(f"prepare-package: forbidden sensitive/runtime file: {relative}")

try:
    manifest = json.loads((root / "release.json").read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"prepare-package: invalid release.json: {error}")

top_keys = {
    "schemaVersion", "name", "version", "gitRevision", "target", "runtime",
    "configSchemaVersion", "checksumAlgorithm",
}
if not isinstance(manifest, dict) or set(manifest) != top_keys:
    raise SystemExit("prepare-package: release.json fields do not match schema version 1")
if manifest.get("name") != "codex-web-ui" or not isinstance(manifest.get("version"), str) or not manifest["version"]:
    raise SystemExit("prepare-package: invalid package identity")
arch = manifest.get("target", {}).get("architecture")
platform = manifest.get("target", {}).get("platform")
if manifest.get("target") != {"platform": "linux", "architecture": arch} or arch not in {"x64", "arm64"}:
    raise SystemExit("prepare-package: release.json has an unsupported target")
if expected and expected != f"linux-{arch}":
    raise SystemExit(f"prepare-package: package architecture linux-{arch} does not match requested {expected}")
if manifest.get("schemaVersion") != 1 or manifest.get("configSchemaVersion") != 1:
    raise SystemExit("prepare-package: unsupported release or config schema version")
if manifest.get("checksumAlgorithm") != "sha256":
    raise SystemExit("prepare-package: unsupported checksum algorithm")
runtime = manifest.get("runtime")
if not isinstance(runtime, dict) or set(runtime) != {"node", "codex", "nativeModules"}:
    raise SystemExit("prepare-package: runtime fields do not match schema version 1")
if runtime.get("node") != {"major": 22, "range": ">=22 <23"}:
    raise SystemExit("prepare-package: unsupported Node runtime contract")
toolchain = {}
for number, line in enumerate((root / "infra/toolchain.env").read_text(encoding="utf-8").splitlines(), 1):
    if not line or line.startswith("#"):
        continue
    match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=([^\s]+)", line)
    if not match or match.group(1) in toolchain:
        raise SystemExit(f"prepare-package: invalid toolchain pin on line {number}")
    toolchain[match.group(1)] = match.group(2)
if set(toolchain) != {"NODE_VERSION", "PNPM_VERSION", "CODEX_CLI_VERSION", "NODE_LINUX_X64_SHA256", "NODE_LINUX_ARM64_SHA256", "PNPM_TARBALL_SHA512", "CODEX_TARBALL_SHA512", "CODEX_LINUX_X64_TARBALL_SHA512", "CODEX_LINUX_ARM64_TARBALL_SHA512"}:
    raise SystemExit("prepare-package: toolchain pin fields do not match the supported contract")
if not re.fullmatch(r"22\.\d+\.\d+", toolchain["NODE_VERSION"]):
    raise SystemExit("prepare-package: invalid Node.js toolchain pin")
if not re.fullmatch(r"\d+\.\d+\.\d+", toolchain["PNPM_VERSION"]):
    raise SystemExit("prepare-package: invalid pnpm toolchain pin")
if any(not re.fullmatch(r"[0-9a-f]{64}", toolchain[name]) for name in ("NODE_LINUX_X64_SHA256", "NODE_LINUX_ARM64_SHA256")):
    raise SystemExit("prepare-package: invalid Node.js checksum pin")
if any(not re.fullmatch(r"[0-9a-f]{128}", toolchain[name]) for name in ("PNPM_TARBALL_SHA512", "CODEX_TARBALL_SHA512", "CODEX_LINUX_X64_TARBALL_SHA512", "CODEX_LINUX_ARM64_TARBALL_SHA512")):
    raise SystemExit("prepare-package: invalid npm tarball checksum pin")
revision = manifest.get("gitRevision", "")
if not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise SystemExit("prepare-package: invalid git revision")
codex = runtime.get("codex")
if not isinstance(codex, dict) or set(codex) != {"versionPin"}:
    raise SystemExit("prepare-package: Codex runtime fields do not match schema version 1")
codex_pin = codex.get("versionPin", "")
if not re.fullmatch(r"codex-cli \d+\.\d+\.\d+", codex_pin):
    raise SystemExit("prepare-package: invalid Codex version pin")
if codex_pin != f"codex-cli {toolchain['CODEX_CLI_VERSION']}":
    raise SystemExit("prepare-package: Codex manifest and toolchain pins differ")

native_modules = runtime.get("nativeModules")
if not isinstance(native_modules, dict) or set(native_modules) != {"argon2"}:
    raise SystemExit("prepare-package: native module fields do not match schema version 1")
argon2 = native_modules.get("argon2", {})
expected_prebuild = f"prebuilds/linux-{arch}"
if argon2 != {"version": "0.44.0", "prebuildDirectory": expected_prebuild, "libc": ["glibc", "musl"]}:
    raise SystemExit("prepare-package: Argon2 native runtime contract does not match target")
argon_root = root / "apps/server/node_modules/argon2/prebuilds"
expected_names = {"argon2.glibc.node", "argon2.musl.node"} if arch == "x64" else {"argon2.armv8.glibc.node", "argon2.armv8.musl.node"}
target = argon_root / f"linux-{arch}"
if not target.is_dir() or {p.name for p in target.iterdir() if p.is_file()} != expected_names:
    raise SystemExit("prepare-package: required Argon2 glibc/musl prebuilds are missing or incomplete")
other_dirs = {p.name for p in argon_root.iterdir() if p.is_dir()} - {f"linux-{arch}"}
if other_dirs:
    raise SystemExit(f"prepare-package: package contains Argon2 prebuilds for other targets: {sorted(other_dirs)}")

checksum_path = root / "SHA256SUMS"
lines = checksum_path.read_text(encoding="utf-8").splitlines()
entries = []
for line in lines:
    match = re.fullmatch(r"([0-9a-f]{64})  \./([^\r\n]+)", line)
    if not match:
        raise SystemExit("prepare-package: malformed SHA256SUMS")
    digest, relative = match.groups()
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts or "\\" in relative:
        raise SystemExit("prepare-package: unsafe SHA256SUMS path")
    entries.append((relative, digest))
names = [name for name, _ in entries]
if names != sorted(names) or len(names) != len(set(names)):
    raise SystemExit("prepare-package: SHA256SUMS inventory is not unique and sorted")
actual = sorted(
    path.relative_to(root).as_posix()
    for path in root.rglob("*")
    if path.is_file() and not path.is_symlink() and path.name != "SHA256SUMS"
)
if names != actual:
    missing = sorted(set(actual) - set(names))
    stale = sorted(set(names) - set(actual))
    raise SystemExit(f"prepare-package: SHA256SUMS inventory mismatch (missing={missing}, stale={stale})")
for relative, expected_digest in entries:
    digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
    if digest != expected_digest:
        raise SystemExit(f"prepare-package: checksum mismatch: {relative}")
PY
}

if [[ -n $verify_dir ]]; then
  [[ -z $output ]] || die '--verify and --output are mutually exclusive'
  [[ $archive == none ]] || die '--archive is available only in build mode'
  command -v "$python_bin" >/dev/null 2>&1 || die 'python3 is required'
  validate_tree "$verify_dir" "$target_arch"
  printf 'Verified portable package: %s\n' "$verify_dir"
  exit 0
fi

[[ -n $output ]] || die '--output is required in build mode'
[[ -n $target_arch ]] || die '--arch is required in build mode'
[[ $(uname -s) == Linux ]] || die 'package build mode requires Linux so pnpm dependency links remain portable'
[[ $output = /* ]] || die 'output must be absolute'
[[ ! -e $output ]] || die 'output already exists'
case "$archive" in none|tar.gz|tar.zst) ;; *) die 'archive must be none, tar.gz or tar.zst' ;; esac
for command in git pnpm tar; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done
command -v "$python_bin" >/dev/null 2>&1 || die 'python3 is required'
[[ $archive != tar.zst ]] || command -v zstd >/dev/null 2>&1 || die 'zstd is required for tar.zst output'
[[ $archive != tar.gz ]] || command -v gzip >/dev/null 2>&1 || die 'gzip is required for tar.gz output'

cd "$REPO_ROOT"
[[ -z $(git status --porcelain=v1 --untracked-files=all) ]] || \
  die 'the repository must be completely clean so the package provenance matches its Git revision'

revision=$(git rev-parse --verify HEAD)
source_epoch=$(git show -s --format=%ct HEAD)
version=$(node -p "require('./package.json').version")
codex_pin=$("$python_bin" - <<'PY'
from pathlib import Path
import re
text = Path("infra/env/codex-web-ui.env.example").read_text(encoding="utf-8")
match = re.search(r'^CODEX_WEB_CODEX_VERSION_PIN="([^"]+)"$', text, re.MULTILINE)
if not match:
    raise SystemExit("prepare-package: Codex version pin is missing from environment contract")
print(match.group(1))
PY
)
arch=${target_arch#linux-}
temporary=$(mktemp -d "${output}.tmp.XXXXXX")
release_stage="$temporary/release"
package_stage="$temporary/package"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

"$SCRIPT_DIR/prepare-release.sh" --output "$release_stage"
mkdir -p "$package_stage"
cp -a -- "$release_stage/apps" "$package_stage/apps"

tracked_roots=(infra scripts skills)
git cat-file -e HEAD:install.sh 2>/dev/null && tracked_roots+=(install.sh)
git archive --format=tar HEAD -- "${tracked_roots[@]}" | tar -xf - -C "$package_stage"
[[ -f $package_stage/install.sh ]] || die 'committed root install.sh is required for a self-contained package'
[[ -f $package_stage/scripts/install-package.sh ]] || die 'committed scripts/install-package.sh is required for a self-contained package'

argon_root="$package_stage/apps/server/node_modules/argon2/prebuilds"
[[ -d $argon_root/linux-x64 && -d $argon_root/linux-arm64 ]] || die 'server deployment is missing supported Argon2 Linux prebuilds'
find "$argon_root" -mindepth 1 -maxdepth 1 -type d ! -name "$target_arch" -exec rm -rf -- {} +

PACKAGE_ROOT=$package_stage PACKAGE_VERSION=$version GIT_REVISION=$revision TARGET_ARCH=$arch CODEX_PIN=$codex_pin "$python_bin" - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["PACKAGE_ROOT"])
arch = os.environ["TARGET_ARCH"]
manifest = {
    "schemaVersion": 1,
    "name": "codex-web-ui",
    "version": os.environ["PACKAGE_VERSION"],
    "gitRevision": os.environ["GIT_REVISION"],
    "target": {"platform": "linux", "architecture": arch},
    "runtime": {
        "node": {"major": 22, "range": ">=22 <23"},
        "codex": {"versionPin": os.environ["CODEX_PIN"]},
        "nativeModules": {
            "argon2": {
                "version": "0.44.0",
                "prebuildDirectory": f"prebuilds/linux-{arch}",
                "libc": ["glibc", "musl"],
            }
        },
    },
    "configSchemaVersion": 1,
    "checksumAlgorithm": "sha256",
}
(root / "release.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
PY

PACKAGE_ROOT=$package_stage "$python_bin" - <<'PY'
import hashlib
import os
from pathlib import Path

root = Path(os.environ["PACKAGE_ROOT"])
files = sorted(
    (
        path for path in root.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != "SHA256SUMS"
    ),
    key=lambda path: path.relative_to(root).as_posix(),
)
with (root / "SHA256SUMS").open("w", encoding="utf-8", newline="\n") as output:
    for path in files:
        relative = path.relative_to(root).as_posix()
        output.write(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  ./{relative}\n")
PY

validate_tree "$package_stage" "$target_arch"
mv -- "$package_stage" "$output"

case "$archive" in
  tar.gz)
    tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner -cf - -C "$(dirname -- "$output")" "$(basename -- "$output")" | gzip -n >"${output}.tar.gz"
    ;;
  tar.zst)
    tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner -cf - -C "$(dirname -- "$output")" "$(basename -- "$output")" | zstd -q -T1 -19 -o "${output}.tar.zst"
    ;;
esac
printf 'Prepared portable package: %s\n' "$output"
