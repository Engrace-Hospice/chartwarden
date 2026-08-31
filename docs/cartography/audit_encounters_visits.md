# WardenX Focused Audit: Encounters / Visits

Source of truth: running repository implementation as inspected on 2026-08-30. This audit intentionally does not treat specs as authoritative unless the production code implements them.

## A. What exists today

Production-usable pieces exist, but not as a complete web workflow.

- M17 Scheduling owns scheduled Visit records: planned time, assigned membership, purpose/setting, cancellation, no-show, reschedule, reassignment, recurring-policy rows, state history, availability, time off, and route optimization reads.
- M8 Encounters owns clinical Encounter records: draft/finalized/signed/cosign/void states, authoring identity, service date, discipline/type, optional visit linkage, vitals, mileage, signatures, cosignature requests, addenda, voiding, and late-entry override event concepts.
- M17 has real backend APIs for creating, editing, starting, cancelling, rescheduling, marking no-show, reassigning, listing, and reading visits.
- M8 has real backend APIs for creating encounter drafts, listing/reading encounters, capturing vitals/mileage, finalizing, signing, cosigning, voiding draft encounters, and managing addenda.
- A live M8 outbox consumer is registered for `m17.visit.published`; it creates a draft encounter for a scheduled visit when the admission is active.
- M9 and M10 can store optional encounter references on assessment records.
- M11 can store optional encounter references on order records.
- M17 and M8 have RLS/audit migrations and live RLS tests.

Direct answers to the explicit questions:

1. Users cannot create Visits today from the web UI. Visit creation is API-only.
2. Visits can exist without Encounters. `visit.encounter_id` is nullable, and encounter creation is asynchronous through the M8 consumer.
3. Encounters can exist without scheduled Visits. `encounter.visit_id` is nullable.
4. Users cannot create unscheduled/PRN Encounters from the UI. The API can create a draft without `visitId`, but manual unscheduled drafts lack siting and are likely not signable without additional data.
5. Visit scheduling is owned by M17.
6. Clinical Encounter documentation is owned by M8.
7. Visit-to-Encounter linkage is partially enforced: M8 enforces at most one encounter per non-null `visit_id`, but neither table requires the link.
8. Clinicians can start a Visit through the M17 API; there is no M8 Start Encounter or End Encounter route, and the UI exposes neither.
9. Users can sign finalized encounters from the UI, but the UI does not expose create, document, or finalize, so normal UI signing is only possible for already-finalized records.
10. Signed/cosigned/voided encounter edits are blocked by M8 service guards for the documented write routes.
11. Corrections/amendments are represented by addenda APIs, but the UI does not expose them and the service allows addenda on any non-void parent, not only signed encounters.
12. M8 has care-plan link tables/routes, but the production route/service discard the posted link body and do not insert link rows. So this is not currently usable.
13. Encounter completion/signature does not automatically mutate M7 care plan content.
14. Assessments can be optionally linked to encounters through M9/M10 APIs; M8 UI does not launch or list them.
15. HUV1/HUV2 and HOPE admission/discharge timepoints exist independently of encounters unless `sourceEncounterId` is supplied to the M10 timepoint API. SFV currently exists independently of M8.
16. Visits can be assigned at creation and reassigned through M17 API. Assignment history is captured in visit state history/outbox.
17. Discipline, credential, PTO, and caseload checks exist for M17 creation/reassignment. M8 manual create has much thinner guard coverage.
18. Recurring visit policies and pure recurrence materialization exist, but production routes do not materialize future visit instances and no registered job was found.
19. Missed visits can be marked manually through the M17 API. No registered automatic missed-visit detector was found.
20. Users cannot cancel/reschedule visits from the web UI; backend APIs exist.
21. Reschedule API preserves history by marking the original visit `rescheduled` and creating a new visit. Plain PATCH edits can still overwrite schedule fields without reschedule lineage.
22. Admission hold does not appear to pause/cancel/update scheduled visits.
23. Future visits are not automatically cancelled on admission discharge in the inspected production wiring.
24. Unsigned/late encounter concepts and events exist; confirmed production alert/watchdog wiring is incomplete or absent.
25. A clinician worklist exists as a read-only web screen for upcoming/my visits and draft encounters.
26. No single E2E was found proving Visit -> Encounter -> Document -> Finalize -> Sign through the web UI.
27. Top blockers are missing UI create/manage actions, missing M8 documentation persistence for core note/care-plan links, missing start/end encounter workflow, missing live M8 signed -> M17 completion binding, and missing admission lifecycle cleanup.

## B. What is partially wired

