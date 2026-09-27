---
name: project-change-workflow
description: Deliver implementation-authorized repository changes with a risk-scaled fast, standard, or high-risk workflow. Use for features, fixes, refactors, migrations, configuration, tests, and documentation changes that modify a project. Small local changes take a direct fast path; formal planning and full delivery ceremony are reserved for work whose scope or risk justifies them. Do not use for read-only questions, diagnosis-only requests, status reports, or reviews with no requested edits.
---

# Project Change Workflow

Use the lightest evidence-backed lifecycle that safely fits the change while preserving the project's own
instructions, architecture, authorization boundaries, and existing user work. Do not make a small local
change pay the planning, reading, branching, reporting, or verification cost of a cross-cutting feature.

## Choose the lane first

Classify from the request, affected paths, immediate dependencies, and Git state before broad discovery:

- **Fast (`small`)**: local and reversible, one narrow owner, no shared contract, persistence, authorization,
  external side effect, concurrency, migration, production, or multi-step user-workflow boundary.
- **Standard**: a normal feature or fix spanning a user-visible workflow, shared contract, or multiple modules,
  without introducing a high-impact trust or data boundary.
- **High-risk**: security/auth, migrations, destructive or difficult-to-recover operations, concurrency or
  idempotency, public/external integrations, production paths, sensitive-data flows, or LLM-controlled effects.

When uncertain between lanes, inspect only enough nearby code and requirements to resolve the classification.
Use the higher lane only when a concrete risk or dependency warrants it, not merely because the repository is
large or mature.

## Authority and boundaries

- Read the repository's agent instructions first, then only the source documents relevant to the selected lane
  and affected boundary. Repository instructions override generic guidance in this skill.
- Authorization to implement does not authorize push, deployment, production access, paid external calls,
  destructive data operations, or unrelated cleanup.
- Follow the repository's commit policy. Otherwise commit when the user requests it or the established project
  workflow expects it; a small change does not require a new branch or multiple slice commits. Whenever
  committing, stage only owned paths and never sweep unrelated dirty files into a commit.
- Never push. The user owns push timing.
- Never merge a feature branch without the user's explicit approval. Before requesting approval, make the
  result runnable or otherwise inspectable by the user and report the verification evidence.
- Preserve an existing dirty worktree. Do not stash, reset, switch away from, overwrite, or include unrelated
  changes merely to obtain a clean state.

## Fast path for small changes

For a `small` change:

1. Read the applicable repository instructions, target implementation, nearest callers/tests, and only the
   requirement needed to preserve existing behavior.
2. Check Git state and ownership. Stay on the current branch unless the user or repository explicitly requires
   another mode.
3. Resolve discoverable details autonomously. Ask only when a missing answer would materially change behavior,
   safety, data, scope, or an irreversible outcome.
4. Make the narrow change, run the smallest meaningful focused check, inspect the diff, and commit once only
   when required by repository policy or user request.
5. Report the outcome, exact verification, and any remaining limitation concisely.

Do not use a plan tool, publish a readiness summary, create a feature branch, scan broad documentation
inventories, run the full project gate, or split the work into ceremonial slices unless the task ceases to be
small. If discovery reveals a shared boundary or higher risk, reclassify once and continue in the appropriate
lane.

## Standard and high-risk lifecycle

### 1. Discover and align

Inspect the affected implementation before asking questions. Establish only what can change the result:

- requested outcome and user-visible behavior;
- acceptance criteria and observable proof;
- in-scope and explicitly out-of-scope work;
- affected contracts, data, modules, interfaces, operations, and documentation;
- relevant invariants, risks, dependencies, and existing patterns;
- assumptions and genuinely material open questions.

Ask only questions whose answers can materially change product behavior, architecture, security, data shape,
scope, irreversible operations, or acceptance criteria. Do not ask for facts available in the repository.
If no material question remains, continue without a mandatory pause. A readiness summary is useful for
high-risk work, optional for standard work, and omitted for small work.
If a material answer is required, stop before planning or implementation and wait for it.

### 2. Select Git and execution mode

Inspect the current branch, status, staged files, and ownership before choosing a mode.

- Create `codex/<task-slug>` automatically for a substantive feature, cross-cutting change, migration,
  security-sensitive boundary, multi-agent implementation, or separately reviewable body of work when the
  worktree is safe for branching.
