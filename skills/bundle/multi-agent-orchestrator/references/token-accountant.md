# Token Accountant

Load this layer to record efficiency, compare baselines, compact hot context, or garbage-collect runtime state.

## Measurement rules

Use exact provider/tool usage when exposed. If exact tokens or prices are unavailable, record `unknown` plus observable proxies such as context items, file bytes, calls, retries, and elapsed work. Never invent token counts or prices.

Primary unit:

```text
tokens_per_successful_task = total attributable tokens / externally accepted tasks
```

Keep failed/abandoned task cost visible. A low-token task that fails acceptance is not a success.

## Core metrics

- input/output tokens by coordinator, worker, reviewer, and lane
- context redundancy: unused or duplicated context divided by supplied context
- escalation rate and escalation cause
- rework rate and repeated-criterion failures
- map hit rate: tasks using valid intelligence without broad rediscovery
- context hit rate: initially supplied items later marked useful
- context-request precision: granted items that resolved the stated decision
- reviewer usefulness: actionable accepted findings divided by review effort; track false positives separately
- successful-task latency and deterministic-check cost
- severe false-success or post-acceptance regression count

Segment comparisons by task type, risk, module, and lane. Do not compare unlike work as if it were one population.

## Baselines

Maintain rolling project baselines and, when useful, a pre-runtime baseline. Record window, sample size, routing policy version, and missing data. Compare medians and failure/rework rates rather than relying only on averages distorted by large tasks.

An optimization win requires equal or better external acceptance quality and a meaningful improvement in total cost, latency, or context efficiency.

## Hot-context compaction

Compact when a working set nears its soft budget, after a stable milestone, or before handing work to a new role. A hot summary contains:

- active TaskSpec and remaining criteria
- current hypothesis/decision state
- relevant intelligence node ids and exact artifact pointers
- changes/evidence already produced
- unresolved risks and explicit context requests
- negative context and discarded hypotheses

Never compact away acceptance failures, permission limits, unresolved contradictions, or source pointers needed to recover detail.

## Garbage collection

Apply retention by value and recoverability:

- retain accepted TaskSpecs, final evidence pointers, decisions, promoted/reverted policies, and durable experience
- archive or compress closed ledger details after their audit window
- delete duplicate raw outputs and expired caches only when their summarized evidence is retained or they are reproducible
- remove stale intelligence only after confirming it is superseded or cheaply rebuildable
- preserve failure summaries longer than verbose success traces because they protect against repeat mistakes

GC is incremental and scoped. Never recursively delete broad project or user directories. Record material removals and whether they can be rebuilt.
