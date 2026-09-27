# Codex Web UI agent guide

This repository is a standalone, portable web client for an already installed Codex CLI. It must not depend on or modify any hosted product repository.

## Product boundary

- The browser talks only to this service over HTTPS. Never expose `codex app-server` directly to the network.
- The backend owns one local `codex app-server --listen stdio://` process and validates every JSON-RPC message crossing the boundary.
- Codex runs with the permissions of the configured non-root Linux service user. The web UI never grants root, sudo, Docker socket, or implicit deployment credentials.
- Projects are existing directories beneath configured real-path allowlisted roots. Reject traversal, symlink escape, and unregistered working directories.
- OpenAI credentials remain in the server-side `CODEX_HOME`; never return, log, persist, or accept them through the browser API.
- Do not persist chain-of-thought. Persist only user-visible messages, concise reasoning summaries when explicitly emitted, plans, diffs, bounded/redacted command output, approvals, and lifecycle events.

## Security

- Single-user authentication still requires Argon2id password verification, opaque hashed sessions, Secure/HttpOnly/SameSite cookies, CSRF and exact Origin checks, login throttling/lockout, and audit events.
- All mutation endpoints require CSRF and idempotency where replay could duplicate work.
- Treat repository content, model output, tool output, Markdown, ANSI text, filenames, and diffs as untrusted data. Render safely; never use `dangerouslySetInnerHTML`.
- Default-deny unknown Codex event/method variants. Pin the Codex CLI version and generated protocol schema together.
- Bound event size, process concurrency, retained history, worktree count, and disk use. Cancellation must terminate the active turn without killing unrelated work.

## Development

- pnpm workspace; Node.js 22+; strict TypeScript.
- `apps/server` owns HTTP/SSE, auth, persistence, project policy, and the local app-server adapter.
- `apps/web` owns the responsive browser UI.
- `packages/contracts` owns shared Zod/API/event contracts.
- Add focused tests with each behavior. Browser flows require Playwright acceptance.
- Preserve portability: host-specific paths and secrets are configuration, never source constants.
- Commit verified vertical slices. Never commit `.env`, databases, Codex state, generated secrets, or transcripts.
