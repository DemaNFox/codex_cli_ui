#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

install_nginx=false

die() {
  printf 'codex-web-ui bootstrap: %s\n' "$*" >&2
  exit 1
}

load_toolchain_pins() {
  local file=${1:?pin file required} line key value required
  local -A seen=()
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]]+)$ ]] || die 'invalid toolchain pin file'
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case "$key" in
      NODE_VERSION|PNPM_VERSION|CODEX_CLI_VERSION|NODE_LINUX_X64_SHA256|NODE_LINUX_ARM64_SHA256|PNPM_TARBALL_SHA512|CODEX_TARBALL_SHA512|CODEX_LINUX_X64_TARBALL_SHA512|CODEX_LINUX_ARM64_TARBALL_SHA512) ;;
      *) die "unsupported toolchain pin: $key" ;;
    esac
    [[ -z ${seen[$key]+x} ]] || die "duplicate toolchain pin: $key"
    seen[$key]=1
    printf -v "$key" '%s' "$value"
  done <"$file"
  for required in NODE_VERSION PNPM_VERSION CODEX_CLI_VERSION NODE_LINUX_X64_SHA256 NODE_LINUX_ARM64_SHA256 PNPM_TARBALL_SHA512 CODEX_TARBALL_SHA512 CODEX_LINUX_X64_TARBALL_SHA512 CODEX_LINUX_ARM64_TARBALL_SHA512; do
    [[ -n ${seen[$required]+x} ]] || die "missing toolchain pin: $required"
  done
}

load_toolchain_pins "$REPO_ROOT/infra/toolchain.env"

usage() {
  cat <<'EOF'
Usage: sudo scripts/bootstrap-ubuntu.sh [--install-nginx]

Installs the pinned system toolchain required by Codex Web UI on Ubuntu
22.04/24.04: base utilities, Node.js 22, pnpm, and @openai/codex. Node archives
are downloaded from nodejs.org and checked against repository-pinned SHA-256
digests before extraction. This command never authenticates Codex or reads its
credential store.
EOF
}

