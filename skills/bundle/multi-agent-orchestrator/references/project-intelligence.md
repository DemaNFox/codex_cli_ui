# Project Intelligence

Load this layer for initial mapping, targeted refresh, invalidation, or post-task updates.

## Purpose

Maintain a hierarchical, evidence-linked model of the repository so later tasks can navigate by summaries before reading code.

```text
project
├── modules
│   ├── files
│   │   └── symbols
│   └── dependency edges
├── decisions / ADRs
├── conventions and verified commands
└── fingerprints, freshness, and provenance
```

Each node should be independently loadable and include only what helps routing or context selection:

- stable id and kind (`project`, `module`, `file`, `symbol`, `decision`, `convention`)
- purpose or responsibility summary
- path and symbol locator when applicable
- public interfaces and significant inbound/outbound dependencies
- behavioral or ownership boundaries
- evidence pointers, fingerprint, observed time, TTL class, and confidence
- dirty/stale state and reason

Do not copy full source, logs, or transcripts into intelligence nodes.

## One-time bootstrap

When no compatible map exists:

1. Use the strongest appropriate model currently available for architectural synthesis.
2. Inventory project instructions, manifests, top-level structure, build/test entry points, major modules, and documented decisions.
3. Search for symbols and dependency edges before opening representative files.
4. Build project and module summaries first; expand only central or immediately relevant symbols.
5. Record fingerprints and provenance so future tasks can refresh incrementally.

Bootstrap is not a license to read the whole repository. Large or generated trees should remain summarized or excluded. If no stronger model can be selected, use the inherited model and record that limitation.

## Incremental validation and invalidation

Validate only nodes relevant to the current TaskSpec plus their direct dependency boundary.

- Prefer repository identity, revision, file metadata, content hash, manifest/lockfile changes, and symbol search results as fingerprints when available.
- A changed file dirties its file node, contained symbols, affected dependency edges, and ancestor summaries.
- A manifest, schema, public interface, or shared configuration change also dirties known consumers.
- An ADR or convention change dirties nodes whose summaries relied on it.
- Refresh dirty nodes lazily when demanded by a task; eagerly refresh only nodes required for safe routing or verification.
- Clear dirty state only after evidence is re-read and the summary is regenerated.

Unknown dependency impact is itself a risk signal for the router.

## Freshness and TTL

Use freshness classes rather than one universal age:

- **Structural:** project/module purpose and stable boundaries. Long TTL; invalidate primarily by fingerprints.
- **Operational:** commands, toolchain behavior, dependency versions, generated interfaces. Medium TTL; verify when relevant.
- **Volatile:** incidents, temporary workarounds, active migrations, branch-local state. Short TTL; verify every task or session.
- **Immutable evidence:** committed ADRs and versioned specifications. No time expiry, but invalidate when their source changes.

Expired means “must validate before reliance,” not “delete immediately.” Preserve useful stale summaries with an explicit stale marker until refreshed or garbage-collected.

## Decisions and conventions

Store decisions separately from observations. A decision entry records status, scope, rationale summary, source, supersession link, and affected nodes. A convention records verified patterns such as test commands, layout, naming, or change constraints with evidence and last validation.

Never promote a repeated pattern into a project convention without evidence that it is intentional.
