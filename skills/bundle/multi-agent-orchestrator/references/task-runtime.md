# Task Runtime

Load this layer to create execution state, briefs, handoffs, or ledger entries.

## Bounded TaskSpec

Create one TaskSpec for the user outcome and smaller child specs only for independently owned work.

```yaml
task_spec:
  id: T-...
  outcome: "observable end state"
  acceptance:
    - criterion: "observable behavior or invariant"
      evidence: "test, inspection, diff, measurement, or review"
  in_scope: []
  out_of_scope: []
  constraints: []
  risk: R1
  dependencies: []
  write_scope: []
  context_budget: { lane: Terra, target_tokens: 30000 }
  stop_conditions: []
```

Keep it short. Link evidence or intelligence nodes instead of embedding source material.

## Context-local decomposition

Split by independently verifiable ownership, not by arbitrary phases. Good child tasks minimize shared context and have a specific artifact or conclusion. Preserve the critical integration path with the coordinator.

Each worker brief includes:

- objective and TaskSpec id
- owned and forbidden scope
- bounded context package and negative context
- allowed mutations and authority limits
- expected artifact/evidence
- stop/escalation conditions
- reminder that worker completion is a claim, not final acceptance

Workers sharing a filesystem must not revert or overwrite unrelated changes. One writer owns each overlapping surface.

## Compressed handoff

Return a decision-ready handoff:

```yaml
handoff:
  task_id: T-...
  status: done | partial | blocked | failed
  result: "short outcome summary"
  changed: ["artifact pointers"]
  decisions: ["decision + reason"]
  evidence: ["command/result or inspection pointer"]
  risks: []
  context_requests: []
  dirty_nodes: []
```

Do not propagate chain-of-thought, raw terminal output, or the full conversation. Retain raw evidence by pointer only when needed for audit/debugging.

## Task Ledger

The ledger is append-oriented execution memory, not a transcript. Record:

- TaskSpec and actual lane/model/topology
- intelligence and context node ids used
- context expansions and exclusions
- state transitions and handoffs
- deterministic verification and independent review outcomes
- acceptance decision and residual risk
- dirty nodes, experience observations, and accounting record ids

Use compact structured entries. Corrections append a superseding entry rather than silently rewriting history. Prune or archive raw details through the Token Accountant policy while retaining the accepted outcome and evidence pointers.
