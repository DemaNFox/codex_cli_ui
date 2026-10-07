# Codex Web UI

A self-hosted, single-operator Codex server package with a browser interface.

The service keeps Codex on the server and provides projects, durable chats, streamed progress, approvals,
interactive questions, one-turn permission grants, model/reasoning selection, interruption and continuation
from any browser. Images and common project files can be attached both when starting a turn and when steering
an active turn by selecting, pasting or dropping them into the composer; image analysis is delegated to Codex and stored uploads remain inside the bounded
application state. The managed runner guidance asks Codex to include project-relative Markdown links for
user-requested deliverables, including a requested archive when one is created. Relative file links in Codex
answers are checked against the registered project before they are offered as downloads. Available files are
downloaded through an authenticated, traversal-safe route; stale, removed or never-created paths are labelled
as unavailable in the chat instead of being handed to the browser as broken downloads.
As a fallback when a completed answer omits such a link, the UI presents its completed file-change paths as
authenticated project downloads; the backend's canonical project checks remain authoritative. Agent messages render safe GitHub-flavored Markdown, including
responsive tables and code blocks, while raw HTML remains inert. An optional microphone control records a bounded clip in the browser,
transcribes it through the server and places the resulting text in the composer for review before sending.
It uses the official Codex app-server protocol over local stdio; the app-server transport
is never exposed publicly.

The workspace uses one navigation sidebar: projects expand to their chats, each project has its own new-chat
action and archived chats remain recoverable from the project menu. The composer stays pinned while a long
transcript scrolls independently. `/status` opens safe Codex account limits plus two explicitly labelled usage
scopes: an estimate for the selected chat and dated totals for all token activity on the signed-in account.
Account totals distinguish today, the trailing 7 and 30 days and all available time; unavailable per-chat
breakdowns stay visibly unavailable instead of being inferred. `/skills` opens the same status surface at the
loaded skills and instruction-source inventory.
The same Status drawer can replace the runner's Codex account through the official device-code flow when no
task or subagent is running. The short-lived code is shown only to the authenticated owner; access and refresh
tokens never pass through the Web application.
It also shows the installed and prepared Codex versions. An update can be started there only after an operator
has staged a complete checksummed release and all turns, pending starts, subagents and other exclusive work are
idle. The browser cannot choose a package, path, command or version. The Web API remains non-root in every
installation mode; a narrow root broker activates the fixed prepared release and rolls back automatically if
health verification fails.
On narrow screens the same navigation becomes a keyboard-accessible drawer, long titles remain on one line,
and model/access controls collapse into a compact settings row so the transcript and composer keep the
viewport.
Projects, chats, safe transcript events and sessions live on the server rather than in browser storage, so
the same administrator account sees the same workspace from desktop and phone. Active-task follow-ups,
including their safe attachment metadata, are persisted and streamed to both devices. Chat names can be edited
from the row menu. After the first successful task, a new chat adopts Codex's native topic name when it is
semantic; if Codex supplied only the beginning of the request, the server replaces it asynchronously with a
short contextual title through the same authenticated app-server account.
The last model, reasoning, access and approval selections are account settings stored on the server. Messages
and execution stages show their date and time, while steer and stop actions show an explicit accepted or failed
state instead of relying on a disappearing input value.
Each chat has an optional per-device notification subscription. After an explicit bell-button action, the
browser asks for notification permission and can report a terminal Codex result even while the page is
closed. Notification text is deliberately generic and never contains transcript, command, attachment or
tool-output content.

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
(x64 or arm64), clone it and run the default restricted installation:

```bash
git clone https://github.com/DemaNFox/codex_cli_ui.git
cd codex_cli_ui
./install.sh --public-origin https://codex.example.com --external-proxy
```

Replace `--external-proxy` with `--tls-cert /path/fullchain.pem --tls-key
/path/privkey.pem` to install the bundled Nginx edge. The installer installs any
missing base Ubuntu commands plus repository-pinned Node.js 22, pnpm and Codex
CLI artifacts, verifies their cryptographic checksums and the release inventory,
then checks `codex login status`. When the runner has no Codex session, it starts
`codex login --device-auth` directly on the local terminal as that non-root user.
It never accepts or stores an OpenAI token itself. Finally it prompts locally for
the Web UI administrator and generates host-local VAPID credentials for browser notifications without
printing the private key. An existing
installation requires the explicit `--upgrade` flag.
For a shared host, add `--no-start`, establish filesystem byte/inode quotas,
then enable the units; the default start path is intended for a dedicated
personal server.

On a dedicated personal host the operator may instead give Codex full machine authority explicitly:

```bash
./install.sh \
  --runner-mode host-admin \
  --project-root / \
  --public-origin https://codex.example.com \
  --external-proxy
```

This runs only the local Codex app-server runner as root; the HTTP API remains `codex-web-ui-api`. A stolen Web
session, prompt injection or malicious project command can therefore become root execution in this mode. The
installer never chooses it implicitly. It also installs a global Codex instruction that this is the physical
target host, so local administration uses local commands rather than SSH back to the same machine.

Migrating an existing restricted installation uses the explicit migration workflow documented in
[infra/README.md](infra/README.md). It preserves the Web SQLite database and copies the complete Codex home,
including rollout history, before changing the runner. Do not replace the runner user or point at an empty
root profile with a normal `--upgrade`.

