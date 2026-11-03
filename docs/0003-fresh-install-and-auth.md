# ADR-0003: Fresh Codex install and browser first-run authentication

Status: accepted target, implementation pending, 2026-11-03.

## Scope

This decision applies to a self-hosted, single-operator Ubuntu Server package. It does not make the Web UI a multi-tenant or hosted Codex service. It replaces the fresh-install Codex-version and login decisions in [ADR-0002](0002-managed-portable-toolchain.md). Existing deployed installations continue to use the old behavior until a separately verified upgrade implements this decision.

## Fresh installation

On every new installation, resolve the latest **stable** official Codex CLI release at install time. Do not select prereleases or silently substitute an older release. Download the resolved architecture-specific artifacts into an isolated staging directory, verify official package integrity and the expected origin, then record the exact resolved version and artifact digests in the installation manifest. Node.js and package-manager versions may remain reviewed build-tool pins; this decision concerns the Codex runtime.

The app-server binary and the Web adapter must be a compatible unit. Generate the candidate's app-server schemas before activation and compare its required methods, events and data shapes with the adapter's reviewed compatibility contract. An unknown or incompatible protocol is an explicit installation failure before service activation, with the resolved upstream version and a non-secret diagnostic. Do not run an unreviewed binary as a fallback and do not claim that arbitrary future releases can be supported automatically. A new application release must extend the adapter and acceptance tests for a changed protocol. Rollback and existing-release upgrades remain explicit, drained and health-checked; they must not replace a running installation merely because a newer Codex release appeared.

## First-run bootstrap

Package installation completes without a Codex session or access to a server GUI. It creates only the protected local Web administrator and HTTPS endpoint, then starts in a visible `Codex not connected` state. Until Codex authentication succeeds, task admission and all Codex-dependent writes fail closed; health and administrator setup remain available. Do not expose the private app-server socket or CODEX_HOME to the browser. The operator opens the HTTPS URL from another device and completes Codex sign-in there. A terminal device login remains an explicit recovery option, not a prerequisite for installation.

The Web administrator session and the Codex account are distinct identities. First-run UI offers two exclusive Codex authentication modes: ChatGPT subscription via the reviewed app-server device-code flow, and OpenAI API key via a dedicated authenticated, CSRF- and Origin-protected server command. Never put an API key in a URL, browser storage, Web SQLite, logs, audit payloads, event streams or app-server RPC responses. The runner owns the Codex credential in its protected CODEX_HOME. The UI labels the active billing mode and explains that API-key usage is billed separately from a ChatGPT subscription. Switching modes requires an idle runner and an outcome-confirmed transition; uncertain results keep admission closed. A future public sign-in integration must be reviewed against current OpenAI requirements before release.

## State and acceptance

Keep Codex sessions, rollout history, settings and skills under the runner's CODEX_HOME. Keep Web authentication, project mapping, queue and bounded display projection in the Web SQLite database. Do not replace either with one cache file. Backup and restore must include both stores and verify that resumed threads, skills and UI mappings agree after recovery.

The implementation proceeds in this order, with a focused test gate after each slice: (1) this contract, (2) latest-stable install and compatibility gate, (3) unauthenticated service bootstrap, (4) browser sign-in for both modes, (5) complete browser workflow and dual-store recovery, (6) clean Ubuntu x64/arm64 install, upgrade and rollback acceptance. Run the full repository and system acceptance gates only after all six slices pass their focused checks. Switching the v2 UI to default and deploying to a live server are separate release actions.
