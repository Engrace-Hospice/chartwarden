# Workflow 04 — Visit & Encounter Current-State Audit

**Audit date:** 2026-11-14

**Audited revision:** `bb71a8baf` (`develop`)

**Scope:** G0 evidence only; no product implementation is authorized by this document

**Parent plan:**
[`ChartWarden_Workflow_04_Visit_Encounter_Documentation.md`](./ChartWarden_Workflow_04_Visit_Encounter_Documentation.md)

## 1. Executive finding

The authoritative scheduling, encounter, care-plan, and EVV lifecycles already exist and should be
preserved. M17 publishes a visit, M8 idempotently seeds and owns the encounter, M18 supplies EVV
truth, and M7 supplies care-plan-review truth. The first implementation slice does not need a new
endpoint, migration, state, permission, or cross-module write.

The joined clinician journey is nevertheless incomplete at the presentation and browser-evidence
layers:

- visit and encounter pages link to one another, but return context is inconsistent and the composer
  uses browser history rather than a deterministic deep link;
- M8's server optimistic concurrency works, but the composer has no dirty-navigation, unload,
  multi-tab recovery, autosave, or offline-draft mechanism;
- the encounter record and composer do not adapt to narrow screens, and the composer lacks the
  persistent patient banner used by the list/read surfaces;
- gate failures are displayed, but they do not consistently link to the canonical correction route;
- the existing Playwright suites test scheduling and encounter authoring separately, not the
  published-visit-to-signed-encounter continuity; and
- the repository describes mobile/Capacitor EVV capture but contains no mobile application artifact
  that can prove that UI journey.

Recommendation: approve a presentation-and-evidence first slice limited to continuity, patient
context, responsive layout, save/dirty-state clarity, actionable remediation, and the joined RN
browser journey. Preserve all existing routes and backend contracts.

## 2. Authority and ownership