- Scheduled Visit -> draft Encounter: M17 emits `m17.visit.published`; M8 consumes it and seeds a draft encounter. This depends on outbox delivery and an active admission check in the consumer.
- Encounter -> Visit completion: M8 declares `m8.encounter.signed` with M17 as a consumer, and the M17 pure visit machine has a system-only complete transition. The inspected backend dispatcher does not register an M17 consumer for `m8.encounter.signed`, and the M17 complete transition only applies from `in_visit`, while most visits remain `published` or `en_route`.
- Recurrence: `recurring_visit` table, API, pure RRULE materializer, and tests exist. The production create route stores the recurring policy but does not materialize visits, and no registered job was found.
- Care Plan -> Visit: M17 has pure proposal generation from frequency text and `visit_proposal` tables/routes. No registered job or live M7 event consumer was found that turns care-plan interventions into proposals automatically.
- Care Plan -> Encounter: tables and API routes exist for encounter care-plan links, but the route/service currently ignore the posted problem/goal/intervention IDs and do not insert link rows.
- Assessment/HOPE linkage: M9/M10 can store optional encounter references; M8 does not launch assessments or display linked assessment status.
- Orders linkage: M11 can store `source_encounter_id`; there is no live order-to-visit scheduling flow.
- Alerts: M17/M8 event catalogs declare alert-worthy events; confirmed job-driven or M36-delivered visit/encounter attention flows are not complete.

## C. Scaffold/mock/spec only

- M8 clinical note/HearthNote selections are API-shaped but not meaningfully persisted by the production route service. `PATCH /api/v1/encounters/:encounterId/selections` validates no body in the route and only bumps version.
- M8 care-plan-link request body is API-shaped but effectively discarded.
- M8 EVV-missing reason and late/admin override reason bodies are parsed in route schemas but the service stores sentinel reasons instead of caller-supplied text.
- M8 addendum selection updates only bump version; addendum narrative output is not persisted as a complete clinical document.
- M17 visit-proposal and recurrence domain logic are real pure code, but no production worker was found to generate proposals or child visits.
- M17 UI screens are mostly read-model shells; comments explicitly defer publishing/dismissing/rescheduling actions.
- M8 UI screens are read/sign/cosign shells; they do not expose encounter creation, authoring, finalize, vitals entry, care-plan links, assessments, void, or addenda.

## D. What is missing

- Web UI Visit creation.
- Web UI Visit edit/reassign/reschedule/cancel/no-show/start.
- Web UI Encounter creation.
- Web UI Encounter documentation and finalize.
- Web UI care-plan item selection inside an encounter.
- Web UI assessment launch/link from an encounter.
- M8 Start Encounter / End Encounter commands.
- Encounter actual start/end timestamp capture through M8.
- Robust scheduled Visit -> Encounter -> Visit completed loop.
- Cancellation/no-show/reschedule cleanup for already-seeded encounter drafts.
- Admission hold/discharge cleanup for future visits.
- Automatic recurrence materialization.
- Automatic missed-visit detection.
- Signed encounter rendering payload containing real final narrative/addenda text.
- A single end-to-end browser/API test proving create visit, seed/create encounter, document, finalize, sign, retrieve.

## E. Current Visit lifecycle

M17 visit states are:

`proposed -> published -> en_route -> in_visit -> completed`

Terminal/exit states are:

`cancelled`, `rescheduled`, `no_show`

Actual transitions:

- `proposed` + publish -> `published`
  - Permission/route: `POST /api/v1/visits` with `visit.create`, or proposal publish with `visit.proposal.publish`.
  - Guard: pre-schedule gate must pass; ABAC checks credentials, discipline, PTO, and caseload/unassigned pool.
  - Effects: history, version, outbox `m17.visit.assigned`, `m17.visit.published`, alert concept `visit_assigned`.
- `proposed` + dismiss -> `cancelled`
  - Permission/route: proposal dismiss.
  - Effects: proposal dismissal; not a normal scheduled visit cancellation.
- `published` + start -> `en_route`
  - Permission/route: `POST /api/v1/visits/:visitId/start` with `visit.start`.
  - Guard: alternate self-attested EVV requires fresh `x-step-up` and EVV missing reason.
  - Effects: `actual_started_at`, EVV bracket state, outbox `m17.visit.started`.
- `en_route` + arrive -> `in_visit`
  - Pure machine supports this.
  - No M17 backend route for arrive was found.
- `in_visit` + complete -> `completed`
  - Pure machine requires system actor and emits `m17.visit.completed`.
  - Intended source appears to be `m8.encounter.signed`, but no live M17 dispatcher consumer was found.
- `published|en_route|in_visit` + cancel -> `cancelled`
  - Permission/route: `POST /api/v1/visits/:visitId/cancel` with `visit.cancel`.
  - Guard: reason minimum 20 chars, reason code, cancelled-by actor.
  - Effects: cancel columns, history, outbox `m17.visit.unassigned`, `m17.visit.cancelled`.
- `published` + reschedule -> `rescheduled`
  - Permission/route: `POST /api/v1/visits/:visitId/reschedule` with `visit.reschedule`.
  - Guard: reason minimum 20 chars; new schedule and optional new assignee must pass scheduling gate.
  - Effects: original row becomes `rescheduled`, new visit row is created/published, original links `rescheduled_into_visit_id`, outbox `m17.visit.unassigned`, `m17.visit.rescheduled`.
- `published` + no-show -> `no_show`
  - Permission/route: `POST /api/v1/visits/:visitId/no-show` with `visit.mark_no_show`.
  - Guard: reason required by API schema.
  - Effects: no-show columns, history, outbox `m17.visit.unassigned`, `m17.visit.no_show_detected`.
- `published` + reassign -> `published`
  - Permission/route: `POST /api/v1/visits/:visitId/reassign` with `visit.reassign`.
  - Guard: new member must pass assignment gate.
  - Effects: assigned membership changed, history/outbox assignment events.

