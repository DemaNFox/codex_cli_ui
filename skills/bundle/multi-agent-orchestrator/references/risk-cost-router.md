# Risk/Cost Router

Load this layer before choosing the execution model, reviewer, agent topology, or escalation.

## Routing inputs

Assess:

- task type: discovery, design, implementation, debugging, migration, verification, documentation
- failure impact: correctness, data, security, privacy, compatibility, operations, reversibility
- uncertainty: clarity of cause/specification and quality of existing intelligence
- dependency depth and estimated blast radius
- context size and tool requirements
- parallelizability and ownership clarity
- expected retries, review effort, and cost of a false success

Assign R0–R3 risk. Increase risk for unknown dependencies or unverifiable acceptance; do not lower it because the proposed patch is small.

## Capability lanes

Choose only among model identifiers actually advertised by the current environment. These lane names express capability/cost intent:

- **Luna:** narrow searches, inventory, boilerplate, deterministic edits, focused tests, and other bounded low-risk work.
- **Terra:** default engineering lane for substantial implementation, debugging with a supported hypothesis, and mixed reasoning/tool use.
- **Sol:** ambiguous architecture, high-risk changes, broad synthesis, difficult root-cause work, adversarial review, and recovery after repeated failure.

When current models named Luna/Terra/Sol are available, use the matching family. Otherwise select the nearest exposed capability or inherit the coordinator model, and record the actual choice. Never manufacture a model id.

## Expected total cost

Optimize this quantity rather than per-call price:

```text
expected_total_cost = execution
                    + context preparation
                    + deterministic verification
                    + independent review
                    + P(rework) × rework cost
                    + P(escalation) × escalation cost
                    + P(false success) × failure impact
```

Qualitative estimates are acceptable when exact prices or probabilities are unavailable. Record assumptions; do not invent precision.

Use the cheapest lane whose expected total cost is lowest after failure risk. A cheap first attempt is wasteful when failure predictably forces full rediscovery.

## Topology rules

- Keep the coordinator/integrator local.
- Delegate only context-local work with one clear owner and bounded write scope.
- Parallelize independent surfaces; serialize tasks with shared invariants or the same write set.
- If two roles touch the same area, make one read-only or sequence them.
- Reuse a worker for a narrow correction when its context remains valid; use a fresh reviewer for independent judgment.

## Escalation

Escalate lane, context level, or decomposition when:

- the same acceptance criterion fails twice
- evidence contradicts the working model
- blast radius is larger than routed
- required context repeatedly exceeds the lane's soft limit
- a worker reports an unresolved permission, data, security, or migration risk
- reviewer findings show systemic rather than local defects

Escalation briefs contain the failed criterion, evidence, attempted fix, and smallest missing context. Do not replay full transcripts or silently repeat the same route.