| Concern | Current authority | Evidence | G0 conclusion |
|---|---|---|---|
| Visit schedule, assignment, and lifecycle | M17 | `packages/scheduling/src/lifecycle/visit-machine.ts:31-198` | Preserve |
| Encounter content, lifecycle, signatures, and addenda | M8 | `apps/backend/src/modules/08-encounters/lifecycle/encounter.ts:51-165`; `lifecycle/addendum.ts:29-84` | Preserve |
| EVV events, bracket, corrections, and missing-resolution queue | M18 | `apps/backend/src/modules/18-evv/routes/evv-routes.ts:130-535`; `seams/index.ts:62-81` | Preserve |
| Care-plan review status and correction | M7 | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:529-538`; `apps/web/src/modules/07-care-plan/screens.ts:66-101` | Consume through seam/route only |
| Cross-module handoff | M17 outbox → M8 consumer; M8 signed event → M17 consumer | `apps/backend/src/modules/08-encounters/consumers/seed-visit-encounter.ts:1-103`; `apps/backend/src/modules/17-scheduling/consumers/index.ts:167-258` | Preserve asynchronous ownership |

The UI must not collapse visit, encounter, and EVV into one synthetic state. A draft encounter does
not mean a visit is complete, and a visit status does not prove a signed clinical record exists.

## 3. Current route and deep-link map

### 3.1 Registered browser routes

| Surface | Route | Registration / behavior |
|---|---|---|
| Clinician work list | `/me/visits` | `apps/web/src/modules/17-scheduling/screens.ts:166-173` |
| Visit detail | `/scheduling/visits/:visitId` | `apps/web/src/modules/17-scheduling/screens.ts:158-164` |
| Patient encounters | `/patients/:patientId/encounters` | `apps/web/src/modules/08-encounters/screens.ts:40-46` |
| Encounter record | `/patients/:patientId/encounters/:encounterId` | `apps/web/src/modules/08-encounters/screens.ts:48-54` |
| Encounter composer | `/patients/:patientId/encounters/:encounterId/compose` | `apps/web/src/modules/08-encounters/screens.ts:56-63` |
| Draft work queue | `/work/drafts` | `apps/web/src/modules/08-encounters/screens.ts:74-80` |
| Cosign work queue | `/work/cosignatures` | `apps/web/src/modules/08-encounters/screens.ts:65-72` |
| Canonical care-plan correction | `/patients/:patientId/care-plan` | `apps/web/src/modules/07-care-plan/screens.ts:66-101` |
| Missing-EVV queue | `/evv/missing-resolutions` | `apps/web/src/modules/18-evv/screens.ts:93-100` |

The visit detail reconstructs its calendar return link from `view`, `patient`, the visit service
date, and the visit id (`visit-detail.tsx:131-166`). The calendar route documents `membership`,
`date`, and `weekStart` variants (`screens.ts:113-128`). The M17 → M8 link does not carry these return
parameters: visit detail and My Visits navigate directly to the encounter record
(`visit-detail.tsx:206-219`; `my-visits.tsx:148-155`). The reverse link is a direct visit-detail route
(`encounter-read.tsx:1938-1950`). The composer header uses `navigate(-1)`, so a direct deep link has
no deterministic return target (`encounter-compose.tsx:298-331`).

### 3.2 Handoff implementation

On `m17.visit.published`, the M8 consumer validates the event, reads active-service facts, and either
skips or idempotently seeds a draft (`seed-visit-encounter.ts:30-103`). The My Visits and visit-detail
screens then discover the link by listing encounters and matching `visitId`, so the UI may briefly
show “still being created”/“Processing” (`my-visits.tsx:148-155`; `visit-detail.tsx:54-76,206-219`).
That is an asynchronous handoff, not a client-side encounter creation contract.

When M8 publishes `m8.encounter.signed`, M17's consumer performs the system-owned completion
transition. The M17 state machine accepts completion only from that event path
(`packages/scheduling/src/lifecycle/visit-machine.ts:188-198`). The client must not mark a visit
complete because a save, finalize, or primary-signature request appeared successful.

## 4. Lifecycle, version, idempotency, and retry truth

### 4.1 Visit

The legal visit progression is `proposed → published → en_route → in_visit → completed`, with
cancelled/no-show/error terminal alternatives (`visit-machine.ts:82-92`). Start/arrive accepts M18
EVV evidence or a self-attestation; self-attestation requires a reason of at least 40 characters and
fresh step-up (`visit-machine.ts:31-41,108-126`). M17 mutations require an idempotency key at the
route boundary (`apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:130-160`).

### 4.2 Encounter

The M8 graph is `draft → finalized → signed`, or `draft → finalized → cosign_pending → cosigned`;
`voided` is terminal (`lifecycle/encounter.ts:51-61`). Finalize previews the Layer-3 gate. Sign
re-enforces the gate, requires fresh step-up, freezes selections, writes a signature, emits the
signed event, and opens a cosign request for LPN/CHHA when required
(`lifecycle/encounter.ts:93-146`). Signed content is never reopened for editing.

Selection and mutable-child updates use `If-Match`; the route helper rejects stale versions
(`routes/encounters-routes.ts:209-214,311-334,394-409,464-479`). The web client sends the stored
version and renders `STALE_VERSION` as a reload-required warning
(`apps/web/src/modules/08-encounters/encounters-api.ts:225-257`;
`encounter-compose.tsx:56-68`). It does not merge concurrent edits or automatically retry them.

Cosign requests use explicit acknowledgement/sign/release transitions and 12/24/48-hour timing
rules (`cosignature/cosignature.ts:63-73,134-171`). Late-entry tiers are calculated from configured
ceilings and require the applicable override (`late-entry/tiers.ts:1-55`). Addenda have their own
draft/finalized/signed lifecycle; signing freezes the addendum while retaining the immutable parent
(`lifecycle/addendum.ts:3-11,29-84`).

## 5. M8 API inventory

| Capability | Current route/evidence | Controls of note |
|---|---|---|
| Create/list/read drafts | `POST /api/v1/encounters`; list, my-drafts, and read at `encounters-routes.ts:221-309` | Discipline derived from role; caseload-scope/non-leak guards |
| Template and selections | `GET/PATCH .../template|selections`, `encounters-routes.ts:311-379` | `If-Match` on write; selection read audited |
| Vitals and mileage | `encounters-routes.ts:382-497` | Scoped author/supervisor writes; PHI reads audited |
| Care-plan links | `encounters-routes.ts:499-558` | M8 stores references, not M7 content |
| EVV reconciliation | `encounters-routes.ts:561-580` | Consumes M18 truth through its seam |
| Finalize and sign | `encounters-routes.ts:582-640` | Author scope; sign requires fresh step-up |
| Late/admin override and void | `encounters-routes.ts:643-693` | Separate permissions; step-up on overrides |
| Cosignature | `encounters-routes.ts:695-759` | Qualified-role ABAC; step-up on sign/release |
| Addenda | `encounters-routes.ts:762-908` | Separate author/sign permissions, `If-Match`, fresh step-up |

No new API is required for the proposed first slice.

## 6. Permission, ABAC, RLS, and audit controls

M8 maps authenticated role keys to authorable disciplines and refuses a body-claimed discipline the
actor does not hold (`encounters-routes.ts:121-150,221-240`). Routes compose explicit read, author,
finalize, sign, cosign, addendum, override, vitals, and mileage permissions
(`encounters-routes.ts:152-175`). `encounter.scope` returns non-leaking not-found behavior outside the
caseload, while author, supervisor, addendum-author, and qualified-cosigner predicates constrain the
operation (`encounters-routes.ts:176-211`; `apps/backend/src/modules/08-encounters/abac-predicates.ts:1-28`).

Signature, cosignature, addendum signature, and privileged override routes compose server-verified
fresh-auth checks (`encounters-routes.ts:622-675,725-759,885-908`). PHI reads declare resource ids or
list audit configuration—for example encounter, selection, vitals, mileage, and cosignature reads
(`encounters-routes.ts:243-309,338-355,413-447,482-497,695-708`).

M8, M17, and M18 tables have tenant RLS and write-audit/immutability controls in their module
migrations: `packages/db/migrations/0031_encounters_m8_rls_audit_triggers.sql`,
`0045_scheduling_m17_rls_audit_triggers.sql`, and `0047_evv_m18_rls_audit_triggers.sql`. M18's event
ledger is append-only and its offline id is unique (`0047_evv_m18_rls_audit_triggers.sql:40-89,120-136`).
The existing live suites use the application role to prove these rules; browser visibility is not a
substitute for RLS evidence.

## 7. Compliance gates and correction routes

M8 owns a 12-check Layer-3 gate and returns structured remediation. It checks required sections,
vitals/scales, care-plan review status, EVV bracket, late entry, and other encounter facts
(`apps/backend/src/modules/08-encounters/gate/gate.ts:1-11,48-103`). Care-plan overdue status is read
through `CarePlanReader`, and EVV bracket status through `EvvBracketResolver`
(`apps/backend/src/modules/08-encounters/seams/index.ts:105-127`;
`apps/backend/src/modules/18-evv/seams/index.ts:62-81`).

The encounter record already links to `/patients/:patientId/care-plan`, but the composer renders a
generic gate message without a guaranteed canonical link. Workflow 04 should reuse the M7 route and
server-supplied blocker; it must not reproduce the care-plan rule client-side.

## 8. EVV, mobile, and offline truth

M18 check-in/check-out routes derive target visit, assignment, window, posture, and attestation
facts server-side; capture has no break-glass override (`evv-routes.ts:130-237`). The v2 offline sync
contract enforces unique local ids and causal ordering and classifies each item as applied,
already-applied, rejected, or retryable (`evv-routes.ts:332-455`). The older batch route preflights
the batch but processes events in independent transactions, so a runtime failure can leave an
applied prefix (`evv-routes.ts:240-330`). Workflow 04 must not promise stronger atomicity.

The web registry explicitly says check-in/check-out capture and device self-registration belong to
a Capacitor mobile flow (`apps/web/src/modules/18-evv/screens.ts:36-39`). No Capacitor/mobile client
artifact exists in `apps/` in this checkout. Therefore the backend capture and offline contracts are
implemented, but the mobile UI journey is not verifiable from this repository. Web surfaces should
show M18 status and link to reconciliation; they should not simulate attested device capture.

The comment at `apps/web/src/modules/18-evv/screens.ts:24-34` says missing-resolution production is
deferred, but current code now creates missing resolutions idempotently
(`apps/backend/src/modules/18-evv/jobs/late-check-sweep.ts:4-14`). The screen comment is stale; the
job code is current authority.

## 9. Draft persistence and interruption behavior

The composer initializes React state from canonical M8 reads and persists only when the clinician
uses the explicit save action (`encounter-compose.tsx:222-278`). Repository search found no M8 use
of `beforeunload`, a route blocker, `localStorage`, IndexedDB, service-worker draft persistence, or
offline mutation queue. The global offline banner warns that changes will not save
(`apps/web/src/shell/offline-banner.tsx:1-40`), but it does not preserve encounter edits.

Consequences:

- explicit saves are canonical and version-checked;
- unsaved React state is lost on reload, direct navigation, or tab close;
- in-flight navigation is not protected;
- two tabs receive a server `STALE_VERSION` result, but there is no merge/recovery workspace; and
- no claim of offline encounter authoring is supportable today.

The first slice may add dirty/in-flight protection and accurate status messaging without persisting
PHI in browser storage. Durable offline authoring requires a separate privacy, conflict, protocol,
and mobile boundary approval.

## 10. Browser/runtime audit

The audit used the synthetic RN account against the local application at `http://localhost:5173`.
It loaded `/me/visits`, one linked encounter record, and its composer at 375×812, 768×1024, and
1440×1000. Screenshots were retained only in `/private/tmp/chartwarden-wf04-g0/`; filenames contain
route and viewport only.