- Stay on the current branch for a small isolated change or a continuation already represented by the current
  worktree.
- If unrelated dirty or staged work makes branch creation unsafe, do not switch, stash, or reset it. Continue
  only when owned files can be isolated safely; otherwise explain the collision and request direction.
- A branch is an isolation mechanism, not permission to merge or push.

For standard and high-risk work, read [delivery checkpoints](references/delivery-checkpoints.md) and use its
matching verification depth. The fast path above is self-contained and does not require loading that reference.

### 3. Build the implementation plan

Create a concise dependency-ordered plan for standard work and a fully traceable plan for high-risk work. Each
item should produce a reviewable result and name its focused verification. Include documentation, contracts,
migrations, tests, review, commits, and user validation only when the change actually requires them.

Use the available plan tool for standard or high-risk work. Keep exactly one item `in_progress`; update statuses
as evidence is produced. Trace acceptance criteria to verification without creating speculative or ceremonial
items. Never create a plan solely because the skill was invoked.

### 4. Implement one verified slice at a time

For each real plan item:

1. Mark it `in_progress`.
2. Implement the smallest coherent vertical slice without drive-by refactoring.
3. Update canonical documentation when the slice changes or confirms durable product logic, a contract, an
   operational procedure, or another concern the repository explicitly requires documenting.
4. Run the smallest meaningful focused check.
5. Inspect the actual diff and update the plan.
6. Commit the slice when repository policy requires it or when it is independently reviewable and committing
   is part of the selected workflow.
7. Move to the next item only after the current result is understood.

Resolve discoverable technical details autonomously. When implementation exposes a material new choice, stop
before encoding it, summarize the evidence and choices, ask the user, then revise acceptance criteria,
documentation, plan dependencies, and any affected completed steps after the answer. Reverify earlier work
whose assumptions changed.

### 5. Route specialized work

Use focused skills instead of copying their procedures into this workflow:

- use `$systematic-debugging` for bugs and failures, selecting its fast or full lane from the evidence;
- use `$vercel-react-best-practices` only for React work with a real performance-sensitive surface;
- use `$webapp-testing` only when rendered interaction or explicit browser evidence is material;
- use `$security-threat-model` when the user or repository requires threat modeling for a changed trust
  boundary;
- use `$multi-agent-orchestrator` only when multi-agent work is explicitly authorized and there are at least
  two independent tracks with disjoint write scopes.

For multi-agent work, keep the main agent as coordinator and integrator. It owns discovery, shared contracts,
critical-path decisions, integration, final review, and reporting; it may implement tightly coupled shared
work instead of delegating it. Use high reasoning for the coordinator when configured and medium reasoning for
workers when the environment supports it. Never parallelize tasks that edit the same schema, migration,
contract index, domain policy, component, or canonical document.

### 6. Verify and review

Run checks in increasing scope and stop when the selected lane has sufficient evidence: focused tests first,
then affected integration/browser checks, then the full project gate only when task risk or repository policy
requires it. Read complete relevant outputs and report exact commands and results. A failed check is evidence,
not permission to guess; route non-trivial failures through systematic debugging.

Review the final diff inside the same task for correctness, requirements coverage, negative paths,
authorization, data safety, concurrency/idempotency, compatibility, migrations, UX/accessibility,
observability, documentation, and unrelated changes. For high-risk work, use an independent read-only reviewer
agent when multi-agent execution is authorized and its scope can remain isolated.

Do not claim success while mandatory checks are missing or red. Apply the Definition of Done in
[delivery checkpoints](references/delivery-checkpoints.md).

### 7. Report and hand off

Lead with the outcome. For standard and high-risk work, adapt the final-report template in
[delivery checkpoints](references/delivery-checkpoints.md) and include only applicable fields:

- implemented behavior and user impact;
- material architecture or product decisions;
- documentation and files changed;
- exact test/review evidence;
- commits and current branch;
- incomplete items, blockers, known risks, and rollback considerations;
- explicit merge, push, and deployment status.

If the feature is ready for user validation, explain how to run or inspect it. Request merge approval only
after that validation surface and all required gates are available. Do not push after approval or merge.