Plain `PATCH /api/v1/visits/:visitId` can change schedule/assignee/purpose/setting and rerun gates, but it does not preserve original schedule as a reschedule lineage event.

## F. Current Encounter lifecycle

M8 encounter states are:

`draft -> finalized -> signed`

Cosign branch:

`draft -> finalized -> cosign_pending -> cosigned`

Void branch:

`draft -> voided`

Actual transitions:

- Create draft
  - Route: `POST /api/v1/encounters`
  - Permission/ABAC: `encounter.author` and `encounter.scope`.
  - Effects: insert `encounter`, outbox `m8.encounter.created`.
- Finalize
  - Route: `POST /api/v1/encounters/:encounterId/finalize`
  - Permission/ABAC: `encounter.author`, `encounter.scope`.
  - Effects: status `finalized`, vocab version pinned, outbox `m8.encounter.finalized`.
  - Implementation gap: final assembled documentation is not persisted as a real note payload.
- Sign
  - Route: `POST /api/v1/encounters/:encounterId/sign`
  - Permission/ABAC: `encounter.sign`, `encounter.scope`, step-up.
  - Guards: encounter must be finalized; provider/location siting must exist; F2F requires dual-write marker; service uses permissive compliance/cosigner checks for non-F2F.
  - Effects: status `signed` or `cosign_pending`, `signed_at`, `encounter_signature`, outbox `m8.encounter.signed`; LPN/CHHA routes cosign request.
- Cosign
  - Route: `POST /api/v1/cosignature-requests/:id/sign`
  - Permission/ABAC: `encounter.cosign`, `m8.cosigner_role_match`, step-up.
  - Effects: encounter `cosigned`, cosignature row, outbox `m8.encounter.cosigned`.
- Void
  - Route: `POST /api/v1/encounters/:encounterId/void`
  - Permission/ABAC: admin/author scope.
  - Guard: only draft can be voided.
  - Effects: status `voided`, void columns, outbox `m8.encounter.voided`.
- Addendum
  - Routes exist for create/update/finalize/sign.
  - Guard gap: parent only has to be non-void; this is broader than "signed encounter addendum."

There is no M8 `in_progress`, `started`, `ended`, `amended`, or `corrected` encounter state.

## G. Visit ↔ Encounter relationship

- Scheduled visit reference on M8: `encounter.visit_id`, nullable.
- Encounter reference on M17: `visit.encounter_id`, nullable.
- M8 has a partial unique index on `(organization_id, visit_id)` where `visit_id IS NOT NULL`; therefore a single scheduled visit can have at most one linked encounter.
- A Visit can exist without an Encounter.
- An Encounter can exist without a scheduled Visit.
- A scheduled visit normally creates a draft encounter when `m17.visit.published` is processed by M8.
- A completed visit does not automatically create an encounter; creation happens at publish time.
- Starting a visit updates only M17 visit state/timestamps. It does not update M8 encounter state.
- There is no Start Encounter command.
- Signing an encounter emits `m8.encounter.signed`, but the inspected production dispatcher does not register the M17 completion consumer.
- Cancelling, rescheduling, or marking a visit no-show does not appear to void/cancel/delete the already-seeded draft encounter.

## H. Current data model

Text diagram:

```text
organization
  └─ patient
      └─ admission
          ├─ M17 visit
          │   pk: id + service_date
          │   organization_id, provider_entity_id, location_id
          │   patient_id, admission_id
          │   assigned_membership_id
          │   assigned_discipline_at_assignment
          │   visit_purpose, visit_setting
          │   scheduled_started_at, scheduled_ended_at
          │   actual_started_at, actual_ended_at
          │   service_date
          │   status
          │   evv_bracket_state/check-in/check-out/missing reason
          │   parent_recurring_visit_id, parent_proposal_id
          │   encounter_id nullable
          │   cancelled/no_show/reschedule metadata
          │   version, created_at, updated_at
          │
          ├─ M17 visit_state_history
          │   visit_id, from_state, to_state, action
          │   actor_membership_id, reason, metadata
          │   created_at
          │
          ├─ M17 recurring_visit
          │   patient_id, admission_id, assigned_membership_id
          │   visit_purpose, visit_setting, rrule/byday/time/date fields
          │   status, version, created_at, updated_at
          │
          ├─ M17 visit_proposal
          │   patient_id, admission_id, source care-plan intervention/frequency fields
          │   suggested date/discipline/purpose/member
          │   state, published_visit_id, dismissed metadata
          │
          └─ M8 encounter
              pk: id
              organization_id, provider_entity_id nullable, location_id nullable
              patient_id, admission_id
              visit_id nullable, unique per org when non-null
              encounter_type, discipline
              authored_by_membership_id
              service_date
              started_at, ended_at columns exist but are not route-driven
              status
              late_entry_tier/reason/override fields
              vocab_version_id
              face_to_face_encounter_id, bereavement_plan_id
              document_id
              signed_at, cosigned_at
              voided metadata
              version, created_at, updated_at
                ├─ encounter_signature
                │   encounter_id, signature_type, signed_by_membership_id
                │   signed_at, step-up/session provenance, legal attestation
                ├─ vitals
                │   encounter_id plus clinical vital fields
                ├─ mileage
                │   encounter_id, miles/source
                ├─ encounter_care_plan_link
                │   encounter_id and optional problem/goal/intervention ids
                │   table exists; production add route does not insert rows
                ├─ cosignature_request
                │   encounter_id, routed_to_membership_id, state/SLA fields
                └─ encounter_addendum
                    encounter_id, reason/status/version/signature fields
```

