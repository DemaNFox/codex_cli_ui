# Context Resolver

Load this layer whenever constructing or expanding a worker/reviewer context package.

## Progressive disclosure

- **L0 — project map:** relevant project purpose, constraints, and module index.
- **L1 — module cards:** responsibilities, interfaces, ownership, and dependency boundary.
- **L2 — symbols and contracts:** signatures, types, schemas, callers/callees, tests, and ADR excerpts.
- **L3 — focused excerpts:** only the implementation ranges needed for the task.
- **L4 — complete files:** when local interactions, formatting, or edits require full-file understanding.
- **L5 — dependency expansion:** adjacent modules or transitive behavior, granted only for a stated reason.

Start at the lowest sufficient level. Search filenames, symbols, imports, references, and tests before opening files. Do not substitute a broad repository read for a precise search.

## Context package

Every non-trivial worker brief should carry:

- TaskSpec id and bounded objective
- relevant intelligence node ids/summaries
- exact source/test/decision pointers
- allowed write scope and forbidden scope
- known dependencies and assumptions
- **negative context:** directories, historical threads, generated files, or hypotheses intentionally excluded
- acceptance evidence expected from that worker
- context budget and current disclosure level

Negative context prevents repeated exploration and makes exclusions reversible: a worker may request a named excluded item with a reason.

## Default working-set budgets

These are initial prompt/context targets, not claims about a model's context-window limit.

| Lane | Target | Soft limit |
|---|---:|---:|
| Luna | 12k tokens | 25k |
| Terra | 30k tokens | 60k |
| Sol | 50k tokens | 100k |

The actual hard limit is the currently exposed model/tool limit; never guess it. Prefer summarization or a more focused task over approaching it.

Crossing a soft limit requires either compaction or an explicit context request:

```yaml
context_request:
  task_id: T-...
  reason: "Why current context is insufficient"
  requested:
    - "exact symbol, file, decision, or dependency"
  expected_decision: "What this context will resolve"
  disclosure_level: L3
```

The orchestrator grants, narrows, or rejects the request. Context expansion is logged so usefulness can be measured later.

## Usefulness and redundancy

Mark a context item useful when it directly supports a decision, edit, failed hypothesis elimination, or verification. Mark it redundant when already represented by a trusted summary or never used. Do not punish necessary negative findings: a targeted search that rules out a plausible cause can be useful.

When multiple workers need the same source, share one compact intelligence node or artifact pointer rather than pasting duplicate content.
