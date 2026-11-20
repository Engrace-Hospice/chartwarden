# Workflow 10 — Electronic Visit Verification Current-State Evidence

**Audit date:** 2026-11-19
**Branch:** `chore/env-example-drop-minio-note`
**Commit:** `df2e0d7947847b2e70d390774c5e348dd5882743`
**Scope:** WP0 only: static source audit, focused non-live tests, and architecture-fitness checks. No
application code, database schema, API, authorization policy, regulatory rule, or runtime data was changed.
**Parent plan:**
[`ChartWarden_Workflow_10_Electronic_Visit_Verification.md`](../ChartWarden_Workflow_10_Electronic_Visit_Verification.md)

## 1. Decision summary

1. **The M18 server domain is substantially implemented.** Capture, correction, device registration,
   geofence evaluation, missing-resolution, durable offline replay, aggregator preparation, background jobs,
   RLS, audit, and outbox wiring are present. The generated status matrix reports M18 implemented
   (`audit/implementation-status/IMPLEMENTATION_STATUS.md:30`). This is evidence of repository coverage,
   not proof of a usable field workflow.
2. **The clinician electronic-capture client is not implemented.** There is no mobile/Capacitor app under
   `apps/`, and no frontend calls the EVV check-in, check-out, self-registration, or offline-sync endpoints.
   The web My Visits action is a separate M17 **missing-EVV self-attestation** path
   (`apps/web/src/modules/17-scheduling/my-visits.tsx:52-58,168-206,463-496`). WP2/WP3 therefore cannot be
   treated as presentation-only web work.
3. **Device attestation is explicitly off by default.** `EVV_DEVICE_ATTESTATION_ENFORCED` is opt-in
   (`.env.example:313`; `apps/backend/src/modules/18-evv/routes/evv-routes.ts:63-79`) because no attested
   client exists. Assigned-clinician, visit-window, approved-device, and coordinate rules still apply.
4. **Aggregator automation is wired, but a production integration is not proven.** The composition root
   constructs and schedules M18 workers (`apps/backend/src/index.ts:4938-4946,12574-12604`). Blank state
   configuration creates no submissions; absent Sandata URL uses a deny transport; the patient state
   identifier port throws unbound (`apps/backend/src/modules/18-evv/jobs/wiring.ts:1-12,32-52,65-85`). The
   HTTP field assumptions have not been exercised against Sandata
   (`packages/evv-aggregators/src/adapters/sandata-http-transport.ts:1-10`).
5. **ADR-0044 supersedes the plan's launch-adapter baseline.** Sandata plus the open-model adapter are the
   as-built choices; OR-PTC DCI is not built. An Oregon deployment needing submission must add an Oregon
   adapter first (`docs/adr/ADR-0044-evv-launch-aggregator-sandata.md:1-28`).
6. **One broken deep link is verified.** Two Medicaid validation surfaces route `resolve_in_m18` to the
   nonexistent `/evv/exceptions` path
   (`apps/web/src/modules/24-billing-medicaid/validation-queue.tsx:59-69` and
   `validation-worklist.tsx:108-118`). The registered resolution screen is `/evv/missing-resolutions`
   (`apps/web/src/modules/18-evv/screens.ts:93-100`).
7. **The current EVV UI is several disconnected ledgers, not one operations workspace.** The registered
   screens are individually functional, but there is no shared EVV workspace navigation, combined
   needs-attention queue, evidence timeline, or correction control on event detail. That is a UX observation,
   not a server defect.

## 2. Audit boundaries and classification

Every conclusion below uses one of these labels:

- **Verified defect:** source proves existing behavior contradicts a registered route or intended contract.
- **UX observation:** existing behavior works but is fragmented, unclear, or difficult to operate.
- **Design proposal:** a recommended future presentation; it is not current behavior.
- **Deferred capability:** an intentionally absent prerequisite or integration.
- **Unverified:** comments, schemas, or tests exist, but this audit did not prove the behavior in a live stack.

