# Ubuntu deployment assets

These files install the standalone Codex Web UI as a loopback-only Node.js service behind an HTTPS Nginx
edge. The browser-facing API is always unprivileged. The Codex runner defaults to a restricted non-root
identity, while an explicit dedicated-host mode may run the runner as root. The assets do not deploy
automatically or copy product runtime secrets and deployment credentials into the Web API.

## Portable installation

The normal path is `./install.sh` from a clean Git checkout. It builds an
architecture-specific checksummed package without root, then invokes the root
installer only for system integration. It first installs the repository-pinned
Node.js, pnpm and Codex CLI toolchain beneath `/opt/codex-web-ui/runtime` and
exposes stable launchers in `/usr/local/bin`. The runner mode defaults to `restricted` and its user defaults
to the `sudo` caller. Its existing Codex login is reused without copying credentials; otherwise the installer
starts Codex device login for that user on the controlling terminal:

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
there is no `curl | sh` or floating `latest` tag. Use `--upgrade` explicitly to preserve the existing admin config
while switching to a new immutable release.
If `/usr/local/bin/codex` is already a regular host-managed executable, bootstrap
preserves it; the service still uses the exact managed CLI path from its protected
runner configuration.

For a dedicated machine that the operator wants Codex to administer completely, select the mode explicitly:

```sh
./install.sh \
  --runner-mode host-admin \
  --project-root / \
  --public-origin https://codex.example.com \
  --external-proxy
```

`host-admin` selects root's Codex identity and the unsandboxed root app-server unit. It permits system package,
service, network and filesystem administration from an authenticated Codex turn. It does not make the Web API
root: the API continues as `codex-web-ui-api`, communicates only through
`/run/codex-web-ui/app-server.sock`, and cannot read the protected runner environment or `CODEX_HOME` directly.
This mode is appropriate only when the operator accepts that login/session compromise, prompt injection and
project tooling can obtain host-root execution.

Both modes install a delimited global instruction in `CODEX_HOME/AGENTS.md` without replacing operator text.
It identifies this machine as the local physical Web UI host and directs Codex to use local commands instead
of SSH to loopback, the current hostname or any address of the same machine.

## Migrating an existing runner to host-admin

An installation without `/etc/codex-web-ui/codex-runner.env` still uses the retired single-service topology,
where the API and Codex share one OS identity. Upgrade that installation once without a runner migration flag:

```sh
./install.sh \
  --upgrade \
  --public-origin https://codex.example.com \
  --external-proxy
```

This adoption is a transaction of its own. It uses the owner of the legacy `CODEX_HOME` as the exact old
systemd instance, drains and stops that instance, preserves the Web database in place, moves only API-owned
data to `codex-web-ui-api`, removes `CODEX_HOME`/`CODEX_BIN` from the API environment, creates the protected
runner environment and starts the split socket topology. The old instance is disabled only after the split API
and app-server pass health checks. A failure restores the old release, configuration, data ownership, enabled
state and old service identity before releasing the drain. Directly combining legacy adoption with
`--migrate-runner-mode` is rejected so rollback never has to cross two security boundaries at once.

After that first upgrade succeeds, do not change `--runner-user` or `--codex-home` on an ordinary upgrade. Use
the explicit migration flag in a second invocation and repeat the installation's existing origin/TLS arguments:

```sh
./install.sh \
  --upgrade \
  --migrate-runner-mode host-admin \
  --migration-codex-home /root/.codex-web-ui \
  --project-root / \
  --public-origin https://codex.example.com \
  --external-proxy
```

The destination must not exist. `/root/.codex-web-ui` is recommended when `/root/.codex` already belongs to a
separate manual root CLI profile; the migration never merges profiles. It first blocks new work, waits for all
turns and subagents to finish, stops the API and runner socket, copies the complete current Codex home, compares
the copied file inventory and hashes, verifies the pinned CLI and copied login, installs the same-host global
instruction, then switches the app-server unit to root and performs a health check. Web SQLite, attachments,
projects, chat titles and thread mappings stay in place. Only this explicit host-admin migration may widen the
registered project roots to exactly `/`; ordinary upgrades continue to reject every project-root change.

The destination parent must be root-owned and not writable by group or other users. Migration cannot be
combined with `--no-start`, because a successful health check of the new root runner is part of the state
transition; use `--no-start` only on ordinary installs/upgrades.

Migration is committed as its own transaction before the package upgrade continues. If migration fails, the
old unit/configuration is restored and the incomplete target is removed. After a successful health check the
old Codex home is retained at its original path but recursively changed to root ownership and mode `0700`, so
the former runner cannot use the duplicated credential. Keep that rollback copy until chats and continued
turns have been checked; a later package-upgrade failure does not undo an already healthy identity migration,
and the upgrade can be retried normally without the migration flag.

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
  `codex-cli 0.159.3`). `binutils` remains an additional prerequisite only for
  the optional scoped AppArmor profile.
