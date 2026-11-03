# Web UI v2 rebuild contract

Status: in progress, 2026-10-12. This document describes a replacement client, not a completed release.

The approved installation and first-run authentication target is [ADR-0003](0003-fresh-install-and-auth.md). Its six slices will be implemented and checked sequentially; this v2 client remains read-only until its write flows pass acceptance.

## Goal and reference

Build a Linux-hosted, browser-accessible Codex client whose conversation, execution and account workflows follow the reviewed official Codex app-server protocol. The `lencx/ChatGPT` repository is a useful desktop-shell design reference, but it wraps ChatGPT and is not the Codex desktop source or a Codex protocol specification. Pixel identity or unattended adoption of proprietary desktop features is not promised.

The existing authenticated Web API and private app-server process remain the security boundary. Codex rollout history remains authoritative for native turns; the existing SQLite project/session/journal data and all files remain intact. The v2 client must never infer that an API acknowledgement means a native turn started or stopped. It must distinguish accepted, queued, running, uncertain, failed and complete states using server evidence.

## Replacement strategy

The new client is built alongside the existing client and entered explicitly with `?ui=next`. This preview is read-only until its write flows have their own acceptance evidence; it must not accidentally submit a turn, approve an action or alter a project. The original client remains the default and the escape route. Do not use a database migration, delete existing history, or switch the default until the replacement passes the parity gates below. Deployment is a separate, explicitly requested operation.

The target architecture has four boundaries:

1. A version-pinned, default-deny app-server adapter. On each reviewed Codex release, compare the official generated schema, method/event allowlists and protocol tests before exposing a new capability.
2. A server-owned conversation projection. Native turn/item history and live notifications reconcile into one ordered, bounded, redacted read model. SQLite holds UI metadata, queue and reconnect evidence; it does not replace native history. Ambiguous commands remain visible and require positive reconciliation, never blind replay.
3. A client data layer. It loads an immediate bounded snapshot, walks backward with stable cursors, follows SSE only after the snapshot cursor, keeps already loaded pages through the browser session, and treats IndexedDB as a disposable cache. Missing and stale pages must have explicit retry/error states.
4. A modular interface. Project/chat navigation, conversation, composer, activities, approvals, files, agents, status and settings consume the same typed data layer. Responsive width must not hide message content or create page-level horizontal scrolling.

## Acceptance gates before default switch

- History: old and new chats show every retained user prompt and completed final answer after refresh; backward pagination reaches earlier pages without skips or duplicates. A live event racing a snapshot cannot erase a newer state.
- Execution: new turn, active steer, queue/cancel, interrupt, active descendants and uncertain starts have correct backend-authoritative status across refresh, reconnect and server restart. No write occurs from the read-only preview.
- Interaction: approvals, user input, permissions, attachment upload/preview/download, generated files, voice input, skills and account/settings either work end to end or are visibly unsupported; no silent no-op controls.
- Security: authentication, CSRF, Origin, project path allowlist, response redaction and private app-server transport stay enforced; unknown protocol variants fail closed.
- Operations: desktop and mobile browser flows pass local Playwright checks; the full repository gate passes; a rollback to the old client is possible without data conversion or task interruption.

## Slices

1. **Read-only v2 preview:** independent shell/navigation, existing safe conversation renderer, bounded history paging and SSE after the snapshot cursor. Current work; not the default UI.
2. **Write controller:** typed command states and idempotent new-turn/steer/queue/cancel/interrupt flows, with ambiguous-result reconciliation and focused restart/race tests.
3. **Interaction surfaces:** approvals, inputs, attachments, files, agents, account/settings and accessibility parity.
4. **Cutover:** browser acceptance against an isolated test runtime, data/rollback checks, then a separately authorized release and default switch.

The existing [desktop parity baseline](desktop-parity.md) remains the reviewed capability inventory until v2 replaces it. Each upstream-version check produces a candidate review, not an automatic binary or interface update.
