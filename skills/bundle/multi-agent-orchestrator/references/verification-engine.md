# Verification Engine

Load this layer while defining acceptance and after implementation or analysis produces a claim.

## Acceptance ownership

The orchestrator or an independent verifier decides whether TaskSpec criteria are met. Worker self-tests are evidence, not acceptance. Never ask a cheaper or weaker worker to mark its own work successful.

Use a separate reviewer/fixer when risk is R2–R3, the change is security/data/migration sensitive, the worker had to infer requirements, or verification requires judgment. For R1, coordinator review plus deterministic checks may be enough.

## Verification order

1. Confirm the delivered scope and inspect the relevant diff/artifact.
2. Run the cheapest deterministic checks that can falsify the result.
3. Run targeted tests at the changed boundary.
4. Add integration, regression, or adversarial checks according to risk.
5. Have an independent reviewer evaluate the remaining judgment-heavy criteria.
6. Compare all evidence with every TaskSpec criterion; accept, issue a delta brief, or escalate.

Do not run an enormous generic suite when a focused check provides earlier evidence, but do not substitute focused tests for required project-wide gates.

## Review matrix

| Change surface | Deterministic evidence | Targeted review | Adversarial focus |
|---|---|---|---|
| Logic / bug fix | focused tests, repro before/after, static checks | boundary and regression paths | nearby inputs that preserve the old failure |
| API / contract | schema/type checks, consumer tests | compatibility and error semantics | malformed, missing, old-version clients |
| Data / migration | dry run, invariants, rollback proof | loss, ordering, idempotency | partial failure and replay |
| Security / auth | policy tests, permission matrix | trust boundaries and bypasses | confused-deputy, privilege escalation, fail-open |
| Concurrency / async | deterministic stress where possible | ordering and ownership | cancellation, timeout, duplicate delivery, race windows |
| UI / workflow | component/e2e checks, accessibility checks | user flow and state transitions | keyboard, empty/error/loading, responsive behavior |
| Config / build | parse/build/lint and clean-environment check | defaults and portability | missing env, version skew, rollback |
| Docs / analysis | link/schema checks and source traceability | completeness against request | ambiguous or unsupported claims |

## Findings and fixes

Reviewers report criterion, severity, exact evidence pointer, and smallest reproducible concern. The fixer receives only the delta brief plus necessary context. Re-run the failed check and impacted gates after a fix.

Escalate rather than loop when two fixes fail the same criterion, the reviewer disputes the TaskSpec, or evidence exposes a broader architectural issue.

Acceptance records must say which criteria passed, which evidence supports them, what was not verified, and any residual risk.