The worktree was already dirty before WP0. It contained one unrelated tracked modification
(`docs/messaging-hub/04-phases-4-to-6.md`) and numerous unrelated untracked files/directories, including this
parent Workflow 10 plan. None were changed by this audit. A browser-backed write journey was not run because
the compose stack had only Postgres, Valkey and RustFS running; API/web were stopped. The existing database was
not reset or mutated. Per repository policy, no live suite was pointed at the shared compose Postgres.

## 3. Authority and current baseline

| Source | Current decision |
|---|---|
| ADR-0008 D1-D3/D5 | EVV applicability is `(state × payer program × service type)`; Medicare hospice EVV is operational and never a federal claim-blocking rule; Medicaid applicability is state/program/service-specific; aggregator PHI requires integration governance. |
| ADR-0044 | Sandata is the shipped launch adapter behind the pluggable registry; OR-PTC DCI is absent; Oregon submission requires a future Oregon adapter. |
| ADR-0020 / integration catalog | A trading-partner agreement / BAA is required before production Medicaid EVV submission (`docs/architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md:161,297`). |
| ADR-0035 | Capacitor is the intended field-mobile boundary, but no such app is present in the repository. |
| ADR-0113 D6 | Check-in can be blocked by overdue-note policy; check-out remains reachable. Offline batches containing any check-in call the same gate. |
| Generated status matrix | M18 reports implemented, including its generated implementation pairs. This does not prove mobile capture or a live vendor connection. |

**Verified defect — stale authoritative-adjacent prose:** the UI screen spec still says EVV bracket state gates
encounter signing and Medicaid claims without the ADR-0008 applicability qualification
(`docs/design/screens/clinical/CHARTWARDEN_UI_EVV.md:11-15`). Any implementation PR must update the wording so
it cannot be read as a universal claim rule.

## 4. Navigation map

### 4.1 Registered M18 web screens

Source: `apps/web/src/modules/18-evv/screens.ts:62-146` and generated UI parity
`audit/ui-parity/UI_PARITY.md:178-186`.

| Journey | Route | Permission | Current surface | Classification |
|---|---|---|---|---|
| EVV overview | `/evv/dashboard` | `evv.read_metrics` | Aggregate KPI dashboard | UX observation: duplicates `/admin/evv-metrics` presentation. |
| Event ledger | `/evv/events` | `evv.read` | Search/filter table | Reuse. |
| Event detail | `/evv/events/:eventId` | `evv.read` | Coordinate-free facts | UX observation: no timeline, correction action, visit/patient navigation, or resolution context. |
| Missing resolutions | `/evv/missing-resolutions` | `evv.missing_resolution.read` | Worklist with attest/override actions | Reuse and reorganize. |
| Aggregator submissions | `/evv/aggregator-submissions` | `evv.aggregator.read` | Worklist with resubmit/cancel | Reuse and clarify configuration/vendor truth. |
| Geofence policy | `/evv/geofence-policy` | `evv.policy.read` | Tenant and per-address settings | Keep administrative. |
| Team devices | `/evv/devices/pending` | `evv.device.read` | Supervisor roster/actions | Keep administrative. |
| Metrics | `/admin/evv-metrics` | `evv.read_metrics` | Same metrics component | Consolidation candidate. |
| My devices | `/me/evv/devices` | `evv.device.read` | Read-only clinician roster | Deferred as a complete journey because self-registration has no client. |

### 4.2 Clinician journey as built

`/me/visits` loads M17 visits and can post `/visits/:visitId/start` or `/arrive` only after collecting a
40-character missing-EVV reason and fresh step-up. The dialog explicitly says EVV advances from the device
(`my-visits.tsx:463-496`). No implemented client performs that device capture. There is also no check-out
button in M18 web code.

**Deferred capability:** Scheduled visit → electronic EVV check-in/out → offline queue → sync is server-contract
only.
**UX observation:** the available web action is labeled "Start visit" / "Check in to visit" even though it is
the exception/self-attestation path. This is legally meaningful and should not look like normal EVV capture.

### 4.3 Broken and missing links

- **Verified defect:** M24 uses `/evv/exceptions`; no such screen is registered. Target
  `/evv/missing-resolutions`, with a query parameter only if the target supports it.
