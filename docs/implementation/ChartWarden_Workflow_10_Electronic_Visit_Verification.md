# ChartWarden — Workflow 10: Electronic Visit Verification (EVV) Redesign

**Repository destination:** `docs/implementation/ChartWarden_Workflow_10_Electronic_Visit_Verification.md`
**Executor:** Codex
**Status:** WP0 APPROVED — 2026-11-19; approved PR-0/PR-1 supervisor workspace, PR-2 event correction, and PR-3 honest aggregator evidence slices implemented locally; PR-4/PR-5 mobile source and PR-6 vendor scaffolding audited, with release gates still closed
**Sequence:** After Workflow 09 (Clinical Visits & Documentation), before Workflow 11 (Medication Orders)
**Baseline:** The historical ZIP proposal has been superseded by the current-branch WP0 evidence at
[`evidence/10-evv-current-state.md`](./evidence/10-evv-current-state.md). That audit includes static source
inspection, focused non-live tests and architecture gates; it did not run a browser journey, live DB suite,
real-device test, vendor integration, or state-specific regulatory verification.
**Scope:** Clinician check-in/check-out, offline capture/synchronization, EVV event visibility, exceptions and corrections, device and geofence policy, supervisor review, aggregator submissions, and integration with scheduled visits and clinical encounters.

---

## 0. Executive decision

Build a **single, understandable EVV experience** with two coordinated surfaces:

1. **Clinician visit check-in/out:** embedded in the assigned visit, with a simple state-specific primary action and clear feedback on what was captured, saved, or is pending sync.
2. **Supervisor EVV Operations:** a worklist of exceptions and missing events, event detail with provenance, resolution and correction controls, and aggregator submission monitoring.

Avoid exposing administrative EVV vocabulary to clinicians who simply need to start and finish a visit. Do not merge the scheduled visit, clinical encounter, and EVV event into one database status. Keep existing server authorization, idempotency, event history, corrections, and audit protections authoritative.

**Target journey:** Scheduled/assigned visit → clinician opens visit → check-in with allowed capture method → EVV event accepted or queued offline → clinician performs visit and documents encounter → check-out → system detects missing/late/invalid events → authorized supervisor resolves exceptions → qualifying event is prepared/submitted where applicable → acknowledgment/rejection visible and actionable.

**Important scope boundary:** EVV applicability varies by service, payer, program, and state. Do not assume that every Medicare hospice visit requires EVV, that a successful check-in proves a billable service, or that all states use one aggregator. Validate applicable rules separately before enforcing or submitting.

## 1. Verified repository anchors — recheck on current branch

These paths were observed in the uploaded repository. Their presence is not proof of complete production behavior.

