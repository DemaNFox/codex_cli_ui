# Ubuntu deployment assets

These files install the standalone Codex Web UI as an unprivileged, loopback-only
Node.js service behind an HTTPS Nginx edge. They do not deploy automatically and
they never copy `CODEX_HOME`, Codex authentication, project `.env` files, product
runtime secrets, Docker access or deployment credentials.

## Assumptions

- Ubuntu with systemd, Nginx, Node.js 22+, Python 3, `curl`, and the pinned Codex
  executable already installed. `binutils` is required when installing the
  scoped AppArmor profile. Startup fails unless `codex --version` exactly
  matches `CODEX_WEB_CODEX_VERSION_PIN` (initially `codex-cli 0.153.4`).
- The chosen service user already exists and is not root. The current server may
  use `ai-chat-agent` with `CODEX_HOME=/opt/ai-chat-agents/home/.codex`.
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

## Safe installation sequence

1. Build a verified minimal release outside `CODEX_HOME` with
   `scripts/prepare-release.sh --output /absolute/new/release-directory`. The
   command runs the full repository gate and produces only the production
   backend dependency closure plus the compiled web assets. Ensure the output
   contains no `.env`, database, Codex state or escaping symlink.
2. Run `scripts/install-ubuntu.sh` without `--start`. It creates no credentials.
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
8. Start `codex-web-ui@USER.service` and run
   `sudo scripts/health-check.sh`. The check needs root only to read the
   protected environment and never prints secret values.

Updates atomically switch `current`, restart the service, and automatically
restore the prior release if health fails. Rollback accepts only an existing
release beneath `/opt/codex-web-ui/releases`; neither path deletes releases.
