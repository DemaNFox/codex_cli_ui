# Architecture

## Decision

Build a portable standalone service around the official Codex app-server protocol. The browser never scrapes terminal output and never connects directly to app-server.

```text
Browser
  -> reverse proxy with TLS and request limits
    -> Node.js API (codex-web-ui-api): login, projects, threads, turns, approvals, SSE
      -> SQLite: UI metadata, sessions, audit and bounded event journal
      -> root-created mode-0600 Unix socket
        -> isolated runner identity -> codex app-server --listen stdio://
          -> configured CODEX_HOME
          -> allowlisted project roots
```

## Runtime ownership

- The API owns one bounded Unix-socket client. systemd starts the app-server under the configured,
  already authenticated runner identity and restarts each accepted connection independently.
- The API cannot read `CODEX_HOME` or the runner environment. The runner cannot read the Web login/session
  environment or SQLite; it receives read-only attachment access and explicit project/Codex-home paths.
- JSON-RPC requests are correlated by generated numeric IDs. Server-initiated approval and input requests are recorded as pending UI actions.
- The backend projects safe, normalized events to per-thread SSE streams. Reconnect uses the last event ID and the durable event journal.
- Subagent lifecycle notifications are projected into a server-owned table keyed by the root chat and are
  published as safe SSE state snapshots. The projection includes public identity, hierarchy, model, effort,
  exact lifecycle state and timestamps, but never the delegated prompt or chain-of-thought. Every authenticated
  device therefore sees the same running and completed subagents after reconnect.
- Projects, thread metadata, authenticated sessions and the safe event journal are server-owned. Browsers keep
  only transient view/composer state: a second authenticated device loads the same project and chat inventory,
  hydrates the selected transcript from the server and then follows it through SSE. Active-turn steering is
  also written as a canonical user event so it remains visible after reconnect and on every device.
- The thread projection stores the current active turn ID instead of asking the browser to infer it from a
  bounded event journal. A process restart clears that runtime-only projection before Codex is queried, so an
  old `inProgress` history row cannot create a phantom running task. Interrupt acceptance is journaled and
  broadcast as `interruptRequested`; the turn remains active until Codex emits its terminal notification.
- The single administrator's last model, reasoning effort, permission preset and approval policy are stored as
  one atomic server-side preference tuple. They follow the account between devices and are not reset when the
  operator switches projects.
- Codex rollout files remain the source of truth for Codex conversation history. SQLite stores the local project registry, thread-to-project mapping, UI metadata, sessions, audit records and a bounded reconnect journal.
- A project is a display name plus a canonical existing directory under an allowlisted root. Codex has no separate project entity; thread `cwd` binds execution to a project.
- Models and reasoning efforts come from `model/list`; the UI never hard-codes account availability.
- `instructionSources` from thread start/resume and `skills/list` are visible in the status drawer so the operator can verify that `AGENTS.md` and required skills loaded.
- The backend reads account rate limits and aggregate usage through the app-server read-only account methods. Its public projection omits account identity, email, credits, authentication material and unknown upstream fields; an unsupported optional method degrades to `null` plus a static warning.
- The browser handles `/status` and `/skills` locally instead of sending them as model turns. Other text, including unknown slash-prefixed text, remains an ordinary Codex prompt.
- Completed agent messages are rendered as sanitized GitHub-flavored Markdown. Raw HTML is disabled, links
  receive safe navigation attributes and wide tables scroll inside their own mobile-safe container; model
  output is never executed as JavaScript.

## Voice transcription

- The browser records a short audio clip only after an explicit microphone action, then sends one
  authenticated multipart request to the Web API. Stopping a recording never sends a Codex turn: the returned
  transcript is inserted into the composer for operator review and editing.
- The browser stops a recording at the advertised duration. The API independently accepts only an allowlisted
  audio media type within a hard byte bound, permits only bounded transcription concurrency/rate and applies
  an upstream timeout before forwarding the in-memory file to the configured OpenAI transcription model.
  Audio bytes are never written to SQLite, attachment storage or logs. Container duration is not decoded
  server-side; the byte limit remains the hostile-client availability boundary.
- One recording receives one UUID idempotency key. A bounded ten-minute in-memory cache binds that key to the
  authenticated session and audio hash, shares an in-flight result and rejects conflicting replay; the same
  key is forwarded upstream and reused for the client's single network-error retry. The cache intentionally
  does not make transcription text durable.
- `OPENAI_API_KEY` lives only in the root-owned Web service environment. It is separate from the isolated
  runner's Codex device credential and is never returned through capabilities, errors or browser assets.
