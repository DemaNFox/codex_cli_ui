# Ubuntu deployment assets

These files install the standalone Codex Web UI as an unprivileged, loopback-only
Node.js service behind an HTTPS Nginx edge. They do not deploy automatically and
they never copy `CODEX_HOME`, Codex authentication, project `.env` files, product
runtime secrets, Docker access or deployment credentials.

## Portable installation

The normal path is `./install.sh` from a clean Git checkout. It builds an
architecture-specific checksummed package without root, then invokes the root
installer only for system integration. It first installs the repository-pinned
Node.js, pnpm and Codex CLI toolchain beneath `/opt/codex-web-ui/runtime` and
exposes stable launchers in `/usr/local/bin`. The runner defaults to the `sudo`
caller. Its existing Codex login is reused without copying credentials; otherwise
the installer starts Codex device login for that user on the controlling terminal:

```sh
./install.sh \
  --public-origin https://codex.example.com \
  --external-proxy \
  --project-root /srv/codex-projects
```

For a dedicated Nginx edge, replace `--external-proxy` with existing
`--tls-cert` and `--tls-key` paths. The private key must be root-owned `0600`
and the certificate must cover the origin hostname. Installations fail closed
on an unsupported OS/architecture, artifact or package checksum mismatch,
failed Codex login, unsafe Codex ownership, or public plaintext configuration.
Downloaded artifacts use exact versions and committed SHA-256/SHA-512 digests;
there is no `curl | sh`, floating `latest` tag or root-owned Codex credential
store. Use `--upgrade` explicitly to preserve the existing admin config
while switching to a new immutable release.
If `/usr/local/bin/codex` is already a regular host-managed executable, bootstrap
preserves it; the service still uses the exact managed CLI path from its protected
runner configuration.

The API runs as `codex-web-ui-api`; Codex runs as the selected existing user.
They communicate only through `/run/codex-web-ui/app-server.sock`. Web secrets
and runner settings are separate root-owned `0600` files.

Release assembly uses pnpm's isolated deploy graph and loads every direct
production dependency, including Argon2, before accepting the output. This
prevents a flattened but incomplete transitive dependency graph from reaching
activation.

## Assumptions

- Ubuntu 22.04/24.04 with systemd, internet access and a sudo-capable non-root
  operator. The bootstrap installs missing `ca-certificates`, `curl`, `git`,
  `python3`, `xz-utils` and (for the bundled edge) Nginx through APT. It installs
  exact toolchain versions from `infra/toolchain.env`; startup fails unless
  `codex --version` exactly matches `CODEX_WEB_CODEX_VERSION_PIN` (initially
  `codex-cli 0.153.4`). `binutils` remains an additional prerequisite only for
  the optional scoped AppArmor profile.
- The chosen service user already exists and is not root. The current server may
  use `ai-chat-agent` with `CODEX_HOME=/opt/ai-chat-agents/home/.codex`.
- First-time authentication requires an interactive controlling terminal. The
  device code is displayed by Codex directly and must not be shared. For an
  unattended host, authenticate beforehand as the runner with
  `sudo -u USER -H /usr/local/bin/codex login --device-auth`; never log in as root.
- A prepared release contains `apps/server/dist/index.js` and
  `apps/web/dist/index.html`. Nginx serves the web build directly and proxies
  only `/api/` to the loopback backend. Release directories are immutable and
  retained under `/opt/codex-web-ui/releases`; `current` is an atomic symlink.
- Each allowed project root and `CODEX_HOME` is an existing canonical directory.
  They cannot overlap. The generated systemd drop-in grants write access only to
  those paths and application state.
- `/api/health` returns a 2xx response on the configured loopback listener.
- `/etc/codex-web-ui/codex-web-ui.env` is a regular, non-symlink file owned by
  `root:root` with mode `0600`. The systemd manager reads `EnvironmentFile=`
  before switching to `User=%i`; the service user must not be able to read the
  file directly.
- The safe event journal is capped at 1,000 events per thread and 32 KiB per
  event. Codex rollout history remains authoritative; the bounded journal is
  the reconnect/UI projection and prevents one browser replay from exhausting
  the service cgroup.
- Nginx accepts attachment requests up to 21 MiB so the API can enforce the
  exact 20 MiB file limit after multipart overhead. The body timeout is 60
  seconds. Keep both values aligned with the application contract rather than
  raising the edge limit independently.

## CPU, RAM and process safety

