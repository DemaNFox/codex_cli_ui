# Architecture

## Decision

Build a portable standalone service around the official Codex app-server protocol. The browser never scrapes terminal output and never connects directly to app-server.

```text
Browser
  -> reverse proxy with TLS and request limits
    -> Node.js API (codex-web-ui-api): login, projects, threads, turns, approvals, SSE
      -> SQLite: UI metadata, sessions, audit and bounded event journal
      -> root-created mode-0600 Unix socket
        -> selected runner identity -> codex app-server --listen stdio://
          -> configured CODEX_HOME
          -> allowlisted project roots
```

## Runtime ownership

- The API owns one bounded Unix-socket client. systemd starts the app-server under the configured,
  already authenticated runner identity and restarts each accepted connection independently.
- The API cannot read `CODEX_HOME` or the runner environment. In restricted mode the runner also cannot read
  the Web login/session environment or SQLite. In explicit host-admin mode the runner is root and can bypass
  host filesystem ownership by design, so Web/API isolation prevents accidental API privilege but is not a
  security boundary against a hostile root Codex turn.
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
- Codex rollout files remain the source of truth for Codex conversation history. SQLite stores the local project registry, thread-to-project mapping, UI metadata, sessions, audit records and a bounded reconnect journal. The journal keeps the newest configured event window plus a separately bounded window of user prompts so command/subagent noise cannot evict every transcript anchor. A bounded per-thread turn-navigation index is rebuilt from authoritative Codex history once per app-server generation and updated with every accepted local prompt; it restores navigation after reload without making the activity journal unbounded.
- A project is a display name plus a canonical existing directory under an allowlisted root. Codex has no separate project entity; thread `cwd` binds execution to a project.
- Models and reasoning efforts come from `model/list`; the UI never hard-codes account availability.
- `instructionSources` from thread start/resume and `skills/list` are visible in the status drawer so the operator can verify that `AGENTS.md` and required skills loaded.
- The backend reads account identity, rate limits and aggregate usage through bounded app-server methods. The
  public projection exposes only the authenticated account type, email and plan label; it omits account IDs,
  credits, authentication material and unknown upstream fields. Account usage preserves the bounded daily
  buckets needed to label today and trailing 7/30-day totals separately from the upstream lifetime summary.
  When Status names a registered selected thread, the backend performs a second `account/usage/read` with that
  exact `threadId` and exposes only an explicitly estimated aggregate of input, cached input, net-new input,
  output and total tokens. It does not expose billing-route groups or invent a historical reasoning-token split
  that the thread estimate does not provide. Account-wide and selected-thread failures degrade independently to
  `null` plus a static warning.
- The authenticated owner can replace the runner's Codex account through the official app-server device-code
  flow. The API exposes the short-lived verification URL and one-time code only in process memory, never reads
  `CODEX_HOME`, and never receives an access or refresh token. Starting the flow atomically closes task
  admission and is allowed only with no root turn, pending start or active subagent; cancellation, failure or
  confirmed timeout cancellation restores admission while preserving the previous account. An indeterminate
  cancellation stays fail-closed until Codex reports a terminal login result or the API process is restarted.
  Completion refreshes the bounded account projection without deleting Web sessions, SQLite chat history or
  Codex rollout files.
- The browser handles `/status` and `/skills` locally instead of sending them as model turns. Other text, including unknown slash-prefixed text, remains an ordinary Codex prompt.
- Completed agent messages are rendered as sanitized GitHub-flavored Markdown. Raw HTML is disabled, links
  receive safe navigation attributes and wide tables scroll inside their own mobile-safe container; model
  output is never executed as JavaScript.
- The public event projection preserves only the bounded `commentary`/`final_answer` phase of completed agent
  messages. The transcript gives `final_answer` a labelled visual boundary while commentary remains visually
  neutral. For journal entries created before this phase was persisted, the last phase-less agent message of
  a successfully completed turn is treated as the compatibility final; explicit commentary is never promoted.
- Once a successfully completed turn has a final answer, its transcript projection keeps that turn's operator
  prompt and final answer; every other completed turn keeps its own pair too. Only commentary and execution
  activity are hidden. Active, failed, interrupted or final-less turns retain their progress and diagnostic
  events. After an app-server generation change, the server count-reconciles missed terminal answers, terminal
  turn state and file changes from the redacted native history into the durable journal without duplicating
  events already observed. Final answers, successful terminal turn markers and completed file changes each
  have their own bounded retention allowance, so a retained answer can still be summarized and expose its
  generated-file fallback. A compact server-persisted prompt rail navigates between
  calls without changing server state. When an older prompt predates the retained activity window, its rail
  entry targets the first retained event from that turn, or the transcript start if the entire turn has aged
  out. On narrow screens the same rail becomes horizontally scrollable.