- **UX observation:** Event rows navigate to event detail (`events.tsx:266-273`), but resolution and submission
  rows do not provide a stable cross-link to the corresponding event pair or visit.
- **UX observation:** the EVV screens share no workspace tab/navigation component; users rely on global nav.

## 5. Screen → API → domain/security matrix

The route registrar is mounted from the composition root with the real Drizzle service, transactional M18
outbox publisher, note-closure start gate, coordinate cipher, and device-attestation flag
(`apps/backend/src/index.ts:6775-6806`). Route handlers obtain organization and actor identity from request
context, not bodies (`evv-routes.ts:7-18`).

| Surface / API | Server controls | Domain/storage | Current UI |
|---|---|---|---|
| `POST /evv/check-in`, `/check-out` | Permission; assigned-clinician + visit-window ABAC; optional session attestation; `Idempotency-Key`; check-in note-closure gate | `recordCapture`; active event pair; geofence evaluation; encrypted coordinates; transactional outbox | **No electronic-capture client.** |
| `POST /evv/offline-sync`, `/v2` | Per-event permission/ABAC; optional session attestation; device coherence; no header idempotency | v2 durable receipt keyed by `(org, device, localId)`; causal sorting; per-item applied/already/rejected/retryable | **No offline client.** |
| `GET /evv/events`, `/:eventId` | `evv.read`; RLS; read audit | Coordinate-free event projections | Ledger/detail exist. |
| `POST /evv/events/:eventId/correct` | `evv.correct_record`; fresh server-session step-up; `Idempotency-Key` | Append correction; supersede original; correction reason; outbox; resolution effects | **No correction action in event detail.** |
| `GET /evv/visits/:visitId/bracket` | `evv.read`; read audit | Bracket projection for M8 and other consumers | No direct clinician view. |
| Device read/self-register/lifecycle routes | Separate read/register/approve/suspend/retire permissions; mutation idempotency | Device state machine and server-bound registration facts | Roster lifecycle actions exist; self-register absent. |
| Geofence read/edit routes | Separate read/edit permissions; mutation idempotency | Platform floor, tenant policy, per-address override | Policy page and modals exist. |
| Missing-resolution list/attest/override | Separate read/self/supervisor permissions; assigned-clinician check in service; supervisor fresh step-up; mutation idempotency | One open row per visit/kind; terminal close states; audit/outbox | Queue and both human actions exist. |
| Aggregator list/resubmit/cancel | Separate read/resubmit/cancel permissions; mutation idempotency | Submission state machine and optimistic versioning | Queue/actions exist. |
| `GET /evv/metrics` | `evv.read_metrics`; aggregate-only audit exemption | Server-side rates | Dashboard and admin duplicate. |
| `GET /evv/clinician-current-location` | `evv.location.read_team`; audited coordinate-bearing read | Opens encrypted coordinate with fault handling | No M18 screen; consumed as cross-module capability. |
| Portal arrival | Portal permission + active-grant/patient ABAC; audited | Timestamp only; no coordinates | M31-owned surface. |

All mutating routes except both offline-sync routes require a client `Idempotency-Key`
(`evv-routes.ts:104-130`). Offline v2 returns one result per local capture and distinguishes permanent rejection
from retryable failure (`evv-routes.ts:364-487`).

## 6. Separate state machines and invariants