The installed service starts in automatic resource mode. It uses the live host/ancestor-cgroup capacity,
keeps one CPU core and at least 15% RAM (minimum 1 GiB) outside the Codex workload, and derives a safe
concurrency ceiling. The administrator can inspect or lower CPU, RAM, task and agent limits in the Status
drawer. Changes wait for all root turns and subagents to finish; they never terminate active work.
Temporary saturation is not shown as a rejected task. A new root task is stored in the local durable queue
with its runtime settings and attachments, shown in the chat with its position, and started automatically when
that chat has no active root turn and a safe slot becomes available. Active subagents use execution slots but
do not block a new root task in the same chat when another slot is free. A selected active subagent can be
stopped from the Agents menu without interrupting the root turn or unrelated agents. A task that is still waiting can be cancelled from its
queue card; cancellation never interrupts work that has already started, and an ambiguous start that requires
review remains non-cancellable. Resource reconfiguration, draining and degraded-capacity
states still fail closed instead of silently adding work. A rare interrupted start is shown as requiring review;
it is reconciled against Codex and is never retried blindly. An answer emitted before the whole turn finishes
is shown as received while work continues; only a successful terminal turn is marked as the final answer.
If the root finishes while descendants keep running, the header says so explicitly. Active execution state is
also reconciled automatically, and a successful completion notification waits for the whole task tree to stop.

A new host needs only:

1. Ubuntu 22.04 or 24.04 on x64/arm64, Git, internet access and a normal sudo-capable user;
2. an HTTPS domain/proxy or an existing certificate and private key;
3. write access for the selected Codex user to the intended project roots, unless explicit `host-admin` is used;
4. an interactive terminal for the first Codex device login and Web UI administrator bootstrap.

Codex authentication, website passwords, `.env` values, databases, transcripts and project worktrees are
host state and are never committed. The installer must validate the pinned CLI protocol before activation.
Voice transcription is optional and independent from Codex device authentication. Each verified release
ships a pinned, manifest-checked quantized Whisper model; production inference stays on-host and requires no
transcription API key or runtime model download. The browser stops long recordings, while the API enforces
canonical audio, byte-size, decoded-duration, silence, request-rate and single-inference limits without
storing the audio. Upgrades treat the former `gpt-transcribe` setting as the bundled local model and ignore a
legacy `OPENAI_API_KEY`, so existing installations do not need a manual secret migration.
Browser notifications require a browser-supported secure context and permission granted separately on each
device. Chat subscriptions and the bounded delivery queue are server state; VAPID private material remains
only in the protected root-owned environment file.

## Verification and release

```bash
corepack pnpm install --frozen-lockfile
pnpm verify
scripts/prepare-release.sh --output /tmp/codex-web-ui-release
```

`scripts/prepare-package.sh --output /tmp/package --arch linux-x64 --archive tar.gz`
creates a checksummed, architecture-specific application package when run on
Linux. Package assembly intentionally refuses a Windows host because Windows
junction semantics cannot preserve pnpm's Linux dependency graph. The package
still downloads its checksum-pinned Node.js/pnpm/Codex toolchain during first
installation; it is not an air-gapped bundle. Deployment,
TLS, storage bounds and upgrades are documented in [infra/README.md](infra/README.md). Required
custom Codex skills are vendored with checksums under `skills/bundle`; project
`AGENTS.md` files remain with their respective Git repositories and are loaded
through each registered project path.

`SHA256SUMS` detects corruption and incomplete package trees; it is not a
publisher signature. Trust comes from cloning the intended GitHub repository
and reviewing/pinning the Git revision before invoking `sudo`.

After one full drained upgrade installs the split static pointer, frontend-only releases can be activated
without restarting the API or Codex app-server:

```bash
sudo /opt/codex-web-ui/current/scripts/update-web-ubuntu.sh \
  --source /absolute/path/to/verified/package \
  --release-id 20260928-web-a1b2c3d
```

The command verifies the checksummed package with the currently installed verifier, rejects a mismatched
`apiCompatibility`, copies an immutable release into the bounded release store, and atomically switches only
`web-current`. Use `rollback-web-ubuntu.sh` to reverse only that static switch. Backend, protocol, migration,
systemd or resource-control changes still require the normal drained full upgrade.

The Status drawer can install the single repository-reviewed compatible Codex runtime target without a server
terminal command. The browser sends only an empty request; the root worker verifies fixed official npm URLs,
committed archive digests and an exact generated-protocol match before switching the immutable runtime, and
rolls back protected configuration if health fails. An arbitrary newer CLI or a protocol-changing release still
requires a reviewed full application package.

To expose a previously installed and reviewed full release in the Status drawer, stage its release identifier
on the server:

```bash
sudo /usr/local/sbin/codex-web-ui-stage-codex-update \
  --source /absolute/path/to/verified/package \
  --release-id 20261001-codex-update
```

The root-only staging helper verifies and copies one complete package into the immutable release store. It can
also reselect an existing managed package with `--release-id EXISTING_RELEASE_ID`. Neither form publishes a
path, release selector or general root/package-install capability to the Web UI.
