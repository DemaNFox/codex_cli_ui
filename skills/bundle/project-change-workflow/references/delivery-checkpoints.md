# Delivery checkpoints

Use this reference for standard and high-risk repository changes. The small-change fast path is defined in
`SKILL.md` and should not load or execute these checkpoints unless discovery reclassifies the task.

## Risk classification

### Small

A local, reversible change with one narrow owner and no contract, persistence, authorization, external-side-
effect, or user-workflow boundary change.

Typical evidence: focused tests, relevant static check, diff review, and one commit.

Execution rule: use the fast path in `SKILL.md`. No formal plan, readiness summary, feature branch, exhaustive
documentation scan, full gate, or multi-slice reporting is required unless repository policy explicitly says
otherwise.

### Standard

A feature or fix spanning a normal application boundary, user-visible workflow, multiple modules, or a shared
contract without a new high-impact trust or data boundary.

Typical evidence: focused tests, affected integration or browser checks, relevant build/static gates, final
diff review, user-validation instructions, and one or more vertical-slice commits.

### High-risk

A migration, security/auth boundary, destructive or difficult-to-recover operation, concurrency/idempotency
change, public/external integration, production path, sensitive-data flow, or LLM-controlled side-effect path.

Typical evidence: documented design decision, failure/rollback plan, focused and integration tests, applicable
security or browser review, full repository gate, independent read-only review when authorized, explicit user
validation, and merge approval.

## Definition of Ready (standard and high-risk)

Planning may begin when:

- the requested outcome and user-visible behavior are understood;
- acceptance criteria are observable;
- scope and non-goals are explicit;
- relevant repository requirements and existing patterns were inspected;
- affected boundaries and task risk are identified;
- every material open question is answered or its assumption is explicitly authorized;
- external actions and destructive operations have the necessary authority;
- the Git mode is safe for the current worktree.

If these conditions are already satisfied, continue without a ceremonial approval pause. Summarize readiness
only when it helps the user evaluate meaningful risk or scope.

## Plan item contract (standard and high-risk)

Each plan item should state:

- the result, not merely an activity;
- owned files or architectural surface;
- prerequisites and downstream dependents;
- applicable documentation or decision record;
- focused verification that proves the result;
- whether it forms an independently committable vertical slice.

Keep one item in progress. When a material discovery invalidates the plan, revise downstream items and mark
completed items for revalidation instead of silently working from a stale plan.

## Branch decision matrix

Use a `codex/<task-slug>` branch when the work is substantive, cross-cutting, separately reviewable,
multi-agent, security-sensitive, or changes migrations/contracts. Use the current branch for a small isolated
change or an explicit continuation already present in the worktree.

Do not create or switch branches when unrelated dirty/staged files could be carried, hidden, overwritten, or
misattributed. Never use stash or reset as automatic branch preparation. Merge only after explicit approval
and after the user has a practical way to run, inspect, or accept the result. Never push.

## Verification ladder

This is a ladder, not a checklist. Start at the narrowest relevant rung and climb only as required by the
selected lane, changed boundary, acceptance criteria, or repository policy.

1. Reproduce the pre-change failure or establish the baseline when applicable.
2. Run the narrowest unit/component/contract test for the slice.
3. Run the affected package's lint and typecheck/build checks.
4. Run integration tests for changed persistence, queue, API, or external boundaries.
5. Run browser interaction checks for changed user-visible behavior.
6. Run the full repository gate required by project instructions and risk.
7. Inspect exit codes, complete relevant output, and the final diff.

Do not substitute a passing linter for a test, a component test for browser behavior, or a mock for an
explicitly required integration gate.

## Self-review checklist

- Every acceptance criterion maps to implemented behavior and evidence.
- Failure, empty, stale, unauthorized, duplicate, and concurrency paths are handled where relevant.
- Schema, API, generated types, persistence, and consumers remain compatible.
- Authorization and business policy are enforced at the backend boundary.
- Sensitive data, logs, errors, screenshots, fixtures, and reports follow redaction rules.
- Migrations are forward-safe and have an appropriate recovery or forward-fix plan.
- User-visible behavior covers accessibility, keyboard, responsive, loading, error, and offline states as
  applicable.
- Operational behavior is observable without claiming persisted projections are live telemetry.
- Documentation describes the implemented behavior once in its canonical location.
- The diff contains no unrelated formatting, cleanup, generated output, secrets, or user-owned changes.

## Definition of Done

The change is complete only when:

- acceptance criteria and mandatory checks pass;
- the final diff has been reviewed;
- required product, implementation, and operational documentation is current;
- each completed slice is committed with only owned paths;
- incomplete work and known risks are explicit;
- the feature has a user-validation path when user-visible;
- merge awaits explicit approval;
- no push or deployment occurred without separate authorization.

## Final report template (standard and high-risk)

```text
Outcome
- What now works and what changed for the user.

Implemented
- Completed behavior and important decisions.

Changed artifacts
- Canonical documentation and key code paths.

Verification and AI review
- Exact commands, results, browser/integration evidence, and review findings resolved.

Not completed / risks
- Missing gates, blockers, known limitations, recovery concerns, or follow-up work.

Git state
- Branch, commit hashes, merge status, push status, and deployment status.

How to validate
- Exact local or safe test steps available to the user.
```