| Aggregate | States / shape | Key invariant |
|---|---|---|
| M17 scheduled visit | `proposed → published → en_route → in_visit → completed`, with terminal dismissed/no-show/cancel/reschedule branches (`packages/scheduling/src/lifecycle/visit-machine.ts:82-92`) | EVV or explicit missing-EVV self-attestation advances visit; visit status is not EVV event status. |
| M18 EVV event | No mutable lifecycle state; an append-only check-in or check-out exists and may later be superseded by a correction (`event-lifecycle.ts:1-14`) | Active pair uniqueness; original retained; coordinates sealed; captured and recorded times distinct. |
| M18 missing resolution | `open` to exactly one of five `closed_*` states (`missing-resolution.ts:89-105`) | Closed states are terminal; clinician/self and supervisor paths have different identity, time, reason and step-up rules. |
| M18 offline receipt | One durable receipt per `(organization, evvDevice, localId)` | Same replay returns the stored proof; changed payload conflicts; receipt does not claim a rejected capture succeeded. |
| M18 aggregator submission | `pending → queued → submitting → submitted → accepted/rejected/timeout`; cancel from nonterminal; resubmit only rejected/timeout (`aggregator-submission.ts:61-94`) | Transport receipt is not payer/aggregator acceptance; accepted/cancelled are terminal. |
| M8 clinical encounter | `draft → finalized → signed`, or `finalized → cosign_pending → cosigned`; void from draft (`apps/backend/src/modules/08-encounters/lifecycle/encounter.ts:51-61`) | Documentation/signature state remains independent from visit and EVV state. |

## 7. Capture evidence and provenance

The event record includes organization/provider/location tenancy columns; visit, patient, address, clinician,
discipline, device, service type, device `capturedAt`, server `recordedAt`, encrypted coordinates and DEK
version, accuracy, GPS quality, offline flag/local id, correction links/reason, and attestation id at record
(`packages/db/src/schema/evv/evv-event.ts:37-123`).

- **Verified:** coordinates are ciphertext, not plaintext columns (`evv-event.ts:74-80`); the composition root
  refuses capture when no tenant coordinate key is bound (`apps/backend/src/index.ts:6798-6805`).
- **Verified:** ordinary event GET/list DTOs are coordinate-free (`evv-typebox.ts:184-261`).
- **Verified:** device time cannot lead server time; capture rejects it
  (`event-lifecycle.ts:98-115`). This is stricter than merely preserving clock skew and needs explicit client copy.
- **Verified:** outside-geofence and suspected-spoof signals are advisory, recorded rather than care-blocking
  (`event-lifecycle.ts:12-14,158-215`).
- **Unverified:** signature/biometric and platform attestation behavior on a real handset. No client exists.
- **Unverified:** exact-coordinate read warning level. The route is read-audited, but WP0 did not inspect a live
  audit row.

## 8. Offline truth table

| Concern | Current truth | Classification |
|---|---|---|
| Supported clients | Request schema accepts iOS/Android device registrations; no actual client app exists. | Deferred capability |
| Local storage | The spec claims SQLCipher, but no client implementation exists in the repository. | Unverified / deferred |
| Pending/sync UI | No local pending, syncing, rejected, or confirmed UI. | Deferred capability |
| Retry/dedupe | v2 uses durable `(org, device, localId)` receipts and per-item results. Focused tests passed. | Verified at unit/injection level |
| Duplicate replay | Same capture returns `already_applied`; changed payload conflicts. | Verified at unit/injection level |
| Out-of-order events | v2 sorts by visit/time/kind and rejects causally impossible checkout. | Verified from source/tests |
| Partial failure | Legacy endpoint can commit early events before a runtime failure; v2 reports each result. | Verified source observation |
| Token/session expiry | Server auth fails; no client recovery UX exists. | Deferred capability |
| User/device switch | Server binds approved device to membership; local data isolation cannot be tested without a client. | Partly verified server-side; client unverified |
| Lost-device recovery | Suspend/retire controls exist; local queue erasure/recovery does not. | Deferred capability |

**Proposal constraint:** build against `/offline-sync/v2`; do not expand the legacy endpoint. A client must never
render "EVV recorded" before an `applied` or `already_applied` server result.

## 9. Security and tenancy evidence

- Capture permissions compose assigned-clinician and visit-window predicates, with break-glass disabled
  (`evv-routes.ts:148-177`).
- Correction and supervisor override resolve step-up from server session state, never a request flag
  (`evv-routes.ts:92-102,521-552,726-741`).
- The event table is append-only except supersede markers, RLS protected, and write-audited
  (`packages/db/migrations/0047_evv_m18_rls_audit_triggers.sql:120-145,187-223`).
- All focused architecture checks passed (§14): tenancy, header auth, context attributes, route reachability,
  ABAC declaration/composition, live-suite wiring, and outbox bindings.
