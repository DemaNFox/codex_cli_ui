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

The application package remains architecture-specific because of native server
dependencies, but it is not an air-gapped toolchain bundle: first installation
requires access to Ubuntu package repositories, nodejs.org and registry.npmjs.org.

## Consequences

- A clean supported server needs only Git, internet access, a sudo-capable
  non-root operator, HTTPS configuration and project storage.
- Runtime upgrades are deliberate source changes: update versions and digests,
  verify both supported architectures, and release the matching protocol pin.
- An explicit application `--upgrade` moves an existing managed Codex path to
  the newly pinned managed version. A custom Codex path remains fixed and must
  use a separate explicit migration workflow.
- Existing authenticated runner state is reused without copying credentials.
- A compromised reviewed Git revision still has root installer authority; the
  operator must pin and trust the repository revision before invoking `sudo`.