Important absent links:

- No `care_plan_id` on `visit` or `encounter`.
- No `order_id` on `visit` or `encounter`.
- No `assessment_id` list on `encounter`; M9/M10 store optional back-references instead.

## I. Create/manage Visit

Backend:

- `POST /api/v1/visits` creates a visit and immediately publishes it if gates pass.
- Required request fields: `patientId`, `admissionId`, `patientAddressId`, `externalFacilityId`, `assignedMembershipId`, `visitPurpose`, `visitSetting`, `scheduledStartedAt`, `scheduledEndedAt`.
- Optional request fields: `schedulerInternalNotes`, `caregiverReminderOptIn`, `parentRecurringVisitId`.
- Persisted scheduling fields include patient/admission, assignee, purpose, setting, scheduled start/end, service date, address/facility, notes, reminder opt-in, parent recurring/proposal references.
- Discipline is not supplied by the caller; it is derived from visit purpose and stored as `assigned_discipline_at_assignment`.
- Provider entity and location are derived from the assigned membership defaults.
- No create field exists for priority, reason, care-plan reference, order reference, recurrence/frequency, or free-form visit type outside `visitPurpose`.
- API management exists for edit, start, cancel, reschedule, no-show, reassign, list, detail, proposals, recurring policy creation/discontinuation, availability, time off, and metrics.

Frontend:

- No visit create UI was found.
- No edit/reassign/reschedule/cancel/no-show/start UI was found.
- Visit screens are read-oriented.

Answer: a user cannot create a visit from the web UI today.

## J. Create/manage Encounter

Backend:

- `POST /api/v1/encounters` creates a draft.
- Required fields: `patientId`, `admissionId`, `encounterType`, `discipline`, `serviceDate`.
- Optional fields: `visitId`, `faceToFaceEncounterId`, `bereavementPlanId`.
- No create fields exist for narrative note, start/end time, care-plan ids, order ids, assessment ids, assigned clinician, location, or provider entity.
- Manual unscheduled/API-created encounters omit provider/location siting in the production service; sign later requires siting, so these drafts are not a complete PRN encounter path.
- Scheduled encounters are created by the M8 `m17.visit.published` consumer and include provider/location from the visit payload.

Frontend:

- No encounter create UI was found.
- No encounter documentation/finalize UI was found.
- Encounter read screen can sign only when status is already `finalized`.
- Draft and cosignature worklists can open existing records.

Answer: a user cannot create an encounter from the web UI today.

## K. Clinical documentation & signatures

Implemented documentation pieces:

- Vitals capture API.
- Mileage capture API.
- Encounter finalization/signature state transitions.
- Primary signature persistence in `encounter_signature`.
- Cosignature request/signature flow.
- Addendum API and addendum signature events.
- Void draft encounter.

Partial or missing documentation pieces:

- Clinical narrative/SOAP/free-text encounter documentation is not persisted end-to-end by the production M8 route service.
- `PATCH /selections` currently only bumps version and returns an empty preview.
- Care-plan links are not inserted by the route service.
- Orders addressed are not linked by M8.
- Assessment links are not listed/managed by M8; M9/M10 may reference M8.
- Attachments are not part of the inspected M8 encounter authoring workflow.
- Medications are not documented inside M8 encounter authoring in the inspected routes.
- Late-entry/admin override routes exist, but caller-supplied reasons are not persisted as-is.

Signature/finalization:

- `finalized` and `signed` are distinct states.
- `signed` and `cosigned` records are protected by edit guards for the normal M8 write routes.
- Step-up/session freshness applies to signing and cosigning.
- Signature identity persists membership/session provenance.
- Addenda are the correction mechanism, but UI support is missing and parent-state validation is too broad.

## L. Care Plan integration

M7 relationship:

- M8 has a `CarePlanReader` seam used to read relevant care-plan elements for an encounter context.
- M8 schema includes `encounter_care_plan_link` with optional problem/goal/intervention references.
- M8 event payload for `m8.encounter.signed` includes a `careplanLinks` array.
- Production `addCarePlanLink` does not insert the posted problem/goal/intervention link rows; it returns an ID-like value after loading the encounter.
- The M8 UI does not let clinicians select Problems, Goals, or Interventions.
- Signed encounter evidence does not appear to update M7 content through a live mutation flow.

Classification:

- Care Plan -> Visit: proposal-domain scaffold/pure code; no confirmed live automatic scheduling.
- Care Plan -> Encounter: read/reference concepts only; production clinical linking is not usable.
- Encounter -> Care Plan update: missing. No automatic mutation, no proposal/suggestion workflow, no manual M7 update from encounter signature found.

Explicitly: an encounter cannot currently document in production UI/API behavior that "this visit addressed Problem X, worked toward Goal Y, performed Intervention Z" in a durable way, despite schema concepts existing.