- When the key is absent, capabilities report transcription unavailable and the microphone control explains
  that server setup is required. The rest of Codex Web UI continues to work normally.

## Attachments

- The browser uploads each attachment before starting a turn and receives only an opaque attachment ID plus safe display metadata. Uploads are scoped to their thread and stored beneath the bounded application-state directory; the original client path is never trusted.
- A turn may claim at most eight already uploaded attachments. Each attachment is limited to 20 MiB and the durable total is limited to 50 MiB per thread. Deleting or archiving a chat does not escape the thread boundary.
- PNG, JPEG and WebP images are signature-checked and passed to app-server as native `localImage` inputs. The UI renders them through an authenticated, thread-scoped content route.
- Common text, source, PDF and office documents remain inert files in the Web API. Codex receives a backend-generated instruction containing only a server-verified internal path; the API does not parse, execute, unzip or embed their content.
- App-server `userMessage` notifications are not copied into the public event journal. The backend writes one canonical user event containing only text and safe attachment metadata, preventing duplicated messages and internal-path disclosure during streaming or history hydration.
- Fragmented agent-message deltas are not exposed because an internal path could span fragments and bypass per-event redaction. The UI receives the complete redacted agent message; other safe progress and state events continue to stream.
- Activity rows derive their short label only from the sanitized public item projection: command text, changed
  paths, public reasoning summaries, or the server/tool name. Command output may appear inside the row's
  disclosure; raw reasoning, tool arguments, credentials and hidden protocol fields are never rendered.
- Attachment IDs cannot be used across threads. Content responses use `nosniff`; non-image files are downloads rather than active browser content.
- When this browser tab switches chats, it aborts its own in-flight uploads and removes only staged IDs that the same tab has received. It never infers ownership from another client's history. Claimed or sent attachments remain fail-closed and cannot be deleted through that cleanup path.

## Permission presets

- `read-only`: read project files and run non-mutating inspection.
- `workspace-write`: normal development inside the registered project.
- `full-access`: Codex `danger-full-access` semantics within the privileges of the non-root service account.

The service does not add sudo, root, Docker socket, product secrets, or deployment credentials. A future deployment broker is a separate typed and audited boundary.

## Portability

All executable source, database migrations, protocol snapshots, service templates, installer scripts and
required custom skills live in this repository. Host-specific absolute paths and credentials live only in
separate protected Web and runner environment files. The supported installer downloads exact, repository-pinned
Node.js, pnpm and Codex CLI artifacts, verifies committed digests, and installs them in immutable root-owned
version directories. Codex authentication is performed only as the selected non-root runner through its direct
terminal. Installation fails closed when the managed Codex CLI does not match the checked-in compatible protocol
snapshot.

Deployment secrets are kept in a root-owned `0600` environment file. systemd
loads it before changing to the unprivileged service identity, so the service
user does not receive file-read access. CPU, memory and process counts for the API and all runners are
aggregated in one workload slice. A separate root-owned, socket-activated resource broker accepts only a fixed
snapshot/apply protocol from the API service identity and can change only that slice. The default automatic
policy never allocates more than the parent cgroup/host permits and reserves at least one CPU plus 15% of RAM
(at least 1 GiB) for Ubuntu. Custom ceilings are validated against live capacity, staged while any root task or
subagent is active and applied only after the workload becomes idle. New work fails closed while a policy is
pending/degraded and when live memory or the effective execution-unit ceiling is exhausted. Disk admission and a periodic guard stop work on low space
or database overflow, while an administrator-enforced filesystem quota or
dedicated bounded volume remains mandatory for a hard disk limit.
The effective agent ceiling is also passed to the pinned Codex thread configuration as `agents.max_threads`
when an idle thread is resumed, so descendants share the same concurrency limit; the cgroup remains the final
machine-level enforcement boundary. Automatic concurrency allows at most eight threads and budgets at least
one CPU core and 2 GiB of the selected workload memory per concurrent root/subagent slot; a custom value above
that derived ceiling is rejected.

