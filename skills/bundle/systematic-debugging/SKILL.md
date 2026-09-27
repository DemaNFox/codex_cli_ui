---
name: systematic-debugging
description: Diagnose and fix bugs, test/build failures, regressions, and unexpected behavior with evidence proportional to risk. Use a fast path for deterministic local failures with a directly supported cause; use full root-cause investigation for unclear, flaky, cross-component, performance, concurrency, production, or repeatedly failed cases. Do not turn an obvious local correction into a ceremonial multi-phase investigation.
---

# Systematic Debugging

Fix causes, not symptoms, using the lightest investigation that produces trustworthy evidence.

## Choose the lane

Use **fast debugging** only when all are true:

- the failure is deterministic or already captured by a precise failing test/error;
- one local component owns the behavior;
- direct code/error/diff evidence supports a specific cause;
- no security, sensitive data, migration, concurrency, external integration, or production boundary is involved;
- no previous fix hypothesis has failed.

Use **full debugging** when the cause is uncertain, reproduction is flaky, multiple components or environments
interact, performance/timing/concurrency is involved, production differs from local behavior, or a first
evidence-backed hypothesis fails. Do not choose the full lane merely because the repository is large.

## Fast debugging

1. Read the exact error or incorrect output, target code, nearest test, and relevant recent diff.
2. Reproduce with the smallest existing command or add the smallest regression test.
3. State one concise hypothesis supported by the evidence.
4. Make one root-cause fix; do not bundle cleanup.
5. Run the regression check and the narrow affected static/build check, inspect the diff, then stop.

Do not perform broad pattern searches, instrument unrelated layers, read complete reference implementations,
or run full suites unless the initial evidence stops being sufficient.

## Full debugging

1. **Locate the failure boundary.** Reproduce reliably where possible; read complete relevant errors; compare
   recent changes and environments. At multi-component boundaries, inspect sanitized inputs, outputs, config,
   and state without printing secrets or protected payloads.
2. **Trace the cause.** Follow bad state backward to its origin and compare with the nearest working pattern.
   Read only the reference material needed for the differing behavior.
3. **Test one hypothesis.** State why the suspected cause explains the evidence and change one variable to
   confirm or reject it. If rejected, incorporate the new evidence before forming another hypothesis.
4. **Protect and fix.** Add the smallest useful regression test, implement one root-cause correction, and run
   affected checks in increasing scope.

After three failed evidence-backed hypotheses, stop proposing patches and discuss whether the architecture,
assumptions, or environment model is wrong. For diagnosis-only requests, stop after the evidence-backed cause.
If the cause is genuinely external or timing-dependent, document what was ruled out and add bounded handling
or observability only when implementation is requested.

## Optional techniques

Read only when the case needs them:

- `root-cause-tracing.md`: deep call/data-flow origin tracing;
- `condition-based-waiting.md`: flaky timing and polling;
- `defense-in-depth.md`: validation at several layers after the root cause is known.
