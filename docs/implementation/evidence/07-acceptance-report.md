# Workflow 07 — Acceptance Report

**Date:** 2026-11-17
**Scope:** Discipline-specific care plans (module 15)
**Engineering status:** Complete
**Release status:** Awaiting clinician usability signoff, the private-Postgres live proof, and a deployment rollback drill

## Delivered behavior

- A patient-scoped overview presents Aide, MSW, Spiritual, and Volunteer journeys without creating a volunteer plan before its first assignment.
- The overview uses server-derived action metadata for the open version, latest signed version, missing signer roles, assigned owners, and durable IDG provenance.
- Authorized clinicians can open an initial or interim version through a typed, idempotent, `If-Match`-protected API. System-authored version kinds remain unavailable to that route.
- The shared workspace renders the latest signed version (not the first signed row), fails closed for finalize/sign controls without their route permission, prevents duplicate transition submissions, and announces errors.
- Version, signature, and IDG review surfaces retain sealed snapshots and provenance. Signed content is displayed as historical state, not recomputed from the current plan.
- Clinical tables reflow through labelled keyboard-scrollable regions. Authoring screens warn before reload or explicit navigation discards unsaved content.

## Automated verification

All commands ran from the repository root.

| Command | Result |
|---|---|
| `bun run typecheck` | Passed: production graph plus all seven test-typecheck shards and the DOM-test shard. |
| Focused M15 Vitest command over web, route injection, caseload, open-version, and package tests | Passed: 9 files, 96 tests. |
| `env E2E_BASE_URL=http://localhost:5173 bunx playwright test --config=e2e/playwright.config.ts --project=chromium e2e/specs/discipline-care-plans.spec.ts` | Passed: authenticated synthetic Whitfield journey, four discipline cards, lazy volunteer state, keyboard navigation, 375px no-overflow assertion, and WCAG 2.1 A/AA axe scan. |
| `bun run build` | Passed for all packages, applications, and scripts. |
| `bun run arch:fitness` | 49 gates passed in the sandbox; only `arch:docling-lock` could not read the user UV cache. The same gate was rerun with cache access and passed, yielding 50/50 effective green gates. |
| `bun run test` | Passed: 2,430 files; 35,884 tests passed, 8,383 skipped, 15 todo. Duration 252.32s. |
| Selected-file `bunx biome check` | Passed with no remaining findings. |

Generated implementation-status, UI-parity, OpenAPI, injection-coverage, and E2E/axe-coverage reports were refreshed. The OpenAPI client parity check passed.

## Security and clinical-control evidence

- Backend authorization remains authoritative; frontend controls use the exact `discipline_plan.finalize` and `discipline_plan.sign` permissions and fail closed when permissions are unknown.
- Signing still uses the existing step-up middleware and sealed required-signer set. The UI does not auto-sign or widen the quorum.
- Version opening requires authorization, caseload scope, `If-Match`, and idempotency. The write service locks the plan root and performs version insertion/root transition atomically.
- SUD and family-violence rows remain filtered in the read service; the client renders only the returned redaction categories.
- No migration was added. No production data, real patient record, or external telemetry was used. The browser scenario used generated local demo data.

## Outstanding release gates

1. Run `test:m15:plan-bootstrap:live` in its CI-provisioned private Postgres environment. On 2026-11-17 an isolated `chartwarden-postgres:dev` container was started on port 5667 with a fresh `chartwarden_wf07` database and `max_locks_per_transaction=1024`; `pg_isready` passed. The compliance PreToolUse hook still refused the live-suite command before execution because Codex cannot perform the human confirmation required for a suite that drops `chartwarden_app`. The command was not bypassed and the disposable container was removed.
2. Complete clinician usability review for Aide, MSW, Chaplain, and Volunteer Coordinator personas, including tablet and screen-reader-assisted use.
3. Execute the deployment rollback drill. This change has no migration and adds a backward-compatible endpoint/response projection, so rollback is an application-release rollback; the drill itself has not been performed.

These are external validation/release activities, not unfinished application implementation. They must not be represented as completed until their evidence is attached.
