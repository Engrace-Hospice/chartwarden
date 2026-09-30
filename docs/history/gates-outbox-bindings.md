# Fitness gate: outbox bindings ↔ event catalog

> Rationale and incident history for `check-outbox-bindings` (rules 1–6, F-020/F-043/F-094/F-095, and the M19/M20/M14/M15/M16/M23/M27/M36 binding findings). Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

- `scripts/check-outbox-bindings.ts` — **outbox binding ↔ event-catalog agreement**
  (`bun run arch:outbox-bindings`, in `arch:fitness`). Every live `OutboxConsumerBinding` must bind a
  catalogued event, must not bind one catalogued record-only (`declaredConsumers: []`), and its module
  must be named in that event's `declaredConsumers`. The dispatcher asserts exactly this already — by
  THROWING before `server.listen()` — but it is only constructed when `DATABASE_PLATFORM_URL` is set,
  so no test, local run or CI job ever reached the check. Two mismatches accumulated in two modules
  (`m23.claim.submission_failed` omitted M23's own retry consumer; `m25.edi.835_received` was
  catalogued record-only while M25 bound it live), and the only symptom was a backend that refused to
  start in the documented production configuration (F-020, issue #49). Unlike the other static gates
  this one EVALUATES rather than parses: it imports each consumer module and calls its
  `build…Consumer` factory with an absorbing stub, so the six different indirections the bindings use
  to express their event lists resolve to their real values. A binding file that yields no binding is
  an error, never a skip. The runtime half is the `outbox-boot` CI job
  (`bun run check:boot:platform`), which boots the backend with a real provisioned platform login and
  proves the relay starts. **F-043 (#103) adds the direction none of them ran**: all three
  rules above go binding → catalog, so an event declaring `["m33","m36"]` with no consumer anywhere
  satisfied every one of them — the catalog read as if all 599 of its consumer-declaring entries were
  wired when **570** were not, and at (module, event) granularity **1165 of 1203** pairs were unbound.
  Same unasked-direction shape as F-025/#59 (the live-suite gate checked `package.json` → CI and never
  the reverse, hiding 29 suite files). Rule 4 now requires every module named in `declaredConsumers` to
  have a live binding **or** to be named in `scripts/outbox-deferred-consumers.ts` with a reason — the
  `deviceAttestationValid` rule again, at (module, event) granularity so the count cannot drift: a new
  unbound pair fails, a listed pair that gains a binding fails ("outlived its reason"), an entry whose
  event or declaration disappears fails, and an empty reason fails. `--update`
  (`bun run outbox:deferrals:update`) regenerates the event lists but never the reasons, and writes a
  brand-new consumer module as `kind: "unclassified"` with an EMPTY reason — so updating cannot
  manufacture a passing state. `unclassified` groups print on every run as the standing finding (today:
  **0**). The absence is **not silent at runtime**: `resolveRouting` marks such an event `deferred` and
  the relay finalizes each row `pending` with `attemptCount - 1`, so it never reaches `maxAttempts`,
  never dead-letters, and is never purged (retention touches only `dispatched` rows) — every emission
  becomes a row re-claimed every 30 minutes for the life of the deployment, which
  `outbox-dispatcher.live.test.ts` already proves. The two largest groups are one decision each, not
  hundreds of forgotten consumers: **m36** (272) routes alerts through the `AlertEmitter` **seam**, and
  **m33** (319) pulls metrics from `report_mv.*` materialized views.
  **M20 is the first module bound out of the registry entirely** (542 → 538 pairs, 33 → 32 modules), and it
  is the shape the `handlers-unbound` list was named for. Six deciders — the §7.1 cadence materializer, the
  reassignment re-point, the completion retirement, the §4.8 no-show inquiry and both EVV bracket
  re-anchors — were complete, exported and unit-tested since M20-T04 with **no factory yielding a
  binding**, so their only caller was their own test file. One layer down that meant **no INSERT into
  `safety_check_in_schedule` existed anywhere in the repository**: the only write was the fulfilment UPDATE,
  which can close a row but not make one, so the §4.2 supervisor board, the §4.3 badge trio, the §4.8
  overdue detector and the clinician's own `/me/today` had always read an EMPTY SET. A safety board that
  answers "nobody is overdue" because nobody was ever OBLIGED is indistinguishable from one where everyone
  is fine. **Both halves had to land together**, because the catalog declared `m20` on neither
  `m17.visit.published` / `.completed` / `.no_show_detected` nor `m18.evv.check_in_recorded` /
  `.check_out_recorded` — a binding without the declaration is routed nothing — and two declarations it DID
  carry (`m18.evv.geofence_breach_recorded`, `m19.oncall_shift.activated`) name a consumer M20's own
  `consumers/index.ts` explains it will never write, so they deferred every emission forever. Three things
  only running it found. `seam-context`'s `readVisitAnchors` — written FOR these consumers — returns `null`
  on both "no such visit" and "the seam threw", correct for the §4.2 board and wrong for a consumer, and
  M17's seam store opens `withOrgContextFromRequest`, which throws outside a request scope: a binding that
  used the helper would have caught that on every single delivery and no-op'd forever, green. Each handler
  opens `runWithRequestContext` and reads the seam directly. And `wardenx_app` **had no DELETE grant on the
  table** while `consumers/schedule-plan.ts` defines retirement AS a delete and argues no member of
  `safety_check_in_state` can truthfully say "invalidated" — migration 0111's header says the app role gets
  DELETE on nothing in M20 and both statements were written before anything executed one. Migration 0238
  grants it on that one table: a `proposed` row is a plan the system MADE, not evidence of anything that
  happened, and 0111's own M4 trigger fires on DELETE so the retirement stays on the record.

  **A second M20 mechanism sits entirely outside the outbox and is invisible to every gate above it
  (F-111, #249).** `lifecycle/sos-escalator.ts` (§4.8 `m20.sos-sla-watchdog.cron`, D7, M20-F05/S13/
  INT-031) is a complete, pure, unit-tested per-alert decider for the SOS escalation ladder — the
  5-second stale-cancel-window sweep, tier-1/2/3 SLA-dwell escalation via `escalateSos`, and the
  `emergency_terminus` re-page loop via `repageTerminus`. **Nothing calls it.** No file under
  `20-field-safety/` matches `*cron*`/`*worker*`/`*job*`; no queue name or BullMQ registration
  mentions `sos-sla-watchdog` anywhere outside the decider's own header comment; the composition root
  wires M20's outbox consumers (F-043/#103) but registers no cron worker for this module at all. A
  field clinician's SOS alert that nobody acknowledges within its tier-1 SLA sits in `acknowledging`
  forever — not an error path, the absence of a background process, so nothing logs it. The ladder
  fires today only on a supervisor's manual escalate or when an M36 delivery failure happens to
  trigger it (`consumers/m36-delivery-failed.ts`, capped short of the terminus, #205's M36
  follow-up). **Why neither outbox gate caught it**: `check-outbox-bindings.ts` and
  `check-live-suite-coverage.ts` both reason about the outbox — catalog↔binding agreement, live
  suites wired to CI — and this is a scheduled decider with no producer event to wait on, invisible
  to both gate classes this repo has built. **Reported, not fixed**: a from-scratch build (a BullMQ
  worker under the reserved `m20.sos-sla-watchdog.cron` name, per-org/per-alert scanning via the
  active-org enumerator pattern M30's wiring batch established, locking against double-escalation,
  composition-root wiring) — comparable in scope to the M36 out-of-band dispatch pipeline and M27
  async cost-report processing, both reported and deferred elsewhere in this document rather than
  built inline.

  **M19 followed M20 out of the registry's launch-critical tier (F-043, #103).** Its two D10 inbound
  triggers — `consumers/m17-no-show.ts` and `m18-late-checkout.ts` over the shared `inbound-trigger.ts`
  core — were complete deciders whose only caller was their own test, so the relay deferred both. What that
  cost: `triage_call.source` has six enum values and the module's two live insert paths hardcode `manual`
  and `paper_origin`, so `no_show`, `late_checkout`, `m36_delivery_failure` and `geofence_anomaly` were
  unreachable and `source_outbox_event_id` — the column D10's redelivery guard
  `triage_call_source_dedupe_uq` is built on — had **never been written by anything**. No proactive triage
  call had ever been opened: a clinician who never arrived at a dying patient's home, and one who never
  checked out of it, each raised an event delivered to nobody. Binding them also gives
  `m19.oncall_shift.coverage_gap` its first producer, which `events-by-m19.ts`'s own header records as
  "declared … but never actually published anywhere in this codebase yet". **The defect the live run found
  is worth keeping**: the ports read M19's OWN tables, so the first draft ran them on the bare pool. That
  does not fail closed to "no rows". Once ANY transaction on a pooled connection has run
  `set_config('app.org_id', …, true)`, the GUC reverts after commit to the SESSION value — which for a
  custom GUC never set at session level is the **empty string, not NULL** — so the RLS predicate's
  `current_setting('app.org_id', true)::uuid` becomes `''::uuid` and the read throws `22P02`. On an idle
  connection it would instead have matched nothing silently, and a `findCallBySourceEvent` that answers
  null for a call that exists is a duplicate welfare call on every redelivery, which is exactly what D10's
  guard exists to prevent. Loud on a busy connection, silent on a fresh one, wrong on both.

  **The m22 group's REASON was wrong about six of its members (F-099, #103).** The registry groups by
  (module, kind) "so the reason lives once — m22 is declared on 85 events for one reason, not 85 reasons",
  and m22's read: M22 renders on REQUEST, a module that wants a document emits a render request, and
  "these declarations name M22 as a consumer of the SOURCE clinical/billing event instead — the same
  handshake spelled a second way, and only the request spelling is wired." True of ~70. **False of six,
  which ARE the request spelling and were being emitted from production write paths with nothing draining
  them**: `m10.hope.summary_requested` (`POST /hope/assessments/:id/summary-pdf`),
  `m16.bereavement.outreach_artifact_requested` (the D14 welcome packet at plan open),
  `m20.safety.incident_report_requested` (whose catalog entry says "M22's renderer consumes it; M20 ships
  no PDF code"), `m25.appeal_packet.render_requested`, `m27.artifact.render_requested` and
  `m37.body_release.document_requested`. Each declares `["m22"]` and nothing else, so no other module was
  covering for the absence, and each emit site's own comment says M22 renders it. Every one of those rows
  has sat `pending` since its producer landed — re-claimed every thirty minutes, never dead-lettered,
  never purged. **This is the grouping's own failure mode**: a reason that fits most of a group reads as a
  decision covering all of it, and the entry is then the LAST place anyone re-derives, because it looks
  like the question was already asked. `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS` compounded it from the
  other side — its header called `m37.body_release.document_requested` "declared but has no emitter and no
  published template" when M37's body-release machine emits it on `identifyFuneralHome` and
  `ipu_body_release.release_document_id` is the column waiting for it, **named in that column's own schema
  comment**. Binding them needed migration 0239 (seven `document_aggregate_type` values; M16's packet
  files against the existing `bereavement_letter`, one aggregate type with several template keys) plus
  eight template descriptors and six `REQUEST_SHAPES` rows — the infrastructure was entirely general, the
  0196/0197 precedent a third time. **The second defect underneath, which only writing the adapters
  surfaced: four of the six payloads carry no patient.** `DocumentRequestPayload.patientId` is what
  `document.patient_id` is written from, M22 `dependsOn [1, 5]` and cannot read M10/M16/M20/M37's tables
  to resolve one, and every emit site already had it in hand (`hope_assessment.patient_id`,
  `bereavement_plan.patient_id`, `ipu_body_release.patient_id` — all NOT NULL — and
  `safety_incident.patient_id`, nullable for a reason). So binding alone would have rendered a HOPE
  summary, a bereavement packet and a decedent's release authorization onto NO chart, which is a
  strictly worse outcome than not rendering them: an unrendered request is a visible `pending` row, an
  off-chart clinical document is a filed one nobody can find. The producers now publish it, declared in
  their catalogs; M20 sends an explicit `null` because a vehicle accident has no patient and filing that
  report on someone's chart is worse than filing it on none, and **M25 is patient-independent by
  construction** — `appeal_case` reaches a chart only through a nullable `claim_id` into M23, so
  asserting one would mean inventing a link M25 does not hold. Proven live end-to-end (real publisher →
  real dispatcher → real renderer → real `document` row under RLS): 7 of `gap-023-024-038-render-handshake
  .live.test.ts`'s 14 fail against the pre-fix consumer, and 11 of the two unit suites' cases do.
  538 → 533 pairs, 36 → 42 catalogued events covered. **What remains in the m22 group now divides again**,
  and the registry says so: for M11/M12/M13/M21/M23/M33 the source-event declaration is redundant because
  the request half IS wired; for M6/M7/M8/M9/M14/M15/M18/M24/M30/M39 the module has **no request event at
  all**. M6 is the one that matters — seven `document_id` columns on `certification`, `election_statement`,
  `f2f_encounter`, `nor_acknowledgment`, `revocation_event`, `discharge_event` and `transfer_event`, each
  commented "M22 document", all NULL forever, with all six templates (`cti`, `election_statement`, `f2f`,
  `nor`, `revocation`, `discharge_summary`) already published in `PLATFORM_TEMPLATE_TABLE` and
  `m6.document_requested` catalogued by nothing. Those are the CoP compliance documents.
  **Reported, not fixed**: `m13.administration_record.document_requested` is catalogued and its pure
  machine pushes the outbox effect on `perAdministrationPdfRequired`, but M13's backend effect interpreter
  has **no `outbox` arm at all**, so the request never becomes a row — producer-side, and it stays on the
  anticipated list rather than being subscribed, because a consumer bound to a name nothing emits is
  indistinguishable from working.

  **M6's six CoP compliance documents were never rendered, and neither half of the handshake existed
  (F-100, #103).** The Medicare Conditions of Participation artifacts a survey asks for — the
  certification of terminal illness, the election statement, the face-to-face encounter, the notice of
  rights, the revocation, the discharge summary. `PLATFORM_TEMPLATE_TABLE` has published a template for
  every one since it landed; SIX `document_id` columns on `certification`, `election_statement`,
  `f2f_encounter`, `nor_acknowledgment`, `revocation_event` and `discharge_event` have carried the comment
  "M22 document (app-validated)" since M6's schema landed. **Both ends were missing at once, which is why
  neither looked broken**: M22 subscribed to none of M6's six source events, so no request was ever
  drained, and M6 subscribed to `m22.document.rendered`, so there was nothing to stamp even if one had
  been. Six columns, NULL in every database that has ever existed. **No new event was invented**: the
  deferral registry's own note said M6 needed an `m6.document_requested` and the anticipated-events list
  named one, but the M22 spec's §4.11 consumer table routes M6's SOURCE events to the renderer one
  template each — the `m23.abn.required` shape — and M6's catalog has declared `m22` on exactly those six
  the whole time. The catalog was right and only the subscription was absent. **The `patientId` defect
  from F-099 recurred at larger scale and with no defensible exception**: none of the six payloads carried
  a chart target, M22 `dependsOn [1, 5]` and cannot resolve one, and every emit site already had the value
  in hand — so binding alone would have filed six CoP artifacts on no chart, which is worse than not
  rendering them (an unrendered request is a visible `pending` row; an off-chart signed certification is a
  filed document nobody can find).
  **The render call's spread order was a live defect of exactly that kind and only the live run found it.**
  `render.content` was spread AFTER the resolved `aggregateId`/`patientId`, so a payload carrying its own
  `aggregateId` overwrote the identity the normalizer had just decided — and M6's `runEffects` puts the
  TRANSITION's aggregate in the body, so every NOR rendered under its ADMISSION's id. The document
  existed, addressed to the wrong row, and the back-ref could never match: the one failure mode a back-ref
  cannot recover from, because there IS a document and it looks fine. The resolved routing now wins.
  **Six production routes 500'd, and the reason no test could see it is the F-093 shape exactly.**
  `createDbAdmissionRouteService(db)` defaults its outbox to `NOOP_OUTBOX`, which accepts anything, and
  **every M6 live suite took that default — nine constructions across eight files** — so the module drove
  its entire production write surface against a publisher that validates nothing, while production binds
  one that `Value.Check`s and REFUSES. `runEffects`' base envelope is `{aggregateId, admissionId}` and
  every M6 event declares more, so an effect emitted without its own `extraPayloadByEvent` entry does not
  degrade, it rolls the write back. Found by binding the real publisher in the live suites (now
  `__tests__/_m6-outbox.ts`): `POST /f2f/:id/complete`, `/f2f/:id/window-override`, `/f2f/:id/attest`,
  `/admissions/:id/hold`, `/admissions/:id/resume` and **`POST /election-periods`**. Two of those are
  structural rather than clerical. The completion transition emitted **`m6.f2f.scheduled`** — the wrong
  event, announcing to every consumer that the encounter had been *scheduled* at the moment it was
  completed, and a name whose schema the completion path cannot satisfy; attestation is only reachable
  from `completed`, so the whole CMS-418.22(a)(4) face-to-face chain was dead one step past scheduling
  (`m6.f2f.completed` is now catalogued, record-only, because no module acts on completion and inventing a
  consumer would put a permanently-pending row on every one). And `createElectionPeriod` omitted
  `sequence`, so **no admission could open a benefit period past the one its activation seeds** — 42 CFR
  418.21(a) recertification, refused for every tenant. The typed `M6OutboxEventName` union did not help
  with either: it pins NAMES, and a real name emitted from the wrong transition with the wrong payload is
  still a real name. Proven by `m6-cop-document-renders.live.test.ts` — the real admission write service,
  the real catalog-validating publisher, the real dispatcher, the real renderer, into real `document` rows
  and the six stamped columns, under RLS, with org B seeing none of it.
  **Nine m6 events still declare `m22` and they are two different things, recorded in the registry
  reason rather than smoothed over.** `m6.discharge.cosigned` and `m6.transfer.created` are named by the
  M22 spec and are genuinely deferred — the cosign fires on the SAME `discharge_event` id, so it is a new
  VERSION of an existing document and the decider answers `idempotent_skip` until the W2 append path
  exists; the transfer wants a `discharge_summary` TRANSFER VARIANT M22 does not publish, and rendering
  the base template would file a document titled Discharge Summary for a patient who was transferred. The
  other seven — `referral.accepted`, `admission.draft_created`, `admission.activated`,
  `admission.discharged`, `election.drafted`, `election.period_started`, `loc.changed` — are named by no
  part of the M22 spec and by no M22 consumer, so they are **mis-declared rather than deferred**, and each
  is a high-volume clinical event whose every emission is re-claimed every thirty minutes for the life of
  the deployment. **Now fixed (F-101).** The two specs disagreed and only one of them owns the answer:
  `declaredConsumers` is a ROUTING input, not a record of interest, so M22's own §4.11 consumer table
  decides who consumes M22, and M6 §4.4's table — which names M22 on all seven, glossing
  `admission.draft_created` as "(election form prep)" — was the wrong side to follow. Each of the seven
  has a SIBLING event that carries the renderable artifact and IS bound: the election statement renders
  from `election.signed` not `.drafted`, the discharge summary from `discharge.created` (which carries the
  `discharge_event` id M22 back-refs) not `admission.discharged`, the recert CTI from `cti.signed` not
  `election.period_started`. **Three of the seven named `m22` and nothing else**, so each was a
  permanently-pending row on a path with no consumer at all — a referral acceptance, a draft admission, a
  drafted election statement — and all three are now **record-only**, which `buildOutboxRoutingPlan` puts
  in `recordOnly` and the relay finalizes `dispatched` and the retention purge can finally collect. The
  other four still defer, on their other unbound consumers, and that is the point rather than a
  shortfall: **the reason they defer is now the true one**, and a deferral list that names a consumer
  which will never bind cannot be worked off. The precedent is #204, which dropped `m20` from
  `m19.oncall_shift.activated` for the same reason and recorded it in `packages/types/src/safety.ts`
  rather than by editing the spec. The tests assert the ROUTING OUTCOME, not the membership of a list —
  `not.toContain("m22")` passes equally on a catalog where the event was deleted — and two of them are
  controls that pass in both directions, pinning that the six F-100 renders and the two genuinely
  deferred entries kept their declaration: a blanket sweep would have un-rendered the CoP documents the
  previous PR had just wired. Deferred pairs 527 → **520**.

**A discharged patient's orders stayed in flight forever, and the fix was blocked from BOTH sides
  (F-102, #103).** M11 and M12 each ship a complete, exported, unit-tested discharge-cascade decider —
  `decideDischargeCascade` (§2.6 D13 / W-DC-02) and `decideMedicationDischargeCascade` (§2.2 D13) — and the
  only caller either has ever had is its own test file. Both modules' `consumers/index.ts` explain the
  absence as "the live boot wiring, when the backend is mounted"; the backend has been mounted for a long
  time. **Nobody could have written that wiring**: `m6.admission.discharged` named neither module in its
  `declaredConsumers`, and `assertBindableAgainstCatalog` refuses a binding whose module the catalog does
  not declare — so a decider with no binding and a catalog with no declaration each made the other look
  like someone else's half. It is the F-101 shape inverted: that one was a declaration with no consumer,
  this is a consumer with no declaration, and only the second is invisible to `arch:outbox-bindings`'
  rules 1–4. Rule 6 saw it and could only file it: `outbox-subscription-exceptions.ts` held both as
  `handler-unbound`, which is accurate and is not a fix. Every order still in flight when a patient was
  discharged stayed in flight — a pending-signature lab, a verbal-pending comfort kit, an active DME
  rental, and a `queued_for_transmission` medication order, which is one waiting to reach the
  e-prescribing vendor. **The cascade deliberately does NOT go through `discontinueOrder`**, which both
  deciders' headers named as its executor: that path writes `actorMembershipId: userId` — the CALLER — so
  a system cascade would put a clinician's name on an act they did not perform, on a chart a surveyor
  reads; it never writes `source_outbox_event_id`; and it runs the machine's `discontinue` event, which is
  legal only from `active`, while `cascadeDiscontinue` is legal from `pending_signature` and
  `verbal_pending` too — so the orders that most need stopping are exactly the ones it would have refused
  with ILLEGAL_ORDER_TRANSITION. `order_discontinuation.actor_membership_id` has been nullable since M11's
  schema landed, commented "NULL for system-actor cascades", and `source_outbox_event_id` has existed for
  this provenance; **nothing in the repository had ever written either**. **A third defect was one layer
  down**: `emitSupplyCancellation` was gated on an `supplyFulfillmentInFlight` fact M11 CANNOT PRODUCE —
  `order_record` holds no supply-request reference, and `SupplyFulfillmentProvider.isTerminal`, the seam
  whose doc says "M11 asks this before issuing a cancellation", takes a `SupplyRequestId` M11 never sees.
  The only value a live consumer could honestly pass was `false`, and `false` meant M21 was never told:
  the cascade would discontinue a DME rental and leave the vendor order standing. The gate is gone rather
  than the fact invented, because **M21 already answers this and says so** — its payload doc reads "M21
  keys on `orderId` regardless, because M11's ref can be stale", and `decideSupplyCancellationCascade`
  returns `no_match`, emitting nothing, for an order with no request. Asking about an order that was never
  fulfilled is a no-op M21 is built for; not asking about one that was is a live vendor order on a
  discharged patient. Proven by `m6-discharge-cascade.live.test.ts` — the real M6 write service discharges
  as `wardenx_app`, the real catalog-validating publisher writes the row, the real dispatcher delivers it,
  and both real consumers read their own tables under RLS; 5 of its 6 cases fail with the bindings removed,
  and the sixth is the terminal-orders control that must pass either way. **M13 and M15 are NOT the same
  finding and are not fixed here**: both are registered `no-handler`, meaning no decider exists — M13's
  four M6 lifecycle subscriptions are §4.5 eMAR-context inputs nobody has written, and M15's is larger
  and reported separately below.

  **M15's entire write surface hung off a table nothing inserted into (F-103, #103).**
  `bootstrapDisciplinePlan` is the §2.2.1 `[*] → draft` factory whose own doc says it is "called by the
  `m6.admission.activated` consumer"; **that consumer did not exist**, M15's `consumers/` was a
  seam-reading layer with no outbox binding in it, m15 was not in that event's `declaredConsumers`, and
  there was **no INSERT into `discipline_care_plan` anywhere in the repository** — not the write service,
  not a seed, not a test. Nor is there a route that creates one: every M15 write route is
  `/discipline-plans/:planId/…`, so the bootstrap consumer is the ONLY creation path by design. The aide
  plan of care (CoP 418.76), the MSW plan (418.64(c)), the spiritual plan (418.64(d)) and every goal,
  intervention, discipline assessment and 14-day aide supervisory visit — all of which hang off `plan_id`
  rather than a version — were unreachable in every deployment that has ever run, and the §7.1/§7.2/§7.3
  initial-assessment clocks that count from `initial_assessment_clock_started_at` never started because
  nothing set it. The M20 `safety_check_in_schedule` finding one module over: an empty compliance surface
  and a compliant one are indistinguishable. **A SECOND defect sat under it and only running the live
  suite found it.** M15's `OutboxEmission` had no `organizationId` field and none of its six emit sites
  supplied one; `outbox_event.organization_id` has no default, so every `m15.*` emission wrote NULL and
  the RLS WITH CHECK refused it with **42501, rolling back the whole mutation** — signing a plan version,
  amending a discipline assessment, completing an aide supervisory visit and all three
  volunteer-assignment inactivations 500 in production. Invisible because **M15 had no live suite at
  all**: every existing M15 test drives the write service with a no-op outbox, which accepts anything —
  the F-093/F-100 shape a third time. `organizationId`, `aggregateKind` and `aggregateId` are now REQUIRED
  on the emission rather than optional; optional made the port assignable to the real publisher only by
  method bivariance, which is exactly the check that let the omission through. **The version half is
  reported, not fixed**: `discipline_care_plan_version` has no writer and no create route either
  (`/versions` is a GET; only `finalize` and `sign` are POSTs), so a plan still cannot be authored to v1 —
  and §7.1 assigns v1 to a person ("the supervising RN … creates Aide POC v1 with the task list"), so a
  stub version authored by the relay would put a draft on the record nobody wrote. Proven by
  `m15-plan-bootstrap.live.test.ts`: the real M6 write service activates an admission, the real dispatcher
  delivers, M15's real consumer sites the plans through M6's org-explicit `admissionSchedulingContextForOrg`
  (the §4.7 seam cannot be used — it pins the tenant from the ambient REQUEST scope and a relay tick is not
  a request) and inserts under RLS. All 7 fail without the binding. **The suite also found the harness
  lying to itself twice**: three cases were `for (const p of await plansFor(…))` over an empty list, which
  asserts nothing and passed while the consumer was refusing every delivery.

  **M14's D8 action-item auto-close: three absences stacked, and the deepest one would have made the
  fix look like it worked (F-104, #103).** §4.5 says an action item linked to a downstream artifact closes
  itself when that artifact reaches its absorbing state — "action item flips to `auto_closed`;
  `linked_artifact_id` confirmed; `closed_at = now()`". Everything for it shipped with M14-T06 except what
  makes it run: `transitionActionItem(_, {type:'autoClose'})` complete and unit-tested, `auto_closed` in
  the status enum, `close_reason` on the table, `m14.action_item.auto_closed` catalogued,
  `planActionItemAutoClose` mapping each source event to its linked kind — and **no binding**, plus three
  of the six sources (`m11.order.signed`, `m11.order.completed`, `m12.medication_order.signed`) not
  declaring m14 at all, so `assertBindableAgainstCatalog` would have refused half of it. **Underneath both:
  `idg_action_item.linked_artifact_id`, the column the whole engine matches on, was written by NOTHING** —
  the create route took `linkedArtifactKind` and not the id, the INSERT wrote the kind and not the id, the
  view returned the kind and not the id, and `m14.action_item.created` announced the kind and not the id.
  The `election_period.effective_at` shape (read in seven places, written in none) one module over, and
  the reason binding alone would have been WORSE than not binding: a live handler matching NULL forever,
  green, with a `close_reason` value and an outbox event to make it look wired. Both link fields now travel
  together or not at all (422), because a kind with no id can never close and an id with no kind is matched
  by nothing — either alone is an item that LOOKS linked and stays open. **The M8 case is deliberately not
  the same rule**: §2 and §4.5 both say `m8.encounter.signed` closes an `encounter`-linked item MATCHING THE
  ASSIGNEE, not the artifact, because the encounter did not exist when the item was written. Collapsing the
  two is the obvious simplification and it is wrong in the expensive direction either way round — keyed on
  the artifact no encounter item would ever close, keyed on the assignee a signed care plan would close that
  clinician's unrelated order items. Proven by `m14-action-item-autoclose.live.test.ts`, which publishes
  each real upstream event through the real catalog-validating publisher (four of the six payloads this
  suite first invented were REFUSED by it, which is the guard working) and drives the real dispatcher into
  the real consumer under RLS; 6 of its 8 fail with the binding removed. What remains in the m14 group is
  the other three shapes M14 describes and has not built — the M6 inclusion cache, the M9/M10/M11/M12
  "since last IDG" Valkey projection cache, and the M22 packet back-ref, which additionally has no producer
  since `m14.packet.document_requested` is catalogued by nobody.

  **No bereavement plan has ever existed, and three more defects sat between the event and the row
  (F-105, #103).** CoP 418.64(d) obliges a hospice to serve the decedent's family for THIRTEEN MONTHS, and
  `bereavement_plan` is the root carrying that single clock — the contact roster, the D4 outreach schedule,
  the anniversary reminders, the risk scores and the closure record all hang off `plan_id`.
  `decideEligibilityIntake` is M16's complete §4.3.1 intake decider and its own header says "the live
  outbox binding + the transactional insert land with the §4.9 workers in M16-T06"; there was no binding,
  and **no INSERT INTO `bereavement_plan` anywhere in the repository** — not the write service, not a seed,
  not a test. Nor a route: `POST /api/v1/bereavement/plans` does not exist (the collection path is a GET
  worklist) and all fifteen plan writes are `/plans/:planId/…`, so the consumer is the only creation path
  BY DESIGN and it was absent. The M15 `discipline_care_plan` and M20 `safety_check_in_schedule` finding a
  third time, and M30's `bereavement_coverage_rate` has been computing off the empty table. M6's side was
  never missing — `m6.bereavement.eligible` is catalogued, emitted from the death-discharge transition, and
  declares exactly one consumer, so every death has left a `pending` row re-claimed every thirty minutes.
  **Three defects underneath, none of which any test could see** (every M16 suite drives the write service
  through `NOOP_OUTBOX`, the F-093/F-100/F-103 shape). (1) M16's `OutboxEmission` had **no
  `organizationId`** and none of its five emit sites supplied one, so every `m16.*` row wrote NULL, RLS
  refused it with 42501 and — the publish running on the CALLER's transaction being the whole point of a
  transactional outbox — the mutation rolled back with it: seeding a roster, assigning a volunteer,
  completing an outreach and initiating contact were all 500s. It was already on the effect context, used
  by the `alert` arm one case below. Required now, not optional: optional is what let the port stay
  assignable to the real publisher by method bivariance. (2) `resolveDeathFact` called M6's §4.7
  `AdmissionStatusReader`, whose id-keyed reads open `withOrgContextFromRequest` — a relay tick is not a
  request, so every delivery would have dead-lettered. (3) **The census window's upper bound excluded the
  row it was looking for.** `DeathDischargeReader`'s period is half-open (`death_at < to`, right for the
  reporting-period scans it was written for), M16 asked for `to = eligibleAt`, and on M6's emit path those
  are THE SAME VALUE — `discharge_event.death_at` and the event's `eligibleAt` are both set from one
  `dischargeDate` field in one statement. So `resolveDeathFact` returned null for every death ever
  recorded, and the intake reported it as "M6's census has no row for this admission", which is the
  opposite of true. Fixed in M16 rather than the seam: making the period inclusive would change a published
  contract under M5, M21 and M30 to fix M16's off-by-one-instant, and M5's own death consumer already pads
  the same bound. **A fourth was PARAM-004 pointing the wrong way.** It replaced a UTC slice of
  `death_at` with an org-timezone conversion because "a death at 11:45pm Pacific is 06:45 UTC the FOLLOWING
  day" — correct about instants, and `discharge_event.death_at` is not one: its only writer is
  `new Date(input.dischargeDate)` where `dischargeDate` is `Type.String({ format: "date" })`, and M6's own
  state machine types the field `deathAt: LocalDate`. M6 models no time of death. Every value in that
  column is midnight UTC of a typed date, so converting it through a US timezone lands on the previous
  evening — dating every death ONE DAY EARLY in every organization west of UTC, which is every US hospice,
  on the column D4's 13-month clock counts from. PARAM-004 fixed a failure this data cannot exhibit and
  introduced one it always will; its own fixture is an instant with a time component M6 cannot produce.
  `localDateOf` is kept and still tested, because it is right the day M6 records a real instant.
  **A fifth is reported, not fixed**: `checkDeathDateMatchesAdmission`'s second parameter is named
  `admissionDeathDate` and wants `discharge_event.effective_at`; it was being passed
  `admission.discharged_at`, which the discharge transition writes `now()` — so the §2.5 check compared the
  death date to the FILING instant for equality and rejected precisely the late filing W-DC-01 permits and
  the 180-day lookback exists for. It now passes `null` (the decider's own documented branch) and starts
  performing the day `DeathDischargeRow` carries `effectiveAt` — though it is vacuous even then, since
  M6 sets both fields from one input. `decideCosignReceipt`, M16's other written decider, stays registered
  as deferred with the true reason: `discharge_event` models no external source, so every death reads
  `internal_clinician_recorded`, no plan can carry the `external_source_metadata` a D18 receipt would
  release, and the payloads do not meet either. Proven by `m16-bereavement-intake.live.test.ts` — the real
  M6 write service discharges by death as `wardenx_app`, the real catalog-validating publisher writes the
  row, the real dispatcher delivers it, and M16's real consumer reads M6's real census seam and inserts
  under RLS; 7 of its 8 fail with the binding removed, and the eighth is the non-death control that must
  pass either way.

  **No Notice of Election has ever been filed, and the trigger the spec names cannot work (F-106, #103).**
  The NOE tells Medicare a beneficiary has elected the hospice benefit. CMS requires it within FIVE
  CALENDAR DAYS of the election effective date; miss the window and the hospice forfeits payment for every
  day from the election start until the notice is accepted (42 CFR 418.24(b), CR 8877) — one of the most
  expensive timing rules in hospice billing. **`NoeRepository.create` had no caller anywhere in the
  repository** — not production code, not one test — and `schema.noeRecord` is touched only by M23's ABAC
  resolver and its eraser. No route either: `/api/v1/noe-records` is a GET list and the only POSTs are
  `/:id/submit` and `/:id/cancel`, both of which load an existing row. So the 5-day clock was never started
  for any election, the `noe_window_watch_idx` watchdog cron has always scanned an empty table, and the NOE
  worklist screen has always been empty. `consumers/index.ts` explains the absence as "the live inbound
  dispatcher is a later platform phase" — that dispatcher landed, the `isPlatformOperator` shape.
  **The trigger M23's §4.4 map names cannot carry the fact.** It routes `create_noe_draft` off
  `m6.election.signed`, and `noe_record.election_effective_date` and `window_target_at` are both NOT NULL —
  the second one IS the CMS deadline. The election's effective date exists in exactly one place,
  `election_period.effective_at`, which the `setActive` transition writes at admission ACTIVATION and
  nothing else does (F-042's column); `election_statement` carries only `signed_at`. In M6's own flow the
  statement is signed BEFORE the admission activates, so at that event the anchor is NULL and a federal
  filing could not be dated. `m6.election.period_started` is emitted from the transaction that writes the
  column, already declared `m23`, and its own payload schema says a consumer needing the window "can read
  it from `electionPeriodId` via the M6 seam once the seed path actually stores it" — a precondition F-042
  met. The sibling event carries the fact, which is the F-101 shape, so **`m23` is dropped from
  `m6.election.signed`'s `declaredConsumers`** (leaving `["m22"]`, bound) rather than left to defer a topic
  M23 does not consume. Gated on `sequenceNumber === 1`: an NOE is filed once per ELECTION, not per benefit
  period, and a recert continues the same election — `noe_record_admission_uq` is the structural backstop,
  the sequence check is what stops a second insert being attempted at all. The facts arrive through
  `electionPeriodContextForOrg`, a new org-explicit M6 reader (the `admissionSchedulingContextForOrg`
  sibling — the §4.7 seam pins the tenant from the ambient request scope and a relay tick is not a
  request), and the CCN through the same `ProviderCcnPort` shape the claim write service already binds.
  Proven by `m23-noe-draft.live.test.ts`: the real M6 write service runs the §418.24 chain to an active
  admission as `wardenx_app`, the real publisher writes the row, the real dispatcher delivers it, and M23's
  real consumer inserts through the real `NoeRepository` under RLS — all 8 fail with the binding removed.
  **What remains in the m23 group is now stated per-effect rather than as a phase**: `createNotrDraft` (the
  NOTR half — `notr_record` has no writer either, and its three trigger topics need the transfer-direction
  and discharge-reason mapping decided first), `enqueueRevalidation`, `freezeNewClaims` and
  `recordDocumentBackReference`. **M26's stated blocker was CHECKED and is real, not expired**: its
  `CapConsumerStore` needs `cap_beneficiary_accrual.mbi_normalized` and `first_election_in_period`, both
  NOT NULL, and M5 publishes no MBI reader seam — so the Medicare aggregate-cap accrual ledger has no
  writer and a tenant's cap liability computes as zero. Reported, not fixed: the facts exist in the
  database and only the seams are missing, which is a producer-side M5 change.

  **The NOTR was the same absence with a second table, and two of its three triggers needed a decision
  (F-107, #103).** The Notice of Termination/Revocation tells Medicare a hospice election has ENDED; 42 CFR
  418.26 requires it within five calendar days of the discharge or revocation effective date, and the M23
  spec's own regulatory table says exactly that. `NotrRepository.create` had no caller anywhere,
  `schema.notrRecord` is touched only by the ABAC resolver and the eraser, and `/api/v1/billing/
  notr-records` is a GET whose only POST is `:id:submit` — so no notice of an election ending has ever been
  drafted and the `notr_window_watch_idx` watchdog has always scanned an empty table. **TRANSFER** was the
  producer-side half: `notr_record.effective_end_date` is NOT NULL and `m6.transfer.created` published
  `{transferEventId, admissionId, direction, otherHospiceCcn}` and no date at all — not derivable
  downstream either, because `transferOut` discharges through `dischargeAdmissionTx`, which stamps
  `admission.discharged_at = now()`, the day the paperwork was filed rather than the day the transfer took
  effect. `transfer_event.effective_at` is NOT NULL and both emit sites had `input.effectiveDate` in hand,
  so the payload is widened (the F-099/F-100 shape); direction `in` is a deliberate no-op, since a transfer
  IN starts a benefit rather than ending one. **DISCHARGE** turned on `requiresMedicalDirectorCosign`, which
  is the right discriminator rather than a proxy for one: W-DC-02 says filing a for-cause discharge does NOT
  discharge the admission — the row is `pending_cosign` and the patient stays on service — so a NOTR then
  would tell CMS the benefit ended while the agency is still being paid to provide it. `discharge()`'s
  pending branch emits `true`; `dischargeAdmissionTx`, which runs on the immediate path AND again from
  `cosignDischarge`, always emits `false`. So the for-cause notice fires at COSIGN off the second emission
  with the same `dischargeEventId`, and nothing needs to subscribe to `m6.discharge.cosigned` (whose payload
  carries no admission, patient or date anyway). A DEATH discharge drafts one like any other — the spec's
  trigger list carves out no reason, 418.26 is written about the benefit ending rather than about why, and
  the two mistakes are not symmetric: an unnecessary NOTR is cancelled at the MAC, a missing one forfeits
  payment. The `notr_record` CHECK constraints make trigger and event id ONE fact (`trigger_kind =
  'revocation' AND revocation_event_id IS NOT NULL`, exactly one of three id columns set), so the mapping is
  enforced by the schema rather than only by the consumer. Proven by `m23-notr-draft.live.test.ts` — the
  real M6 write service runs each termination as `wardenx_app`, the real publisher writes the row, the real
  dispatcher delivers it, and M23's real consumer inserts through the real `NotrRepository` under RLS; all
  8 fail with the binding removed, including the two "drafts nothing" cases, which assert the consumer MADE
  the decision rather than merely that no row appeared. What remains in the m23 group is now three named
  ports rather than a phase: `enqueueRevalidation`, `freezeNewClaims` and `recordDocumentBackReference`.

  **The cost report CMS receives pointed at nothing, and the request half was asking for the wrong file
  (F-108, #103).** `ecr_submission.ecr_file_document_id`, `.pi_file_document_id` and
  `.supporting_documents_document_ids` are where M27 holds the Electronic Cost Report, the Print Image and
  the supporting bundle — "M22 ref" in the schema, D11's "M27 holds back-references; no MinIO code".
  `EcrSubmissionRepository.update` has accepted exactly those three since M27-T05 and **nothing has ever
  called it with one**; `handleDocumentRendered`, the pure decider for them, shipped with M27-T09 with **no
  caller anywhere and no test anywhere** — not even its own, unlike every prior instance of this shape.
  `consumers/index.ts` files the absence as "the live inbound transactional-outbox dispatcher accessor
  lands (RULE 3(d))", the phase F-106 already found had landed. F-099 bound the REQUEST half, so since then
  every submitted report has rendered a real document into MinIO and the submission that produced it has
  gone on serving `ecrFileDocumentId: null`. **The pure handler's declared payload named two fields the wire
  does not carry.** `DocumentRenderedEvent` wanted `submissionId` and `artifactKind`; M27 fans three
  artifacts out under ONE request event name, so M22 routes each to its own template and its own
  `aggregate_type` and echoes back `aggregateType` + `aggregateId`. A binding written to the declared shape
  would have read `undefined` for both and no-op'd on every delivery — the F-030 attribute failure at
  payload granularity, silent and indistinguishable from "no M27 document was rendered". The discriminator
  is now `aggregateType`, which is the shared vocabulary rather than M22's private routing map: the three
  values are `DocumentAggregateType` members in the leaf `packages/types`, so reading them is reading a
  published contract and not copying a list. **The producer-side defect only surfaced from tracing the same
  handshake, and it was the more expensive half.** `submitCostReport` emitted its OWN
  `m27.artifact.render_requested` for `ecr` carrying `payloadRef: snapshot.id`, one line after enqueueing
  the `ecr-generation` job that emits BOTH artifacts carrying the real `buildEcrArtifacts` text. M22's D14
  idempotency is keyed `(sourceEvent, aggregateType, aggregateId)` and the submit row is written FIRST, so
  it won — the rendered Electronic Cost Report was a serialization of the request envelope with a snapshot
  UUID where the file's contents belong, and the job's request, the one holding the actual filing, was an
  `idempotent_skip`. The emit is gone from submit: the job owns it because the job is what has the
  artifacts. **The group reason was wrong about every member, the F-099 shape at full scale.** It read that
  M27's `consumers/subscription-map.ts` + `handlers.ts` are the M25/M26 mirror and the topics are
  forward-declared pending the relay; that map names THREE topics and **not one of the 23 events in the
  group is among them** — they were never forward-declared, they were never declared at all. What is
  actually true is that M27's input model is a seam PULL: `statistics-refresh` re-aggregates the S-3
  patient-day census from M6's `LevelOfCarePeriodReader`/`AdmissionCensusReader` and the visits-by-discipline
  from M8's `EncounterStatisticsProvider`, `refresh-inputs` materializes the trial balance, and the M23/M26
  revenue and cap facts arrive through M27's own forward-seam readers. So all 23 name as a PUSH consumer a
  module that resolves the same fact by PULL — nine of them (`m21.supply_request.invoice_*`,
  `m26.cap.accrual_recorded`/`.settlement_*`/`.year_*`, `m8.mileage.captured`) naming m27 and nobody else,
  so every emission is a row re-claimed every thirty minutes with no consumer anywhere. **Reported, not
  fixed**: the correction is the F-101 sweep and it needs the same per-event verification F-101 gave m6's
  seven, not a blanket edit. Two smaller absences recorded with it — the supporting-doc REQUEST has no
  producer at all (`runEcrGeneration` emits `ecr` and `pi`, and nothing else emits the event), so the
  handler's append branch is reachable only from the test; and M40 publishes no provider-entity offboard
  topic under any spelling, so M27's third subscription stays `no-such-event` rather than deferred. Proven
  by `m27-ecr-backref.live.test.ts` — the real `runEcrGeneration`, the real catalog-validating publisher,
  the real dispatcher, M22's real render consumer and renderer, into real `document` rows and the stamped
  columns, under RLS, with org A's artifact refused against org B's submission; 3 of its 7 fail with the
  binding removed, and the producer-side half fails `m27-cost-report-workflow-slice.live.test.ts` when the
  submit emission is put back.

  **Every alert the platform has ever emitted claimed it was delivered, and nothing has ever been
  delivered by any channel (F-109, #103).** `alert.outcome` was `NOT NULL DEFAULT 'delivered'` and
  **written by nothing**: `computeOutcome`, the §2.4.3 roll-up, has existed since M36-T04 with no caller,
  and `notification_delivery.status` has **no `UPDATE` anywhere in the repository**, so the §2.4.4 state
  machine had exactly one reachable state and every delivery row ever written is still `pending`. The
  user-visible end of it is that `aggregateDeliveryStatus` — a SECOND roll-up, called but writing nothing
  — has returned `"pending"` for every line of every user's Notifications tab, always. **The enum could
  not say otherwise.** §2.4.3's machine OPENS in `pending` ("alert row written; notification_delivery rows
  enqueued") and `alert_outcome` had three values, none of them that one — so the column could not express
  "not settled yet" and asserted the most flattering value available instead. Migration 0240 adds it, 0241
  moves the DEFAULT and corrects the historical rows, guarded on **not one** delivery having reached a
  §2.4.4 terminal state, which is the definition of "nothing settled" and is what makes the rewrite a
  correction rather than a blanket relabel. **The settlement path is the inbox READ, and ADR-0036 is why.**
  §2.4.4 settles an in-app row on "socket acked"; ADR-0036 (Accepted, and it wins over a module spec)
  records that `socket.io` is installed nowhere, no realtime transport was ever built, and "UI freshness is
  REST refetch/poll". `GET /api/v1/alerts/inbox` IS that poll — `notifications-inbox.tsx` is its only
  caller — so the fetch is the moment the alert reaches the client and there is no second event to wait
  for. It goes straight to `delivered`: `sent` is the accepted-by-dispatcher step of a dispatcher tier that
  does not exist, and parking rows in a state nothing advances is the defect being fixed. Scoped three ways
  and narrowed to `pending` so a poll can only settle the caller's own undelivered in-app rows — the
  parent-join RLS policy, the explicit `alert.organization_id` predicate beside it, and
  `recipient_user_id` — and the parent re-roll is skipped when the outcome is unchanged, because the M4
  trigger fires on every UPDATE and a still-pending alert would otherwise log a row per poll per recipient
  forever. **The single most misleading value the column carried is now `failed`**: `emit()` writes a
  no-op alert when no `alert_rule` fires, so an event that matched nothing recorded itself as successfully
  delivered to the zero people it reached — `rollUpAlertOutcome([])` is `computeOutcome`'s own documented
  answer, "nobody was reached", and the emitter now writes the initial outcome rather than defaulting it.
  **Out-of-band rows are deliberately untouched, and an alert holding one now stays `pending` forever.**
  That is not a new defect, it is the missing tier becoming visible: `planFanOut` plans push/sms/email/voice
  deliveries and **no dispatcher exists for any of them** — `packages/messaging/src` has no `dispatchers/`
  directory, and the twelve §4.4 queue names in `jobs/queues.ts` are pure data referenced by nothing but
  their own test, so no `Queue`, no `Worker` and no producer has ever been constructed. Calling a push
  nobody sent `delivered` would move the lie rather than remove it. **Reported, not fixed**: that whole
  out-of-band tier, and the standing #205 absence it sat inside — at the time, M36 contributed NO event
  catalog, so `m36.notification.delivery_failed` had no producer and the three written deciders that
  subscribe to it (M19's `consumers/m36-delivery-failed.ts`, M20's `delivery_failed` SOS escalation reason,
  M26's) could not run. **M36 now catalogues the event (`events-by-m36.ts`, #205) and M19/M20 are real,
  live-bound consumers** — M19 escalates an open call, opens an operational call, or reports a coverage
  gap; M20 advances the SOS ladder, capped at `escalation_tier_3` since its dial/page/PSAP terminus
  effects have no implementation anywhere (M26's stays `no-handler`: its own handler is a no-op stub and
  its whole consumer relay is unbound, `outbox-subscription-exceptions.ts`). The gap this paragraph is
  actually about still stands: **no producer exists** — nothing publishes the event, because the
  out-of-band dispatch/reconciliation pipeline (Twilio/push/email/voice) that would detect a delivery
  failure and emit it is unbuilt, the separate project named above. M19's file already names itself as the
  one place to reconcile when that pipeline lands and publishes the real payload.
  Proven by `m36-alert-outcome.live.test.ts` — the real Drizzle `AlertEmitter` over a real platform-default
  `alert_rule`, the real route service, real RLS, org B's poll unable to settle org A's row; 3 of its 7
  fail with the two production changes reverted, and the migration case fails on a schema without
  0240/0241.

  **A sibling table in the same subsystem shipped with no RLS and no grant at all (F-110, #247),
  found re-verifying this fix live.** `alert_receipt` (migration 0243 — per-user read-receipt state
  for the alert inbox, distinct from `notification_delivery`'s transport-lifecycle rows) has no
  `GRANT` to `wardenx_app` and no RLS policy anywhere, unlike `notification_delivery` — its exact
  structural sibling, also a pure child of `alert` — which has carried a parent-join policy + grant
  since migration 0017. Every real request touching it (`listAlertInbox`'s left-join,
  `markAlertRead`'s insert, both in `messaging-route-service-db.ts`) threw Postgres 42501 "permission
  denied for table alert_receipt" — confirmed live, 4 of 7 cases in `m36-alert-outcome.live.test.ts`
  failed before the fix. Migration 0247 mirrors `notification_delivery`'s parent-join RLS shape,
  adding the NULLIF empty-GUC guard from migration 0246's `device_attestation` precedent (this table
  is only ever touched inside `withOrgContext` today, unlike that guard's original bare-pool case,
  but the guard is free insurance against the identical failure mode). **A gate blind spot sits
  underneath and is reported, not fixed**: `check-tenancy.ts`'s Rule 1 three-column check never
  flagged the missing `organization_id` handling either, because its schema-scanning regex assumes a
  two-argument `pgTable(name, columns)` call ending in a bare `\n})` — `alert_receipt`'s three-argument
  form (`pgTable(name, columns, (t) => ({ indexes… }))`) never matches it, so the table was invisible
  to Rule 1 regardless of the `NON_ORG_SCOPED` allowlist. A MISS, not a false alarm, and it applies to
  any other three-argument `pgTable()` table in the schema — filed as its own issue (#247) rather than
  attempting a regex fix with repo-wide blast radius in the same pass. `alert_receipt` is now
  explicitly added to `NON_ORG_SCOPED`'s M36 entry regardless, so the exemption is documented intent
  rather than an accident of what the regex happens to match.

  **Rule 6 (F-094, #205) is the direction rule 4 still did not run.** Six modules publish an
  `M*_SUBSCRIBED_EVENT_NAMES` constant, and each carries the same doc comment — it exists "so an upstream
  rename breaks the build rather than silently orphaning a handler". **Nothing compared any of them to
  anything.** They are string-literal tuples, and the tests that reference them assert the list's SHAPE
  (three dot-separated segments, no self-consumption, contains one particular corrected name) and never
  that a name EXISTS; two of the six also claimed to be "verified as live by `validateSeams()` at boot",
  which validates the SEAM registry and has no knowledge of event names. The six and the catalog disagreed
  on **65 facts**. Rule 6 asks both directions and the halves are not symmetric: a name the catalog does
  not declare is an event the relay delivers to NOBODY in that module, and writing a binding does not help
  — `assertBindableAgainstCatalog` refuses a binding whose module is undeclared, which is the wall #204
  hit; a declaration the list omits is just the list being wrong, since the catalog is what the relay
  reads. So **32 were reconciled INTO the lists**, including `idg.decision_recorded` — the one event M16
  binds live, which M16's own subscription list did not name. **Three were real routing bugs**: M21 has
  had deciders for `m13.comfort_kit.deployed` and `.controlled_substance_discrepancy` since M21-T04 and
  the catalog named m14 and m30, so a kit deployment routed past the only module that stocks one; M16's
  `decideCosignReceipt` is the D18 gate-release decider for `m6.discharge.cosigned`, declared to m22
  alone. **Three were deleted** — M16's `m17.shift_changed` (M17 emits no shift topic under any name) and
  M20's two `m19.oncall_shift.*` (its own `consumers/index.ts` says there is nothing to consume: they
  were the re-sync trigger for a cached on-call resolution and M20 caches none). The remaining **28 are
  `scripts/outbox-subscription-exceptions.ts`**, grouped by (module, kind) so the reason lives once and
  the event lists stay exact, with four kinds that each state a checkable fact rather than an intention:
  `no-producer` (6), `no-handler` (11), `record-only-target` (8), `would-defer-a-bound-event` (3). The
  last is the one that stops a well-meant fix: `m22.document.rendered` and `m17.visit.published` are
  delivered TODAY to every consumer they declare, so adding an unbound one would convert a working
  delivery into a row re-claimed every thirty minutes — **for the other consumers too**. The gate deletes
  each entry's own excuse when it expires: a pair that comes to agree both ways fails, one no longer
  named by either side fails, a `no-producer` entry whose event gets catalogued fails, and any other kind
  naming an uncatalogued event fails. **`no-producer` was the standing finding, printed on every run, and
  is now resolved (#205) — the group has zero members.** M2 and M36 used to contribute NO event catalog to
  the boot dispatcher at all — no `M2_OUTBOX_EVENTS`, no `M36_OUTBOX_EVENTS` — so `m36.notification.
  delivery_failed` (named by M19, M20 and M26) and M35's four `m2.*` organization/session topics, half of
  its entire subscription list and the trigger for its §4.12 per-seat billing, had no producer at all.
  **M2 now catalogues and publishes 16 identity-lifecycle events** (`events-by-m2.ts`), including the real
  §11 D19 org activate/suspend/close capability (`organization-lifecycle.ts`) and the `select-organization`
  producer for `m2.session.created` — the exact four events M35 needed. **M36 now catalogues
  `m36.notification.delivery_failed`** (`events-by-m36.ts`), with M19's written decider and M20's SOS
  escalation reason both live-bound to it for the first time. Neither is `no-producer` any more: M35's four
  topics moved to `no-handler` (M35 has no `consumers/` directory yet), and M26's moved to `no-handler` too
  (its handler is a no-op stub, its relay is unbound) — both filed in `outbox-subscription-exceptions.ts`.
  `m36.notification.delivery_failed` itself still has no PRODUCER emitting it in practice, but for a
  different reason now: the out-of-band dispatch/reconciliation pipeline that would detect a failed
  delivery and raise the event is unbuilt (see the alert-outcome finding above) — a gap in what M36 does,
  not in what it declares.

  **Rule 6 saw six modules of nineteen, and its own comment said otherwise (F-095, #208).** It enumerated
  `M<N>_SUBSCRIBED_EVENT_NAMES` off the `@wardenx/types` barrel and claimed "a seventh module publishing one
  is checked the day it lands with no edit here" — false on the day it was written, because THIRTEEN more
  modules already declared their subscriptions under three other spellings and in another directory
  (`M<N>_OUTBOX_SUBSCRIPTIONS` / `M<N>_UPSTREAM_SUBSCRIPTIONS` and the `_TOPICS` splits in each module's own
  `consumers` directory, the frozen `_SUBSCRIPTION_MAP`s, two lone `{ eventName, consumerName }` objects).
  **The gate written to end "a list compared to nothing" left thirteen lists compared to nothing**, and they
  disagreed with the catalog on **132 further facts**. Discovery is now the whole point: the NAME pattern is
  deliberately wide (any `M<N>_…SUBSCRI…` export, anywhere in `apps/` or `packages/`) and the narrowing
  happens on the VALUE, where it can be checked — a matching name whose value is not one of the four
  recognised shapes is an **error, not a skip**, so a fifth spelling breaks the build on the commit that
  introduces it. The one exemption is a `*_DEFERRED` boolean, recognised by `typeof value === "boolean"`
  rather than by name. **Nothing is double-registered**: 255 of the "catalog declares it, the list omits it"
  pairs are the same absence `outbox-deferred-consumers.ts` already holds with a reason, so rule 6 skips a
  pair rule 4 has accepted — and when that deferral is lifted by binding the event, rule 6 starts requiring
  the list to name it, which is how the list gets corrected on the commit that binds.
  **Eight names were dead** — in no catalog under any spelling, so the handler behind each could never run.
  Two are the literal failure these constants' own headers promise to prevent: M14 subscribed to
  `hope.j2051_trigger_fired` and `hope.sfv_created` while M10 catalogues them `m10.`-prefixed, so the J2051
  and SFV consumers named nothing. Three more are M33 MV-invalidation topics (`m17.visit.no_show`,
  `m18.evv.check_in`/`check_out` against the catalogued `…_detected`/`…_recorded`), and three are placeholder
  spellings M23/M24 carried with a written instruction to rebind "when M40's `events-by-m40.ts` lands" —
  it landed, and nothing came back (`mdm.canonical_updated` → `m40.canonical.updated`,
  `m26.cap.*.v1` → the unversioned names, `m23.medicare_claim.acknowledged` → `m23.claim.acknowledged`).
  A placeholder that names a module's own spelling of an event is indistinguishable from a real subscription
  at a glance, which is why all eight survived. **M11 was the live one**: it BINDS `m22.document.rendered`
  (the §7.2 W2 back-ref that stamps `order_record.document_id`) and its own list never named it for the whole
  of that binding's life — the F-094 `idg.decision_recorded` shape again — while the only test on that list
  pinned its contents verbatim, which a list and a copy of the same list always satisfy.
  The remaining **132 are grouped by (module, kind)** in `outbox-subscription-exceptions.ts` with three kinds
  added for facts the six simple lists never presented: `self-consumption` (a module's own event, correctly
  absent from an inbound-only map — the one kind that excuses the OPPOSITE direction, so the freshness check
  inverts for it), `no-such-event` (the owning module has a landed catalog and this is not in it, so waiting
  will not fix it), and `handler-unbound` (the decider is written and bound by nothing — #103's
  `handlers-unbound` set seen from the list side, which `outbox-deferred-consumers.ts` cannot hold because it
  can only carry pairs the catalog DECLARES). The gate DECIDES `no-producer` vs `no-such-event` itself off
  whether the owning module contributes a catalog, rather than trusting the entry — getting those the wrong
  way round is how a permanent defect gets filed as a staging gap. **The standing finding had grown to a
  third module — M28 contributed no event catalog either**, alongside M2 and M36, so the FHIR gateway
  published nothing and M33's `mv_fhir_bulk_export_org_month` had no invalidation source. **Resolved with
  the same #205 pass**: M28 now catalogues 13 events (`events-by-m28.ts`) on real write paths — client
  lifecycle, bulk-export, inbound proposals, including the revocation cascade that cancels an inflight job
  — and `m28.fhir.bulk_export.completed` is the one `mv_fhir_bulk_export_org_month` keys off. It is filed
  `handler-unbound` rather than closed outright: M33's consumer-side mechanism
  (`handleUpstreamInvalidation`) is written and unit-tested but still has no live `OutboxConsumerBinding`,
  deferred with the rest of M33's ~60 MV-refresh topics under `M33_MV_REFRESH_SUBSCRIPTIONS_DEFERRED` —
  a separate M33 composition-root task, not an M28 one. **The catalog entry's own comment records a second,
  producer-side gap the consumer-binding framing doesn't capture**: no worker anywhere transitions a bulk-
  export job to `completed`, because §2.3's async job processing is unbuilt — the same absence F-035
  records as why `$export`/`$everything` were dropped from `SERVED_RESOURCES`/the CapabilityStatement
  rather than left advertising an operation the gateway cannot perform. So even once M33 binds, the event
  has no live producer yet either; the catalog entry exists to pin the payload contract for when one does.
  Re-verified live against a fresh disposable Postgres (2026-09-27): `test:m28:outbox-catalog:live` (4/4),
  `test:m28:fhir-gateway:live` (9/9) and `test:rls:live:m28` (11/11) all pass unchanged since #205 landed.
