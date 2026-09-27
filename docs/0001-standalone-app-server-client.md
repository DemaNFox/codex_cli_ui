# ADR-0001: standalone Codex app-server client

Status: accepted, 2026-09-27.

## Context

The operator needs an always-on browser interface for Codex running on Ubuntu, with desktop-like projects, chats, progress, approvals and model controls. The service must be reusable on another server and must not become part of any product repository.

## Decision

Use `codex app-server` over local stdio JSONL as the execution and conversation protocol. Implement a standalone Node.js backend and React frontend. Keep website authentication independent from the server-side OpenAI login. Maintain project metadata in local SQLite and bind Codex threads through canonical `cwd` paths.

Do not expose the experimental app-server WebSocket transport. Do not scrape the terminal or base the interactive UI on `codex exec`. Do not grant the service root or Docker access.

## Consequences

- The UI can use native thread, turn, event, approval, model and skill primitives.
- The installed Codex version and generated protocol schemas must be upgraded together.
- Browser security, resource admission, persistence projection and recovery remain responsibilities of this service.
- Full-access mode means the configured Linux user's authority, not host root authority.
