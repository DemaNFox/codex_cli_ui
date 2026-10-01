# ADR-0002: Managed portable Codex toolchain

Status: accepted

## Context

Requiring an operator to install compatible Node.js, pnpm and Codex CLI versions
before deploying the Web UI makes a new-server installation fragile and does not
provide reproducible protocol compatibility. Running an unpinned shell installer
as root would replace that operational problem with a supply-chain boundary.

## Decision

The supported Ubuntu installer bootstraps exact Node.js 22, pnpm and Codex CLI
versions declared in `infra/toolchain.env`. It downloads versioned upstream
archives over HTTPS, verifies committed SHA-256 or SHA-512 digests before
extraction, and activates immutable root-owned version directories through
stable `/usr/local/bin` links. It never uses a floating release tag or pipes a
download into a shell.

Codex credentials remain host state. If the selected non-root runner is not
authenticated, installation invokes `codex login --device-auth` as that runner
with input and output attached directly to `/dev/tty`, then rechecks login
status. The installer never authenticates as root, accepts tokens as arguments,
or captures the device code.

After bootstrap, an authenticated Web owner may replace that same runner account through the pinned Codex
app-server `chatgptDeviceCode` flow. The Web API temporarily relays only the verification URL and one-time
code, never a credential token, and does not read the runner's `CODEX_HOME`. Runtime account replacement is
admitted only while every root turn, pending start and subagent is idle; new work remains blocked until the
flow completes, fails or cancellation is confirmed. A cancellation whose outcome cannot be verified remains
fail-closed until Codex reports a terminal result or the API process is restarted.

After installation, the Web owner may also activate a newer pinned Codex version from the Status drawer, but
only when a trusted host operator has already placed and staged a complete immutable release. The browser and
API never select or download a version, URL, path or package. A root-owned broker exposes only fixed `status`
and `apply` operations, authenticates the API socket peer, and delegates activation to one fixed systemd
oneshot. Codex and app-server still run as the non-root runner.

The staged package is accepted only when its inventory, architecture and API compatibility match the installed
boundary. Before drain, the candidate Codex binary generates its schemas as the runner and those bytes must
match the reviewed checksummed protocol snapshot in the package. Activation uses the normal health-checked
full upgrade and restores the prior release and both version-pin environment files on failure. A CLI-only
floating update is deliberately unsupported because the backend and protocol pin form one compatibility unit.

The application package remains architecture-specific because of native server
dependencies, but it is not an air-gapped toolchain bundle: first installation
requires access to Ubuntu package repositories, nodejs.org and registry.npmjs.org.

## Consequences

- A clean supported server needs only Git, internet access, a sudo-capable
  non-root operator, HTTPS configuration and project storage.
- Runtime upgrades are deliberate source changes: update versions and digests,
  verify both supported architectures, and release the matching protocol pin.
- The Status drawer can activate only an operator-staged compatible full release; it is not an npm registry
  client and does not grant Codex or the API general root access.
- An explicit application `--upgrade` moves an existing managed Codex path to
  the newly pinned managed version. A custom Codex path remains fixed and must
  use a separate explicit migration workflow.
- Existing authenticated runner state is reused without copying credentials.
- Account replacement does not delete Codex rollout state or Web-owned chat metadata; access to older remote
  conversation history can still depend on the newly selected account's OpenAI authorization.
- A compromised reviewed Git revision still has root installer authority; the
  operator must pin and trust the repository revision before invoking `sudo`.