- Restricted mode requires an existing non-root service user. The current server may use `ai-chat-agent` with
  `CODEX_HOME=/opt/ai-chat-agents/home/.codex`. Host-admin requires the root runner and defaults to root's
  protected Codex home.
- First-time authentication requires an interactive controlling terminal. The
  device code is displayed by Codex directly and must not be shared. For an
  unattended restricted host, authenticate beforehand as the runner with
  `sudo -u USER -H /usr/local/bin/codex login --device-auth`. In host-admin mode run the same pinned Codex
  device flow as root; the installer attaches it directly to the terminal and never captures the code.
- A prepared release contains `apps/server/dist/index.js` and
  `apps/web/dist/index.html`. Nginx serves the web build directly and proxies
  only `/api/` to the loopback backend. Release directories are immutable and
  retained under `/opt/codex-web-ui/releases`; `current` selects the backend and
  `web-current` independently selects the static build through atomic symlinks.
- Each allowed project root and `CODEX_HOME` is an existing canonical directory. Restricted mode rejects
  overlap and broad protected roots, then grants write access only to those paths. Host-admin may register `/`
  and intentionally has whole-host access.
- In host-admin mode the API remains non-root and therefore delegates only project-path canonicalization to
  `codex-web-ui-project-path-broker.socket`. The root broker reads `/etc/codex-web-ui/project-roots` (root-owned
  mode `0600`), validates the API peer and candidate inode/type/containment, and exposes no file-content,
  directory-listing, write or caller-supplied policy operation. Restricted mode does not enable this broker.
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
The host-admin runner remains assigned to this slice for normal accounting and operation. Because it is root,
it can intentionally change systemd/cgroup policy; the slice is not containment against a hostile host-admin
turn.

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

## Codex updates from Status

The API performs a read-only check of the fixed official npm metadata endpoint at startup and every six hours.
Opening Status reads the cached result; “Проверить обновления” forces the same bounded check. Discovery never
selects executable content. The root broker separately exposes either a staged full application package or the
single reviewed runtime target shipped in `infra/codex-update-target.json`.

When that reviewed target is newer than the installed runtime, Status shows “Скачать и установить”. Its empty
request carries no URL, path, version, package or command. The fixed worker independently requires the official
registry latest version to equal the reviewed target, verifies npm and committed SHA-512 digests, performs
bounded safe extraction, regenerates app-server schemas as an unprivileged identity and requires exact reviewed
protocol hashes. A mismatch fails closed and requires a compatible full application package. Activation drains
work, switches protected runtime/version pins, health-checks the service and restores the previous configuration
on failure.

The staged full-release path remains authoritative for protocol or application changes. After reviewing and
preparing a complete release, stage exactly its identifier:

```sh
sudo /usr/local/sbin/codex-web-ui-stage-codex-update \
  --source /absolute/path/to/verified/package \
  --release-id 20261001-codex-update
```

The helper verifies the package with the installed root-owned verifier, enforces the release-store limit,
copies and re-verifies it as an immutable root-owned release, then atomically updates
`/opt/codex-web-ui/codex-update-candidate`. Use `--release-id EXISTING_RELEASE_ID` without `--source` to reselect
an existing managed package. It never downloads packages. The browser can then invoke only a strict `apply`
operation; it cannot provide a URL, path, version, command, unit or package name. The root broker authenticates
the API peer, repeats inventory/ownership/architecture/API checks and starts the fixed
`codex-web-ui-codex-update.service` oneshot. Candidate Codex schemas are generated as the non-root runner and
must match the reviewed protocol snapshot before any drain begins.

Activation waits for all Codex work and other exclusive operations to become idle, then uses the supported
full installer. It atomically updates both protected version-pin files, restarts the compatible application,
checks health and rolls back on failure. Inspect it with:

```sh
systemctl status codex-web-ui-codex-update-broker.socket codex-web-ui-codex-update.service
sudo cat /var/lib/codex-web-ui/codex-update-result.json
```

Codex and the API remain non-root. Only the small broker/worker boundary has root authority; do not add the
runner to sudoers or give it write access to the release store.

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
   Voice input uses the pinned quantized Whisper model shipped inside each verified
   immutable release. No transcription API key is needed, and the production runtime
   never downloads a model or sends recorded audio off-host. The default model path
   follows `/opt/codex-web-ui/current/models`; override the model/cache settings only
   when an equivalent manifest-verified model has been provisioned there.
   The supported installer also runs `setup-push.mjs` once to add a VAPID keypair
   and HTTPS subject to this file. It preserves existing keys on upgrades so active
   browser subscriptions remain valid and never prints either key. Removing or
   rotating the pair invalidates existing device subscriptions.
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
`/run/codex-web-ui/upgrade-drain`. A drain-aware API keeps reads, SSE,
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
