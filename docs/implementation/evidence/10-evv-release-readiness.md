# Workflow 10 — EVV release-readiness report

**Date:** 2026-11-19
**Scope:** Workflow 10 PR-0 through PR-3 in this repository; source/readiness audit of PR-4 through
PR-6 across the separate
[`Engrace-Hospice/chartwarden-mobile`](https://github.com/Engrace-Hospice/chartwarden-mobile) repository
and the existing aggregator adapter.
**Decision:** **NO-GO for production release as one complete workflow.** The supervisor web slices are
locally verified, including a bounded authenticated application-stack journey, and ready for review,
but physical-device and real vendor sandbox evidence is incomplete.

## 1. Delivered local slices

| Slice | Commit | Delivered outcome |
|---|---|---|
| PR-0/PR-1 | `d83b249cf` | One EVV Operations workspace, repaired navigation/deep links, truthful status language, and updated design/current-state documentation. |
| PR-2 | `66d7b1940` | Event evidence and correction workflow over the existing server route, including reason, confirmation, step-up/error handling, and post-write evidence refresh. |
| PR-3 | `fd25b7857` | Honest aggregator-readiness language and a read-only evidence dialog backed by additive transaction, timestamp, retry, and rejection fields. |
| Mobile reconciliation | `2bb4da03e` | PR-4/PR-5 mapped to the separate React Native/Expo repository and held at NO-GO pending live/device evidence. |
| Mobile SDK readiness | `chartwarden-mobile@72ceaa3` | Added the direct `expo-asset` native peer/config plugin required by `expo-audio`, aligned the Expo SDK 57 packages to Expo's supported patch set, upgraded the three Better Auth packages from vulnerable `1.6.25` to patched `1.7.26`, and configured Metro's documented SQLite WASM support and isolation headers. |
| Vendor reconciliation | `d80b1b222` | PR-6 mapped to the existing fail-closed adapter binding and held pending agreement and real sandbox conformance. |

No database migration, new table, new credential, new vendor call, new location collection, or new
offline storage was introduced by these commits.

## 2. Before and after

| Workflow concern | Before | After |
|---|---|---|
| Supervisor navigation | EVV pages were individually reachable but lacked a consistent operations workspace. | Stable workspace navigation connects dashboard, attention queue, events, submissions, policy, and device surfaces. |
| Exception discovery | Missing-event and correction paths were difficult to discover from evidence. | Event detail presents provenance and the existing authorized correction ceremony without rewriting the original event. |
| Correction feedback | The server route existed, but the web detail had no complete correction interaction. | The user reviews the proposed correction, supplies a reason, receives typed errors, and reloads the server evidence after success. |
| Aggregator empty state | An empty queue could be read as a healthy/configured integration. | The screen explicitly says configuration status is unavailable and that an empty queue proves no readiness. |
| Aggregator status | Dense rows showed state and mutation actions but little operational evidence. | Every row has an accessible evidence dialog; vendor acceptance is explicitly separated from payer claim acceptance or payment. |
| Mobile ownership | The plan still named a Capacitor slice in this monorepo. | The plan follows the authoritative separate React Native/Expo repository and preserves its release gates. |
| Vendor readiness | Generic adapter presence could be mistaken for a verified Sandata integration. | The plan records that the HTTP wire contract is assumed, fake-fetch tested, and production remains deny-by-default. |

## 3. Verification performed

| Evidence | Result |
|---|---|
| Changed TypeScript projects (`packages/types`, `packages/ui`, backend, web) | Passed. |
| Full test typecheck, including DOM test program | Passed. |
| Architecture fitness | Passed all configured gates, including tenancy, compliance, API provenance, generated-client parity, and UI documentation. |
| EVV web module DOM suite | Passed after updating the terminal-submission assertion to retain read-only evidence while withholding mutations. |
| PR-3 behavior tests | Passed empty-state truthfulness, rejection evidence, accepted-vs-paid language, keyboard interaction, and automated WCAG A/AA checks. |
| Aggregator injected-route contract | Passed evidence projection and rejection-evidence clearing on resubmit. |
| M18 private PostgreSQL live suites | Owner-run evidence passed the read/RLS, write lifecycle, worker/tenant-scope, and DEK rotation/audit suites against fresh databases in an isolated `chartwarden-postgres:dev` container. The updated read suite passed 5/5, including the production aggregator route's evidence projection, cross-tenant exclusion, and actor-attributed list-read audit event under the NOBYPASSRLS application role. The updated write suite passed 29/29, including the production correction route's stale-step-up denial, successful immutable supersession, scrubbed M4 audit rows, outbox membership attribution, and replay conflict. |
| OpenAPI and generated client | Regenerated and check-clean. |
| EVV documentation corpus | Check-clean. |
| Platform boot check | Passed with `DATABASE_PLATFORM_URL` set: the backend returned `/health` 200 and the outbox relay was polling. |
| PR-1 browser sweep | Six EVV screens were checked at 375, 768, and 1440 px without horizontal overflow or automated axe violations. No screenshot artifact was retained. |
| Post-PR-3 authenticated browser journey | Passed 4/4 Playwright checks against the local application stack after an idempotent synthetic field-operations seed. The real M17 publication consumer registered the current visit before real M18 check-in/check-out API calls created the event evidence. Separate authenticated runs proved the truthful empty aggregator state and a visibly synthetic rejected-submission dialog through the production read route. The correction ceremony and aggregator states passed WCAG A/AA scans and document-overflow checks at 375×812 and 1440×900; the mobile dialog's Close control was also reached after scrolling. |
| Canonical Expo application (`chartwarden-mobile@72ceaa3`) | Passed all 65 Vitest files / 363 tests, TypeScript, uncached Expo lint, dependency compatibility (`expo install --check`), and Expo Doctor 21/21. Local production exports generated the iOS and Android Hermes bundles and the static web application with its SQLite WASM worker and 250 routes. The resolved tree contains `expo@57.0.33`, `expo-audio@57.0.5`, its direct `expo-asset@57.0.21` peer, and the three Better Auth packages pinned to `1.7.26`. The earlier critical Better Auth audit finding is cleared. This is source/build-health evidence, not physical-device EVV evidence. |
| Retained browser artifacts | [Correction desktop](./screenshots/evv/correction-ceremony-desktop-1440x900.png), [correction mobile](./screenshots/evv/correction-ceremony-mobile-375x812.png), [aggregator empty desktop](./screenshots/evv/aggregator-empty-state-desktop-1440x900.png), [aggregator empty mobile](./screenshots/evv/aggregator-empty-state-mobile-375x812.png), [aggregator evidence desktop](./screenshots/evv/aggregator-evidence-desktop-1440x900.png), [aggregator evidence mobile top](./screenshots/evv/aggregator-evidence-mobile-375x812.png), and [aggregator evidence mobile bottom](./screenshots/evv/aggregator-evidence-mobile-bottom-375x812.png). All data is synthetic. |

The populated browser fixture identifies its vendor as `synthetic_demo`, uses transaction id
`demo-no-vendor-call`, and says no vendor transmission occurred. It proves authenticated presentation,
not Sandata conformance or connectivity.

## 4. Not run or not evidenced

- VoiceOver, TalkBack, or manual screen-reader verification.
- Physical iOS/Android foreground-location, permission, approximate-location, interruption, and attestation cases.
- SQLCipher, WAL/SHM plaintext scan, backup exclusion, lost/wrong key, logout, account switch, reinstall, and offline replay recovery on devices.
- Sandata sandbox submission/polling, vendor schema conformance, executed agreement/BAA verification, or production rollback rehearsal.
- Resolution of the remaining npm audit report (9 moderate and 4 high transitive Expo/router/tooling advisories). npm's proposed automatic remediations cross the supported Expo SDK boundary, so no forced downgrade/major upgrade was applied.
- A completed full repository non-live test run after PR-3. The first attempt inherited an unavailable ambient database URL and also exposed a timing-sensitive harness test under full-suite contention; the harness test passed all 196 cases when isolated. A second environment-clean run continued for an extended period without completing. On 2026-11-19, an environment-clean retry again saturated the host: unrelated loopback/Docker/CLI tests reached their 50-second ceilings. A bounded `bun run test -- --maxWorkers=4` retry removed the broad contention failures, but local-listener suites (`m36-attachment-scanners` and `m29-inbound-plain-guard`) still timed out and the runner stopped making progress; the sandbox also denied process inspection. Both retries were terminated and are not recorded as passing. Focused EVV tests, full test typecheck, architecture gates, and the platform boot check passed.

## 5. Rollback and data safety

The web/API work has no migration and does not alter persisted EVV records during deployment. A rollback
reverts the runtime commits in reverse order: PR-3 (`fd25b7857`), PR-2 (`66d7b1940`), then PR-0/PR-1
(`d83b249cf`). PR-3's OpenAPI document and generated client must be reverted with its backend projection
so the contract remains synchronized.

Rollback removes navigation, correction UI, and evidence presentation only. Existing EVV events,
corrections, audit history, submissions, device records, and worker state remain stored and continue to
follow server-owned authorization and transition rules. Mobile offline EVV remains protected by its
default-off build flag. With Sandata configuration absent, the deny transport remains bound; rollback
must not be simulated by pointing production at an unverified endpoint.

## 6. Outstanding risks and release gates

| Area | Current posture | Gate to close |
|---|---|---|
| Supervisor web slices | Locally verified; no migration; focused application-role tenant-boundary proofs, authenticated browser journey, responsive WCAG scans, and retained screenshots pass. | Fresh review and manual assistive-technology pass. |
| Aggregator evidence | Authorized audited list read; additive fields; M18 workers pass; the production route projection, cross-tenant exclusion, read-audit persistence, and authenticated empty/populated browser states pass. | Real vendor sandbox evidence. |
| Correction workflow | Uses the existing server permission, ABAC, step-up, and immutable provenance path; the production route passes live stale/fresh step-up, supersession, reason persistence, scrubbed audit, outbox attribution, replay-conflict proof, and an authenticated responsive ceremony pass. | Manual assistive-technology pass. |
| React Native/Expo online capture | Source exists in `chartwarden-mobile`; automated tests, typecheck, lint, dependency compatibility, native/web bundle export, and Expo Doctor pass at `72ceaa3`; the critical Better Auth advisory is cleared, but transitive Expo/router audit findings remain; release remains NO-GO. | Physical-device and authenticated backend matrix on the pinned contract/build, plus an upstream-compatible resolution or reviewed disposition for the remaining dependency advisories. |
| Offline v2 queue | Encrypted design and default-off source exist; the canonical application's automated source/build-health gates pass at `72ceaa3`; release remains NO-GO. | SQLCipher/device security, identity isolation, replay, recovery, and retention evidence. |
| Sandata | Fail-closed adapter and fake transport tests exist; release NO-GO. | Named state/provider, executed agreement, approved secrets, synthetic sandbox conformance, and rollback drill. |
| Architecture ownership | Separate Expo application is the aligned target; ADR-0072 formal ratification remains pending. | Owner ratification before changing renderer or cross-repository ownership. |

## 7. Release decision

PR-0 through PR-3 are suitable for branch review as a bounded web/API improvement. They are not evidence
that mobile EVV, offline EVV, device attestation, or a state aggregator is production-ready. Workflow 10
as a whole remains **NO-GO** until the live, device, and vendor gates above are closed or explicitly
removed from a narrower release scope by the owner.
