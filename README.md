# Codex Web UI

A self-hosted, single-operator browser client for an existing Codex CLI installation.

The service keeps Codex on the server and provides projects, durable chats, streamed progress, approvals,
interactive questions, one-turn permission grants, model/reasoning selection, interruption and continuation
from any browser. Images and common project files can be attached to a turn by selecting, pasting or dropping
them into the composer; image analysis is delegated to Codex and stored uploads remain inside the bounded
application state. It uses the official Codex app-server protocol over local stdio; the app-server transport
is never exposed publicly.

The workspace uses one navigation sidebar: projects expand to their chats, each project has its own new-chat
action and archived chats remain recoverable from the project menu. The composer stays pinned while a long
transcript scrolls independently. `/status` opens safe Codex account limits and aggregate usage; `/skills`
opens the same status surface at the loaded skills and instruction-source inventory.
On narrow screens the same navigation becomes a keyboard-accessible drawer, long titles remain on one line,
and model/access controls collapse into a compact settings row so the transcript and composer keep the
viewport.

Status: the portable release has been deployed and verified on an Ubuntu reference host. A new host still
requires its own HTTPS endpoint, bounded storage and server-local login secrets.

## Architecture

```text
Browser -> HTTPS edge -> Web API/SSE -> private Unix socket -> Codex app-server
                         |                                  |
                         v                                  v
                   SQLite + uploads                 CODEX_HOME + projects
```

See [architecture](docs/architecture.md) and the [threat model](docs/Codex_Web_UI-threat-model.md).

## Portability contract

The repository is the complete distributable source. On Ubuntu 22.04/24.04
(x64 or arm64), clone it as the already authenticated Codex user and run:

```bash
git clone https://github.com/DemaNFox/codex_cli_ui.git
cd codex_cli_ui
corepack pnpm install --frozen-lockfile
./install.sh --public-origin https://codex.example.com --external-proxy
```

Replace `--external-proxy` with `--tls-cert /path/fullchain.pem --tls-key
/path/privkey.pem` to install the bundled Nginx edge. The installer verifies the
checksummed package inventory, Node 22, the pinned Codex CLI and `codex login status`, then
prompts on the local terminal for the Web UI administrator. An existing
installation requires the explicit `--upgrade` flag.
For a shared host, add `--no-start`, establish filesystem byte/inode quotas,
then enable the units; the default start path is intended for a dedicated
personal server.

A new host needs:

1. a supported, already authenticated Codex CLI;
2. Node.js/pnpm and this Git checkout;
3. an HTTPS domain/proxy or an existing certificate and private key;
4. write access for that Codex user to the intended project roots.

Codex authentication, website passwords, `.env` values, databases, transcripts and project worktrees are
host state and are never committed. The installer must validate the pinned CLI protocol before activation.

## Verification and release

```bash
corepack pnpm install --frozen-lockfile
pnpm verify
scripts/prepare-release.sh --output /tmp/codex-web-ui-release
```

`scripts/prepare-package.sh --output /tmp/package --arch linux-x64 --archive tar.gz`
creates a checksummed, architecture-specific offline installer. Deployment,
TLS, storage bounds and upgrades are documented in [infra/README.md](infra/README.md). Required
custom Codex skills are vendored with checksums under `skills/bundle`; project
`AGENTS.md` files remain with their respective Git repositories and are loaded
through each registered project path.

`SHA256SUMS` detects corruption and incomplete package trees; it is not a
publisher signature. Trust comes from cloning the intended GitHub repository
and reviewing/pinning the Git revision before invoking `sudo`.