## Initial API

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET/POST/PATCH/DELETE /api/projects`
- `GET /api/models`
- `GET/POST /api/threads`, `GET/PATCH /api/threads/:id`
- `POST /api/threads/:id/archive`, `POST /api/threads/:id/unarchive`; listing accepts a project-scoped `archived` filter
- `POST /api/threads/:id/turns`, `POST /api/threads/:id/steer`, `POST /api/threads/:id/interrupt`
- `POST /api/approvals/:id/resolve`
- `POST /api/user-input-requests/:id/resolve` for typed `request_user_input` answers; secret answers are never persisted or echoed
- `POST /api/permission-requests/:id/resolve` for an explicit deny or one-turn grant derived from the validated request
- `GET /api/threads/:id/events` using SSE and `Last-Event-ID`
- `GET /api/threads/:id/subagents` for the durable root-chat subagent projection
- `POST/GET /api/threads/:id/attachments`, `GET/DELETE /api/threads/:id/attachments/:attachmentId`; uploads use multipart field `file`
- `GET /api/system/capabilities` for safe version/auth/instruction/skill, rate-limit and aggregate-usage status
- `POST /api/audio/transcriptions` for bounded ephemeral speech-to-text; uploads use multipart field `file`
- `GET/PUT /api/system/resource-limits` and `POST /api/system/resource-limits/apply` for the
  authenticated, CSRF-protected resource policy workflow

All state-changing routes require an authenticated session, exact Origin and a session-bound CSRF token.

An empty chat can exist locally before Codex has written a rollout for it. Archive and restore first use the
upstream Codex operation; if Codex specifically rejects that request and the local chat has no persisted events,
the Web UI records the state locally and audits the degraded path. Timeouts, unavailable Codex and failures for
chats with history remain errors rather than being silently accepted.

The single navigation sidebar expands each project into its chat list, offers global and per-project new-chat
actions and keeps a cross-project recent list. The project context menu exposes an archived-chat view scoped
to that project. Archived threads can be inspected and restored without mixing them into the active thread
list. The transcript owns the scroll container while the composer remains in a fixed grid row.
Thread menus allow a server-persisted manual rename. Until the operator renames it, the first native
`thread/name/updated` notification from Codex supplies the topic name after the initial task. Open clients
apply that notification immediately; background and visibility refreshes reconcile project/thread navigation
changed from another device.
Messages and visible execution stages render their persisted ISO event time in the browser's local timezone.
The transcript follows new events only while the reader remains near its bottom. Scrolling upward exposes a
floating jump control; newly streamed events keep that control visible instead of moving the reader, and the
control returns to the latest event on demand.
For live work this is the server receipt time. Older history first imported from Codex may only have the import
time when the protocol item did not expose a trustworthy occurrence timestamp.
At `820px` and below, the navigation is an off-canvas drawer with focus containment, Escape close and focus
return. Runtime model, reasoning, permission and approval controls remain available behind a compact toggle;
their collapsed state reserves the constrained viewport for the independently scrolling transcript and the
composer. The account/logout row remains reachable inside the drawer.

## Upgrade drain

Package upgrades are fail-closed around active Codex work. The installer requests a drain before switching the
`current` release: new turn starts are rejected, while reads, SSE, steering, interruption and pending user
interactions remain available from desktop or phone. Activation proceeds only after the running API reports
zero active root turns, pending turn starts and active subagents. An unavailable or unverifiable drain leaves
the old release running.
An active legacy release that lacks this health contract is never upgraded in place: the installer fails
closed. Its one-time migration requires an external maintenance fence that blocks new turn submissions,
followed by a verified idle state and a stopped API with no app-server runners. Later drain-aware upgrades
prove idleness through the running service without taking the monitoring and steering surface away.

This drain prevents planned upgrades from destroying work; it is not crash recovery. An unexpected API or
runner process failure can still terminate an in-flight Codex turn because the private app-server process is
bound to that connection. Preserving computation across such a crash would require a durable broker outside
the API lifecycle.

## Independent Web UI releases

Nginx serves static assets through the root-owned atomic `web-current` symlink, while the API and app-server
continue to execute from `current`. A web-only update verifies the complete package inventory using the
already-installed verifier, requires the package and active backend manifests to share the same integer
`apiCompatibility`, copies the immutable package into the existing bounded release store, then switches only
`web-current`. It does not request a drain, reload systemd, restart the API or reconnect app-server.

Full updates remain authoritative for backend and UI together: they drain active root turns and subagents,
switch both pointers and restart the service. Any API compatibility change, server/config/systemd change or
package lacking compatibility metadata must use that full path. Both update modes record independent previous
targets, so a static rollback cannot roll back the backend and a full rollback restores both components.
During a retained single-identity deployment migration, the updater also clears legacy per-service CPU,
memory and task ceilings. The aggregate workload slice remains the sole resource-control owner, preventing an
older static unit limit from silently overriding the current automatic or operator-selected policy.