| Surface | 375 px | 768 px | 1440 px | Runtime/a11y result |
|---|---|---|---|---|
| My Visits | Usable | Usable | Usable | No axe violation; 350 responses |
| Encounter record | Two-column content clips/overlaps | Right rail remains cramped | Usable | Serious contrast failure at all widths; 366 responses |
| Composer | Progress labels overlap; three-column workspace clips | Workspace remains too wide | Usable | Serious “Required” badge contrast at 768/1440; 348 responses |

All nine loads retained their intended deep link and produced no console error, page exception, or
HTTP response ≥400. Root-level overflow measured zero because fixed-width children are clipped by
containers; visual screenshots expose the inaccessible content. The fixed sources are the composer
summary and three-column inline styles (`encounter-compose.tsx:799-869,985-990`) and record
`1fr + 20rem` grid (`encounter-read.tsx:2674-2688`).

Lab observations were CLS `0`, FCP 76–80 ms, and LCP 160–244 ms. These are local single-load
observations, not production percentiles. INP was not measured because the run performed no
qualifying interaction. The 348–366 response counts are unbounded enough to require a request
inventory in the implementation slice; the browser performance resource buffer saturated at 250,
so its entry count is not the source of truth.

The existing encounter Playwright happy path failed before authoring because its selector interpreted
the numbered accessible label as `1Reason for Visit` and then searched for a matching button
(`e2e/specs/encounters.spec.ts:58-205`). This is test-selector drift against the current UI, not a
server or page-load failure. It must be repaired before it can provide release evidence.

