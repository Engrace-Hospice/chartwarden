# #248 outbox consumer builds (parallel-fork rounds)

> F-120 and F-150–F-171: building real bindings, verification catches, coordination hazards, and the running pair count. Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

**Five M11 catalogued signed events were computed and thrown away, and two of the two module boundaries
waiting on them are now bound (F-120, #248).** `packages/orders/src/catalog.ts`'s `downstreamSignedEvents`
has computed `hl7_orm_requested` / `supply_fulfillment_requested` / `level_of_care_change_signed` /
`recertification_signed` as a `transitionOrder` effect on every SIGN since the pure order machine
shipped — `orders-route-service-db.ts`'s `signInternal` called `transitionOrder` only for its guard/throw
and never read `.effects`, discarding all five. Two of the five catalog entries even asserted "M11 emits
the typed event today" for `supply_fulfillment_requested` and `hl7_orm_requested` — false, checked against
the actual write path rather than the comment, the F-119 shape again. A signed lab order never requested an
outbound HL7 ORM; a signed dme/supply/comfort_kit order never asked M21 to fulfill it; a signed
level-of-care-change/recertification order never told M6. **Fixed for the three kinds whose full
catalogued payload is derivable from data M11 already holds**: `emitDownstreamSignedEvent` builds each from
`order_record.data`, already validated at draft/request-signature time against the exact per-kind TypeBox
`packages/orders/src/kinds.ts` uses. `hl7_orm_requested` stays unbound — `OrmRequestedPayload` needs
patient demographics and a resolved M40 provider identity M11 does not hold, and M29's outbound ORM worker
is a from-scratch build (the pure wire builder, dispatch planner, ACK-correlation core, D9 retry/DLQ policy
and the operator list/retry routes all shipped at M29-T06/T08; the ingest sink that would call them is
still Wave H, per the module's own header). Writing the fix surfaced a second, independent defect:
`recertification`'s `periodEndDate` is `format: "date"` and `orders-typebox.ts` registered "uuid" and
"date-time" but never "date" — nine OTHER modules (M8/M9/M17/M19/M20/M23/M24/M27/M30/M35) register it
redundantly, so in the real app one of them always wins the race before a recertification is ever signed,
and the gap was invisible until a live test's narrower import graph hit it directly. Fixed with the same
idempotent `FormatRegistry.Has` guard the other nine already carry.
**M21's other two of the three `consumers/m11-orders.ts` deciders are now bound too** — the §7.7
cancellation cascade and the §2.2 DME monthly-rental close-out, both complete and unit-tested since
M21-T04, whose own file header said "the live outbox binding + the transactional insert land with the
§4.6 workers alongside the M21-T05 service layer": the service layer landed (`insertRequest`, D4 routing,
per-kind validation) and nothing was ever bound. Both consumed events were **already being emitted in
production** by the M11 discharge cascade (F-102) — every death/discharge on an admission with an open
`supply_request` has been cancelling the M11 order while leaving the DME rental or comfort-kit request
standing, the reciprocal of F-102's own finding one module downstream. `outbox-consumers/
m11-order-cascade.ts` runs the SAME `transitionSupplyRequest` + `runEffects` write path a route uses
(`patchSupplyRequest`, pulled out of `write-service-drizzle.ts`'s closure to module scope and exported, so
there is exactly one place that maps an `EffectPatch` onto the table — the F-100/F-103 "two write paths for
one table" lesson), with **no actor at all**: `routes/actor.ts`'s own doc comment says "the §4.5.1 inbound
cascades reach M21 through the outbox consumers, not through a route, and they attribute their rows to the
source event rather than to a human," and `writeActorOf` refuses a session with no membership — fabricating
one would misattribute a system cascade to a person who did nothing, on a DEA chain-of-custody-adjacent
table. **The THIRD decider, `decideSupplyFulfillmentIntake` (the §7.1 request that OPENS a `supply_request`
in the first place), stays unbound and is reported, not fixed**: its own IO resolver
(`consumers/order-context.ts`) already says why — "NO PLATFORM SEAM ANSWERS `resolveServingLocation`, and
that is a real gap rather than an oversight" — `supply_request.location_id` is NOT NULL and no fact (M2
Locations, M5 patient, M6 admission) says which Location serves a given patient. Binding it today would
mean either dead-lettering every delivery or inventing a Location-resolution heuristic the module's own
author explicitly declined to guess at, the `providerEntityFor` lesson one file over ("a guessed provider
entity is a mis-stated cost report") applied to Location instead. Proven live end to end over real
Postgres: `m11-downstream-signed-fanout.live.test.ts` (the real M11 write service signs each kind as
`wardenx_app`, asserts the exact catalogued payload, and confirms a signed lab order still emits neither
unbound event) and `m21-order-cascade.live.test.ts` (the real M6/M11 discharge cascade → the real
catalog-validating publisher → the real dispatcher → M21's two real consumers, under RLS: the pre-`ordered`
immediate cancel, the post-`ordered` two-phase `cancellation_pending`, `cancel_no_op` on an
already-terminal row, silent `no_match` when no request was ever opened, the monthly-rental completion via
a direct `discontinueOrder` call, and a one-shot kind correctly left alone). **Running total on #248: 509 →
419** declared-but-unbound pairs (this pass resolved the two `m21` entries; #248 remains open for the rest).

  **#248 shifted from catalog triage to building the first real binding — and the scoping investigation
  found genuinely different reasons three of the four candidate targets weren't buildable yet
  (F-150, #248).** Every declared-but-unbound pair in the registry had by now been individually verified
  at least once (25/25 groups carry an F-number from a real per-event check); the remaining 195 pairs are
  confirmed genuine, currently-unbuilt relationships, not catalog mistakes — so the next request was to
  start building them. M30's own `handlers-unbound` group (4 events) was the obvious first target:
  `packages/quality/src/consumers/handlers.ts` had shipped pure, port-injected and fully unit-tested since
  the package landed, with **no implementation of `M30ConsumerPorts` anywhere in this repository** —
  RULE 3(d)'s "the live inbound dispatcher is a later platform phase" had simply never come due. Checking
  each of the four before building found three different blockers, not one: `m10.hope.submission_accepted`
  needed only a payload widening (`providerEntityId` — the fact `enqueueRecompute` needs, absent from the
  catalog schema though `hope_submission.provider_entity_id` is NOT NULL and already on the row the emit
  site returns); `m23.claim.adjudicated` needed nothing at all, its real production emitter
  (`claim-state-service.ts`) already carries a complete payload; `m12.medication.error_reported` is
  genuinely blocked — its handler's `createIncidentDraft` needs a resolvable "M30 service membership" for
  `incident_report.reported_by_membership_id` (NOT NULL), and no system-actor-membership convention exists
  ANYWHERE in this codebase to attribute an auto-created draft to (the F-102 `actorMembershipId: NULL for
  system-actor cascades` carve-out does not apply here — this column has no such nullable escape); and
  `m18.evv.visit_verified`, checked while scoping this pass, turned out not to be an M30-side gap at all —
  M18's own `domain/event-lifecycle.ts` `recordEvent` pure decider declares the outbox effect, but the
  REAL production check-in/check-out write path (`evv-route-service-db.ts`) never calls that decider and
  emits its four other EVV events inline instead; `visit_verified` has never been published by any
  production code path, so binding an M30 consumer for it would wire a line to a house that was never
  built. **Bound the two that were genuinely ready.** `buildM30UpstreamConsumerPorts`
  (`apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts`) implements
  `enqueueRecompute` for real — per-measure-code FY-boundary period resolution
  (`resolvePeriodRule`/`resolvePeriodWindow`, mirroring `m30-jobs.ts`'s own private `resolveFyBoundary`,
  not exported) feeding the real `MeasureRecomputeQueueRepository.enqueue`, RLS-scoped via
  `withOrgContext` — while the other three `M30ConsumerPorts` methods stay LAZY fail-closed
  `unboundWorkerPort` thunks (the exact mechanism `m30-jobs.ts`'s own worker deps already use for the
  identical posture), never invoked by the two consumers this pass actually binds. **Deliberately did NOT
  half-bind `m6.discharge.death`**: its handler calls `createMortalityReviewDraft` (real, buildable) AND
  `addCahpsSampleCandidate` (blocked on the M1 envelope-DEK caregiver-contact encrypt PLUS a
  caregiver-contact fact the death event's payload does not carry — the identical gap `m30-jobs.ts`'s own
  `cahpsMonthlySample.samples.insertSampled` port already reports) in ONE invocation — binding it now
  would make the mortality-review insert throw and roll back on every single delivery because of the
  CAHPS half, which is worse than leaving it unbound entirely. `buildM30HopeSubmissionAcceptedConsumer`/
  `buildM30ClaimAdjudicatedConsumer` (`outbox-consumers/upstream-events.ts`) wire the two ready handlers
  into real `OutboxConsumerBinding`s, registered in the composition root's consumer array for the first
  time. **This is the first genuinely-bound relationship this registry has produced, not a catalog
  correction** — the two pairs are removed from `outbox-deferred-consumers.ts` outright (a live binding
  now reaches them), and the group's reason text is rewritten to state the two remaining events' two
  DIFFERENT blockers precisely rather than repeating the old blanket note. Net: **197 → 195** pairs (2
  bound). Verified: `bun run build`/`typecheck` clean, full non-live suite 654 files / 9589 tests green,
  `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 57 live bindings now cover 77 catalogued events,
  up from 55/75), a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable
  Postgres, and a new live suite (`m30-upstream-consumers.live.test.ts`, `test:m30:upstream-consumers:live`,
  wired into the CI `lifecycle-live` M30 job) proving both bindings for real: the correct `hope_derived`
  (the two HOPE-derived TFP measure codes) and `hci` (all eleven indicator + composite codes) measure sets enqueue with the
  right provider/org/triggering-event fields, a redelivery debounces onto the same pending row rather than
  duplicating it (the `uq_measure_recompute_pending` partial-unique), and cross-tenant isolation holds.
  Leaving #248 open — 195 pairs across 25 modules remain, one of which (`m12.medication.error_reported`)
  needs new platform infrastructure (a system-actor membership convention) and the rest need their own
  scoped builds the same way this pass scoped M30's.

**#248's second genuinely-bound relationship — M16's §2.6 / D6 M39 consent-revocation cascade — and the
build surfaced a real, previously-invisible decider/machine mismatch along the way (F-151, #248).**
`decideConsentRevocationCascade` (`lifecycle/cascades.ts`) has been a complete, pure, unit-tested decider
since M16-T03, and `bereavement_opt_out.source_kind`'s own schema comment already named the mechanism
this pass built: "when M39 emits `m39.consent.revoked` for a `bereavement_outreach_consent` record, M16
CASCADES (§2.6) — it does not gate-keep. M39 is the truth." Nothing had ever bound it — the pair sat in
the m16 `handlers-unbound` group F-134 had already scoped as "backed by a real pure decider." Scoping it
against M24's `handlers-unbound` group first (a parallel candidate with real, named pure handlers in
`consumers/handlers.ts`) found that group genuinely blocked on two DIFFERENT infrastructure gaps — no
claim-lifecycle write path exists to back `handleClaimPaid`/`handleClaimDenied`/`handleMedicarePrimaryAck`
at all, and `medicaid_claim.updatedByMembershipId`/`createdByMembershipId` are NOT NULL with no
system-actor escape hatch the way `order_discontinuation.actor_membership_id` has (F-102) — so M24 stays
deferred, its reason updated to name both blockers precisely rather than repeating the old blanket
"forward-declared, pending the relay" note. **M16's build, by contrast, had full precedent already sitting
in the codebase.** `bereavement_opt_out.recorded_by_user_id` and `bereavement_plan_closure.closed_by_user_id`
are both nullable with a documented system-write precedent in their own schema comments ("NULL when the
portal self-service path recorded it" / "NULL for the 13-month auto-close cron"), and `optOutContact`'s
existing HTTP-route implementation (`routes/write-service-drizzle.ts`, route 14) already accepts a
null-membership `M16MutatingActor` for the identical reason. The new consumer
(`outbox-consumers/m39-consent-revoked.ts`) mirrors that route's write exactly — the same
`transitionBereavedContact` machine call, the same effect-runner + `bereavement_opt_out` insert shape, the
same future-outreach cancellation — with `recordedByUserId: null` / `sourceKind: "m39_revocation_cascade"`
in place of a staff membership, the F-102 `CONSUMER_USER_ID` convention (`""` for `app.user_id`) F-150's
M30 consumer already established one module over. **Building it surfaced a narrow, latent bug nobody had
exercised**: `decideConsentRevocationCascade` returns `cascade_opt_out` for a contact whose status is
EITHER `active` OR `proposed`, but `BEREAVED_CONTACT_GRAPH` (`lifecycle/contact.ts`) accepts the `optOut`
event only from `active` — `proposed` accepts only `confirmContact`. The decider's own unit test
(`bereavement-lifecycle.test.ts`) exercises `active`/`opted_out`/`null`, never `proposed`, so this was
invisible until a real delivery against an unconfirmed contact was driven end to end. Not fixed here,
deliberately — whether an unconfirmed contact's consent revocation should be a no-op (matching
`opted_out`/`deceased`) or drive some other transition is a product decision this pass does not guess at,
the identical restraint F-150 applied to `m12.medication.error_reported`'s missing system-actor
convention. The consumer instead lets the machine's own typed `ILLEGAL_TRANSITION` throw and dead-letter
for a human, mirroring the "refuse rather than guess" posture `outbox-consumers/m6-bereavement-eligible.ts`
already takes on its own unresolvable death-fact cases — documented at the top of the new file rather than
silently swallowed, and proven as its own live-test case rather than left untested. Net: **195 → 194**
pairs (1 bound). Verified: `bun run build`/`typecheck` clean, full non-live suite 654 files / 9589 tests
green with no pinned-array assertions to update, `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 58
live bindings now cover 78 catalogued events, up from 57/77 — `arch:live-suites` required the new script
wired into the CI `lifecycle-live` M16 job before it would pass), a clean `check:boot:platform` run against
a freshly migrated, RLS-enforced disposable Postgres, and a new live suite
(`m16-consent-revoked.live.test.ts`, `test:m16:consent-revoked:live`) proving the binding for real: an
active contact cascades to `opted_out` with the correct `bereavement_opt_out` row and a cancelled future
outreach touchpoint, a redelivery against an already-opted-out contact is a true no-op (no second opt-out
row, `version` unchanged), a consent id no contact in the org tracks is a no-op, a `proposed` contact
throws the documented `ILLEGAL_TRANSITION`, and cross-tenant isolation holds. Leaving #248 open — 194
pairs across 25 modules remain.

**Five modules' `handlers-unbound` groups were investigated in parallel by five independent forks, each
independently re-verified against the actual code before being trusted, and 10 of the 24 events they
covered are now real, live-bound relationships (F-152, #248).** Per the user's explicit instruction to
scale this arc to parallel dispatch while guarding against mistakes, five forks each took one module
(M11, M5, M13, M17, M14), applying the same F-150/F-151 rigor — a real decider check, a schema
nullability/precedent check, an existing-route-to-mirror check, and a decider/machine graph
compatibility check — and reporting back BUILT (with files + wiring) or BLOCKED (with precise
file:line reasons) rather than guessing. **M5 — 1 of 9 built**: `m6.admission.activated` denormalizes
the activating admission's `provider_entity_id`/`location_id` onto `patient` (§3.3/ARCH-011, "nullable
until admission" — no write path had ever set either column), through M6's registered
`AdmissionStatusReader.getAdmissionSiting` seam, deliberately scoped to ONLY the `patient` row (cascading
onto the dozen-plus child tables carrying their own `provider_entity_id` is a separate, undecided
question). **M11 — 2 of 9 built**: `m9.assessment.significant_change` (the §2.7 D7 order-suggestion
banner, writing the `wardenx:m11:orders:suggestion:<patientId>` Valkey projection `suggestion-banner.ts`'s
own header had always named as the mechanism — a new dedicated `orderSuggestionRedisClient` connection,
mirroring `stepUpRedisClient`'s shape, since this is a distinct concern from every existing Redis client
in the composition root) and `m21.supply_request.status_changed` (the D8 one-shot `supply`/`comfort_kit`
auto-complete on `toStatus='delivered'`, `dme` deliberately excluded — it closes out via the separate
monthly-rental path F-120 already bound). **M13 — 4 of 8 built, via one consumer**: `m6.admission
.activated`/`.transfer.created`/`.discharge.created`/`.cti.signed` all open the §2.8 D17
medication-reconciliation worksheet through the real `decideReconciliationTrigger`/
`buildReconciliationWorksheet` cores, resolving admission siting via M6's org-explicit
`admissionSchedulingContextForOrg` seam (M13's `dependsOn` has no edge to 6). **Independently verifying
this build (not merely trusting the fork's report) found a real gap the fork's own type had introduced**:
`AdmissionAnchor.providerEntityId` was declared non-null while the source `admission.provider_entity_id`
column is nullable (ARCH-011) exactly like `locationId` already was in the same interface — widened to
match and given the identical "refuse rather than fabricate" throw
(`medication_reconciliation_worksheet.provider_entity_id` is NOT NULL and this path had never been
exercised), rather than silently coercing past a real compile error at the central-wiring step, which is
what the verification pass was for. **M17 — 3 of 12 built**: `m18.evv.check_in_recorded`
(`published → en_route`) and `m18.evv.at_patient_address` (`en_route → in_visit`) — both named explicitly
by `transitionVisit`'s own `VisitAdvanceSource: {via:"evv"}` doc comment as the D14 EVV-authoritative
advances the spec calls the visit lifecycle's authoritative driver, unwired despite that — and
`m20.safety.visit_cancellation_requested` (M20's own catalog: "M20 never writes an M17 row — this event
IS the request and M17's D3 handler decides"), using the established `M17_SYSTEM_USER_ID` sentinel since
`m17.visit.cancelled`'s payload requires a non-empty `cancelledBy` string. Building it surfaced two
un-acted-on findings on the remaining M17 group: `m18.evv.check_out_recorded`'s own catalog DESCRIPTION
claims it drives `in_visit → completed`, contradicted by `visit-machine.ts`'s hard `isSystemActor` guard
restricting that transition to `m8.encounter.signed` alone; and `m18.evv.event_corrected`'s description
reads as the same seam-pull shape F-140 already dropped on the M8 side of the identical event. **M14 — 0
of 14 built, correctly**: the group's own header already named the real blocker (a whole unbuilt
Valkey-backed per-patient "since last IDG" projection cache with no client, decider, or cache-key scheme
anywhere in the repo) and the fork's read-only investigation confirmed it rather than forcing a partial
bind. **Net on #248: 194 → 184** (10 bound: M5 ×1, M11 ×2, M13 ×4, M17 ×3). Each group's registry reason
was rewritten to state its own remaining blockers precisely (M11's D8/D7 finding is documented in its own
group text now, not repeated here), and each affected module's own hand-maintained subscription-list
constant (`M11_OUTBOX_SUBSCRIPTIONS`, `M17_OUTBOX_SUBSCRIPTIONS`) was updated to agree — `arch:outbox-
bindings` caught the disagreement immediately (rule 6) until both were corrected in the same change.
**A second, unrelated defect was fixed in the same round, at the user's follow-up request**: the four
pre-existing `verbalOrder` TypeScript errors in `11-orders/routes/service.ts` — flagged as out-of-scope
in every prior round back to the "New order creation" commit that introduced them — were a genuine,
material gap, not a cosmetic type mismatch. `OrderDetailView.verbalOrder` (the read-back attestation
evidence CMS requires for a verbal order) had been added to the type without ever being populated by the
in-memory order backend (`createInMemoryOrderBackend`, used by unit tests and dev seeds): `createVerbalOrder`
and `recordVerbal` both captured, validated (`readBackVerified` must be true, attestation ≥100 chars) and
then DISCARDED the actual evidence — nothing on `OrderRecord` ever stored it, so a verbal order's legal
record existed only transiently in the request args. Fixed by mirroring the production Drizzle backend
(`orders-route-service-db.ts`'s real `verbal_orders` table + `toOrderDetailView`'s exact re-add shape)
exactly: `OrderRecord` now carries the real evidence at both capture sites, `detailView()` forwards it
explicitly (the same reason production's `toOrderDetailView` does — `view()`'s declared return type omits
it even though the destructure leaves it on the runtime object), `recordVerbal` gained the
`readBackVerified` guard production has always had and the in-memory version was missing entirely, `sign`
now advances a verbal order's own status/`signedAt` on completion, and `regenerateVerbalTimer` keeps the
nested projection's `deadlineAt` in sync with the flat column rather than only updating one of the two.
Verified: `bun run build`/`typecheck` fully clean (0 errors, the first time in this series), full non-live
suite green except 12 pre-existing, unrelated frontend DOM test failures (confirmed via `git stash` to
predate this round entirely — `encounter-authoring`/`admission-detail`/`hope-admission-workspace`, none
touching M5/M11/M13/M14/M17 or order verbal-evidence code), `arch:fitness` 38/38 (`arch:outbox-bindings`
0 disagreements both directions after the two subscription-list corrections), a clean `check:boot:platform`
run against a freshly migrated, RLS-enforced disposable Postgres, and all four new live suites
(`test:m5:admission-siting:live` 4/4, `test:m11:m9-m21-consumers:live` 11/11 against real Postgres+Valkey,
`test:m13:reconciliation-triggers:live` 5/5 — proving the `providerEntityId` fix under real RLS — and
`test:m17:evv-sos-consumers:live` 4/4) run individually against the same disposable database. Leaving
#248 open — 184 pairs across 25 modules remain.

**Five modules' `handlers-unbound` groups (M25, M18, M21, M16, M23) were dispatched to five parallel forks
a second time, each independently re-verified against the actual code before being trusted or applied, and
11 of the round's 24 candidate events are now real, live-bound relationships — with two of the five forks'
own claims corrected by that verification before anything was built (F-153, #248).** Per the user's
explicit "dispatch 5 subagents at a time... but make sure to verify their work" instruction, each fork took
one module and reported BUILT (with isolated new files) or BLOCKED (with precise reasons) rather than
forcing an incorrect bind; the coordinator then independently re-read every claimed decider, schema
constraint, and catalog declaration against the real source before applying anything centrally.
**M25 — 0 built, correctly.** The fork reported BLOCKED on `m23.claim.rejected`/`m18.evv.aggregator_rejected`
and both claims were verified true against the schema, not merely trusted: `denial_case` carries no unique
index on either idempotency key shape `handlers.ts`'s own header promises ("the store enforces the
dedupe"), and `DenialSeedStore.seedDenial`'s declared input has no `taxonomyStatus` field while the column
is NOT NULL with no default and the only real writer derives it via M38 CARC-category resolution — binding
either now would mean a race-prone insert or a fabricated column value. The group's reason text is rewritten
to state both schema gaps precisely rather than repeating "same posture as M26/M27," which undersold it —
M26/M27 wait on a store bind, this waits on new schema. **M18 — 2 of 2 built, group fully resolved and
deleted.** `m17.visit.cancelled` (cancels non-terminal aggregator submissions + voids open missing-resolution
rows, D7/§2.2.4) and `m8.encounter.signed` (auto-closes or creates-already-closed a missing-EVV resolution
off the encounter's own documented reason, D6) are both live in `outbox-consumers/`. Verification confirmed
both catalog declarations were already in place from F-141/F-146 (no catalog edit needed), that
`detected_by_source`'s schema comment already names `'encounter_signed_consumer'` as a real enumerated
value, and that `evv_missing_resolution_open_uidx` is a PARTIAL unique index (`WHERE status='open'`) so the
create-already-closed insert path never collides with it. **M21 — 2 of 7 built, 1 corrected from unbound to
misdeclared, 4 remain genuinely blocked or unattempted.** `m13.comfort_kit.deployed` (§2.5 deployment-ack,
resolved by patient+admission since the ack's whole point is that the deploymentId link doesn't exist yet)
and `.return_required` (§2.6 chain-of-custody open) are live in `outbox-consumers/m13-comfort-kit-cascade.ts`
— both catalog declarations were already present (confirmed by direct read of `events-by-m13.ts`).
`m11.order.signed` is **removed from the catalog outright, not bound**: the fork found it redundant with
the co-emitted, more specific `m11.order.supply_fulfillment_requested` sibling (same
`emitDownstreamSignedEvent` transaction) — verified true by reading `orders-route-service-db.ts` directly
(line 566 emits `.signed`, line 601 in the same function calls `emitDownstreamSignedEvent`, which emits
`.supply_fulfillment_requested` at line 512) — the F-117/F-101 co-emission shape a module over. Both M21's
own `M21_SUBSCRIBED_EVENT_NAMES` mirror and `events-by-m11.ts`'s `declaredConsumers` were corrected to
match. **M16 — 1 of 5 built.** `m6.admission.discharged` (filtered to `reason='death'`, the §4.5 "secondary
verifier" against M6 failing to emit `m6.bereavement.eligible`) re-runs the identical §4.3.1 intake decider
a second time off a different source event. **Verification caught the fork's own claim wrong here**: its
report said the catalog "does not yet declare `m16`" and its live test built a synthetic in-memory catalog
patch to work around the gap — direct inspection of `events-by-m6.ts` found `m16` already sitting in
`m6.admission.discharged`'s `declaredConsumers` (a kept pair from F-134, never dropped), so no catalog edit
was needed at all and the test's synthetic patch was deleted in favor of the real `M6_OUTBOX_EVENTS` before
being trusted — the exact mistake the user's "verify to avoid mistakes" instruction exists to catch, on the
build side rather than the blocked side this time. **M23 — 6 of 8 built, the round's largest single bind.**
`m6.cti.signed`, `m6.f2f.attested`, `m6.loc.changed`, `m6.election.period_ended`, `m8.encounter.cosigned`,
and `m5.patient.deceased` (its `revalidate` effect only — `freeze_new_claims` stays unbuilt, no column or
table anywhere backs it, confirmed only a `vi.fn()` mock exists) now each enqueue onto the ALREADY-RUNNING
`revalidate.consumer` BullMQ worker (`runRevalidateConsumer`, registered since the launch-worker set landed,
that nothing had ever added a job to) via `outbox-consumers/m23-revalidate-triggers.ts`, and the worker's own
`RevalidationTargetResolverPort` — fail-closed-unbound at boot — is now real
(`buildDrizzleRevalidationTargetResolver`, a new `ClaimRepository.listRevalidationTargets` matching every
VALIDATING/READY claim by the event's `patientId`/`admissionId` exact match or `encounterId` jsonb
containment on `claim_line.backing_encounter_ids`), independently verified field-by-field against each
event's real catalogued payload rather than assumed from the fork's report. Every one of the six payload
shapes was confirmed by direct read: `m6.cti.signed`/`.f2f.attested`/`m5.patient.deceased` carry `patientId`,
`m6.loc.changed`/`.election.period_ended` carry `admissionId`, `m8.encounter.cosigned` carries only
`encounterId`. `m18.evv.late_check_resolved` and `m25.taxonomy.unmapped_code_observed` stay genuinely
blocked — the first needs a reverse of F-123's `encounterVisitIdsForOrg` M23 has no port for, the second
needs a whole new validation-rule-suggestion mechanism. **A gate-breaking defect surfaced applying M23's
build, found only because the coordinator ran `arch:fitness` rather than trusting the fork's "clean"
report**: the fork's exported `buildM23RevalidateTriggerConsumer(eventName, deps)` took the event name as a
runtime parameter, which crashes `check-outbox-bindings.ts`'s discovery probe — it calls every
`build*Consumer(s)`-named export with an absorbing Proxy stub, and the stub's `Symbol.toPrimitive` returning
itself (not a primitive) threw the instant the function tried to interpolate `` `m23.revalidate-trigger.
${eventName}` ``. No other binding factory in the codebase takes a runtime discriminator as a positional
argument — each hardcodes its `consumerName`/`eventTypes` as compile-time constants instead — so this was a
novel shape the gate had never had to handle. Fixed by renaming the per-event factory to
`buildM23RevalidateTriggerConsumerFor` (outside the gate's `^build[A-Za-z0-9]*Consumers?$` discovery regex)
while the plural `buildM23RevalidateTriggerConsumers` — which the gate DOES evaluate, safely, since it loops
over the real string-literal event array internally rather than taking one from the caller — stays the
composition root's actual entry point. **Net: 184 → 172** (11 bound, 1 dropped as misdeclared, 0 added; 25 →
24 modules, M18's group fully resolved). Verified centrally, once, after all five forks' edits landed
together: `bun run build`/`typecheck` clean (0 errors), full non-live suite 654 files / 9592 tests green (one
pinned-array assertion updated — `orders-outbox-consumers.test.ts`'s `m11.order.signed` fan-out, to drop
`m21`), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements both directions — one gate-breaking
crash fixed along the way, two rule-6 subscription-list corrections needed:
`M21_SUBSCRIBED_EVENT_NAMES` to drop `m11.order.signed`, M23's own dead `M23_OUTBOX_SUBSCRIPTIONS` map to
add `m6.election.period_ended`), a clean `check:boot:platform` run against a freshly migrated,
RLS-enforced disposable Postgres (dropped and rebuilt from all 270 migrations to rule out stale local
state), and all four new live suites run individually against the same disposable Postgres + a disposable
Valkey (`test:m18:visit-cancelled-encounter-signed:live` 6/6, `test:m21:comfort-kit-cascade:live` 7/7,
`test:m16:discharge-death-secondary:live` 5/5, `test:m23:revalidate-triggers:live` 6/6), alongside seven
pre-existing sibling live suites re-run unchanged to confirm no regression (`m18:read`/`write`,
`m21:order-cascade`, `m16:bereavement-intake`/`consent-revoked`, `m23:noe-draft`/`notr-draft`,
`m23:claim-assembly-seams`) — one pre-existing, unrelated failure found and confirmed via `git stash` to
predate this round entirely (`gap-037-m23-remittance-feedback.live.test.ts`, 2/8 cases, an `m25.remittance
.claim_paid` pending-row-count assertion untouched by anything this round built). Leaving #248 open — 172
pairs across 24 modules remain.

**A fifth parallel round (M6, M12, M13, M19, M24) built one real binding and corrected one real
misdeclaration — the smallest yield of the series so far, and evidence the easy pairs are running out
(F-155, #248).** Per the same "5 forks, verify before applying" discipline, each fork investigated one
module's `handlers-unbound` group and reported BUILT or BLOCKED; the coordinator independently
re-verified every claim (schema columns, enum values, `dependsOn` edges, seam signatures) before
applying anything. **M13 — 1 of 7 built.** `m6.admission.discharged` (`m13.admission-discharged-cascade`,
`outbox-consumers/m6-admission-discharged-cascade.ts`) is the §2.5/§2.7 D14 cascade: cancels every
future pending `scheduled_dose` (never retro-marks a past one — the missed-dose sweep owns those) and
flags every still-`deployed` comfort-kit deployment for return, via the pure, already-shipped
`planDischargeCascade` (`@wardenx/emar`) fed by the same org-explicit `admissionSchedulingContextForOrg`
seam F-152's reconciliation-trigger consumer established for this exact module boundary. Neither target
table carries a `version` column, so idempotency under redelivery is enforced by conditioning each
UPDATE's `WHERE` on the same state predicate the SELECT used, not on id alone — verified directly against
the schema (`scheduled_dose.status`, `comfort_kit_deployment.disposal_status`/`return_required_at`) rather
than trusted from the fork's report. **The remaining 6 M13 pairs stay genuinely blocked, precisely
rescoped rather than merely re-asserted**: `m12.medication_order.active`/`.discontinued` need three
cross-module facts with no seam surface for any of them (M12's order DTO carries no tenancy columns, no
location→timezone resolution exists for DST-exact dose slots, and `.discontinued` has no order-level
cancellation decider anywhere in M13); `m21.comfort_kit.deployed_at_patient`/`.replenished` are
payload-blocked (the real emitted `dispatchedContent.medicationOrderId` is nullable while the target
column is NOT NULL); `m21.comfort_kit.returned` is a genuine M21 producer-side defect — M21 emits this
SAME event name at TWO different lifecycle points (return requested vs. return reconciled), and binding
M13's `applyKitReturn` to it would flip `disposal_status='returned'` before the kit is physically
returned; `.return_reconciliation` depends on that ambiguity being resolved first. **M6 — 0 of 4 built,
but the verification pass corrected the group's own prior framing.** F-143 had called
`m23.noe.accepted`/`m23.notr.accepted` "decisive, ready" subscriptions on M23's own "Done means" prose;
checked against the actual mechanism rather than the description, both are MISDECLARED, not merely
unbound — no `compliance_window_kind` enum value, table, or column anywhere in M6's schema references
NOE/NOTR at all, M6's own `dependsOn` excludes 23 (so it has no seam to resolve which admission's window
to touch even if a mechanism existed), and "closing the window" is already a side effect of the SAME
transition on the M23 side alone (`NoeRepository.listWindowWatchCandidates` filters
`notInArray(N.state, NOE_TERMINAL_DB)`, so an accepted row self-excludes from every future watchdog scan
with no cross-module handshake needed). Both dropped from `events-by-m23.ts`'s `declaredConsumers` at the
source — the F-101/F-131 shape in the opposite direction from usual: a prior pass's own "kept, decisive"
call, overturned by checking the mechanism instead of trusting the cross-referenced prose.
`m11.order.level_of_care_change_signed`/`.recertification_signed` remain genuinely blocked: real,
self-contained write paths exist (`changeLoc`/`createElectionPeriod`, both already consumer-safe), but
neither `level_of_care_period` nor `election_period` carries a column linking a row back to the
triggering M11 order, and a genuine redelivery (the dispatcher retries up to `maxAttempts=8`) would
silently open a second/third LOC period or benefit period — needs a schema migration (a
`source_order_id` column + unique index), not an isolated-file fix. **M12, M19, M24 — 0 of 16 built,
each blocked on missing infrastructure tiers rather than a binding gap.** M12's 6 `sync-triggers.ts`
events need a whole BullMQ worker tier that does not exist anywhere in the module (no `jobs/` directory,
no `Queue`/`Worker` construction, and the two "jobId" values the route service returns today are
hardcoded template strings, not real `.add()` results); `m11.order.verbal_expired_unsigned` has no
producer anywhere (the pure 48h-deadline check has zero callers) AND the real catalogued payload has no
`targetKind` field the decider needs to discriminate on. M19's sole candidate
(`m17.visit.assigned` shift-sync) needs a `jobs/` directory that doesn't exist plus a genuine design
decision — no existing pattern in this codebase does a true reset-the-delay-on-each-trigger BullMQ
debounce, and the closest precedent (M30's F-150 `enqueueRecompute`) is a different, DB-dedupe mechanism.
M24's 6 events all route through an `M24ConsumerStore` interface with zero implementations anywhere
(only an in-memory no-op stub) and 4 of the 6 need a `medicaid-revalidate` BullMQ worker that was never
built — unlike M23's F-153 build, where the worker already existed and only needed a producer, here
neither the store nor the worker exists; a real financial-state-transition write shape needing product
sign-off, not guessed at. Net: **172 → 169** (1 bound, 2 dropped as misdeclared, 0 added; module count
unchanged at 24). Verified: `bun run build`/`typecheck` clean (0 errors), full non-live suite 654 files /
9592 tests green with no pinned-array assertions to update, `arch:fitness` 38/38
(`arch:outbox-bindings` confirms 169 declared-but-unbound pairs, down from 172, and 77 live bindings
now covering 88 catalogued events), a clean `check:boot:platform` run against a freshly migrated,
RLS-enforced disposable Postgres, and the new live suite (`m13-admission-discharged-cascade.live.test.ts`,
`test:m13:admission-discharged-cascade:live`, wired into the CI `lifecycle-live` M13 job) run individually
(5/5), alongside four sibling live suites re-run to confirm no regression from the catalog edits
(`m13:reconciliation-triggers` 5/5, `m16:discharge-death-secondary` 5/5, `m23:noe-draft` 8/8,
`m23:notr-draft` 8/8, `m6:discharge-cascade` 6/6). Leaving #248 open — 169 pairs across 24 modules remain.

**F-155's own M13 build shipped with a real wiring gap this round's re-verification caught before it
could ship a second time, and M1's `system_status` group turned out to be a much deeper misread than "not
wired yet" (F-156, #248).** Re-checking F-155's own commit before starting new work — a habit this pass
adopted specifically because the "verify to avoid mistakes" instruction applies to this agent's own prior
output, not only to forked subagents' claims — found `buildM13AdmissionDischargedCascadeConsumer` was
built, unit-proven live, and passed `check:boot:platform`/`arch:outbox-bindings` clean, but was **never
added to `apps/backend/src/index.ts`'s `consumers` array**. Both of those green gates are proxies, not the
real thing: `check-outbox-bindings.ts` discovers a "live binding" by statically importing every
`consumerModule:`/`eventTypes:` source file and calling the exported `build…Consumer` factory with an
absorbing stub — it never reads the composition root — and `check:boot:platform` only proves the server
boots without throwing, not that every catalogued relationship is actually satisfied at runtime. A
consumer built, tested, and passing every static gate can still be completely unreachable in production if
the one line wiring it into the real dispatcher is missing — invisible to every check this arc has run
except a direct `grep` for the factory name in `index.ts`, which is now a standing step in this arc's own
verification checklist. Fixed by adding the import + construction call (mirroring
`buildM13ReconciliationTriggerConsumer`'s own `admissionSchedulingContextForOrg` template immediately
above it). A repo-wide sweep for every other `export function build*Consumer` not referenced by name in
`index.ts` found two more candidates, both false positives on inspection rather than the same bug twice:
`buildM30BillingConsumer` is a seam adapter (`QualityBillingConsumer`, called internally by
`consumed-seam-adapters.ts`, never an outbox `handle(event)` shape) and `buildSosDeliveryFailureConsumer`
is wired through M20's own aggregating `buildFieldSafetyConsumers()`, spread into the composition root's
array rather than named directly — both correctly reachable, just not by a naive grep. **The M1
`system_status` group's F-141 characterization — "a real, built mechanism that only lacks its automatic-
consumer wiring" — was true about the mechanism EXISTING and false about it being LIVE.**
`SystemStatusReader`'s interface (`bootstrap/routes/system.ts`) is ORG-scoped by signature
(`upsert(orgId, component)`); the real Drizzle `system_status` table
(`packages/db/src/schema/system-status.ts`) has no `organization_id` column at all — genuinely
platform-global, its own header comment says so — and no Drizzle-backed reader implementation exists
anywhere in the repository. The composition root never overrides the boot default, so every deployment has
always run on `createInMemorySystemStatusReader()`: a per-process `Map` that resets on every restart and
cannot be shared across horizontally-scaled instances. `POST /admin/system/status` has never once
persisted a status flip to the real table, in any environment — a defect this pass found by checking the
mechanism rather than trusting the cross-module agreement on its existence, the F-119/F-136 shape (three
producing modules independently repeating the same claim is stronger evidence than one, but still not a
substitute for reading the code). **2 of 6 built anyway, on a NEW write path that bypasses the broken
reader entirely.** `m33.lag.exceeded`/`.recovered` have a real, already-existing emission
(`m33-jobs.ts`'s `lagProbe.outbox`, `organizationId: null` — the documented GAP-099 platform-singleton
pattern), and the dispatcher's separate `pollPlatform()`/`platformConsumers` binding path was already
proven live by M40's NPPES appliers (`buildM29NppesPlatformConsumers`) — this pass's own first-draft file
header claimed to be the FIRST live `platformConsumers` entry, caught and corrected by reading
`apps/backend/src/index.ts` directly before trusting the draft comment. `buildM1LagProbeStatusConsumer`
(`bootstrap/outbox-consumers/m33-lag-probe.ts`) writes the real `system_status` table directly via
Drizzle — no RLS on the table, so no `withOrgContext` needed — flipping the shared `database_replication`
component `degraded` on `.exceeded` and `operational` on `.recovered`; idempotency needs no version check
beyond `ON CONFLICT DO UPDATE`, since the platform receipt table already dedupes a redelivery of the same
event before `handle()` is ever called. **4 of 6 stay genuinely blocked, and two of them are a sharper
finding than "not wired" — the event is never published to the outbox at all.**
`m23.mac_portal.unavailable`/`.recovered`: `runMacPortalHealth` (`m23-jobs.ts`) calls only
`alerts.dispatch()` (M36's `WorkerAlertPort` seam), never `outbox.publish()` — and that alert path is
itself unbound at the composition root (`deps.alerts` is never passed to `buildM23WorkerDeps`, so every
dispatch call throws `unboundWorkerPort`), so binding an M1 consumer to either event name would wire a
line to a house that was never built, the F-150 `m18.evv.visit_verified` shape a module over.
`m24.medicaid_state_channel.unavailable`/`.recovered` have no emit site anywhere in the codebase at all —
a from-scratch state-channel health cron, mirroring M23's own (itself broken) pattern, not attempted here.
Net: **169 → 167** (2 bound, 0 dropped, 0 added; module count unchanged at 24). Verified: `bun run
build`/`typecheck` clean (0 errors), full non-live suite 654 files / 9592 tests green (two pinned-array
assertions caught and fixed mid-pass — `check-live-suite-coverage.test.ts`/`fitness-gates.test.ts` both
failed on the first `arch:fitness` run for a missing CI matrix row on the new M1 live suite, fixed before
re-running), `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 167 pairs, down from 169, and 78 live
bindings now covering 90 catalogued events), a clean `check:boot:platform` run against a freshly migrated,
RLS-enforced disposable Postgres (with the M13 wiring fix included, proving the discharge cascade is now
actually reachable), and both new live suites run individually (`m13:admission-discharged-cascade` 5/5,
`m1:lag-probe-status` 3/3) alongside two sibling live suites re-run for regression on the
`platformConsumers` array change (`m1:platform-outbox` 11/11, `m1:outbox-dispatcher` 8/8). Leaving #248
open — 167 pairs across 24 modules remain.

**This round surfaced a genuine coordination hazard in the dispatch mechanism itself, not just in the
target code (F-158, #248).** A dynamic-loop wakeup cycle plus an intervening context compaction meant the
coordinator lost direct memory of having already dispatched three general-purpose agents (for M25's
`handlers-unbound` group and — separately, still unidentified by author at discovery time — M2's and
M37's `no-consumer-surface` events) alongside the M1/M2/M29/M35/M37 investigation forks this pass's own
visible history shows being freshly dispatched for the same targets. The result: several hundred lines of
real, carefully-reasoned, already-complete code sat uncommitted in the working tree with no record of who
built it, at the same time a fresh fork was independently re-investigating two of the same five events
and reporting them BLOCKED. Applying either side blind would have been wrong — discarding working code
because a fresh investigation didn't know it existed, or trusting unattributed code because it compiled.
**Resolved by verifying, not by trusting either signal alone**: a dedicated audit fork re-derived the
correctness of every uncommitted file against the actual schema/spec (not against either party's claims),
`SendMessage` to the still-running M25 agent got a first-party status report and confirmed which files
were and weren't its own, and the M2/M37 forks' BLOCKED verdicts were reconciled — not contradicted — by
reading the actual uncommitted code: it solved the exact problems those forks found by **scoping down**
(M2's consumer only handles the one `portal_access` consent type where the over-termination risk the fork
flagged doesn't apply, honestly deferring `family_caregiver_access`) or by **sidestepping** (M37's
consumer calls the pure `transitionAdmission` machine directly rather than the HTTP route's
physical-disposition schema, so the reason-vocabulary mismatch the fork found in the route layer never
applies to a path that never goes through it). One real defect surfaced independent of any of this: the
M25 agent's own new live suite — written honestly, self-flagged as never run live because its environment
had no disposable Postgres, only the shared dev-stack container its own reset-schema step would have
destroyed — had two test-fixture bugs once finally run against a real throwaway database: four `seedClaim`
calls reused the same patient/service-date range and collided on the real
`claim_active_by_range_uq` partial unique index (fixed by giving each call its own service period), and
one assertion expected a single `m25.denial.opened` event where the fixture's own default CARC ("16",
unmapped in the test's fake terminology) honestly also fires `m25.taxonomy.unmapped_code_observed` — both
test-authoring bugs, not production defects; the production consumer was doing the documented right thing
in both cases. **Net across the round: M17's `handlers-unbound` group built 2 more**
(`m18.evv.check_out_recorded` — narrower than the catalog's own stale description, stamping the
`visit.evv_check_out_event_id` pointer only, never driving the `complete` transition the `isSystemActor`
guard reserves for `m8.encounter.signed`; `m18.evv.event_corrected` — real, unlike M8's F-140 seam-pull
drop of the same event name, because M17 has no bracket-resolution seam of its own and caches EVV facts
only by push) and dropped 2 as misdeclared (`m39.consent.delegated_access.granted`/`.revoked` — M17's own
spec is decisive twice over that portal-caregiver access is a live M31 ABAC seam pull, never a push to
M17, and its manifest excludes 39). **M2's `no-consumer-surface` group is now fully resolved and
deleted**: `m39.consent.revoked` is bound for the `portal_access` scope. **M37's `no-consumer-surface`
group built its first-ever outbox consumer**: `m6.admission.discharged` reuses the pure
`transitionAdmission` machine, no-ops on death (reserved for the separate `m6-discharge-death.ts` path),
and lets a non-`active` IPU state throw and dead-letter rather than guessing — `m19.triage_call
.gip_admission_proposed` stays genuinely blocked (M37's own §4.5 table never actually names it, only
narrative prose does, and no schema exists to write a proposal to regardless). **M25's `handlers-unbound`
group is now fully resolved and deleted**: `m23.claim.rejected`/`m18.evv.aggregator_rejected` are both
bound, with the two real schema gaps F-153 found actually fixed (migration 0249's unique index; a widened
`seedDenial` port resolving `taxonomyStatus` via the existing `effectiveCategory` mechanism) plus a third,
previously undocumented blocker — neither payload carries `providerEntityId` — resolved per event (a
direct `@wardenx/billing` read for M23, since M25's `dependsOn` includes 23; M17's `VisitReader` seam
wrapped in `runWithRequestContext` for M18, the same F-118 fix `19-oncall`/`20-field-safety` already apply
for the identical dependency shape). **M29 and M35 stay fully blocked**, both freshly re-investigated and
found to need real new platform infrastructure rather than a wiring fix: M29's entire HL7 pipeline has no
T08 worker anywhere (the pure wire builder and dispatch planner exist, unit-tested, with zero production
callers); M35's four candidates need a KMS/envelope-DEK provider that exists nowhere on this platform (the
`PseudonymKeyProvider.activeKey()` gap this document's F-030 section already names for a different
consumer), and the other two need either an undecided product question (trial-subscription creation) or a
reused mechanism with wrong actor attribution and no real Stripe dispatch. Net: **167 → 159** (6 bound, 2
dropped as misdeclared, 0 added; 24 → 22 modules, M2 and M25 fully resolved). Verified: `bun run
build`/`typecheck` clean (0 errors), full non-live suite 654 files / 9593 tests green (two pinned-array
assertions caught and fixed — `check-live-suite-coverage.test.ts`/`fitness-gates.test.ts`, for the missing
M25 `package.json` script and CI row), `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 159 pairs,
down from 167, and 84 live bindings now covering 93 catalogued events), a clean `check:boot:platform` run
against a freshly migrated, RLS-enforced disposable Postgres, all four new live suites run individually
after the two test-fixture fixes (`m2:consent-revoked` 7/7, `m17:evv-checkout-corrected` 5/5,
`m37:admission-discharged-cascade` 8/8, `m25:denial-seed-consumers` 9/9), and thirteen sibling live suites
re-run for regression on the touched shared files (`m17:evv-sos-consumers` 4/4, `m17:write` 21/21,
`m18:read` 4/4, `m18:write` 16/16, `m18:visit-cancelled-encounter-signed` 6/6, `m25:835-ingestion` 9/9,
`m25:interim-payments-seam` 1/1, `m2:pre-org-picker` 4/4, `m2:organization-lifecycle` 5/5, `m37:write`
12/12, `m37:privacy-gates` 16/16, `m37:coverage` 9/9, `m39:consent-lifecycle` 4/4). Leaving #248 open —
159 pairs across 22 modules remain.

**A fifth round of parallel forks built 3 more bindings and, verifying them, surfaced a real, pre-existing
production scoring defect that predates every fork in this series (F-159, #248).** Five forks re-investigated
M23's 2 remaining events, M6's 2, M16's 4, M13's 6, and M1's 4 — all previously scoped as blocked by
F-153/F-155/F-156. **M6 built the first of its two**: `m11.order.level_of_care_change_signed` is now a live
consumer (migration 0250 adds `level_of_care_period.source_order_id` + a plain unique constraint, the
migration-0249 NULLS-DISTINCT precedent), calling the same pure `transitionLevelOfCare` machine `changeLoc`
calls directly rather than the route-shaped function itself. It honestly refuses IRC/GIP-directed orders
(the catalogued payload carries no `facilityId`/`clinicalJustification`, both required by the machine's own
guard) rather than fabricating either fact — RHC/CHC, which need neither, succeed. `m11.order
.recertification_signed` stays blocked, and the fork found the real reason is deeper than "needs an
idempotency column": M11's own locked spec requires M6 to validate F2F-window and CTI-narrative adequacy
before sequencing the next benefit period, and no callable function anywhere performs either check —
wiring straight to `createElectionPeriod` would bypass the exact CoP-compliance gate D10 exists to enforce.
**M16 built 2 of its 4**: `m39.consent.signed` (the §4.5 post-death-grant handler, confirming proposed
contacts) and `m5.patient.bereavement_opt_out_changed` (the §2.6/D9 patient-level cascade) are both live;
`m37.ipu_admission.death_recorded` and `m6.discharge.cosigned` stay blocked, the first because it has NO
PRODUCER anywhere in the codebase (`transitionAdmission(..., {type:"recordDeath"})` is called nowhere
outside its own unit test — and would be redundant even if built, since M16 already receives every IPU
death through two already-bound M6 paths), the second because the real catalogued payload is a completely
different event (M6's route-40 for-cause discharge cosign) from what the decider needs.
**Independently re-verifying the M16 build — not trusting the fork's own report — found a real, pre-existing
production bug it had faithfully copied rather than introduced**: `BereavementRosterEvidence`'s real fields
are `isPrimaryCaregiver`/`enrolledSurvivorCount`, and both the new consumer AND the already-shipped private
`appendScore` (`routes/write-service-drizzle.ts`, the function being reimplemented) were constructing
`{activeContactCount, relationshipCode}` under an `as never` cast — so `deriveRiskFactors` read `undefined`
for both fields on every score ever appended through the real HTTP route, always resolving
`primaryCaregiverRole` as a definite non-caregiver (never falling back to the MSW-derived value its own
`!== null` check exists to permit) and always resolving the roster half of `socialIsolation` as `false`
(`undefined < number` is always false in JS). Fixed in both places: `enrolledSurvivorCount` is the same
already-computed roster count under its correct name, `isPrimaryCaregiver` is honestly `null` (no bound seam
resolves M5's `patient_caregiver.is_primary`, the extract.ts header's own "KNOWN GAP" pattern) rather than
guessed, and the `as never` cast is gone — the object now genuinely satisfies the real interface.
**Running the new live suite for the first time found a second bug, this one inside the new consumer
itself, not inherited**: `skipPerPatientOptOut` (the D9 pre-death opt-out) transitions a plan straight from
`eligible`/`initiating` to `closed_completed` without ever running `seedRosterAndSchedule` — the only
transition that sets `opened_at` — while migration 0100's `berv_plan_opened_at_required` CHECK requires a
non-null `opened_at` for `closed_completed` among other statuses. The pure machine's own `skip` case had
simply never declared the effect (never exercised against a real database before this pass, since the
consumer that would call it has been unbound its whole life); fixed by adding a `set_timestamp` effect for
`opened_at` at the same instant as `closed_at` — honest, not fabricated, since a plan that never opened and
was immediately closed genuinely has a zero-day lifetime. A second, independent bug compounded it: the
consumer's own `closePlan` helper called `runEffects` and discarded its returned column patch entirely,
so even a correctly-declared effect would never have reached the database — fixed by capturing and
applying the patch in the final UPDATE. **M23, M13, and M1 stay exactly as blocked as before, each
re-verified fresh rather than re-asserted, with several findings sharpened**: M23's `m18.evv
.late_check_resolved` needs one new M8-owned seam function (`visitId → encounterId`) outside an isolated
M23 build; `m25.taxonomy.unmapped_code_observed` — now a real, live-published event since F-158 — needs
genuinely new schema (a 30-day occurrence/threshold-tracking table per M25's own D13) rather than the
already-wired `revalidate.consumer` path the other 6 M23 events reuse. M13's `m21.comfort_kit
.deployed_at_patient`/`.replenished` nullability is now CONFIRMED DELIBERATE (a real IPU floor-stock-kit
business state), not an oversight a migration should tighten, and `.returned`'s M21 producer-side
double-emit defect is now pinpointed to exact line numbers for a future scoped fix. M1's `m23.mac_portal.*`
re-confirmed a second, independent live bug beyond the missing outbox emit: `deps.alerts` is still never
wired into `buildM23WorkerDeps` at the composition root, so every real MAC-portal state-transition throws
in production today. Net: **159 → 156** (3 bound, 0 dropped; module count unchanged at 22 — none of the
four partially-built groups emptied). Verified: `bun run build`/`typecheck` clean (0 errors), full non-live
suite 654 files / 9593 tests green (including the bereavement-lifecycle unit suite, re-run to confirm the
new `opened_at` effect doesn't regress `skipPerPatientOptOut`'s pinned assertions), `arch:fitness` 38/38
(`arch:outbox-bindings` confirms 156 pairs, down from 159, and 87 live bindings now covering 95 catalogued
events), a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres
(proving migration 0250 applies cleanly), all three new live suites run individually after fixing five
test-fixture bugs found along the way — two CHECK-constraint-blind INSERT fixtures in each of the two new
M16 suites (`assigned_counselor_user_id`/`opened_at`/`closed_at` per status; a missing `bereaved_contact_id`
on a seeded outreach row) plus two message-vs-code assertion mismatches in the M6 suite (`m6:loc-change
-signed` 7/7, `m16:consent-signed` 5/5, `m16:opt-out-changed` 6/6) — and five sibling live suites re-run for
regression on the touched shared files (`m16:bereavement-intake` 8/8, `m16:consent-revoked` 5/5,
`m16:discharge-death-secondary` 5/5, `m6:cop-documents` 6/6, `m6:discharge-cascade` 6/6). Leaving #248
open — 156 pairs across 22 modules remain.

**A sixth round of parallel forks targeted five groups never before investigated for BUILD (only
catalog-triaged) — M26, M31, M27, M30's `no-consumer-surface` M6 cluster, and 4 producer-side gaps
inside M22 — and built the largest single haul of new bindings in this arc so far: 15 pairs across
three modules, plus 2 more catalog corrections discovered and bound in the same pass (F-160, #248).**
**M26's `CapConsumerStore` is real for the first time.** `cap_beneficiary_accrual.mbi_normalized`/
`.first_election_in_period` (both NOT NULL) had no writer anywhere — M26's `handlers-unbound` group's
own F-131 reason already named this as the blocker behind all 5 of its confirmed-genuine subscriptions.
Fixed with two new org-explicit seam reads injected as PORTS rather than imported — M26's real manifest
`dependsOn` is `[1, 23, 36]`, not the spec's unapplied proposed-patch list, so it cannot import M5 or M6
directly: `mbiNormalizedForPatient` (M5, reading the already-CHECK-constrained `patient_identifier`
kind='mbi' row nothing had ever read) and `firstElectionEffectiveDateInRangeForOrg` (M6, the F-121
range-reader shape a third module over — `ElectionPeriodReader` only ever answered single-date lookups).
`cap_period` is matched by `(organizationId, capYear)` alone rather than by CCN, deliberately mirroring
`seam-impls.ts`'s own existing simplification — `openPeriod` still writes every `cap_period.ccn` as the
literal `"000000"` sentinel pending the M40 bind, so a real per-patient CCN would never match it anyway.
Building it surfaced two MORE pairs with real routing in `M26_SUBSCRIPTION_MAP` that the catalog had
simply never declared: `m5.patient.deceased` (the identical `freeze-patient` action as the already-bound
`m6.revocation.created`) and `m36.notification.delivery_failed` (a documented no-op, `surface-stuck-alert`
— binding it still corrects the catalog/binding disagreement even though nothing observable happens on
delivery yet, and the event still has no real producer). Both declared and bound in the same pass —
**8 of M26's 9 candidates now live**; only `m25.remittance.claim_recouped` stays deferred, on a
confirmed-still-live, pre-existing defect in `handleClaimReversed` (reads `patientId`/`priorPaidAmountCents`
off a payload — `{originalClaimId, replacementClaimId|voidClaimId, reason}` — that carries neither).
**M31 got its first outbox consumers ever** — no `31-portal/outbox-consumers/` directory existed before
this pass. Built 3 of the 6 events F-139 had confirmed genuine: `m17.visit.cancelled`/`.rescheduled`
force-end/re-mint a `telehealth_visit` room by driving the existing pure `canTransitionTelehealth`
machine directly, and `m8.encounter.signed` reconciles an already-ended room once the encounter closes
it out. The vendor-side `TelehealthProvider.endRoom` force-close call is deliberately NOT attempted —
`telehealth_visit.vendor_room_id_cipher` has no decrypt path anywhere in this codebase, confirmed against
the one production route with the identical need (`routes/telehealth.routes.ts`'s staff `/end` route
never calls it either) — the DB-side transition is the real enforcement point regardless, since
`foldParticipantJoin` refuses any join once the room is in an ended state. No `m31.telehealth.visit_ended`
is emitted by any of the three: M31 currently emits ZERO `m31.*` outbox events anywhere in production, and
inventing the platform's first one from a pure consumer would repeat the exact "declared relationship
nobody decided" shape this arc exists to correct in the other direction. **2 of the remaining 3 stay
blocked on the identical root cause, independently confirmed via two different code paths**: both
`m39.consent.delegated_access.*` events and `m16.bereavement.contact_active` each need a
`sourceConsentRecordId`/portal-account resolution no schema path in this codebase currently provides
(`portal_caregiver_link`, the spec's own promised bridge table, doesn't exist — grepped, zero hits).
**M22 built the 4 events F-144 had flagged as unbuilt on the PRODUCER side too** — every builder existed,
nothing ever called one. `m13.administration_record.document_requested`: the pure `@wardenx/emar` machine
had declared this effect since M13-T03, but the production write service reimplements `commit` inline and
never read it — fixed by checking `administration_policy.emar_per_administration_pdf_enabled` directly.
`m23.billing.document_render_requested` (all 4 of M23's typed builders), `m24.medicaid_billing
.document_render_requested` (1 of M24's 4 spec-named kinds — the other 3 have no producer transition
anywhere and stay honestly unbuilt), and `m25.denial_resolution_letter.render_requested` are each
co-emitted in the same transaction as the underlying fact (the F-099/F-100/F-117 precedent). **Building
the M24 half surfaced an independent, pre-existing production bug**: `terminalizeSubmissionAndTransition`
passed the `withOrgContext` `""` GUC sentinel as `actorMembershipId` — a nullable UUID column, not a GUC —
so every worker-driven Medicaid claim-state transition threw Postgres `22P02` on its first tick, in every
environment, forever; `runClaimSubmit`/`runClaimPoll` had no test coverage anywhere in the repo before
this pass. Fixed to the honest `null`. Six new `document_aggregate_type` enum values were needed
(migration 0251, the F-099/migration-0239 additive-only precedent), one per artifact kind rather than a
shared bucket, so two kinds' renders can never collide under the same idempotency key.
**M27 and M30 stayed fully blocked, both freshly re-investigated with sharpened, more precise reasons
rather than merely re-asserted.** M27's 2 remaining M21 invoice-accrual events hit three concrete blockers
checked against the real schema: M27's `suppliesCents` is GL-account-aggregate (Worksheet A's own
`tiesToTrialBalanceWithinDollar` cross-check against the Xero-derived trial balance), so landing a
per-transaction M21 accrual would likely double-count against the same expense already flowing through
the GL-mapping pipeline, with no shared invoice id to dedupe against; the one per-transaction precedent in
M27's schema, `bad_debt_record`, is `cost_report_id NOT NULL` (scoped to one already-created report) while
M21's payloads carry no `cost_report_id`/fiscal-year field at all. M30's 15-event compliance-window/
survey-readiness cluster (M6 ×9, M15 ×4, M23 ×2) is blocked at THREE levels simultaneously, not merely
"decisively cross-referenced" as the prior reason implied: none of the 15 map to any of the 28 currently
registered measure codes; the seam method M30's own code CLAIMS to consume for the M6 cluster doesn't
exist either — `m6-admission.ts`'s header comment says M30 consumes M6's `ComplianceWindowReader`, but the
real `QualityAdmissionConsumer` interface has exactly three methods and none of them touch compliance
windows, confirmed by direct read rather than trusting the comment (`bound is not computing`, F-042, one
level deeper than usual — the seam itself was never built); and no alternate consumer table exists either
(`cop_compliance_status` is human-checklist-only, `risk_register_entry`'s four source kinds don't include
compliance windows or NOE/NOTR breaches). Building any of the 15 needs a new measure or a new
non-recompute consumer table — real feature design, not a wiring gap. Net: **156 → 143** (15 bound via 3
new consumer surfaces, 2 more catalog corrections bound in the same pass, 0 dropped as misdeclared; module
count unchanged at 22 — none of the four partially-built groups emptied). Verified centrally, once, after
all five forks' edits landed together plus one immediate follow-up fix for the 2 M26 catalog gaps:
`bun run build`/`typecheck` clean (0 errors), full non-live suite 654 files / 9593 tests green with no
regressions, `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 143 pairs, down from 156, and 91 live
bindings now covering 103 catalogued events, up from 87/95), a clean `check:boot:platform` run against a
freshly migrated, RLS-enforced disposable Postgres (proving migration 0251 applies cleanly and the full
91-binding dispatcher boots), all three new live suites run individually (`m26:cap-consumer-store` 9/9,
`m31:portal-telehealth-consumers` 10/10, `f144:render-requests` 10/10), and seventeen sibling live suites
re-run for regression on every touched shared file (`m13:emar-write` 24/24, `m13:emar-read-service` 5/5,
`gap-022:m13-rn-case-manager` 12/12, `m23:claim-submit-worker` 3/3, `m23:noe-draft` 8/8, `m23:notr-draft`
8/8, `m23:revalidate-triggers` 6/6, `m24:claim-line-assembly` 9/9, `m25:denial-seed-consumers` 9/9,
`gap-023-024-038:render-handshake` 14/14, `gap-051:m33-export-render` 5/5, `m27:ecr-backref` 7/7,
`m6:cop-document-renders` 6/6, `gap-004:death-cascade` 3/3, `m5:admission-siting` 4/4,
`m6:loc-change-signed` 7/7, `m6:discharge-cascade` 6/6). Leaving #248 open — 143 pairs across 22 modules
remain.

**The last 3 items in the m12 `handlers-unbound` group are now built, and the dispatch round that built
them surfaced the largest redundant-multi-agent-dispatch episode this arc has hit, resolved by centralized
verification rather than by trusting any single report (F-162, #248).** A context compaction mid-session
caused this arc's own coordinator to lose track of having already dispatched work on M12's three remaining
blocked items — `m11.order.verbal_expired_unsigned`, the six `sync-triggers.ts` patient-sync/MedHx-fetch
events, and `m13.reconciliation.draft_order_requested` — and re-dispatch a fresh round for the identical
targets; `ListAgents` surfaced **ten** subagents in flight, several of them themselves confused about
whether they were the coordinator or a worker (the F-158 shape at several times the scale). Rather than
force a pick between competing implementations sight unseen, every report was collected, every claim
independently re-verified against the actual working tree (`git status`/`git diff`, not the reports'
narrative), and conflicts were reconciled by keeping the best-reasoned surviving pieces from each side
rather than discarding either wholesale. **M11's verbal-order-expiry timer** is now real end to end, for
both M11's own clinical orders and M12's medication orders, closing three independently stacked defects:
the published `OrderSignatureProvider.recordVerbalOrder` seam (which M12's `recordVerbal` route now
actually calls, writing a real polymorphic `verbal_order` row) had always computed every deadline off the
48h platform DEFAULT, never the tenant's real `order_verbal_policy` override — a real, independent bug fix,
not a fabrication — fixed via a new `OrderSeamStore.verbalPolicyForOrg()`; the catalog payload gained the
`targetKind` field `decideVerbalExpiry` needed to discriminate on and never had; and a new hourly
`orders.verbal_timer` BullMQ fan-out (`11-orders/jobs/verbal-order-expiry-worker.ts`) drives
`OrderRouteService.expireOverdueVerbals`, publishing the event M12's `verbal-expired-binding.ts` consumer
was already correctly written to receive. **M12's DoseSpot sync job-queue tier** resolves the group's
oldest-standing blocker (no `jobs/` directory, no `Queue`/`Worker` construction anywhere, the two `jobId`
values the route service returned were hardcoded template strings, never a real enqueue) by reconciling
TWO independently-built, architecturally-different concurrent implementations of the same six-event
tier — a pure-BullMQ design (complete event-ingestion bindings, `jobId`-keyed dedupe) and a durable
Postgres debounce table (`dosespot_sync_queue`, migration 0253, `FOR UPDATE SKIP LOCKED` claim,
`measure_recompute_queue`/F-150 precedent) — rather than picking one and discarding the other's real work.
The DB-table design won as the QUEUE BACKEND: its partial-unique `dosespot_sync_queue_pending_uq` index
collapses two DIFFERENT trigger events for the same patient arriving close together (e.g. `.created` then
`.updated` seconds apart) onto one pending row, atomically with the outbox delivery — a property a BullMQ
`jobId` dedupe cannot express, since that only catches an exact redelivery of the identical event. The
OTHER design's event-ingestion binding layer (`consumers/sync-trigger-bindings.ts` — parsing each of the
six source payloads, running the already-shipped pure `decidePatientSyncTrigger`/`decideMedHxFetch`
deciders, and the honest injected-port pattern for `m6.cti.signed`'s missing `admissionId`, resolved
through M6's own `electionPeriodContextForOrg` seam since M12's manifest has no `dependsOn` edge to 6) was
kept as-is and simply repointed at the DB-table repository instead of a raw BullMQ `.add()` — nothing
thrown away, both real pieces of work combined. The vendor boundary stays an HONEST fail-closed stub, not
fabricated: no `DOSESPOT_*` credential exists anywhere in this repository, so every drained row fails
closed with a structured `DegradedError`, never a manufactured success; the one real edge
(`dosespotSyncDemographicsForOrg`, a new M5-owned org-explicit seam) resolves the patient-sync demographic
snapshot honestly, while the DoseSpot-side patient-id mapping and the RxBenefit cache both stay genuinely
unbuilt and reported as such (no table, no cache implementation, anywhere). **M13's
`m13.reconciliation.draft_order_requested`** now carries real drug content instead of the historical
hardcoded `{}`: `planReconciliationDecision` refuses (`RECONCILIATION_MEDHX_UNAVAILABLE`, 501) a
`carry_forward`/`new_order` decision on an `m12_medhx` line — no MedHx-record projection exists anywhere to
source real content from, and minting a draft claiming "derived from history" with nothing behind it would
misstate the order's provenance — and refuses (`RECONCILIATION_MEDICATION_DETAILS_REQUIRED`, 422) the same
decision on any other non-active line with no caller-supplied `medicationDetails`, validating
`medClass='controlled_substance' ⇔ deaSchedule` present. `carry_forward` on an already-`m12_active` line is
now correctly a no-op (a real bug fix — it used to wrongly emit). M12's new
`draft-order-requested-binding.ts` consumer mints the real `medication_order` draft, siting and attributing
it via M6's `activeAdmissionDraftContextForPatient` seam (the same one `m12.idg-decision-intake` already
binds), idempotent through a new non-partitioned ledger table
(`medication_order_reconciliation_decision_application`, migration 0254 — `medication_order` is
partitioned, so a direct unique constraint on the triggering decision id cannot exist) rather than a
pre-read. **Two pre-existing, unrelated test regressions surfaced by the full suite run were fixed, not
worked around**: `document-consumers.test.ts`'s pinned `M22_DOCUMENT_REQUEST_EVENTS` array was stale
against two legitimately-added entries from separate concurrent work; `emar-routes.test.ts`'s M13-T08
draft-order test used a `lineKind` value (`"active_medication"`) that predates the real
`"m12_active"|"m12_medhx"|"caregiver_reported"` vocabulary and asserted an event that the corrected
`m12_active` no-op fix means can never fire for that line kind — rewritten against a `caregiver_reported`
line with real `medicationDetails`, which is what actually exercises the handshake. Net on #248: the
`m12` `handlers-unbound` group (8 pairs — all remaining items) is now fully resolved and deleted from
`scripts/outbox-deferred-consumers.ts`, not merely emptied. Verified centrally: `bun run build`/`typecheck`
clean (0 errors), `arch:fitness` 38/38, full non-live suite 654 files / 9601 tests green (0 failed, up from
9599 before the two regression fixes), and `docs/api/openapi.json` + the generated typed client
regenerated and checked in sync.

**A five-fork survey-then-build round found the easy pairs genuinely running out — 3 of 5 targets were
real, precisely-scoped builds, and the other 2 correctly stopped short of fabricating business logic they
were never handed a decision for (F-163, #248).** Rather than dispatch blind, a research-only fork first
ranked all 21 remaining `outbox-deferred-consumers.ts` groups (126 pairs) by buildability from their own
documented reasons, and the five build forks that followed targeted its top picks. **M23's `m18.evv
.late_check_resolved`** — the one pair F-159 had scoped precisely as needing "one new M8 seam function" —
is now bound as the group's 7th of 8: a new `encounterIdsForVisitsForOrg` (`08-encounters/seams/
drizzle-store.ts`), the reverse of the already-published `encounterVisitIdsForOrg` and genuinely 1:1
(`encounter_org_visit_unique`, a partial unique index on `(organization_id, visit_id)`), injected as a
port into a new `m18-late-check-resolved.ts` consumer that enqueues onto the SAME `revalidate.consumer`
queue the module's six sibling triggers already use — no new infrastructure, matching this module's
established no-package-import posture for M8 bridges exactly. **M35 got its first-ever `outbox-consumers/`
directory**, binding 3 of its 8 D21-exhaustive inbound subscriptions: `m2.organization.{activated,
suspended,closed}` now mirror the real admin/tenant route operations they were always described as
triggering "in sympathy" with — `.suspended`→the same write `adminPauseSubscription` performs,
`.closed`→the TENANT self-serve `cancelSubscription`'s period-end schedule (not the platform immediate
cancel — D19/§4.12 both say "at period end"), `.activated`→RESUME ONLY (a `paused` subscription returning
to `active`, mirroring `adminResumeSubscription`), never CREATE — the spec's own "(optionally) create
initial trial subscription" hedge is its own tell that which of the three plan tiers a newly-activated org
should default onto was never decided, and inventing one would have been exactly the fabricated-business-
logic move this round's forks were instructed to stop short of. The other 3 of M35's 8 (`m2.session
.created`, `m5.patient.{deceased,merged}`) stay deferred on one shared, genuinely blocking root cause:
`PseudonymKeyProvider.activeKey()` has ZERO implementations anywhere in `apps/backend` — no seeded active
key row, no KMS-decrypt path, nothing that generates/wraps/inserts the platform's first epoch (the same
gap F-158 already named for this module's webhook `WebhookPayloadEncryptor` sibling port) — confirmed
M34's real per-tenant DEK-wrap mechanism does not transfer, since `patient_pseudonym_key` is platform-wide
rather than per-org, a structurally different scheme new security-critical infrastructure would be needed
to build. **The other 3 forks investigated and correctly reported BLOCKED, no files changed, each
sharpening a finding rather than merely re-asserting one.** M31's two previously-unchecked pairs
(`m17.visit.published`, `m22.document.rendered`) are each blocked deeper than this module's other
deferrals: the first needs a telehealth signal that exists nowhere in M17's real `VisitPurpose`/
`VisitSetting` schema (a missing upstream data-model fact, not a missing binding) stacked on a missing
envelope-encrypt capability for the vendor room-id columns and a whole absent BullMQ tier for this module;
the second's target table, `portal_document_share`, was never manifest-owned per M31's own schema
barrel's header and, independently, M31 already answers "what documents can this account see" via a live
seam pull already wired into its dashboard — the seam-vs-push trap this arc's F-101/F-115/F-129/F-140
findings keep finding, applied to M31 for the first time. M1's `m24.medicaid_state_channel.{unavailable,
recovered}` attempted the direct M23 MAC-portal-health mirror and found it doesn't transfer: unlike M23,
M24 has NO cron infrastructure running at all (`registerM24CronWorkers`/`scheduleM24Jobs` are never called
anywhere in `index.ts` — not even this module's two OTHER, already-built-and-tested crons), and a genuine,
unresolved contradiction sits under the specific pair — the catalog declares `organizationId` non-nullable
(per-tenant) while the spec's own worked example and the one real non-throwing health-check method that
exists today (`MedicaidAdapter.healthy()`, a single composition-root instance built once from env config)
both point platform-scoped; the one mechanism that WOULD answer per-tenant needs new credential-handling
plumbing this pass declined to guess the shape of. M22's `m14.minutes.amended` investigation found its own
premise was wrong before finding the real blocker: `m14.minutes.signed` — cited elsewhere in this corpus
as this event's "real trigger" — is not bound either (no template, no catalog entry, confirmed absent at
every point in `git log` history), and the actual gap one layer down is sharper than "needs the W2 append
path" — the append MACHINERY is fully built at the store layer (`DocumentSeamStore.upsertRenderedDocument`
already does genesis-vs-append correctly), but the shared pure decider's idempotency key is `(aggregateType,
aggregateId)` only, never `(sourceEvent, aggregateId)` as its own header comment says is the intended
design, which is necessary today for crash-safety (traced: the outbox dispatcher's delivery receipt commits
in a SEPARATE transaction after `handle()` returns) but means every subsequent render request for an
already-rendered aggregate silently no-ops — exactly backwards for an amendment that needs a NEW version.
Fixing it is shared infrastructure spanning every one of M22's ~40 rendered events, not an M14-scoped
narrow extension, and matches the shape already on record for `m6.discharge.cosigned`. Net on #248:
122 pairs across 21 modules remain (126 → 122; `m18.evv.late_check_resolved` bound at M23, 3 of M35's 8
bound, M35's own group re-typed `no-consumer-surface`→`handlers-unbound` now that a real directory exists).
Verified centrally: `bun run build`/`typecheck` clean (0 errors), `arch:fitness` 38/38 on the first run (no
new HTTP routes this round, so `openapi:check`/`client:check` needed no regen), full non-live suite
654 files / 9601 tests green, both new live suites individually against a fresh disposable Postgres
(`m23:late-check-resolved` 8/8, `m35:org-lifecycle-consumer` 10/10), sibling regression suites
(`m23:revalidate-triggers` 6/6, `m8:read` 4/4), and a clean `check:boot:platform` run against the same
freshly migrated, RLS-enforced disposable Postgres, proving the real 111-binding dispatcher (up from 109)
accepts both new consumers at boot.

**A fifth round of 5 parallel forks built 4 real bindings, correctly dropped one as redundant, and the
coordinator's own re-verification caught a genuine boot-crashing bug plus an architecture-boundary
violation neither the forks' own static checks had surfaced (F-164, #248).** Targets: M17's
`m8.encounter.orphan_recorded`, M23's `m25.taxonomy.unmapped_code_observed`, M14's 9-event "since last
IDG" cluster, M26's `m25.remittance.claim_recouped`, and M31's 4 previously-uninvestigated pairs.
**M17's `m8.encounter.orphan_recorded` is dropped, not built** — confirmed to have no production emitter
anywhere in `08-encounters/` (grep-checked against all 13 real `emit(...)` call sites) and, independently,
redundant even if it were built: the identical fact is already delivered to M17's live
`m17.m8-encounter-signed` consumer, whose own `EncounterSignedConsumed` doc comment names the exact branch
"M17 reconciliation, M8 D2" and whose `planVisitCompletionFromEncounter` already returns
`{kind:"skip", reason:"no_visit_link"}` for it — a real subscription pair, once removed, drops cleanly to
`declaredConsumers: []` with no `seamConsumers` replacement, since the relationship the name gestures at
is already covered by `.signed`. **M23's `m25.taxonomy.unmapped_code_observed`** — the group's last
remaining pair — is now bound: a new per-row `unmapped_taxonomy_occurrence` table (migration 0255 — one
row per delivered occurrence, not a maintained counter, since a 30-day ROLLING window needs individual
rows to age out, which a counter can never express), idempotent on `(organization_id, source_event_id)`,
and a new consumer that records the occurrence then dispatches the EXISTING `WorkerAlertPort` → M36
`AlertEmitter` seam once the org's rolling 30-day count for that CARC code exceeds 50 — no new
alert-delivery mechanism invented, reusing exactly what M23's own cron alerts already use. **M26's
`m25.remittance.claim_recouped`** — also the group's last remaining pair — is now bound too: the real
blocker was three missing facts, not the two the standing finding had named (`patientId` was genuinely
absent; `priorPaidAmountCents` was never the right field to fix, since `handleClaimReversed`'s `cents()`
helper is a passthrough rather than a dollars→cents conversion; `service_from`/`service_to`, NOT NULL on
`cap_beneficiary_accrual_line`, were a third gap found only by tracing the real insert path). Fixed by
widening the payload at its one real M25 emit site (`patientId` via the already-in-scope M23
`ClaimMatchCandidateProvider` seam, `recoupedAmountCents` computed directly from the same float dollars the
existing `recoupedAmount` string already carries, `serviceFrom`/`serviceTo` from the 835's own optional DTM
dates) and routing it to the SAME `record-reversal-line` action `m23.claim.replaced`/`.voided` already use
— those two stay a documented, still-open no-op independent of this fix, since neither of THEIR payloads
carries the fields the handler reads. **M14 built 6 of 9 "since last IDG" events on a shared per-patient
Valkey cache** (`consumers/since-last-idg-cache.ts`, one JSON object per patient, 30-day TTL, deduped by
the delivering outbox event's own id): M9's two write straight from the payload; M10's/M11's/M12's three
needed a cross-module fact neither payload carries, resolved via three NEW org-explicit seam functions
(`hopeAssessmentPatientIdForOrg`/`orderPatientAndKindForOrg`/`medicationOrderPatientAndDrugForOrg`, the
`encounterIdsForVisitsForOrg` (M8) precedent extended to three more modules) injected as ports — **the
build's first draft read M10/M11/M12's schemas directly instead, a real `arch:tables` boundary violation
the coordinator's own re-verification caught and fixed** (M14's `dependsOn` is `[1, 7, 8, 36]`, no edge to
9/10/11/12, and each fork had individually mis-attributed the other two's violations to "pre-existing,
unrelated concurrent work" rather than recognizing its own). M11's/M12's two `.discontinued` events are a
deliberate departure from the seam-vs-push rule this arc otherwise applies: their read-side projection
types doc-comment themselves as seam-pull, the opposite framing from M9/M10 on the same two files — but
the seam AS IMPLEMENTED anchors its filter on a timestamp fixed at order creation/activation and never
revisited, so an order discontinued after the packet-build cursor is invisible to it regardless of how the
read side joins it; the push cache is the only place that fact can come from until the seam's own filter is
widened (a separate M11/M12-side gap, reported not fixed). **M6's `admission.activated`/`.discharged` and
the M15 trio were investigated fresh and left exactly as-is, genuinely ambiguous rather than confidently
resolved either way** — M14's own D9 rationale cites both a seam-pull mechanism (M5's `CaseloadProvider`)
AND its own §4.5 table's push-cache description as consistent, when the two describe different facts (an
inclusion cache can express a 7-day post-discharge grace window a plain "active caseload right now" seam
cannot); M15's Lock-status one-liner about a `DisciplinePlanReader` seam consumption is a narrower claim
(the packet's cross-discipline VIEW) than whether the same builder separately needs the three push events
for a "since last IDG" delta, which M15's own decisive §2.4/§4.5 event table names with real payloads and
explicit M14 consumers — a dedicated future pass is needed to read the packet builder's actual read-side
requirements, not a snap drop on either spec fragment alone. **M31 built 2 of its last 4 unchecked pairs,
re-typed `no-consumer-surface`→`handlers-unbound` now that a real directory exists (the F-163/M35
precedent)**: `m16.bereavement.plan_closed_completed` (plan-level grant revocation via the T03
`planBereavedWindowClose` pure core, unit-untested and uncalled since M31-T03) and the BROAD
`m39.consent.revoked` cascade — a genuinely different, cleaner mechanism than M2's own already-built
consumer for this identical event name, since M31's own `portal_access_grant.source_consent_record_id`
column is a direct, unambiguous match key the session table M2 revokes against does not have (M2's sweep
can only ever cover the `portal_access` scope, because two concurrently-valid `family_caregiver_access`
grants for different caregivers share nothing else to disambiguate on). `m16.bereavement.plan_opened` stays
blocked on a sharper wall than previously named — the flip's INSERT half needs
`portal_access_grant.granted_by_membership_id`, NOT NULL with no nullable escape (unlike
`revoked_by_membership_id` on the same table), the F-150 "no system-actor-membership convention" shape
exactly, compounded by the real M39 consent this insert depends on almost never being `active` yet at the
moment of death. `m6.admission.discharged` (a different M31 use of the event name from the one already
blocked in the m14 group) stays blocked on two reasons per branch: the death branch is redundant with the
already-bound `m6.bereavement.eligible`→`plan_opened` chain, and the non-death branch needs a BullMQ/cron
tier that exists nowhere in `31-portal/` for a mechanism the spec's own §4.8 table says should be a daily
cron, not an event-triggered job. **A standing finding surfaced investigating all four, flagged rather than
fixed**: no production code path anywhere creates a `portal_account` or `portal_access_grant` row — both
admin invitation routes are complete stubs that return a canned success with no database write — so
today's builds are correct but inert end-to-end until that separate, larger gap (materializing
accounts/grants from M2's magic-link accept flow) is built, the same shape already on record for M2/M16
(F-097/F-105). **Independently verifying every fork's work found one more defect none of their own
static checks caught**: the M23 taxonomy consumer's `getSeam("AlertEmitter")` call sat at module-TOP-LEVEL
scope in the composition root, ahead of where the seam actually registers during boot — `bun run
typecheck`/`build`/the full non-live suite all stayed green (nothing exercises the real boot sequence), and
only a real `check:boot:platform` run crashed with `SeamError: seam 'AlertEmitter' requested before
registration`. Fixed by moving the resolution inline into the `dispatch` closure (lazy, first-use-only —
the RULE 4 fail-closed-thunk shape every other cross-module port in this file already follows), which is
also where the fix was verified: a second `check:boot:platform` run passed clean. Net on #248: **122 → 111**
pairs (11 bound — 6 M14, 2 M23/M26's last pairs, 2 M31 — 1 dropped as redundant, 0 added; 21 → 19 modules,
M23 and M26 both fully resolved). Verified centrally: `bun run build`/`typecheck` clean, `arch:fitness`
38/38 (`arch:outbox-bindings` confirms 111 pairs, down from 122, and 120 live bindings now covering 125
catalogued events, up from 111/120), a clean `check:boot:platform` run against a freshly migrated,
RLS-enforced disposable Postgres (the real proof the AlertEmitter-timing fix holds), full non-live suite
654 files / 9603 tests green (one pinned-array assertion updated for the M17 drop), and all four new/touched
live suites run individually against the same disposable Postgres+Valkey (`m14:since-last-idg-cache` 13/13,
`m23:taxonomy-occurrence` 8/8, `m26:cap-consumer-store` 13/13, `m31:bereavement-consent-consumers` 9/9),
alongside three sibling regression suites (`m23:revalidate-triggers` 6/6, `m23:late-check-resolved` 8/8,
`m6:loc-change-signed` 7/7). Leaving #248 open — 111 pairs across 19 modules remain.

**A sixth round of five parallel forks built 9 more bindings across five modules, fully resolved M19,
and the coordinator's own re-verification caught a genuine `arch:tables`/`arch:boundaries` violation plus
a three-way F-number collision none of the forks' own static checks could see (F-165, #248).** Targets:
M29's `m5.patient.deceased`, M5's `m17.visit.assigned`/`.unassigned`, M31's `m16.bereavement.plan_opened`,
M19's sole `handlers-unbound` pair, and M24's six-event group — dispatched per the user's explicit "5
subagents at a time, verify to avoid mistakes" instruction, each independently re-checked against the
actual working tree rather than trusted from its own report. **M29 built the FREEZE half of
`m5.patient.deceased`**: every still-`pending` `hl7_inbound_proposal` matched to a decedent is expired via
the already-written-but-never-called `expireProposal` pure decider (M29-T04), widened with an optional
`reason` so a death-triggered freeze is distinguishable from the (also still-unbuilt) 72h SLA sweep; the
REFUSAL half (blocking future post-death A01/A04 messages) stays unbuilt — M5's `PatientReader` seam
carries no deceased/status field, a producer-side gap this build reports rather than works around. **M5
built `m17.visit.assigned`/`.unassigned`**: a new per-clinician Valkey shift-assignment cache
(`05-patient/seams/shift-caseload-cache.ts`, one Hash per (org, userId), field=visitId, read-time expiry
off `scheduledEndedAt` + a grace window) unioned additively into `CaseloadProvider`, resolving M17's
membership-keyed payload to a Better Auth user id via a new `membershipUserIdForOrg` seam function
(M5 already reads `schema.memberships` directly for the identical reason at GAP-022/#124) — and,
deliberately, the one cache in this whole arc that fails OPEN on a Redis read error rather than closed,
because `CaseloadProvider` sits on the ABAC hot path for nine other modules and a Valkey hiccup turning
into a platform-wide caseload-check outage would be strictly worse than a stale cache. **M19's group is
now fully resolved and deleted**: `m17.visit.assigned` drives the §4.8 `m19.shift-sync.debounced`
reconciler via a new two-table-free, single-table TRUE debounce (`on_call_roster_sync_queue`, migration
0256 — `run_after` is bumped forward on every trigger via `ON CONFLICT ... DO UPDATE`, not merely
collapsed onto a pending row, because a BullMQ `jobId` dedupe cannot express "reset the 30s quiet window",
only "at most one pending"), with the periodic "shift cron tick" catch-up sharing the same table as a
`cron_catchup`-reason row rather than a second competing writer to `on_call_shift`. Correctly reported,
not forced: `reconcileOrgOnCallRoster`'s roster reader resolves `{kind:"unavailable"}` on every real call
today, because M17's own `VisitAssignmentReader.tonightsOnCallRoster` is a PERMANENT, documented deny-stub
("M17 owns no on-call rotation table") — the reader is an injected port specifically so the live suite can
prove the debounce/claim/apply machinery for real without waiting on that unrelated M17-side gap.
**M31 built `m16.bereavement.plan_opened`**, re-checking both of F-164's own named blockers rather than
re-asserting them and finding both resolve: migration 0257 nullable-widens
`portal_access_grant.granted_by_membership_id` (the `order_discontinuation.actor_membership_id`
precedent — a consumer-driven cascade names no acting membership), and the "no active consent to insert
against yet" framing was right about WHEN `plan_opened` fires (before any contact confirms) but wrong that
the fact is unresolvable: `bereaved_contact.status = 'active'` already IS the per-contact "this exact
consent signed" fact, and the missing piece — the consent's VERSION — resolves via M39's real
`ConsentEvaluator.evaluate`, cross-checked that the returned governing record matches the contact's own
rather than trusting a different contact's authority. **M24 built 4 of its 6 candidate events across two
actions**: `trigger-revalidate` (`m5.patient.updated`/`.address_changed`, `m8.encounter.signed`) reuses
the EXACT rule-run + transition logic the manual "revalidate" button already performs, never a new
validation rule; `resolve-medicare-primary` (`m23.claim.acknowledged`) applies the pure machine's own
`medicare_primary_acknowledged` edge, correctly scoped short of the full spec (no Medicare-EOB-context
snapshot — that seam has no port anywhere on the write service) and honestly reported as CURRENTLY INERT
in production, since no code path anywhere ever transitions a claim INTO the state this consumer would
act on. The other 2 (`m25.remittance.claim_paid`/`.claim_denied`) stay genuinely blocked: M25's real
835-posting pipeline matches only against M23 (Medicare) claims, and there is no Medicaid-claim matching
path anywhere. **M30's own group was re-checked, not re-asserted, and the actor-half of its stated blocker
turned out wrong**: `m12.medication.error_reported`'s catalogued payload already carries a REAL
`reportedByMembershipId` (the actual clinician, not a fictional system-actor), so the "no
system-actor-membership convention" framing never applied — the real, deeper wall is that **no producer
anywhere in the codebase ever emits this event** (`reportMedicationError`, the function its own catalog
description names, does not exist; exhaustively grepped across the two plausible source modules). Binding
an M30 consumer for it would be dead code, correct and permanently unexercised — not built, the
`m18.evv.visit_verified` shape a second time in the same group.
**Two coordinator-caught defects, both invisible to the forks' own lightweight self-checks.** The M31
build imported `schema.bereavedContact` directly off M16's Drizzle schema — a real `arch:tables`/
`arch:boundaries` violation (M31's `dependsOn` carries no edge to 16) caught only by running the actual
gates rather than trusting the fork's "not run, per instructions" disclaimer; fixed with a new org-explicit
`bereavedContactFlipCandidatesForPlanForOrg` seam (`16-bereavement/seams/plan-provider-entity-for-org.ts`,
the `bereavementPlanSitingForOrg`/M30 precedent one module over), injected as a port with a locally-declared
structural type rather than an imported one — the `m16-plan-closed.ts` shape exactly, needed because
`arch:boundaries` flags even a type-only cross-module import here. Independently, three forks (M29, M5, and
the system-actor-membership fork building M31/M30) each claimed **F-165** for their own citations, and a
fourth (M24) discovered the collision mid-task, picked **F-166** for itself, and — working on the same
shared `outbox-deferred-consumers.ts` string fields concurrently — ended up being the surviving edit for
all three other forks' own reason-text paragraphs too, each correctly re-describing the other forks' real
work but under its own number and a misleading "(#248, m24 group)" tag. Resolved by renumbering every
citation to the single round number (**F-165**, following F-164) and correcting the four misattributed
group tags — a content audit rather than a blind rename, since each renumbered paragraph was independently
re-verified against the actual files before being trusted. **The verification pass also found two
test-fixture bugs and one genuine mirror-constant gap this round's forks introduced**: M31's live suite
seeded an `active`-status `bereavement_plan` row with no `assigned_counselor_user_id`, violating
`berv_plan_active_requires_counselor` (a real CHECK, not a fixture-writer's guess); M24's live suite seeded
two provider entities with the SAME literal NPI, violating the platform-wide-unique `provider_entity_npi_idx`;
and `packages/types/src/oncall.ts`'s `M19TableName`/`M19_TABLE_NAMES`/`M19_AUDIT_DENYLIST`/
`M19_AUDIT_RETENTION_CLASS` — the leaf-package mirror of M19's owned-table manifest — had not been updated
for the new `on_call_roster_sync_queue` table, caught by the full non-live suite (not `arch:fitness`, which
only checks the `module-manifest.ts` side) failing two pinned assertions; the retention class is
`operational` (process bookkeeping for a reconciliation pass), not `compliance` like M19's clinical-record
tables, matching the identical distinction migration 0253's `dosespot_sync_queue` trigger already draws.
**A pre-existing, unrelated test bug was also fixed, at the user's explicit follow-up request**:
`m30-bereavement-plan-closed-consumer.live.test.ts` (last touched at F-162, migration 0100 — long before
this round) seeded a `closed_completed`-status plan with neither `opened_at` nor `closed_at`, violating two
CHECK constraints (`berv_plan_opened_at_required`/`berv_plan_closed_at_required`) that have existed since
migration 0100; fixed in place. Net: **111 → 102** (9 bound — 1 M29, 2 M5, 1 M31, 1 M19, 4 M24 — 0 dropped;
19 → 18 modules, M19 fully resolved). Verified centrally, once, after all five forks' edits landed together
plus the coordinator's own fixes: `bun run build`/`typecheck` clean (0 errors), `arch:fitness` 38/38
(`arch:outbox-bindings` confirms 102 pairs, down from 111, and 129 live bindings now covering 128
catalogued events, up from 120/125 — one real `arch:tables`/`arch:boundaries` violation caught and fixed
along the way), full non-live suite 654 files / 9603 tests green (two pinned-array/pinned-count assertions
in `oncall-contracts.test.ts`/`oncall-schema.test.ts` updated for the new M19 table, after first confirming
they were catching a real gap and not a stale pin), a clean `check:boot:platform` run against a freshly
migrated, RLS-enforced disposable Postgres (the real 129-binding dispatcher boots clean), all five new live
suites run individually against the same disposable Postgres+Valkey after fixing the two fixture bugs
found along the way (`m29:patient-deceased-freeze` 8/8, `m5:visit-assignment-cache` 8/8,
`m31:bereavement-plan-opened` 6/6, `m19:roster-sync-debounce` 12/12, `m24:revalidate-medicare-primary`
6/6), and thirteen sibling regression suites re-run for regression on every touched shared file
(`m30:bereavement-plan-closed-consumer` 2/2 — the pre-existing fix — `m30:upstream-consumers` 2/2,
`m5:admission-siting` 4/4, `m5:census-scope` 7/7, `m5:death-cascade` 3/3, `m24:claim-line-assembly` 9/9,
`m16:bereavement-intake` 8/8, `m16:consent-revoked` 5/5, `m16:consent-signed` 5/5,
`m16:opt-out-changed` 6/6, `m16:discharge-death-secondary` 5/5, `m31:portal-telehealth-consumers` 10/10,
`m31:bereavement-consent-consumers` 9/9). Leaving #248 open — 102 pairs across 18 modules remain.

**A seventh round of five parallel forks (M11, M13, M17, M21, M22), plus a sixth follow-up agent
dispatched specifically to fix the M21-side producer defects the M13 fork found blocking its own
group, built 14 more bindings and fully resolved M13 — and the coordinator's own re-verification
caught a real build-breaking enum-mirror gap and an `arch:outbox-bindings` rule-6 miss neither fork's
own static checks surfaced (F-166, #248).** **M11 — 1 bound, 1 dropped.**
`m21.supply_request.cancelled` is now live (`outbox-consumers/m21-supply-cancelled.ts`): F-137 had
read this pair as always-a-no-op (the M11 order already discontinued by M11's own discharge cascade
before M21 ever replies), which is true of ONE of its two real producers and false of the other — a
real staff route, `cancelSupplyRequest`, emits the identical event with the M11 order still in
flight, and this pass's re-check caught the second producer F-137's reading had missed. Needed a new
`order_discontinuation_reason` enum value (migration 0258, `supply_request_cancelled` — none of the
nine existing values honestly describe "cancelled out from under this order by someone at M21" as
distinct from a clinical decision or an M11-originated cascade). `.cancel_no_op`, by contrast, is
confirmed to have exactly ONE producer — always the case F-137 described — and is dropped as
genuinely misdeclared, record-only now. **M17 — 2 bound.** `m15.volunteer.assignment_inactivated` is
built, but not the literal reading M15's own catalog description implies (`visit
.assigned_membership_id` is NOT NULL — there is no "unassigned but still scheduled" state, only a
full cancel or a reassign to a specific new membership, and no auto-reassignment algorithm exists to
guess one honestly); what's built is the platform's own already-designed answer — M17's catalogued,
alert-wired `m17.reassignment_needed` event had zero producers anywhere, including the PTO-approval
path meant to trigger it, and the new consumer is its first real one, warning a human scheduler per
affected visit rather than guessing a replacement. `m19.triage_call.visit_needed` is built too,
resolving all three of F-133's named infrastructure gaps for real: migration 0260 adds
`triage_dispatch_m19` to `visit_proposal_source` (additive-only); a new, narrow M6 seam
(`activeAdmissionSitingForPatientForOrg`) resolves patientId → admission siting without the existing
`activeAdmissionDraftContextForPatient`'s physician-required throw (irrelevant to a scheduling
proposal); and "M17's manifest excludes 6" was never a real blocker — the established org-explicit
`...ForOrg` port-injection pattern needs no `dependsOn` edge. Building it surfaced and fixed a real
payload gap: the event's non-null fields couldn't distinguish `visit_dispatched_now` from
`pronouncement_scheduled`, so a new `visitKind` discriminator now carries the fact M19 already has at
the emit site. **M13 — 6 bound, group fully resolved and deleted.** The M13 fork itself bound 2:
`m12.medication_order.active` (the §2.3 D2 scheduled-dose materializer, pure and complete since
M13-T03 with zero callers — resolved via a new M12 org-explicit seam plus a new
`FoundationSiteReader.locationTimezone` method, M13's own direct-import pattern for a module that
already `dependsOn`s module 1) and `.discontinued` (a new pure `planOrderDiscontinueCascade` core,
the `planDischargeCascade` future-pending-only shape scoped to one order). The other 4 — all M21
comfort-kit events — were confirmed genuinely blocked on real M21-side producer defects, which the
follow-up agent then fixed and bound: `deployed_at_patient`/`.replenished` were scoped honestly
rather than guessed at (M13 has zero precedent anywhere for an order-less drawdown, so the new
consumers track every order-linked line for real and visibly skip floor-stock lines via a reported
`skippedFloorStockLineCount`, never silently); `.returned` had a real double-emission bug — M21 fired
the SAME event name at return-REQUEST time (placeholder facts) and at return-RECONCILE time (real
facts) — fixed by deleting the premature emission at its source rather than inventing an unconsumed
new event name; `.return_reconciliation` is genuinely distinct (the physical-count-vs-tracked-quantity
cross-check), not redundant with `.returned`. Binding `.deployed_at_patient` also completed a
previously-dead handshake: M21's own `buildM21ComfortKitDeploymentAckConsumer` (F-153) had sat live
and bound since that pass, waiting for an event nothing had ever published. **M22 — 5 bound, 1
dropped.** A survey-then-build pass over the group's remaining ~25 events found `m8.encounter.signed`
(template `encounter`, published with no producer wired — the LOCKED payload's renderable content had
sat unconsumed since the event existed), `m18.evv.aggregator_accepted` (template `evv_verification`),
`m14.packet.render_requested`/`m14.minutes.signed` (templates `idg_patient_packet`/`idg_minutes`, both
real `document_aggregate_type` values since migration 0048 with no descriptor — exactly the wall
F-162 found and stopped short of), and `m15.plan.version_signed` (4 new template descriptors by
`kind`, payload widened with `patientId` at the source). No migration was needed for any of the
five — only the missing TemplateDescriptor + REQUEST_SHAPES/event-list entries. Dropped
`m18.evv.verification_pdf_requested` as the vapor duplicate of `aggregator_accepted`'s real trigger
(no emit site anywhere publishes it). The rest were investigated and sharpened rather than rebuilt on
guesswork: `m11.order.results_received` looked buildable until the dedicated (non-generic)
`lab-backref-consumer.ts` pipeline was checked and found to need a port-name fix PLUS an SUD-class flag
the real M29 seam DTO doesn't carry — the same Part-2-disclosure risk F-035 already refused for a
different DTO pair; several more (`m12.medication_order.list_changed`/`.transmitted`,
`m8.encounter.addendum_signed`, `m9.assessment.summary_requested`) are the same F-162 idempotency-key
GRANULARITY collision the shared `decideDocumentRequest` core has for `.amended` — a first render for
an aggregate id succeeds and every later request for the same id silently no-ops, which is backwards
for anything needing a second version. **M21's own group — 0 bound directly, but a real stale claim
corrected.** The re-check found F-137's "no platform seam answers which Location serves this patient"
claim for `m11.order.supply_fulfillment_requested` was stale — `AdmissionSummary.locationId` had been
on the seam's return type the whole time, unread — and fixed it for real
(`consumers/order-context.ts`'s `resolveServingLocation` port is now gone outright, not merely
patched). But checking whether a consumer could actually bind on top of that fix found the payload
assembly blocked a level deeper, for all three M11 sub-kinds: `dme`/`supply` require fields
(`skuId`, `hcpcs`, a full `deliveryAddress`) M11's own order-data contract for those kinds is
`contract_not_published` and cannot supply, and `comfort_kit`'s M11 canonical shape carries none of
the fields M21's schema requires either — no published M5 seam closes the address gap. A bound
consumer would `ValidationError`-refuse essentially every real delivery, the F-150 "wiring a line to a
house that was never built" shape restated at the schema level; the location fix is kept as real,
independently-correct progress, but the pair stays deferred. **Three coordinator-caught defects, none
visible to any individual fork's own scoped checks.** Two forks independently minted migration `0258`
for unrelated purposes (M11's `order_discontinuation_reason` value, M17's `visit_proposal_source`
value); resolved by renumbering M17's to migration 0260 (0259 was already claimed by the follow-up
agent's comfort-kit-idempotency migration) — a content audit, not a blind rename, since both files
were independently correct. The M17 fork's migration added `triage_dispatch_m19` to the DATABASE enum
but missed BOTH code-side mirrors — `packages/db/src/enums.ts`'s Drizzle `pgEnum` and
`packages/types/src/scheduling.ts`'s `VisitProposalSource` union — a real, build-breaking gap
(`bun run build` failed with a TS2769 Drizzle insert-type mismatch) invisible to every fork's own
narrower `tsc --noEmit` pass, since none of them ran the full project build after all five forks'
edits landed together. And `arch:fitness` caught a genuine `arch:outbox-bindings` rule-6
disagreement: the M17 fork bound both its new consumers live and declared `m17` on both catalog
entries, but never added either to `M17_OUTBOX_SUBSCRIPTIONS` — the module's own hand-maintained
mirror, checked bidirectionally against the catalog by rule 6 — so the gate that exists specifically
to catch "declared and bound but the module's own source of truth disagrees" caught it immediately.
Four pinned-array test assertions also needed updating for real changes across all five groups — one
of them (`document-render-consumer.test.ts`'s "every subscribed event is declared by its producer"
check) needed FOUR new module-catalog imports (M8/M14/M15/M18) added to its own explicitly-enumerated
`declared` map, per that test file's own documented convention that a new producer module must be
added to the import list by hand or the check is silently incomplete. Net: **102 → 86** (14 bound, 2
dropped as misdeclared; 18 → 17 modules, M13 fully resolved and deleted). Verified centrally, once,
after all six agents' edits landed together plus the coordinator's own three fixes: `bun run
build`/`typecheck` clean (0 errors), full non-live suite 654 files / 9603 tests green (four
pinned-array assertions updated after confirming each was catching a real change, not a stale pin),
`arch:fitness` 38/38 (`arch:outbox-bindings` confirms 86 pairs, down from 102, and 138 live bindings
now covering 139 catalogued events, up from 129/128 — one real rule-6 disagreement caught and fixed
along the way), a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable
Postgres (proving migrations 0258/0259/0260 all apply cleanly and the real 138-binding dispatcher
boots), all five new live suites run individually against the same disposable Postgres+Valkey
(`m11:supply-cancelled` 6/6, `m17:volunteer-triage-consumers` 6/6,
`m13:scheduled-dose-materialization` 7/7, `m13:comfort-kit-deployment` 6/6, `f166:render-requests`
8/8), and fifteen sibling regression suites re-run for regression on every touched shared file
(`f144:render-requests` 10/10, `f161:m7-m17-render-requests` 4/4, `m22:render-handshake` 14/14,
`m6:cop-documents` 6/6, `m33:export-render` 5/5, `m27:ecr-backref` 7/7, `m11:m9-m21-consumers` 11/11,
`m11:write` 11/11, `m21:order-cascade` 6/6, `m21:comfort-kit-cascade` 7/7,
`m21:comfort-kit-replenishment` 8/8, `m13:admission-discharged-cascade` 5/5,
`m13:reconciliation-triggers` 5/5, `m17:evv-sos-consumers` 4/4, `m17:evv-checkout-corrected` 5/5).
Leaving #248 open — 86 pairs across 17 modules remain.

**An eighth round of five parallel forks yielded the smallest build-to-investigation ratio of the
series so far — 2 of 5 groups built real bindings, 3 of 5 found nothing buildable and instead
strengthened their groups' standing reasons with fresh, re-verified findings (F-167, #248).** Per
the same "5 forks, verify before applying" discipline, each fork investigated one (or a bundle of
small) `handlers-unbound`/`no-consumer-surface` group and reported BUILT or BLOCKED; the
coordinator independently re-verified every claim — reading the actual seam signatures, schema
columns, and catalog declarations — before applying anything. **M31 — 1 of 6 built.**
`m16.bereavement.contact_active` is now live: the per-contact-exact D6 lateral-flip trigger the
already-bound `plan_opened` consumer's own header (F-165) names as "the real primary trigger" —
`plan_opened` fires once per PLAN, before any contact has confirmed, so its own per-contact loop
almost always finds nothing, while `contact_active` fires exactly once per CONTACT at the moment
that contact's own `bereavement_outreach_consent` is verified. A new M16 org-explicit seam
(`bereavedContactFlipCandidateForOrg`, the single-contact sibling of the existing plan-wide read,
re-resolved fresh by contact id rather than trusted off the payload so a contact that has since
left `active` is an honest no-op) feeds a new M31 consumer that resolves the decedent patient via
`BereavementPlanProvider.planById` and the governing consent version via M39's
`ConsentEvaluator.evaluate`, cross-checked against the contact's own `consent_record_id` — a
mismatch skips rather than attributes the flip to the wrong record. The other 5 M31 candidates were
re-verified and stay genuinely blocked, unchanged from F-163/F-164: `m17.visit.published` (a
missing telehealth data-model fact, a hardcoded crypto AAD, and no job tier — three independent
gaps), `m22.document.rendered` (the seam-vs-push trap — the dashboard already live-pulls this fact
per request), both `m39.consent.delegated_access.*` events (no schema bridge from an M5 caregiver
row to a portal userId exists anywhere), and `m6.admission.discharged` (redundant with the already-
bound death chain on the death branch; needs a still-nonexistent cron tier on the grace-timer
branch). **M5 — 4 of 6 built, 1 dropped as misdeclared, 1 stays blocked.** `m39.consent.signed`,
`.revoked`, `.supersedes` and `.renewed` are now bound to a single new consumer
(`buildM5ConsentPrivacyConsumer`) that recomputes `patient_privacy_flag_snapshot`'s `sud` flag off
M39's `42_cfr_part_2_release` consent type — the ONE real relationship M39's own spec §4.3.1 names,
and the mapping for it (`TYPE_TO_PRIVACY_FLAG`) already existed, unused, in M39's own
`consumers.ts` since M39-T08/T09. **F-138's original "no mapping exists anywhere in the codebase"
verdict was simply checked against the wrong file and found false** — the fix here is building the
missing CALLER, not the missing fact. `supersedes`/`renewed` are treated identically to `signed`
(both write the new record `status: "active"` in the same transaction that emits the event,
verified directly against `consent-store-db.ts`), the same three-event grouping M22's own
`render-consumer.ts` (F-161) already uses for its own render trigger. A new pure
`mergeConsentSignal` helper (`privacy/index.ts`) merges the ONE touched category into whatever the
persisted snapshot's other flags currently hold rather than overwriting the whole snapshot from a
single-category signal — protects the still-unbuilt HIV/mental_health/genetic "M5-delegated" flags
(§4.3.1) from being silently clobbered once a future producer sets them. `m39.consent
.recipient_removed` is dropped from `declaredConsumers` at the source (`events-by-m39.ts`, was
`["m22","m5"]`, now `["m22"]`) rather than left a permanent unactionable deferral: its own catalog
description names it for M22/M28's per-signed-URL disclosure-subsetter cache, M5's categorical
`patient_privacy_flag_snapshot` schema has no recipient dimension at all, and the payload does not
even carry `typeKey` — M22's own F-161 finding independently reached the identical "no persistent
state to invalidate" conclusion for this exact event, corroborating evidence from the other
consuming module. `m39.consent.expired` stays genuinely blocked: no production code path emits it
anywhere — the whole M39 §4.9 cron tier (expiration ticks, reminder ticks, renewal-cycle close) is
unwired, confirmed by a zero-hit grep for `M39_QUEUES`/cron registration in the composition root —
and binding a consumer to a name nothing publishes would be dead code, the standing F-150
`m18.evv.visit_verified` shape. **The other three forks found zero buildable pairs across their
combined 22 events, and each re-verified rather than re-asserted its group's standing reasons
against current code.** M1's `m24.medicaid_state_channel.{unavailable,recovered}` re-confirmed M24
still has no cron tier registered at all (unlike M23's own, itself broken, equivalent) plus the
same unresolved per-org-vs-platform-scoping contradiction. M6's `m11.order.recertification_signed`
re-confirmed no F2F/CTI adequacy-check function exists anywhere under `06-admission/` — a genuine
clinical-compliance design decision, not a wiring gap. M29's `m11.order.hl7_orm_requested` found
newer infrastructure than previously scoped (`29-external-interfaces/outbound/` now holds a pure
wire builder, dispatch planner, retry policy and ACK-correlation core) but confirmed every file is
still uncalled by anything — the gap is a full outbound MLLP transport worker, not a wiring line.
M35's three `handlers-unbound` events (`m2.session.created`, `m5.patient.{deceased,merged}`) swept
the WHOLE repository, not just M35, for any KMS/envelope-DEK provider built since F-163 and found
none — `PseudonymKeyProvider.activeKey()` still has zero production implementations anywhere, and
`patient_pseudonym_key` is confirmed structurally different from M34's per-tenant DEK-wrap
mechanism (platform-wide vs. per-org), so that precedent does not transfer. M37's
`m19.triage_call.gip_admission_proposed` re-read M37's own §4.5 "Outbox Subscriptions" table
directly and confirmed the event still appears in no row of it (only in narrative prose), while
`ipu_admission`'s `admissionId`/`levelOfCarePeriodId`/`providerEntityId` are all still
`.notNull()` — no schema exists to write a proposal to before those three facts exist. M16's two
events (`m37.ipu_admission.death_recorded`, redundant with the already-bound death chain and still
producer-less on the M37 side; `m6.discharge.cosigned`, a genuinely different payload shape from
what the D18 decider needs) stay blocked unchanged. M24's two events
(`m25.remittance.claim_paid`/`.claim_denied`) stay blocked, but the re-check surfaced a genuinely
new fact: `ReceiveAdviceInput` already carries a `payerKind` discriminator at the 835 receive step
that `postAdvice`'s auto-match entirely ignores, routing every advice through the M23-only matcher
regardless — a real cross-module matching-scheme design decision (how to route by payer), not a
wiring gap, and reported rather than guessed at. M27's two events
(`m21.supply_request.invoice_{accrued,reconciled}`) re-confirmed all three previously-named
blockers unchanged (the Worksheet A GL-tie-out conflict, `bad_debt_record.cost_report_id`'s
NOT NULL single-report scoping, no shared vendor+amount+date matching key). M14's remaining 8
events (the M6 inclusion-cache pair, `m12.medication_history_pulled`, the M15 trio, M19's
`care_plan_change_indicated`, M39's `expiring_soon`) resolved to ONE root cause stated once rather
than eight times: the M14 §2.4 T-24h packet-build worker has never been written in production — only
the pure `builder.ts` contract and F-164's cache-*writing* consumers exist; nothing anywhere reads
the cache, resolves inclusion, or calls the pure builder — and for the handful of facts that would
not fit even once a worker exists (M19's free-form `changeKind`, M12's pull-metadata, M39's
undefined "compliance tile"), no typed packet-contract slot exists in `packages/types/src/idg.ts`,
and this pass declined to invent one unilaterally, matching F-164's own restraint on
`m9.assessment.recorded`. **A recurring coordination hazard surfaced again this round and was
caught by the same discipline that has caught it every time before**: all five forks minted F-numbers
independently and collided three ways (F-167 used by two research-only groups, F-168 by M31's build,
F-169 by M14's research-only citation, F-170 by M5's build) — reconciled by renumbering every
citation to the single round number, F-167, across every touched file (`.ts`, the two new consumer
files, the two new live-test files, `ci.yml`), verified by a repo-wide grep showing zero remaining
F-168/F-169/F-170 occurrences after the sweep. Net: **86 → 80** (5 bound — 4 M39 events via one M5
consumer, 1 M16→M31 event — 1 dropped as misdeclared, 0 added; module count unchanged at 17, no
group fully emptied this round). Verified centrally, once, after all five forks' edits landed
together: `bun run build`/`typecheck` clean (0 errors), `arch:fitness` 38/38
(`arch:outbox-bindings` confirms 80 pairs, down from 86, and 140 live bindings now covering 140
catalogued events, up from 138/139), full non-live suite 654 files / 9603 tests green with no
pinned-array assertions to update this round, a clean `check:boot:platform` run against a freshly
migrated, RLS-enforced disposable Postgres (no new migrations this round — neither build needed a
schema change), both new live suites run individually against the same disposable Postgres+Valkey
(`m31:bereavement-contact-active` 7/7, `m5:consent-privacy` 7/7), and seven sibling regression
suites re-run for regression on every touched shared file (`m31:portal-telehealth-consumers` 10/10,
`m31:bereavement-consent-consumers` 9/9, `m31:bereavement-plan-opened` 6/6,
`m30:bereavement-plan-closed-consumer` 2/2, `m5:admission-siting` 4/4,
`m5:visit-assignment-cache` 8/8, `m5:death-cascade` 3/3). Leaving #248 open — 80 pairs across 17
modules remain.

**A ninth round of four parallel forks fixed a real shared-infrastructure defect in M22's render
pipeline and bound 3 more events off the fix, while the other three forks converged on the same
honest outcome — genuinely re-verified, nothing new to build (F-168, #248).** Targets: the m22
group's own standing "idempotency-key-granularity collision" (first found F-162, re-confirmed
F-166), M30's `no-consumer-surface` group (21 events, never before checked for BUILD rather than
catalog correctness), and a targeted re-check of M11's and M21's 8 remaining events against the
exact upstream facts their standing blockers name. **M22 — the fix, and 3 events bound.**
`decideDocumentRequest`'s `alreadyRendered` fact had always been resolved from
`renderedDocumentForAggregate({aggregateType, aggregateId})` — "does ANY document exist for this
aggregate" — never from the specific delivered outbox event, despite the file's own header comment
naming `(sourceEvent, aggregateId)` as the intended design (F-162's own finding, left unfixed).
That made every SECOND render request against an aggregate that already had one document silently
`idempotent_skip` forever — correct for a genuine crash-and-retry redelivery of the identical
outbox row, wrong for a second, different request event that needs a new document VERSION.
**Re-verified against `outbox-dispatcher.ts` before designing anything**: the delivery receipt is
written in a SEPARATE transaction after `handle()` returns, so a genuine redelivery of the SAME row
can still reach the consumer twice — `decideDocumentRequest` genuinely needs its own dedup floor,
it just had the wrong granularity. Migration 0261 adds `document_version.source_event_id`
(nullable, no FK — `outbox_event` rows are purged past retention and provenance must outlive the
row that requested it, the `render_form_fill_id` precedent) with a plain `UNIQUE
(organization_id, source_event_id)` — NULLS DISTINCT by default, so the many non-request-driven
historical/manual-upload rows coexist freely and only request-linked ones collide — written in the
SAME insert as the version row itself, so the fix is crash-safe by construction rather than adding
a second lost-write window. **The naive single-tier fix (dedup on source-event-id for every event)
was built first and caught its own regression before landing**: `gap-023-024-038-render-handshake
.live.test.ts`'s existing D14 cases simulate a PRODUCER-side duplicate emission (a fresh outbox
row, same order, same content — never a real second signature) and assert exactly one document
results; a pure per-event-id key would have rendered a second version, since a fresh duplicate row
has a fresh id. Redesigned as a two-tier `RequestShape.appends` flag: ~40 GENESIS-only events keep
the exact pre-fix aggregate-level dedup (their source transition fires exactly once per real
occurrence — an order is signed once), and only events whose real transition can legitimately
recur against the same aggregate use the new per-request key. **3 events bound** on the new tier:
`m8.encounter.addendum_signed` (appends onto `.signed`'s `encounter` doc; payload widened with the
same `documentRenderPayload` shape `.signed` already sends), `m14.minutes.amended` (appends onto
`.signed`'s `idg_minutes` doc; payload widened with the same three snapshot columns `.signed`
publishes — caught and fixed its own near-miss before landing: the DENYLISTED
`idg_minutes_amendment.amendment_reason` plaintext was in the first draft's payload, corrected to
keep only its SHA-256 hash on the wire, matching the pre-existing design), and
`m12.medication_order.transmitted` (appends onto `.document_requested`'s `medication_order` doc —
honestly reported as NOT end-to-end working: this event is catalogued with no producer anywhere in
`12-dosespot/`, the `m17.caregiver_reminder_due`/F-161 posture, the binding real and tested against
the real payload shape with nothing yet emitting it). `m12.medication_order.list_changed` was
checked and found NOT the same collision, correcting a stale F-166 framing — its real aggregate is
`patientId` (a med-list render), genuinely different from `.document_requested`'s `orderId`, needing
a new aggregate type and template, real feature scope beyond this fix. `m9.assessment
.summary_requested` and `m6.discharge.cosigned` are now technically unblocked by the granularity fix
but deliberately left unbound — each needs its own product decision about what "a new version" means
for a point-in-time summary and a for-cause discharge cosign respectively, not decided here. **M30's
`no-consumer-surface` group — 1 catalog correction, 20 confirmed genuinely blocked.**
`m9.assessment.recorded`'s F-115 verdict ("no assessment reader exists in `30-quality/`") was
checked against the wrong directory: a real, typed `QualityAssessmentConsumer` seam interface
already exists at `packages/quality/src/seams/consumed/m9-assessment.ts`, matching M30's own
decisive spec text that M9 is seam-pull-only — moved from `declaredConsumers` to `seamConsumers`
at the source rather than left a stale deferral. The other 20 (14 already-swept M6/M15/M23
compliance-window events, plus 6 freshly investigated this round) stay genuinely blocked: two have
no producer anywhere (`m12.medication_order.transmission_failed` — the whole `transmit-newrx`
worker doesn't exist; `m37.ipu_admission.death_recorded` — `recordDeath` is called nowhere outside
its own unit test, and M37 isn't even declared a consumer of the M6 event that would drive it), and
the rest have a real producer but no receiving mechanism on M30's side at any level — measure
registry, seam interface, or consumer table (`m37.restraint.applied`'s own spec claims a
"forward-seam-deny-stub" that was never actually stubbed; the two M16 bereavement events have real
producers but M30's one registered bereavement measure reads a different fact entirely). **M11 and
M21's remaining 8 events — re-checked fresh against the exact specific fact each standing blocker
depends on, all confirmed still genuinely blocked, 0 changed.** `care_plan_intervention
.linked_order_id` is still written by no code path anywhere (still literal `null` on every insert);
no `ConsentEvaluator`/DPOA pull exists anywhere in `11-orders/`; M11's `dme`/`supply` order-kind
contracts are still `contract_not_published`; `PatientAddressReader` still carries no street-address
field; no DoseSpot credential/webhook infrastructure exists anywhere. One fact was checked freshly
rather than assumed unchanged, since real M13 comfort-kit-return-reconciliation infrastructure has
landed since the last check: `m13.comfort_kit.controlled_substance_discrepancy` now IS published, by
a real emitter at true reconciliation time (not bedside-admin time as previously) — but its payload
is still `{deploymentId, medicationOrderId, deltaQuantity, deltaPercent}`, still missing the
`returnId`/`custodyChain` M21's catalogued schema requires, a gap that emitter's own header already
documents as a separate, still-open M21-side blocker this pass does not touch. Net: **80 → 76** (4
bound/corrected — 3 M22 events, 1 M30 catalog fix — 0 dropped; module count unchanged at 17, no
group fully emptied this round). Verified centrally, once, after all four forks' edits landed
together plus one F-number renumbering (two forks independently used F-171 and F-168 for their own
paragraphs; reconciled to the single round number F-168): `bun run build`/`typecheck` clean (0
errors), `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 76 pairs, down from 80, and 140 live
bindings now covering 143 catalogued events, up from 140), full non-live suite 654 files / 9603
tests green, a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable
Postgres (proving migration 0261 applies cleanly and the widened `M22_DOCUMENT_REQUEST_EVENTS`
catalog boots), the new live suite (`f168:document-request-idempotency` 5/5 — proving both halves:
a genuinely new request against an already-rendered aggregate creates a real new version, and a
genuine redelivery of the identical event id does not double-render), and ten sibling regression
suites re-run individually against the same disposable Postgres+Valkey
(`f144:render-requests` 10/10, `f161:m7-m17-render-requests` 4/4, `f166:render-requests` 8/8,
`m6:cop-documents` 6/6, `m27:ecr-backref` 7/7, `m22:document-seam-store` 3/3, `m22:write` 15/15,
`m22:read` 5/5, `m8:write` 50/50, `m14:write` 26/26 — the last two catching real regressions on
first attempt with the naive single-tier design, both green after the two-tier redesign). Leaving
#248 open — 76 pairs across 17 modules remain.

**A five-fork build round, dispatched per the user's explicit "fix them" instruction, bound 3 more
pairs, seeded 2 real consent-cascade types, and left the two riskiest targets — M14's packet-build
worker and the m39 consent-type seed's original `media_release` target — correctly BLOCKED rather
than forced (F-171, #248).** Targets: M12's medication-list render, M14's entire §7.1/§7.2 T-24h
packet-build worker, M11's lab-results back-ref (the group's last M11 event), M5's direct
patient-merge write path, and the consent-type-catalog seed gap behind `media_release`. Each fork
was instructed to refuse rather than guess on any clinical-safety or disclosure-risk ambiguity; the
coordinator independently re-verified every claim (build, typecheck, `arch:fitness`, the full
non-live suite, a disposable Postgres+Valkey, every new live suite run individually, and every
touched shared file's sibling regression suites) before applying anything. **M12's
`m12.medication_order.list_changed` is now bound**: `medication-list-consumer.ts`/
`medication-list-bindings.ts` (the `lab-backref-consumer.ts` shape) resolve the patient's CURRENT
active-medication set via M12's real, already-registered `MedicationOrderProvider.
getActiveMedications` seam at DELIVERY time — never from the delivered diff payload, which cannot
supply full-list content — wrapped in `runWithRequestContext` (the F-118/F-153 "a dispatcher tick is
not a request" shape again) and keyed on `documentVersionForSourceEvent` (F-168's per-request
idempotency granularity) so every genuinely new `.list_changed` event appends a real new version,
never a silent no-op. §7.16 SUD redaction is reused, not reinvented (`MedicationOrderDto.
isSudTreatment` is already on every row). A registry citation this pass corrected: F-168/F-170 had
said `patient_medication_list`'s aggregate type/template "already existed" — true only of
`@wardenx/forms`' separate golden-template-diff registry, never consulted by `render()`/
`REQUEST_SHAPES`; the table `createDocumentRenderer` actually resolves against had no entry at all,
now added (no migration — the enum value has existed since M22-T01). **`m11.order.results_received`
is now bound too**, closing the group's own standing citation of what blocked it: the real registered
`LabObservationReader` interface has always been `getById`/`listByPatient`, and
`lab-backref-bindings.ts` called a `resolveLabResultsPayload` method that never existed — fixed by
ADDING `getByObservationId(organizationId, observationId)` rather than renaming the call, since the
real catalogued payload carries no `patientId` `getById` requires. A real, non-fabricated
`isSudClass` field is now on `LabObservationSeamValue`, projecting the parent `lab_observation.
sud_redacted_at_ingest` column (ingest redacts per MESSAGE, uniformly — never an invented per-row
classifier). Deliberately NOT wired into the generic `REQUEST_SHAPES` pipeline: `lab_results_pdf`
shares `order_record`'s aggregate type with the order-form render already occupying it at sign time,
so the generic genesis-only idempotency would `idempotent_skip` every lab result forever once an
order had ever been signed — the dedicated consumer instead reuses F-168's per-event dedup directly.
Building it surfaced a third, independent, pre-existing defect: `createDocumentRenderer.render()` had
no channel for a per-call retention-class override, so `planLabResultsRender`'s own D23 SUD-promotion
override (`compliance_42cfr_part2`) had nowhere to go despite being computed correctly since M22-T09
— fixed by adding an optional `RenderPayloadCore.retentionClassOverride` field that `render()` now
prefers over the template default (the F-168 `sourceEventId` widening shape again); a SIBLING pipeline
(`medication-list-bindings.ts`) hit the identical gap and explicitly matched the old behavior for
consistency rather than fix it — this pass fixed the shared renderer instead, since leaving a
documented 42 CFR Part 2 compliance mechanism silently inert was worse than the small, additive
widening. `m11.order.results_received` itself still has no production emitter anywhere in the
codebase (`LabResultsApplier`, named in its own catalog description, does not exist) — the binding is
real and tested against the real catalogued payload, the `m17.caregiver_reminder_due`/F-161 shape.
**M5's `m5.patient.merged` is now bound, corrected in BOTH directions at once.** The real §2.4/§4.3
merge write path (`05-patient/merges.ts` + `merges-db.ts`, `POST /api/v1/patients/:id/merge`) had no
execution path anywhere — matching the group's own prior finding exactly. The producer side is now
real: `planMerge` validates every precondition against the §2.4.1 state diagram (self-merge,
already-merged source/target, an unmergeable source status all refuse with typed errors, never
guessed at), resolves each `fieldResolutions` entry against an explicit allowlist of `patient`'s own
mutable demographic columns, and `mergePatients` applies it all in one `withOrgContext` transaction —
the target absorbs chosen fields, the source flips to `merged`/`merged_into_id` with every OTHER row
it owns left completely untouched (no destructive UPDATE on satellite tables, proven live), the full
audit diff lands in `patient_merge`, and the event publishes for real. **The M22 side was checked
against the actual code rather than rebuilt to the group's own prior description**: "a real
per-document `UPDATE document SET patient_id = ...` M22 would have to perform" is false and provably
so — `22-documents/lifecycle/merge-redirect.ts` (M22-T03) is a complete, unit-tested pure core whose
own header states the opposite design, a SEAM PULL against live `patient.merged_into_id` at every
fetch, the M40 `followMerge` shape applied to documents, never a push this event could drive. `m22` is
now a `seamConsumers` entry rather than `declaredConsumers` on `m5.patient.merged` — the fix that
actually stops it deferring forever, since no consumer build was ever the right answer for this pair.
The read-time redirect itself stays genuinely unwired (`resolvePatientRedirect`/
`applyPatientMergeCascade` have zero real callers anywhere in `22-documents/`) — reported, not built,
since it touches M22's read surface broadly and needs its own review. **The consent-type-seed fork
correctly reported its own primary target, `media_release`, BLOCKED rather than force-fitting a seed
row**: `22-documents/` has no `m39.consent.revoked` consumer of any kind (not merely unseeded,
unbuilt), and no schema mechanism can locate "media" documents without guessing (`document`'s
`aggregate_type`/`source_kind` enums carry no photo/video concept distinct from an ordinary clinical
upload; a `mime_type LIKE 'image/%'` heuristic was considered and rejected as the F-102 "guessed
provider entity" mistake applied to PHI photos). Seeding `media_release` anyway was rejected too, per
its own conservative instruction: it would make `cascadeKind` resolve correctly with still nothing to
consume it — moving the blocker from "no seed row" to "seed row, still nothing consumes it," the
"looks fixed, isn't" shape this arc exists to avoid. **Two SIBLING types were seeded instead**, each
checked against its own real, already-bound D7 cascade consumer rather than assumed from spec prose:
`portal_access` (M2's `buildM2ConsentRevokedConsumer`, F-142 + M31's grant-revoke consumer, both live)
and `bereavement_outreach_consent` (M16's `buildM16ConsentRevokedConsumer`, F-151 + the same M31
consumer) — the second row is also what makes `createBereavementOutreachDraft`'s `consent_record.
type_key` FK satisfiable for the first time in any deployment, independent of the cascade question.
**M14's T-24h packet-build worker is real for the first time — the largest, riskiest build in this
arc's history — and, checked directly rather than assumed, its existence does not unblock any of the
group's 8 standing events.** `schedule-materialise.ts` (§7.1 W-SCH-01) and `packet-build.ts` (§7.2
W-PKT-01/§4.9.1 `tminus-24h-build`) are new: real `idg_meeting` materialization from
`idg_recurring_policy`, and the real T-24h cron that resolves §2.3 D9 inclusion and builds each
included patient's packet from real M5/M6/M7/M8 facts plus the F-164 cache, transitioning
`scheduled → packets_building → packets_ready`. Two new M6 org-explicit seams
(`idgPacketInclusionForOrg`, `idgCurrentLevelOfCareForOrg`) and one new M7 seam
(`idgPacketCarePlanContextForOrg`) back it; per the explicit "STOP rather than guess" instruction,
every packet-cover field with no cheap correct cross-module source stays honestly `null`/`[]`/`false`
(HOPE context, flagged events, carry-forward action items, F2F window state) rather than fabricated,
and any patient missing a required fact is skipped via the already-catalogued
`m14.packets.build_failed_for_patient` event, never blocking sibling patients. **This resolves the
group's own standing PUSH-vs-PULL ambiguity for `m6.admission.activated`/`.discharged` decisively in
favor of PULL, and closing that ambiguity is why the pair stays unbound, not a reason to bind it**:
D9 inclusion is answered by the new `idgPacketInclusionForOrg` seam reading `admission` directly at
build time, never `CaseloadProvider` (confirmed, again, to have no location/date parameter) and never
a push cache — there is nothing for either event to write into. The other 5 stay blocked, unchanged
in substance, because building the worker deliberately never touched what each one needs: no field
was added to `PacketFlaggedEventDigest.kind` (M19's `care_plan_change_indicated`), no medication-
history slot was added to `SinceLastIdgInput`/`PacketSnapshot` (M12's `medication_history_pulled`), no
"applied" state or tracking table exists M14/M15-side (the M15 trio), and no compliance-tile concept
was invented (M39's `expiring_soon`) — each the same "do NOT invent a slot the spec doesn't describe"
restraint this pass was explicitly held to. **A cross-fork F-number collision was reconciled
centrally, the F-165 precedent again**: five forks independently minted F-171 (×2), F-172, F-173 and
F-174 for their own citations; renumbered to the single round number F-171 across every touched file
(`.ts` comments, test file names and headers, `package.json` script names, `.github/workflows/
ci.yml`), verified by a repo-wide grep showing zero remaining F-172/173/174 occurrences. **The
coordinator's own verification pass also found two forks had each forgotten to wire their own new
live suite into `package.json`/CI** — `m5-patient-merge.live.test.ts` had no script or CI row at all
(caught by the M14 fork's own `arch:live-suites` run, fixed centrally) and `f171-m22-lab-backref.live.
test.ts` had a script but no CI matrix row (found only by re-checking `ci.yml` directly, since
`arch:live-suites` only checks a script exists for every suite FILE, not that every script gained a
row) — both are exactly the class of gap F-025/F-156 already named this series' own verification step
exists to catch. Net: **76 → 73** pairs (3 bound: M12, M11, M5; 0 dropped; module count unchanged at
17 — the m22 and m5 groups both still carry other declared events). Verified centrally, once, after
all five forks' edits landed together plus the coordinator's own three fixes (the renumbering, the two
missing CI wirings): `bun run build`/`typecheck` clean (0 errors), `arch:fitness` 38/38
(`arch:outbox-bindings` confirms 73 pairs, down from 76, and 142 live bindings now covering 145
catalogued events, up from 140/143), full non-live suite 654 files / 9603 tests green, a clean
`check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres (proving
migrations 0257–0261 all apply cleanly and the real 142-binding dispatcher boots), all five new live
suites run individually against the same disposable Postgres+Valkey (`m5:patient-merge` 11/11,
`m22:medication-list-render` 6/6, `f171:m22-lab-backref` 7/7, `f171:consent-type-seed` 3/3,
`m14:packet-build` 5/5), and thirty-one sibling regression suites re-run for regression on every
touched shared file (`m5:admission-siting` 4/4, `m5:census-scope` 7/7, `m5:consent-privacy` 7/7,
`m5:death-cascade` 3/3, `m5:visit-assignment-cache` 8/8, `m6:write` 12/12, `m6:discharge-cascade` 6/6,
`m6:cop-documents` 6/6, `m6:loc-change-signed` 7/7, `m6:abac-scope` 2/2, `m6:read` 10/10, `m7:write`
23/23, `m7:read` 4/4, `m7:conformance` 8/8, `m7:consent-wiring` 5/5, `m14:write` 26/26, `m14:read`
8/8, `m14:autoclose` 8/8, `m14:since-last-idg-cache` 13/13, `m14:clinical-event-consumers` 3/3,
`m22:render-handshake` 14/14, `m22:write` 15/15, `m22:read` 5/5, `m22:document-seam-store` 3/3,
`f168:document-request-idempotency` 5/5, `f144:render-requests` 10/10, `f161:m7-m17-render-requests`
4/4, `f166:render-requests` 8/8, `m29:nppes-sync` 8/8, `m29:patient-deceased-freeze` 8/8, `m29:
unmatched-lab-review` 15/15, `m28:fhir-gateway` 9/9, `m28:outbox-catalog` 4/4, `m11:write` 11/11,
`m11:downstream-signed` 5/5, `m11:m9-m21-consumers` 11/11, `m11:supply-cancelled` 6/6, `m11:
m12-verbal-expiry` 4/4, `m11:verbal-order-expiry` 6/6, `m12:read` 7/7, `m12:reconciliation-
discontinue` 6/6, `rls:live:m5` 9/9, `rls:live:m6` 17/17, `rls:live:m7` 13/13, `rls:live:m14` 14/14,
`rls:live:m22` 21/21, `rls:live:m28` 11/11, `rls:live:m29` 15/15). **Four pre-existing, unrelated
failures were found and each independently confirmed via `git stash` to predate this round entirely,
identical on clean `main`**: `m12:write`'s `recordVerbal` (`SeamError: seam 'OrderSignatureProvider'
requested before registration` — that test file never registers M11's seam in its own `beforeAll`);
`m12:sync-triggers`'s two DoseSpot-vendor-boundary message/status-mismatch assertions; `m11:read`'s
`verbal_order.effective_at` NOT NULL fixture gap; and `auth:live`'s two pre-existing failures (a
Better Auth two-factor key-derivation error, and TEST-003's `ORGANIZATION_NOT_ACTIVE` 403). Leaving
#248 open — 73 pairs across 17 modules remain.

**F-172 (#248) — five parallel forks each built a specific, named infrastructure gap this arc's own
findings had already diagnosed, rather than re-investigating pairs that were already precisely
scoped**: M35's KMS/`PseudonymKeyProvider` seam, M24's missing `state-channel-health` cron, M37's
missing death-recorded producer, M21's `controlled_substance_discrepancy` payload widening, and M25's
payer-routed claim-matching path. All five landed; net **73 → 66** pairs (0 dropped as misdeclared,
7 resolved: M35's whole group gone, M24's `m25.remittance.claim_paid`/`.claim_denied` group gone,
M37's `death_recorded` bound, M21's `controlled_substance_discrepancy` bound), module count **17 →
15** (m35 and the m24-consumes-m25 group both fully resolved).

**M35 — the KMS/`PseudonymKeyProvider` seam, previously declined twice (F-142, F-167) as "genuinely
new security-critical infrastructure."** On a third look this was too conservative: it is the SAME
already-ratified ADR-0038 application-layer AES-256-GCM envelope pattern a FIFTH time, identical
custody model to `M34_TENANT_KEK`/`TWO_FACTOR_ENCRYPTION_KEY`/`M24_CREDENTIAL_ENCRYPTION_KEY`/
`MESSAGING_ENCRYPTION_KEY`, and the M35 module spec itself (§4.11 D15/§14.3) independently commits to
"the standard WardenX KMS-wrapped DEK pattern." `packages/subscription-billing/src/pseudonym/
key-envelope.ts` mirrors `tenant-kek.ts`'s format exactly, AAD-bound to `(kekId, keyEpoch)` instead of
`(kekId, organizationId)` since there is no tenant on this platform-singleton table; mint-on-first-use
is race-safe via `patient_pseudonym_key_one_active_uq` + `ON CONFLICT DO NOTHING` + re-select, never
an app-level lock; a new `M35_PSEUDONYM_KEY_KEK` required-in-production env var (a SEPARATE secret
from `M34_TENANT_KEK`) backs it, fail-closed when unset. Three previously-blocked consumers are now
live: `m2.session.created` (resolves `userId`→`membershipId` via the M1-owned `memberships` table,
M35's own `dependsOn: [1]`), `m5.patient.deceased` (marks the patient inactive for the current
period), `m5.patient.merged` (marks the survivor active). **Independently adversarially reviewed**
(a dedicated security-review pass, not the building fork's own self-report): verdict SAFE TO SHIP —
confirmed byte-for-byte algorithm/key-size/nonce parity with `tenant-kek.ts`, confirmed the AAD
binding genuinely defeats a ciphertext-substitution-across-epochs attack (live-tested), confirmed the
mint-on-first-use race is genuinely closed (both winner and loser always re-read the DB-committed row,
never use a locally-minted key directly), confirmed `patient_pseudonym_key` has RLS enabled with NO
`wardenx_app` grant at all (the tenant role gets `permission denied`, live-tested) and the provider is
wired off the platform pool, confirmed rotation retains retired epochs rather than deleting them.

**M24 — the `state-channel-health` cron (§4.9), never built** (`registerM24CronWorkers`/
`scheduleM24Jobs` constructed workers that discarded their own `listActiveOrgs()` result without ever
calling the pure `runEligibilityStaleWatchdog`/`runRbDayDailySweep` handlers, and `stateChannelHealth`
had no worker and no handler at all). **The prior F-162 org-scoping objection was reread and found
incomplete, not wrong**: `MedicaidAdapter.healthy()` (platform-scoped, no credentials) is a
DIFFERENT, deliberately platform-scoped method from `OregonGatewayPort.healthy(credentials)`, which
does a real per-credential `GET {portalUrl}/health` keyed `(organizationId, providerEntityId,
serviceState, channel)` — the catalog's non-nullable `organizationId` was correct all along, the
opposite of M23's platform-singleton shape. New `state-channel-health-jobs.ts`: fans out over active
orgs' active trading-partner credentials, probes each live gateway (Oregon only; the other three
Phase-1 states report `null` — "nothing to report", never fabricated as down), and on a genuine
transition emits `.unavailable` (debounced 3 consecutive failed probes per §7.8) or `.recovered`
(immediate, no debounce) — a real in-flight debounce bug (every post-first-failure tick reading
`!prev.up` as "already reported", so no streak could ever reach 3) was caught and fixed by the
fork's own live test before landing. **Two genuine, pre-existing production defects were surfaced and
reported, not fixed (out of this task's scope)**: `submission-jobs.ts`'s `WorkerOutboxPort` is
narrower than the real bound publisher requires (every `runClaimSubmit`/`runClaimPoll` publish site
omits `organizationId`/`aggregateKind`/`aggregateId`, which TypeScript's bivariant method-parameter
checking hides, but which are all NOT NULL on `outbox_event` and would throw at the real insert), and
`CredentialResolverPort`/`buildDrizzleCredentialResolver` captures a `db` handle at construction and
never takes a `tx`, so `deps.credentials.resolve(...)` in those same functions runs OUTSIDE the
`withOrgContext` transaction they otherwise thread everywhere — a likely empty-GUC or silent-empty-read
bug. This file's own two ports were built to the CORRECT shape instead of reusing either. **This
group's `m1`-side follow-up (the platform status-page consumer) stays exactly as unbuilt as before** —
`SystemStatusReader` is still the in-memory, non-shared, per-process stub F-156 found; a future
consumer can now bind to a real, live-emitting producer instead of a house that was never built, but
building it is a separate, smaller task.

**M37 — the death-recorded producer, previously a complete, pure, unit-tested transition
(`transitionAdmission(..., {type: "recordDeath"})`) with NO caller anywhere outside its own unit
test.** `m6.discharge.death`'s catalog entry declared only `["m5"]`; M37 was catalog-unbindable, not
merely unwired. New `37-ipu/consumers/m6-discharge-death.ts` mirrors the sibling
`m6-admission-discharged.ts` precedent exactly: CAS-on-version idempotency, dead-letters on illegal
transitions rather than guessing, auto-opens `ipu_body_release` from facts already on `ipu_admission`
(ARCH-011, no cross-module read). `deathCertifierId` (`ipu_body_release.pronouncing_physician_id`,
NOT NULL) is carried on the widened `m6.discharge.death` payload — already a required, pre-validated
fact at the one real emit site (`checkDischargeNarrative` refuses the discharge upstream without it
for `dischargeType === "death"`), the F-099/F-100 "artifact already in hand at the emit site" shape,
not a new seam. **The redundancy half of this group's own long-standing finding was checked a third
time by direct read and confirmed right**: M16's two real M6-sourced death consumers are both keyed
off the SAME `m6.discharge.death` transaction this new M37 consumer itself reacts to, so a third M16
path off `death_recorded` would arrive no earlier and carry no fact M16 doesn't already have — `m16`
is dropped from `death_recorded`'s `declaredConsumers` at the source (the F-100/F-117/F-134 redundant-
sibling shape), not bound to a consumer that would always no-op.

**M21 — `m13.comfort_kit.controlled_substance_discrepancy`, payload-BLOCKED since F-166/F-168, not
merely unbound.** The catalogued `m21.controlled_substance.discrepancy_detected` schema requires a
non-nullable `returnId` plus a full custody chain — the shape a RECONCILIATION-time discrepancy
carries, and M13's re-emit has in fact fired at true reconciliation time since F-166 (the file header
this replaced was stale, written when the re-emit fired at bedside administration time). `returnId`
was simply never added to M13's wire payload despite already being in scope at the ONE emit site
(`13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation.ts` — that handler IS the
`m21.comfort_kit.return_reconciliation` consumer, so the incoming event's own `returnId` is the
outgoing M13 event's aggregate); widened additively, no cross-module read invented. `custodyChain`
is resolved from the REAL, already-persisted `comfort_kit_returned_content` row (a new `returnId`-
keyed join) plus the `comfort_kit_return` row's own custody columns — both rows are guaranteed to
already exist by the time M13's re-emit can ever fire, because M21's OWN `reconcileReturn` transaction
writes them in the SAME commit that (via the outbox) triggers the M13 consumer this event is re-emitted
from. **Genuinely not redundant with M21's own native `detectionSource: "return_reconciliation"`
emission of the same event**: M13's bedside administration-tracked accounting and M21's dispatched-
vs-returned accounting are two independent discrepancy checks that can legitimately disagree. The
other 2 of this group's 3 pairs were re-checked fresh and remain genuinely blocked, unchanged
(`dme`/`supply` M11 order-kind contract still `contract_not_published`; `PatientAddressReader` still
has no street-address field; DoseSpot infrastructure still a Phase-1 deny-stub).

**M25 — the m24 group's last two events, `m25.remittance.claim_paid`/`.claim_denied`, blocked because
`postAdvice`'s auto-match always matched against the single injected M23 `ClaimSubmissionReader` seam
regardless of the advice's own `payerKind`, so a Medicaid 835 could never resolve a `medicaid_claim.id`
even once a consumer existed.** Fixed by making the candidate lookup payer-routed — `payerKind` was
already on the wire since `receiveAdvice`, so this is routing an existing fact, not inventing a new
matching scheme. New `ClaimMatchCandidateProviderByPayer` map (`medicare`/`medicaid`/`commercial`);
`postClaim`/`postAdjustments` resolve the provider via `claimCandidatesFor(advice.payerKind)`. New M24
published seam `MedicaidClaimMatchProvider` (org+providerEntityId-scoped `candidatesForLine`/
`patientIdForClaim`) — only claim-control-number exact match is possible (no payer ICN/Recipient ID on
the wire per D12/§3.6), documented as a scope limit, not worked around. New M24 consumer
(`outbox-consumers/m25-remittance.ts`), the M23 GAP-037 consumer's Medicaid sibling. **Independently
adversarially reviewed for financial-misrouting risk**: cross-payer misrouting not found (`payerKind`
is read from a persisted, server-set `remittance_advice` column, never client-per-call, and every
routing map lookup either hits a real per-payer provider or a safe `NO_CLAIM_MATCH_CANDIDATES` empty
result — no default-to-Medicare fallthrough); cross-tenant scoping correct (every M24 seam query and
the consumer's own claim lookup filter by `organizationId` inside `withOrgContext`, RLS double-
enforced); ambiguous matches correctly refuse rather than guess (`autoMatch` returns `UNMATCHED` on
>1 candidate). **The review DID find one real gap, fixed centrally before verification**: the new M24
consumer read the claim via a plain `SELECT` and wrote its state transition with no CAS/version guard
at all — unlike its own cited M23 template (`claimRepo.transitionToState`, a genuine optimistic-
concurrency write) — so two genuinely concurrent deliveries could both pass the idempotency check
against the same stale read and both blindly overwrite, risking a duplicate state-history row and a
duplicate `m24.medicaid_claim.paid`/`.denied` emission. Fixed by adding the missing `WHERE version =
$expectedVersion` CAS predicate (a lost race now throws and retries against fresh state, the same
pattern used throughout this codebase's other consumer writes); re-verified against a fresh, isolated
disposable Postgres after the fix, all 7 cases of the new live suite still green.

**Coordination, all found and fixed centrally, none by the building forks themselves**: a cross-fork
F-number collision (four of five forks independently minted F-171, already used by the immediately
prior committed round; renumbered to F-172 across every touched `.ts`/`.yml` file, including two
stray `F-1xx` template placeholders one fork left unfilled, and one test file renamed from an `f171-`
to an `f172-` prefix to match, verified with a repo-wide grep afterward); a genuine test-fixture gap
(`env-validation.test.ts`'s `GOOD` fixture had no `M35_PSEUDONYM_KEY_KEK`, so 14 of its own cases
failed the moment that var became required-in-production — added, matching the `M34_TENANT_KEK`
fixture precedent); a near-miss on `24-billing-medicaid/wiring.ts` (two forks edited it concurrently;
one's `Write` briefly clobbered the other's `registerSeam` call, caught via a live-test failure not a
diff review, re-merged rather than reverted — both halves confirmed present in the final file); the
`m1` group's own reason text for `m24.medicaid_state_channel.*` was stale after M24's build (still
said "no cron infrastructure running at all") — updated to record the cron now exists and only the
M1-side consumer remains unbuilt. Verified centrally, once, after all five forks' edits landed
together plus the coordinator's own fixes: `bun run build`/`typecheck` clean (0 errors), `arch:fitness`
38/38 (`arch:outbox-bindings` confirms 66 pairs across 15 modules, down from 73/17), full non-live
suite 654 files / 9604 tests green, all 5 new/changed live suites green (`m21:comfort-kit-cascade`
12/12, `m13:comfort-kit-deployment` 6/6, `m37:death-recorded` 7/7, `m35:pseudonym-key-provider` 10/10,
`m24:remittance-feedback` 7/7 — the last re-run a second time, alone, against a completely fresh
disposable Postgres after the CAS fix landed, to confirm the fix itself rather than trust timing),
21 sibling regression suites green (`m37:admission-discharged-cascade` 8/8, `m5:death-cascade` 3/3,
`m35:org-lifecycle-consumer` 10/10, `m23:claim-match-seam` 4/4, `m25:835-ingestion` 9/9,
`m24:revalidate-medicare-primary` 6/6, `m24:claim-line-assembly` 9/9, `m24:nf-facility-snapshot` 5/5,
`m21:order-cascade` 6/6, `m21:comfort-kit-replenishment` 8/8, `m13:write` 24/24, `m13:rn-case-manager`
12/12, `m13:read` 5/5, `m13:reconciliation-triggers` 5/5, `m13:admission-discharged-cascade` 5/5,
`m13:scheduled-dose-materialization` 7/7, `m13:m12-draft-order-requested` 7/7), and two clean
`check:boot:platform` runs against freshly migrated, role-provisioned disposable Postgres instances
(one confirming the real 283-migration boot with the new bindings, one directly confirming the M24
state-channel-health cron worker actually constructs when `REDIS_URL` is set). Leaving #248 open —
66 pairs across 15 modules remain.

**F-173 (#248) — the last easy, precisely-diagnosed infra gap this arc had surfaced: M1's
`system_status` reader was still an in-memory, non-persistent stub.** `POST /admin/system/status`
had therefore never once persisted to the real table, in any environment — the composition root only
ever constructed `createInMemorySystemStatusReader()`, a per-process `Map` reset by every restart and
unshared across horizontally-scaled instances. New `createDrizzleSystemStatusReader()` satisfies the
existing `SystemStatusReader` interface unchanged, deliberately ignoring `orgId` for the row key since
the table (per its own header) carries no tenant column at all — the same NON_ORG_SCOPED, no-RLS shape
the two existing outbox consumers (`buildM1LagProbeStatusConsumer`, `buildM1MacPortalHealthConsumer`)
already use to write this table from the outbox side; this store is the admin-route side's independent
twin of that same write path. **Investigated, correctly NOT forced**: whether the two still-declared-
but-unbound `m24.medicaid_state_channel.*` events (F-172 gave them a real producer for the first time)
could now bind onto this same table, mirroring the two existing platform-health consumers. Found a
genuine cross-tenant disclosure risk instead — `GET /api/v1/system/status` requires only
`requireSession()` (no elevated role, no org filter) and returns every row unfiltered, so a per-org
Medicaid-credential-health component would put one tenant's billing-infrastructure status on every
other tenant's shared status page, visible to any authenticated user of any org. Left deferred,
documented in the `m1` group's own reason text. Verified: `build`/`typecheck` clean, `arch:fitness`
38/38 (declared-but-unbound count held at 66/15, unchanged since nothing new was bound), non-live
suite 9604 tests green, new live suite green (`m1:system-status-store` 4/4) plus 3 sibling live
suites re-run individually for regression (`m1:lag-probe-status` 3/3, `m1:mac-portal-health` 4/4,
`m1:feature-flags` 10/10), two `check:boot:platform` runs (the first used a malformed platform-
credential URL and was discarded rather than trusted, redone correctly before accepting the result).
Leaving #248 open — 66 pairs across 15 modules remain.

**F-174 (#248) — a full return to standard investigation cadence across five groups untouched since
early in this arc (m30's two groups, m27, m17, m31, m11), deliberately excluding M29's outbound MLLP
transport worker (held for a dedicated, later multi-agent effort per explicit direction — a real
multi-day build, not a small gap). Net result: 0 built, 0 dropped, all 35 pairs re-confirmed
genuinely blocked** — the clearest evidence yet that this arc has reached its real plateau, not an
illusory one. Every group's `reason` text was updated with a fresh re-verification, several correcting
overstated or stale prior claims rather than merely restating them: **m30's high-priority lead**
(`m37.ipu_admission.death_recorded`, freshly live-emitted by F-172's own new producer) was checked
first and stays deferred for a sharper reason — the event only fires as a downstream effect of
`m6.discharge.death`, and M30's OWN upstream consumer for that transaction (`createMortalityReviewDraft`)
is itself still an unbound `unboundWorkerPort`, so binding `death_recorded` now would race a
still-nonexistent primary mortality-review path for the same death, not merely wire an existing one.
**m27's "hard cross-check" framing was found overstated**: no automated GL-mapping-to-Worksheet-A
pipeline exists anywhere in the codebase to violate — Worksheet A is populated by direct human PUT
today — which sharpens rather than clears the blocker, since M27's own locked spec answers the
identical "vendor invoice not represented in the EHR" problem with a human-entered manual adjustment
line, not an automated consumer, reinforcing that which mechanism M21's case should take is still a
genuine undecided product call. **m31's "no envelope-encrypt capability exists" claim was found
wrong**: M34's shared per-tenant DEK provider is already reused by three other modules and could cover
telehealth-vendor-room ciphertext the same way — the real blocker stays the missing upstream M17
telehealth-setting value, an M17 data-model decision this consumer can't invent. **m31's
`m22.document.rendered` "misdeclared/redundant" framing was corrected to "real, schema-blocked"**: the
target table is a genuine disclosure-view-tracking artifact (§164.528 accounting-of-disclosures),
answering a different question than the existing seam pull, not a duplicate — it stays deferred
because building it means minting M31's first new PHI table since M31-T02, a real schema decision out
of scope for a consumer bind. **m11's DPOA citation was corrected** to the actually-decisive spec
table (M39's own event catalog, not the unrelated revocation-cascade table two prior rounds had cited)
and confirmed genuinely producer-decided-but-unbuilt on M39's own admission, with neither a push
consumer nor a pull seam nor a schema column to build against — unlike M7/M14's already-dropped
siblings, which each had a documented pull alternative. **m17's both pairs** and **m11's care-plan-
intervention trio** were reconfirmed unchanged on direct re-grep (no third EVV bracket-resolution
value, no risk-area producer anywhere in `20-field-safety/`, `linked_order_id` still never written).
Verified per-fork: `build`/`typecheck` clean, `arch:fitness` 38/38 throughout (declared-but-unbound
count held at 66/15 — the round changed zero bindings), full non-live suite 9604 tests green after all
five forks' edits landed together (no live-Postgres run needed — nothing new was bound, so nothing
needed proving against a real database). Leaving #248 open — 66 pairs across 15 modules remain.

**F-176 (#248) — five research-only forks (m22, m14, m31, m11 and the nine small groups), then one central apply,
found exactly ONE buildable pair among the ~35 it re-checked, and 16 more that were misdeclared and came out of the registry (66 → 49).** The
forks were told to change nothing and mint no F-numbers; every verdict below was then re-checked by the
coordinator against the code before applying. **Built: `m6.discharge.cosigned` (m22).** M22's spec (§4.11/§7.17) names
it: a for-cause cosign renders a NEW VERSION of the discharge summary. The append machinery already existed
(F-168: `RequestShape.appends`, per-request idempotency key, `upsertRenderedDocument`'s append branch); what was
missing was the shape, the subscription entry, and a payload M22 could file — the event carried only
`{dischargeEventId, medicalDirectorCosignedAt}`, no chart. The catalog schema now also requires
`admissionId`/`patientId`/`dischargeDate`/`reason` (`patientForAdmission` at the one real emit site,
`cosignDischarge`); the in-memory route service only pushes the event NAME so it is unaffected. The M6 back-ref
stamps `document_id` only while NULL, so v2 never overwrites v1's link; if the filing-time `.created` row is
still undispatched the cosign render becomes v1 and `.created` idempotent-skips (benign). M16's unbound
`decideCosignReceipt` also subscribes to this topic and needs a different payload — widening is additive, so it is
unaffected. Known gap shared with the F-168 append events: `upsertRenderedDocument` does not mark the prior version
superseded. **Dropped/moved (16 pairs; the m29 pair F-175 is resolving concurrently is NOT counted here):**
`m7.intervention.added/.updated/.discontinued` (m11 → seamConsumers: M11's spec PULLS M7 via
`OrderProvider.findByCarePlanIntervention`, and `care_plan_intervention.linked_order_id` is written by nothing, so
the catalog's "M11 links it if an order backs it" condition can never hold);
`m6.admission.activated/.discharged` (m14 dropped, also removed from `M14_OUTBOX_SUBSCRIPTIONS`: F-171's packet
worker answers D9 inclusion by PULL); `m15.plan.bootstrapped/.version_signed` (m14 → seamConsumers: M14's spec never
names M15, M15's own spec makes the packet integration a `DisciplinePlanReader` pull);
`m24.medicaid_state_channel.unavailable/.recovered` (m1 dropped, group deleted: `system_status` is platform-global
with a session-gated read route, so per-org Medicaid-credential health there would show one tenant's channel state
to every tenant — F-172's cron now genuinely produces both events, which is why this needed a fresh look);
`m39.consent.delegated_access.granted/.revoked` (m31: not in M31's §4.10 table, covered by the bound broad
`m39.consent.revoked` consumer, forward-seam pull, and no producer — also removed from
`M31_SUBSCRIBED_EVENT_NAMES`); and from m22: `m11.order.draft_created` and `m12.medication_order.signature_requested`
(no form content in the payload, and a render here would take the genesis-only key and turn the signed
`.document_requested` render into an `idempotent_skip` — binding them would have been actively harmful) plus
`m39.consent.expired/.recipient_added/.recipient_removed` (M22 keeps no signed-URL/subsetter state a push could act
on; `subsetter_dirty_at` is in no schema). **A stale claim corrected:** F-161 said M22 "resolves ConsentEvaluator
fresh on every signed-URL mint" — `signed-url-service.ts` gates only on the external-recipient BAA and
`resolveSudConsentPresent` runs at render time only; the real unbuilt control (a consent re-check at mint) belongs
in M22's mint path, not in an outbox consumer. **Reported, not built:** the two `m39.consent.dpoa.*` events stay
declared for m11 but now have a confirmed NO PRODUCER (`addDpoaAgent`/`updateDpoaAgent` never publish) and M11 has
no DPOA field or decider — do not build the M39 producer while `m11` stays declared and unbound; an m31
post-discharge-grace sweep for the non-death `m6.admission.discharged` branch (new M6 seam + `31-portal/jobs/` +
live suite, needs a sweep-vs-delayed-job decision and a grace default); `m6.transfer.created` (needs a
`discharge_summary_transfer` aggregate type, migration, template and an out-only decision). **Verified:** `build`
and `typecheck` clean, `arch:fitness` 38/38, full non-live suite green after five pinned assertions were updated
(`document-backref-consumers` ×2, `document-consumers`, `document-render-consumer` ×2, `outbox-seam-consumers`),
`check:boot:platform` clean on a fresh migrated DB, and the new live case in `m6-cop-document-renders.live.test.ts`
(7/7) — it FAILS with the request shape removed (one version, not two) — plus `f168:document-request-idempotency`
5/5, `m22:render-handshake` 14/14, `m23:notr-draft` 8/8, `m6:discharge-cascade` 6/6, `m16:discharge-death-secondary`
5/5 and `m6:t4:write` 15/15. **Process notes:** a concurrent agent (F-175, the M29 outbound T08 worker) edited
`scripts/outbox-deferred-consumers.ts`, `events-by-m29.ts` and `index.ts` in the same working tree while this round
ran, so this round committed only its own hunks (the registry was rebuilt from HEAD plus this round's edits rather
than staged whole); and the first live-DB negative test was invalid because a reused disposable Postgres ran out of
lock memory after repeated schema resets ("7 skipped" is a failed `beforeAll`, not a skip) — use a fresh container
with `max_locks_per_transaction` raised.

**F-175 (#248) — the deferred user directive from the F-173 round ("keep going, but once every other group is
exhausted, use subagents to build M29's full outbound MLLP transport worker thoroughly") acted on once F-174
confirmed the real plateau: two parallel forks build the T08 outbound MLLP dispatch worker end-to-end, closing
the `m29` group's last pair (`m11.order.hl7_orm_requested`) outright.** The coordinator did the interface design
itself before dispatching — a shared `MllpTransport`/`MllpTransportSendInput`/`MllpTransportOutcome` contract —
so the two forks (transport client; dispatch worker) could build in true parallel despite the worker depending on
the client's output. **Fork A built `outbound/mllp-transport.ts`**, the real `node:net`/`node:tls` client framing
over the inbound listener's own `encodeMllpFrame`/`MllpFrameBuffer`. Found empirically, not assumed, that
`checkServerIdentity` — the task's own suggested cert-pin enforcement point, since it runs mid-handshake — is
inert on this repo's actual runtime: with `rejectUnauthorized:false` it is never invoked on either Node or Bun,
and with `rejectUnauthorized:true`+trusted `ca`, Node correctly aborts on its returned `Error` but Bun (the real
production runtime) still lets `secureConnect` fire regardless. Switched to a manual, synchronous pin check
inside `secureConnect` (`sha256(DER cert)` via `getPeerCertificate().raw`) run before the frame is ever built or
written — verified reliable on both runtimes, and proven by its own live suite's critical negative test: a
mismatched pin refuses the connection with zero bytes ever reaching the peer. `channelCertPin`'s minting
convention is unconfirmed anywhere else in the repo (every call site treats it as opaque, no minting code exists)
— this file assumes sha256 of the DER encoding, not a re-serialized PEM string (PEM re-encoding isn't byte-stable
across tools), flagged for reconciliation against whatever eventually mints pins in the admin UI. **Fork B built
`outbound/dispatch-worker.ts`** (+ `dispatch-crypto.ts`, `feed-resolver.ts`, `resolve-baa.ts`, `rate-limiter.ts`,
`queues.ts`, `wiring.ts`) orchestrating the already-built pure cores (`dispatch-planner.ts`/`ack-correlation.ts`/
`retry-policy.ts`, all real since M29-T06 but never called by anything — the same "decision core ships, nothing
drains it" shape F-165/F-167 already found here). BAA gate reuses the real M40 `BaaStatusProvider` seam via the
exact `22-documents/outbox-consumers/baa-gate.ts` `getSeam(...)`-opaque pattern (fail-closed on any seam error);
envelope encryption reuses M34's real per-org `getTenantKeyProvider().dekForOrg`/`dekForOrgVersion` (AES-256-GCM,
DEK-version embedded for rotation survivability, AAD binding module+column+org) — the same shape three other
live modules (`hearthnote-crypto.ts`, `portal-crypto.ts`, `consent-crypto.ts`) already use, confirmed by direct
grep against the real `packages/saas-tenant-platform` seam, not assumed. `baa_refused` correctly never emits
`transmission_failed` (no row, alert+audit-intent only — a BAA lapse is transient) — verified directly in the code
and by a dedicated live test. Retry is a poll-based sweep over `idx_hmo_next_retry`, not per-row BullMQ delayed
jobs (the index shape is the strongest signal of original intent, and it survives a Redis flush with zero lost
retries since state lives entirely in Postgres) — the `state-channel-health-jobs.ts` cron-fan-out shape, one
minute cadence. Idempotency is a SELECT-before-INSERT inside the same org-scoped transaction (`idx_hmo_idempotency`
is a lookup index, not a unique constraint — checked against the migration): closes the realistic sequential-
redelivery replay shape (proven by a live test), honestly does NOT close a true concurrent-delivery race, flagged
as a real schema follow-up rather than silently accepted. **Two new real gaps surfaced and added to the `m11`
group rather than built past:** `m29.lab_order.transmitted`/`.transmission_failed` had no catalog entry at all
before this pass (`events-by-m29.ts` — the identical shape, one hop over) and are now correctly catalogued with
`declaredConsumers:["m11"]` (M29's spec §4.4/§4.10 is decisive), but grepping `LabTransmissionApplier` finds only
two doc-comment mentions and no actual consumer anywhere — M29 now publishes both events for real; M11 simply
does not yet read them, a genuine M11-side follow-up out of this task's scope. Two schema gaps also surfaced and
documented rather than guessed past: `external_feed` has no facility-routing column at all (the T-29.08 addendum
sketch assumed one that was never migrated), so feed resolution falls back to "the org's one active
`orm_outbound` feed, fail-closed on zero or ambiguous" rather than routing by `labDestinationFacilityId`; and the
ORM wire's MSH-3/4/5/6 identity fields have no backing columns either, falling back to the feed's own
`displayName` reused three ways. **Coordinator verification (independent of both forks' self-reports, per this
arc's standing discipline):** re-read both new files in full; re-ran the transport's own 10-test live suite
(10/10, no mocks — real in-process TCP/TLS servers including the pin-mismatch negative test); re-ran
`build`/`typecheck` clean and `arch:fitness` 38/38 after all seven new/changed files landed together; re-ran the
full non-live suite (9614 passed, matching the fork's own report exactly); spun up a **fresh** disposable Postgres
(the F-176 round's own process note about a reused container running out of lock memory applied here too) and
independently re-ran the new `m29-outbound-dispatch.live.test.ts` suite (7/7: happy-path AA-ack with the payload
cipher decrypting back to the exact bytes the mock server received, BAA-inactive no-row/no-`transmission_failed`,
AR-reject terminal no-retry, transport-failure schedules-retry-not-DLQ, 5th-attempt DLQ exhaustion, redelivery
idempotency, cross-tenant isolation); re-ran `check:boot:platform` against the same instance with a freshly
double-checked `DATABASE_PLATFORM_URL` (the F-173 lesson about not trusting a "pass" built on a malformed
credential, applied again) — clean, confirming the worker and retry-sweep cron construct at boot. Grep-swept for
F-number collisions: none — both forks were told to use F-175 explicitly and did, needing no renumbering. Net:
**declared-but-unbound drops from 49 (post-F-176) to 50** (the `m29` group's 1 pair resolves, its own group
deleted outright per the F-166/F-176 "group empties → delete" precedent; 2 new pairs land on the `m11` group for
M29's own new outbound events, M11's consuming side unbuilt). Leaving #248 open — 50 pairs across 13 modules
remain.

**F-177 (#248) — builds `LabTransmissionApplier`, the two `m11` pairs F-175 surfaced (`m29.lab_order.transmitted`/
`.transmission_failed`) when it built M29's real T08 dispatch worker, at the user's direct follow-up request.**
Research first (a dedicated fork, kept out of the coordinator's own context): confirmed `order_record` already
carries the full D16 column set (`transmission_status`/`transmission_acked_at`/`transmission_ack_code`/
`transmission_failure_reason`, migrated since M11-T07 — F-175's `fulfillment_status` citation was a stale gloss
from M29's spec prose; the real column is `transmission_status`) and the `order_transmission_status` enum
(`not_required`/`pending`/`pending_retry`/`transmitted`/`failed`) already exists. D16 (locked,
`WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md:2837`) and its own §4.10 event-consumption table (line ~1498, "Either way
emit `m11.order.transmission_status_changed`") turned out to be fully decisive on the state machine and on both
re-published events — no undecided design call remained once the state machine was read in full, contrary to
F-175's own scoping note that this was "a real M11-side feature... a genuine design decision." **A real
spec/producer mismatch surfaced and resolved, not guessed past**: D16's own reference implementation gates
`failed` vs. `pending_retry` on a `willRetry` boolean it expects on the M29 payload — the REAL
`LabOrderTransmissionFailedPayload` F-175 built carries no such field, only
`reason:"application_reject"|"dlq_exhausted"`, and F-175's dispatch worker never publishes
`m29.lab_order.transmission_failed` for a retry-in-progress state at all (a non-terminal transport failure or a
retryable `AE` ack just updates the row and reschedules silently — no outbox event). So `pending_retry` is
UNREACHABLE from this consumer against the real M29 contract as it stands today — every delivery of
`.transmission_failed` this file will ever see is terminal and is applied straight to `failed`; this is the
correct behavior for the actual producer, not a shortcut past the spec. Built
`outbox-consumers/m29-lab-transmission-applier.ts` (mirrors `m21-fulfillment-status.ts`'s idempotent-optimistic-
UPDATE shape): the UPDATE is guarded on `transmissionStatus = <the status just read>`; `transmitted`/`failed` are
treated as already-settled (a redelivery against a settled row silently skips, never regresses); on a terminal
failure it emits BOTH `m11.order.transmission_status_changed` and `m11.order.transmission_terminal_failed` per
D16's own table (never `.transmission_terminal_failed` alone). `orderingPhysicianMdmId` (required by
`.transmission_terminal_failed`'s own payload schema, absent from M29's payload) is read off the same
`order_record` row the consumer already selects, not fabricated. **Two real gaps `arch:fitness`/the live suite
caught, not guessed past:** `arch:outbox-bindings` rule 6 failed on the first run — the two new bindings were
missing from `M11_OUTBOX_SUBSCRIPTIONS` (`11-orders/consumers/index.ts`), the exact F-095 catalog-vs.-source-of-
truth disagreement that constant exists to catch, fixed by registering both; and the live suite's first run
found a genuine DB behavior, not a test bug — the RLS migration's §3.4 "lab-initial-states" trigger forces a new
`kind='lab'` row's `transmission_status` to `'pending'` at INSERT time regardless of what value is inserted
(proven directly against a live container: an INSERT carrying `'failed'` came back `'pending'`), so the live
suite's seed helper had to insert-then-update rather than seed the starting state in one INSERT. Verified: `build`/
`typecheck` clean, `arch:fitness` 38/38 (declared-but-unbound: 50 → 48, the `m11` group's two m29 pairs resolved,
its two `m39.consent.dpoa.*` pairs remain), full non-live suite green (9614, after updating one pinned
`M11_OUTBOX_SUBSCRIPTIONS` assertion), new live suite `m11:lab-transmission-applier` (7/7) proven against a fresh
disposable Postgres, `check:boot:platform` clean with a double-checked platform credential URL.

**F-178 (#248) — Phase 1 of the M30 20-pair no-consumer-surface group, the user's own explicit scope: the M6
compliance/F2F cluster. Three parallel forks (a shared interface contract designed centrally first, mirroring the
F-175 `MllpTransport` pattern), then one central verify-and-reconcile pass.** Built the real
`ComplianceWindowCountsProvider` seam M30's spec has long claimed (§7.5 W-OVR-02) but that was never actually
built — `packages/quality/src/seams/consumed/m6-compliance-window.ts` (the consumer-side interface,
`f2fWindowOnTimeCounts`/`f2fWindowOverrideCounts`, each `{numerator, denominator}` over a
`{orgId, providerEntityId?, fromIso, toIso}` scope) and
`apps/backend/src/modules/06-admission/seams/compliance-window-counts-provider.ts` (the Drizzle-backed
implementation, registered as `"ComplianceWindowCountsProvider"` via the existing `registerAdmissionSeams(deps.db
? {db, ...} : {})` call at the composition root — no new boot wiring needed). Deliberately F2F-scoped
(`windowKind = 'f2f_recert_30d_prior'` only, joined to `admissions` for the optional `providerEntityId` narrow —
`compliance_window` itself has no such column), matching the user's own Phase-1 scope decision, which explicitly
deferred M23's NOE/NOTR `window_breached` pair (needs a persistent breach-log table, a different shape), M6
`admission.on_hold`/`.resumed` (a live dashboard pull, a different shape), and `m6.applier.refused` (may not be a
quality measure at all) to later rounds. Two new M30 measures consume it —
`f2f_window_on_time_rate`/`f2f_window_override_rate` (`packages/quality/src/measures/operational/`), registered
in both `MEASURE_CATALOG` (`registry.ts`) and the calculator-binding map (`registrations.ts` — the catalog
descriptor alone does not make a measure computable; missing this would fail closed with
`MeasureRegistrationMissing`) and wired into `m30-jobs.ts`'s `resolveOperationalMeasureInput` switch + the
`getSeam("ComplianceWindowCountsProvider") as never` call site, with platform-default thresholds (0.95/gte
on-time, 0.05/lte override — no CMS-published floor exists for either, CoP 418.22 mandates the F2F encounter
itself, not a specific closure percentage). **A real scope-overclaim caught in central verification, not
committed past:** the build-side fork's first pass moved all 6 of the group's M6 compliance-window pairs to
`seamConsumers`, but 4 of them — `m6.compliance.window.opened/closed/overdue/overridden` — are GENERIC across all
11 `complianceWindowKind` values (payload carries `windowType`, not just F2F; M6's own spec, line 3868, confirms
non-F2F kinds are real and actively created today — `concurrent_hospital_admission`, `external_discharge_notice`,
`hl7_admission_cancellation` informational windows), while the new seam's WHERE clause reads nothing outside
`f2f_recert_30d_prior`. Corrected before commit: only the two truly F2F-specific events —
`m6.f2f.window_overridden` and `m6.f2f.window_missed` — are genuinely resolved by this seam and dropped from the
group; the four generic events stay `declaredConsumers: ["m30"]`, genuinely unbound, since the real relationship
they represent (M6's spec, lines 2322/2330/3047 — a general compliance-window dashboard pull across every window
kind, including an all-kind "Overrides — last 30 days" widget) is a different, larger, still-unbuilt seam than
the F2F-scoped one this round shipped.

**F-178b (#248) — `m6.f2f.window_missed` had NO PRODUCER anywhere in the codebase before this round** (the pure
decider `decideF2fWindowStatus`, `certification/window-math.ts`, correctly implements "an attested F2F closes the
window; otherwise, once the org-local day passes `windowEnd`, the window is missed" but shipped with zero
callers — the file's own doc comment said "the caller emits `m6.f2f.window_missed`" while no such caller existed,
the identical "decision core ships, nothing drains it" shape this arc keeps finding). Built a periodic scan
(`runF2fWindowMissedScanCron`, `jobs/cron-workers.ts`) on the previously-declared-but-never-wired
`M6_QUEUES.windowAlert`/`M6_JOB_SCHEDULES.windowAlert` (every 15 min) — the first work on that queue, distinct
from `planWindowAlert`/`promoteWindowStatus`'s other window kinds, which assume a `compliance_window` row is
already open and only promote its status; no code path ever opens an `f2f_recert_30d_prior` row (only
`attestF2f`'s `close_window` effect touches that kind, and only as a no-op close), so this scan computes the
window itself off the PRECEDING recert election period's `scheduled_end_at + 1 day` (a not-yet-active period's
own `effective_at`/`scheduled_end_at` are unpopulated until it activates) and OPENS the row itself the moment
`decideF2fWindowStatus` first reads "missed", reusing the real decider rather than reimplementing it. Idempotent
by construction, not by an application-side check: the INSERT targets the existing partial unique index
`cw_adm_kind_open_idx` (`UNIQUE (admission_id, window_kind) WHERE status <> 'closed'`) via `onConflictDoNothing`,
so only the tick that actually opens the row publishes the event; a later `attestF2f` closes it through its
pre-existing effect, unchanged. **A real, unrelated production bug found and fixed along the way**: this is the
first M6 cron to write to an M4-audited PHI table, and `M6_WORKER_SYSTEM_USER_ID` (the synthetic system-actor id
all three M6 crons share) was never seeded as a real `user` row, so the audit trigger's FK 23503s on the very
first tick — fixed by using `userId: ""` (the established `withOrgContext` system-write idiom already used
throughout `admission-route-service-db.ts`) for this call site only; the two sibling scans are untouched since
neither writes to an audited table. Flagged, not fixed: the same latent defect likely affects
`*_WORKER_SYSTEM_USER_ID` in the ~8 other modules whose system-actor crons don't yet touch an audited table.

Verified centrally across all three F-178/F-178b forks (not trusting individual self-reports): `build`/`typecheck`
clean, `arch:fitness` 38/38 (declared-but-unbound: 48 → 46 — the two genuine F2F pairs, not all 6), full non-live
suite green (655 files / 9622 tests, 0 failed), the new live suite `test:m6:t5:counts:live` (6/6) and the extended
`test:m6:t5:write:live` (6/6, 3 new F2F-window-missed producer tests alongside the original 3) both proven against
a fresh disposable Postgres, `check:boot:platform` clean with a double-checked platform credential URL.

**F-179 (#248) investigated the general (all-window-kind) compliance-window dashboard-pull relationship F-178
correctly left deferred, and dropped all four remaining `m6.compliance.window.*` pairs as misdeclared, not merely
unbuilt.** `packages/types/src/admission.ts` DOES pre-declare a real, typed `ComplianceReader` interface
(`listOpenWindows(scope): Promise<ComplianceWindowSummary[]>`) matching M6 spec §4.7's decisive text verbatim —
but it is a pure aspirational leftover: never registered in `SeamName`, no deny-stub, no implementation anywhere,
and the `apps/backend/src/modules/06-admission/readers/` directory the spec names for it does not exist. No
M30-owned route, seam, or UI screen spec consumes it either — `docs/design/screens/` has no M30 "operational
dashboard"/open-windows screen at all. What the M6 spec's "M30 dashboard pulls open windows"/"Overrides — last 30
days" prose (line 2322/2330/3047) actually describes is already fully live: `GET /api/v1/compliance-windows`
(`admission-routes.ts` route 44) is an org-wide, all-window-kind, filterable REST read, gated by
`compliance.read`/the `compliance.scope` ABAC predicate — itself documented as "org-wide for compliance_officer,"
the exact persona a compliance/quality dashboard would use. This is a direct frontend-to-M6 REST call, not a
backend module-to-module relationship — nothing for the outbox/seam registry to track. Dropped `m30` from
`declaredConsumers` on all four (`events-by-m6.ts`), not moved to `seamConsumers`: there is no seam to move it
to, and building one (the pre-declared but unregistered `ComplianceReader`) would ship a seam with no caller —
the identical "decision core ships, nothing drains it" shape this arc keeps finding, in the opposite direction.
Caught before a build was dispatched: the user approved this round's topic as "build the general seam," but
fresh research surfaced the REST route first, so the actual, smaller, correct action (a catalog correction, not
a new seam) was confirmed with the user before proceeding. Verified: `build`/`typecheck` clean, `arch:fitness`
38/38 (declared-but-unbound: 46 → 42), full non-live suite green (655 files / 9622 tests, 0 failed) — a pure
catalog/comment correction with no runtime behavior change, so no live-suite or `check:boot:platform` re-run was
needed.

**F-180 (#248) — four parallel research-only forks re-checked the remaining previously-deferred M30 items** (M6
`admission.on_hold`/`.resumed`, `m6.applier.refused`, M23 NOE/NOTR `window_breached`, and M15's 4 events) against
current code rather than re-asserting prior framing, then one central verify-and-apply pass. **Dropped 6 of 9
investigated pairs as misdeclared**, all for the same root reason — M30's own LOCKED spec is decisive on exactly
what it consumes and none of these six appear in it, with no supporting seam method or measure code either:
`m6.applier.refused` (M6's own spec places it beside a Prometheus gauge, "dashboard data source" — an
ops/observability framing, not a cross-module business-fact handoff; already durably audited independent of any
consumer via the live `m6.applier.contract_violation_refused` action); `m23.noe.window_breached`/
`m23.notr.window_breached` (the breach fact is a real, persisted `windowBreachedAt` column on both
`noe_record`/`notr_record`, already served by a direct REST read — `GET /api/v1/noe-records`/`notr-records`, the
F-179 shape exactly — plus M36 critical-severity alerting and, for NOE, M33's bound
`mv_noe_window_breach_org_month` materialized view; NOTR carries the identical `seamConsumers: ["m33"]` catalog
claim without a matching M33 subscription-map entry, a real asymmetry flagged for its own follow-up, out of this
pass's scope); `m15.plan.version_signed` (kept its real `m22` consumer, only `m30` dropped), `m15.plan.discharged`,
and `m15.discipline_assessment.amended` (M30's own §1.2 names exactly 4 `DisciplineComplianceProvider` measures —
supervisory/MSW/chaplain on-time, volunteer-gate — as its real M15 consumption; none of these three events is
among them, and the producer-side catalog comments asserting otherwise, e.g. "M30 re-measures," were unverified
guesses this pass checked and found unsupported). **Confirmed still genuinely unbound, not misdeclared:**
`m6.admission.on_hold`/`.resumed` (M6's spec uses the identical "M30 dashboard" phrasing F-179 resolved for
compliance windows, but the REST-resolution check does NOT apply here — `holdReason`/`holdAt`/`releasedAt` are
write-only everywhere in `06-admission/`, never selected by any existing read path, so unlike
`GET /api/v1/compliance-windows` there is no already-live REST route serving this data; a real build gap on both
the M6 reader side and the M30 consumer side) and `m15.volunteer.ratio_recomputed` (the M27
`staffPatientCareMinutes` blocker was independently re-verified as still current, not stale — M27 ships no hours
seam anywhere). Verified: `build`/`typecheck` clean, `arch:fitness` 38/38 (declared-but-unbound: 42 → 36), full
non-live suite green (655 files / 9622 tests, 0 failed) — another pure catalog/comment correction with no runtime
behavior change. Leaving #248 open — 36 pairs across 13 modules remain.

disposable Postgres, `check:boot:platform` clean with a double-checked platform credential URL. Leaving #248 open
— 48 pairs across 13 modules remain.

**F-181 (#248) — M29 outbound schema follow-ups: a feed→destination link, dedicated MSH identity columns, and the
concurrent-redelivery race (fork B of the F-175 follow-ups).** F-175's resolver documented two schema gaps it had
to work around and one race it could not close. **Routing:** `external_feed` had no column linking a feed to the
lab it delivers to, so `OrmRequestedPayload.labDestinationFacilityId` was ignored and dispatch required exactly one
active `orm_outbound` feed per org. Migration 0262 adds `lab_destination_facility_id` (a LOGICAL M40 facility id, no
FK across the module edge; partial index on `(organization_id, lab_destination_facility_id)`), and the resolver's
pure `selectOutboundFeed` now routes by it. The single-feed fallback survives ONLY for exactly one candidate whose
link is genuinely NULL (a pre-F-181 tenant); a sole feed linked to a different facility never receives another
destination's order (`no_feed_for_destination`), two feeds linked to one facility are `ambiguous_feed`. The retry
sweep now resolves each queued row's OWN feed (`resolveById`) instead of demanding a sole feed, so adding a second
feed no longer stalls rows already bound to the first. **Identity:** `msh_sending_application`/`_sending_facility`/
`_receiving_application`/`_receiving_facility` replace the `displayName`-for-three-fields fallback; each is
CHECK-constrained (1–180 chars, no `| ^ ~ \ &` and no control characters, so a value cannot break segment framing).
MSH-3 alone defaults to the fixed platform identity `WARDENX` (a constant, not a guess). A feed missing a required
field is REFUSED: the worker alerts and throws `OutboundFeedIdentityIncompleteError` (feed id + FIELD NAMES only), so
the outbox dispatcher retries and dead-letters for redrive rather than silently dropping the order the way the
`no_active_feed`/`ambiguous_feed` refusals do — it is an operator-fixable gap on the right destination. The admin
create/update/detail routes, OpenAPI enrichment and typed client carry all five fields. **Idempotency, and a
deliberate deviation from "add a unique index":** `hl7_message_outbound` is PARTITIONED BY RANGE (`queued_at`), and
Postgres requires any unique index on a partitioned table to include the partition key — a `UNIQUE (organization_id,
idempotency_key)` cannot exist, and one that included `queued_at` would never collide (each attempt stamps its own
time). The race is closed instead with a transaction-scoped advisory lock on `(org, idempotency key)` taken before
the existing SELECT: a concurrent redelivery queues behind the first and its SELECT (a fresh READ COMMITTED
snapshot after the lock is granted) sees the committed row. The new live case FAILS without the lock (two rows, 3
of 3 runs) and passes with it. If a database-level guarantee is ever wanted (a non-worker writer), the honest
options are a tiny non-partitioned `(organization_id, idempotency_key)` guard table or a non-partitioned outbound
table — both new-table work, not attempted here. **Residual, unchanged:** the DER-vs-PEM `channel_cert_pin`
convention is still an assumption nothing mints, `mllp_plain` still has no production guard, and the M11
`hl7_orm_requested` emitter is still unbuilt (fork C). Verified: `build`/`typecheck` clean, `arch:fitness` 38/38,
`m29-outbound-dispatch.live` 13/13 (7 existing + 6 new: facility routing, no-fallback refusal, configured MSH
identity on the wire, identity refusal, concurrent redelivery, MSH CHECK + cross-tenant RLS on the new columns), the
new `m29-feed-resolver` unit suite, and `check:boot:platform` clean on a fresh migrated database.

**F-181 (#248) — the PRODUCER of `m11.order.hl7_orm_requested`: the middle of the lab-order pipeline F-175 (M29's
T08 worker) and F-177 (M11's `LabTransmissionApplier`) built either end of, and that nothing had ever fed.** A
signed lab order never became an HL7 ORM and `transmission_status` never left `pending`: F-120 had left `lab`
unbound because `OrmRequestedPayload` needs patient demographics, a resolved M40 physician and a destination
facility, none of which M11's own tables hold. Built in one branch (`f178-m11-orm-emitter`): on SIGN of a lab
order, in the SAME transaction, `emitOrmRequested` (`orders-route-service-db.ts`) gathers the facts through THREE
injected ports (`orm-request/orm-requested.ts` — pure decision core + port shapes; `orm-request/ports.ts` — the
default binding) and publishes through the real catalog-validating publisher. **The ports:** `patient(tx, org,
patientId)` is a NEW M5-owned seam function `hl7OrmDemographicsInTx` (M11 has no `dependsOn` edge to 5, so it is
injected, never imported; it runs on the caller's tx rather than opening its own `withOrgContext`, because a
second pooled connection beside the sign tx risks pool exhaustion); `physician(org, mdmId)` reads M40's
`MdmEntityProvider.resolvePhysician` and returns an NPI only for an NPI-anchored canonical with a well-formed
10-digit value; `destination(tx, org, {routingLabId})` requires an ACTIVE M40 facility (the order's own optional
`data.routingLabId`) — `labDestinationFacilityId` must be a facility because M29's D16 BAA gate runs on exactly that
id — AND, until fork B's feed↔facility link lands, exactly one active `orm_outbound` feed (the only routing M29
supports), refusing `no_active_feed`/`ambiguous_feed` at sign time rather than emit an event M29 would only alert
on and drop. Only that last half changes when B lands; the port shape does not. **REFUSE, NEVER FABRICATE.** Any
unresolvable fact leaves the order signed, sets `transmission_status='failed'` with `orm_refused:<reason>` in the
existing `transmission_failure_reason` column (no migration), and fires `m11.order.transmission_terminal_failed`
(`transmittedAttempts: 0`) so M36 alerts the ordering provider; NOTHING partial is ever published. The reasons:
`sud_restricted` (42 CFR Part 2 — F-035 D3 makes SUD redaction default-ON at every egress; the M5 flag is
FAIL-CLOSED including an invalidated/stale snapshot, and the gate runs before any demographics are copied into a
payload), `patient_not_found` (also another tenant's patient — the read is org-scoped), `patient_merged`,
`patient_mrn_missing`/`patient_name_missing`/`patient_dob_missing`, `patient_sex_unrecorded` (M5's default `UNK`
means "nobody asked" and is NOT turned into HL7 `U`; an explicit `U` passes) / `patient_sex_unmappable`,
`physician_unresolved`/`physician_not_active` (deactivated)/`physician_npi_unconfirmed` (provisional, or no
NPI)/`physician_name_missing`, `lab_test_codes_missing`/`multiple_test_codes_unsupported` (the payload carries ONE
`observationIdentifier`, so a multi-test order would silently lose tests — refused instead),
`no_routing_lab`/`lab_facility_unresolved`/`no_active_feed`/`ambiguous_feed`, `payload_invalid` (the assembled
payload is `Value.Check`ed against the catalogued schema BEFORE publishing, so a schema defect refuses the ORM
instead of throwing out of — and blocking — the sign), and `dependency_unavailable` (a port threw; a lab-routing
hiccup must never fail the sign). **Minimum necessary:** the ORM carries `collectionInstructions` and a
"FASTING REQUIRED" note as NTE lines (a specimen cannot be collected without them) and deliberately NOT
`clinicalJustification` or `notes` (free text that routinely holds diagnoses). `internalMrnAuthority` is
`WARDENX-<organizationId>` — M5 stores no issuer for the internal MRN and the MRN is unique per organization, so
the tenant IS the assigning namespace (a label, not a demographic fact; flagged as an assumption). Priority maps
`stat→S`, `asap→A`, else HL7's own default `R` (null is "unspecified", not a clinical fact). **Composition root:**
`mountOrderRoutes(app, db, outbox, buildM11OrmRequestedPorts({ patient: hl7OrmDemographicsInTx, feeds:
buildDrizzleOutboundFeedResolver() }))` — `arch:boundaries` caught the first draft, which put this binding in
`bootstrap/` (module 1 may import no feature module), so M5 and M29 arrive as injected deps and only M40 (which M11
may import) is bound in M11's own directory. Without the ports (unit tests, the standing/verbal workers) a signed
lab emits nothing, exactly as before. **Proven live** (`m11-orm-requested.live.test.ts`, 17/17, real Postgres as
`wardenx_app`): the whole chain — real M11 sign → real publisher → real dispatcher → M29's real T08 worker with a
stub `MllpTransport` (the only fake) → `m29.lab_order.transmitted` → F-177's applier — ends with the order
`transmitted`/`AA` and a wire containing the MRN, name, NPI and LOINC code; twelve refusal scenarios (every one
asserts the order is still `active`, `failed` with the typed reason, the alert fired, and ZERO wires sent); a
non-lab order emitting nothing; the no-ports default; and cross-tenant isolation through org B's own connection. **14
of the 17 fail with the producer disabled** (the 3 that pass are the control cases), and 31 unit cases pin the pure
core. **Residual risks, stated not hidden:** (1) `resolvePhysician` opens its own pooled connection while the sign
tx holds one, so pool saturation under many concurrent signs could stall — the M5 read avoids this by running on
the caller's tx, M40's seam cannot; (2) a refused order has no resend route — the alert tells a human, but nothing
re-attempts the ORM after the missing fact is fixed; (3) `mllp_plain` is unguarded outside tests (F-175's note
stands); (4) the `channelCertPin` DER-sha256 convention is still an unconfirmed assumption; (5) SUD detection is the
patient-level M5 flag only — there is no classifier for a SUD-class ORDER (e.g. a drug-screen LOINC), so a
non-restricted patient's SUD test order is transmitted; consent-aware release for a restricted patient is a
follow-up, today it is a flat refusal; (6) `routingLabId` is optional on the lab kind, so every lab order without one
is refused until the feed↔facility link makes a default destination derivable.

**F-182 (#248) — inbound `mllp_plain` refused in production (the twin of F-181's outbound guard).** F-181 fork A
refused cleartext `mllp_plain` for the OUTBOUND worker only and left inbound feeds untouched, but an inbound plain
listener is the same PHI-on-the-wire exposure (a partner ADT/ORU feed over a plain socket). The rule is now one
decision, shared: production is never allowed (the `M29_ALLOW_MLLP_PLAIN` opt-in is ignored there, and boot already
refuses to start with it set); non-production needs the explicit opt-in; every caller defaults to the
environment-derived answer, so a supervisor or registry built without the option FAILS CLOSED. Three layers:
(1) **admin routes** — `assertProtocolAcceptable` no longer keys on `kind === 'orm_outbound'`: in production a create
or an activate of ANY `mllp_plain` feed is a 422 `PLAIN_MLLP_REFUSED` (protocol is immutable after create, so a feed
made before the deployment became production is caught at activate); (2) **supervisor** — `startFeedListener` refuses
a plain feed before the BAA gate is even consulted, logs `hl7.listener.plain_refuse` and raises a critical compliance
alert whose text carries the feed/org ids only (no host, port or sending-facility allowlist), outcome reason
`plain_protocol_refused`; (3) **the bind point** — `createTlsListenerRegistry.start` throws `PlainListenerRefusedError`
before `net.createServer`, so a caller that bypassed the supervisor still binds nothing and never loads a credential.
New `listener/protocol-policy.ts` reuses F-181's `resolveDestinationPolicy`/`checkProtocol` (no second copy of the
production test). No migration, no API shape change (openapi/client untouched). Note: this tree does not yet compose
the inbound listener process from `apps/backend/src/index.ts` (the supervisor's real `main()` is still deferred per the
`listener/index.ts` header), so the guard sits at the two points any such composition must pass through.
Verified: 105 unit tests across the new `m29-inbound-plain-guard.test.ts` (policy, supervisor gate, a REAL-socket
registry that must refuse and leave the port closed, plus a control that an opted-in non-production listener still
binds), the extended route suite and the env suite; with the three guards disabled 7 of the new cases fail (all three
layers) and the controls still pass. **Residual:** the `M29_ALLOW_MLLP_PLAIN` opt-in is one switch for both
directions (a non-production deployment cannot allow one and not the other); `mllp_plain` inbound in non-production
still needs the loopback/private-address hygiene of the deployment, since the listener binds `0.0.0.0`.

**F-182 (#248) — RESEND of a refused lab ORM: the operator's way out of F-181's "refused, then stuck".** F-181's producer
refuses (never fabricates) when a fact the HL7 ORM needs is unresolvable at sign time — order still `active`,
`transmission_status='failed'`, `transmission_failure_reason='orm_refused:<reason>'`, M36 alert fired — and, the residual
risk F-181 named, nothing ever re-attempted once someone fixed the fact. `POST /api/v1/orders/:id/resend-transmission`
(`orders.amend`: RN Case Manager, MD/NP/PA, Medical Director, Clinical Supervisor — the roles that can correct an order,
so no new permission key and no role-grant seed; no step-up, because the order was already signed for exactly this
transmission and a resend discloses nothing new) re-runs the SAME producer over the SAME ports and returns
`{outcome: 'requested' | 'still_refused', refusalReason, order}`; anything not resendable is a 409. **One transaction:**
`SELECT … FOR UPDATE` the order row, classify (`orm-request/orm-resend.ts`, pure), resolve, then on success a
CONDITIONAL update (`WHERE transmission_status='failed' AND reason = <the one read>`) back to `pending` + one
`m11.order.hl7_orm_requested`, so a caller never observes `pending` without the request or the reverse. **Still
refused:** the recorded reason is refreshed if the blocker changed, nothing is published and NO second alert is raised
(the provider was alerted at sign). **No per-attempt idempotency key is needed:** M29's key is `(feed, 'orm', orderId)`
and a refused order never reached M29, so it has no outbound row to collide with — which is also exactly why an M29
terminal failure (`dlq_exhausted` / `application_reject`, written by F-177's applier) is NOT resendable: that message WAS
built and sent, and re-emitting would create a second one. **Never resendable, on purpose:** `sud_restricted` (42 CFR
Part 2 — a disclosure gate, so lifting it is a compliance decision, not a data fix; a resend button any RN could press
would be a de-facto override, and clearing the M5 flag does not make it one) and the three refusals whose fact lives in
the IMMUTABLE signed order (`lab_test_codes_missing`, `multiple_test_codes_unsupported`, `no_routing_lab` — re-running
cannot change the answer; the remedy is `POST /orders/:id/correct`). **Audit:** the route puts the Better Auth USER id
on the transaction (`audit_event.actor_user_id` FKs `user`, so the membership id the rest of M11 passes would violate
it), and the M4 trigger records the `order_record` update `failed/orm_refused:x → pending` with that actor; no PHI in
any log or message (the reason is a fixed producer token). No migration. **Proven live**
(`m11-orm-resend.live.test.ts`, 15/15, real Postgres as `wardenx_app`, real publisher, real dispatcher, M29's real T08
worker over a stub `MllpTransport`): refused (sex unrecorded) → the M5 row is fixed → resend → one request → wire →
applier → `transmitted`/`AA`; a fixed feed refusal resends too; still-refused publishes nothing and alerts nobody; a
changed blocker refreshes the reason; two CONCURRENT resends dispatch exactly one message; a delivered order, an M29
terminal failure and a non-lab order are 409; SUD (before and after the flag is cleared) and no-routing-lab are 409;
another tenant's order and an unknown id are 404; the audit row names the user. **Negative tests:** with BOTH
concurrency guards removed the concurrent case fails 3 of 3; each guard ALONE holds the suite at 15/15 (they are
independent); without the `orm_refused:` prefix check the M29-terminal case fails; without the SUD check the SUD case
fails. 35 unit cases pin the classifier and the HTTP contract (403 without `orders.amend`, 401, 404, 422, 409).
**Residual risks, stated not hidden:** (1) it is explicit only — there is no automatic sweep, deliberately (a retry loop
against a non-transient refusal would re-alert); an operator has to know to press it, and nothing yet surfaces the
`orm_refused:*` orders in a queue or the UI; (2) `allowedActions` on the order detail does not advertise `resend`, so a
client must infer it from `transmissionStatus`; (3) the in-memory order service (unit tests / the standing workers)
always refuses a resend, because it has no producer; (4) a resend re-reads the order's ORIGINAL `signedAt` as
`requestedAt`, not the resend time, which is the order's request time but not when this attempt happened; (5) the
M40 physician lookup still opens its own pooled connection while the resend tx holds one (F-181's residual pool note
applies unchanged).

**F-182 (#248) — M29 outbound: the `in_flight` lease and reclaim sweep.** The premise this fork was given ("a worker that dies mid-send leaves the row stuck `in_flight`") was FALSE for the code as F-175 shipped it, and finding that was the point: `handleOrmRequested` ran the insert, the `in_flight` write, the socket send and the outcome write inside ONE `withOrgContext` transaction, so a crash mid-send rolled the whole row back — there was no committed `in_flight` row to sweep, and the outbox redelivery inserted a FRESH row with a NEW MSH-10 (a possible second order at the lab, the worst outcome). The only committed `in_flight` rows F-175 could produce were the ones the ack-correlation "log + discard" branch left behind when an ack came back for a different MSH-10 — stranded forever. A reclaim sweep over that alone would have been near-dead code, so the worker was restructured to **claim → send → finalize**: the `in_flight` claim commits (with `next_retry_at` as a LEASE expiry, default `OUTBOUND_IN_FLIGHT_LEASE_MS` = 5 min, >7x the 10s connect + 30s ack worst case) BEFORE the socket, the send holds no transaction, and the outcome lands in a second transaction whose writes carry a **claim guard** (`status='in_flight' AND retry_count = <at claim>`), so a slow worker that lost its lease writes nothing and publishes nothing. **The duplicate-send decision:** a reclaim is a pure STATE TRANSITION, never a send — `queued` again with `retry_count + 1` and the shared backoff (`decideInFlightReclaim` reuses `decideRetry`), so the existing retry pass re-sends the STORED wire, i.e. the SAME MSH-10, and a receiver that already processed the crashed attempt can dedupe on it (at-least-once on the wire, one order at the lab); every reclaim draws on the shared 5-attempt budget and the last one goes terminal `dlq` with `m29.lab_order.transmission_failed` so M11 (F-177) marks the order failed and a human verifies with the lab — an outcome that stays unknown is never re-sent forever; every reclaim raises an operator alert. Reclaim and the retry claim both use `FOR UPDATE SKIP LOCKED` plus a conditional UPDATE, which also fixes a latent F-175 defect: two overlapping retry sweeps both read a row `queued` and both transmitted it. No migration (the lease reuses `next_retry_at` and the existing `(status, next_retry_at)` index) and no new wiring (the reclaim runs inside the already-wired per-minute retry-sweep tick). **Proven live** (`m29-outbound-dispatch.live.test.ts`, real Postgres as `wardenx_app`, real TCP MLLP receiver): a send that died after delivery leaves a committed `in_flight` row that is reclaimed and re-sent with the same MSH-10 (two wires, ONE control id, one `transmitted` event); a live lease is untouched; three concurrent sweepers reclaim once; two overlapping retry sweeps send once; a stalled worker finalizing after its reclaim is a no-op; budget exhaustion goes terminal through the REAL catalog-validating publisher; the mismatched-MSH-10 ack no longer strands the row; cross-tenant sweeps stay in their org. **Each guard was mutation-tested** — staleness, the finalizer claim guard, and the lock + conditional write on BOTH reclaim and claim each fail their case when removed (the first concurrent-sweepers test passed with its protections removed because the sweeps never overlapped; it now widens the window with a slow in-transaction alert emit, and fails as it should). **Residual risks, stated not hidden:** (1) a crash between the wire landing at the receiver and the finalize still yields a second wire on reclaim — safe only if the receiver dedupes on MSH-10, which HL7 v2 receivers conventionally do but which is a contract with each lab that nothing here verifies; (2) the lease is a single global default (`inFlightLeaseMs` is injectable, not yet per-feed or env-tunable) and a worker stalled longer than the lease WILL be reclaimed — the claim guard keeps the data consistent but the receiver sees a second wire; (3) the rate-limiter wait now counts against the lease, harmless at the default but a reason not to shrink it; (4) a crash AFTER the claim commit but BEFORE the send makes the reclaimed attempt the first real send, indistinguishable from a lost one — harmless, alerts the same; (5) the `hl7.outbound.dispatched` audit kind is reused for a reclaim requeue (no new audit kind was invented).

**F-183 (#248) — M29 outbound: the four residual risks F-182's `in_flight` sweep left, closed.** (1) **Receiver dedupe is now an explicit operator decision, not an assumption.** F-182 requeued a lease-expired row with the SAME MSH-10, which is only safe if the lab dedupes on MSH-10 — a contract nothing recorded. `external_feed.receiver_dedupes_control_id boolean NOT NULL DEFAULT false` (migration 0263, admin create/update/detail + OpenAPI + typed client) is that statement. When **false** (the default) a stale `in_flight` row is **HELD**: terminal `dlq` with `retry_count + 1` and no `next_retry_at`, never automatically re-sent, the existing `m29.lab_order.transmission_failed` (reason `dlq_exhausted`, `detail` `in_flight_lease_expired_delivery_unverified`, TRUE `attemptCount`) that M11's F-177 applier already applies as terminal, a HIGH alert that says it was NOT re-sent and to verify with the lab, audit kind `hl7.outbound.held`. When **true** F-182's requeue is kept unchanged. **BEHAVIOUR CHANGE vs F-182:** every existing feed defaults to false, so until an operator sets it true a lost send is held for a human where F-182 would have re-sent it — deliberately, because the failure being avoided is a SECOND ORDER at the lab and the safe default is no automatic duplicate. The flag is read straight from the feed row (any status; a missing row FAILS CLOSED to held). The catalogued failure `reason` union was not extended (that would need an M11 applier + catalog change), so the human-facing distinction lives in `detail`, the alert and the audit kind. (2) **The lease is per feed.** `external_feed.in_flight_lease_seconds integer NULL` (CHECK 60..3600 — the floor sits above the transport's 10 s connect + 30 s ack worst case so a lease can never be shorter than a live send), NULL = the platform default (`OUTBOUND_IN_FLIGHT_LEASE_MS`, still injectable); the fresh claim AND the retry-sweep claim both commit the feed's own lease as `next_retry_at`, so the reclaim honours it with no extra read. An update accepts an explicit `null` to clear it. (3) **The lease clock now starts when the send begins.** The claim commits the lease before the rate-limiter wait, and a sweep batch claims every row at once but sends them one after another, so the wait (or earlier sends) ate the lease of a live sender. `transmitClaimed` re-arms the lease under the existing claim guard (`status='in_flight' AND retry_count`) once at least 1 s has elapsed since the claim (below that the claim's own lease still covers the send and the extra write, with its audit row, is skipped); if the guard matches nothing a reclaimer already took the row, so the worker **sends nothing** and logs `m29.outbound.claim_lost`. (4) **The reclaim requeue has its own audit kinds** — `hl7.outbound.reclaimed` (requeue) and `hl7.outbound.held` — added to the `OutboundAuditRecord` union (these are logged intents, not a DB enum, so no enum mirror exists to update). **Proven live** (`m29-outbound-dispatch.live.test.ts`, 31 cases: 23 prior + 8 new; real Postgres as `wardenx_app`, real TCP receiver, the REAL catalog-validating publisher for the held event): held-vs-requeue per feed in one sweep across two orgs; a 60 s feed reclaimed at +2 min while a default-lease feed is untouched, and a 30 min feed untouched at +10 min while a default-lease feed is reclaimed; the retry claim takes the feed's lease; a long limiter wait (virtual clock) cannot get a live sender reclaimed and the re-armed lease is exactly send-start + lease; a reclaimer that takes the row during the limiter wait leaves the worker sending nothing; safe defaults, the CHECK bounds and RLS on the new columns. Route round-trip, `null` clearing, defaults and 422 bounds are in `external-interfaces-inject.test.ts`. **Each guard was mutation-tested** — ignoring the feed flag, ignoring the feed lease (fresh claim, and separately the retry claim), never re-arming, and sending despite a lost claim each fail exactly their cases when removed. **Residual risks, stated not hidden:** (1) setting the flag true is only as good as the operator's confirmation with the lab; nothing verifies a lab's dedupe behaviour; (2) a HELD order has no automatic resend path — after the human verifies with the lab, the resend is manual, and F-182's `orm-resend` covers only emit-time refusals, not M29 terminal failures; (3) a worker stalled past even a long per-feed lease is still reclaimed (the claim guard keeps the data consistent; whether the receiver then sees a second wire depends on the flag); (4) the re-arm costs one extra write (and one M4 write-audit row) when a send starts more than 1 s after its claim.

**F-183 (#248) — where can ONE lab order become TWO outbound ORM messages? An investigation; the flagged "M11 emitter crash-after-send window" is one REAL hazard, and it is not in the emitter.** F-182's in_flight-sweep fork called the emitter's crash-after-send window "a separate duplicate hazard". The emitter never touches a socket — it publishes `m11.order.hl7_orm_requested` into the outbox inside the sign transaction — so the question was re-posed as "every path that can yield two ORM events, two M29 rows, or two wires", and each candidate was reproduced on the real path (real sign as `wardenx_app`, real catalog-validating publisher, real dispatcher and receipts, real M29 worker over a stub transport, F-177's applier) in `m11-orm-duplicate-windows.live.test.ts`. Only two code paths ever publish the request (`signInternal`, shared by sign and verbal sign, and F-182's resend), which bounds the search. **Verdicts — W1 two CONCURRENT signs: CLOSED** by the unique partial index `order_signature_target_signature_uq` (the loser blocks on the winner's uncommitted signature row and fails; with the index dropped both succeed: two events, two wires); the state machine separately refuses a sequential second sign. **W2 sign transaction fails at/after the emit: CLOSED** — one transaction, so a failed publish leaves no signature, no `m11.order.signed`, no request, and the retry publishes exactly one (mutation: swallowing the publish error makes the sign succeed with no event). **W3 redelivery after a lost `(event, consumer)` receipt, routing unchanged: CLOSED** by M29's key lookup under the F-181 advisory lock (mutation: disabling the lookup sends twice). **W5 resend of an order whose request is already at M29 or delivered, and the applier regressing a delivered order: UNREACHABLE/CLOSED** — resend needs `failed` + `orm_refused:*`, a refused order never reached M29, the applier never writes `orm_refused:*` and treats `transmitted`/`failed` as terminal (mutations: removing the `not_failed` check still refuses via the independent `not_an_orm_refusal` check — two guards; removing the applier's terminal guard lets a late `transmission_failed` flip a delivered order). The F-182 resend suite already pins concurrent resends, sequential resends, M29-terminal failures and feed-refusal-then-fix. **W4 redelivery after the ROUTING CHANGED: REAL.** M29 §2.6 keys dedupe on `hash(feed_id, source_kind, source_aggregate_id)`, and `handleOrmRequested` computes it from the feed the resolver picks AT DELIVERY TIME. The crash window is the worker sending and committing, the process dying before the dispatcher writes the receipt, and the event being redelivered — if an operator relinked the destination facility to another feed (or swapped/suspended the feed) in between, the redelivery resolves feed Y, computes a different key, finds nothing and sends the same order to a second lab endpoint (reproduced: wires to port 2575 then 2576). The key format is spec-defined and unchanged; the invariant it was reaching for is one ORM per ORDER, so the fix is an order-level check. **What shipped here:** `outbound/order-dispatch-dedupe.ts` — `ormDispatchExistsForOrder` (READ-ONLY, any feed, any status) and `ormOrderDispatchLockKey`, live-tested (any feed, only that order, only that tenant) — and W4 committed as `it.fails` (it asserts the correct behaviour and currently fails, so the hazard stays reproduced in CI). **What did NOT ship on this branch:** the worker hook, because `dispatch-worker.ts` is owned by the concurrent reclaim-policy fork; the two-line hook (take `pg_advisory_xact_lock` on `ormOrderDispatchLockKey`, then `return null` if `ormDispatchExistsForOrder`, at the TOP of the claim transaction, before feed resolution — which also means a redelivery no longer trips `OutboundFeedIdentityIncompleteError` over a feed the order never used) lives on the stacked branch `f180-m29-order-dedupe-hook` with W4 flipped to a plain `it`. **Residual risks, stated not hidden:** (1) until that hook merges the hazard is live; (2) `hl7_message_outbound` has no index on `source_aggregate_id`, so the order-level lookup scans the org's rows across partitions once per delivery — fine at lab-order volume, an index (migration) is the follow-up if that changes; (3) an order stuck `pending` because the worker dropped its event (BAA lapse returns without a row or a `transmission_failed`) is not a duplicate hazard but is unrecoverable by the resend path (status is `pending`, not `failed`) — a separate gap; (4) a corrected order is a NEW order id and legitimately produces a new ORM; nothing cancels the original at the lab. **On the stacked branch `f180-m29-order-dedupe-hook` the hook IS applied** (`dispatch-worker.ts`: order-level advisory lock + `ormDispatchExistsForOrder` at the top of the claim transaction) and W4 is a plain passing `it`; the M29 dispatch (23), ORM-requested (17), resend (15), applier (7) and M29 RLS (15) suites all still pass with it.

**F-184 (#248) — five previously-untriaged M30 pairs checked individually; two dropped as misdeclared, one built, two confirmed genuinely blocked, plus a system-actor-membership proposal for one of the two.** (Numbered F-184, not F-181 — the M29 workstream above already claimed F-181–183 when its own F-178–180 rounds collided with this round's original numbering and were renumbered; this round's catalog text and code comments were written and checked before that collision was discovered, then renumbered in place.) **Dropped, misdeclared:** `m12.medication_order.transmission_failed` — M30's own spec names exactly two `MedicationOrderProvider` methods it consumes from M12 (`getOpioidOnAdmissionStats`, `getComfortKitDeploymentTimeline`), confirmed as `QualityMedicationOrderConsumer`'s only two real methods; nothing about transmission failures. `m37.ipu_admission.death_recorded` — reverses F-149's stale conclusion: it fires strictly downstream of, and only because of, `m6.discharge.death` (M37's own consumer comment: "recordDeath is driven by the M6 death consumer"), and M30's `createMortalityReviewDraft` is keyed exclusively to that same upstream event — the identical redundant-sibling shape F-172 already used to drop `m16` from this event. **Built, landed:** `m16.bereavement.risk_score_computed` — M16 already had a dormant, purpose-built seam method, `BereavementComplianceProvider.riskScreeningCompletenessCounts` (D17: excludes `minimal` data-completeness rows from the denominator), unread by any registered measure. Added a pure calculator (`bereavement_risk_screening_completeness_rate`, mirrors F-178's `f2f_window_on_time_rate` exactly), registered it (`MEASURE_CATALOG` + `registrations.ts`), and wired it into `m30-jobs.ts`'s `resolveOperationalMeasureInput`, reusing the existing `bereavementCompliance: getSeam("BereavementComplianceProvider")` binding — no duplicate seam reference. No bespoke outbox consumer: like F-178's F2F measures, the nightly `m30.nightly_recompute` cron pulls the seam directly, since the event's own write lands in the same table the seam already reads. `events-by-m16.ts` reclassifies `m30` from `declaredConsumers` to `seamConsumers` on this event (alongside M33's pre-existing seam-pull declaration) — the real mechanism is a seam pull, not an outbox subscription, so leaving it in `declaredConsumers` would have left a permanent declared-but-unbound pair. **Confirmed still genuinely blocked, not misdeclared:** `m16.bereavement.plan_skipped_per_patient_opt_out` (three prior rounds — F-115/F-148/F-161 — plus this fresh check all agree: whether an opt-out skip belongs in the `bereavement_coverage_rate` denominator is an open product decision, not a code gap; the event carries no `planId`, since nothing was ever opened) and `m37.restraint.applied` (M37's spec is unusually decisive this is real, and M30 already has a matching consumer port stubbed, `createIncidentDraft` — but F-150's "no system-actor-membership convention exists anywhere" framing for its actor-identity half turned out to be stale on independent re-check: `incident_report.reported_by_membership_id` (NOT NULL) carries no DB-level FK — unlike M20's structurally identical, genuinely-FK-enforced `safety_incident.reported_by_membership_id` — and this codebase already has four working precedents for a NOT NULL, non-FK, module-owned system-actor sentinel on this exact column shape (`M17_SYSTEM_USER_ID`, `M18_SYSTEM_USER_ID`, `M37_SYSTEM_MEMBERSHIP_ID` ×2, `RENDER_SYSTEM_MEMBERSHIP_ID`); a fifth, module-owned `M30_SYSTEM_MEMBERSHIP_ID`, would be a same-shape, no-migration fix. What still blocks the event is the second, independent, additive gap alone: `m30IncidentKind` has exactly 6 members, no `restraint_use` slot — a real enum migration plus an `IncidentKindData` payload variant, and deciding how a restraint event maps into that typed payload is a clinical-categorization call this round does not make unilaterally. Not the same blocker as `m12.medication.error_reported` in the first m30 group above — F-165 already established that event's real gap is "no producer anywhere," unrelated to actor identity. Verified: `bun run build`/`typecheck` clean, `bun run arch:fitness` 38/38 (including `arch:outbox-bindings`, 34→33), full `bun run test` 661 files/9762 tests passed, 0 failed. No schema or live-DB-observable behavior changed (the new measure reuses an already-live seam method), so no live-suite re-run was needed.

**F-185 (#248) — `m37.restraint.applied` → M30 `restraint_use` incident draft, real end-to-end bind.** Closes the pair F-184 narrowed. Added `restraint_use` as the 7th `m30_incident_kind` enum member (migration 0264, additive `ALTER TYPE ... ADD VALUE`) and its `INCIDENT_KIND_CATALOG` entry (`requiredKindDataFields: ["narrativeText"]`, `sentinelEligible: true`, `alwaysMandatoryReport: false`, `defaultSeverity: "moderate"` — all three pre-decided by the user, not invented here). Payload design is the approved "thin pointer" (Option A): the auto-filed draft carries only `restraintEventId` + `restraintKind` + an auto-generated `narrativeText`, sourced entirely from `m37.restraint.applied`'s existing catalogued payload — M37's real `restraint_justification_text` (audit-denylisted PHI) is never read or copied across the module boundary, deliberately avoiding the richer B/C designs F-184's proposal flagged as needing a separate product decision. `createIncidentDraft` (`upstream-consumer-ports.ts`) is now real: a fifth system-actor sentinel, `M30_SYSTEM_MEMBERSHIP_ID`, resolves `incident_report.reported_by_membership_id` (NOT NULL, no DB-level FK — the same precedent-backed pattern `M17_SYSTEM_USER_ID`/`M18_SYSTEM_USER_ID`/`M37_SYSTEM_MEMBERSHIP_ID`/`RENDER_SYSTEM_MEMBERSHIP_ID` already use), and the insert runs for real inside `withOrgContext`. Idempotency required a genuine fix, not just a copy of the existing `enqueueRecompute` pattern: `incident_report`'s §2.6 auto-creation backstop is a per-LEAF partial-unique index (`..._auto_creation_uidx`, created directly on each monthly partition, migration 0063), and an `INSERT ... ON CONFLICT` issued against the partitioned PARENT cannot infer that index (confirmed live — Postgres `42P10`, arbiter-index inference only sees indexes declared on the parent itself) — fixed by catching the real `23505` unique-violation on insert instead. `providerEntityId` (`incident_report`, NOT NULL) is not on the event's payload, so a new org-explicit seam, `restraintAdmissionSitingForOrg` (`37-ipu/seams/`), reads it (plus `patientId`/`locationId`) off `ipu_admission` by id; the consumer binding (`m30/outbox-consumers/m37-restraint-applied.ts`) takes it as an injected port rather than a direct import, since M30's manifest `dependsOn` genuinely excludes 37 (`arch:boundaries` would refuse the direct import) — confirmed against `architecture/module-manifest.ts` and mirrors the existing `m16-plan-closed.ts`/`bereavementPlanSitingForOrg` shape exactly, not a new mechanism. An unrecognised `ipuAdmissionId` (cross-tenant or stale redelivery) is a silent no-op, the same posture the M16 consumer already has. Wired at the composition root (`apps/backend/src/index.ts`) alongside M30's other upstream consumers. `scripts/outbox-deferred-consumers.ts`: `m37.restraint.applied` removed from the m30 `no-consumer-surface` group's `events` array. Verified independently (not merely accepting the build's self-report): `bun run build`/`typecheck` clean; `bun run arch:fitness` 38/38 including `arch:boundaries` (0 violations — confirms the port-injection, not a boundary-violating direct import) and `arch:outbox-bindings` (33→32); full `bun run test` 661 files/9764 tests passed, 0 failed; `test:m30:upstream-consumers:live` re-run independently against a freshly provisioned disposable Postgres (4/4 passed, including the redelivery-is-a-no-op and cross-tenant-no-op cases) and `check:boot:platform` re-run clean against the same database. No new `package.json` script or CI job needed — extended the existing `m30-upstream-consumers.live.test.ts`, which already ran in CI.

**F-187 (#248) — the missing index behind F-183's order-level dispatch dedupe.** `ormDispatchExistsForOrder` (one lookup per `m11.order.hl7_orm_requested` delivery, run before feed resolution) filters `hl7_message_outbound` by `(organization_id, source_aggregate_kind, source_aggregate_id)`, and the table had no index on the source aggregate (0146 indexes: `(organization_id, feed_id)`, `(status)`, `(idempotency_key)`, partial `(status, next_retry_at)`), so every delivery read the org's outbound history across all monthly partitions. Migration `0265_m29_outbound_order_lookup_index.sql` adds `idx_hmo_org_source_aggregate` on `(organization_id, source_aggregate_kind, source_aggregate_id)` on the partitioned parent — a plain NON-unique btree (a unique index would have to include the partition key `queued_at`, and one order may legitimately own more than one row over its life, so uniqueness is not the invariant; the advisory lock is), mirrored in the Drizzle schema. No other query filters this table by source aggregate (retry/reclaim use `idx_hmo_next_retry` and the primary key), so it is scoped to this one lookup. `CREATE INDEX` on the parent creates a child index on every existing partition including DEFAULT, and `create_hl7_message_outbound_partition()` makes new months with `CREATE TABLE … PARTITION OF`, which inherits parent indexes, so no change to the partition function was needed. **Proof** (extends `m29-outbound-dispatch.live.test.ts`; the seam now exports `ormDispatchLookupQuery` so the test `EXPLAIN`s exactly the statement the worker runs): on ~40k rows across 4 partitions under the real NOBYPASSRLS role, every partition holding rows is read through a child of the new index with zero rows fetched-and-discarded; every existing partition and a freshly created month carry it; answers and cross-tenant isolation are unchanged. **The control is by work done, not node type** — with the index dropped (rolled-back txn) the planner does not necessarily Seq Scan (it can fall back to `idx_hmo_org_feed` on the org prefix alone as a Bitmap Heap Scan that fetches every row of the org and filters them), so the assertion is >5,000 rows filtered and >10x the buffers; measured for an absent order: 132 buffers / 0.107 ms with the index vs 3,872 buffers / 6.1 ms and 40,001 rows discarded without. **Residual risks:** `CREATE INDEX` on a partitioned parent cannot be `CONCURRENTLY` and runs in the migration transaction, so it takes a brief SHARE lock on `hl7_message_outbound` — short at lab-order volume, but a much larger table would want per-partition concurrent builds; the retry-sweep and reclaim queries were checked and are already served by existing indexes, so this adds write cost to one more index on every outbound insert, which is negligible at this volume.

**F-187 (#248) — recovery for lab orders that can never reach the lab: the two orders the pipeline stranded.** (1) **An order that failed AFTER a message was built** (`dlq_exhausted`, including F-183's "held, delivery unverified" reclaim, or `application_reject`) was refused by F-182's resend on purpose — the lab may already hold it, and a blind re-send orders the test twice — and had NO other way out. (2) **An order the M29 worker refused to persist** (no/ambiguous/unlinked feed, incomplete MSH identity, lapsed BAA) stayed `pending` FOREVER: F-175's worker `return`ed silently (or F-181 threw and the outbox eventually dead-lettered), no `transmission_failed` could be published (it needs an outbound row to cite), and F-182's resend needs `failed`, so nothing could reach it. The planner's header even assumed "the M29-owned DLQ auto-requeues on BAA restoration (W-XI-08)" — a mechanism that was never built (a refused plan writes no row for a requeue to find). **Gap 2 fix — never silently stuck.** New catalogued event `m29.lab_order.dispatch_refused` (`orderId`, `organizationId`, `feedId|null`, `refusalId`, `reason` ∈ `no_active_feed | ambiguous_feed | no_feed_for_destination | feed_identity_incomplete | baa_inactive`; `declaredConsumers: ["m11"]`, ids + an enum, no PHI, never the missing MSH field's name or value), published by the worker IN THE CLAIM TRANSACTION at every row-less exit (`refuseDispatch`). F-177's `LabTransmissionApplier` (now subscribed to it in `M11_OUTBOX_SUBSCRIPTIONS`) flips a `pending` order to `failed` with `dispatch_refused:<reason>` and re-publishes `transmission_status_changed` + `transmission_terminal_failed` (M36's ordering-provider alert, `transmittedAttempts: 0`), and ONLY a `pending` order — a stale or redelivered refusal never disturbs one that moved on. F-182's `classifyOrmResend` now also accepts `dispatch_refused:*` (no outbound row exists for these, so a resend cannot duplicate). **Design decision, stated:** all five causes are TERMINAL for that event, not retried by the outbox — an outbox retry cannot tell a config gap fixed in minutes from one that needs a day, and its dead-letter leaves the order `pending`; the resend is the deliberate, human-triggered retry. F-181's `OutboundFeedIdentityIncompleteError` (alert + throw) was therefore REMOVED (class, export, and its live assertion rewritten to the new terminal signal); only genuine faults (a throwing dependency, a lost connection) still throw and ride the outbox retry. **Gap 1 fix — attested recovery.** `POST /api/v1/orders/:id/recover-transmission` (`orders.amend`, no step-up — it re-discloses the SAME signed order to the SAME lab, or records a fact; what protects it is the REQUIRED closed-enum `attestation` body, its audit record, and the single-dispatch guards) — the operator calls the lab and attests what it holds: `not_received_by_lab` re-runs F-181's producer and publishes ONE `m11.order.hl7_orm_requested` carrying a fresh `redispatchAttestationId`; `received_by_lab` marks the order `transmitted` and sends nothing (not offered for an `AR`, which the lab explicitly refused). **The duplicate-risk reasoning.** The attestation carries the one fact the system cannot know. M29's worker treats `redispatchAttestationId` as the SINGLE sanctioned exception to F-183's one-ORM-per-order guard: it may add a new row only when every earlier row is a DEAD END (`dlq` / `naked` / `failed`) — a `queued`, `in_flight` or `acked` row still owns the order and blocks it exactly as before (`ormDispatchHasLiveOrDeliveredRow`) — and the new row's idempotency key hashes the attestation id in (`orderId#attestationId`; the persisted `source_aggregate_id` stays the bare order id), so it cannot collide with the dead attempt's key while a redelivery of the SAME attested event still finds its own row and sends nothing. No ordinary delivery, and no F-182 resend, carries the id, so the guard is unchanged for them. **Race safety:** one transaction; `SELECT … FOR UPDATE` on the order row plus a conditional `UPDATE … WHERE transmission_status='failed' AND reason = <read>` (the F-182 pair, each independently sufficient) — a double-click dispatches once and the loser is 409 `not_failed`. **The attestation IS the audit record:** written into `transmission_failure_reason` (`recovery_attested:<attestation>:<uuid>`, an enum and a uuid — no free-text note is accepted, so nothing PHI-shaped can enter) in the SAME `UPDATE`, so the M4 write-audit trigger's before/after diff on `order_record` records what was attested, when, and — via the real Better Auth user id set on the transaction — by whom; NO migration (the trigger already captures every column but `data`/`indication_text`). **If the producer now refuses,** the order is left EXACTLY as it was (still `failed`/`dlq_exhausted`) and never rewritten to `orm_refused:*` — that would make F-182's attestation-free resend reachable for an order whose first attempt may have reached the lab. Verified: `build`/`typecheck` clean, `arch:fitness` 38/38 (after refreshing the status-matrix, openapi-coverage and inject-coverage reports; the new event is bound, so `arch:outbox-bindings` needed no registry change), new unit suite `orm-recovery.test.ts`, new live suite `test:m11:orm-recovery:live` (17/17 — held → attested re-dispatch → delivered once with a new MSH-10 and key; the audit diff; two CONCURRENT attestations dispatch once; a second attestation after a repeat failure gets its own row; a still-refused producer leaves the order untouched and the plain resend stays refused; `received_by_lab` sends nothing; an `AR` cannot be marked received; delivered/pending/emit-time-refused/non-lab orders not recoverable; cross-tenant 404; not-configured 409; a lapsed BAA, a removed feed and an MSH identity broken between sign and dispatch each end `failed` with an actionable reason and then resend to `transmitted`; a stale refusal is a no-op, and a refusal applies only to a `pending` order — not `pending_retry`/`not_required`), `m29-outbound-dispatch.live` 35/35 (31 + 4: the attested guard refuses over `acked`/`queued`/`in_flight`, the attested re-dispatch over `dlq`/`naked`/`failed` adds one row and survives a concurrent redelivery, F-183's guard is unchanged without the attestation, every feed refusal publishes exactly one `dispatch_refused`). **Mutation-tested — each guard removed fails exactly the tests that pin it:** the attested guard's blocking-status set (only `queued` left → the acked/in_flight case fails), the attestation in the idempotency key (bare key → the attested-over-dead-end case and four recovery cases fail), the row lock + conditional update TOGETHER (the concurrent-attestation case fails 3/3) and each ALONE (16/16 on three runs — independently sufficient, as in F-182), the applier's `pending`-only guard (**not caught at first**: the stale-refusal test used a `transmitted` order, which the applier's earlier terminal-state check already covers, so the guard's only reachable effect — `pending_retry`/`not_required` — was unpinned; a case was added and now fails without the guard), each worker refusal publication (BAA; feed/identity — both suites), the attestation exception itself (five cases), a still-refused recovery rewriting the reason to `orm_refused:*`, and an `AR` markable as received. **Residual risks, stated not hidden:** (1) an operator who attests `not_received_by_lab` wrongly can still cause a duplicate at the lab — the system records who said so, it cannot verify it; (2) a `dispatch_refused` redelivered AFTER an operator resend has set the order `pending` again would flip it `failed` once more (the applier keys on `pending`, not on the refusal's age) — the same feed/BAA cause would refuse the new request anyway; (3) `received_by_lab` leaves the attestation marker in `transmission_failure_reason` on a `transmitted` order (the only place it survives in the audit diff without a migration); (4) an attested request that the worker blocks because a live row appeared meanwhile is dropped silently (logged) and the order stays `pending` — unreachable through the applier's own transitions, a genuine race only across two rows.

**F-187 (#248) — a lab order SUPERSEDED after its ORM may already be at the laboratory now reaches a human; the protocol-level cancel is deliberately NOT built, and this is the spec decision.** F-183's duplicate-window investigation ended with "a corrected order is a NEW order id and legitimately produces a new ORM; nothing cancels the original at the lab" — the same is true of a plain discontinue and of the discharge cascade. **Spec decision (do not "finish" this without a spec change):** the specs define NO outbound lab cancel. T-29.08 (`WARDENX_T-29.08_OUTBOUND_ORM.md`) defines ONE outbound message, `ORM^O01` with `ORC-1 = NW` (`orm-o01.ts` hardcodes `"NW"`); there is no `CA`/`OC`/`DC` order-control flow, no cancel message type, no cancel idempotency rule and no partner-lab acknowledgement semantics in the M29 spec (its "cancel" is inbound `ADT^A11` and the `cancelled` lab-RESULT status), the task specs or `WARDENX_INTEGRATIONS_v0_1.md`. M11's spec gives supplies a decisive `m11.order.supply_cancellation_requested` (§4.5, consumer M21) and names NO lab equivalent; `m11.order.discontinued`'s listed consumers exclude M29; §61 says transmission is an observed state and "M11 does NOT retry transmissions". Whether a lab honours `CA` after collection, whether the ACK of a cancel proves anything (it does not — results may still arrive) and which order-control code a given partner wants are partner-lab decisions — inventing them would put an unspecified message on a production PHI channel. **What is built instead (what the specs DO support):** `11-orders/outbox-consumers/lab-cancellation-required.ts`, M11's SELF-consumer of `m11.order.discontinued` (route, discharge cascade) and `m11.order.corrected` (the supersede trigger discontinues the original silently, so this is the only event that says it was replaced), raising an M36 alert (`m11.order.lab_cancellation_required`, platform-default rule `care_team` on `patientId`, added to `PLATFORM_DEFAULT_ALERT_RULES` — without a rule `rulesFor` returns `[]` and the alert would be dropped silently) with ids and tokens only, the pure `decideLabCancellation` (`transmitted` / `in_flight` / `delivery_unverified`) and, for a correction, BOTH ids of the pair (`replaces_order_id` already links them and the order detail already exposes it). Catalog: `m11` added to `declaredConsumers` of both events; `M11_OUTBOX_SUBSCRIPTIONS` names both (`arch:outbox-bindings` rule 6 caught the missing entries); wired in `apps/backend/src/index.ts` next to `buildM11LabTransmissionApplierConsumer` (an `AlertEmitter` seam cast, the F-181 M29-worker precedent). No migration, no route change. **A real defect the live suite caught:** `insertDraft` writes `transmission_status='pending'` (and `results_status='awaiting_results'`) on EVERY lab draft, so `pending` alone does NOT mean an ORM was requested — the first cut would have raised a false "cancel this with the lab" alert for every unsigned lab draft that was corrected; the emitter only runs at SIGN, so `signed_at` is the real signal and `decideLabCancellation` requires it. **Alerts only when something may be at the lab:** `transmitted` (the lab has it), `pending`/`pending_retry` (requested, unacknowledged — it may still be sent AFTER the discontinuation), `failed` by an M29 terminal failure (F-183 holds those as delivery-unverified); NOT `failed` `orm_refused:*` (never produced), NOT results already received, NOT never-signed, NOT non-lab. Verified: live suite `m11:lab-cancellation` 12/12 on the `wardenx_app` role with the real catalog-validating publisher and the real M29 worker/applier (transmitted → discontinue → one alert; refused → none; double discontinue + repeated relay ticks → one; correct → alert on the ORIGINAL carrying the replacement id; cross-tenant event invisible under RLS; no PHI in the payload) plus a 22-case unit suite; mutation-tested — removing each of the eight guards (results-received, refusal, status-reread, corrected subscription, never-signed, `not_required` default, kind, original-vs-replacement id) fails at least one suite. **Residual:** (1) an operator still phones the lab — nothing is withdrawn; a protocol cancel needs a spec decision (ORC-1 code per partner, cancel-ack semantics, its own idempotency key coexisting with F-183's one-ORM-per-order dedupe); (2) `in_flight` can race — an ORM queued at discontinuation may be sent seconds later; the alert says so, but M29 still sends it (M29 cannot read M11 to skip a discontinued order); (3) separate from this item, found while wiring it: M29's own three operator alert kinds (`OutboundAlert.kind` — `hl7_outbound.transmission_failed`, `external_feed.baa_expired`, `external_feed.baa_missing`) have NO platform-default `alert_rule` (grep of `PLATFORM_DEFAULT_ALERT_RULES`, the messaging package and every migration finds none), so unless a tenant configured its own rule the emitter has no rule to resolve recipients from — by the same mechanism that made this item's rule necessary, they reach nobody (inferred from `alert-rule-seed-persister.ts`'s own header, NOT exercised live here); (4) the alert is per-order, so a discharge that cascades N transmitted lab orders raises N alerts.

**F-188 (#248) — M29's outbound operator alerts never reached anyone: three independent defects, each proven live on the real M36 emitter (`m29-alert-routing.live.test.ts`), then closed.** F-187's cancel fork noted, outside its scope, that the three M29 alert kinds have no platform-default rule; this round tested that on the real chain (real `wardenx_app` role, the real `wireAlertRuleSeed` seed, the real Drizzle `AlertEmitter`) and found it was the third-worst of three. **(1) SEVERITY — every emit threw.** M29's intent carries the §5.3 payload ladder (`HIGH` / `NORMAL`); the emitter takes the legacy `alert_severity` enum (`info` / `warn` / `critical`) and writes it to an enum column, so all five probed emits (the three kinds at `HIGH`, `transmission_failed` at `NORMAL`, and even a control kind that DOES have a seeded rule) died at the `alert` INSERT ("invalid input value for enum"). The worker's `emitAlert` swallows alert failures by design (an alerting outage must never block dispatch), so the only trace was a `m29.outbound.alert_emit_failed` log line: **no M29 alert had ever been persisted.** The unit tests could not see it because every worker case injects a FAKE alerts port that records whatever it is given — three F-182/F-183 assertions even pinned `"HIGH"` / `"NORMAL"` as the value the emitter received. **(2) NO RULE.** With a valid severity the three kinds persisted an `alert` row with `resolvedRecipientCount 0` and zero `notification_delivery` rows (`emit()` documents "no rule → a no-op alert"); the seed held none (probe: 0 default rules for the three kinds). **(3) PERMANENT DEDUPE.** `alert` is unique on `(organization_id, correlation_id)` and `persist()` returns the existing row without writing deliveries; M29's id `m29-outbound:<kind>:<feedId>` never changed, so even with (1) and (2) fixed only the FIRST alert of a kind per feed could ever notify anyone (probe: a second, different incident on the same id returned the same alert row and added no delivery). **The fix.** New pure `outbound/alert-routing.ts`: `toEmitterSeverity` (HIGH→`critical`, NORMAL→`warn`), `outboundAlertCorrelationId` (the id now carries a time WINDOW — one page per (kind, feed) per window, so a retry storm pages once and a still-true condition pages again: 1 h for `transmission_failed`, 24 h for the BAA kinds, since a lapse blocks every send for the feed and each refused order still becomes `failed` with its own reason) and `buildOutboundAlertEmit`; the worker's `emitAlert` now calls it (a 4/−6-line hunk, no send/claim logic touched). `OUTBOUND_ALERT_KINDS` is now a runtime list the `OutboundAlert.kind` type derives from, so a guard can enumerate the kinds. Three platform-default rules (code-seeded by `wireAlertRuleSeed`, so no migration), audiences from M29 spec §5.3: `hl7_outbound.transmission_failed` → `role_set` [`org_admin`, `clinical_lead`] ("operator-on-call, M11 owners" — a tenant's operator is its `org_admin`; no tenant-operator role key exists), `external_feed.baa_expired` / `baa_missing` → `role_set` [`compliance_officer`, `org_admin`] (the spec names the compliance officer; `org_admin` is the backstop for a tenant that has none assigned, since a lapse blocks every lab send for the feed). **Verified.** New live suite `m29-alert-routing.live.test.ts` (8): the seed carries a rule for every kind; each kind reaches EXACTLY its audience (asserted as the recipient set, not a count); a bystander in the same tenant and another tenant's admin are never reached; ORG_B's alert resolves only ORG_B's admin; the throttle (storm absorbed inside a window, a new alert in the next); the payload is ids + a summary only. Two end-to-end cases in `m29-outbound-dispatch.live.test.ts` drive the REAL worker into the REAL emitter (a BAA-refused dispatch → compliance officer + org_admin; a dead-lettered transmission → org_admin + clinical lead). Unit guard `m29-alert-routing.test.ts` (10) fails if any `OUTBOUND_ALERT_KINDS` entry lacks an enabled seeded rule, so a new alert kind cannot silently reach nobody again. Six mutations each fail their tests: each of the three rules disabled, the severity pass-through restored, the correlation window removed, and the worker's adapter reverted to the pass-through (which fails both end-to-end cases and the three corrected assertions). **Residual, unchanged:** the throttle is per (kind, feed) per window, so a second failing order on the same feed inside the hour is not separately paged (each order still becomes `failed` and M11's applier alerts the care team per order — F-187); the failure `payload` carries no order id, so the M11 owners resolved by role are the clinical leads generally, not the ordering provider (M36's `ordering_provider` resolver needs an order/provider id in the payload); the inbound listener supervisor's alerts (`listener/supervisor.ts`: cleartext-blocked, BAA-gate-blocked) do NOT share these defects because they do not go through this path at all — they use an injected `dispatchAlert` port of their own shape (`SupervisorAlert`: no `eventType`, so no rule could ever match), and the inbound listener is not composed from `apps/backend/src/index.ts` (F-182), so those alerts are unwired rather than mis-typed; binding them to M36 (an `eventType`, a seeded rule, the severity ladder) belongs with composing the listener.

**F-188 (#248) — F-187's attested recovery, hardened against its own four stated residual risks.** F-187 shipped `POST /api/v1/orders/:id/recover-transmission` with an honest list of what it could not do; each item is closed here (migration `0266`, additive). **(1) A wrong attestation.** An operator who attests `not_received_by_lab` on a phone call the system cannot verify orders the test twice at the lab. Four layers now stand in front of it. *(a) Structured evidence, persisted:* the body REQUIRES `contactName` (who at the lab was contacted) and `labReference` (the lab's own reference for the call), each shaped so it cannot carry a patient identifier — a name is `^[A-Za-z][A-Za-z .'-]{1,79}$` (no digits, so no MRN/DOB/phone), a reference is `^[A-Za-z0-9][A-Za-z0-9._#/-]{2,63}$` (no spaces, so no free-text names) — enforced by the TypeBox body AND by DB CHECKs, so even a direct insert cannot smuggle free text in. *(b) Step-up:* the route mounts `requireStepUp("order.recover_transmission")` on top of `orders.amend`, for BOTH attestations — a wrong `not_received_by_lab` duplicates an order, a wrong `received_by_lab` HIDES an order the lab never got, so neither is a click. *(c) A contradiction check BEFORE anything is written:* `classifyRecoveryContradiction` refuses `not_received_by_lab` with a specific 409 when the system can see the lab has the order — `lab_result_received` (M11's own `results_status`/`results_first_received_at`, or any M29 `lab_observation` matched to the order), `lab_acknowledged` (an outbound row the lab ACKed), `send_in_progress` (a row still `queued`/`in_flight`, so a second send would duplicate it) — and FAILS CLOSED (`evidence_unavailable`) when the evidence port is not wired: a safety check that cannot run is not "no contradiction". The read is M29's new read-only `ormOutboundEvidenceForOrder`, injected into M11's ports by the composition root (M11 has no `dependsOn` edge to 29). `received_by_lab` is never blocked by it: it sends nothing, and inbound evidence can only agree with it. *(d) Dual control was NOT built:* the repo has two-person controls (break-glass cosign, M34 shred, M30 CAP/PIP) but each is bespoke to its domain and there is no reusable "second approver" primitive; adding a second approver flow to one route would be a new pattern, not a use of one, and the step-up + contradiction check + persisted evidence address the failure without it. **(2) A stale refusal.** A `m29.lab_order.dispatch_refused` redelivered AFTER the operator resent flipped the freshly re-requested order `failed` again (the applier keyed on `pending`, not on the refusal's age). Every emission of `m11.order.hl7_orm_requested` — sign, F-182 resend, attested recovery — now mints an `attemptId`, persists it as `order_record.transmission_attempt_id` in the SAME transaction, and carries it on the event; M29 echoes it on `dispatch_refused`, and the applier applies a refusal only when it names the order's CURRENT attempt (and the conditional UPDATE re-checks it, so a concurrent resend cannot slip between the read and the write). A refusal from a request that predates F-188 carries no id and is applied exactly as before. **(3) A marker on a delivered order.** F-187 parked `recovery_attested:<enum>:<uuid>` in `transmission_failure_reason` because it had no migration — leaving it on a `transmitted` order forever, and recording nothing about what the operator established. The attestation now has its own home: `order_transmission_attestation`, APPEND-ONLY (grants are SELECT+INSERT only AND a BEFORE UPDATE/DELETE trigger rejects the write for any role, including the owner), RLS three-column + `FORCE`, the M4 write-audit trigger with the contact NAME denylisted out of the diff — one row per recovery: what was attested, the evidence, the order's prior failure reason, the outcome, the attempt it started (NULL for `received_by_lab`; a CHECK ties outcome ⇄ attestation ⇄ attempt), and who attested. A `pending`/`transmitted` order now carries NO failure reason. **(4) A blocked attested request.** When the worker could not honour an attested re-dispatch because an outbound row that owns the order appeared between the request and the claim, it logged and returned, and the order sat `pending` forever. It now publishes `dispatch_refused` with the new reason `attested_redispatch_blocked` IN THE CLAIM TRANSACTION (bound to the attempt, per #2); the applier records it as `recovery_blocked:row_owns_order` — deliberately NOT `dispatch_refused:*`, because that prefix is what F-182's plain resend acts on and a row EXISTS here (the plain resend would only be swallowed by F-183's order-level guard, or duplicate). A `recovery_blocked` order is recoverable AGAIN through the attested path only, which re-runs the contradiction check first (so it refuses `send_in_progress` until the owning row settles). Verified: `build`/`typecheck` clean, `arch:fitness` 38/38 (after regenerating openapi/client/status-matrix), non-live suite 9,852 passed, `orm-recovery.test.ts` 68 (the request contract incl. 11 evidence-shape rejections, the step-up 403s, the contradiction table), `test:m11:orm-recovery:live` 33/33 (17 F-187 cases, updated where the marker is gone, + 16 new). **Mutation-tested — each guard removed fails exactly the tests that pin it:** the contradiction check disabled (6 live cases), fail-OPEN on missing evidence (1 live + 1 unit), the applier's attempt binding (2), the worker's blocked-request signal (2), the blocked reason recorded as a resendable `dispatch_refused:*` (2), `recovery_blocked` no longer recoverable (1 live + 1 unit), the evidence CHECKs weakened (1), the append-only trigger removed (1) and — with the grants loosened as well — the app-role denial (1), the step-up gate removed (2 route cases), the attempt id not persisted at each of the three emission sites (resend 2, recovery 4, sign 5 — the sign case also fails the F-187 "never pending forever" cases, which is the coupling working), and a delivered order keeping a marker (1). **Residual risks, stated not hidden:** (1) an operator can still lie with a well-formed name and reference — the evidence is recorded and attributable, not verified against the lab; the contradiction check catches only what the system can see (a result, an ack, a live send). (2) The attempt binding covers `dispatch_refused` only: a redelivered M29 `transmitted`/`transmission_failed` for an EARLIER attempt is still guarded only by the terminal-state check, because `hl7_message_outbound` rows do not store the attempt id (that would need an M29 migration on a partitioned table). (3) During the deploy window an order whose request was emitted BEFORE F-188 (no attempt id) and resent AFTER it is exposed to the old stale-refusal flip once, by a refusal that also carries no id. (4) The attestation table is not on the destruction-role grant list (0157): erasing an order leaves its attestation row, which holds a lab contact's name and a lab reference (not patient data by construction, but a right-to-erasure sweep should still decide about it). (5) `order_transmission_attestation` is not yet surfaced on the order detail response; an operator reads it through audit. (6) `received_by_lab` is not contradiction-checked, so an operator who wrongly attests it hides an undelivered order — that is why it is step-up gated and attributable, not because it is safe.

**F-189 (#248) — `POST /api/v1/auth/select-organization` returned 500 for EVERY sign-in through the real composition, since #205 (2026-09-27); found while verifying F-181..F-188 on the Docker stack, and it is not in that work.** The handler binds the session to the chosen org and then publishes `m2.session.created` in the same request. The publish goes through `createOrgScopedIdentityOutbox`, which opened its transaction with `withOrgContextFromRequest` — the org from the AMBIENT request context, resolved BEFORE the bind, so it was empty: `app.org_id` became `''` and `outbox_event`'s policy (`organization_id = current_setting('app.org_id', true)::uuid`) threw `22P02 invalid input syntax for type uuid: ""`. It reproduced identically on the pre-F-181 baseline (`dc627cf3`) against the same database. **Why nothing caught it — two independent blind spots in `auth.live.test.ts`:** (1) it mounted `mountIdentityRoutes` with NO `outbox`, so the publish was a silent no-op (production passes `outbox: m2OutboxPublisher`); (2) its app handle used `WARDENX_TEST_DATABASE_URL`, a SUPERUSER, so every RLS policy was bypassed — the standing habit "prove RLS live, not on a superuser connection", violated in the one suite that drives sign-in. A THIRD staleness hid behind them: TEST-003 seeded its org with the column default `status='created'` and had been failing since D19 enforcement landed (`ORGANIZATION_NOT_ACTIVE`, 403). **Fix:** the adapter uses the event's own `organizationId` — the org just bound — ONLY when the request context has none; a request that already carries an org keeps it, so an event for a different org still fails RLS closed. **Tests:** `auth.live` now connects as the real NOBYPASSRLS `wardenx_app` (`appRoleConnectionString`), mounts the identity routes with a real catalog-validating M2 publisher exactly as production does, seeds an `active` org, and asserts the `m2.session.created` outbox row lands; with the fix reverted the same test fails with the production 500 (`expected 500 to be 200`). Verified: `auth.live` 19/19, `m2:organization-lifecycle` 5/5, `m2:outbox-audit-rls` 4/4, `m2:pre-org-picker` 4/4, `m2:step-up-override` 9/9, `m2:consent-revoked` 7/7, `rls:live:m2` 13/13, non-live 9,864, `arch:fitness` 38/38. **Residual:** production has been exposed since #205 landed if `main`'s deploys carried it — whether it was live there is for the operator to confirm; the dev stack's pre-#205 image predates it.

**F-190 (#248) — two M29 admin-route defects found by the same Docker-stack verification: EVERY per-feed admin route answered 404 for every feed, and a duplicate feed answered 500.** (1) **The feed-org ABAC resolver read `external_feed` on the BARE pool.** `buildDrizzleM29AbacResolver.feedOrgId` ran a plain `SELECT` with no `app.org_id`; `external_feed` is FORCE RLS, so `wardenx_app` sees ZERO rows (measured: superuser 12 feeds, `wardenx_app` without an org context 0, with one 12), the resolver answered `null`, `external_feed_organization_scope` denied with `notFoundOnDeny`, and detail / update / activate / suspend / revoke / credentials / health all returned 404 — for every feed, in production, since the routes shipped. The unit tests bind a stub resolver and NO live suite ever built the Drizzle one, so a superuser-free run never happened (the same blind spot as F-189). **Fix:** `feedOrgId(feedId, contextOrgId)` runs under `withOrgContext` for the CALLER's org, so a feed is visible iff it is theirs and a foreign feed stays `null` (still indistinguishable from "no such feed", §8.2). The predicate passes `context.organizationId`. (2) **`uq_external_feed_org_port_kind` had no registered meaning**, so a duplicate (org, port, kind) create was `500 INTERNAL_ERROR`; it is now a `businessRule()` beside the index (the F-022 convention), which the central error handler turns into a 409 with a caller-facing sentence. **Tests (in `m29-outbound-dispatch.live.test.ts`, real NOBYPASSRLS role):** the resolver resolves the tenant's own feed, hides another tenant's and an unknown id, and the predicate is true for the owner / false across tenants (fails with the old resolver: `expected null to be '1111…'`); a second same-kind feed on one port provokes the real `23505` and `classifyDatabaseError` maps it to the registered rule, while a different port and the same port in another tenant are fine. Verified: `m29:outbound-dispatch` 43/43 (41 + 2), `rls:live:m29` 15/15, `m29:unmatched-lab-review` 15/15, `m29:alert-routing` 8/8, non-live 9,864, `arch:fitness` 38/38. **Observed, NOT changed:** `POST /orders/:id/resend-transmission` and `/recover-transmission` are guarded by `orders.amend` alone (the existing `/correct` route also applies the `discipline_can_order` ABAC), and the seeded role catalog grants `orders.amend` to almost every role (chaplain, CHHA, volunteer included) — so as seeded, any of them can resend or attest-recover a lab order. Whether production tenants narrow that is a product decision, not a code defect.


**F-199 (#248) — a failure STORM on one feed is now counted and escalated once, not merely absorbed: F-188's windowed dedupe pages once per (kind, feed, window), which protected the pager and hid the outage.** **Proved first, on the real emitter as the real NOBYPASSRLS role:** a repeat inside the window returns the same `alert.id`, writes no `notification_delivery`, and changes NOTHING on the alert (`payload` never gains a field) — so a 200-order outage and one flaky message were indistinguishable to the on-call person, and the M11 side's per-order alerts were the only signal. **Why the count lives in the alert persistence, not in M29:** the loudest storms are the ROW-LESS refusals (a lapsed BAA, an unlinked or identity-incomplete feed refuses every order and writes no `hl7_message_outbound` row), so nothing in M29's tables can count them; and the worker's emit runs in its own transaction, so a count taken from committed outbound rows would also miss the current failure. **Design (no migration):** (1) `AlertEmitter.emit` gains an OPT-IN `countRepeats`; the alert is born with `payload.occurrences = 1` and each absorbed repeat does ONE atomic `UPDATE … RETURNING` (`jsonb_set`), writing NO delivery, so concurrent repeats serialize on the row lock and each sees a distinct count; the emit result returns `occurrences`. Opt-in because a redelivered event that re-emits the same id is idempotent, not an occurrence — every other producer is unchanged (a test pins that). The in-memory emitter counts the same way. (2) M29's `emitOutboundAlert` (the worker's `emitAlert` now calls it — a one-line hunk; no claim/send/finalize logic touched) emits the counted alert immediately, then — on the ONE call whose returned count EQUALS the threshold — emits a `critical` `hl7_outbound.transmission_storm` on its own correlation id (`m29-outbound:hl7_outbound.transmission_storm:<feed>:<window>`), so M36's dedupe bounds it to once per window even if two workers race (belt and braces: with `>=` in place of `==` the live suite stays green because the dedupe absorbs the extras — the unit test is what pins the call count). Seeded platform-default rule for the storm kind: same audience as the failure (`org_admin` + `clinical_lead`), floor `critical`. BAA kinds are COUNTED but never escalated: one standing condition, already `critical`, already a 24h window. **Threshold:** default 10 failures per feed per hour; `M29_ALERT_STORM_THRESHOLD` (integer 2..100000) overrides, and an invalid value FALLS BACK to 10 rather than disabling escalation (NaN would never equal a count). **PHI:** the alert payloads are `feedId`, `detail`, `occurrences` (+ `windowMinutes` on the escalation) — ids, integers and fixed sentences. **Tests:** unit (threshold parsing, escalation builder, wrapper over a fake counting emitter: first alert is one immediate emit, 200 → exactly one escalation right after the 10th, below-threshold none, next window fresh, other feed independent, BAA never, non-counting emitter never escalates) and LIVE in `m29-alert-routing.live.test.ts` on the real emitter/seed/role: baseline un-counted absorption, first failure pages the intended people with count 1, 25 → one page + count 25 + exactly one critical escalation to the right people, 9 → count but no escalation, 60 in flight from a cold start (race path) → exact count + one escalation, next window pages again with a fresh count and escalates again, another feed / another tenant independent, BAA counted never escalated, no PHI keys, seeded rule. **Mutation-tested (each fails exactly its own tests):** repeats not counted (7 fail), birth count removed, race path not counted, seeded rule removed (5 fail across the pinned seed test, the F-188 completeness guard and the live suite), `>=` for `==`, BAA added to the escalation map, worker not opting in (12 fail). **Not built — (c), carrying the order id on the alert intent:** the intents are built in `retry-policy.ts` / `dispatch-planner.ts` / `ack-correlation.ts` and at four worker call sites, i.e. the files other in-flight forks edit; the row-less refusal alerts ALREADY name the order in `detail`, and M11's per-order care-team alerts name every affected order, so the operator can find them. **Residual:** each counted repeat is one `UPDATE` on `alert`, and `alert` carries the M4 write-audit trigger — about one `alert.update` audit row per repeat (156 for 192 repeats across the live suite); a milestone-only update policy would cut that if it ever matters. The count is per window, not per outage: a storm spanning windows shows one alert (and one escalation) per hour, each with its own count. The M11 per-order alerts are unchanged (N failing orders is still N care-team alerts); an M36-level digest for those is a separate, larger change.

**F-200 (#248) — attempt binding for the TERMINAL M29→M11 events: `m29.lab_order.transmitted` and `.transmission_failed` now name the attempt they concern, and M11's applier applies them only to the order's current attempt.** F-188 bound `dispatch_refused` to the attempt it refused; the two events that come off an outbound ROW carried no attempt because `hl7_message_outbound` stored none, so a late or redelivered one from an EARLIER attempt was guarded only by the terminal-state check — which stops protecting an order the instant a recovery sets it `pending` again. **Proven on the real path BEFORE any change (`m11-orm-recovery.live.test.ts`, real NOBYPASSRLS `wardenx_app`, real worker + applier):** **window A is REAL** — attempt 1 dead-letters, the operator recovers (attempt 2, order `pending`), and a redelivered attempt-1 `transmission_failed` flips the recovered order back to `failed` (`expected 'failed' to be 'pending'`); **window B is real at the applier but not reachable from M29 today** — a stale `transmitted` marks a recovered `pending` order delivered (`expected 'transmitted' to be 'pending'`), yet M29 cannot produce a late ack for attempt 1 (its row is a dead end, and F-188's contradiction check already refuses a recovery over an acked row), so it is pinned as defence in depth. **Fix:** migration `0271` adds a nullable, unindexed `hl7_message_outbound.attempt_id uuid` (`ADD COLUMN` on the PARTITIONED parent cascades to every partition incl. the DEFAULT one, and later months come from `CREATE TABLE … PARTITION OF`, which inherits it — asserted live, including a month created by the real partition function; no index because nothing filters by it and a unique index would have to include `queued_at`). The worker copies the request's `attemptId` onto the row at claim time (a non-uuid is stored NULL rather than failing the INSERT), threads it through the fresh-claim, retry-sweep and reclaim contexts, and every terminal event built from a row carries it as an ADDITIVE OPTIONAL field (`transmitted` AA, `transmission_failed` for AR, retry exhaustion, permanent refusal and the F-183 reclaim hold — catalog schemas + `outbound-events.ts` types; `@wardenx/types` has no M29 lab-order payload mirror, so nothing to add there). The applier's F-188 guard is generalized from `dispatch_refused` to all three kinds: an event whose attempt differs from `order.transmission_attempt_id` is ignored. **Deploy window:** a row queued before the migration has `attempt_id` NULL, and an event already in the outbox carries none — such events apply EXACTLY as before (guarded only by the terminal-state check), so nothing in flight is stranded; the gap closes as those rows drain. **Tests:** recovery suite 33 → 37 (windows A and B, the current attempt still applies, legacy no-attempt events apply) and outbound dispatch 43 → 50 (attempt lands on the row and on the event for an AA ack, an AR reject, retry exhaustion with the attempt NOT rewritten by retries, an F-183 reclaim requeue, and a reclaim hold; absent/malformed ids store NULL and are not stranded; the column exists on the parent, the DEFAULT partition, every partition and a newly created one). **Mutation-tested — 9 mutations, every one killed, none survived:** the applier guard removed (fails windows A and B and BOTH F-188 refusal tests — one guard now covers all three kinds), the worker not copying the attempt (5 dispatch + 2 recovery), the retry-exhaustion / permanent-failure / AA / AR event builders each dropping it, the uuid guard removed, and the retry-sweep and reclaim contexts each losing the row's attempt. Verified: `m29:outbound-dispatch` 50/50, `m11:orm-recovery` 37/37, `orm-resend` 15/15, `orm-requested` 17/17, `orm-duplicate-windows` 8/8, `lab-transmission-applier` 7/7, `downstream-signed` 5/5, `m29:alert-routing` 8/8, `rls:live:m29` 15/15, `m29:unmatched-lab-review` 15/15, non-live 9,864, `arch:fitness` 38/38, `check:boot:platform` on a database migrated through 0271. **Residual:** the attempt binding closes the M29→M11 loop but cannot help an event whose row predates 0271 (deploy window, above); an operator's `received_by_lab` still marks the order `transmitted` without any row, by design.

**F-201 (#248) — stuck lab orders stop waiting on a human to notice: bounded AUTO-RETRY for orders refused before any outbound row existed, and a WORKLIST + AGING ESCALATION for the ones a person must verify with the lab.** F-182/F-187/F-188 left two kinds of stuck order, with opposite answers. (1) **Refused before any row existed** (`orm_refused:*` from the producer, `dispatch_refused:*` from M29's worker): the cause is a fact OUTSIDE the order — a lapsed BAA, an unlinked feed, an incomplete MSH identity, an unconfirmed NPI — and nothing was ever sent, so a re-emission cannot duplicate; yet the order sat `failed` until someone noticed the cause was fixed and pressed resend. (2) **Failed after a message was built** (`dlq_exhausted` incl. F-183's "held, delivery unverified", `application_reject`, `recovery_blocked:*`): the lab MAY have it, so these are never retried automatically — but nothing told anyone they were waiting. **Auto-retry (`stuck-transmission-recovery.ts`, rules in the pure `orm-request/stuck-recovery.ts`):** a 15-minute BullMQ tick (`orders.stuck_transmission`, the verbal-order-timer fan-out shape: audited platform-context org enumeration, each org under its own `withOrgContext`) re-emits through **F-182's own `resendLabTransmission`** — one implementation, so a sweep and an operator's click share the same row lock, conditional update and fresh attempt id, and concurrent sweeps single-dispatch by the same two guards. Eligibility is `classifyOrmResend` itself (single source of truth), so an SUD refusal (a disclosure gate), a refusal that lives in the immutable signed order, and every M29-terminal failure are refused by the sweep exactly as by the button. **The bound, and why:** at most 5 RE-EMISSIONS per order (only an actual re-emission spends one — a check that finds the cause still present, or the producer still refusing, costs nothing); a backoff of 10 m, 30 m, 2 h, 6 h after attempts 1–4 (exactly `MAX-1` steps — the bound, not a fifth wait, ends the sweep; cumulative ≈ 8.7 h, short first because a re-emission that fails after the cause CLEARED is a new problem, not the old one); and a 72 h window measured from the LATEST failure (it caps the work a silent, permanently broken order costs — re-checked every tick until the window closes — and is where the sweep stops waiting). Hitting either bound raises ONE `m11.order.transmission_auto_retry_exhausted` alert (warn, `org_admin` + `clinical_lead`) and stamps `transmission_auto_retry_exhausted_at`, so it can never repeat. **The one cause the producer does not check is the BAA** (the worker does, at dispatch): a still-lapsed BAA would round-trip through the worker and re-alert the ordering provider on every attempt (the applier raises `transmission_terminal_failed` each time a refusal flips an order `failed`), so `dispatch_refused:baa_inactive` is pre-checked through M29's own gate (`outboundBaaCleared` = `resolveOutboundBaaResult` + `decideBaaGate`, fail-closed, injected because M11 has no edge to M29) and skipped, with nothing emitted and no attempt spent, until it is in force. **Held orders:** `GET /api/v1/orders/held-transmissions` (`orders.amend` — the permission the actions on the list already require; cursor-paginated keyset on `(updated_at, id)` at MICROSECOND precision, oldest first, `limit` ≤ 100; PHI read audited as `lab_order` list; ids + fixed reason token + age + stage + the feed the dead-ended message went to — `feedId` from a new read-only M29 fact `ormOutboundFeedsForOrders`) and an aging escalation on the same tick: `m11.order.transmission_held_aging` at **warn ≥ 4 h** and **critical ≥ 24 h** (`M11_HELD_WARN_AFTER_HOURS` / `M11_HELD_CRITICAL_AFTER_HOURS`, validated at boot — a bad value THROWS, never a silently disabled escalation), one page per (order, hold episode = the order's attempt id, stage) — the `alert` table's unique correlation id IS the de-duplication, so the sweep may run every tick. Both alert kinds have seeded platform-default rules (F-188's lesson: an unruled kind reaches nobody) and a test asserts every kind in `M11_STUCK_ORDER_ALERT_KINDS` has one. **Migration 0270** (additive): `order_record.transmission_auto_retry_count` (NOT NULL DEFAULT 0, CHECK ≥ 0), `transmission_auto_retry_at`, `transmission_auto_retry_exhausted_at`, and the partial index `idx_order_transmission_failed (organization_id, updated_at, id) WHERE kind='lab' AND transmission_status='failed'` — the existing partial index covers only `pending`/`pending_retry`, so the sweeps and worklist had no index for the `failed` end. **Tests:** `m11-stuck-recovery.live` 17/17 (real `wardenx_app`, the real M29 worker + F-177 applier, the REAL M36 emitter over the real rule seed — "one page per stage" is proven by the `alert` table, not a stub) and `stuck-recovery.test.ts` 43 (pure rules, seeded-rule guard, the route's 401/403/422 and that the org comes from the context, never a parameter). **Mutation-tested (each fails ITS test):** BAA pre-check, attempt bound, window, backoff, eligibility gate, exhausted marker, counter bump, counter-on-refusal, stage in the alert id, held filter, keyset comparison, cursor validation, one-failure-stops-the-sweep, lost-race-counted-as-error, fan-out swallowing/aborting, route permission, org-from-query, read audit, threshold ladder. **Survivor, by design:** removing the explicit `organization_id` predicate from the sweeps' shared filter does NOT fail any test — RLS alone isolates tenants there (verified), so the explicit filter is defense in depth, not a tested guard. **Caught by the tests, not by review:** the worklist first failed boot with `ReadAuditCoverageError` (a route returning `patientId` must declare `auditRead`); and the first backoff schedule had a fifth step (24 h) that the attempt bound made unreachable. **Residual:** (1) "held since" is `order_record.updated_at` — a later write to the order restarts the age and therefore the escalation clock (the applier sets it when it marks the order failed; no other path currently touches a held order); (2) the counter bump runs in a second transaction after the resend commits, so a crash between them leaves the count one short (the order is `pending` then, so the bound still holds — worst case one extra attempt); (3) held orders are still resolved by a human — the escalation only makes them impossible to miss; (4) an order re-checked every 15 min for up to 72 h costs one producer run per tick (≈ 288 worst case per order, bounded); (5) the exhausted alert is per ORDER, so a BAA lapse that strands many orders raises one per order after 72 h (F-188's feed-level BAA alert is the loud one); (6) `orders.amend` is broadly granted in the seeded role catalog (F-190 observation), so the worklist is as visible as the resend action it accompanies; (7) the sweep's `resend` passes no acting user (an empty user id, the module's consumer/worker convention), so there is no person to attribute the re-emission to in the M4 write-audit — the auto-retry counters on the row are what say it was the sweep.

**F-202 (#248) — the attested lab recovery, hardened a second time: a TWO-PERSON control on the duplicate-risk attestation, the attestations on the order detail, and the destruction-role grants the ledger never got.** Three gaps F-188 left open. **(1) A well-formed lie still passed.** `not_received_by_lab` re-dispatches the order, so a wrong one orders the test twice at the lab; the evidence (who at the lab, the lab's reference) was recorded and attributable but not verifiable, and dual control was skipped because the repo "had no second-approver primitive". It does — M3 break-glass is one (`bge_cosigner_distinct`, migration 0210; `BreakGlassStore.cosign`: a `cosign_pending` state, a `cosigned_by`, a CHECK that the co-signer is not the invoker, and the guards in the UPDATE's WHERE) — and this copies its shape rather than inventing one. Migration `0272`: `order_recovery_request` (status `pending_cosign | executed | cancelled | expired`; the co-signer is never the requester — CHECK; status and resolution columns must agree — CHECK; at most ONE pending per order — partial UNIQUE index; frozen once resolved and evidence immutable while pending — trigger; the contact NAME denylisted from the M4 diff) and `order_transmission_attestation` gains `cosigned_by_*` + `recovery_request_id` under a **NOT VALID** CHECK (rows written under single control are exempt; every NEW `not_received_by_lab` row must carry a co-signer distinct from the attester, whatever code path writes it). The first call now FILES a request (`outcome: "pending_cosign"`, expires in **24 h**) and touches nothing; `POST /orders/:id/recover-transmission/:requestId/cosign` (`orders.amend` + the same fresh step-up as the request) executes it — refusing, in break-glass's order, a request that is not pending, has lapsed, or was filed by the SAME user (409) — re-running the F-188 contradiction check against FRESH evidence and the producer against THIS moment's facts, then the unchanged F-187/F-188 single-dispatch execution in one transaction; `.../cancel` (`orders.amend` only — it sends nothing) lets either person withdraw it; the hourly M11 timer (the verbal-order tick — no new queue) lapses stale requests. `received_by_lab` sends nothing and stays single-person. **Compliance is told, always:** every execution / cancellation / expiry raises an M36 alert (`m11.order.recovery_executed` warn, `_expired` warn, `_cancelled` info — three platform-default rules to `compliance_officer` with `org_admin` as the backstop) with **ids and counts only** (no contact name, no reference, no patient id), a per-(kind, request) correlation id (`alert` dedupes on it — F-188's lesson) and a **repeat-attester** signal: when the same requester's Nth request inside 24 h reaches the threshold (default 3, injectable) the executed alert goes `critical` with `repeatAttester: true` and the count. Alerts are emitted after commit and are best-effort — the durable record is the append-only ledger. **(2) The attestations were invisible on the order.** The order detail now carries `transmissionAttestations` (what, outcome, who — membership ids, like every actor on the view — when, attempt, the co-signer) and `pendingRecovery`. The lab contact's NAME and the lab's reference are a third party's personal data, so they are `null` unless the reader holds `orders.amend` (the recovery permission); everyone with `orders.read` still sees THAT a recovery exists and who did it. **(3) Erasing an order left its attestation rows behind.** `order_transmission_attestation` was never on the `wardenx_destruction` grant list (0157's pattern) and its append-only trigger would have blocked the delete anyway. Both tables now have 0157's `SELECT, DELETE` grant + an org-scoped `<table>_destruction` policy, the eraser (`createDrizzleOrderEraseStore`) deletes them keyed on the erased order ids and counts them into the certificate, and the append-only trigger admits a DELETE **only from a non-superuser member of `wardenx_destruction`** — a superuser is implicitly a member of every role, so `pg_has_role` alone would have let `postgres` rewrite history; the first cut of this migration made exactly that mistake and the F-188 "not even a superuser" test caught it. The app role still cannot update or delete; the destruction role can delete but never update. **Tests:** `m11-orm-recovery.live` 33 → 49 (real NOBYPASSRLS `wardenx_app`, real publisher; the 33 existing cases keep asserting the execution through a `recover()` helper that files and co-signs) — filing dispatches nothing; a different person's co-sign executes ONCE with both people on the ledger; self-cosign refused at the service AND by the CHECK; two different co-signers racing dispatch one message; one pending per order (service + index); TTL lapse, the sweep through the real timer fan-out, and re-filing after; cancel; `received_by_lab` single-person; the co-sign re-checks evidence; the ledger's dual-control CHECKs; request immutability; cross-tenant; alerts (severity, PHI-free payload, distinct correlation ids); the repeat-attester flag; the detail and its redaction; and destruction as a real non-superuser destruction-role login (other tenant's run reaches nothing, no UPDATE, app role and superuser still refused). Unit: `orm-recovery-dual-control.test.ts` (19: the co-sign precedence, the anomaly rule, the alert builder, and a guard that every recovery alert kind has an enabled seeded rule), the two routes' permission/step-up/params cases in `orm-recovery.test.ts`, the eraser counts. **Mutation-tested: 23 mutations across every new guard, all killed** (each by the case built for it): the application-layer distinctness, the expiry guard, the already-pending pre-check, the co-sign evidence re-check, the detail redaction, the anomaly flag, the sweep in the fan-out, the ledger omitting its co-signer, the executed and cancelled alerts, the eraser skipping either table, the trigger blocking the destruction role / admitting a superuser, the missing destruction grant / policy, the dual-control CHECK, both distinctness CHECKs, the one-pending index and the freeze trigger. **Design decisions:** the co-signer needs the same `orders.amend` + step-up as the requester (a dedicated `orders.recover_cosign` permission would need a catalog change and per-tenant role grants; the two-person rule is enforced by DISTINCT USERS, not a role, and a tenant that wants role separation can grant `orders.amend` narrowly — see the F-190 note that the seeded catalog grants it very broadly); 24 h TTL (long enough to span a night shift, short enough that an attestation about the lab's state does not execute against a situation that has since changed); the repeat-attester count is the REQUESTER's (a co-signer who approves the same requester's every request is not yet flagged). **Residual:** two colluding authorized users still defeat it — the control makes a lie need two liars and leaves both on the record and in a compliance officer's inbox, it does not verify the lab; a request that can no longer execute (the order recovered another way) stays pending until it lapses or is cancelled; the alert is best-effort after commit (a failure is logged with ids only); `orders.amend` breadth (F-190) still decides who can file or co-sign.

**F-203 (#248) — the four residual risks of F-202's two-person lab-recovery control, mitigated: permission breadth, collusion, stranded requests, best-effort alerts. NONE of it verifies the lab — that cannot be done from inside the platform; it makes a false attestation costlier, louder and un-losable.** **(1) Permission breadth.** `orders.amend` (granted to nearly every clinical role) guarded resend, recover, co-sign, cancel and the held-transmission worklist, and decided who saw the lab contact's name and reference. Three dedicated keys now do (`packages/auth` `contributed.ts`): `orders.transmission.recover` (resend, file, cancel, co-sign, read the evidence), `orders.transmission.view_held` (the worklist alone — seeing it does not let anyone act on it), `orders.transmission.cosign_escalated` (the high-trust co-signer; the co-sign route is an any-of of `recover` / `cosign_escalated`, and that holder also reads the evidence because it must judge it). **WHO LOSES ACCESS:** every role that held `orders.amend` without being an administrator loses resend / recover / co-sign / cancel / the worklist / the lab contact's evidence — in the seeded catalog that is RN Case Manager, MD/NP/PA, Medical Director, Clinical Supervisor and every other clinical role; `orders.amend` itself (correct an order) is untouched. Migration `0273` mirrors the three `permission` rows and grants them to `org_admin` and `administrator` ONLY (the two roles the catalog sync grants every key to), in every existing tenant, idempotently — so no tenant is left without someone who can recover an order; a tenant grants the narrower keys to a DON / clinical lead / compliance officer on purpose. **(2) Collusion.** (a) SIGNALS: an executed recovery by a requester/co-signer PAIR at the threshold raises a `critical` `m11.order.recovery_anomaly` (`repeat_pair`, the pair's correlation id is symmetric and window-scoped so M36 keeps ONE alert per window), a high org-wide rate raises `org_rate`, and the per-recovery executed alert turns `critical` for a repeated pair; ids and counts only. (b) HARD BOUND: once a requester, or a pair (either way round), has EXECUTED `RECOVERY_ESCALATION_THRESHOLD` (3, `M11_RECOVERY_ESCALATION_THRESHOLD`, invalid falls back, never disables) recoveries in the trailing 24 h, the next co-signature must come from a holder of `orders.transmission.cosign_escalated` (409 `escalation_required`, nothing dispatched, the request stays pending); the escalated approval is RECORDED on the request (`cosigned_escalated`). The counts are taken under per-person advisory locks in a fixed order (no deadlock), so two in-flight co-signs on DIFFERENT orders cannot both slip under the edge. (c) NOT built, and why: corroborating against inbound lab data is ALREADY F-188's contradiction check (a result, an acked/queued/in-flight row) — re-run at co-sign against fresh data; there is nothing further the platform holds. **(3) Stranded requests.** A trigger on `order_record` (0273) supersedes a pending request the instant its order leaves `failed` or changes its failure reason — by ANY writer, not only the paths that remembered to — to the new terminal `superseded` with a fixed reason token (`order_discontinued`, `transmission_transmitted`, `failure_reason_changed`, …); the hourly sweep is a BACKSTOP (`order_no_longer_recoverable`) for what a trigger cannot see. Co-sign and cancel answer 409 `superseded` naming the reason. The co-sign takes the ORDER row lock first, so a co-sign racing a supersede waits and then reads `superseded` — proven with two real transactions. No alert on supersede: nothing executed and nothing lapsed unattended. **(4) Durable alerts.** Alerts are no longer emitted after commit and swallowed: the recovery's OWN transaction publishes `m11.order.recovery_alert_requested` (self-consumed by `outbox-consumers/recovery-alert.ts`, the F-187 lab-cancellation shape) and the relay retries a failed delivery; the alert's unique correlation id makes redelivery idempotent. Proven: an injected emitter outage after commit loses nothing — the event stays undispatched, the relay redelivers after its backoff, the real M36 emitter records ONE alert paging the compliance officer, a forced duplicate delivery adds none — and a failing intent publish rolls the WHOLE recovery back. F-201's exhausted / aging alerts were LEFT as they are: their emit runs in a sweep whose own retry (alert first, then stamp; the stable correlation id dedupes) already makes a failure retried, not lost. **Verified:** live as `wardenx_app` in `m11-orm-recovery.live.test.ts` (49 → 68 cases). **Mutation-tested (26 guards): 25 killed by their own tests; ONE survivor** — dropping `status='pending_cosign'` from the co-sign's own UPDATE `WHERE` is masked because the pure `decideRecoveryCosign` already refuses a settled request under the order lock and the immutability trigger refuses the write; it stays as defence in depth. **Residual:** the bound stops two people looking like one, it does not stop two colluding people who each stay under it; `orders.transmission.recover` breadth is now a per-tenant decision and a tenant that grants it widely reopens the risk; the recovery alerts are still delivered by the relay's retry policy (a dead-letter after its attempts is the existing DLQ alert).

**F-191 (#248) — `m21.supply_request.delivered`'s `m22` declared consumer is GONE, dropped at the source, not merely re-confirmed.** A scoping-only pass (not a build) checked whether M22's disclaimed "caregiver-signature flow" was real, buildable infrastructure — and found it was a catalog error instead: M22's own locked spec explicitly disclaims owning signature capture (line 126, "M22 does not capture signatures — the source module does"; line 2383 lists it as a non-goal even for M39 consent, the nearest structural analog), no capture route/seam/FormFill consumer exists anywhere in `22-documents/`, and every real signature flow in this codebase (M11/M12 orders, M7/M8/M15 attestations, M39's `ConsentCaptureEvidence`) is captured synchronously inside its OWNING module, never via an M22 outbox consumer. `declaredConsumers` corrected at the source (`events-by-m21.ts`). The underlying gap this surfaced — M21 had no caregiver-signature capture of its own at all, despite a dangling `caregiverSignatureRequestId` concept in its own spec (D7) that nothing ever wired — was scoped as a separate, undecided feature proposal and built next as **F-193**.

**F-192 (#248) — `m6.transfer.created` is GONE from the M22 group too, BOUND, not merely re-confirmed.** The wall every prior pass (F-161/F-162/F-166/F-176) hit was real but narrow: the M22 spec calls the wanted artifact "discharge_summary (transfer variant)", and no variant existed — rendering the base `discharge_summary` template would file a document titled "Discharge Summary" for a patient who was TRANSFERRED, not discharged for cause/death/routine. **Fix:** migration 0267 adds `discharge_summary_transfer` to `document_aggregate_type` (the F-099/F-144/F-161 additive-enum precedent, a fourth time); a `PLATFORM_TEMPLATE_TABLE` descriptor and a `REQUEST_SHAPES`/`M22_DOCUMENT_REQUEST_EVENTS` entry follow the identical F-161 M6-CoP/`m7.care_plan.version_signed` SOURCE-event shape — no separate `*.document_requested` sibling, the event name is the template. The payload is widened with `patientId` at both real emit sites (`transferOut`/`transferIn`, `admission-route-service-db.ts`), which already resolve the admission's patient in the same transaction (F-100's "every one of these artifacts is patient-scoped by definition" reasoning, one event over). `transfer_event.document_id` ("(M22) transfer summary", uncommented-on-but-unread since M6's schema landed) is now stamped by a new `M6_BACKREF_TARGETS` row. Fires from BOTH directions under the one event/template; content is payload-driven only (`direction`/`effectiveAt`/`otherHospiceCcn`), nothing invented beyond what the catalogued payload carries. **Verified independently** (a concurrent peer round self-labeled the same "F-192" migration comment in `packages/db/src/enums.ts` for an unrelated M21 enum during a shared-worktree edit collision — caught and corrected to F-192 on reconciliation; the build itself was untouched): `bun run build`/`typecheck`/`arch:fitness` 38/38 clean; full non-live 9,899 passed/0 failed; `test:f192:m6-transfer-render:live` 4/4 against a fresh disposable Postgres; sibling regressions `m6:cop-documents` 7/7, `f161:m7-m17-render-requests` 4/4, `f166:render-requests` 8/8, `m6:discharge-cascade` 6/6, `m6:loc-change-signed` 7/7, `m13:reconciliation-triggers` 5/5, `m23:notr-draft` 8/8, `f168:document-request-idempotency` 5/5, `f171:m22-lab-backref` 7/7, all green; `check:boot:platform` passed.

**F-193 (#248) — M21's OWN caregiver-signature capture, closing the real gap F-191 surfaced.** F-191 correctly dropped the misdeclared `m22` consumer, but M21's own spec (D7) still said "caregiver signature is optional via M22's signature flow, triggered when policy or tenant config requires it" — a mechanism M22 was never going to build and M21 had never built either; `supply_request.data`'s draft `caregiverSignatureRequestId` concept was dangling, no FK, nothing wired. **Built, deliberately narrow:** the CAPTURE capability only — nothing makes a signature REQUIRED before anything; D7's "triggered when policy or tenant config requires it" describes a separate, larger, undecided requirement-gating question this round does not touch. Migration 0268 adds `m21_caregiver_signature_capture_method` (`typed_signature_in_app` / `witnessed_verbal_documented` / `declined` — narrowed from M39's `ConsentCaptureEvidence` shape, since M21's manifest `dependsOn` has no edge to M39 and cannot import its type) and five nullable columns on `supply_request` (discrete facts, not jsonb — this table's own D7 courier-attestation precedent), with a CHECK pairing the three top-level facts and a denylist extension so the free-text evidence is scrubbed from the audit diff while the row stays the durable record. `M21WriteService.captureCaregiverSignature` runs its own load→guard→UPDATE (NOT `runRequestTransition`: a caregiver signature is evidence about an already-`delivered` row, not a §2.2 status edge) with no outbox emission — there is no event to bind. Resubmission is REJECTED (409), not overwritten or appended, matching this module's append-only posture for every other evidentiary attestation. New route `POST /api/v1/supplies/supply-requests/:supplyRequestId/caregiver-signature`, gated on a new `supplies.request.caregiver_signature` permission + `If-Match` + `Idempotency-Key`. **Verified independently:** `bun run build`/`typecheck`/`arch:fitness` 38/38 clean; full non-live 9,899 passed/0 failed; `test:m21:caregiver-signature:live` 6/6 against a fresh disposable Postgres (capture succeeds and persists; a second capture is refused 409 with the first capture intact; capture before `delivered` is refused 422; the witnessed-method evidence floor refuses an incomplete submission then succeeds with the M22 document reference landing on its own column; cross-tenant isolation returns `NotFoundError` under RLS, not a superuser probe; the audit trigger redacts the evidence jsonb while the row carries the real value); `check:boot:platform` passed. **F-number note:** an initial self-assigned "F-192" collided with a concurrent peer round's own F-192 (the M6 transfer-document build above); caught via a full-repo grep before commit and renumbered to F-193 throughout (migration comments, permission-catalog comments, lifecycle/route/service doc-comments, `check-audit-denylist-sync.ts`, `scripts/openapi/enrichments.ts`, `ci.yml`) — one stray F-193 label left behind in `packages/db/src/enums.ts`'s `discharge_summary_transfer` comment (which belongs to F-192, not F-193, since it is the OTHER round's enum value) was caught on reconciliation and corrected back to F-192.

**F-194 (#248) — `m18.evv.visit_verified` is BOUND.** M30's own `hvldl_near_death_recompute` effect and pure handler (`handleEvvVisitVerified`) already existed, fully unit-tested, unbound — but the event was never actually published: M18's check-out write path (`evv-route-service-db.ts`) never called the pure `recordEvent` decider that declared this event's effect. **Fix:** emit `m18.evv.visit_verified` inline at check-out (mirroring the existing `check_out_recorded`/`geofence_breach_recorded` emits) when the check-out pairs with an in-geofence prior check-in and no `evv_missing_resolution` is still open. Built the missing `OutboxConsumerBinding` (`buildM30VisitVerifiedConsumer`), resolving `providerEntityId` via a new org-explicit `evvVisitProviderEntityForOrg` M18 seam (M30's manifest excludes 18, port-injected per the established `CapConsumerStore` shape). `nearestDeathWithinDays` is deliberately left unresolved — the handler's own contract enqueues unconditionally when it's absent. **Verified independently:** `build`/`typecheck`/`arch:fitness` 38/38 clean; full non-live 9,899 passed/0 failed; `test:f194:m18-visit-verified:live` 4/4 against a fresh disposable Postgres; `check:boot:platform` passed.

**F-195 (#248) — `m6.admission.on_hold`/`.resumed` are BOUND.** Unlike the sibling `m6.compliance.window.*` events F-179 resolved (a REST dashboard pull that already existed), these two were genuinely unbuilt on both sides: `holdReason`/`holdAt`/`releasedAt` were write-only everywhere in `06-admission/`. **Fix:** `GET /api/v1/admissions` now projects all three (org-wide, `?state=on_hold` filterable) — the real REST dashboard read M6's spec (line 2983) describes. `m30` dropped from `declaredConsumers` on both events; no push consumer was ever the right mechanism, the F-179 shape applied here too. No migration needed (columns pre-existed). **Verified independently:** `build`/`typecheck`/`arch:fitness` 38/38 clean; full non-live 9,899 passed/0 failed; `test:m6:read:live` 11/11 (extended with a hold→resume→verify case) against a fresh disposable Postgres; `check:boot:platform` passed. **F-number note:** a three-way collision on "F-194" among this round's concurrent build forks (M18-EVV, M6-hold/resume, and the M39 mint-time-consent security fix) was caught before commit; this round's footprint was smallest and renumbered to F-195.

**F-196 (#248) — `m18.evv.late_check_resolved` is BOUND.** M17's own `evv_bracket_state` is already push-maintained by two sibling EVV consumers (`m18-evv-check-in.ts`/`m18-evv-at-patient-address.ts`), so a push consumer is this module's established mechanism, not a seam-vs-push mismatch as prior rounds (F-133/F-166/F-174) had partly framed it. M23 already has a live, bound consumer for this exact event (F-162), proving the fact genuinely fires in production. **Fix:** migration 0269 adds 4 nullable columns to `visit` (`evv_missing_resolution_resolved_at`/`_status`/`_by_membership_id`/`_reason`, the last denylisted per M17's own `evv_missing_reason` precedent) — a same-row informational stamp, not a `visit_state_history` transition (the resolution fires once the visit is already `completed`, never moving `status`). The earlier "needs a product decision on what M17 should show" framing was itself the thing blocking a build that a purely additive, non-decision-shaped stamp resolves. **Verified independently:** `build`/`typecheck`/`arch:fitness` 38/38 clean; full non-live 9,899 passed/0 failed; `test:m17:evv-late-check-resolved:live` 3/3 against a fresh disposable Postgres; `check:boot:platform` passed. **Central-verification catch:** the built consumer was correctly kept in `declaredConsumers`, but the module's own `M17_OUTBOX_SUBSCRIPTIONS` source-of-truth list was never updated to match — `arch:outbox-bindings` rule 6 caught the disagreement; fixed by registering the binding there.

**F-197 (#248) — mint-time SUD-consent re-check, a real production security/compliance gap (42 CFR Part 2), not a routine wiring task.** M22's render-time SUD-consent gate (`consent-gate.ts`'s `resolveSudConsentPresent`) was real and correct — but ran exactly ONCE, at document render time, never again. In production: the staff/general mint path (`signed-url-service.ts`'s `mint()`) had zero SUD-consent check of any kind, ever; the portal mint path's consent gate was coded but wired to always short-circuit false (`isSudVersion` defaulted `() => false` and was never actually supplied); and the production `portalConsent` port fell back to an in-memory stub even with a real database configured (`registerDocumentSeams`'s one real call site, `apps/backend/src/index.ts`, never passed it, unlike the adjacent `registerConsentSeams` call that correctly wires its own real store). **Net effect:** a 42 CFR Part 2 document rendered while consent was active stayed freely downloadable — by staff and by the patient/family portal — via a fresh signed URL indefinitely after that consent was later revoked. **Fix:** a mint-time SUD-consent re-check on both paths, fail-closed, mirroring the already-proven `isExternalDisclosure`/`resolveExternalBaaActive` BAA-check shape in the same file; the production wiring gap fixed to match `registerConsentSeams`'s own pattern. `declaredConsumers` corrected at the source (`events-by-m39.ts`, `m22` dropped from `m39.consent.revoked` — the identical reasoning already used for this event's siblings `.expired`/`.recipient_added`/`.recipient_removed` in F-176: a mint-time pull, not a push reaction). **Verified independently:** `build`/`typecheck`/`arch:fitness` 38/38 clean; full non-live 9,899 passed/0 failed; `test:f197:m22-mint-time-sud-consent:live` 7/7 against a fresh disposable Postgres (proves the vulnerability's exact shape — consent active → mint succeeds → consent revoked → same mint now refused, on both paths — a non-SUD document is never gated, and cross-tenant RLS isolation holds); sibling regressions `m22:document-seam-store` 3/3, `m34:dsar-export` 3/3, `m34:tenant-export` 3/3, `m34:tenant-export-approval` 3/3, all green; `check:boot:platform` passed. **Shared-worktree note:** this round's edits were silently wiped twice by concurrent activity in the shared working tree; the build was finished and verified in an isolated `git worktree` off the same base commit, then merged back centrally (a `package.json` conflict resolved by hand; everything else applied cleanly).

**F-198 (#248) — the `m11` group is GONE, not merely emptied (the F-115/F-164 m28/m23 shape).** Its last two pairs, `m39.consent.dpoa.agent_appointed`/`.agent_removed`, are dropped — the last holdout of the M7/M14 pattern already established (F-129/F-142 dropped both of those on the strength of a real, documented pull alternative each module had built: M7's write-time `acting_consent_id` attribution, M14's build-time packet read). M11 has neither: every order in M11's own catalog carries only `orderingPhysicianMdmId`/`certifyingPhysicianMdmId` — every order is physician-signed, never patient/representative-signed — and an exhaustive grep of `11-orders/`/`packages/orders/` for any consent/authorization/decision-making concept returns nothing. `declaredConsumers` corrected at the source (`events-by-m39.ts`).

**Decisions landed this round, scoped as future build rounds, not yet built:** `m12.medication.error_reported` (M30) — a new explicit clinician-initiated report action in M12/M13, not an auto-derived one. `m16.bereavement.plan_skipped_per_patient_opt_out` (M30) — counts as CoP coverage satisfied. `m21.supply_request.invoice_accrued`/`.invoice_reconciled` (M27) — a real 4th cost-report precedence tier for M21 supply-vendor invoices. `m9.assessment.summary_requested` (M22) — both an auto-refresh on chart-open and an explicit download/print button.

**Genuine open decisions surfaced, not yet asked:** `m19.triage_call.gip_admission_proposed` (M37) — build a minimal pending-proposal read-projection into the existing IPU intake surface, or leave GIP-proposal visibility to M19's own UI. `m17.visit.published` (M31 telehealth) — collapses to one real question: should clinicians be able to request a video-enabled telephonic visit in M17 (a new boolean flag alongside `visit_setting='telephonic'`), triggering an M31-minted Daily.co room; everything downstream (crypto wiring, the `providerEntityId` seam, M31's first BullMQ worker) is bounded, previously-proven engineering once that lands. `m11.order.recertification_signed` (M6) — genuinely blocked on a real, unbuilt clinical-compliance check (F2F-window/CTI-narrative adequacy validation before sequencing the next benefit period; F-159/F-167 confirmed `createElectionPeriod` performs no such check today), not a wiring gap or a redundant sibling. `m6.discharge.cosigned` (M16) — the bereavement decider wants an external-source-discharge cosign M6 has never implemented; the catalogued payload is the for-cause route-40 cosign instead, a different fact entirely.

**F-204 (#248) — the two-person lab-recovery control can now be completed in a small tenant: the operational roles hold the recovery keys by default, and a request nobody can co-sign is refused up front instead of lapsing.** F-203 split `orders.transmission.{recover,view_held,cosign_escalated}` out of `orders.amend` and granted them to `administrator` + `org_admin` ONLY. `not_received_by_lab` needs a DIFFERENT user to co-sign, so a tenant with a single org admin could file a recovery that no one could ever execute — it sat `pending_cosign` until its 24 h TTL. **Found while planning it:** nothing materializes `ROLE_TEMPLATES` for a real tenant (`identity-routes.ts`, `role-store.ts` say so), so `director_of_nursing` / `compliance_officer` / `clinical_supervisor` rows exist only where a tenant created them; "default grants" therefore have to be (a) a migration over the roles that exist and (b) a shared constant the dev seed and the migration are both pinned to, not a provisioning step. **Grants (`LAB_RECOVERY_DEFAULT_GRANTS`, `packages/auth/src/roles/lab-recovery-grants.ts`):** `director_of_nursing` → recover + view_held; `clinical_supervisor` → recover + view_held; `compliance_officer` → cosign_escalated + view_held (the high-trust co-signer the F-203 collusion bound asks for). `medical_director` and every discipline role get nothing — re-disclosing an order to a lab and attesting to a third party's state is an operational authority, and `orders.amend` already covers clinicians. NOT a `system_locked` floor: a tenant may still remove a key from a role it owns, and a floor would have made every existing tenant's role fail `floorViolations` until backfilled. **Migration `0274_m11_lab_recovery_default_role_grants.sql`:** one idempotent `INSERT … SELECT … ON CONFLICT DO NOTHING` over `role` joined to the VALUES table, only for roles that exist (a tenant with none is unchanged), never removes a grant; `seed-staff-personas.ts` grants the same keys to the dev roles (the keys are `admin`-category, so the field-staff category filter never included them). **The pre-check:** `RecoveryControls.countEligibleCosigners(organizationId, excludeUserId)`, wired in the composition root from TWO halves that each read only their own tables (`arch:tables` refuses M11, M3 and Foundation each other's tables, and the M3 half may not read `membership`; the same split `createDbAdminMembershipReader` already uses): M3's `createMembershipsHoldingPermissionReader` (`03-authorization/permission-holders.ts`) returns the memberships holding either key through an enabled, unexpired role assignment, and Foundation's `buildM11CosignerCounter` (`bootstrap/m11-cosigner-counter.ts`) resolves them to distinct ACTIVE users other than the requester, both under the caller's org context (RLS-scoped). When it is 0, filing `not_received_by_lab` is refused with a 409 `no_eligible_cosigner` that names the fix (grant the key to a second person), BEFORE anything is written; `received_by_lab` (single-person) never asks. Absent port ⇒ no pre-check, as before. **Tests (live, real NOBYPASSRLS role):** the migration's VALUES table equals the constant (drift fails), the migration grants exactly the three roles' keys where they exist, replays idempotently, gives `medical_director` / `rn_case_manager` nothing; the pre-check refuses with nothing filed and the order untouched, passes the right (org, requester) to the port, files when a co-signer exists, and never applies to `received_by_lab`; the counter, in its own fresh tenant, ignores `view_held`-only holders, the requester, lapsed assignments, disabled roles and suspended memberships, counts a person holding both keys once, counts a `cosign_escalated`-only holder, and is invisible across tenants. Recovery suite 68 → 71. **Mutation-tested (each fails exactly its own tests):** the requester not excluded, a disabled role counted, the pre-check disabled (2 tests), a migration row dropped (3), the constant drifting from the migration (3). **Not proven / residual:** the count is a point-in-time check — a co-signer removed between filing and co-signing still leaves a request that lapses (F-203's superseded/TTL path covers it); a tenant that never creates a DON/supervisor/compliance role still has only its admins as holders, so the 409 is the signal to grant one. `orders.amend` is unchanged.

**F-number/migration collision note (#248) — a peer session merged its own F-204 (the lab-recovery entry above, migration 0274) directly onto local `main` while this round's four forks (self-numbered F-204..F-207) were running in isolated worktrees, branched from one commit behind.** Caught before merge, not after: each of the four forks was rebased onto the new `main` tip and renumbered — F-204→**F-205** (m12), F-205→**F-206** (m16, migration 0274→0275), F-206→**F-207** (m27, migration 0274→0276), F-207→**F-208** (m9, migration 0274→0277) — inside their own isolated worktrees, each re-verified independently after the rename (build/typecheck/`arch:migration-numbering`/`arch:fitness`/its own live suite/`check:boot:platform` green), before any of the four touched the shared tree. This is the same class of collision F-195's own history note already describes for an earlier round (a three-way "F-194" collision among concurrent forks); isolated worktrees prevent the FILE-level collisions that caused that round's repeated stash/pop wipes, but do not, by themselves, prevent a NUMBER-level collision, since a worktree branched from an older commit cannot see a number a sibling fork (or a peer session merging independently) claims after that point. The fix is the same either way: renumber on merge, never on the strength of what was free at dispatch time.

**F-205 (#248) — the m30 `handlers-unbound` group is GONE, not merely emptied.** `m12.medication.error_reported`, the group's last remaining pair, is now bound. F-165/F-174 had found this event's real blocker was "no producer anywhere" (the actor-identity half F-150 originally blamed was wrong — the catalogued payload already carries a real `reportedByMembershipId`). The user decided the missing producer: a new explicit clinician-initiated "report error" action on the medication order (M12), not an auto-derived one. **Built:** `POST /api/v1/medication-orders/:id/report-error` (`reportMedicationError`, a new `prescribing.report_error` permission), and `buildM30MedicationErrorReportedConsumer` binding the pre-existing pure `handleMedicationErrorReported`/`createIncidentDraft` handler (real since F-185), resolving `providerEntityId`/`locationId` via a new M12→M6 seam chain (`medicationOrderScheduleContextForOrg` → `admissionSchedulingContextForOrg`), the F-166 M13 dose-materializer precedent. `events-by-m12.ts` widened (`summary`, optional) and `IncidentTriggerEvent`'s m12 variant widened (`medicationErrorId`). **Verified independently** (after the F-204 rebase/renumber above): `build`/`typecheck`/`arch:fitness` 38/38 clean; `test:f205:m12-medication-error-reported:live` 3/3 against a fresh disposable Postgres (happy path + redelivery-idempotent, cross-tenant no-op, cross-tenant isolation); full non-live suite 670 files / 10,023 passed / 0 failed; `check:boot:platform` passed. A pre-existing, unrelated M12 write-lifecycle live-suite flake (`recordVerbal`'s `OrderSignatureProvider` seam not registered) was independently confirmed to reproduce identically on the unmodified base commit and correctly left untouched — worth its own follow-up issue, out of scope here.

**F-206 (#248) — `m16.bereavement.plan_skipped_per_patient_opt_out` is BOUND, GONE from the m30 `no-consumer-surface` group.** F-115/F-148/F-161 all reached the same "genuine gap, open product decision" conclusion — the event carries no `planId` (nothing was ever opened), so `planClosureCounts` can't answer it either, and whether an opt-out-skipped death belongs in the `bereavement_coverage_rate` denominator was undecided. The user decided: yes, counts as CoP coverage SATISFIED. **Built:** a new, idempotent `bereavement_cop_opt_out_credit` table (migration 0275, RLS+FORCE, audit trigger, org-scoped index), recorded at the real live emit site (`m5-patient-opt-out-changed.ts`'s `skip` branch) on `(organization_id, source_event_id)`; `copOutreachCounts` (`16-bereavement/seams/drizzle-store.ts`) now sums matching credits into both the numerator and denominator of the measure — the F-150 `enqueueRecompute` pattern, a seam-pull relationship (`declaredConsumers` drops `m30`, `seamConsumers` gains it on `events-by-m16.ts`), not an outbox binding. `m15.volunteer.ratio_recomputed` stays deferred in the same group, unchanged — a separate, still-undecided M27-hours seam gap the opt-out decision never touched. **Verified independently:** `build`/`typecheck`/`arch:migration-numbering`/`arch:fitness` 38/38 clean; migration 0275 applies cleanly at its new ordinal (297 migrations total); `test:m16:opt-out-changed:live` 7/7 against a fresh disposable Postgres (credit-row creation, idempotent redelivery, `close_early` does NOT credit, end-to-end `copOutreachCounts` before/after delta proving +1/+1 semantics); `check:boot:platform` passed.

**F-207 (#248) — the `m27` group is GONE, not merely emptied.** `m21.supply_request.invoice_accrued`/`.invoice_reconciled`, the group's last remaining pair, are now bound. F-130/F-167/F-174 sharpened the real blocker over three passes: M27's expense-input model is GL-account-level and period-aggregated (`trial_balance_import`/`cost_center_mapping`/Worksheet A), with no per-transaction accrual precedent except `bad_debt_record` (scoped to one already-created cost report) and no fiscal-year field on either M21 payload. The user decided this as a 4th cost-basis precedence tier, additive to D17's M13 administration → M12 ordered → manual entry chain, not a replacement of the GL-mapped Worksheet A figure. **Built:** a new `vendor_invoice_line` table (migration 0276, RLS+FORCE, audit trigger, retention class `compliance`, no PHI) + a new `m27_vendor_invoice_status` enum, and `buildM27VendorInvoiceConsumer`, which resolves the fiscal-year `cost_report` by `(providerEntityId, factDate)`, inserts an idempotent accrual row (`ON CONFLICT DO NOTHING`), and updates the same row on reconciliation guarded on `status = 'accrued'` — dead-lettering (not guessing) when a fact falls outside every open report's window. `architecture/module-manifest.ts`/`.cjs` `ownedTables` updated for M27; M27's own `M27_OUTBOX_SUBSCRIPTIONS` source-of-truth list (`27-cost-report/consumers/subscription-map.ts`) was missing both new events at first pass — `arch:outbox-bindings` rule 6 caught the disagreement once the deferred-registry entry was removed (the F-196 lesson, one round later); fixed by adding both as a new `vendor_invoice_accrual` effect kind. **Verified independently:** `build`/`typecheck`/`arch:migration-numbering`/`arch:fitness` 38/38 clean; migration 0276 applies cleanly at its new ordinal; `test:f207:m27-vendor-invoice:live` 3/3 against a fresh disposable Postgres; full non-live suite 670 files / 10,023 passed / 0 failed; `check:boot:platform` passed.

**F-208 (#248) — `m9.assessment.summary_requested` is BOUND, GONE from the m22 `handlers-unbound` group.** The user decided both triggers: an auto-refresh on chart-open AND an explicit download/print button. **Built:** chart-open auto-refresh (freshness-throttled, not a new dedup table) plus a new `POST /api/v1/patients/:patientId/assessments/summary/document` explicit download/print route; both emit the real event, and M22 renders a new `assessment_summary` document type (migration 0277, additive enum value) as ONE EVOLVING per-patient document — `patientId` is the aggregate, no per-request id on the payload — appending a new version per request via F-168's `document_version.source_event_id` idempotency-key mechanism, the fix that makes an evolving-document interpretation (vs. one-per-snapshot) safe: repeated/successive render requests against the same aggregate correctly produce new versions instead of silently no-opping. Fixed 2 hardcoded M22-event-list unit tests, and **9 sibling M22 live suites** whose boot catalogs needed `M9_OUTBOX_EVENTS` added — the shared render consumer's `eventTypes` is the whole `M22_DOCUMENT_REQUEST_EVENTS` array, so adding this event broke every sibling's dispatcher construction until fixed (F-144/F-161/F-166/F-168/F-192/GAP-023-024-038/GAP-051/M6-CoP/M27-ECR). **Nested-worktree gotcha found and self-corrected:** editing a `packages/quality`-adjacent file inside the isolated worktree initially produced a false type error because Bun/Node's module resolution silently walked up to the MAIN tree's `node_modules` for `@wardenx/*` workspace packages; fixed by running `bun install` inside the worktree itself to relink — a real finding for any future worktree-isolated fork touching `packages/*`. **Verified independently:** `build`/`typecheck`/`arch:migration-numbering`/`arch:fitness` 38/38 clean; migration 0277 applies cleanly at its new ordinal; `test:f208:m9-assessment-summary-render:live` 5/5 against a fresh disposable Postgres; the 9 sibling suites re-verified sequentially (to avoid a schema-reset race when run concurrently against one database) — F-144 10/10, F-161 4/4, F-166 8/8, F-168 5/5, F-192 4/4, GAP-023/024/038 14/14, GAP-051 5/5, M6-CoP 7/7, M27-ECR 7/7, 64/64 total; full non-live suite 670 files / 10,023 passed / 0 failed; `check:boot:platform` passed.

**F-215 (#248) — three misdeclared pairs dropped at the producing catalog entry (declared-but-unbound 18 -> 15).** Each re-verified against the consumer's OWN spec and the code (the F-180 precedent: `m15.plan.discharged` etc.). (1) `m15.volunteer.ratio_recomputed` -> m30 dropped (now `seamConsumers: ["m30","m33"]`): the event carries only the volunteer-minute numerator, M30's spec (§1.1 line 138) names only `volunteer_compliance_gate_rate` from M15 via `DisciplineComplianceProvider`, and M33 already pulls by seam; F-180 had itself flagged that this would likely drop. The m30 register group (its last pair) is deleted outright (F-115/F-164/F-198 precedent). **Separate, non-outbox gap, unchanged and NOT closed here:** nothing supplies M30's volunteer-hours *denominator* — `staffPatientCareMinutes` defaults `null` in M15's `seams/drizzle-store.ts`, the composition root never supplies it, M27 ships no hours seam. (2) `m39.consent.expiring_soon` -> m14 dropped: M14's spec never mentions consent expiry; it reads consent only via `consent.evaluate` at packet time. `seamConsumers: ["m36"]` kept. (3) `m20.safety.high_risk_area_entered` -> m17 dropped; the m17 register group (its last pair) deleted. M17's spec has zero mentions of high-risk areas, M20's banner is a read-time render, and no producer exists (only the M36 alert builder, `alerts.ts`). Note the producer-side claim in M20's own "Consumed by" line (M17 "surfaces a visit-row warning badge") is unsupported on the consumer side — the consumer's decisive text wins (F-101). No runtime behavior change; subscription lists unchanged.

**F-216 (#248) — `m5 <- m39.consent.expired` is BOUND, and M39's expiration/reminder crons are built (declared-but-unbound 15 -> 14; the m5 register group is deleted).** F-167 left this pair deferred because NOTHING produced the event: `M39_QUEUES`/`shouldExpire`/`dueReminders` (`packages/consent/src/jobs/index.ts`) had zero callers under `apps/backend`, so a consent past `expires_at` stayed `status='active'` forever and M5's persisted `sud` flag (read from the snapshot by `privacy-flag-reader.ts`/`admission-clearance-reader.ts`) stayed lifted — a real 42 CFR Part 2 gap, not just a dead catalog row. **Built:** `apps/backend/src/modules/39-consent/jobs/` (`index.ts` data, `expiration.ts` bodies, `cron-workers.ts` BullMQ shell) + `wiring.ts` (`M39_PLATFORM_JOB_ID = "m39.platform_crons"`, `wireM39Tenancy`), constructed in `apps/backend/src/index.ts` next to M14 (`registerM39CronWorkers`/`scheduleM39Jobs`, `attachDlqAlertsToAll`). Two hourly (`0 * * * *`, spec §4.9) queues on the package's `M39_QUEUES` names: `m39.consent_expiration` (active + `expires_at <= now` -> `expired`, `FOR UPDATE SKIP LOCKED`, UPDATE re-guarded `status='active'`, `nextConsentStatus(...,"tickExpired")` + `shouldExpire` composed, `m39.consent.expired` published through the real catalog-validating publisher in the SAME tx) and `m39.expiration_reminder` (one `consent_expiration_reminder` row + `m39.consent.expiring_soon` per (consent, kind), idempotent on `idempotency_key` with `ON CONFLICT DO NOTHING`; only the most urgent OPEN window fires, restricted to the type's `reminder_cadence_floor`). Org-explicit, one `withOrgContext` tx per page, fan-out collects per-org failures and rethrows together (M14 review-clock-sweep precedent). **First-run backlog bound:** a deployment with lapsed-but-`active` consents flips at most `M39_CRON_BOUNDS.pageSize * maxPagesPerOrg` = 100 x 10 = 1000 rows per org per hourly tick (one short tx per page of 100; the remainder drains on later ticks; proven live with 1005 rows). Reminders likewise never burst all five windows for a consent already inside several. **Renewal-safety catch (found while designing the M5 side, fixed, not in the brief):** `renew` leaves the PRIOR record `active` until its `expires_at` passes, so the normal flow (reminder -> renew -> old ticks to expired) would have made a naive `expired -> active:false` re-restrict SUD while the renewal is live. The `m39.consent.expired` catalog payload gained an OPTIONAL `remainingActiveConsentRecordId` (another active same-patient+type consent exists); M5's consumer recomputes as ACTIVE in that case. The `revoked` path has the same latent shape with a second active consent; left as-is (out of scope, revoke of one of two concurrent Part-2 releases). **M5:** `m39.consent.expired` added to `M5_CONSENT_PRIVACY_CONSUMER.eventNames` (`05-patient/outbox-consumers/m39-consent-privacy.ts`, already built/wired in `index.ts`); `arch:outbox-bindings` subscription lists regenerated (`outbox:deferrals:update`, no list delta). **Not done / limits:** only the two outbox-producing crons are built (cascade-retry, renewal-cycle-close, draft-auto-expire, eval-audit-partition remain unbuilt); a tenant overlay's tighter cadence is not consulted (platform floor only); the reminder scan re-reads every active consent inside the 90-day window each hour (keyset-paged, capped 1000/org/run); recipient resolution for the alert stays M36's. **Live proof** (`test:m39:consent-expiration:live`, real NOBYPASSRLS `wardenx_app`, real publisher + real `createOutboxDispatcher` + M5's real consumer, CI job row "M39 consent expiration crons"): lapsed Part-2 flips and M5's snapshot goes `[]` -> `["sud"]` within one `tick()`; idempotent rerun emits nothing; revoked/superseded/already-expired/future/indefinite rows untouched and silent; org A's job never touches org B (fan-out then expires B); renewal-safe; non-Part-2 type drives no flag; 1005-row backlog bounded 1000 + 5; reminder emitted once, floor honored. Mutation checks (WIP snapshot committed first): skip the flip (5/8 fail), drop the M5 eventName (snapshot test fails), run under the wrong org (5/8 fail), drop the renewal field (renewal test fails), break reminder idempotency (reminder test fails); removing ONLY the SELECT `status='active'` guard is caught by the backlog test alone because the UPDATE guard and `planConsentExpiry` independently keep revoked/superseded rows safe (three layers — the suite does not kill a single-layer removal for the revoked row). **Ops hazard recorded:** `db:provision-roles`/`check:boot:platform` on a second database inside a cluster that live suites reset makes `DROP ROLE wardenx_app` fail in every suite (cross-database role dependency); drop the boot database and `wardenx_platform_login` before running the live suites.
**F-224 (#248) — `m19.triage.summary_requested` is BOUND, GONE from the m22 `handlers-unbound` group; its producer is an EXPLICIT staff action.** The group's last reason said the event had no producer, an undefined trigger ("tenant policy / disposition trigger"), a catalogued payload with no `recipientKind` while `M19TriageSummaryRequestedPayload` required it, no summary `document_aggregate_type` value and no M22 template — all five re-verified against the code before building. The user decided the trigger: a deliberate action by a clinician, not an automatic one. **Built:** `POST /api/v1/triage-calls/:triageCallId/request-summary` (`requestSummary`; new `triage.request_summary` permission in `M19_CONTRIBUTED_PERMISSIONS`, category `triage` like its `triage.disposition` sibling — the dev field-staff seed grants the whole `triage` category, and the spec's §4.6 role list names RN/NP; there is no code-side M19 role-grant table to edit; per-call `triage_call_owner_or_supervisor` ABAC; `Idempotency-Key`, which the platform replay cache turns into "one key, one answer" — proven over real HTTP; the D13 AI-block as a new `rejectAiActor()` on M19's `routes/actor.ts`, the M24 shape; 404 for a cross-tenant call id). Body is ONLY `recipientKind` (caregiver | attending); the content is assembled server-side. **Write-transaction guards** (not only the route): the call must be `documented_pending_encounter`/`documented`/`closed` with a selected disposition that has an outcome to tell (not `abandoned`/`escalated_unresolved`, checked independently of the state because the CHECK constraints admit a `documented` row carrying either) and an identified patient; a vendor-class session is refused (an in-agency disclosure). Each refusal writes nothing to the outbox. **The catalogued payload was fixed, not just documented:** `recipientKind`, `patientId`, `callOpenedAt`, `requestedByMembershipId`, `disposition` and four nullable structured facts; the real catalog publisher refuses a payload without `recipientKind` (proven). **PHI, decided conservatively:** what crosses the outbox row and the rendered PDF is an ALLOWLIST (`clinical/triage-summary.ts`): the disposition enum, a discipline token (validated as a short `[a-z_]` token — prose is dropped), arrival instants/dates, a transport enum. NEVER a free-text field (`educationSummary`, `instructionsGiven`, `reason`, `electionText`, `gipCriteriaSummary`, `preferredFacility`), a protocol answer, a transcript or a medication. Medications and answers are where 42 CFR Part 2 content lives (M19's own `redactSudMedications` exists for that reason), so the summary carries nothing SUD-class and needs no per-document M39 consent decision; the PDF builder reads the same fields by name a second time, so a producer bug that leaks a field onto the wire still cannot reach the bytes (proven with a sentinel in every free-text field, on the outbox row AND the stored PDF). Not flagged `isSudClass`, so F-197's render/mint gates do not fire; if a future revision wants clinical free text in the summary it must resolve `sudDisclosurePermitted` (M39) like `readTriageMedicationContext` and set `isSudClass` — the allowlist is the single place that has to change deliberately. **M22 half (F-099/F-100/F-208 pattern):** migration 0290 adds TWO `document_aggregate_type` values (`triage_summary_caregiver`, `triage_summary_attending` — one per audience so the two never interleave in one version chain and the portal/mint gates can key on the audience), mirrored in `packages/db/src/enums.ts` and `packages/types/src/documents.ts`; two `PLATFORM_TEMPLATE_TABLE` descriptors (`clinical_record`); a `REQUEST_SHAPES` entry (`aggregateIdFields: ["triageCallId"]`, `templateKeyByField` on `recipientKind` — an unknown value throws, never a guess — `appends: true`); the `M22_DOCUMENT_REQUEST_EVENTS` membership; and a real PDF builder per template (`render-pdf/triage-summary-doc.ts`: fixed lay-language outcome text for the caregiver, no internal ids; call reference + enumerated facts for the attending; no patient name, the document is filed on the chart by `patient_id`). One document per (call, audience), a new version per explicit re-request via F-168's `source_event_id`. **Sibling fallout:** the render consumer's `eventTypes` is the whole `M22_DOCUMENT_REQUEST_EVENTS`, so the 10 M22 live suites that build a boot catalog needed `M19_OUTBOX_EVENTS` (the F-208 lesson, again), plus 2 hard-coded-list unit tests.

**F-218 (#248) — `m19.triage_call.care_plan_change_indicated` is RESOLVED as a seam pull and LEFT the m14 group.** Premises verified: the producer fires only in `dispositionPayloads`' `gip_admission_proposed` arm (`changeKind: "level_of_care_gip_proposed"`); `PacketFlaggedEventDigest.kind` was a closed five-member union; the T-24h packet worker (F-171) already pulls flagged events through `flaggedEventSources`. **Built:** the union gains `triage_care_plan_change`; the worker's `FLAGGED_KINDS` accepts it; the pure builder folds it into the ONE `level_of_care_candidate` cover flag (a hospitalisation/ER event in the same packet yields one flag with a combined detail, never two flags of a kind); a new M19 org-explicit published read `idgTriageCarePlanChangesForOrg` (batched by patient, 500-patient cap, `withOrgContext` + an explicit `organization_id` predicate, ids + enum + instant only — no criteria text) is the fourth `flaggedEventSources` entry in BOTH `apps/backend/src/index.ts` and `scripts/db/run-idg-packet-build.ts`. M19's catalog moves `m14` from `declaredConsumers` to `seamConsumers` (a push declaration with no binding defers every row forever). Every other exhaustive consumer of the union was audited and needed no change: the typebox/OpenAPI `kind` is `Type.String()`, the packet-content projection, the PDF (`humanize`) and the web panel render it generically, and `applySudRedaction` keys on `sourceId`. Proven end to end in `m14-packet-build.live.test.ts` (a real GIP-proposed call inside the cursor window counts, one before it and a non-GIP disposition do not; the cover flag is derived; no criteria text in the snapshot; a fourth-source cross-tenant check).

**F-219 (#248) — `m19.triage_call.gip_admission_proposed` reaches M37 as a seam pull; the m37 group is GONE.** Premises verified: `ipu_admission.admission_id`/`level_of_care_period_id`/`provider_entity_id` are all NOT NULL and none exists at proposal time; the event is absent from M37's authoritative §4.5 table and present only in §1.1 prose and the intake-worklist screen row (§6.1 #3: "M19 GIP-proposed entries"). **Built:** the ONE M19 read both consumers share (`gipProposalsForOrg`, `19-oncall/seams/gip-proposals-for-org.ts` — the same `disposition = 'gip_admission_proposed'` transition feeds F-218, so there is one query and one projection; `proposedAt` is the call's first `documented_pending_encounter` history row, falling back to `updated_at`; `gipCriteriaSummary` never crosses, `preferredFacility` crosses to M37 only); M37 `GET /api/v1/ipu-intake/gip-proposals` (`m37.ipu_admission.read`, list audit) over a structural `GipProposalReader` port injected in the composition root (M37 has no `dependsOn` edge to M19) — an unbound reader THROWS rather than rendering a silently-empty "nothing proposed" list; a read-only "GIP proposals from after-hours triage" section on the web admissions worklist (no row actions, no patient name, nothing when there are none, a notice when the read fails). M37 gains NO table and writes no `ipu_admission`; the durable M11 LOC order -> M6 `requires_ipu_bed` -> M37 path is untouched. **Not built, by decision or scope:** the section lists proposals but offers no "open the triage call" link (the M19 triage screens live under a different route family with their own gates), and there is no dismissal/retention semantics — a proposal stays listed while the call's disposition is `gip_admission_proposed`, which is exactly the state a later M11 order does not change today; both are follow-ups for when the LOC-order hand-off exists.

**Verification (F-218/F-219/F-224), on a disposable Postgres 18 (own port, `max_locks_per_transaction=4096`, one live suite at a time), Redis and MinIO:** `build`/`typecheck` (+`typecheck:tests`)/`arch:fitness` 38/38 clean; `arch:outbox-bindings` declared-but-unbound 18 → 15 pairs; non-live suite 704 files / 10,480 passed / 0 failed (the live files skip without a DB env); `test:f218-f219-f224:m19-triage-pairs:live` 11/11 on the real NOBYPASSRLS `wardenx_app` role (real write service -> real catalog publisher -> real dispatcher -> real M22 render; cross-tenant, redaction sentinel on outbox row and PDF bytes, idempotent append, every refusal writes nothing, both M19 events DISPATCH instead of deferring); `test:m14:packet-build:live` 15/15; every M19, M14, M22 and M37 live suite re-run one at a time against the final tree — 35 suites / 396 tests, all green (M19: inbound-triggers 18, roster-sync 12, RLS 26; M14: packet-build 15, write 34, read 14, enrichment 4, autoclose 8, since-last-idg cache 13, clinical-event consumers 3, RLS 19; M22: the ten render-request siblings 10+4+12+5+4+5+5+7+7+14, write 15, read 5, medication-list 6, lab-backref 7, F-197 mint-time 7, seam-store 3, RLS 21; M37: write 12, privacy gates 16, RN coverage 9, discharged-cascade 8, death-recorded 7, RLS 30); `check:boot:platform` passed; the changed routes were hit over real HTTP against the actual backend booted on an isolated disposable stack (API :3917, PG :55917, Redis :56917, MinIO :9917; the dev stack was never touched): 400 without the key, 422 on a bad `recipientKind`, 409 for an open call, 200 + an identical replayed answer for a repeated key, 401 unauthenticated on the worklist read, the relay delivered both requests and M22 stored a real PDF per audience in MinIO (lay text present, sentinel absent). **Mutation checks** (after a WIP commit, each reverted): free-text spread into the summary content (caught by the unit allowlist test and, after one strengthening, the live outbox-payload assertion); removing the summarizable-disposition guard (NOT caught at first — the state guard masked it — a `documented`+`abandoned` seed now catches it); removing the vendor guard; restoring `declaredConsumers: ["m37"]` on the GIP event (the live "both events DISPATCH" test and the catalog unit test fail); dropping the disposition predicate of `gipProposalsForOrg` (NOT caught at first — the distractors were never asserted absent — now caught); dropping the since cursor; mapping `attending` to the caregiver template; removing `triage_care_plan_change` from the worker's `FLAGGED_KINDS` (unit and live). **Shared-host note:** Postgres roles are cluster-global, so a second database on the same disposable server (used for the HTTP check) makes every live suite's `DROP ROLE wardenx_app` fail until that database is dropped — the failure looks like a wall of skipped suites, not a role error.

**F-229 (#248) — `m21 <- m11.order.supply_fulfillment_requested`: STOPPED before inventing a contract; the M5 full-address seam is BUILT, the pair stays deferred with a sharper reason.** The triage premises were each checked against code and specs. TRUE: `dme`/`supply` are `contract_not_published` (`packages/orders/src/kinds.ts`, deliberately "instead of inventing clinical fields"); `PatientAddressReader` had no street-address method; `comfort_kit`'s canonical shape is `{kitSku, deploymentSite, preferredDeliveryWindow?, notes?}` while M21's `ComfortKitDeployRequestDataSchema` requires `comfortKitTemplateId`/`contents`/`pharmacyDispatchMode`. PARTLY FALSE: `pharmacyDispatchMode` is NOT an unanswerable gap — M21 §3.1.5/D4/D6 define it (routing-rule `default_pharmacy_dispatch_mode`, per-Location override) — and `hcpcs` for a SKU is derivable from `supply_item.hcpcs` (§3.1.3); what is missing is the SKU itself. The decisive gaps, none closable by code: (1) neither M11 §2.1 nor M21 §2.1/§4.5.1 names which `order_record.data` field carries a dme/supply `skuId`/quantity/cadence (M21's schema fields exist only on M21's own request row), and "publish M21's schema as M11's contract" would make it strict for every existing dme/supply draft (M14 IDG-spawned orders, the order editor, ~15 tests) and invent the clinician field set M11 declined to; (2) `comfort_kit.kitSku` is free text with NO mapping to a `comfort_kit_template` (templates carry only `name`), so `contents` cannot be resolved without inventing a matching rule, and `snf`/`ipu` sites need an `ipuRoomId` M11 never captures. **Built:** `PatientAddressReader.primaryAddress(organizationId, patientId)` (M5, `05-patient/address-reader.ts`; org-explicit, own `withOrgContext`, explicit `organization_id` predicate; deny-stub updated) proven live on the NOBYPASSRLS role (`m5-address-reader.live.test.ts`, `test:m5:address-reader:live` + `ci.yml` row): current primary row only, null when none, cross-tenant null. PHI posture for the eventual consumer: the payload already carries ids + `supplyDetail` only; the consumer PULLS the address through this seam at consume time, so it never rides the outbox. **Recommendation (option A in the register entry):** a product decision publishing versioned `dme.v2`/`supply.v2` (`{skuId, quantity, unit?, rentalCadence?, needsInstallation?, needsPatientEducation?}`, no address; hcpcs read from `supply_item`) and a template-code for `comfort_kit.kitSku`; after that the bind is mechanical (decider `decideSupplyFulfillmentIntake` exists; idempotent on `sourceOrderId`; settle on unresolvable address/SKU/contract). Declared-but-unbound count unchanged.

**F-231 (#248) — `m22 <- m12.medication_order.draft_created_from_extraction` and `m22 <- m5.patient.draft_created_from_extraction`: re-verified, STOPPED, nothing built (2026-09-30).** The pair was triaged as "waiting on M32 and the DocLens flag". Checked fresh, that framing is too small: the flag and M32 are the LEAST of it. Verified facts: (1) the only emit of the M12 event is the in-memory reference service (`12-dosespot/routes/service.ts`, `fromExtraction`); the real `dosespot-route-service-db.ts` emits only `draft_created`; (2) the M5 event has a catalog entry (`05-patient/events-by-m5.ts`) and no emit site; (3) nothing emits `m22.extraction.commit_requested` (only the name list in `packages/types/src/documents.ts`), and `events-by-m22.ts` has no `m22.extraction.*` catalog entry, so the emit itself would need catalog entries first; (4) `POST /api/v1/intake/jobs/:id/extraction/commit` builds a stub run with empty candidates and chart targets, and no code writes `extraction_job`/`extraction_candidate`/`extraction_provenance` (only the review/decision rows are written, by the T07 route); (5) M32 is built, but the four DocLens capabilities are `DESIGN_REVIEW` (`packages/ai-platform/src/inventory/capabilities.ts`), the seam `projector` (§2.5 typed output schemas) and `actors` ports are unbound (`32-ai-platform/seams/published.ts` header), and the ten inference seams stay deny-stubs until a per-tenant DEK cipher exists (`index.ts`); M22's `resolveDocLensCapability()` is still the deny-stub.

**Why it is a stop, not a build (spec conflicts and gaps that are governance/clinical decisions):** (a) M12 D12 and AI Governance §2.1.1 hard-block AI-introduced changes to medications; M12 D12 explicitly rejects "AI proposes, clinician approves" for `medication_order` ("every approval gate has a bypass path ... until validated; a substantial safety review that hasn't happened"). M22 D4/D5 and Governance §7.3.2 nonetheless route human-approved medication candidates into an M12 draft. Both cannot be fully true; Governance is architecture, but §7.3.2 and §2.1.1 themselves disagree on whether "hard block" admits a human-approved draft. (b) M12 gives the consumer only an event-table row: no field mapping (name/RxNorm/strength/sig/route), no rule for the draft's prescriber (M22 must not bypass `prescriber_eligible`; the reviewer need not be a prescriber). (c) M5 names a consumer `m5-draft-created.ts` on the M22 side only; it never says whether the commit creates a new `prospective` patient or changes demographics of an existing one, nor which fields. (d) Promoting `doclens_*` from `DESIGN_REVIEW` is an AI Safety Owner act (Stage 1-4 evaluation), not an engineering edit.

**Options:** A) Decide (a) first. A1: medications are excluded from DocLens writeback (extracted meds stay read-only review evidence; only low-risk demographics flow) — consistent with M12 D12 and the safest; the M12 pair would then be DROPPED at the source. A2: allow a human-approved DRAFT with a dedicated M12 safety review and a `source='doclens_extraction'` marker that blocks signing until a prescriber re-enters the order — needs a spec amendment to M12 D12 and Governance §2.1.1/§7.3.2. B) For M5, decide "new prospective patient vs. demographics proposal" and the field allowlist (low-risk fields only, per §7.3.2). C) Then build the chain in this order: catalog entries for `m22.extraction.commit_requested/_completed`; persistence of pipeline results (DEK-encrypted `value_cipher`, never trusting client-supplied values at commit); M32 projector + provider behind a typed port (test double in tests only, fail closed when flag off / no provider); a permission-gated, Idempotency-Key, AI-blocked, step-up commit route reading server-side decisions and Part 2 gating (`sud_consent_present`, F-197/F-214); the M5 (and, if A2, M12) consumers and real-DB emits; then the two M22 back-reference consumers. **Recommendation:** A1 + B (M5 demographics, low-risk fields only) first; drop the M12 pair; build the M5 chain; keep `doclens_*` at `DESIGN_REVIEW` until the AI Safety Owner promotes it. The register reason was updated; both pairs remain deferred and `arch:outbox-bindings` is unchanged.

**F-227 (#248) — `m16 <- m6.discharge.cosigned` is BOUND, the m16 group is GONE (declared-but-unbound 7 -> 6), and the M6 external-death applier — which had never actually worked — now does (migration 0300).** F-159/F-167 held this pair blocked on a payload mismatch (`{dischargeEventId, medicalDirectorCosignedAt}` vs `decideCosignReceipt`'s `{sourceProposalId, cosignedAt, medicalDirectorMembershipId}`) and on `discharge_event` having no source/cosign columns. Both were M6's gap, decided by M6's spec (§4.8.4 `recordExternalDeath`, W-M6-31, W-DC-02, D14) and M16's D18. **Two triage premises were WRONG and are corrected here.** (1) "The external-death applier records the death as completed through the normal `discharge()`": it never completed anything — `recordExternalDeath` called `service.discharge({reason:'death'})` with no `deathCertifierId`, so `checkDischargeNarrative` threw `DEATH_CERTIFIER_INVALID` (R-DC-01) before a row was written, and its second transaction re-published `m6.discharge.death` without the `deathCertifierId` F-172 made required, which the catalog publisher would have rejected; every accepted external death dead-lettered. (2) "Record it as `pending_cosign` (admission not yet discharged)": that is the **for-cause** path (D11). M6 §4.8.4/W-M6-31 say the opposite for an external death — the discharge is recorded `completed` **immediately** (admission -> `bereavement`, election/LOC ended, `m6.discharge.death`, `m6.bereavement.eligible`) with a `cosign_required=true` flag, because the external notice "is not the source of truth on cause-of-death" and the director attests afterwards (7 days, via a parallel `external_discharge_notice` compliance window). Building `pending_cosign` would have held the admission active and delayed bereavement/census/billing on a fact the spec says is true now. **Built.** Migration 0300: `discharge_event.source` (CHECK internal_clinician_recorded|hl7_external, default internal), `source_proposal_id` (logical uuid, no FK; unique per org), `cosign_required`, `medical_director_membership_id`, `cosigned_at` (CHECKs: external => proposal + cosign_required; cosign facts land as a pair) — idempotent, code-side mirror in the `packages/db` schema (no enum/table change, so no manifest change). `DischargeInput.externalSource` (applier only, never the HTTP body) stamps provenance in the same transaction as the discharge row and waives the pronouncing-certifier capture (the sending facility pronounced; the cosign attests); the HTTP death route still demands the certifier. The applier's tx2 opens the 7-day `external_discharge_notice` window (idempotent against an already-open one) and its catalog-valid events. Route 40 (`POST /discharges/:id/cosign-for-cause`, `discharge.cosign_for_cause` + `discharge.is_medical_director`, guards unchanged) gained an external branch: a `completed` + `hl7_external` + un-cosigned row is attested (facts set, notice window closed, `m6.discharge.cosigned` published); a second cosign / stale version / other tenant / non-external completed row is refused. The for-cause cosign now also stamps the facts. Catalog, additive: `m6.discharge.cosigned` gains optional `sourceProposalId` + `medicalDirectorMembershipId`; `m6.discharge.death.deathCertifierId` becomes optional (absent for external deaths). M6's `DeathDischargeReader` returns real `source`/`cosignStatus`/`sourceProposalId`/`cosignedAt`/`medicalDirectorMembershipId`. M16: `externalSourceMetadataFor` uses the real proposal id (the fabricated `sourceProposalId = admissionId` could never have matched a later cosign) and refuses an external row with none; new `buildM16DischargeCosignedConsumer` (`outbox-consumers/m6-discharge-cosigned.ts`, wired in `apps/backend/src/index.ts`) runs `decideCosignReceipt` + the plan machine's state-preserving `receiveCosign` under `withOrgContext` with the plan row `FOR UPDATE`; no source proposal (for-cause) = no-op; cosign-before-plan = no-op and the later intake reads the cosigned fact off the seam; a redelivery never restamps. **Consumers of the old behavior.** The M6 events (`m6.admission.discharged`, `m6.discharge.death`, `m6.bereavement.eligible`) now fire for an external death for the first time, at the same moment a normal death fires them, so M5's patient-deceased cascade, M13/M21 discharge cascades, M16 intake and M31's bereavement grace see an external death like an internal one — none wait for the cosign (correct per spec). Changes that DO follow: (a) M16 plans for external deaths are created gated (`cosignStatus` pending) and first contact unlocks on the cosign (D18); (b) M30's HVLDL external-source subset and its pending-cosign Risk-Register flag can now fire (`cosignStatus` was always undefined); (c) **M37**: `m6.discharge.death` without a pronouncing physician still moves the `ipu_admission` to `deceased` but no longer auto-opens `ipu_body_release` (its `pronouncing_physician_id` is NOT NULL and cannot be fabricated) — an IPU patient whose death arrives by external notice gets no auto body-release row until staff open one; (d) `m6.discharge.created` (W-M6-31 lists it) is still NOT published by the applier (captured, not re-emitted — unchanged pre-existing behavior), so M22/M23/M13's `discharge.created` reactions do not fire for external deaths — reported, not built; (e) a tx1-committed/tx2-failed applier run is not retried (the narrative marker makes the redelivery an idempotent skip) — pre-existing, more visible now that the window + events live in tx2. **Compliance points to confirm:** who may cosign (today any user holding the `medical_director` role via `discharge.is_medical_director`; the spec has no anti-self-cosign rule, so the accepting reviewer can also cosign), the 7-day attestation window (overdue raises `m6.compliance.window.overdue`; a late cosign is still accepted), and that an external death's pronouncing physician stays unrecorded. **Proof:** `m6-m16-external-death-cosign.live.test.ts` (new, script + ci.yml row) on `wardenx_app` with the real publisher and dispatcher: applier completes + stamps + opens the window, the M16 plan carries the real proposal id, cosign -> facts/window/enriched event -> one gate release, redelivery no-op, cosign-before-plan ordering, second/stale/other-tenant cosign refused, internal death and R-DC-01 untouched, for-cause cosign unchanged and M16 no-ops it, cross-tenant isolation. Mutations (after a WIP commit, each reverted): dropping `sourceProposalId` from the cosign payload; restoring the fabricated proposal id; removing the already-cosigned guard + `isNull` where; removing M16's no-source-proposal no-op; dropping the applier's `externalSource` — each failed the expected tests.