- Relative Markdown links emitted by Codex are presented as generated project-file downloads. If a completed
  final answer omits a link, the transcript also presents completed file-change paths as authenticated project
  downloads. Both paths use the same backend route, whose canonical project checks remain authoritative: it
  resolves the requested file against the thread's registered canonical project directory, rejects absolute
  paths, traversal, symlink escape, directories and files above 100 MiB, and always serves an attachment with
  `nosniff`. External, root-relative and fragment links retain their normal link behavior.

## Voice transcription

- The browser records a short audio clip only after an explicit microphone action, decodes it locally and
  converts it to 16 kHz mono PCM16 WAV before sending one authenticated multipart request to the Web API.
  Stopping a recording never sends a Codex turn: only the final transcript is inserted into the composer for
  operator review and editing. Partial streaming is intentionally outside this first local-ASR slice.
- The browser stops a recording at the advertised duration. The API independently accepts only the canonical
  WAV shape within hard byte and decoded-duration bounds, rejects silent clips, and permits only bounded
  transcription concurrency/rate. Audio bytes are held only in memory and are never written to SQLite,
  attachment storage or logs.
- One recording receives one UUID idempotency key. A bounded ten-minute in-memory cache binds that key to the
  authenticated session and audio hash, shares an in-flight result and rejects conflicting replay; the same
  key is reused for the client's single network-error retry. The cache intentionally does not make
  transcription text durable.
- The Web API warms one CPU-only quantized Whisper pipeline before serving requests. The model and exact Git
  revision are pinned in configuration; a release-time provisioning step downloads the artifacts into the
  immutable release, records their byte lengths and SHA-256 hashes, and runtime verifies the complete file
  inventory before loading with remote models disabled. Production transcription therefore makes no external
  request and cannot download or substitute model files at runtime.
- The local pipeline runs inside the same host workload resource ceiling as the Web service and Codex runner;
  only one transcription may execute at a time. If the model is absent, corrupt or cannot be warmed,
  capabilities report transcription unavailable and the rest of Codex Web UI continues to work normally.

## Attachments

- The browser uploads each attachment before starting or steering a turn and receives only an opaque attachment ID plus safe display metadata. Uploads are scoped to their thread and stored beneath the bounded application-state directory; the original client path is never trusted.
- A start or active-turn steer may claim at most eight already uploaded attachments. Each attachment is limited to 20 MiB and the durable total is limited to 50 MiB per thread. Deleting or archiving a chat does not escape the thread boundary.
- PNG, JPEG and WebP images are signature-checked and passed to app-server as native `localImage` inputs. The UI renders them through an authenticated, thread-scoped content route. Clicking either a staged image thumbnail or a persisted message image opens the same in-app preview; the preview has an explicit close control and also closes on backdrop click or `Escape` without changing attachment state. Persisted message images retain an explicit authenticated original-file download, while staged browser blob previews do not expose a server download.
- Common text, source, PDF and office documents remain inert files in the Web API. Codex receives a backend-generated instruction containing only a server-verified internal path; the API does not parse, execute, unzip or embed their content.
- App-server `userMessage` notifications are not copied into the public event journal. The backend writes one canonical user event containing only text and safe attachment metadata, preventing duplicated messages and internal-path disclosure during streaming or history hydration.
- Fragmented agent-message deltas are not exposed because an internal path could span fragments and bypass per-event redaction. The UI receives the complete redacted agent message; other safe progress and state events continue to stream.
- Activity rows derive their short label only from the sanitized public item projection: command text, changed
  paths, public reasoning summaries, or the server/tool name. Command output may appear inside the row's
  disclosure; raw reasoning, tool arguments, credentials and hidden protocol fields are never rendered.
- Attachment IDs cannot be used across threads. Content responses use `nosniff`; non-image files are downloads rather than active browser content.
- Start and steer use the same claim lifecycle. The backend claims staged IDs before calling app-server,
  releases them only when it can prove no Codex request was accepted, preserves the claim on an ambiguous
  outcome, and binds successful files to the returned turn before publishing one safe user message.