while (($#)); do
  case "$1" in
    --install-nginx) install_nginx=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die 'this command must run as root'
[[ $NODE_VERSION =~ ^22\.[0-9]+\.[0-9]+$ ]] || die 'invalid Node.js pin'
[[ $PNPM_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid pnpm pin'
[[ $CODEX_CLI_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid Codex CLI pin'
[[ $NODE_LINUX_X64_SHA256 =~ ^[0-9a-f]{64}$ && $NODE_LINUX_ARM64_SHA256 =~ ^[0-9a-f]{64}$ ]] || die 'invalid Node.js checksum pin'
for digest in "$PNPM_TARBALL_SHA512" "$CODEX_TARBALL_SHA512" "$CODEX_LINUX_X64_TARBALL_SHA512" "$CODEX_LINUX_ARM64_TARBALL_SHA512"; do
  [[ $digest =~ ^[0-9a-f]{128}$ ]] || die 'invalid npm tarball checksum pin'
done

[[ -f /etc/os-release ]] || die '/etc/os-release is missing'
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} =~ ^(22\.04|24\.04)$ ]] || die 'supported OS is Ubuntu 22.04 or 24.04'

packages=(ca-certificates curl git python3 xz-utils)
$install_nginx && packages+=(nginx)
missing_packages=()
for package_name in "${packages[@]}"; do
  dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -qx 'install ok installed' || missing_packages+=("$package_name")
done
if ((${#missing_packages[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi

for command_name in curl sha256sum sha512sum tar xz; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is unavailable after package installation: $command_name"
done

case "$(uname -m)" in
  x86_64) node_arch=x64; node_sha=$NODE_LINUX_X64_SHA256; codex_platform_sha=$CODEX_LINUX_X64_TARBALL_SHA512 ;;
  aarch64|arm64) node_arch=arm64; node_sha=$NODE_LINUX_ARM64_SHA256; codex_platform_sha=$CODEX_LINUX_ARM64_TARBALL_SHA512 ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac
node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
runtime_root=/opt/codex-web-ui/runtime
node_root=$runtime_root
node_dir="$node_root/node-v${NODE_VERSION}-linux-${node_arch}"

if [[ -e /opt/codex-web-ui ]]; then
  [[ -d /opt/codex-web-ui && ! -L /opt/codex-web-ui && $(stat -c '%u' /opt/codex-web-ui) == 0 ]] || \
    die 'managed application root must be a root-owned real directory'
  application_root_mode=$(stat -c '%a' /opt/codex-web-ui)
  (( (8#$application_root_mode & 8#022) == 0 )) || \
    die 'managed application root must not be group/world writable'
else
  install -d -m 0755 -o root -g root /opt/codex-web-ui
fi
if [[ -e $node_root ]]; then
  [[ -d $node_root && ! -L $node_root && $(stat -c '%u' "$node_root") == 0 ]] || die 'managed Node.js root must be a root-owned real directory'
  node_root_mode=$(stat -c '%a' "$node_root")
  (( (8#$node_root_mode & 8#022) == 0 )) || die 'managed Node.js root must not be group/world writable'
else
  install -d -m 0755 -o root -g root "$node_root"
fi

if [[ ! -x $node_dir/bin/node || $($node_dir/bin/node --version 2>/dev/null || true) != "v$NODE_VERSION" ]]; then
  [[ ! -e $node_dir ]] || die "managed Node.js directory exists but does not match v$NODE_VERSION: $node_dir"
  temporary=$(mktemp -d "$node_root/.bootstrap.XXXXXX")
  case "$temporary" in "$node_root"/.bootstrap.*) ;; *) die 'temporary bootstrap path escaped the managed root' ;; esac
  cleanup() { rm -rf -- "$temporary"; }
  trap cleanup EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$temporary/$node_archive" \
    "https://nodejs.org/download/release/v${NODE_VERSION}/${node_archive}"
  printf '%s  %s\n' "$node_sha" "$temporary/$node_archive" | sha256sum --check --strict --status || die 'Node.js archive checksum mismatch'
  tar -xJf "$temporary/$node_archive" -C "$temporary"
  extracted="$temporary/node-v${NODE_VERSION}-linux-${node_arch}"
  [[ -x $extracted/bin/node && $($extracted/bin/node --version) == "v$NODE_VERSION" ]] || die 'downloaded Node.js runtime is incomplete'
  chown -R root:root "$extracted"
  chmod -R go-w "$extracted"
  mv -- "$extracted" "$node_dir"
  trap - EXIT
  cleanup
fi

install_managed_link() {
  local target=${1:?target required} link=${2:?link required}
  if [[ -e $link && ! -L $link ]]; then
    die "refusing to replace unmanaged file: $link"
  fi
  ln -sfn -- "$target" "$link"
}

install -d -m 0755 -o root -g root /usr/local/bin
install_managed_link "$node_dir/bin/node" /usr/local/bin/node
install_managed_link "$node_dir/bin/npm" /usr/local/bin/npm
install_managed_link "$node_dir/bin/npx" /usr/local/bin/npx

export PATH="/usr/local/bin:$PATH"
[[ $(node --version 2>/dev/null || true) == "v$NODE_VERSION" ]] || die 'managed Node.js activation failed'
toolchain_dir="$runtime_root/toolchain-pnpm-${PNPM_VERSION}-codex-${CODEX_CLI_VERSION}-${node_arch}"
if [[ ! -x $toolchain_dir/bin/pnpm || ! -x $toolchain_dir/bin/codex ]]; then
  [[ ! -e $toolchain_dir ]] || die "managed npm toolchain directory is incomplete: $toolchain_dir"
  toolchain_stage=$(mktemp -d "$runtime_root/.toolchain.XXXXXX")
  case "$toolchain_stage" in "$runtime_root"/.toolchain.*) ;; *) die 'temporary toolchain path escaped the managed runtime root' ;; esac
  cleanup_toolchain() { rm -rf -- "$toolchain_stage"; }
  trap cleanup_toolchain EXIT
  pnpm_archive="$toolchain_stage/pnpm.tgz"
  codex_archive="$toolchain_stage/codex.tgz"
  platform_archive="$toolchain_stage/codex-linux-${node_arch}.tgz"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$pnpm_archive" "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$codex_archive" "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}.tgz"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$platform_archive" "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-${node_arch}.tgz"
  printf '%s  %s\n' "$PNPM_TARBALL_SHA512" "$pnpm_archive" | sha512sum --check --strict --status || die 'pnpm tarball checksum mismatch'
  printf '%s  %s\n' "$CODEX_TARBALL_SHA512" "$codex_archive" | sha512sum --check --strict --status || die 'Codex CLI tarball checksum mismatch'
  printf '%s  %s\n' "$codex_platform_sha" "$platform_archive" | sha512sum --check --strict --status || die 'Codex native tarball checksum mismatch'
  install -d -m 0755 "$toolchain_stage/bin" "$toolchain_stage/lib/node_modules/pnpm" \
    "$toolchain_stage/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-${node_arch}"
  tar -xzf "$pnpm_archive" --strip-components=1 --no-same-owner --no-same-permissions -C "$toolchain_stage/lib/node_modules/pnpm"
  tar -xzf "$codex_archive" --strip-components=1 --no-same-owner --no-same-permissions -C "$toolchain_stage/lib/node_modules/@openai/codex"
  tar -xzf "$platform_archive" --strip-components=1 --no-same-owner --no-same-permissions -C "$toolchain_stage/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-${node_arch}"
  ln -s ../lib/node_modules/pnpm/bin/pnpm.cjs "$toolchain_stage/bin/pnpm"
  ln -s ../lib/node_modules/@openai/codex/bin/codex.js "$toolchain_stage/bin/codex"
  chmod 0755 "$toolchain_stage/lib/node_modules/pnpm/bin/pnpm.cjs" "$toolchain_stage/lib/node_modules/@openai/codex/bin/codex.js"
  rm -f -- "$pnpm_archive" "$codex_archive" "$platform_archive"
  [[ $($toolchain_stage/bin/pnpm --version) == "$PNPM_VERSION" ]] || die 'staged pnpm version verification failed'
  [[ $($toolchain_stage/bin/codex --version) == "codex-cli $CODEX_CLI_VERSION" ]] || die 'staged Codex CLI version verification failed'
  chown -R root:root "$toolchain_stage"
  chmod -R go-w "$toolchain_stage"
  mv -- "$toolchain_stage" "$toolchain_dir"
  trap - EXIT
  cleanup_toolchain
fi
install_managed_link "$toolchain_dir/bin/pnpm" /usr/local/bin/pnpm
if [[ -e /usr/local/bin/codex && ! -L /usr/local/bin/codex ]]; then
  printf 'Preserving existing unmanaged /usr/local/bin/codex; the service will use %s directly.\n' "$toolchain_dir/bin/codex"
else
  install_managed_link "$toolchain_dir/bin/codex" /usr/local/bin/codex
fi

[[ $(pnpm --version) == "$PNPM_VERSION" ]] || die 'pnpm version verification failed'
[[ $($toolchain_dir/bin/codex --version) == "codex-cli $CODEX_CLI_VERSION" ]] || die 'Codex CLI version verification failed'
codex_real=$(realpath -e -- "$toolchain_dir/bin/codex")
[[ -f $codex_real && -x $codex_real && $(stat -c '%u' "$codex_real") == 0 ]] || die 'Codex CLI must resolve to a root-owned executable'
codex_mode=$(stat -c '%a' "$codex_real")
(( (8#$codex_mode & 8#022) == 0 )) || die 'Codex CLI must not be group/world writable'

printf 'Installed toolchain: Node.js %s, pnpm %s, codex-cli %s\n' "$NODE_VERSION" "$PNPM_VERSION" "$CODEX_CLI_VERSION"
