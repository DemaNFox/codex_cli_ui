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

Codex credentials remain host state. A fresh installation explicitly chooses one runner mode:

- `restricted` is the default. It uses an existing non-root runner and the hardened app-server unit.
- `host-admin` is an operator-selected dedicated-host mode. It uses the root Codex profile and an app-server
  unit without the runner capability/filesystem sandbox, so authenticated Codex turns have host-root authority.

The browser-facing API remains the separate non-root identity in both modes. If the selected runner is not
authenticated, installation invokes `codex login --device-auth` as that exact identity with input and output
attached directly to `/dev/tty`, then rechecks login status. Root authentication is therefore possible only
after the operator explicitly selects `host-admin`. The installer never accepts tokens as arguments or
captures the device code.

An existing restricted installation cannot change identity through an ordinary upgrade. Its explicit
host-admin migration first drains all turns and subagents, preserves the Web database unchanged, copies the
complete Codex home (including rollout history and authentication) without merging it into an unrelated root
profile, retains a root-only rollback source through health verification, and then activates the root runner.
Collision or incomplete-copy evidence fails closed.

The installer also maintains a delimited global `CODEX_HOME/AGENTS.md` block telling Codex that it already runs
on the physical Web UI host. Same-host administration uses local commands; SSH is reserved for a remote host
that the operator explicitly identifies. Existing operator instructions outside the managed block are kept.

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
oneshot. The API remains non-root; Codex and app-server retain the explicitly installed runner mode.

The staged package is accepted only when its inventory, architecture and API compatibility match the installed
boundary. Before drain, the candidate Codex binary generates its schemas as the runner and those bytes must
match the reviewed checksummed protocol snapshot in the package. Activation uses the normal health-checked
full upgrade and restores the prior release and both version-pin environment files on failure. A CLI-only
floating update is deliberately unsupported because the backend and protocol pin form one compatibility unit.

The application package remains architecture-specific because of native server
dependencies, but it is not an air-gapped toolchain bundle: first installation
requires access to Ubuntu package repositories, nodejs.org and registry.npmjs.org.

## Consequences

- A clean supported server needs only Git, internet access, a sudo-capable operator, HTTPS configuration and
  project storage. Restricted remains the default; host-admin is never selected implicitly.
- Runtime upgrades are deliberate source changes: update versions and digests,
  verify both supported architectures, and release the matching protocol pin.
- The non-root API performs a bounded, read-only check of the fixed official `@openai/codex/latest` registry
  endpoint at startup, every six hours and on an authenticated empty-body refresh request. This check is
  informational only: it cannot select, download, stage or activate a package. The Status drawer can activate
  only an operator-staged compatible full release and cannot change the installed runner mode or grant root
  to the API.
- An explicit application `--upgrade` moves an existing managed Codex path to
  the newly pinned managed version. A custom Codex path remains fixed and must
  use a separate explicit migration workflow.
- Existing authenticated runner state is reused without copying credentials.
- Explicit restricted-to-host-admin migration preserves both Web-owned chat metadata and the complete Codex
  home; an ordinary upgrade never migrates identities.
- In host-admin mode a stolen Web session, prompt injection or malicious project command can become host-root
  execution. This is an accepted operator-selected dedicated-host trade-off, not a shared-host default.
- Account replacement does not delete Codex rollout state or Web-owned chat metadata; access to older remote
  conversation history can still depend on the newly selected account's OpenAI authorization.
- A compromised reviewed Git revision still has root installer authority; the
  operator must pin and trust the repository revision before invoking `sudo`.
