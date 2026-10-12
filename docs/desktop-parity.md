# Codex desktop parity baseline

Status: implementation baseline, 2026-10-12. This is a functional target for the self-hosted browser client, not a claim that the proprietary desktop UI is reproduced or that future upstream features appear automatically.

The staged replacement is specified in [Web UI v2 rebuild contract](v2-rebuild.md). The existing client remains the default until the v2 parity and rollback gates pass.

## Reference and compatibility rule

The execution and conversation reference is the official Codex app-server protocol, pinned with the CLI in `infra/toolchain.env` and `protocol/manifest.json`. The browser must continue to use only the authenticated Web API; app-server is private. OpenAI's App Server documentation calls the interface experimental, so a new Codex version is a review candidate, not an unattended production update.

At runtime, the server checks the official npm registry for a newer Codex CLI every six hours. This is **version discovery only**. At every repository verification, `app-server-protocol.test.ts` checks the reviewed schema digest, version pin and server RPC allowlist. Candidate packages and generated schemas still pass the release/update broker's exact compatibility and rollback gates. Neither check can prove visual parity or automatically implement a new UI feature.

## Capability matrix

| Desktop-like scenario                                                     | Current Web UI                                                                                                            | Gap / next acceptance boundary                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Start, resume and archive chats; model, effort, approvals and permissions | Implemented through private app-server RPC and server-owned project policy                                                | Keep protocol contract tests when the pinned version changes.                                                                                 |
| Show final answers, work activity, attachments and files                  | Safe journal, SSE, authenticated project-file access and browser cache exist                                              | Verify each new native item type before rendering; unknown types remain denied.                                                               |
| Open a long chat and scroll old messages                                  | Immediate bounded safe tail and backward SQLite pages; native import and navigation refresh use `thread/turns/list` pages | Convert exact ambiguous recovery reads and very large individual turns to native item pagination without weakening reconciliation.            |
| Queue, steer, stop and recover work                                       | Local durable queue and explicit uncertain-state recovery                                                                 | Compare with native queue and steering semantics at the next reviewed protocol upgrade; do not silently replay unknown starts.                |
| Use the same account and capabilities                                     | Runner owns Codex login; model/skill catalog and usage are projected safely                                               | App-specific/host-specific desktop integrations may have no public app-server equivalent. Label those unavailable.                            |
| Keep pace with new Codex releases                                         | Six-hour version discovery; pinned schema/digest and update gates                                                         | Review upstream change, update this matrix and tests, stage a compatible package, then deploy separately. No blind binary or UI auto-upgrade. |

## Next slices

1. Eliminate remaining full-history reads for exact queued-start, quota and child reconciliation using native turn/item evidence with race, cancellation and restart tests.
2. Make the Web capability surface driven by the reviewed protocol: expose only implemented interactions and show a clear unsupported state for gated methods.
3. Run browser acceptance for the primary desktop workflows (long-history navigation, active steering, approval, file output and recovery) at desktop and mobile widths, then compare gaps against each reviewed Codex release.

Changes to the repository do not deploy themselves. Production work and long-running agents must be handled through the existing drain and recovery process only after an explicit release request.