## 11. Test matrix coverage

| ID | Current evidence | G0 status |
|---|---|---|
| T01 | Scheduling Playwright opens/schedules visits; M17 DOM tests cover visit actions | Partial: no joined patient/visit/encounter assertion |
| T02 | M8 seed consumer and acceptance tests prove idempotent creation | Backend covered; browser repeat-click gap |
| T03 | Encounter acceptance/live tests and composer save path | Covered below browser; current Playwright selector broken |
| T04 | API error mapping only | Missing retained-local-work browser proof |
| T05 | No unload/route blocker | Missing |
| T06 | `If-Match`, stale-version acceptance/live tests | Backend covered; two-tab browser proof missing |
| T07 | Compliance-gate unit/acceptance tests | Backend covered; actionable-link browser proof missing |
| T08 | Lifecycle, real-publisher/live, and encounter Playwright intent | Backend covered; browser journey currently broken |
| T09 | Permission/ABAC route tests | Backend covered; direct browser denial incomplete |
| T10 | Cosignature unit/acceptance/live tests | Backend covered; browser role journey missing |
| T11 | Cosignature lifecycle tests | Backend covered; browser role journey missing |
| T12 | Addendum lifecycle/routes and acceptance tests | Backend covered; browser journey missing |
| T13 | M18 workflow/live suites and bracket seam | Backend covered; no capture-client artifact |
| T14 | M8 gate + M7 seam tests | Gate covered; canonical correction-link journey missing |
| T15 | M8 signed-event/M17 consumer tests | Backend covered; joined browser continuity missing |
| T16 | Scope/tenant/RLS live tests | Backend/live covered; browser denial needs joined evidence |
| T17 | M18 v2 contract tests | Capture backend only; encounter recovery unsupported |
| T18 | Isolated axe checks exist | Fails G0 runtime at responsive layout/contrast |
| T19 | G0 lab load and error capture | Fails bounded-request evidence; INP unmeasured |
| T20 | Compliance harness, synthetic fixtures, temp evidence naming | No browser storage added; retain as release gate |