The API and every app-server runner are members of `codex-web-ui-workload.slice`, so their CPU, memory and
task use is enforced as one aggregate rather than as independent per-process allowances. The installer starts
the slice and reconciles its persisted policy before the Web service starts. Automatic mode is the default: it
uses the smallest live host/ancestor-cgroup capacity, then reserves one CPU core and
`max(15% of RAM, 1 GiB)` for the operating system. It does not mean capacity beyond the machine.

Only `codex-web-ui-api` can connect to the mode-0600 resource socket. The socket-activated root broker accepts
no command, path, systemd unit or property name from the client; it can change only the fixed workload slice.
It rejects ceilings above live capacity or below current use plus a safety margin, persists changes atomically,
reads the kernel/systemd result back and rolls back on failure. The Web UI stages changes while any root turn,
turn start or subagent remains active and blocks new work until the staged policy has been applied.

Useful read-only checks after installation are:

```sh
systemctl status codex-web-ui-workload.slice codex-web-ui-resource-broker.socket
systemctl show codex-web-ui-workload.slice -p CPUQuotaPerSecUSec -p MemoryCurrent -p MemoryMax -p TasksCurrent -p TasksMax
sudo cat /etc/codex-web-ui/resource-limits.json
```

Do not edit the generated slice drop-in or policy file while the service is running. Use the authenticated Web
UI so updates are serialized against active work and audited.

## Codex sandbox prerequisites

Codex `workspace-write` uses Bubblewrap on Linux. Keep `ProtectProc=invisible`,
but do not add `ProcSubset=pid`: Bubblewrap must read the kernel overflow UID
and GID settings beneath `/proc/sys` while constructing the sandbox. On Ubuntu
hosts that restrict unprivileged user namespaces through AppArmor, install a
dedicated AppArmor profile which grants `userns` only to the exact, root-owned
Codex and Bubblewrap executable paths. Do not disable the host-wide AppArmor
restriction.

`CODEX_BIN` must resolve to an executable the service can traverse. If the
host's existing Codex wrapper or runtime lives below an `InaccessiblePaths`
entry, install a dedicated root-owned, service-read-only Codex runtime outside
that tree and point `CODEX_BIN` at its wrapper. Preserve the exact CLI version
pin and re-run the health check after changing either the runtime or profile.

## Disk safety boundary

`CODEX_WEB_MIN_FREE_BYTES`, `CODEX_WEB_MAX_DATABASE_BYTES` and
`CODEX_WEB_MAX_RELEASES` are soft fail-closed guards, not filesystem quotas.
Startup and health checks reject low free space or an oversized database; the
root storage timer repeats the check every minute and stops the service after a
violation. Install/update admission also refuses to create a release beyond the
configured retained-release count. No script automatically deletes a release.

A shared production host **must** additionally place application state, project
workspaces and release storage on a filesystem with an administrator-enforced
byte and inode quota (or on dedicated size-bounded volumes). The quota is the
hard protection against a fast write burst between timer checks. Size it so the
configured free-space floor remains available to the OS and co-hosted services.
If release admission reaches its cap, the operator must identify an inactive,
non-current release beneath `/opt/codex-web-ui/releases`, preserve any required
rollback artifact, and remove that exact directory through the host's reviewed
operations procedure before retrying the update.

For a standalone Ubuntu host, `scripts/install-bounded-storage.sh` provides the
portable bounded-volume path after the three target directories exist. It
requires explicit byte and inode ceilings, preallocates a root-owned `0600`
ext4 image, checksum-verifies the migration, persists the loop and bind mounts,
and keeps timestamped source directories for reviewed rollback. For example,
an 80 GiB / 1,310,720-inode ceiling is installed with:

```sh
sudo scripts/install-bounded-storage.sh \
  --size-bytes 85899345920 \
  --inode-count 1310720 \
  --project-root /srv/codex-projects \
  --service-user ai-chat-agent
```

The host must have the requested capacity free because the image is allocated,
not sparse. Validate a failure-and-recovery probe appropriate to the host and a
stop/unmount/`mount -a`/restart cycle before relying on the boot-time boundary.
Use a dedicated Web UI `CODEX_HOME` inside the bounded state directory; do not
reuse an unbounded agent home. The systemd unit separately places `/tmp` and
`/var/tmp` on byte- and inode-bounded tmpfs mounts charged to the service cgroup.

## Legacy manual scripts

