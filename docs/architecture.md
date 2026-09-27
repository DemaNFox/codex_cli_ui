# Architecture

## Decision

Build a portable standalone service around the official Codex app-server protocol. The browser never scrapes terminal output and never connects directly to app-server.

```text
Browser
  -> reverse proxy with TLS and request limits
    -> Node.js API: login, projects, threads, turns, approvals, SSE
      -> SQLite: UI metadata, sessions, audit and bounded event journal
      -> Codex supervisor
        -> codex app-server --listen stdio://
          -> configured CODEX_HOME
          -> allowlisted project roots
```

## Runtime ownership

- One backend process owns one long-lived app-server child and restarts it with bounded backoff.
- JSON-RPC requests are correlated by generated numeric IDs. Server-initiated approval and input requests are recorded as pending UI actions.
- The backend projects safe, normalized events to per-thread SSE streams. Reconnect uses the last event ID and the durable event journal.
- Codex rollout files remain the source of truth for Codex conversation history. SQLite stores the local project registry, thread-to-project mapping, UI metadata, sessions, audit records and a bounded reconnect journal.
- A project is a display name plus a canonical existing directory under an allowlisted root. Codex has no separate project entity; thread `cwd` binds execution to a project.
- Models and reasoning efforts come from `model/list`; the UI never hard-codes account availability.
- `instructionSources` from thread start/resume and `skills/list` are visible in the status drawer so the operator can verify that `AGENTS.md` and required skills loaded.
- The backend reads account rate limits and aggregate usage through the app-server read-only account methods. Its public projection omits account identity, email, credits, authentication material and unknown upstream fields; an unsupported optional method degrades to `null` plus a static warning.
- The browser handles `/status` and `/skills` locally instead of sending them as model turns. Other text, including unknown slash-prefixed text, remains an ordinary Codex prompt.

## Attachments

- The browser uploads each attachment before starting a turn and receives only an opaque attachment ID plus safe display metadata. Uploads are scoped to their thread and stored beneath the bounded application-state directory; the original client path is never trusted.
- A turn may claim at most eight already uploaded attachments. Each attachment is limited to 20 MiB and the durable total is limited to 50 MiB per thread. Deleting or archiving a chat does not escape the thread boundary.
- PNG, JPEG and WebP images are signature-checked and passed to app-server as native `localImage` inputs. The UI renders them through an authenticated, thread-scoped content route.
- Common text, source, PDF and office documents remain inert files in the Web API. Codex receives a backend-generated instruction containing only a server-verified internal path; the API does not parse, execute, unzip or embed their content.
- App-server `userMessage` notifications are not copied into the public event journal. The backend writes one canonical user event containing only text and safe attachment metadata, preventing duplicated messages and internal-path disclosure during streaming or history hydration.
- Fragmented agent-message deltas are not exposed because an internal path could span fragments and bypass per-event redaction. The UI receives the complete redacted agent message; other safe progress and state events continue to stream.
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
the protected environment file. Installation fails closed when the installed Codex CLI does not match a
checked-in compatible protocol snapshot.

Deployment secrets are kept in a root-owned `0600` environment file. systemd
loads it before changing to the unprivileged service identity, so the service
user does not receive file-read access. CPU, memory and process counts are
bounded by the unit. Disk admission and a periodic guard stop work on low space
or database overflow, while an administrator-enforced filesystem quota or
dedicated bounded volume remains mandatory for a hard disk limit.

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
- `POST/GET /api/threads/:id/attachments`, `GET/DELETE /api/threads/:id/attachments/:attachmentId`; uploads use multipart field `file`
- `GET /api/system/capabilities` for safe version/auth/instruction/skill, rate-limit and aggregate-usage status

All state-changing routes require an authenticated session, exact Origin and a session-bound CSRF token.

The single navigation sidebar expands each project into its chat list, offers global and per-project new-chat
actions and keeps a cross-project recent list. The project context menu exposes an archived-chat view scoped
to that project. Archived threads can be inspected and restored without mixing them into the active thread
list. The transcript owns the scroll container while the composer remains in a fixed grid row.