## M. Assessment/HOPE integration

M9 Assessments:

- M9 clinical assessment records have optional `source_encounter_id`.
- M9 record-assessment API accepts `sourceEncounterId` and stores it.
- No M8 UI action launches M9 from an encounter.
- M8 read DTO does not present linked M9 assessments.

M10 HOPE:

- HOPE assessment records have optional `source_encounter_id`.
- M10 timepoint recording accepts optional `sourceEncounterId`.
- HOPE timepoint schedules are independent M10 workflow records, not M17 scheduled visits.
- HUV1/HUV2 and admission/discharge RFAs can be linked to an encounter only if the M10 caller passes `sourceEncounterId`.
- SFV recording does not accept `sourceEncounterId` in the inspected route/schema and is independent of M8/M17.

Real relationship:

- `Encounter -> assessment` launch is missing from M8.
- `Assessment/HOPE -> encounter` optional back-reference exists for M9 and most M10 timepoint assessments.
- HUV1/HUV2/SFV are not performed "inside" a Visit/Encounter in the web UI today.

## N. Orders integration

M11:

- Order records can store optional `source_encounter_id`.
- Order creation accepts optional `sourceEncounterId`.
- M11 also stores optional triggering assessment/HOPE/IDG references.
- No live flow was found where an order requires, schedules, or materializes an M17 visit.
- No M8 route/UI was found where clinicians select orders addressed during an encounter.
- No completion-by-encounter mutation was found.

Classification:

- Order linked to encounter: API data model support in M11.
- Order schedules visit: missing.
- Encounter completes order: missing.

## O. Scheduling/recurrence

Recurring/frequency support:

- `recurring_visit` is modeled.
- RRULE/byday/time zone/start/end/count fields are modeled.
- Pure recurrence materialization code and tests exist.
- M17 API can create/discontinue a recurring policy.
- The production route service stores the recurring policy but does not materialize visit instances.
- Discontinuation emits `m17.recurring_visit.discontinued` with `cancelledChildCount: 0`; it does not cancel future child visits.
- No registered job was found to generate future visits from recurring policies.

Frequency from Care Plan:

- Pure proposal logic parses normalized frequencies such as `2:visit:week`.
- Human text like `RN 2x/week` is not the persisted API format for M17 recurrence.
- Care-plan frequency can become proposal-domain objects in pure code, but no live M7 -> M17 proposal generation job/consumer was found.

Changes to future/historical visits:

- No production recurring materialization means future-instance update semantics are not implemented.
- Manual reschedule creates a new visit and preserves the original row.
- Manual patch can change a visit in place.

## P. Missed / cancelled / rescheduled workflows

Missed/no-show:

- Backend route exists: `POST /api/v1/visits/:visitId/no-show`.
- Reason is required.
- Status becomes `no_show`.
- `no_show_detected_at` and reason are stored.
- Events include `m17.visit.unassigned` and `m17.visit.no_show_detected`.
- No automatic no-show job was found.
- No UI action was found.
- No care-plan impact was found.
- Alert/event concept exists; live alert delivery was not confirmed.

Cancelled:

- Backend route exists: `POST /api/v1/visits/:visitId/cancel`.
- Reason and reason code are required.
- Status becomes `cancelled`.
- Cancellation metadata is stored.
- Events include `m17.visit.unassigned` and `m17.visit.cancelled`.
- No UI action was found.
- Cancellation does not appear to void or close a previously seeded encounter draft.

Rescheduled:

- Backend route exists: `POST /api/v1/visits/:visitId/reschedule`.
- Reason is required.
- Original visit becomes `rescheduled`.
- New visit row is created and published.
- Original row links to the new visit through `rescheduled_into_visit_id`.
- History is preserved for this command.
- No UI action was found.
- Existing draft encounter linked to the original visit is not cleaned up by a confirmed consumer.

## Q. Admission lifecycle integration

Admission status guards:

- M17 create/publish does not appear to check admission lifecycle status directly. It relies on scheduling/assignment gates.
- M8 scheduled-visit consumer checks that the admission is active before seeding a draft encounter.
- M8 manual create does not enforce active admission or service date after activation, although validation helpers exist.
- M8 sign does not re-check admission status in the inspected service path.

On hold:

- No live M6 `admission.on_hold` -> M17/M8 consumer was found.
- Existing/future visits appear unchanged.

Discharge:

- No live M6 discharge -> M17 future-visit cancellation consumer was found.
- Existing/future visits appear unchanged.
- A previously seeded/sited encounter could likely still be finalized/signed after discharge because sign does not re-check discharge status.
- A manual post-discharge encounter draft can be created through API if ABAC scope permits, but may not be signable because manual drafts lack provider/location siting.

## R. Frontend

M17 Scheduling screens:

- `apps/web/src/modules/17-scheduling/screens.ts`
  - `/scheduling/day`
  - `/scheduling/week`
  - `/scheduling/proposals`
  - `/scheduling/recurring`
  - `/scheduling/time-off`
  - `/scheduling/visits/:visitId`
  - `/me/visits`
  - `/admin/scheduling-metrics`
- `apps/web/src/modules/17-scheduling/my-visits.tsx`
  - Calls `GET /api/v1/visits`.
  - Shows upcoming/own visits.
  - No create/start/cancel/reschedule/open-encounter action.