- **Unverified:** live NOBYPASSRLS cross-tenant capture/read/correction tests were inventoried but not run.
- **Deferred:** device-attestation enforcement remains off until an attested client exists.

## 10. Applicability matrix

| Case | Current rule | Implementation status |
|---|---|---|
| Medicare hospice | Operational visit verification; never universal `regulatory_required` claim blocking | Architecture decision verified; UI wording needs qualification. |
| Medicaid, mandating state/program/service | EVV and possibly aggregator submission may be required | Applicability remains configuration/domain dependent; no universal UI claim allowed. |
| Oregon requiring state submission | Requires an Oregon adapter before go-live | Deferred; OR-PTC DCI not built. |
| Sandata-configured state | Sandata adapter and configurable HTTP transport exist | Integration contract/sandbox/production behavior unverified. |
| Open model, no aggregator | Local verification may complete without external transmission | Adapter exists and short-circuits locally. |

No current external regulatory lookup was performed during WP0. ADR decisions are the repository authority;
state/vendor contracts must be revalidated before enforcement or production transmission.

## 11. Aggregator capability audit

**Verified implementation:**

- Check-out outbox consumption prepares a submission only when it has a pair and configured applicable state
  (`jobs/submission-prep.ts:28-41,67-121`).
- Per-minute submit, five-minute poll, and daily DEK reseal schedules are registered
  (`jobs/queues.ts:8-28`; `jobs/cron-workers.ts:89-124`).
- Corrections repoint or requeue nonaccepted submissions; already accepted submissions are left alone
  (`submission-prep.ts:125-175`).
- UI separates queued/submitting/submitted/accepted/rejected/timeout/cancelled and offers resubmit only from
  rejected/timeout (`apps/web/src/modules/18-evv/evv-api.ts:101-135`).

**Unverified or deferred:**

- No real Sandata sandbox or production call was made.
- Vendor field names are explicitly working assumptions.
- `patientStateIdentifier` is unbound and fail-closed; clinician NPI is null.
- BAA/trading-partner execution and production credential governance were not evidenced.
- There is no explicit "not configured" status in the submission dashboard; absence appears as an empty queue.

## 12. UI walkthrough results

Static walkthroughs used fictional roles and no patient data:

| Scenario | Result |
|---|---|
| Assigned electronic check-in/check-out | Blocked: no client surface exists. |
| Early/late or unassigned capture | Server guards and tests exist; no client error UX exists. |
| Denied location / degraded GPS | Server contracts exist; no client permission/retake UX exists. |
| Missing checkout | Worker and queue exist; focused worker tests pass; not exercised live. |
| Offline reconnect / duplicate | v2 API behavior tested; no client queue. |
| Event correction | Backend route/state machine exists; no web action. |
| Clinician attestation | Missing-resolution queue exposes it, but the primary web visit action is a separate M17 missing-EVV attestation. |
| Supervisor override | Modal/action exists and server requires fresh step-up; not browser-run. |
| Submission rejection | Queue/action code exists; no seeded live rejection journey run. |
| Device approval | Existing Playwright spec covers it, but was not run in WP0 because API/web were stopped and the spec consumes seed state. |

No screenshots were collected. Desktop/mobile visual claims, touch targets, keyboard-only behavior, screen-reader
announcements, contrast, geolocation denial, and poor-connectivity behavior remain **not run**. Existing components
use semantic labels and `role="alert"` in many error states, and the device E2E includes axe, but source inspection
does not replace an accessibility run.

## 13. Scope proposal and wireframes

### 13.1 Reuse / consolidate / modify / defer