Primary existing suites are `apps/backend/__tests__/encounter-workflow-acceptance.test.ts`,
`encounter-compliance-gate.test.ts`, `encounter-lifecycle.test.ts`,
`m8-encounters-write.live.test.ts`, the M17/M18 workflow and live suites, M8/M17 DOM tests, and
`e2e/specs/{scheduling,encounters,evv}.spec.ts`. Their separation is precisely why T01/T15 still
need one joined browser journey.

## 12. Preserve / reuse / change / defer

| Decision | Exact boundary |
|---|---|
| Preserve | Every registered route and deep link; M17/M8/M18/M7 ownership; all state machines; asynchronous outbox handoff; M8 gate; `If-Match`; step-up; ABAC/RLS/audit; signed immutability; addenda and cosign semantics |
| Reuse | Visit-published seed consumer, linked `visitId`, existing patient/visit/encounter reads, composer and record components, `CarePlanReader`, `EvvBracketResolver`, shared patient banner, current error envelope and step-up redirect |
| Change after approval | Presentation/navigation only: deterministic return context, patient banner in composer, responsive record/composer layout, save/dirty/in-flight clarity, canonical remediation links, contrast fixes, stable selectors, joined RN Playwright journey, responsive/a11y/request evidence |
| Defer | New API/schema/state/permission; persistent browser PHI; offline encounter sync; mobile/Capacitor capture client; protocol/atomicity changes; broad cosign/addendum redesign; AI changes; downstream module redesign |

## 13. Proposed first implementation boundary for approval

The next slice should contain only:

1. M17 → M8 navigation continuity using existing ids and routes, with deterministic schedule/chart
   return context and no duplicate-creation client logic.
2. Patient identity context on the composer plus responsive single-column/stacked behavior for the
   record and composer at 375 and 768 px.
3. Accurate saved/unsaved/in-flight/stale messaging and dirty-navigation protection without browser
   PHI persistence or offline claims.
4. Existing server blocker rendering with links to canonical M7/M18 surfaces, plus the identified
   contrast corrections.
5. Repair of the drifted Playwright selector and one synthetic RN journey proving published visit →
   seeded draft → start/arrive → author/finalize/sign → the same signed encounter from schedule and
   chart, with responsive, axe, console/network, and request-inventory evidence.

Cosignature, addendum presentation, mobile capture, and offline persistence remain later separately
approved slices. G0 is complete when this evidence document is accepted; product work must not start
until the boundary above is approved.
