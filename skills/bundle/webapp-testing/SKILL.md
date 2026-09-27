---
name: webapp-testing
description: Verify interactive local web behavior with Playwright, including navigation, forms, focus/keyboard flows, responsive layout, role gates, realtime/offline behavior, screenshots, and browser logs. Use when browser evidence is requested or materially needed. Do not use for copy-only, static CSS, isolated markup, or pure logic changes that focused component/static checks can prove.
license: Complete terms in LICENSE.txt
---

# Web Application Testing

Use browser automation only when rendered interaction is part of the acceptance evidence. Prefer existing
component/unit/static checks for copy, CSS tokens, isolated markup, and pure functions.

## Safe scope

- Use a local or isolated test environment, never production.
- Do not enable real Provider mutations, paid model calls, or external side effects without exact user
  authorization.
- Reuse an already-running safe server when available. Otherwise run
  `python scripts/with_server.py --help`, then use the helper as a black box; do not read its source unless
  customization is necessary.

## Minimal browser flow

1. Define the smallest user interaction that proves the changed behavior.
2. For dynamic apps, navigate and wait for the specific ready state. Prefer a stable app selector or response
   over a blanket timeout; use `networkidle` only when it matches the app's behavior.
3. Inspect rendered DOM or take one reconnaissance screenshot only when selectors/state are unknown.
4. Execute the interaction with role, label, text, test-id, or stable CSS selectors.
5. Assert the user-visible result, relevant URL/state, and absence of material console errors.
6. Close the browser and report the exact scenario and result. Keep screenshots only when they are acceptance
   evidence or help explain a failure.

Use native Python Playwright scripts. The bundled `examples/` directory contains element discovery, static
HTML automation, and console logging patterns; read only the example needed for the current case.