`install-ubuntu.sh`, `update-ubuntu.sh` and `rollback-ubuntu.sh` are retained as
historical low-level assets for the original single-identity deployment. They
do not install the isolated socket/runner topology and must not be used for a
new portable installation or upgrade. `install.sh` and
`scripts/install-package.sh` are the supported lifecycle entry points.

The retained `update-ubuntu.sh` path still uses the same fail-closed graceful
drain protocol as the package upgrader so an existing single-identity host can
be migrated safely. If its installed API predates drain telemetry, externally
fence access, wait for active work to finish, stop the legacy API and verify
that no app-server runner remains before invoking the updater.

The following steps describe the underlying controls for maintainers, not an
alternative installation path:

1. Build a verified minimal release outside `CODEX_HOME` with
   `scripts/prepare-release.sh --output /absolute/new/release-directory`. The
   command runs the full repository gate and produces only the production
   backend dependency closure plus the compiled web assets. Ensure the output
   contains no `.env`, database, Codex state or escaping symlink.
2. Let `install.sh` assemble and activate that release; use `--no-start` on a
   shared host until hard byte/inode storage bounds have been established.
3. Populate `/etc/codex-web-ui/codex-web-ui.env` through a protected channel;
   keep it `root:root 0600`.
4. Install the bounded storage boundary described above before exposing the
   service. Do not remove its timestamped source backups until health and
   remount recovery have been verified.
5. Verify and install the self-contained required skill bundle with
   `sudo scripts/install-skills.sh --codex-home /absolute/codex/home`. The exact
   vendored file set in `skills/bundle/bundle.manifest.json` is enforced and
   existing skill versions are backed up. Updating the bundle is a reviewed
   source change: run `skill-bundle.py build` from an explicit skill source root,
   inspect the diff and regenerate the committed checksums; never use the whole
   local or server `CODEX_HOME` as that source.
6. On Ubuntu hosts with restricted user namespaces, install the exact-path
   AppArmor exception using the root-owned native Codex and Bubblewrap binaries:
   `sudo scripts/install-apparmor.sh --codex-bin /absolute/native/codex --bwrap-bin /absolute/bwrap`.
   The installer validates and loads only the two scoped `userns` profiles.
7. Install the Nginx template with existing TLS certificate/key paths using
   `scripts/install-nginx.sh`; review `nginx -t` before `--reload`.
   On a shared host where ports 80/443 are already owned, pass distinct
   `--http-port` and `--https-port` values and include the HTTPS port in
   `CODEX_WEB_PUBLIC_ORIGIN`.
8. Start `codex-web-ui@api.service` plus the private app-server socket and run
   `sudo scripts/health-check.sh --service-user api`. The check needs root only to read the
   protected environment and never prints secret values.

Updates atomically switch `current`, restart the service, and automatically
restore the prior release if health fails. Rollback accepts only an existing
release beneath `/opt/codex-web-ui/releases`; neither path deletes releases.

Before an upgrade changes `current` or stops a service, the installer creates
`/var/lib/codex-web-ui/data/upgrade-drain`. A drain-aware API keeps reads, SSE,
steering, interruption and pending approval/input resolution available, rejects
new turn starts, and reports the drain state from `/api/health`. Activation
begins only after health proves both `activeTurns` and `pendingTurnStarts` are
zero. If that proof times out or the response is malformed, the marker is
removed and the old release remains active; no symlink or service is changed.

The first upgrade from a release whose health response has no `upgradeDrain`
object cannot close the race between checking idle and stopping that legacy
API. The installer therefore refuses to upgrade an active legacy API. Put its
public endpoint behind an external maintenance fence that blocks new turn
submissions, wait until all work is idle, stop `codex-web-ui@api.service`, and
verify that no `codex-web-ui-app-server@*.service` runner remains active before
rerunning the upgrade. The installer accepts that already-stopped state; it
never turns an operator assertion into a false safety guarantee. Subsequent
drain-aware upgrades use this fail-closed health contract:

```text
upgradeDrain: {
  supported: true,
  requested: boolean,
  acceptingNewTurns: boolean,
  activeTurns: non-negative integer,
  pendingTurnStarts: non-negative integer,
  idle: boolean
}
```

During a requested drain, `idle` is true only when both counts are zero and new
turns are blocked. `/api/health` remains HTTP 200 while the app-server is ready.
After the new API passes its health check, the installer removes the marker and
waits for health to confirm that turn admission is enabled again.