- When this browser tab switches chats, it aborts its own in-flight uploads and removes only staged IDs that the same tab has received. It never infers ownership from another client's history. Claimed or sent attachments remain fail-closed and cannot be deleted through that cleanup path.

## Permission presets

- `read-only`: read project files and run non-mutating inspection.
- `workspace-write`: normal development inside the registered project.
- `full-access`: Codex `danger-full-access` semantics within the installed runner identity. This is bounded by
  the selected non-root account in `restricted` mode and is host-root authority in `host-admin` mode.

Restricted mode does not add sudo, root, Docker socket, product secrets, or deployment credentials. Host-admin
mode deliberately runs only the Codex app-server runner as root; the API remains non-root. The installed update
broker is not part of a Codex permission preset: it is a separate root-owned, socket-activated boundary that
accepts only `status` and `apply` for one fixed operator-staged release or one repository-reviewed runtime
target. Neither the browser nor the API can supply a URL, filesystem path, package name, version, systemd unit
or shell command.

Version discovery is deliberately outside that privileged broker. The non-root API reads only the fixed HTTPS
`@openai/codex/latest` metadata endpoint with redirects disabled, a five-second timeout, a 32 KiB response cap
and bounded semantic-version validation. Successful results are cached for fifteen minutes, failures for one
minute, and a background check runs at startup and every six hours. The authenticated browser may force the
same fixed check with an empty request but cannot supply a URL, version or package. Discovery never changes the
prepared candidate or reviewed runtime target and never makes an arbitrary npm-only CLI eligible for
activation.

Because the non-root API cannot traverse every valid host-admin project (notably `0700` paths below `/root`),
host-admin installs also use a separate read-only project-path broker. Its private socket accepts only an exact
canonicalization request from the API service identity. The broker reads the root-owned project allowlist,
opens the candidate without reading file content, resolves symlinks, checks stable inode identity, type and
canonical containment, and returns only the canonical path or a coarse error. It has no write path and is not
combined with the resource or update brokers.

## Portability

All executable source, database migrations, protocol snapshots, service templates, installer scripts and
required custom skills live in this repository. Host-specific absolute paths and credentials live only in
separate protected Web and runner environment files. The supported installer downloads exact, repository-pinned
Node.js, pnpm and Codex CLI artifacts, verifies committed digests, and installs them in immutable root-owned
version directories. Codex authentication is performed only as the explicitly selected runner through its
direct terminal. A fresh install defaults to `restricted`; `host-admin` must be named explicitly and cannot be
entered through a normal upgrade. Installation fails closed when the managed Codex CLI does not match the
checked-in compatible protocol snapshot.

The installer writes a bounded managed block into the runner's global `CODEX_HOME/AGENTS.md`, preserving other
content. It tells Codex that the Web UI runner is already executing on the physical target host and must use
local commands instead of SSHing to a loopback, current-hostname or same-host address. It also instructs Codex
to include project-relative Markdown links for user-requested deliverables created in the current project and
to link a requested archive when one is created, without exposing arbitrary host files. An explicit migration to
host-admin drains work, preserves SQLite, copies the complete Codex home without merging profiles, keeps a
root-only rollback source until health succeeds and then changes only the app-server runner identity/unit.
Because Codex persists absolute rollout paths in `state_5.sqlite`, migration and subsequent package activation
transactionally rebase stale `sessions/` and `archived_sessions/` rows from the explicitly allowlisted former
restricted-runner homes to the configured `CODEX_HOME` only when the corresponding copied rollout exists. The
allowlist includes both the packaged restricted profile and the retired server-agent profile used before the
standalone Web UI deployment. An unrecognized or missing rollout fails activation instead of silently orphaning
chat history.
Host-admin installation stores the canonical project allowlist separately for the path broker and enables that
broker before the API starts; restricted mode continues validating paths directly as its own runner-visible
roots.

