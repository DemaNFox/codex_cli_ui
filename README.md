# Codex Web UI

A self-hosted, single-operator browser client for an existing Codex CLI installation.

The service keeps Codex on the server and provides projects, durable chats, streamed progress, approvals,
interactive questions, one-turn permission grants, model/reasoning selection, interruption and continuation
from any browser. It uses the official Codex app-server protocol over local stdio; the app-server transport
is never exposed publicly.

Status: deployment candidate; activation still requires a hostname/TLS
certificate and server-local login secrets.

## Architecture

```text
Browser -> HTTPS reverse proxy -> Codex Web API/SSE -> local Codex app-server stdio
                                      |                     |
                                      v                     v
                                SQLite metadata       CODEX_HOME + projects
```

See [architecture](docs/architecture.md) and the [threat model](docs/Codex_Web_UI-threat-model.md).

## Portability contract

The repository is the complete distributable source. A new Ubuntu host needs only:

1. a supported, already authenticated Codex CLI;
2. Node.js/pnpm and this Git checkout;
3. a non-root service user with access to the intended project roots;
4. a server-local environment file containing the public origin and generated login/session secrets;
5. the included installer for systemd, Nginx and the checksummed skill bundle.

Codex authentication, website passwords, `.env` values, databases, transcripts and project worktrees are
host state and are never committed. The installer must validate the pinned CLI protocol before activation.

## Verification and release

```bash
corepack pnpm install --frozen-lockfile
pnpm verify
scripts/prepare-release.sh --output /tmp/codex-web-ui-release
```

The release command creates a portable runtime directory for
`scripts/install-ubuntu.sh`; deployment, secret entry, TLS setup and service
activation are documented in [infra/README.md](infra/README.md). Required
custom Codex skills are vendored with checksums under `skills/bundle`; project
`AGENTS.md` files remain with their respective Git repositories and are loaded
through each registered project path.