| Decision | Scope |
|---|---|
| Reuse | Server routes, TypeBox/OpenAPI contracts, event and resolution machines, v2 offline receipts, encrypted-coordinate service, M18 workers, device/geofence/submission lifecycle controls, typed error envelope. |
| Consolidate | Dashboard, events, resolutions and submissions under one EVV Operations workspace with stable tabs and cross-links. Keep policy/devices in an admin subsection. |
| Modify after approval | Fix M24 deep links; add shared EVV workspace navigation; make Needs attention the default; add event evidence/provenance timeline; surface server-supported correction with step-up; add honest integration-not-configured states. |
| Separate product/architecture approval | Build the Capacitor client, local encrypted queue, platform attestation, geolocation permission flow, real Sandata transport verification, Oregon adapter, or new PHI/location storage. |
| Defer | Any claim that offline capture, background location, device attestation, or production aggregator submission is available before real-device/vendor evidence. |

### 13.2 Proposed supervisor workspace

```text
+ EVV Operations ---------------------------------------------------------+
| Needs attention | Events | Submissions | Policies & devices              |
| [Open 12] [Rejected 2] [Pending devices 1] [Verified today 94%]         |
|-------------------------------------------------------------------------|
| Cause / visit / clinician / age / status                | Next action  |
| Missing checkout · Visit … · RN … · 5h                  | Review       |
| Sandata rejection · Visit … · TX · code …               | Reconcile    |
|-------------------------------------------------------------------------|
| Selecting a row opens a stable detail route/drawer:                    |
| Problem → original evidence → correction history → allowed action      |
+-------------------------------------------------------------------------+
```

### 13.3 Proposed clinician state card (future mobile client only)

```text
+ Today's visit ----------------------------------------------------------+
| Patient safety identifiers · scheduled window · purpose                |
| Visit: Published   Documentation: Draft   EVV: Not recorded             |
|                                                                         |
| [ Start visit / Check in ]                                              |
| Captures location only for this visit.                                  |
|                                                                         |
| Offline: "Saved on this device — not yet received by ChartWarden"      |
| Server receipt: "Checked in at 10:14 AM"                               |
+-------------------------------------------------------------------------+
```

The existing web missing-EVV attestation must remain visually distinct: **"Record visit without electronic
verification"**, with step-up and reason, rather than masquerading as normal check-in.

## 14. Tests and commands

### Passed

Focused non-live command:

```sh
bunx vitest run \
  apps/backend/__tests__/evv-aggregator.test.ts \
  apps/backend/__tests__/evv-capture-guards.test.ts \
  apps/backend/__tests__/evv-event-lifecycle.test.ts \
  apps/backend/__tests__/evv-geofence.test.ts \
  apps/backend/__tests__/evv-inject.test.ts \
  apps/backend/__tests__/evv-missing-resolution.test.ts \
  apps/backend/__tests__/evv-offline-idempotency.test.ts \
  apps/backend/__tests__/evv-seams.test.ts \
  apps/backend/__tests__/evv-workflow-acceptance.test.ts \
  apps/backend/__tests__/m18-evv-dek-rotation.test.ts \
  apps/backend/__tests__/m18-evv-workers.test.ts \
  apps/backend/src/modules/18-evv/__tests__/coords.test.ts \
  apps/web/src/modules/18-evv/evv-writes.dom.test.tsx \
  apps/web/src/modules/17-scheduling/__tests__/visit-workflow.dom.test.tsx
```

Result: **14 files passed, 332 tests passed, 0 failed, 0 skipped** in 7.75 s. The run emitted expected
test-environment warnings that `BETTER_AUTH_SECRET` was absent; production refuses that configuration.

Architecture checks passed:

- `arch:tenancy`
- `arch:request-header-auth`
- `arch:context-attributes`
- `arch:route-reachability`
- `arch:abac-predicates`
- `arch:abac-composed`
- `arch:live-suites`
- `arch:outbox-bindings`

### Not run

- M18 live suites (`test:m18:read:live`, `test:m18:write:live`, `test:m18:workers:live`, DEK rotation), because
  they require a private disposable Postgres and must not target the shared compose cluster.
- Playwright `e2e/specs/evv.spec.ts`, because API/web were not running and the spec consumes seeded device state.
- Real-device iOS/Android, offline, geolocation, attestation, lost-device, and user-switch tests: no client.
- Sandata sandbox/production integration and BAA/trading-partner verification.
- Full `bun run build`, `bun run typecheck`, `bun run arch:fitness`, `bun run test`, and
  `check:boot:platform`; WP0 changed documentation only and ran the focused gates above.