Deployment secrets are kept in a root-owned `0600` environment file. systemd
loads it before changing to the unprivileged service identity, so the service
user does not receive file-read access. CPU, memory and process counts for the API and all runners are
aggregated in one workload slice. A separate root-owned, socket-activated resource broker accepts only a fixed
snapshot/apply protocol from the API service identity and can change only that slice. The default automatic
policy never allocates more than the parent cgroup/host permits and reserves at least one CPU plus 15% of RAM
(at least 1 GiB) for Ubuntu. Custom ceilings are validated against live capacity, staged while any root task or
subagent is active and applied only after the workload becomes idle. New work fails closed while a policy is
pending/degraded or live memory is unsafe. Exhaustion of an otherwise healthy execution-unit ceiling is handled
by the durable root-turn queue described below. Disk admission and a periodic guard stop work on low space
or database overflow, while an administrator-enforced filesystem quota or
dedicated bounded volume remains mandatory for a hard disk limit.
In host-admin mode these cgroup settings remain the normal operating defaults, but they are not a security
boundary against the root runner: a root task can deliberately reconfigure local systemd/cgroup state.
When the resource broker is configured, its effective root-turn/subagent ceiling is the only application
concurrency admission limit. `CODEX_WEB_MAX_CONCURRENT_TURNS` remains a fail-safe for local or test deployments
that run without the broker; it does not silently cap automatic or custom broker policy.
The effective agent ceiling is also passed to the pinned Codex thread configuration as `agents.max_threads`
when an idle thread is resumed, so descendants share the same concurrency limit; the cgroup remains the final
machine-level enforcement boundary. Automatic concurrency allows at most eight threads and budgets at least
one CPU core and 2 GiB of the selected workload memory per concurrent root/subagent slot; a custom value above
that derived ceiling is rejected.

Ordinary saturation of the effective root-turn ceiling is a scheduling state, not an admission error. The API
persists the complete root-turn request in SQLite, including its idempotency key, runtime settings and attachment
references, and returns a queued projection to the client. The selected chat displays pending requests and their
current positions after reload. A single dispatcher starts the oldest eligible request when the target thread is
idle and capacity is available; completion events and process startup both trigger reconciliation. If queued
work remains without an eligible target past a short grace period because persisted root or subagent activity
may be stale, the dispatcher performs a bounded authoritative `thread/read` reconciliation before waiting.
Only a confirmed inactive native runtime releases the occupied projection; failed or mismatched reads stay fail
closed. Reconciliation is throttled so a confirmed-live task does not cause one-second native polling, and an
ineligible chat never prevents another eligible chat from using a free slot. Claiming and state transition are
transactional so a retry, refresh or concurrent dispatcher cannot start the same request twice. Account
switching, service draining, resource-policy changes and degraded-capacity conditions remain
separate fail-closed states. Guidance sent to an already running turn continues to use the explicit steer path;
the durable queue is only for new root turns.

An authenticated operator may cancel a request only while its durable row is still `queued`. The cancellation
removes the row and its exclusively claimed attachment records in one SQLite transaction, immediately releasing
the thread quota; bounded physical-file cleanup then runs under the thread attachment lock and records any
failure for storage maintenance. A concurrent dispatcher claim wins over cancellation, so `dispatching` and
`unknown` rows cannot be cancelled and active native work is never interrupted by this operation. Successful
cancellation publishes a queue-change event so every device refreshes the remaining positions. Ambiguous
`needsReview` work stays fail closed until authoritative reconciliation.

If the API process loses the result of `turn/start`, the row is retained as visible `needsReview` work and is
never started again automatically. Recovery reads the authoritative Codex thread and matches the persisted
client message id: an existing native turn completes the queue record and attachment binding without another
side effect. Absence from a read is not proof that an earlier request cannot still be applied, so the ambiguous
outcome remains visible and fail closed; it cannot be retried, cancelled or archived through the normal UI
until Codex supplies positive evidence that resolves it. New root turns and queued followers for that same
thread are also held back so a late native turn cannot overtake a newer request; unrelated threads continue to
use the available execution slots.

