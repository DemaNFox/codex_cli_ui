# Codex Web UI agent guide

This repository is a standalone, portable Codex server package. Its supported Ubuntu installer bootstraps the repository-pinned Node.js, pnpm and Codex CLI toolchain, then installs the Web UI. It must not depend on or modify any hosted product repository.

## Product boundary

- The browser talks only to this service over HTTPS. Never expose `codex app-server` directly to the network.
- The backend owns one local `codex app-server --listen stdio://` process and validates every JSON-RPC message crossing the boundary.
- The installer offers two explicit runner modes. `restricted` is the default and runs Codex as a configured
  non-root Linux user inside the hardened app-server unit. `host-admin` is an operator-selected dedicated-host
  mode and runs Codex as root without the runner filesystem/capability sandbox, so authenticated Codex turns may
  administer the whole machine. The browser-facing API always remains the separate non-root
  `codex-web-ui-api` identity and never receives sudo, the Docker socket or a general root helper. The installed
  update control may call only the fixed root broker for either an operator-staged compatible full release or
  the single repository-reviewed Codex runtime target; it must never accept a browser-supplied package, path,
  URL, version, command or unit. Runtime-only activation must match committed archive digests and the reviewed
  app-server protocol byte-for-byte before any installed configuration changes.
- Projects are existing directories beneath configured real-path allowlisted roots. Reject traversal, symlink escape, and unregistered working directories.
- OpenAI credentials remain in the server-side `CODEX_HOME`; never return, log, persist, or accept them through the browser API.
- Bootstrap Codex authentication only as the selected runner identity through its direct terminal. Root device
  authentication is allowed only after the operator explicitly selects `host-admin`; restricted mode must still
  reject it. After bootstrap, an authenticated owner may start the pinned app-server device flow in the Web UI
  only while all root turns, pending starts and subagents are idle. Never persist or log a device code, or
  accept an OpenAI token through installer arguments, logs, or the Web UI.
- The installed global Codex instruction states that the runner already executes on the physical Web UI host.
  Use local filesystem and service-manager commands for that host and never SSH to localhost, loopback, the
  current hostname or another address assigned to the same machine. SSH is for a user-identified remote host.
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