- `apps/web/src/modules/17-scheduling/visit-detail.tsx`
  - Calls `GET /api/v1/visits/:visitId`.
  - Displays status, service date, scheduled time, purpose, setting, clinician/patient labels, reschedule link.
  - No manage actions.
- `apps/web/src/modules/17-scheduling/day-view.tsx` and `week-view.tsx`
  - Read-oriented calendar views.
  - No drag/drop or create action.
- `apps/web/src/modules/17-scheduling/proposals.tsx`
  - Read-only proposal list; no publish/dismiss action.
- `apps/web/src/modules/17-scheduling/recurring.tsx`
  - Read-oriented recurring policy view.

M8 Encounter screens:

- `apps/web/src/modules/08-encounters/screens.ts`
  - `/patients/:patientId/encounters`
  - `/patients/:patientId/encounters/:encounterId`
  - `/work/cosignatures`
  - `/work/drafts`
- `apps/web/src/modules/08-encounters/patient-encounters.tsx`
  - Calls `GET /api/v1/encounters?patientId=...`.
  - Backend list service ignores filters, so this screen can receive all org-visible encounters rather than only the selected patient.
  - No create action.
- `apps/web/src/modules/08-encounters/encounter-read.tsx`
  - Calls encounter read/cosignature APIs.
  - Displays status/signature/cosign fields and placeholder clinical sections.
  - Can sign if status is already `finalized`.
  - Can acknowledge/sign/release cosignature requests.
  - No create, start, edit documentation, vitals, care-plan link, assessment launch, finalize, void, addendum, amend/correct UI.
- `apps/web/src/modules/08-encounters/my-drafts.tsx`
  - Calls `GET /api/v1/encounters/my-drafts`.
  - Opens read screen only.
- `apps/web/src/modules/08-encounters/cosignature-queue.tsx`
  - Queue/read/cosign workflow only.

## S. Events & live consumers

Confirmed or declared producers:

```text
M17 -> m17.visit.proposed -> declared M33
M17 -> m17.visit.assigned -> declared M36/M33
M17 -> m17.visit.published -> live M8 consumer seeds encounter; live M18 consumer observed in bootstrap; declared consumers include downstream modules
M17 -> m17.visit.started -> declared M18/M33/M36
M17 -> m17.visit.completed -> declared M23/M24/M30/M33
M17 -> m17.visit.cancelled -> declared M36/M33
M17 -> m17.visit.rescheduled -> declared M36/M33
M17 -> m17.visit.no_show_detected -> declared M19/M30/M33/M36
M17 -> m17.recurring_visit.discontinued -> declared M33/M36

M8 -> m8.encounter.created -> declared M33
M8 -> m8.encounter.finalized -> declared M30/M33
M8 -> m8.encounter.signed -> declared M9/M10/M14/M17/M22/M28/M30/M31/M33/M36
M8 -> m8.encounter.cosigned -> declared M23/M24/M33
M8 -> m8.encounter.addendum_signed -> declared M22/M28/M33
M8 -> m8.encounter.cosignature_routed -> declared M36/M33
M8 -> m8.encounter.cosignature_overdue -> declared M36/M33
M8 -> m8.encounter.cosignature_escalated -> declared M36/M33
M8 -> m8.encounter.cosignature_hard_cap_reached -> declared M36/M33
M8 -> m8.encounter.late_entry_override -> declared M30/M33
M8 -> m8.encounter.administrative_override -> declared M30/M33
M8 -> m8.encounter.voided -> declared M22/M33
M8 -> m8.encounter.orphan_recorded -> declared M17
M8 -> m8.hearthnote.layer2_enhanced -> declared M30/M32/M33
M8 -> m8.vitals.captured -> declared M9/M36
M8 -> m8.mileage.captured -> declared M27/M33
```

Live binding notes:

- Confirmed in inspected bootstrap: M8 consumes `m17.visit.published`.
- Confirmed in inspected bootstrap: M18 consumes `m17.visit.published`.
- Not confirmed in inspected bootstrap: M17 consuming `m8.encounter.signed` to complete/update visits.
- Not confirmed in inspected bootstrap: M8 consuming M17 cancel/no-show/reschedule events to close seeded drafts.
- M14 has a signed-encounters reader seam for IDG packet/review evidence; a live outbox consumer registration for `m8.encounter.signed` was not confirmed in the inspected dispatcher list.

## T. Jobs/watchdogs

Found as domain concepts or event catalogs:

- Recurrence materialization pure code.
- Frequency/proposal pure code.
- Stale visit detection event concept.
- Caregiver reminder event concept.
- Late check-out suspected event concept.
- Cosignature SLA overdue/escalation event concepts.

Not found as registered production jobs in the inspected wiring:

- Recurring visit materialization.
- Care-plan frequency proposal generation.
- Automatic missed/no-show detection.
- Future visit cancellation on discharge.
- Visit pause/cancel on admission hold.
- Unsigned encounter reminder.
- Late documentation watchdog.
- Cosignature SLA tick worker.

## U. Alerts/attention

Existing alert-worthy events/concepts:

