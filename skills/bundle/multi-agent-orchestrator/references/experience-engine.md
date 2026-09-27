# Experience Engine

Load this layer after acceptance/failure or when prior observations may improve a route.

## Scope

Experience captures reusable observations, not mutable core rules and not raw transcripts.

- **Project-local:** repository commands, fragile boundaries, recurring failure modes, useful context nodes, route outcomes, reviewer findings, and branch/toolchain caveats.
- **Global:** only stable project-agnostic lessons such as a generally effective decomposition or verification pattern. Never copy project secrets, paths, proprietary facts, or user content into global memory.

## Observation schema

```yaml
observation:
  id: E-...
  scope: project | global
  claim: "concise reusable observation"
  kind: success | failure | context_usefulness | routing | verification
  evidence: ["ledger/evidence ids"]
  conditions: ["when this applies"]
  counterexamples: []
  confidence: low | medium | high
  observed_at: "timestamp"
  ttl_class: structural | operational | volatile
```

Keep success and failure evidence. A successful outcome is not enough to infer causality; record the conditions and alternative explanations.

## Context usefulness

For each context package, record which items were:

- decisive for an edit or decision
- useful for ruling out a hypothesis
- required only for verification
- redundant with a trusted summary
- irrelevant to the outcome
- missing and later requested

Use these observations to improve future context selection and summaries. Do not delete a source merely because one task did not use it.

## Retrieval and decay

Retrieve by task type, module/node id, risk, and failure signature. Prefer recent evidence under similar conditions. Mark observations stale when their supporting intelligence fingerprints change or their TTL expires.

Conflicting observations coexist until a stronger evidence set resolves them. Never silently overwrite failure history with a later success.

Experience can nominate an Optimization candidate; it cannot promote itself into policy.