| Path | Observed responsibility / audit focus |
|---|---|
| `apps/web/src/modules/18-evv/events.tsx` | EVV event worklist; filters, statuses, navigation and action discoverability. |
| `apps/web/src/modules/18-evv/event-detail.tsx` | Event details, capture evidence and corrections; assess terminology and provenance. |
| `apps/web/src/modules/18-evv/missing-resolutions.tsx` | Missing/exception resolution queue; role-based resolution experience. |
| `apps/web/src/modules/18-evv/aggregator-submissions.tsx` | Submission tracking and exception handling; distinguish prepared, sent, acknowledged, rejected. |
| `apps/web/src/modules/18-evv/devices.tsx` | Device management and trust state. |
| `apps/web/src/modules/18-evv/geofence-policy.tsx` | Location policy administration; preserve privacy and exception handling. |
| `apps/web/src/modules/18-evv/metrics.tsx` | EVV operational reporting. |
| `apps/web/src/modules/18-evv/evv-modals.tsx`, `evv-shared.tsx`, `evv-api.ts`, `screens.ts` | Shared UI/actions/API contracts; reuse instead of duplicating. |
| `apps/backend/src/modules/18-evv/routes/evv-routes.ts`, `evv-typebox.ts`, `routes/service.ts` | Backend route guards, request contracts, idempotency and EVV operations. |
| `apps/backend/src/modules/18-evv/capture-guards.ts`, `capture-geofence.ts`, `capture-classification.ts` | Capture authorization, visit-window and location classification. |
| `apps/backend/src/modules/18-evv/domain/event-lifecycle.ts`, `missing-resolution.ts`, `aggregator-submission.ts` | Server-owned EVV lifecycle and transition rules. |
| `apps/backend/src/modules/18-evv/offline-idempotency.ts` | Offline deduplication semantics. |
| `apps/backend/src/modules/18-evv/jobs/late-check-sweep.ts`, `spoof-detector.ts`, `submission-prep.ts`, `submission-worker.ts` | Background checks and submission workflow; verify wiring and actual execution. |
| `apps/backend/src/modules/17-scheduling/outbox-consumers/m18-evv-check-in.ts`, `m18-evv-check-out.ts`, `m18-evv-event-corrected.ts`, `m18-evv-late-check-resolved.ts` | Scheduling-side event consumers and side effects. |
| `apps/backend/src/modules/08-encounters/evv-at-sign.ts` | Encounter-signature integration; verify whether EVV blocks signing and under which conditions. |
| `packages/db/src/schema/evv/` | Events, devices, geofence evaluation/policy, missing resolutions, offline receipts, submissions, visit registrations. |
| `docs/design/screens/clinical/CHARTWARDEN_UI_EVV.md` | Existing intended UX; not proof that features are implemented. |
| `e2e/specs/evv.spec.ts`, `apps/web/src/modules/18-evv/evv-writes.dom.test.tsx` | UI/e2e test inventory. |
| `apps/backend/__tests__/evv-*.test.ts`, `m17-evv-*.live.test.ts`, `m18-evv-*.test.ts` | Existing lifecycle, authorization, geofence, offline, worker and integration tests; distinguish live tests from unit tests. |
| [`Engrace-Hospice/chartwarden-mobile`](https://github.com/Engrace-Hospice/chartwarden-mobile): `src/features/visits/use-visit-workflow.ts`, `visit-detail-screen.tsx`, `features/evv/` | React Native/Expo foreground location, device self-registration, online capture, evidence reconciliation, and default-off encrypted offline sync. Cross-repository source evidence only; not production readiness. |

### High-value findings requiring verification

- The EVV route source documents **assigned clinician** and **visit-window** predicates for check-in/check-out. UI must explain rejected attempts without bypassing server enforcement.
- The route source documents an **Idempotency-Key** requirement on mutations except offline-sync routes, whose deduplication uses a device/local identifier. Keep retry behavior aligned with the actual contracts.
- The route source describes **server-session-backed fresh step-up** for correction-of-record and supervisor overrides. Do not replace it with a client-provided flag.
- The route dependency `deviceAttestationEnforced` is documented as **default OFF** pending an attested client. Audit runtime configuration; do not claim device attestation is enforced merely because a gate exists.
- Late-check, aggregator and spoof-detection workers are wired in the current composition root; see WP0 §11.
  This proves construction and focused tests, not a live vendor transmission or real-device anti-spoofing behavior.
- The separate `chartwarden-mobile` repository contains React Native/Expo online capture, self-registration and
  encrypted offline-sync source. Its own release records mark authenticated live and physical-device proof NO-GO;
  do not restate source presence as a released mobile capability.
- A UI module for devices and geofence policy exists; do not make geolocation mandatory for all visits or store/display exact coordinates beyond policy and least-privilege needs.

## 2. WP0 — Current-state audit (APPROVED 2026-11-19)

WP0 is complete at [`evidence/10-evv-current-state.md`](./evidence/10-evv-current-state.md). It was approved in
the review canvas on 2026-11-19. The approved first implementation slice is limited to documentation corrections,
the broken M24 remediation link and consolidation of existing supervisor surfaces. Mobile capture, offline client,
backend behavior, new PHI/location storage and vendor integration still require separate approval.

The audit contains:

1. Current branch/commit, working-tree status, relevant ADRs, feature flags, package scripts and test environment prerequisites.
2. **Navigation map:** My Visits → visit detail → check-in/out; EVV events → detail → correction; missing resolutions → supervisor action; devices/geofence settings; submissions and metrics. Note missing or broken deep links.
3. **Screen-to-API-to-domain matrix:** actual routes, request/response schemas, permissions, ABAC, tenancy enforcement, audit writes, error codes, idempotency and relevant jobs.
4. **State machines separately:** scheduled visit, EVV event, missing resolution, offline receipt, aggregator submission, clinical encounter. Document transitions and invariants; never infer states from UI labels.
5. **Capture evidence inventory:** timestamps, capture method, visit/clinician/patient links, location handling, device identifiers, signatures/attestation if actually supported, original vs corrected values, clock/timezone behavior.
6. **Offline truth table:** supported devices/browsers, local storage approach, PHI exposure, pending state, retries, duplicate suppression, out-of-order events, failed sync, lost-device recovery. Mark unimplemented behavior explicitly.
7. **Security verification:** cross-tenant attempts, unauthorized clinician, stale session, location spoofing, device status, supervisor step-up, audit and immutable provenance.
8. **Payer/state applicability matrix:** what is configured, what is documented, what is merely planned; never create universal hospice EVV requirements. Capture the applicable Medicaid/state/program rules and vendor contracts separately.
9. **Aggregator capability audit:** integration configuration, submission payload, endpoint, acknowledgments, retry, idempotency, reconciliation and rejection paths; verify whether real transmissions occur.
10. **UI walkthroughs** with fictional patients: assigned visit, early/late check-in, denied location, missing check-out, offline sync, correction, duplicate capture, supervisor override, submission rejection. Collect desktop/mobile screenshots if environment is runnable.
11. **Accessibility review:** touch targets, screen reader, keyboard, color contrast, location-permission denial, poor connectivity, plain-language messages.
12. **Tests:** list passed/failed/skipped/blocked/not-run separately; include commands and evidence. Do not claim tests passed without executing them.
13. **Proposal:** reuse/consolidate/modify/defer matrix, exact routes/components affected, risk register, wireframes and PR boundaries.

**STOP GATE CLEARED:** WP0 evidence and the PR-0/PR-1 scope were explicitly approved. Later slices retain their
own approval gates.

### 2.1 Approved implementation progress — 2026-11-19

- **PR-0/PR-1:** corrected the implementation documents, repaired the M24 EVV remediation deep link and added
  one permission-filtered EVV Operations navigation model across the existing supervisor screens.
- **PR-2:** added an immutable event evidence timeline and wired the existing
  `POST /api/v1/evv/events/:eventId/correct` contract into event detail. The client sends a complete replacement
  capture and ≥60-character reason, preserves a scoped in-memory draft across fresh step-up, opens the returned
  event on success and leaves authorization, current-head checks, kind matching, geofence evaluation and the
  atomic supersede transaction to the server.
- The event read contract does not expose coordinates or correction reasons. The UI says so and does not invent
  a broader read path. No backend, schema, new PHI/location storage, mobile client or vendor integration changed.
- Read-only browser QA covered the six EVV workspace routes at 375, 768 and 1440 pixels. All routes loaded, all
  expected navigation links remained available, no horizontal overflow occurred, and the final WCAG A/AA axe
  scan reported no violations. Visual comparison remains inconclusive because no approved screenshot baseline
  exists.

## 3. UX architecture — proposed

### 3.1 Clinician: EVV inside the Visit Workspace

Keep the primary workflow in the scheduled visit; do not send clinicians to an EVV administration module.

**Visit header:** patient safety identifiers, scheduled window, visit purpose, assigned clinician, visit location as authorized, and clearly separated `Visit`, `Documentation`, `EVV` states.

**Contextual primary action (one at a time):**

- Before check-in: **Start visit / Check in** if permitted.
- Check-in captured: **Checked in at [local time]**, with original timestamp provenance available; show **Check out** when permitted.
- Check-out captured: **EVV recorded** or **Needs review** based on server status.
- Offline queued: **Saved on this device — not yet received by server**; never show “Verified” until server confirms.
- Failed: concise error, safe retry, and **Contact supervisor** where appropriate.

If a patient declines location capture, permission is denied, or a device is unavailable, present **only** alternatives that the current backend and applicable policy support. Do not invent telephone verification or manual attestation paths.

### 3.2 Supervisor: EVV Operations workspace

Default to **Needs attention** instead of a raw event table. Proposed tabs (presentation-only unless backend supports statuses):

1. **Needs attention:** missing check-in/out, late capture, flagged geofence/device, failed sync or rejected submissions; each row explains cause and permitted next action.
2. **All events:** searchable/filterable record with patient, clinician, visit, timestamps, capture type, verification status and history.
3. **Submissions:** prepared/sent/acknowledged/rejected according to actual provider semantics; retries and vendor response details.
4. **Policies & devices:** administrative-only access; never put sensitive controls in the clinician flow.

Use a persistent details drawer or stable detail route with: evidence timeline, original values, adjustments, actor, reason, and audit metadata. Use the exact lifecycle vocabulary established in WP0.

### 3.3 Exception resolution

**Problem → Evidence → Allowed resolution → Review → Confirm → Result.**

- State the specific issue in plain language.
- Display original capture and trusted server metadata, not just a generic “invalid” badge.
- Offer only server-authorized resolution types for that event and role.
- Require reason, relevant supporting evidence and fresh step-up where mandated.
- Show irreversible effects and audit consequences before confirmation.
- On conflict, re-fetch server state; never overwrite another supervisor's correction silently.
- Preserve the original record and append correction provenance; never silently rewrite timestamps.

### 3.4 Aggregator submission experience

Use a separate, visible state for **captured**, **eligible for submission**, **queued**, **transmitted**, **accepted**, **rejected**, and **needs reconciliation** only when supported by actual provider contracts. Never map transport success to payer acceptance. Display vendor-specific error and retry guidance without leaking PHI into logs or notifications.

### 3.5 Mobile and accessibility

Large controls, strong contrast, no purple gradients, Lantern tokens, clear time-zone labeling, screen-reader announcements, resilient loading/empty/error states. Confirm any background location or offline claims with real device tests. Do not create location tracking outside a visit without explicit requirements and privacy review.

## 4. Implementation work packages

### WP1 — Design-system and navigation alignment

**Tasks**
- Audit current EVV screen routing and visit deep links.
- Build reusable EVV status, evidence timeline, actionable error and visit-context components using `@chartwarden/ui` and Lantern tokens.
- Unify status labels without altering backend enums.
- Maintain stable URLs and feature flags; provide redirects only where safe.

**Acceptance:** Existing routes continue working; no lost visit/patient context; accessible desktop/mobile states; no backend mutation.

### WP2 — Clinician check-in/check-out UX

**Tasks**
- Add contextual EVV controls to the existing visit surface, not a second visit lifecycle.
- Bind controls to current check-in/out API with permission, window and assignment enforcement.
- Use existing idempotency semantics and prevent duplicate UI submissions.
- Display server-confirmed capture timestamp separately from device-reported time.
- Explain denied geolocation, out-of-window, unauthorized and conflict responses.

**Acceptance:** Cannot bypass server guards; retries do not create duplicate events; clinician sees whether event is pending, accepted or needs review; encounter documentation remains separate.

### WP3 — Offline and device behavior (conditional)

**Prerequisite:** WP0 proves an offline sync contract and approved PHI/device security model.

**Tasks**
- Use existing offline-sync endpoints and receipt identity; do not invent another queue.
- Show pending/syncing/confirmed/rejected states with accurate provenance.
- Test airplane mode, reconnect, duplicate replay, out-of-order events, clock skew, token expiry and lost device.
- Respect server device-attestation enforcement settings; do not fake an attested device.

**Acceptance:** No false “verified” status; no cross-account/tenant local data leakage; no silent data loss. If prerequisites fail, defer offline UI and document limitation.

### WP4 — Supervisor exception and correction workspace

**Tasks**
- Reorganize existing events, event detail and missing-resolution screens around actionable worklists.
- Show source evidence, original vs corrected values, correction reasons and history.
- Preserve server-driven resolution types, authorization, step-up and immutable audit semantics.
- Handle stale records, concurrent resolution, duplicate corrections and permission errors.

**Acceptance:** Only authorized supervisors resolve exceptions; every correction is attributable and traceable; denied actions remain denied through direct API calls.

### WP5 — Submission and reporting clarity

**Tasks**
- Present actual aggregator lifecycle and acknowledgments without assuming transmission is configured.
- Explain rejection reasons and safe retry paths; preserve existing deduplication and job logic.
- Align metrics with authoritative data and provide drill-down into failed/overdue events.
- Add clear “not configured” states where a payer/program integration is unavailable.

**Acceptance:** No fabricated submission success; correct tenant isolation; vendor failures are visible, recoverable and auditable.

### WP6 — Verification, rollout and documentation

**Tasks**
- Add focused unit, component, API-contract and end-to-end tests for clinician/supervisor flows.
- Run real browser mobile/tablet/desktop checks and accessibility tests where environment permits.
- Execute tenant-boundary and role-negative tests; verify event replay, correction provenance, location data handling and job behavior.
- Introduce staged feature flag if necessary; document rollback preserving existing EVV data and audit history.
- Update screenshots, user-facing help, operator runbooks and state/program applicability notes.

**Acceptance:** No regression in visit/encounter/EVV lifecycle; all required tests pass or release is blocked with explicit evidence; rollback is tested.

## 5. Minimum test matrix

| ID | Scenario | Expected result |
|---|---|---|
| EVV-01 | Assigned clinician checks in within valid window | Server-authorized event, visible confirmation |
| EVV-02 | Unassigned clinician checks in | Denied; no event created |
| EVV-03 | Wrong-tenant patient/visit ID | Denied without information disclosure |
| EVV-04 | Early/late capture outside permitted window | Server policy enforced; actionable error |
| EVV-05 | Double-tap or network retry | Idempotent result, no duplicate event |
| EVV-06 | Check-out without valid preceding event | Actual domain rules enforced |
| EVV-07 | Check-in then check-out | Correct event relationship and timestamps |
| EVV-08 | Device clock differs from server | Provenance preserved; no silent time rewriting |
| EVV-09 | Geolocation permission denied | Clear state; only supported alternative actions |
| EVV-10 | Geofence outside threshold | Actual configured policy applied and logged |
| EVV-11 | Spoof signal flagged | Reviewable result, no false automatic conviction |
| EVV-12 | Offline capture then reconnect | Pending until server receipt, deduplicated |
| EVV-13 | Duplicate offline sync replay | One logical event/receipt according to contract |
| EVV-14 | Offline device/user switch | No cross-account PHI exposure |
| EVV-15 | Suspended/rejected device | Server enforcement matches configured policy |
| EVV-16 | Missing check-out detection | Exception surfaced by verified worker |
| EVV-17 | Clinician resolution attempt without permission | Denied |
| EVV-18 | Supervisor correction without fresh step-up | Denied |
| EVV-19 | Authorized correction with reason | Original retained, append-only provenance |
| EVV-20 | Concurrent supervisors resolve same issue | Conflict handled; no silent overwrite |
| EVV-21 | Canceled/rescheduled visit | Correct EVV event/exception handling |
| EVV-22 | Encounter signing with missing EVV | Existing gate behavior unchanged |
| EVV-23 | Submission integration not configured | Honest disabled/not-configured UI |
| EVV-24 | Aggregator transmission fails | Failure and safe retry shown, no fake acceptance |
| EVV-25 | Aggregator rejects record | Rejection visible with actionable details |
| EVV-26 | Retry submission | No duplicate business submission |
| EVV-27 | Metrics cross-tenant request | Denied/isolated |
| EVV-28 | Keyboard and screen-reader navigation | Accessible focus, labels, announcements |
| EVV-29 | Narrow mobile viewport | No clipped primary actions or horizontal overflow |
| EVV-30 | Session expires during check-out | No false success; secure recovery |
| EVV-31 | Audit event includes PHI in logs | Test detects and blocks leakage |
| EVV-32 | Feature-flag rollback | Prior UI restored; stored EVV records unaffected |

Use fictional test data. Adapt expected behavior to actual contracts and applicable policy; do not change clinical or legal rules to satisfy a UI test.

## 6. Proposed pull requests and release gates

| PR | Scope | Gate |
|---|---|---|
| PR-0 | WP0 audit and approved wireframes only | Human approval required before application edits |
| PR-1 | Shared EVV UI, status language, routing | Component/accessibility and navigation tests |
| PR-2 | Event evidence timeline and existing correction route UI | Step-up, permission, provenance and contract tests |
| PR-3 | Honest aggregator configuration/status presentation and drill-down | Vendor-state truthfulness, tenant isolation and worker/live proof |
| PR-4 | React Native/Expo capture and device registration in the separate `chartwarden-mobile` repository | Source implemented; release requires real-device location, attestation and privacy evidence |
| PR-5 | Default-off offline v2 client queue in `chartwarden-mobile` under the approved encrypted local-PHI model | Source implemented; release requires SQLCipher, account/device isolation, replay and recovery device proof |
| PR-6 | Existing Sandata/open-model adapter binding and state rollout, separately approved | Vendor contract remains unverified; requires agreement/BAA, real sandbox conformance, production refusal and rollback evidence |

Do not merge large cross-domain changes in one PR. If a backend safety defect is discovered, propose a separate narrow fix with proof, migration impact and approval.

### PR-3 implementation note — 2026-11-19

The submission queue now explicitly says that configuration readiness is unavailable because the
current tenant-safe read contract has no credential, connectivity, or worker-health signal. An empty
queue is therefore presented as “no submission records,” not as proof of a configured integration.
The audited submission read additively exposes existing transaction, attempt/response/retry timestamps,
and rejection code/reason fields in a details dialog. Status explanations distinguish local preparation,
delivery, vendor response, and payer claim outcome. No credential endpoint, vendor adapter, worker
behavior, schema, policy, or new PHI storage was added.

Focused DOM behavior and injected-route contract tests pass. OpenAPI and the generated client are in
sync. The owner-run private-PostgreSQL M18 read/RLS, write, worker, and DEK-rotation suites also pass.
The new aggregator list projection still needs a live route-level cross-tenant/read-audit journey; this
slice does not claim a real vendor transmission or configuration-health check.

### PR-4/PR-5 cross-repository audit note — 2026-11-19

The authoritative architecture targets a separately versioned React Native/Expo app, not the historical
Capacitor wrapper. At audited mobile commit `77f450ddbf02afa4ad0d662d392afdfd7fa8cbc5`, the canonical
[`Engrace-Hospice/chartwarden-mobile`](https://github.com/Engrace-Hospice/chartwarden-mobile) repository
already contains foreground-only fresh-location capture, device
self-registration with approval gating, server-bracket reconciliation, and an encrypted offline v2
queue behind a default-off build flag. The mobile documentation explicitly forbids treating local source
and unit tests as authenticated live or physical-device evidence.

PR-4 and PR-5 therefore move from “unimplemented here” to “source implemented cross-repository, release
NO-GO.” Remaining gates include iOS and Android location/permission behavior, SQLCipher and backup
exclusion, wrong-key and logout/account isolation, response-loss and replay recovery, attestation-on/off,
access-denial cases, accessibility, and live backend reconciliation. This repository must not add
`apps/mobile`, Capacitor dependencies, or a competing offline queue. ADR-0072 still records formal owner
ratification as pending, so any change to renderer ownership or cross-repository contracts remains an
architecture decision, not an implementation-plan shortcut.

### PR-6 adapter audit note — 2026-11-19

The adapter package, worker flow, configuration binding, per-provider/state credential lookup, retry/poll
state machine, and fail-closed default already exist. The HTTP transport and its tests explicitly use an
assumed Sandata contract: `/submissions`, `/submissions/{id}`, Basic authentication, and local response
field names were tested only through an injected fake fetch. No reachable Sandata sandbox, executed
state trading-partner agreement/BAA, or verified production payload/response contract is evidenced.

PR-6 is therefore not a request to add another generic adapter. Its next authorized work must begin with
a named state/provider entity, executed agreement evidence, sandbox credentials through the approved
secret path, and synthetic conformance fixtures. Until then, leaving `SANDATA_API_BASE_URL` and matching
credentials absent preserves the deny transport and is the correct production posture. No vendor call or
credential change was made during this audit.

## 7. Definition of done

- A clinician can start and finish an eligible visit without navigating through administrative EVV pages.
- Every visible status distinguishes local capture, server receipt, verification and downstream submission where applicable.
- Supervisors can find and resolve exceptions without searching multiple disconnected screens.
- Original events and corrections remain auditable; step-up and permission gates remain server-owned.
- Visit, encounter and EVV states remain separate and correctly linked.
- No blanket assumption that EVV is required for every hospice visit or payer.
- Offline and aggregator claims are backed by actual integration tests or clearly marked unavailable.
- Tenant isolation, PHI minimization, accessibility and recovery are verified.
- Documentation and tests match the implemented UI; no invented APIs or status values.

## 8. Instructions to Claude Code

1. Read this plan and inspect the **current repository**, not only the historical ZIP paths. Check architecture ADRs, Lantern design tokens and prior Workflow 08/09 changes.
2. Execute **WP0 only**. Produce `docs/implementation/evidence/10-evv-current-state.md` with file:line references, actual commands/results, annotated screen map, state/permission matrices and proposed wireframes.
3. Explicitly classify every finding as **verified defect**, **UX observation**, **design proposal**, **deferred capability**, or **unverified**. Do not treat comments or test names as runtime proof.
4. STOP and request approval. Do not change application code, database schema, API routes or regulatory enforcement in WP0.
5. After approval, implement WP1–WP6 in small, reviewable PRs, preserving API contracts and clinical safeguards. Seek separate approval for backend behavior changes, new storage of location/PHI, new aggregator integrations or policy changes.
6. At each PR: run relevant formatter/lint/typecheck/unit/contract/e2e gates; report **passed, failed, skipped, blocked, not run** distinctly. No claims of success without execution evidence.
7. End with a release report: before/after workflow, changed files, screenshots, migration/rollback notes, outstanding risks and verification results.

**Next in sequence:** Workflow 11 — Medication Orders.

**Release readiness:** [`evidence/10-evv-release-readiness.md`](./evidence/10-evv-release-readiness.md)
records the delivered slices, verification, rollback, outstanding gates, and current NO-GO decision for
the complete cross-platform/vendor workflow.