- Visit assigned/rescheduled/cancelled/no-show.
- Reassignment needed.
- Stale visit detected.
- Caregiver reminder due.
- Cosignature routed/overdue/escalated/hard cap.
- Late-entry/administrative override.
- Vitals abnormal flags through `m8.vitals.captured`.

Gaps:

- No confirmed UI attention center for upcoming visit, unassigned visit, visit starting soon, missed visit, late encounter documentation, or unsigned encounter.
- M36 declared consumers exist in catalogs, but production alert delivery for these specific workflows was not confirmed.

## V. Tests

Focused M17 tests found:

- `packages/scheduling/__tests__/visit-machine.test.ts`
  - Unit/domain. Proves visit state machine transitions, reason guards, system-only completion.
- `packages/scheduling/__tests__/recurrence.test.ts`
  - Unit/domain. Proves RRULE materialization logic and discontinuation event effects.
- `packages/scheduling/__tests__/proposals.test.ts`
  - Unit/domain. Proves frequency parsing/proposal generation and proposal publish/dismiss pure transitions.
- `apps/backend/__tests__/m17-scheduling-write.live.test.ts`
  - Live DB/service. Proves create/publish, start, cancel, reschedule, no-show, reassign, recurring, time off, route optimization degraded, and RLS mutation isolation.
- `apps/backend/__tests__/m17-scheduling-read-service.live.test.ts`
  - Live DB/service read coverage.
- `apps/backend/__tests__/gap-030-visit-create-abac.live.test.ts`
  - Live route/ABAC. Proves visit create discipline/caseload predicate behavior.
- `packages/db/migrations/__tests__/m17-rls-isolation.live.test.ts`
  - Live RLS isolation.

Focused M8 tests found:

- `apps/backend/__tests__/m8-encounters-write.live.test.ts`
  - Live DB/service write coverage for encounter workflow pieces.
- `apps/backend/__tests__/m8-encounters-read-service.live.test.ts`
  - Live DB/service read coverage.
- `packages/db/migrations/__tests__/m8-rls-isolation.live.test.ts`
  - Live RLS isolation.
- `apps/backend/__tests__/encounter-seam.test.ts`
  - Unit/seam coverage for billability, render payloads, and draft encounter creation seam.
- `apps/backend/__tests__/encounter-drizzle-store.test.ts`
  - Store/seam read coverage for signed encounters.
- `apps/backend/__tests__/encounter-outbox.test.ts`
  - Outbox event coverage.
- `apps/backend/__tests__/encounter-eraser.test.ts`
  - Eraser/audit catalog coverage.
- `apps/web/src/modules/08-encounters/__tests__/write-workflow.test.ts`
  - Frontend workflow test around existing encounter read/sign/cosign behavior.

What tests prove:

- M17 API/service can create, assign, start, cancel, reschedule, no-show, and reassign.
- M17 pure state machine can complete from `in_visit` by system actor.
- M8 can create/finalize/sign/cosign at service/API level for seeded/sited data.
- RLS isolation exists for both modules.

What tests do not prove:

- Full web Visit -> Encounter -> Documentation -> Finalize -> Sign.
- UI visit creation.
- UI encounter creation/documentation/finalization.
- Care-plan link persistence from encounter.
- Assessment launch/link from encounter UI.
- M8 signed event completing M17 visit in production.
- Admission hold/discharge cleanup.
- Recurring policy generating future visits through registered jobs.

## W. Main business/architecture inconsistencies

1. Critical: The normal web UI cannot perform the intended end-to-end clinical visit workflow. It breaks at visit creation and encounter documentation/finalization.
2. Critical: M8 signed -> M17 visit completion is declared but not confirmed live-bound. Visits can remain published/en_route even after encounter signing.
3. Critical: M8 clinical documentation routes are skeletal. Core selections/narrative/care-plan links are not durably persisted from request bodies.
4. High: Scheduled visit cancellation/no-show/reschedule does not clean up the draft encounter seeded from the original published visit.
5. High: Admission hold/discharge do not pause/cancel future visits and are not consistently enforced for encounter creation/signature.
6. High: Recurring visits are modeled but not generated by production jobs.
7. High: M8 manual unscheduled encounters can be drafted but are not a complete signable PRN path because siting is absent.
8. High: Patient encounter web list sends a patient filter, but the backend list service ignores filters.
9. Medium: M17 PATCH can alter scheduled time without the reschedule history semantics that the dedicated reschedule command preserves.
10. Medium: LPN/CHHA cosign routing creates a request routed to the signer in the inspected service path, not a resolved qualified RN.
11. Medium: M8 addenda can be created on any non-void encounter, not only signed/final records.
12. Medium: M17 write service uses org RLS context with blank user id, so database write-audit actor context may be weaker than business history/signature columns.

## X. Recommended target workflow

Do not implement in this audit. Target ownership should stay split:

```text
M17 owns planned Visit:
  create/schedule -> assign/reassign -> reschedule/cancel/no-show -> start/check-in -> visit completion marker

M8 owns actual Encounter:
  create/open from Visit or PRN -> document -> care-plan/assessment/order context -> finalize -> sign/cosign -> addenda/corrections
```

Recommended user journey:

```text
Admission active
  -> Scheduler creates M17 Visit with patient/admission/purpose/time/assignee/location
  -> M17 publishes Visit and seeds one M8 draft Encounter
  -> Clinician worklist shows today's assigned Visits with linked draft Encounter
  -> Clinician starts Visit/Encounter and records actual time/EVV
  -> Clinician documents narrative, vitals, care-plan links, orders addressed, assessments as needed
  -> Clinician finalizes Encounter
  -> Clinician signs; cosign routes if required
  -> M8 signed event completes/links M17 Visit
  -> Signed historical Encounter is retrievable from patient chart and visit history
```

Do not let M8 duplicate scheduling ownership. Do not let M17 own clinical documentation.

## Y. Recommended implementation phases

Phase 1: Make the existing API workflow coherent.

- Wire `m8.encounter.signed` -> M17 visit completion/update in production.
- Decide how visits reach `in_visit` when started from UI/API, or relax completion semantics deliberately.
- Make cancel/no-show/reschedule close or supersede seeded draft encounters.
- Fix M8 patient list filtering.
- Persist M8 documentation body, care-plan links, EVV/late reasons, and addendum content correctly.

Phase 2: Build the web workflow.

- Add M17 create/manage visit UI actions.
- Add clinician worklist actions: start/open encounter/cancel/no-show where permitted.
- Add M8 encounter authoring UI: note, vitals, care-plan links, assessment launch/link, finalize, sign, addenda.
- Add historical retrieval views with coherent Visit/Encounter DTOs.

Phase 3: Add automation and lifecycle integration.

- Materialize recurring visits.
- Generate visit proposals from care-plan frequency through an explicit user approval workflow.
- Add missed/late/unsigned/cosign watchdog jobs and M36 attention delivery.
- Add admission hold/discharge future-visit handling.
- Add end-to-end tests for the full user journey.

## Z. Files likely to require modification

Likely backend M17 files:

- `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`
- `apps/backend/src/modules/17-scheduling/routes/scheduling-typebox.ts`
- `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`
- `apps/backend/src/modules/17-scheduling/service.ts`
- `apps/backend/src/modules/17-scheduling/events-by-m17.ts`
- `apps/backend/src/modules/17-scheduling/consumers/index.ts`
- `apps/backend/src/index.ts`
- `packages/scheduling/src/lifecycle/visit-machine.ts`
- `packages/scheduling/src/lifecycle/recurrence.ts`
- `packages/scheduling/src/lifecycle/proposals.ts`
- `packages/db/src/schema/scheduling/visits.ts`

Likely backend M8 files:

- `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`
- `apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts`
- `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`
- `apps/backend/src/modules/08-encounters/service.ts`
- `apps/backend/src/modules/08-encounters/lifecycle/encounter.ts`
- `apps/backend/src/modules/08-encounters/lifecycle/validation.ts`
- `apps/backend/src/modules/08-encounters/outbox-consumers/m17-visit-scheduled.ts`
- `apps/backend/src/modules/08-encounters/events-by-m8.ts`
- `packages/db/src/schema/encounter/encounters.ts`

Likely frontend files:

- `apps/web/src/modules/17-scheduling/screens.ts`
- `apps/web/src/modules/17-scheduling/my-visits.tsx`
- `apps/web/src/modules/17-scheduling/visit-detail.tsx`
- `apps/web/src/modules/17-scheduling/day-view.tsx`
- `apps/web/src/modules/17-scheduling/week-view.tsx`
- `apps/web/src/modules/17-scheduling/proposals.tsx`
- `apps/web/src/modules/17-scheduling/recurring.tsx`
- `apps/web/src/modules/08-encounters/screens.ts`
- `apps/web/src/modules/08-encounters/patient-encounters.tsx`
- `apps/web/src/modules/08-encounters/encounter-read.tsx`
- `apps/web/src/modules/08-encounters/my-drafts.tsx`
- `apps/web/src/modules/08-encounters/cosignature-queue.tsx`

Likely integration files:

- `apps/backend/src/modules/06-admission/*`
- `apps/backend/src/modules/07-care-plan/*`
- `apps/backend/src/modules/09-assessments/*`
- `apps/backend/src/modules/10-hope/*`
- `apps/backend/src/modules/11-orders/*`
- `apps/backend/src/modules/14-idg/*`
- `apps/backend/src/modules/36-messaging/*`
- `packages/db/src/schema/assessment/clinical-assessments.ts`
- `packages/db/src/schema/hope/hope-assessments.ts`
- `packages/db/src/schema/orders/order-records.ts`

Likely tests:

- `packages/scheduling/__tests__/visit-machine.test.ts`
- `packages/scheduling/__tests__/recurrence.test.ts`
- `packages/scheduling/__tests__/proposals.test.ts`
- `apps/backend/__tests__/m17-scheduling-write.live.test.ts`
- `apps/backend/__tests__/m17-scheduling-read-service.live.test.ts`
- `apps/backend/__tests__/gap-030-visit-create-abac.live.test.ts`
- `apps/backend/__tests__/m8-encounters-write.live.test.ts`
- `apps/backend/__tests__/m8-encounters-read-service.live.test.ts`
- `apps/web/src/modules/08-encounters/__tests__/write-workflow.test.ts`
- New browser/E2E coverage for Visit -> Encounter -> Document -> Finalize -> Sign.