## 15. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| UI implies electronic capture while executing missing-EVV self-attestation | High | Rename/separate the exception action; do not call it verified check-in. |
| Shipping WP2 without a real mobile client creates a web capture path that cannot attest device/location truth | High | Separate mobile product slice and security review; keep browser capture unsupported. |
| Configured Sandata endpoint transmits against unverified field assumptions or without BAA | Critical | Production start refusal tied to integration governance; sandbox contract tests before enablement. |
| Blank/unbound aggregator configuration looks like success or an empty healthy queue | High | Explicit Not configured / blocked configuration state. |
| M24 remediation link sends users to a 404 | Medium | Narrow frontend fix to `/evv/missing-resolutions`; add route test. |
| Correction exists server-side but is undiscoverable | Medium | Add action from event detail with step-up and provenance review. |
| Legacy offline endpoint permits partial commit without per-item proof | Medium | New client uses v2 only; retain legacy compatibility without new UX. |
| Stale plan/screen comments are repeated as runtime truth | Medium | Update plan and UI spec in PR0/PR1; cite ADR-0044 and actual wiring. |
| Accessibility and mobile layout are assumed from components | Medium | Browser axe + keyboard + screen-reader + 375/768/1440 checks before release. |

## 16. Proposed PR boundaries

| PR | Scope | Gate |
|---|---|---|
| PR-0 | This evidence; correct stale Workflow 10/EVV screen-spec statements only | Human approval; docs checks |
| PR-1 | Fix broken M24 link; shared EVV Operations navigation; Needs attention composition over existing reads | DOM/navigation/a11y tests; no backend change |
| PR-2 | Event evidence timeline and existing correction route UI | Step-up, concurrency, provenance, direct-API negatives |
| PR-3 | Honest aggregator configuration/status presentation and submission drill-down | No fabricated acceptance; tenant isolation; worker/live proof |
| PR-4 | Mobile/Capacitor capture + device registration, only after separate product/security approval | Real devices, location permission, attestation, privacy review |
| PR-5 | Offline v2 client queue, only after PR-4 and approved local PHI model | Encryption, user/device switch, duplicate/out-of-order/reconnect/lost-device tests |
| PR-6 | Vendor/state adapter work, separately approved | BAA/trading partner, sandbox contract, production start refusal, rollback |

## 17. Approval decisions required

1. Approve PR-0/PR-1 as the first implementation slice: documentation corrections, the broken M24 link, and
   supervisor workspace consolidation with no backend behavior change.
2. Decide whether event correction UI belongs in the next slice (PR-2) or remains supervisor back-office only.
3. Treat the clinician capture/offline work as a separate mobile product initiative rather than ordinary WP2/WP3
   web implementation.
4. Keep all vendor/state integration work blocked until a specific state/program/service requirement and executed
   integration governance evidence are supplied.

**STOP GATE AT AUDIT COMPLETION:** No application changes were made during WP0. PR-0/PR-1 were subsequently
approved on 2026-11-19 and implemented as recorded in the parent plan; later slices still require their own
approval.

## 18. Post-audit implementation record — 2026-11-19

The user subsequently approved PR-2. Event detail now follows the immutable predecessor/successor links, labels
the live head, and offers the existing correction-of-record route only as an affordance for a permitted session
viewing that live head. The correction ceremony requires the route's complete replacement capture and
60-character reason, preserves the typed draft across a genuine fresh-step-up return, and navigates to the
server-returned replacement event. Server permission, step-up freshness, kind matching, concurrency and atomic
provenance remain authoritative.

Focused DOM coverage verifies the evidence chain, permission/live-head affordance, exact correction payload and
step-up draft restoration. Read-only browser QA of the six EVV workspace routes at 375/768/1440 pixels found no
fallback screen, horizontal overflow, failed request or final WCAG A/AA axe violation. No screenshot baseline was
available, so pixel-level visual comparison remains not run. This follow-up did not run a live correction against
the shared database, real-device/offline tests or a vendor sandbox.
