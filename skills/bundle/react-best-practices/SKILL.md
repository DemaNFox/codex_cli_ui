---
name: vercel-react-best-practices
description: Apply targeted React performance guidance when work changes data fetching, async waterfalls, effects, global listeners, render frequency, expensive computation, bundle imports, dynamic loading, or explicitly requests performance review. Do not trigger for copy, CSS, static markup, accessibility attributes, or routine component wiring without a performance decision.
license: MIT
metadata:
  author: vercel
  version: "1.0.0"
---

# React Performance Best Practices

Use only the guidance relevant to the changed performance surface. Preserve behavior and avoid speculative
memoization or framework-specific rewrites.

## Route to the smallest rule set

- async/data dependencies: `rules/async-*.md`;
- bundle/import/loading behavior: `rules/bundle-*.md`;
- client fetching or global listeners: `rules/client-*.md`;
- render frequency, derived state, hooks, or effects: `rules/rerender-*.md`;
- long-list/SVG/render cost: `rules/rendering-*.md`;
- demonstrated hot-loop cost: `rules/js-*.md`;
- advanced stable-handler/initialization patterns: `rules/advanced-*.md` only when the basic categories do not
  solve the measured issue.

Read only the individual rule files matching the task. Do not load the compiled `AGENTS.md` unless the user
explicitly requests a comprehensive React performance audit.

## Compatibility and verification

- Apply Next.js, RSC, server-action, SSR, or React-version-specific advice only when the target project uses
  that capability. For React 18/Vite clients, stay with compatible client-side rules.
- Prefer removing waterfalls and unnecessary bundle work over low-impact micro-optimizations.
- Do not add memoization without an expensive computation, unstable dependency, or measured render problem.
- Run focused component tests and the affected type/build check. Claim performance improvement only with
  evidence proportional to the claim.