## Initial API

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET/POST/PATCH/DELETE /api/projects`
- `GET /api/models`
- `GET/POST /api/threads`, `GET/PATCH /api/threads/:id`
- `POST /api/threads/:id/archive`, `POST /api/threads/:id/unarchive`; listing accepts a project-scoped `archived` filter
- `POST /api/threads/:id/turns`, `GET /api/threads/:id/queued-turns`,
  `DELETE /api/threads/:id/queued-turns/:queuedTurnId`,
  `POST /api/threads/:id/steer`, `POST /api/threads/:id/interrupt`
- `POST /api/approvals/:id/resolve`
- `POST /api/user-input-requests/:id/resolve` for typed `request_user_input` answers; secret answers are never persisted or echoed
- `POST /api/permission-requests/:id/resolve` for an explicit deny or one-turn grant derived from the validated request
- `GET /api/threads/:id/events` using SSE and `Last-Event-ID`
- `GET /api/threads/:id/subagents` for the durable root-chat subagent projection
- `POST/GET /api/threads/:id/attachments`, `GET/DELETE /api/threads/:id/attachments/:attachmentId`; uploads use multipart field `file`
- `GET /api/system/capabilities`, with an optional registered `threadId`, for safe
  version/auth/instruction/skill, rate-limit, account-usage and selected-thread usage status
- `POST /api/audio/transcriptions` for bounded ephemeral speech-to-text; uploads use multipart field `file`
- `POST /api/threads/:id/push-subscriptions/status`, plus `PUT` and `DELETE` on
  `/api/threads/:id/push-subscriptions`, for a CSRF-protected per-device chat subscription
- `GET/PUT /api/system/resource-limits` and `POST /api/system/resource-limits/apply` for the
  authenticated, CSRF-protected resource policy workflow

All state-changing routes require an authenticated session, exact Origin and a session-bound CSRF token.

An empty chat can exist locally before Codex has written a rollout for it. Archive and restore first use the
upstream Codex operation. If Codex specifically rejects that request and the local chat has no persisted events,
the Web UI records the state locally and audits the degraded path only after an exhaustive requested-state
`thread/list` read proves the thread is absent. A list error, cursor loop, page-limit exhaustion or matching ID
under another canonical project path is inconclusive and fails closed. Timeouts, unavailable Codex and failures
for chats with history remain errors rather than being silently accepted. If the mutation reached Codex but its
response was lost, the API accepts success only after the bounded read positively finds the exact thread,
canonical project path and requested archive state. An older list request cannot overwrite an archive/unarchive
mutation that completed while that list was in flight. Every successful, reconciled or ambiguous archive-state
transition invalidates the server's loaded-thread marker, because Codex unloads archived native threads; the
next turn after restore must resume the exact thread before it starts.

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

## Browser notifications

- Notifications are opt-in per chat and per browser device. The toolbar first performs an explicit
  user-gesture permission request, registers the same-origin Service Worker and submits the resulting standard
  PushSubscription through authenticated, exact-Origin and CSRF-protected routes.
- SQLite stores the endpoint and its Web Push key material because the server needs them to deliver while no
  page is open. API responses expose only the configured public VAPID key and a boolean membership result;
  endpoints and private key material are never listed, audited or logged.
- A unique terminal turn event creates at most one delivery per mapped subscription. A bounded durable queue
  resumes after restart, retries transient failures with backoff and removes an endpoint after a push service
  reports it gone. Delivery failures never change the Codex turn result.
- Payloads contain only an opaque chat identifier and a generic terminal result. They do not contain the chat
  name, prompts, answers, commands, tool output, filenames or attachment metadata. Clicking a
  notification focuses an existing same-origin page or opens the Web UI.
- VAPID credentials are generated once on the target host during installation and stored in the existing
  root-owned mode-0600 Web environment. Missing configuration or unsupported browser APIs disable only this
  optional capability.

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

## Status-drawer Codex updates

The drawer separately shows the installed CLI and the latest official upstream CLI version. It checks the
fixed registry source when Status opens, supports an explicit “check now” action and reports registry failure
without hiding the existing prepared-release state. After a completed activation, capabilities and the model
catalog are both refreshed; a still-supported selected model is preserved.

An operator may place a complete reviewed application package in the immutable release store and stage its
release identifier through the root-only host helper. When no full package is staged, the installed release may
instead expose one reviewed runtime-only target whose version, architecture archives and protocol hashes are
fixed in root-owned package files. The authenticated Status drawer can request only activation of whichever
fixed candidate the broker reports. The API keeps an admission interlock while the request is uncertain or the
worker is applying, and rejects activation unless root turns, pending starts, subagents, account login, resource
changes and voice transcription are idle.

The root broker authenticates the API peer from the Unix socket, validates root ownership and containment,
checks package/runtime target metadata and starts one fixed systemd oneshot. Full packages retain the existing
inventory, architecture and `apiCompatibility` checks. A runtime-only target is downloaded from fixed npm URLs
with no redirects, bounded before extraction, and accepted only when both published and repository-committed
SHA-512 digests match. The candidate Codex binary runs unprivileged to generate schemas and must byte-match the
reviewed protocol snapshot before drain. The worker switches immutable runtime/version-pin state, health-checks
the API/app-server and transactionally restores the previous configuration on failure. A protocol-changing CLI
still requires a compatible full release. The browser polls the broker result across the API restart.

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
