# Optimization Engine

Load this layer when repeated evidence suggests a routing, context, verification, or compaction policy change.

## Safety boundary

Optimization may update a reversible policy overlay or candidate record. It must not automatically edit `SKILL.md`, project instructions, safety constraints, user permissions, or acceptance ownership.

Every policy change follows:

```text
observation → candidate → evidence threshold → shadow evaluation
            → promote | reject → monitor → keep | revert
```

## Candidate record

```yaml
candidate:
  id: C-...
  proposed_rule: "specific routing/context/verification change"
  scope: "task/module/risk conditions"
  hypothesis: "expected measurable improvement"
  evidence_ids: []
  guardrails: []
  baseline_window: []
  status: candidate | shadow | promoted | rejected | reverted
  owner: orchestrator
```

## Evidence thresholds

Use project-configured thresholds when present. Otherwise use conservative defaults:

- create a candidate after at least 3 comparable outcomes or one severe, clearly causal failure
- start shadow evaluation only when evidence spans at least 2 tasks or independent verification paths
- promote after at least 8 comparable shadow decisions with no severe regression, and only when successful-task cost or reliability improves meaningfully against baseline
- reject when the predicted benefit is absent or guardrails would be weakened
- revert immediately on a severe regression; otherwise revert after 2 consecutive material regressions or a statistically/operationally persuasive negative window

Small samples do not justify automatic global rules. High-impact candidates require human review or explicit project policy even after thresholds pass.

## Shadow routing

During shadow mode, keep the active route unchanged and record what the candidate would have selected, its predicted context/cost, and whether the final outcome supports that prediction. Do not pay for duplicate execution solely to test a candidate unless the user authorized that cost.

## Promotion and rollback

A promoted overlay must include version, scope, evidence, activation time, guardrails, monitoring window, and a direct rollback target. Precedence is:

```text
user/project instructions > core skill > approved project overlay > experimental candidate
```

Optimization reports compare against baselines from the Token Accountant. Success is lower cost per externally accepted task without increased severe failures, hidden rework, or weakened verification.
