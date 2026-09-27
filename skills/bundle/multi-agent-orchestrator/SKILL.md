---
name: multi-agent-orchestrator
description: Orchestrate non-trivial repository work through bounded context, risk/cost-aware model routing, external verification, reusable project intelligence, and evidence-gated optimization. Use for substantial features, bug fixes, refactors, migrations, investigations, reviews, or explicitly delegated multi-agent work; skip the full runtime only for genuinely trivial R0 changes.
---

# Self-Optimizing Orchestration Runtime

Coordinate repository work as a compact control plane. Optimize for successful-task cost and correctness, not the cheapest individual call.

## Non-negotiable invariants

- Information moves upward as summaries and downward as bounded context.
- Keep raw transcripts, full files, and broad search results out of handoffs. Store or retain them for lazy access when the environment permits.
- The orchestrator owns acceptance. A worker, especially a cheaper worker, never certifies its own result.
- Search and project intelligence come before broad file reads. Reuse valid knowledge instead of rescanning.
- Update only dirty intelligence nodes and affected ancestors or dependency edges.
- Treat learned rules as candidates. Never rewrite this core skill automatically.
- Use only models, agent controls, and tools actually exposed in the current session. Do not invent API names or calling syntax.
- Preserve user authority and existing workspace changes. Orchestration does not broaden permission.

## Entry gate

Classify the request before loading detailed protocols.

- **R0 — direct path:** one obvious, local, reversible change; no meaningful dependency, behavior, data, security, or rollout risk. Make the change cheaply and run a focused check. Do not create runtime ceremony.
- **R1–R3 — runtime path:** multi-file work, unclear diagnosis, behavioral changes, dependency or schema impact, broad blast radius, migrations, security-sensitive work, or anything requiring decomposition/review.

Subagents are optional execution resources, not the definition of orchestration. Use them only when clean ownership, parallelism, specialization, or independent review improves expected total cost. Keep tightly coupled critical-path work local.

## Runtime loop

For R1–R3 work:

1. **Orient.** Locate project instructions and the project-local orchestration state. If Project Intelligence is absent, bootstrap it once with the strongest appropriate available model. Otherwise validate only relevant fingerprints and TTLs.
2. **Bound.** Create a concise TaskSpec with outcome, acceptance evidence, scope, constraints, risk, and context budget.
3. **Resolve.** Assemble the smallest useful context package through L0–L5 progressive disclosure. Record excluded areas as negative context.
4. **Route.** Select Luna, Terra, or Sol by task type, risk, uncertainty, dependency/blast radius, and expected total cost including retries and review.
5. **Execute.** Decompose around local context and disjoint ownership. Pass summaries and artifact pointers, never growing conversation dumps.
6. **Verify.** Run deterministic checks first, then independent targeted or adversarial review proportional to risk. Separate fixer and reviewer whenever practical.
7. **Accept or escalate.** The orchestrator compares evidence with the TaskSpec. On failure, issue a narrow delta brief or escalate model/context; do not restart discovery blindly.
8. **Learn incrementally.** Update the Task Ledger, dirty intelligence nodes, useful experience, and accounting metrics. Evaluate policy candidates without modifying core rules.

## Lazy-loaded layers

Read a layer only when its trigger is reached; do not preload every reference.

| Trigger | Read |
|---|---|
| No map, suspected staleness, changed repository structure, or post-task map update | [Project Intelligence](references/project-intelligence.md) |
| Building or expanding a context package | [Context Resolver](references/context-resolver.md) |
| Choosing model/agent topology or considering escalation | [Risk/Cost Router](references/risk-cost-router.md) |
| Creating TaskSpec, delegation briefs, handoffs, or Task Ledger entries | [Task Runtime](references/task-runtime.md) |
| Defining acceptance or reviewing outputs | [Verification Engine](references/verification-engine.md) |
| Recording reusable success/failure/context observations | [Experience Engine](references/experience-engine.md) |
| Testing or promoting learned routing/context rules | [Optimization Engine](references/optimization-engine.md) |
| Measuring efficiency, baselines, compaction, or garbage collection | [Token Accountant](references/token-accountant.md) |

## Runtime state

Prefer a project-local `.codex/orchestration/` directory when persistent state is useful and allowed. Create only the files needed by the active task. Keep generated state out of version control unless the project explicitly wants it tracked.

Suggested logical areas are `intelligence/`, `ledger/`, `experience/`, `metrics/`, `candidates/`, and `raw/`. A repository may map these concepts to an existing convention; do not create a parallel system when compatible state already exists.

Global experience is limited to stable, project-agnostic observations. Store it only in the active Codex user-data location when that location is discoverable and writable. Project facts, paths, commands, and conventions remain project-local.

## Completion contract

Report the accepted outcome, evidence, residual risk, and material state updates. Keep detailed worker transcripts lazy. If the runtime could not verify an acceptance criterion, say so explicitly; completion is not inferred from a worker's confidence.
