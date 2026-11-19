# Workflow 10 — EVV release-readiness report

**Date:** 2026-11-19
**Scope:** Workflow 10 PR-0 through PR-3 in this repository; source/readiness audit of PR-4 through
PR-6 across the separate
[`Engrace-Hospice/chartwarden-mobile`](https://github.com/Engrace-Hospice/chartwarden-mobile) repository
and the existing aggregator adapter.
**Decision:** **NO-GO for production release as one complete workflow.** The supervisor web slices are
locally verified and ready for review, but authenticated application-stack, physical-device, and real
vendor sandbox evidence is incomplete.

## 1. Delivered local slices

| Slice | Commit | Delivered outcome |
|---|---|---|
| PR-0/PR-1 | `d83b249cf` | One EVV Operations workspace, repaired navigation/deep links, truthful status language, and updated design/current-state documentation. |
| PR-2 | `66d7b1940` | Event evidence and correction workflow over the existing server route, including reason, confirmation, step-up/error handling, and post-write evidence refresh. |
| PR-3 | `fd25b7857` | Honest aggregator-readiness language and a read-only evidence dialog backed by additive transaction, timestamp, retry, and rejection fields. |
| Mobile reconciliation | `2bb4da03e` | PR-4/PR-5 mapped to the separate React Native/Expo repository and held at NO-GO pending live/device evidence. |
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
| M18 private PostgreSQL live suites | Owner-run evidence passed the read/RLS, write lifecycle, worker/tenant-scope, and DEK rotation/audit suites against fresh databases in an isolated `chartwarden-postgres:dev` container. The updated read suite passed 5/5, including the production aggregator route's evidence projection, cross-tenant exclusion, and actor-attributed list-read audit event under the NOBYPASSRLS application role. |
| OpenAPI and generated client | Regenerated and check-clean. |
| EVV documentation corpus | Check-clean. |
| PR-1 browser sweep | Six EVV screens were checked at 375, 768, and 1440 px without horizontal overflow or automated axe violations. No screenshot artifact was retained. |

The PR-3 evidence dialog was tested in the DOM accessibility suite after that browser sweep; it has not
received a second authenticated browser/device pass.

## 4. Not run or not evidenced

- A post-PR-3 authenticated Playwright journey against the Docker application stack.
- Screenshots suitable for release review.
- VoiceOver, TalkBack, or manual screen-reader verification.
- Physical iOS/Android foreground-location, permission, approximate-location, interruption, and attestation cases.
- SQLCipher, WAL/SHM plaintext scan, backup exclusion, lost/wrong key, logout, account switch, reinstall, and offline replay recovery on devices.
- Sandata sandbox submission/polling, vendor schema conformance, executed agreement/BAA verification, or production rollback rehearsal.
- Full repository non-live test command and platform boot check after PR-3; focused EVV tests, typechecks, and architecture gates were run instead.

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
| Supervisor web slices | Locally verified; no migration. | Fresh review, authenticated Docker journey, live tenant-boundary proof, and retained screenshots. |
| Aggregator evidence | Authorized audited list read; additive fields; M18 workers pass; the production route projection, cross-tenant exclusion, and read-audit persistence pass live under the application role. | Authenticated Docker browser journey and retained release screenshots. |
| Correction workflow | Uses the existing server permission, ABAC, step-up, and immutable provenance path; the live write suite proves supersession, reason persistence, RLS, and append-only behavior. | Route-level step-up/conflict/audit proof and authenticated browser journey. |
| React Native/Expo online capture | Source exists in `chartwarden-mobile`; release NO-GO. | Physical-device and authenticated backend matrix on the pinned contract/build. |
| Offline v2 queue | Encrypted design and default-off source exist; release NO-GO. | SQLCipher/device security, identity isolation, replay, recovery, and retention evidence. |
| Sandata | Fail-closed adapter and fake transport tests exist; release NO-GO. | Named state/provider, executed agreement, approved secrets, synthetic sandbox conformance, and rollback drill. |
| Architecture ownership | Separate Expo application is the aligned target; ADR-0072 formal ratification remains pending. | Owner ratification before changing renderer or cross-repository ownership. |

## 7. Release decision

PR-0 through PR-3 are suitable for branch review as a bounded web/API improvement. They are not evidence
that mobile EVV, offline EVV, device attestation, or a state aggregator is production-ready. Workflow 10
as a whole remains **NO-GO** until the live, device, and vendor gates above are closed or explicitly
removed from a narrower release scope by the owner.
