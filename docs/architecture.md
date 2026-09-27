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
- `instructionSources` from thread start/resume and `skills/list` are visible in diagnostics so the operator can verify that `AGENTS.md` and required skills loaded.

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
- `GET /api/system/capabilities` for safe version/auth/instruction/skill diagnostics

All state-changing routes require an authenticated session, exact Origin and a session-bound CSRF token.

The project context menu exposes an archived-chat view scoped to that project. Archived threads can be
inspected and restored without mixing them into the active thread list.
