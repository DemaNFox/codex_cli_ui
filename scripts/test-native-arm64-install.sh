#!/usr/bin/env bash
set -euo pipefail

[[ $(uname -m) == aarch64 ]] || { echo 'Native arm64 host required' >&2; exit 1; }
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'Disposable GitHub runner required' >&2; exit 1; }

# The hosted runner has a regular, unmanaged Node binary in /usr/local/bin.
# Move only those preinstalled binaries in this disposable VM so the installer
# sees the same clean toolchain paths as a fresh Ubuntu Server.
runner_toolchain_backup=$(mktemp -d /tmp/codex-web-ui-runner-toolchain.XXXXXX)
for name in node npm npx pnpm; do
  path=/usr/local/bin/$name
  if [[ -e $path && ! -L $path ]]; then
    sudo mv -- "$path" "$runner_toolchain_backup/$name"
  fi
done

sudo bash scripts/bootstrap-ubuntu.sh --build-tools-only
package_root=$(mktemp -d /tmp/codex-web-ui-arm64-package.XXXXXX)
scripts/prepare-package.sh --output "$package_root/release" --arch linux-arm64
sudo bash "$package_root/release/scripts/bootstrap-ubuntu.sh"
sudo apt-get update -qq
sudo apt-get install -y -qq expect >/dev/null
sudo useradd -m -s /bin/bash codex
sudo mkdir -p /srv/codex-projects
sudo chown codex:codex /srv/codex-projects

cat > "$package_root/install.expect" <<EOF
set timeout 1800
spawn sudo bash $package_root/release/scripts/install-package.sh --package $package_root/release --runner-user codex --public-origin https://codex.test --external-proxy --no-start
expect "Administrator username:"
send "testadmin\\r"
expect "Administrator password:"
send "TestOnlyPassword-2026!\\r"
expect "Repeat administrator password:"
send "TestOnlyPassword-2026!\\r"
expect eof
set result [wait]
exit [lindex \$result 3]
EOF
expect "$package_root/install.expect" > "$package_root/install.log" 2>&1 || {
  tail -n 30 "$package_root/install.log" >&2
  exit 1
}

sudo systemctl enable --now \
  codex-web-ui-resource-broker.socket \
  codex-web-ui-project-path-broker.socket \
  codex-web-ui-app-server.socket \
  codex-web-ui-codex-update-broker.socket \
  codex-web-ui-storage-guard@api.timer \
  codex-web-ui@api.service
sudo /usr/local/libexec/codex-web-ui-resource-broker --initialize
"$package_root/release/scripts/health-check.sh" --service-user api --timeout 45

sudo bash "$package_root/release/scripts/install-package.sh" \
  --package "$package_root/release" --upgrade --runner-user codex \
  --public-origin https://codex.test --external-proxy
"$package_root/release/scripts/health-check.sh" --service-user api --timeout 45
before=$(readlink -f /opt/codex-web-ui/current)

cp -a "$package_root/release" "$package_root/broken"
python3 - "$package_root/broken" <<'PY'
from pathlib import Path
import hashlib
import sys

root = Path(sys.argv[1])
app = root / 'apps/server/dist/index.js'
with app.open('ab') as stream:
    stream.write(b'\nthis is invalid JavaScript @@@\n')
new_hash = hashlib.sha256(app.read_bytes()).hexdigest()
sums = root / 'SHA256SUMS'
lines = sums.read_text().splitlines()
lines = [f'{new_hash}  ./apps/server/dist/index.js' if line.endswith('  ./apps/server/dist/index.js') else line for line in lines]
sums.write_text('\n'.join(lines) + '\n')
PY
"$package_root/broken/scripts/prepare-package.sh" --verify "$package_root/broken" --arch linux-arm64
if sudo bash "$package_root/broken/scripts/install-package.sh" \
  --package "$package_root/broken" --upgrade --runner-user codex \
  --public-origin https://codex.test --external-proxy > "$package_root/broken.log" 2>&1; then
  echo 'Broken release unexpectedly activated' >&2
  exit 1
fi
after=$(readlink -f /opt/codex-web-ui/current)
[[ $before == "$after" ]] || { echo 'Rollback did not restore the previous release' >&2; exit 1; }
"$package_root/release/scripts/health-check.sh" --service-user api --timeout 45
echo "Native arm64 install, upgrade, and rollback passed for $(git rev-parse HEAD)"
