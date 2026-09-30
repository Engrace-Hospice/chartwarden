# #248 outbox deferred-consumer triage (catalog corrections)

> Per-group, per-event checks of `outbox-deferred-consumers.ts`: F-115, F-117, F-129–F-149 (decide who really consumes each event; seam-pull vs push). Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

**#248's two biggest `no-consumer-surface` groups were both misclassified, in opposite directions
(F-115).** `outbox-deferred-consumers.ts` held 509 declared-but-unbound pairs; M30 (93) and M28 (52) were
its two largest groups, both carrying a one-line "this module is a producer/gateway, not a subscriber; no
consumer directory exists" reason — the exact shape that already correctly described M33's 319 and M36's
269 pairs before those were moved wholesale to `seamConsumers`. Checked per event rather than assumed,
because F-099/F-101/F-108 each found a blanket reason wrong for a handful of members: **M28's reason was
right, completely** — the FHIR gateway resolves every seam it reads (M5/M6/M7/M8/M11/M12/M13) fresh at
REQUEST time (§164.528 D3, F-035) and holds no cached or derived state any push event would ever need to
invalidate, so all 52 declaredConsumers entries naming it were simply wrong; they are gone, with no
`seamConsumers` replacement, because there is no seam relationship either. **M30's reason was false on its
face**: `packages/quality/src/consumers/` is a real, unit-tested §4.10 consumer directory
(`handlers.ts`/`subscription-map.ts`, RULE 3(d) — pure + a topic map, no boot-wired binding, the same
shape M23/M25/M26/M27 already carry), and `outbox-subscription-exceptions.ts` had already recorded two of
its six subscribed topics as `handler-unbound` because the catalog didn't declare M30 on them. The other
four subscribed topics (`m10.hope.submission_accepted`, `m12.medication.error_reported`,
`m18.evv.visit_verified`, `m23.claim.adjudicated`) *were* declared and sat in this "no consumer directory"
group anyway — reclassified `handlers-unbound`, the mirror case. Of the remaining 89, 27 are the facts
M30's own nightly recompute already reads via seam for a currently-registered measure
(`AdmissionOnsetReader`/`DischargeReader`/`LevelOfCarePeriodReader` for M6, `CarePlanCycleCountsView` for
M7, `SignedEncountersReader` for M8, the live M10 HOPE rollup, `VerbalTimelinessCountsView` for M11,
PRN/missed-dose counts for M13, `IdgScheduleProvider` for M14, supervisory counts for M15,
`copOutreachCounts` for M16, `VisitMetricsProvider` for M17, `QualityCostReportConsumer` for M27) —
verified against the actual Drizzle query each seam runs, not inferred from module proximity, which is
what caught two plausible-looking false positives before they landed: `m16.bereavement.plan_closed_*`/
`plan_skipped_per_patient_opt_out` (M30's `copOutreachCounts` sums outreach-touchpoint status, not plan
closure reasons — a `planClosureCounts` method exists on the same seam interface and is simply unused by
any of the eleven measures `m30-jobs.ts` currently registers, "bound is not computing" a third time) and
`m13.administration.recorded`/`refused`/`corrected`/`voided` (the missed-dose/PRN measures scan
`scheduled_dose` and PRN-specific rows, not the general administration stream). Those 27 moved to
`seamConsumers` on their own `events-by-mNN.ts` entries and out of `declaredConsumers`. One more was a
different defect: `m30.infection.event_recorded` declared itself a "self-subscriber," but
`recordInfectionEvent` runs the §7.8 outbreak-window scan INLINE in the same transaction — nothing has
ever consumed that event via the outbox, so the declaration was dead and is now record-only. Net: 509 →
429 declared-but-unbound pairs; the honest remainder is 61 M30 facts with no current seam (M9/M20/M21/
M23-noe-notr/M25/M26/M37/M39, three M6 facts outside the four M6 readers' documented scope, and
`m8.hearthnote.layer2_enhanced`) plus everything else #248 hasn't triaged yet. Proven by the full
non-live suite (three tests pinned the old declaredConsumers/seamConsumers arrays and now pin the
corrected ones) and `arch:outbox-bindings`, which is the only gate that can see this class of drift at
all.

**#248's own quoted rationale for the m22 group was a per-MODULE claim about a per-EVENT fact, and it
was checked, not assumed (F-117).** The register said "for M11/M12/M13/M21/M23/M33 the request half IS
wired, so the source declaration is redundant" — true of exactly 4 of the roughly twenty events those
six modules contribute to the group, and false of the rest, which are separate order/claim/billing
lifecycle transitions on the same modules with no such sibling. Confirmed redundant by tracing the
actual emit sites to a `*.document_requested` co-emission in the SAME transaction: `m11.order.signed` /
`.standing_spawned` (`orders-route-service-db.ts`), `m12.medication_order.signed`
(`dosespot-route-service-db.ts`'s `emitDocumentRequest` helper), `m13.reconciliation.completed`
(`emar-route-service-db.ts`) — all four dropped from `declaredConsumers`, no `seamConsumers` added,
because the artifact is delivered by the other event and there is no seam relationship to record. Two
more were dropped for a DIFFERENT reason — not redundant, simply nothing to render:
`m37.body_release.completed`, whose own prior transition (`releaseBody`) REFUSES unless the M22
`body_release_authorization` document already exists, so completion produces no new artifact; and
`m27.cost_report.reopened`, which resets the report to `draft` with no job enqueued and nothing
requested. `m27.cost_report.submitted` follows the F-108 precedent directly — it enqueues the
`ecr-generation` job rather than requesting a render itself, and that job's own (already-bound)
`m27.artifact.render_requested` is the real handshake. `m37.body_release.funeral_home_identified` is the
ordinary case: `identifyFuneralHome` co-emits `m37.body_release.document_requested` in the same
transition. **Net: 8 of 66 m22 pairs resolved (429 → 421).** The other 58 divide three ways, verified
against the M22 spec's own §4.11 consumer table (`WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md`) rather than
assumed: events the spec explicitly names for a dedicated per-source consumer that was never built —
`packages/22-documents` has no `consumers/` directory at all, only the generic `outbox-consumers/`
document-request mirror, so EVERY spec-named dedicated consumer (`m11-order-results-received.ts`,
`m8-encounter-document-requested.ts`, `m5-patient-merged.ts`, and the rest) is unbuilt, not merely
unbound — these stay declared as real, spec-endorsed gaps (`m11.order.results_received`,
`m12.medication_order.{list_changed,draft_created_from_extraction}`, `m14.{packet.render_requested,
minutes.signed}`, `m15.plan.version_signed`, `m18.evv.aggregator_accepted`, `m5.patient.{merged,
draft_created_from_extraction}`, `m8.encounter.{signed,addendum_signed}`, `m39.consent.revoked`); events
named by no part of the spec with no redundant sibling, kept declared rather than dropped absent
stronger evidence (the F-101 sweep this needs has not been run on them); and one confirmed STALE
cross-reference worth its own line: `m9.assessment.summary_requested` is real, catalogued, request-
shaped, and already declares m22, while `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS`' own comment calls the
same need `m9.assessment.document_requested` and asserts it is "declared by no catalog under any
spelling" — false, under this one, the F-100 `m37.body_release.document_requested` shape a second time,
where a wrong note in an anticipated-events list is what hid an already-bindable event. **A tooling
defect surfaced running `--update` on a module with two deferred-consumer groups** (M30, split by F-115
into `handlers-unbound` and `no-consumer-surface`), and is now fixed rather than merely reported.
`regenerate()`'s anchor lookup was `out.indexOf('module: "m30",')` with no search-from offset, so BOTH
groups' iterations resolved to the SAME first occurrence — the second iteration overwrote what the first
just wrote with its own (by then already-deleted) leftover, silently emptying one group's `events` array
while the other kept whatever was there. Caught immediately by the gate itself (4 pairs it could no
longer find in any registered deferral) and fixed by hand in that run rather than by re-running
`--update`, which would have repeated it identically. `regenerate()` now anchors on `module` + `kind`
TOGETHER, which is exact even when a module has several groups, and — the deeper half of the bug — never
lets one group's `--update` pass adopt an event a SIBLING group might actually own: a multi-group
module's existing groups only ever lose an event that resolved (no longer unbound), never gain one they
did not already list, and a genuinely new unbound pair for that module surfaces as its own fresh
`unclassified` stub rather than being guessed into whichever sibling group happened to run first.
Verified by running `--update` against the now-correct register: a no-op (byte-identical output), which
is the actual regression test — the exact case that used to corrupt M30's `handlers-unbound` group now
round-trips clean. Proven by `bun run scripts/check-outbox-bindings.ts` (0 disagreements post-fix), the
full non-live suite (one test pinned `m11.order.signed`'s exact consumer array and now asserts m22's
absence explicitly), and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
disposable Postgres — `assertBindableAgainstCatalog` is the real boot-time proof that every dropped
declaration and untouched
gap still agrees with what is actually bound.

  **The m14 group (51 pairs) was checked per-event against M14's OWN spec rather than trusted from six
  producing modules' `declaredConsumers`, and it disagreed at scale (F-129, #248).** Continuing #248's
  triage past the m22/m21/m14-D8 passes, the next-largest group was M14's remaining "M6 inclusion cache +
  M9/M10/M11/M12 'since last IDG' cache + M22 back-ref" bucket. F-101's own rule — the CONSUMING module's
  own spec table decides who consumes it, not the producing module's guess — applied at 8x the scale of
  its first use: M14's §4.5 table (mirrored exactly by `consumers/index.ts`'s `M14_OUTBOX_SUBSCRIPTIONS`,
  14 events) and `packages/idg/src/packet/builder.ts`'s typed build-input structs are the authoritative
  statement of what M14 actually reads, and 22 of the 51 declared pairs named neither. **All 22 were
  redundant with a documented build-time SEAM PULL, not merely unsupported by prose**: M7's 9 problem/
  goal/intervention/care-plan-version events and M39's 2 DPOA events are covered by `CarePlanSummaryInput`/
  `PacketCoverInput` reading M7's `CarePlanReader` and M5/M6/M7/M39 fresh per packet ("already projected to
  the packet cover shape" — never a push cache); M10's `timepoint_scheduled`/`timepoint_signed` are the
  same shape for `HopeContextInput`/`HopeTimepointProvider`; M6's `cti.drafted`/`.late_flagged`/`.voided`
  and `f2f.scheduled`/`.window_missed`/`.window_overridden` are the same shape for `PacketCoverInput`'s
  `nextRecertDueAt`/`f2fWindowState` (M6 owns CTI/F2F enforcement outright — M14 only ever reads it,
  per its own §1.1 dependency line); `m6.discharge.created` is redundant with `m6.admission.discharged`,
  M14's own real D9 inclusion-cache subscription on the SAME discharge transaction, carrying every fact
  D9's effect needs (`admissionId`/`dischargeDate`) while `discharge.created`'s richer fields serve M22/
  M23/M26 instead. Dropped `m14` from each event's `declaredConsumers` at the source
  (`events-by-m6.ts`/`events-by-m7.ts`/`events-by-m10.ts`/`events-by-m39.ts`), never here. **The reverse
  defect turned up in the same pass**: `m11.order.discontinued` is named by M14's own §4.5 table and
  `M14_OUTBOX_SUBSCRIPTIONS` for the projection cache, and M11's catalog had simply never declared `m14` —
  a real, spec-endorsed subscription that `assertBindableAgainstCatalog` would have refused the moment
  anyone tried to bind it live. Added at the source (`events-by-m11.ts`); the matching stale
  `outbox-subscription-exceptions.ts` entry (which had correctly diagnosed this as "NOT one of the D8
  auto-close sources… stays here with the rest of the unbuilt Valkey cache") is now redundant with the
  corrected catalog declaration and is deleted, per the gate's own message ("now both subscribed and
  declared — the exception has outlived its reason"). **The remaining 29 pairs split into two honest
  groups, not one**: the real, still-unbuilt "since last IDG"/inclusion-cache shape M14's own spec names
  (8 events — the two M6 inclusion-cache events, M9's `recorded`/`significant_change`, M10's
  `j2051_trigger_fired`/`sfv_created`, M11's `order.discontinued`, M12's `medication_order.discontinued`);
  and 22 events checked and found neither clearly redundant nor named anywhere in M14's spec (M6 admission
  on_hold/resumed + compliance-window open/overdue, M9's `assessment.amended`, M12's
  `medication_history_pulled`, all 12 of M13's eMAR events, all 3 of M15's discipline-care-plan events,
  M39's `consent.expiring_soon`) — kept declared rather than dropped absent stronger evidence, the F-101
  caution applied in the direction that avoids a false drop. Of those 22, `m13.scheduled_dose.missed` has
  the strongest surviving case to bind next: M14's own §1 packet description names "missed doses" as a
  `flaggedEvents` category and the payload (`missedDoseId`, `dueAt`, controlled/comfort-kit flags) maps
  directly onto `PacketFlaggedEventDigest`'s `missed_dose` kind, unlike the other 11 M13 events, the 3 M15
  events or M39's `expiring_soon`, none of which correlate to any documented packet field.
  **Net: 509 → 419 (prior passes) → 398** (22 dropped, 1 added, net −21). Verified: `bun run build` clean,
  `bun run typecheck` (the same 3 pre-existing, unrelated `m2-*.live.test.ts` TS2698 errors, confirmed via
  `git stash` predating this change), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), full
  non-live suite 654 files / 9589 tests green, the four touched live suites
  (`m11-downstream-signed-fanout`, `m21-order-cascade`, `m6-cop-document-renders`, `m6-discharge-cascade`)
  passing individually against a fresh disposable Postgres, and a clean `check:boot:platform` run
  (the real `assertBindableAgainstCatalog` boot-time proof) against the same freshly migrated, RLS-enforced
  database. Leaving #248 open — 398 pairs across 32 modules remain.

  **The m27 group (23 pairs) was already scoped by its own prior-pass reason as needing exactly this
  per-event check, and it confirmed the reason was right about 21 of 23 and wrong about the last 2
  (F-130, #248).** M27's own §1.1 relationship inventory + manifest-patch `dependsOn` list
  (`[1,2,3,4,6,8,12,13,22,23,26,36,38,40]`) names every seam it actually reads BY METHOD — M6's
  `LevelOfCarePeriodReader`/`AdmissionCensusReader`, M8's `EncounterStatisticsProvider`, M23's
  `PatientDaysProvider`/`ClaimSettlementProvider` (forward-seam deny-stub), M26's
  `CapAccrualReader`/`CapPeriodReader` (forward-seam deny-stub) — and 21/24/37 are conspicuously absent
  from it. **21 of 23 pairs dropped**: all 5 M6 events (`admission.activated`/`.discharged`,
  `election.period_started`/`.period_ended`, `loc.changed` — the last IS the exact table
  `LevelOfCarePeriodReader` pulls), all 3 `m23.claim.*` events, all 6 `m26.cap.*` events — each
  redundant with a seam PULL M27's own spec names by method, triggered on-demand by the `statistics-
  refresh`/`Refresh Inputs` job, never a push subscription; all 3 `m24.medicaid_claim.*` events (M24
  is never named anywhere in M27's spec — Medicaid's billed-day contribution reaches M27 entirely
  through M23's `PatientDaysProvider`, which M27's own text says covers "by program (Medicare /
  Medicaid / other)"); all 3 `m37.*` events (M37 is named only in the OPPOSITE direction — M37 consumes
  M27's `CostReportProvider.getInpatientCapPositionAtFiscalDate`, and GIP/IPU level of care is already
  covered via M6's LOC-period pull regardless of physical site); and `m8.mileage.captured` (M27's spec
  never mentions mileage anywhere, and no worksheet or allocation-basis field in `packages/cost-report`
  reads it — the event's own "payroll/AP" phrasing is Gusto-side, pulled by M27's separate
  `wage-data-pull` job). Dropped at the source in each producing module's `events-by-mNN.ts`. **The
  remaining 2 are the opposite finding — a genuine, real, still-open forward seam, not a
  misdeclaration**: M21's own LOCKED spec (§1.1, D16 — "Does M21 own vendor invoice reconciliation?")
  explicitly commits M21 to emitting `m21.supply_request.invoice_accrued`/`.invoice_reconciled` for an
  M27-side accrual/GL-reconciliation consumer, citing "the M11 D6 / M13 D5 forward-seam precedent until
  M27 locks" — a real, cross-referenced decision on the PRODUCING side that M27's own spec simply never
  corroborates or builds a consumer for. Unlike M24/M37 (unsupported guesses with no decision behind
  them), this asymmetry is backed by an explicit committed decision, so it's kept declared as the
  honest open cross-module question it is rather than dropped on the strength of M27's silence alone —
  the F-101 caution against dropping without evidence, applied in the direction that avoids a false
  drop a second time in the same pass. **One incidental fix found while re-verifying the group stayed
  fully covered after the drop**: `m26.cap.settlement_proposed` had ONLY `declaredConsumers: ["m27"]`
  and no `seamConsumers` at all — dropping `m27` would have orphaned it entirely (0 consumers, caught
  by `m26-unit.test.ts`'s catalog-hygiene assertion). `cap_settlement` is one row per `cap_period`
  (proposed → finalized are two states of the SAME row), and its sibling `settlement_finalized` already
  declares `seamConsumers: ["m33"]` against it — added the same to `settlement_proposed`, the missing
  half of an existing pattern rather than a new one. **Net: 398 → 377** (21 dropped, 0 added). Verified:
  `bun run build` clean, `bun run typecheck` (same 3 pre-existing unrelated `m2-*.live.test.ts` errors),
  `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), full non-live suite 654 files / 9589
  tests green, and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable
  Postgres. Leaving #248 open — 377 pairs across 32 modules remain.

  **The m26 group (22 pairs) checked the same way, against M26's own §4.4 consumer surface rather than
  the six producing modules' guesses, and it went 15/22 misdeclared — the opposite ratio from m27
  (F-131, #248).** `consumers/subscription-map.ts`'s `M26_SUBSCRIPTION_MAP` (the F-094/F-101 precedent:
  a consuming module's own constant is the authority) plus the module spec's exhaustive §3.1 file tree —
  which names exactly seven consumer files and no others — settled every event. **15 of 22 dropped.** All
  6 `m6.*` events (`admission.activated`/`.discharged`, `discharge.created`, `election.period_started`/
  `.period_ended`, `loc.changed`) are redundant with the documented `ElectionPeriodReader` PULL M26's own
  "Depends on" text names for benefit-period-anchored cap math — and `loc.changed` doubly so, since M26's
  own D13 names the INPATIENT (20%-rule) day source as M23 claim lines by revenue code (0655/0656), never
  M6 level-of-care periods, the identical "physical-site-independent" finding F-130 made for M27 one
  module over. `m23.claim.paid` is redundant with `m25.remittance.advice_posted`: M26's own text states
  "M25 is the authoritative paid-amount source — every cent traces to an 835-derived remittance line", so
  the claim-paid milestone itself carries no fact the subscription-map keys on (already correctly
  declared on `advice_posted` alone). `m23.claim.acknowledged` has no support anywhere in M26's consumer
  surface — an acknowledgment carries no paid amount, reversal, or inpatient-day fact. All 4
  `m24.medicaid_claim.*` events have no support of any kind: M26's own spec states outright "Medicaid
  payments are excluded from the Medicare aggregate cap (ADR-0017 D4)" and "M26's scope is strictly
  Medicare per 42 CFR §418.308" — a stronger, first-party exclusion than the m27 pass's M24 finding, which
  only lacked support rather than being expressly ruled out. All 3 `m37.*` events (`census.snapshot_taken`,
  `ipu_admission.discharged`/`.transferred`) have no support either — M37 is named nowhere in M26's
  "Depends on"/"Consumed by" text, the same unsupported-guess shape as m27's M37 cluster. All 15 dropped
  at the source in each producing module's `events-by-mNN.ts`. **7 of 22 kept, and they split two ways.**
  5 are the real, confirmed §4.4 subscriptions `M26_SUBSCRIPTION_MAP` names by action —
  `m23.claim.line_finalized` (`record-inpatient-day-line`), `.replaced`/`.voided`
  (`record-reversal-line`), `m25.remittance.advice_posted` (`record-accrual-line`),
  `m6.revocation.created`/`.transfer.created` (freeze / proportional-weight-init) — genuinely deferred
  behind the Drizzle `CapConsumerStore` bind (itself deferred behind the M5 MBI + M6 first-election
  readers), not misdeclared. The 7th, `m25.remittance.claim_recouped`, is the opposite finding from every
  drop above: M25's own locked §4.5 state-transition table names M26 outright — "`remittance_line`
  reversed (CLP02 = 22) | Emit `m25.remittance.claim_recouped` (M23 consumer + **M26 cap-reversal
  subscriber**)" — but `M26_SUBSCRIPTION_MAP` never built the consumer. Kept declared as the honest gap
  this is, rather than dropped on the strength of M26's silence alone — the F-101 caution applied in the
  keep-not-drop direction a second time in this same pass (5 dropped absent support, 1 kept despite
  absent support because the PRODUCING side's evidence here is a locked-spec transition-table entry, not
  a description gloss). **Checking it surfaced a genuine, pre-existing, unrelated defect, reported rather
  than fixed**: `handleClaimReversed` (`consumers/handlers.ts` — the already-built `record-reversal-line`
  handler backing the two confirmed `m23.claim.replaced`/`.voided` subscriptions) reads
  `p.patientId`/`p.claimId`/`p.priorPaidAmountCents` off the delivered payload, and NEITHER catalogued
  payload carries any of those fields (`{originalClaimId, replacementClaimId|voidClaimId, reason}` — no
  patient, no amount). Every real delivery would silently resolve `recorded: false` forever — invisible
  because no test exercises this action with a catalog-shaped payload, and the whole `CapConsumerStore`
  is unbound regardless so it has never run in anger. Wiring `claim_recouped` through the same handler
  would inherit the identical defect, since its payload carries no `patientId` either. Fixing it needs
  either richer M23/M24/M25 payloads or a by-claim accrual-line lookup `CapConsumerStore` does not
  expose — new design, not a catalog fix, left unbuilt. **Net: 377 → 362** (15 dropped, 0 added).
  Verified: `bun run build` clean, `bun run typecheck` (same 3 pre-existing unrelated
  `m2-*.live.test.ts` errors), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), full
  non-live suite 654 files / 9589 tests green (one catalog-array assertion in
  `admission-outbox-jobs.test.ts` updated to match), and a clean `check:boot:platform` run against a
  freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 362 pairs across 32 modules
  remain.

  **The m34 group (21 pairs) went 21 of 21 misdeclared — every single one — the M28/F-115 shape a
  second time (F-132, #248).** M34's own spec is unusually exhaustive about the boundary: its "Depends
  on"/"Consumed by" header enumerates exactly `1,2,3,4,22,36` and `1,2,3,4,22,23,24,29,33,35`, its §3.1
  file tree lists exactly ONE consumer file (`consumers/m22-document-backref.ts`), and — the single most
  decisive line — its own D15 text COUNTS its M35 consumption: "the four seams M34 publishes plus **the
  ONE** M34 consumes from M35 (deny-stub today)," naming that one thing as
  `TenantSubscriptionEntitlementReader`. A quantified "ONE" is a much stronger contradiction than mere
  silence, and it directly refutes the 9 `m35.*` events (8 `subscription.*` + `tenant.billing_blocked`)
  that M35's OWN spec repeatedly (and specifically) describes as "M34 (when locked) consumes the event to
  gate feature access" — the producing side's aspirational guess, overridden by the consuming side's own
  more authoritative accounting, per F-101. **All 5 `m27.cost_report.*` events are the familiar
  push-declared/pull-actual shape**: M27's own §1.1 text names M34's real mechanism as a SEAM PULL —
  `CostReportFilingStatusReader.getOpenReportsForProvider`/`.getMostRecentSubmissionFor`, consulted
  on-demand at the tenant-offboarding gate and the compliance-posture dashboard summary, explicitly listed
  among M27's forward-seam-deny-stubs (never an outbox subscription). **Both M30 events are the identical
  shape**: M30's own §4.6 seam registry names `SecurityRiskAssessmentReader`'s only consumer as `['m34']`
  and `ComplianceStatusProvider`'s consumers as `['m28','m33','m34']`, consulted "at fiscal-year rollover"
  — a pull, not the `cop.status_changed`/`sra.cycle_closed` push these two events declared. **The
  `m23.mac_credential.updated`/`m24.medicaid_trading_partner.updated` pair looked like the strongest
  candidate for a genuine kept gap** — both producing modules describe it identically as "M34 (wizard
  completion signal)," and `mac_configured` IS one of M34's eleven canonical onboarding steps — but M34's
  own onboarding-step text settles it the other way: `ccn_registered → mac_configured`'s actual precondition
  is a seam pull (M29's `ExternalFeedReader`, with "Phase 1 uses platform-ops attestation," no automated
  credential check at all yet) evaluated on-demand by `precondition_dsl` at advance-attempt time, and the
  `tenant.onboarding_advance` worker's only documented trigger is M34's OWN self-emitted
  `m34.onboarding.task_completed` event — never a cross-module credential-upsert event. Dropped. **All 3
  `m20.safety.*` events had no support of any kind** — M20's own spec never names M34 anywhere, and M34's
  own text states plainly it "consumes no clinical predicates... M34's surface is platform-administrative
  not patient-clinical," the sharpest disclaimer in the corpus against exactly this cluster. All 21 dropped
  at the source in each producing module's `events-by-mNN.ts` (M20 ×3, M23 ×1, M24 ×1, M27 ×5, M30 ×2, M35
  ×9); the m34 group itself is now DELETED from `outbox-deferred-consumers.ts` rather than left empty,
  since a zero-event group is a group whose deferral has fully "outlived its reason." **Net: 362 → 341**
  (21 dropped, 0 added; 32 → 31 consumer modules). Verified: `bun run build` clean, `bun run typecheck`
  (same 3 pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness` 38/38 (`arch:outbox-bindings`
  0 disagreements), full non-live suite 654 files / 9589 tests green with no pinned-array assertions to
  update this pass, and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
  disposable Postgres. Leaving #248 open — 341 pairs across 31 modules remain.

  **The m17 group (14 pairs) went the opposite way from m34 — 12 of 14 were genuine, real, still-unbuilt
  subscriptions, and only 2 were misdeclared (F-133, #248).** `consumers/index.ts`'s own header already
  named the gap this pass confirmed at scale: M17's `M17_OUTBOX_SUBSCRIPTIONS` carries only 5 events
  (`m8.encounter.signed`, the 3 `m6.admission.*` lifecycle events, `m7.care_plan.version_signed`) despite
  the spec (D3/D14) naming EVV as the AUTHORITATIVE driver of the `published → en_route → in_visit →
  completed` visit lifecycle — the EVV-authoritative bracketing this module's own "done means" example
  walks through has never been wired. All 5 `m18.evv.*` events are explicit, decisive real subscriptions:
  M18's own catalog comments say outright "drive M17's visit-state transitions (D14)"
  (`check_in_recorded`/`check_out_recorded`), "the geofence-confirmation stream M17 Scheduling reads"
  (`at_patient_address`), "M8/M17 re-read the bracket" (`event_corrected`), and "flows to M17/M8/M23"
  (`late_check_resolved`). `m15.volunteer.assignment_inactivated` is M15's own catalog comment ("so M17
  must drop the volunteer from the schedule") feeding the `m17.reassignment_needed` day-view cascade M17's
  own D3 names — no reassignment-scan mechanism exists in M17 at all yet, for PTO, credential, or
  volunteer-gate reasons alike (the PTO half is "in-service" per a route comment; the other two have no
  cron or consumer anywhere). `m20.safety.high_risk_area_entered` and `.visit_cancellation_requested` are
  both explicit in M20's own "Consumed by 17" prose and §4.10 outbox table ("M17 also consumes... to
  surface a visit-row warning badge during scheduling"; "(M17 consumer cancels the visit)"). Both
  `m39.consent.delegated_access.granted`/`.revoked` are explicit in M39's own §4.10/§4.7 tables ("M17
  (portal-upcoming scope check)") — M17's `PortalVisitReader`/`ConsentEvaluator` caregiver-scope gate.
  `m8.encounter.orphan_recorded` is explicit in M17's own D2 decision row and §12 checklist ("consumer
  present in M17 (deny-stub until M8 publisher exists)"). **One, `m19.triage_call.visit_needed`, is kept
  on asymmetric evidence rather than dropped on M17's silence** — M17's own spec (locked first) never
  mentions the inbound direction, but M19's spec extensively and repeatedly documents it (§1, §2.2,
  acceptance criteria at §7.1/§7.9 with p95 performance targets) as the trigger for M17's D5
  proposal-worker path — the same "kept, not dropped" caution F-131 applied to `m25.remittance
  .claim_recouped`: a specific, cross-referenced, done-means-tested producing-side decision outweighs the
  consuming spec's mere silence. **2 of 14 were genuinely misdeclared and dropped at the source**:
  `m20.safety.check_in_recorded` — M20's own description says "info severity, no fan-out," and M20's own
  "Consumed by 17" text describes M17's day-view "last check-in" fact as a `SafetyDashboardProvider
  .clinicianStatusForLocation` seam PULL, never this push event (unlike the two kept M20 events, this
  row's §4.10 table entry also carries no "(M17 consumer...)" annotation); `m5.patient.address_changed` —
  M17's own spec (§7.10) states outright "M17 NEVER geocodes; geocoding requests are M5's geocode job
  which runs on `patient.address_changed` outbox" — M17 only ever reads the geocoded result afterward via
  the `PatientAddressReader` seam pull, and M5's own `jobs/index.ts` confirms the real (if still unbound)
  consumer is M5's own `m5.geocode_address` job, not M17. **Net: 341 → 339** (2 dropped, 0 added — the
  smallest net change of any group checked so far, and the first pass in this series where the group's
  original blanket reason turned out mostly right rather than mostly wrong). Verified: `bun run build`
  clean, `bun run typecheck` (same 3 pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness`
  38/38 (`arch:outbox-bindings` 0 disagreements), full non-live suite 654 files / 9589 tests green with no
  pinned-array assertions to update this pass, and a clean `check:boot:platform` run against a freshly
  migrated, RLS-enforced disposable Postgres. Leaving #248 open — 339 pairs across 31 modules remain.

  **The m16 group (12 pairs) mostly confirmed the prior pass's own reason rather than overturning it —
  6 of 12 were real, still-blocked subscriptions and 6 were misdeclarations, all six variants of the
  same defect: a claim that some OTHER event "seeds the bereavement plan" (F-134, #248).** Checked
  per-event against M16's own §4.5 "Outbox Subscriptions (Consumers in M16)" table and
  `lifecycle/cascades.ts`'s three pure deciders, rather than trusting five producing modules'
  `declaredConsumers` guesses. **6 of 12 kept**: `m39.consent.revoked` (§2.6 opt-out cascade, backed by
  a real pure decider) and `m39.consent.signed` (§4.5's "post-death-grant handler", under the spec's
  stale name `consent.created` — M39's own catalog description says outright "the M16 post-mortem grant
  when bereavement"); `m5.patient.bereavement_opt_out_changed` (§4.5 + D9, backed by
  `decidePatientOptOutFlip`); `m6.admission.discharged` (filtered to `reason='death'`) — explicitly named
  in §4.5 as a deliberate "secondary verifier (redundant safety net)", not an oversight; `m6.discharge
  .cosigned` — the D18 gate-release decider, blocked producer-side (already documented by the prior
  pass's reason, unchanged here); `m37.ipu_admission.death_recorded` — named three times in M37's own
  spec as "M16 (bereavement onboarding)", kept on that asymmetric evidence despite M16's own spec being
  silent on M37 (the F-131 "kept, not dropped" caution). **6 of 12 dropped, all the same shape**:
  `m15.plan.discharged` and `m7.care_plan.discharged` each carried a producing-module description
  claiming to "seed the bereavement plan" — flatly false, since F-105 already established
  `m6.bereavement.eligible` is the ONLY creation path, and neither event is in M16's §4.5 table;
  `m6.admission.activated` — an ACTIVATION carries no fact a program that starts at DEATH needs, and was
  only ever part of that event's broad 15-consumer fan-out; `m6.discharge.death` — co-emitted from the
  SAME `runEffects` transition as `bereavement.eligible` (one `t.effects` map, one transition), and
  `bereavement.eligible`'s own description says it IS "the post-rule check on `m6.discharge.death`" —
  M16's real consumer reads only the derived event; `m5.patient.deceased` — a THIRD hop downstream of
  the same transaction (M5's own §7.8 death cascade reacting to `discharge.death`), carrying no fact
  M16's intake decider reads; `m39.consent.renewed` — unlike `.signed`/`.revoked`, no spec text or
  decider names a renewal-triggered action, reading as a mechanical carry-over from the sibling
  consent-lifecycle events' consumer lists. All 6 dropped at the source (M5, M6 ×2, M7, M15, M39), and
  `M16_SUBSCRIBED_EVENT_NAMES` (`packages/types/src/bereavement.ts`) — the F-095 rule-6 mirror of the
  catalog, checked both ways — updated to match, which the gate itself caught (`arch:outbox-bindings`
  failed with 6 fresh "does not declare 'm16'" disagreements until the list was corrected in the same
  change). **Net: 339 → 333** (6 dropped, 0 added). Verified: `bun run build` clean, `bun run typecheck`
  (same 3 pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements after the subscription-list fix), full non-live suite 654
  files / 9589 tests green (two pinned-array assertions updated — `admission-outbox-jobs.test.ts`'s
  activation fan-out and `outbox-seam-consumers.test.ts`'s seam-split case, both to drop `m16`), and a
  clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving
  #248 open — 333 pairs across 31 modules remain.

  **The m25 group (11 pairs) went 9 of 11 misdeclared — the opposite ratio from m16, and the reason was
  the group's own claim taken at face value instead of checked (F-135, #248).** The group's original
  reason read "M25 binds one live consumer; the rest sit on its `consumers/` subscription-map surface,
  forward-declared and inert" — true of the mechanism, false about WHICH events sit on that surface.
  M25's own §4.4 spec text (the `boot.ts` subscribe-list pseudocode) and its real, frozen
  `consumers/subscription-map.ts` both name exactly THREE inbound topics: `m23.claim.rejected` (the
  277CA-derived pre-835 denial-worklist seed, D2/D3), `m18.evv.aggregator_rejected` (the EVV-aggregator
  denial seed, M18 §4.10), and `m22.document.rendered` (the appeal-packet/resolution-letter back-ref,
  already bound). **2 of 11 kept**: `m23.claim.rejected` and `m18.evv.aggregator_rejected` — both have
  written, unit-tested handlers (`handleClaimRejected`, `handleEvvAggregatorRejected`) sitting on that
  same subscription map, genuinely deferred pending the live relay bind, the same posture as M26/M27.
  **9 of 11 dropped, none of them present in M25's own subscribe list under any spelling**:
  `m23.claim.acknowledged`/`.acknowledgment_partial`/`.submitted` and all five
  `m24.medicaid_claim.{submitted,acknowledged,acknowledgment_partial,rejected,denied}` events carry no
  CARC/denial fact for M25 to act on — only a REJECTION (277CA or its EVV-aggregator sibling) seeds a
  worklist row before an 835 lands, and M25's own D9 states it pulls the Medicaid 835 itself over M24's
  per-state channel rather than subscribing to any M24 claim-lifecycle event at all. Two of the nine are
  a sharper defect than "unsupported": `m23.claim.denied` and `m24.medicaid_claim.denied` are each M25's
  OWN OUTPUT read backwards — both events' own descriptions say the DENIED transition only fires after
  "M25 posted a denial 835", so M25 is the PRODUCER of the fact behind each event, not a consumer of it.
  All 9 dropped at the source in each producing module's `events-by-mNN.ts` (M23 ×4, M24 ×5) — every one
  already carried a `seamConsumers` entry (`m33`/`m36`), so none were orphaned by the drop. Net:
  **333 → 324** (9 dropped, 0 added). Verified: `bun run build` clean, `bun run typecheck` (same 3
  pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness` 38/38 (`arch:outbox-bindings` 0
  disagreements), full non-live suite 654 files / 9589 tests green with no pinned-array assertions to
  update this pass, and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
  disposable Postgres. Leaving #248 open — 324 pairs across 31 modules remain.

  **The m23 group (20 pairs) went 12 of 20 misdeclared across seven producing modules, checked against
  M23's own §4.4 subscription surface rather than trusted (F-136, #248).** M23's own spec text (the full
  M6 outbox catalog, quoted by NAME in the dependsOn prose) and its real, frozen
  `consumers/subscription-map.ts` (seven live topics + two M25/M26 deny-stubs) are the authoritative
  statement of what M23 actually subscribes to. **8 of 20 kept** — genuine, real, still-unbound
  subscriptions: the six already on the map (`m6.cti.signed`, `m6.f2f.attested`, `m6.loc.changed`,
  `m8.encounter.cosigned`, `m5.patient.deceased`, `m18.evv.late_check_resolved`), plus two the map has
  not caught up to — `m6.election.period_ended` (the spec's own text names it beside the already-mapped
  `period_started` as "claim-period anchoring") and `m25.taxonomy.unmapped_code_observed`, kept on M25's
  own D13 text naming a specific, decided mechanism despite M23's spec being silent on it — the F-131
  "kept, not dropped" caution a third time. **12 of 20 dropped, spanning M5/M6/M11/M23(self)/M25/M37**:
  `m11.order.level_of_care_change_signed`/`.recertification_signed` are each redundant with M6's own
  resulting `loc.changed`/`cti.signed` (already bound) — the order-signed event is one hop upstream of
  the fact M23 actually reads, the F-120 co-emission shape applied a module over; `m23.claim.draft_created`
  is M23 consuming its OWN event, directly contradicted by the spec's own state-transition table ("M33,
  M22 — no render yet"); `m25.denial.resolved_favorable_via_appeal` is redundant with the already-bound
  `m25.remittance.claim_paid` — M23's own claim state machine says the PAID transition is driven by the
  835 RE-POST, not the appeal decision, which carries no payment fact of its own; all four `m37.*` events
  (`census.snapshot_taken`, `ipu_admission.bed_assigned`/`.discharged`/`.transferred`) have no support in
  M23's spec at all — the only M37↔M23 relationship runs the OPPOSITE direction (M37 reads M23's
  `ClaimReader`) — and `bed_assigned`'s specific claim that "M23 writes the place-of-service Q-code" is
  directly contradicted by F-127's already-established finding that `placeOfService` is genuinely unbound
  platform-wide, no site-type table exists anywhere; `m5.patient.payer_changed` is a seam-pull
  redundancy — M23's own spec states patient-payer status is CONSULTED fresh at every claim assembly,
  never pushed, so there is nothing for a push event to invalidate; `m6.admission.activated` and
  `m6.admission.discharged` were each part of that event's broad clinical fan-out with no billing-specific
  rationale (the F-134 shape already found for m16 on these SAME two events) and each is redundant with a
  narrower, already-bound sibling (`m6.discharge.created` carries the discharge_event id
  `admission.discharged` does not); `m6.nor.acknowledged` (Notice of Rights) is never mentioned anywhere
  in M23's spec — M22 remains its one real consumer. All 12 dropped at the source (M5 ×1, M6 ×3, M11 ×2,
  M23 ×1 self, M25 ×1, M37 ×4); every touched entry already carried other real consumers or a
  `seamConsumers` fallback except `m37.ipu_admission.transferred`, which had ONLY `["m23"]` and is now
  legitimately record-only, matching several sibling M37 events already in that state. **Also fixed in
  this pass, at the user's request**: the three pre-existing, unrelated `m2-*.live.test.ts` TS2698
  errors (`Spread types may only be created from object types`) that every prior pass in this series had
  carried forward as "same 3 pre-existing errors" — both files typed their outbox-publisher adapter's
  closure params as `(tx: never, input: never)` to force an assignment through an `as never` cast, then
  tried to spread the `never`-typed `input`, which TypeScript correctly refuses. Fixed by typing the
  adapter against the real port interface (`OrganizationLifecycleOutboxPort` /
  `Parameters<typeof createOrgScopedIdentityOutbox>[1]`) instead of casting past it — `bun run typecheck`
  is now fully clean, zero errors, for the first time in this series. Net on #248: **324 → 312**
  (12 dropped, 0 added). Verified: `bun run build`
  clean, `bun run typecheck` clean (0 errors — the 3 pre-existing fixed), full non-live suite 654 files /
  9589 tests green (two pinned-array assertions updated — `admission-outbox-jobs.test.ts`'s activation
  fan-out and `outbox-seam-consumers.test.ts`'s seam-split case, both to drop `m23`), `arch:fitness`
  38/38 (`arch:outbox-bindings` 0 disagreements), the two newly-typechecked `m2-*.live.test.ts` files run
  individually against a live disposable Postgres (9/9 passing, unchanged behavior), and a clean
  `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248
  open — 312 pairs across 31 modules remain.

  **The m11 group (10 pairs) went the opposite way from m23 — 9 of 10 were genuine, real, still-unbound
  subscriptions, and only 1 was misdeclared (F-137, #248).** Checked against M11's own spec's
  authoritative "Outbox events consumed" list, and — where M11's own text was silent — against the
  PRODUCING module's spec for a specific, decided, cross-referenced claim (the F-131/F-133 "kept, not
  dropped" caution, applied a fifth time). **9 of 10 kept**: `m9.assessment.significant_change` is on
  M11's own live subscription list (`consumers/index.ts`'s `M11_OUTBOX_SUBSCRIPTIONS`) with a written,
  unit-tested decider (`consumers/assessment-trigger.ts`) — deferred only because nothing binds it to the
  dispatcher yet, same as the already-registered `m10.hope.j2051_trigger_fired` gap one line above it.
  The three `m21.supply_request.*` events (`cancel_no_op`/`cancelled`/`status_changed`) are each
  individually named by M21's own catalog description as a real M11 relationship ("M11 auto-completes a
  one-shot order…", "M11 releases the source order", "Emitted so M11 learns the cascade ARRIVED… M11
  would hold the order open forever") and `status_changed` additionally matches M11's own spec text (§4.5,
  the "auto-complete one-shots" cron) — M11 carries no consumer file yet (`m21-fulfillment-status.ts`,
  named in the spec's own file tree, was never built). The two `m39.consent.dpoa.*` events are named for
  M11 twice over in M39's own spec — its outbox table ("M11 (attribution refresh)") and its
  `dpoa_healthcare` revocation-cascade table ("M11 (acting-consent revalidation on active orders)") — plus
  a checklist item stating outright "Event `m39.consent.dpoa.agent_appointed` → M7/M11/M14 backref
  consumers stubbed." The three `m7.intervention.*` events are named by M7's own mutation-consumer table
  ("M14, M11 (if linked)"), and M7's schema carries a `linked_order_id` column precisely for this handoff
  — M7's architecture note states the PULL direction runs the other way (M11 reads M7 when authoring a
  care-plan-driven order) but the same table still names M11 as a push consumer for the linked-order case,
  a genuinely different relationship from the pull. **1 of 10 dropped**: `m6.admission.activated` had no
  support anywhere — M11's own consumed-events list never names it, and no file, decider, or even a
  comment in `11-orders/` mentions admission activation at all — the same broad-fan-out-no-rationale shape
  F-134/F-136 already found for m16/m23 on this identical event. Dropped at the source
  (`events-by-m6.ts`). Net on #248: **312 → 311** (1 dropped, 0 added). Verified: `bun run build` clean,
  `bun run typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests green (two pinned-array
  assertions updated — `admission-outbox-jobs.test.ts` and `outbox-seam-consumers.test.ts`, both to drop
  `m11` from `m6.admission.activated`'s clinical fan-out), `arch:fitness` 38/38 (`arch:outbox-bindings` 0
  disagreements), and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
  disposable Postgres. Leaving #248 open — 311 pairs across 31 modules remain.

  **The m5 group (10 pairs) confirmed the same "mostly real" pattern as m11 — 9 of 10 kept, 1 dropped
  (F-138, #248).** Checked against M5's own spec text and, where M5 was silent, against the producing
  module's spec for a specific, decided, cross-referenced claim. **9 of 10 kept**: all six
  `m39.consent.*` events (`expired`/`recipient_removed`/`renewed`/`revoked`/`signed`/`supersedes`) are
  named individually, by event, in M39's own outbox table (each row lists M5 among the consumers) and
  repeated in M39's D-M5-interaction prose — the `patient.privacy_flag_snapshot` recompute is a real
  mechanism with no consumer file built yet. `m17.visit.assigned`/`.unassigned` are named by M17's own
  catalog description and confirmed by M5's own §4.1 `CaseloadProvider` seam source comment, which
  describes the mechanism at code level: "Module 17 publishes `shift.visit_assigned` to a per-clinician
  Valkey set TTLed to the shift window" — a decided, still-unbuilt cache. `m6.admission.activated` is
  named by M5's own §3.3 tenancy-columns note (M05-F04/ARCH-011): `patient.provider_entity_id`/
  `location_id` are "populated (and denormalized onto every patient-scoped child table) when the
  admission activates" — confirmed no write path anywhere in the repository sets either column, so the
  consumer is genuinely unbuilt rather than misdeclared. **1 of 10 dropped**: `m24.medicaid_eligibility
  .checked` ran the relationship in the OPPOSITE direction — M5's own spec states its
  `patient.address_changed` triggers M24 to re-check eligibility (M24 reads M5, a seam pull at
  claim-assembly time per M24's own text), and no part of M5's spec names M24 or "medicaid_eligibility"
  as something M5 consumes. Dropped at the source (`events-by-m24.ts`); the event keeps its
  `seamConsumers: ["m33"]` so nothing is orphaned. Net on #248: **311 → 310** (1 dropped, 0 added).
  Verified: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files /
  9589 tests green with no pinned-array assertions to update this pass, `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements), and a clean `check:boot:platform` run against a freshly
  migrated, RLS-enforced disposable Postgres. Leaving #248 open — 310 pairs across 31 modules remain.

  **The m31 group (11 pairs) went 6 kept / 5 dropped on the forward check, and — uniquely among every
  group checked so far — the SAME per-event check surfaced 6 real declarations missing from the catalog
  entirely, because M31's own hand-maintained `M31_SUBSCRIBED_EVENT_NAMES` mirror
  (`packages/types/src/portal.ts`) had already flagged them as "subscribed and not routed here"
  (F-139, #248).** Checked against M31's own authoritative §4.10 "M31 consumes" table (13 named source
  events, each with a real consumer-file name) and, for the drops, against the same spec's §4.4
  "Depends on" text naming a seam PULL instead. **6 of 11 original pairs kept**: `m16.bereavement
  .contact_active` (M16's OWN outbox table names M31 explicitly — the F-131 "kept, not dropped"
  caution), `m17.visit.cancelled`/`.rescheduled` (telehealth-scoped, named consumer files that force-end
  or re-mint the vendor room), `m39.consent.delegated_access.granted`/`.revoked` (the real, decided D10
  mechanism for `family_caregiver_access` grant creation/cascade-revoke), and `m8.encounter.signed`
  (telehealth-attached, flips `telehealth_visit.lifecycle_state='reconciled'`). **5 of 11 dropped**: all
  three M12 events and `m13.administration.recorded` are each redundant with a documented seam pull M31's
  own §4.4 text names by method (`MedicationOrderProvider.getPortalMedicationSummary`,
  `MedicationAdministrationProvider.getPortalAdministrationSummary`) — M31's §4.10 table names no M12 or
  M13 event at all; `m17.caregiver_reminder_due` is disclaimed outright by M31's own text ("M22's domain
  … exposed in M31's preference UI"). All dropped at the source in each producing module's
  `events-by-mNN.ts`. **Checking the full §4.10 table surfaced the reverse defect too (F-102/F-106/F-129
  shape, at unusual scale): 6 events M31's own table names with a real consumer file had NO m31
  declaration anywhere in the catalog** — `m17.visit.published` (room-mint enqueue), `m6.admission
  .discharged` (both `reason` branches — bereaved transition / 30-day grace timer), `m22.document
  .rendered` (patient-facing kinds), `m16.bereavement.plan_opened`/`.plan_closed_completed` (plan-level
  bereaved-scope flip / grant revocation, distinct from the per-contact `contact_active` fact kept
  above), and `m39.consent.revoked` (the BROAD any-consent-type cascade — genuinely wider than
  `delegated_access.revoked`'s family-caregiver-only scope, so not redundant with it). All six now
  declared at the source. `buildOutboxRoutingPlan`'s own header line — "available bindings are live even
  when another declared module is not yet wired" — is what makes this safe: adding m31 to
  `m17.visit.published`/`m22.document.rendered` does not interrupt their existing live delivery to
  m8/m18/m20 or to M22's five other consumers, it only keeps those rows `pending` instead of `dispatched`
  until M31 also binds, confirmed by reading `outbox-dispatcher.ts`'s claim loop directly (bound
  consumers' handlers run BEFORE the `deferred` check, not gated by it). **Two of M31's own
  `M31_SUBSCRIBED_EVENT_NAMES` entries were checked and deliberately NOT added, on the producing module's
  more decisive say-so — the opposite of F-101's usual direction, and worth naming as its own pattern**:
  `m39.consent.created` — M39's own outbox table states its consumers as "(none — drafts are internal)",
  a first-party disclaimer stronger than M31's aspirational spec text, since a draft "carries no
  regulatory force" and gating a portal grant on one would be premature; and `m4.legal_hold.applied`/
  `.released` — M4's own module spec (§M04-F03) commits this fact to a registered `HoldApplier` SEAM per
  data-owning module (the same pattern as `DataEraser`), never an outbox subscription, and
  `events-by-m4.ts`'s own header says declaring a consumer here "would be a namespace lie." Both stay
  exactly as `outbox-subscription-exceptions.ts` already filed them; M31 registering a `HoldApplier` is
  real, unbuilt work, but it is not an outbox-catalog fix. `M31_SUBSCRIBED_EVENT_NAMES` itself was
  corrected to match — the 5 dropped names removed outright, the 6 added names moved from "not routed
  here" into the declaring bucket. Net on #248: **310 → 311** (5 dropped, 6 added — count unchanged
  because the reverse-direction discoveries offset the forward-direction drops almost exactly). Verified:
  `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests
  green (two pinned-array assertions updated — `clinical-consumer-contracts.test.ts`'s M17
  visit-publication test now asserts `m31` deferred alongside m8/m18/m20's still-live delivery, and
  `document-backref-consumers.test.ts`'s declared-consumers pin), `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions), and a clean `check:boot:platform` run against
  a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 311 pairs across 31 modules
  remain.

  **Four groups checked in parallel by four independent research subagents (m19, m13, m24, m8 — all
  tied at 8 pairs), with the coordinator applying, cross-verifying and committing every finding centrally
  to avoid four agents racing to edit the same shared registry files (F-140, #248).** Each agent
  investigated one module against its own authoritative spec/subscription surface, exactly per this
  series' established method; every non-trivial claim (self-consumption verdicts, reverse-direction
  additions, seam-vs-push distinctions) was independently re-verified against the actual code before
  being applied. **m19 (On-Call Triage) — 1 kept, 7 dropped.** `m17.visit.assigned` is decisive and
  specific in M19's own locked spec (a named job, `m19.shift-sync.debounced`, and consumer file,
  `m17-roster-changed.consumer.ts`) despite M17's own stale "Phase 2" gloss on the event. The other 7 are
  each a seam pull M19's own spec describes at the point of use — PTO/reassignment eligibility via an M17
  reader, portal-caregiver consent via `ConsentEvaluator.isActive`, and (the reverse-direction trap
  avoided) M20's own LOCKED D14 decision that its after-hours recipient set PULLS M19's `OnCallProvider`
  seam "without M19 needing to know about safety alerts" — never a push to M19. **m8 (Encounters) — 0
  kept, all 8 dropped.** M8's own spec is unusually decisive: "Outbox publication is the only
  cross-module communication M8 performs AT THE BOUNDARY" — every upstream fact (the M18 EVV bracket, M6
  admission state, M7's care-plan overdue gate) is an in-process SEAM call, confirmed at the code level in
  `seams/index.ts`'s own comments ("M8 also CONSUMES M7's §7.8 CarePlanReader... a boot-validated seam,
  NOT a schema import"). The group is fully resolved and deleted from the registry outright (31 → 30
  modules), the F-132 precedent. **m13 (eMAR) — 7 kept, 1 dropped, plus 4 reverse additions.** M13's own
  live `M13_OUTBOX_SUBSCRIPTIONS` list (11 entries, each a real decider under `decideReconciliationTrigger`)
  settled most of it directly; `m21.comfort_kit.replenished`/`.return_reconciliation` are kept despite not
  yet being on that list, on M21's own decisive catalog text ("M13 tops the existing deployment up" /
  "M13 closes its drawdowns", the payload even carrying `m13DeploymentId`) — the F-131 caution.
  `m37.iv_safety_overlay.required` is dropped: both M37's and M13's own text agree this is a SEAM PULL
  (`IpuIvSafetyOverlayProvider.getOverlayForOrder`), and M13's subscription list names no M37 event at
  all — moved to `seamConsumers`. The reverse check found 4 real gaps already on M13's own subscription
  list with a named decider each — `m6.admission.activated`, `m6.discharge.created`,
  `m6.admission.discharged`, `m6.cti.signed` — all four also correctly pre-diagnosed by a stale
  `outbox-subscription-exceptions.ts` entry, now deleted since the catalog agrees. **m24
  (Billing-Medicaid) — 1 kept, 7 dropped, plus 5 reverse additions.** M24's own authoritative
  `M24_SUBSCRIPTION_MAP` (8 topics, each a real handler in `consumers/handlers.ts`) settled it: kept
  `m5.patient.address_changed`; dropped the three `m18.evv.aggregator_*` events (M24's own D9 decision
  explicitly REJECTS "M24 owns its own EVV gate without consuming M18's seam" as a boundary violation —
  the real mechanism is `EvvComplianceReader.bracketStateForVisit`, a seam pull), both self-declared
  `m24.medicaid_claim.submission_failed`/`.medicaid_eligibility.refresh_requested` (no handler exists for
  the first; the second is never emitted anywhere), `m5.patient.payer_changed` (redundant with a seam,
  the identical F-136 shape one module over), and `m8.encounter.cosigned` (absent from the subscription
  map, which names only `.signed`). The reverse check found 5 real gaps on the subscription map with a
  named handler each — `m23.claim.acknowledged` (`resolve-medicare-primary`, the COB precondition for
  billing Medicaid secondary once Medicare pays primary), `m5.patient.updated`, `m8.encounter.signed`
  (both `trigger-revalidate`), and `m25.remittance.claim_paid`/`.claim_denied` (`mark-claim-paid`/
  `mark-claim-denied`). The M25 pair's own stale exception entry assumed declaring `m24` would interrupt
  M23's live delivery to those two events — the same mistaken belief F-139/m31 already corrected
  (`buildOutboxRoutingPlan` delivers to every bound consumer regardless of what else is declared); deleted
  along with the entry for the other three. **Net on #248: 311 → 297** (23 dropped, 9 added, one group
  fully resolved — 31 → 30 modules). Verified centrally, once, after all four groups' edits landed
  together: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files /
  9589 tests green (four pinned-array assertions updated — `admission-outbox-jobs.test.ts`,
  `care-plan-outbox-jobs.test.ts`, `encounter-outbox.test.ts`, `outbox-seam-consumers.test.ts`, all to
  drop `m8` and/or `m24` from their respective fan-out lists), `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions — this pass's own `M19_SUBSCRIBED_EVENT_NAMES`
  mirror needed the same correction the m31 pass made to `M31_SUBSCRIBED_EVENT_NAMES`), and a clean
  `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248
  open — 297 pairs across 30 modules remain.

  **A second round of four groups checked in parallel (m18, m21, m29, m1), continuing the F-140
  pattern — research-only forks, coordinator applies and verifies centrally (F-141, #248).** **m18
  (EVV) — 1 kept, 5 dropped, plus 1 reverse addition.** M18's own locked D14 is exhaustive about what
  it consumes ("M18 consumes `m17.visit.published` ... and `m17.visit.cancelled`") — only
  `m17.visit.cancelled` survives; `.completed`/`.rescheduled`/`.started` and both
  `m39.consent.delegated_access.*` events have no support in D14 or D16's dependsOn list (which never
  names M39). `m17.visit.late_check_out_suspected` was the sharpest case: M17's own spec glosses it as
  "consumed by M18," directly contradicted by M18's own D14/D6/job-catalog, which describe the
  identical late-checkout-detection mechanism as M18's OWN `late-check-sweep` cron (a listed M18
  BullMQ worker) — the F-101 rule (trust the consumer over the producer's guess) resolves the
  disagreement, and the event is now record-only. The reverse check found a real, decisive, previously
  undeclared subscription: `m8.encounter.signed`, named by M18's own D6, its job catalog
  (`m18.encounter-signed.consumer`, "on m8.encounter.signed outbox"), and its "Done means" walkthrough
  as the auto-close path for a `closed_documented_at_encounter` missing-checkout resolution — added.
  Writing that addition surfaced an independent, unfixed payload gap, reported rather than fixed: the
  locked `m8.encounter.signed` payload does not carry `evvMissingReason` (the field exists on the
  encounter route/schema, just not on this outbox contract), so M18's real consumer cannot yet read the
  fact it needs from this event. **m21 (Supplies/DME/Comfort Kits) — 7 kept, 0 dropped, 0 added.**
  Checked against M21's own authoritative `M21_SUBSCRIBED_EVENT_NAMES` mirror and spec text — every
  pair confirmed genuine: `m11.order.signed` and the four `m13.comfort_kit.*` events are directly on
  the subscription list with complete named deciders; `m11.order.supply_fulfillment_requested` is
  genuinely blocked (no platform seam answers "which Location serves this patient," the same finding
  F-102 recorded); `m12.medication_order.dispensed_at_pharmacy` is fully decisive in M21's own spec
  text though not yet on the subscription list — the F-131 "kept, not dropped" shape. **m29 (External
  Interfaces) — 1 kept, 6 dropped, plus 1 reverse addition.** M29's own locked "four-pillar scope" (D1:
  HL7 inbound/outbound, NPPES, Xero/Gusto) has no room for five of the six drops: `m20.safety.
  osha_reportable_incident_filed`/`workers_comp_claim_initiated` (M20's own text hedges the filing as
  "manual or M29's," an aspiration never decided in M29's scope), `m35.invoice.paid`/`refund.executed`
  (the real M29↔M35 relationship runs the OPPOSITE direction — a seam pull via
  `ExternalInterfaceMetricsProvider`, not a push), and `m5.patient.archived` (its own description
  claimed "M29 expires related HL7 inbound proposals" with zero corroboration anywhere in M29's spec,
  which names exactly one proposal-expiry mechanism — the 72h SLA timer). `m11.order.signed` is the
  sixth drop, redundant with the specific, decisive `m11.order.hl7_orm_requested` sibling — which is
  the one KEPT pair, named explicitly in M29's own spec ("M29 consumes the `m11.order.hl7_orm_requested`
  outbox event as a typed listener ... M29 wires the live consumer at lock"). The reverse check found a
  real, decisive, previously undeclared subscription: `m5.patient.deceased`, named explicitly in M29's
  own M5-dependency prose ("consumed via outbox to freeze inbound ADT processing for the decedent and
  to refuse any post-death A01/A04 events") — added. `m5.patient.merged` was checked and correctly NOT
  added: M29's own text describes that relationship as a seam pull ("resolved at every lookup"), never
  a push. **m1 (Foundation) — 6 kept, 0 dropped, 0 added.** All six are circuit-breaker/health-monitor
  signals from three independent producing modules (M23/M24/M33), and all three use the identical
  decisive phrasing — "M1 records/clears the degraded `system_status`" — naming a real, already-built
  mechanism (`system_status` table + `SystemStatusReader.upsert`, already live behind the admin route)
  that only lacks its automatic-consumer wiring. `m12.dosespot_degraded`/`.recovered` was checked as
  the obvious sibling candidate and correctly excluded: M12's own spec routes DoseSpot degradation
  through a per-tenant feature flag, not the platform-global `system_status` table (`system_status` is
  `NON_ORG_SCOPED`; DoseSpot connectivity is per-tenant, D5) — a principled scoping difference, not an
  oversight. **Net: 297 → 287** (16 dropped, 2 added; module count unchanged at 30, since all four
  groups still carry at least one entry). Verified centrally, once, after all four groups' edits
  landed together: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654
  files / 9589 tests green (two pinned-array assertions updated — `encounter-outbox.test.ts` to add
  `m18`, `orders-outbox-consumers.test.ts` to drop `m29`), `arch:fitness` 38/38 (`arch:outbox-bindings`
  0 disagreements both directions — no mirror-constant drift found this round), and a clean
  `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248
  open — 287 pairs across 30 modules remain.

  **A third round of four groups (m7, m35, m2, m32), and the cross-checking caught two genuine
  misdeclarations hiding IN the reverse-direction check itself, not just in the forward pairs
  (F-142, #248).** **m7 (Care Plan) — 0 kept, 5 dropped, all 5 resolved rather than orphaned.** Two of
  the five (`m39.consent.dpoa.agent_appointed`/`.agent_removed`) and two more
  (`m9.assessment.recorded`/`.significant_change`) are documented build-time SEAM PULLS per M7's own
  locked D7 (a single ABAC seam to M39 for DPOA attribution) and its own "Clinical assessments" text
  (the registered `LatestAssessmentProvider` seam for M9 scores) — dropped with no m7 replacement. The
  fifth, `m19.triage_call.care_plan_change_indicated`, was a genuine **misdeclaration**, not merely
  unsupported: M19's own §11 D8-cascade text is decisive — "M19 emits
  `m19.triage_call.care_plan_change_indicated` consumed by **M14's IDG packet builder**" — the real
  consumer was always M14, never M7. Corrected at the source (`events-by-m19.ts`, m7→m14) and the pair
  now lives in the m14 group rather than vanishing — the m7 group is fully resolved and deleted
  (the m8/m34/m32 precedent), not left empty. **m32 (AI Platform) — 0 kept, 3 dropped, all 3
  resolved.** `m16.bereavement.risk_score_computed` and `m8.hearthnote.layer2_enhanced` are the
  identical shape from the opposite direction: M32's own spec states each relationship runs the
  OPPOSITE way — M16 and M8 each call INTO M32's registered seam
  (`BereavementRiskNarrativeProvider.augment`/`NarrativeEnhancementProvider.enhance`) SYNCHRONOUSLY,
  and M32 already returns everything the corresponding event's payload carries during that call, so
  consuming its own announcement afterward would be redundant — dropped. The third,
  `m19.triage.summary_requested`, was the round's sharpest catch: `events-by-m19.ts`'s own inline
  comment claimed it was "reserved for an M32 AI call-summary request" — flatly contradicted, three
  separate ways, by this SAME module's own locked spec (the "Consumed by" table: "M19 emits
  `m19.triage.summary_requested` and **M22 renders the PDF**; M19 has no PDF code"; the §4.10 outbox
  table: "(M22 consumer)"; the Lock-status section: "M22 caregiver-summary consumer subscribes... at
  M22 lock") and by `packages/types/src/oncall.ts`'s own payload doc comment ("→ **M22** renders the
  caregiver/attending summary document"). A code comment asserting a relationship its own module's
  locked spec names differently, three times, is a documentation bug, not a design decision — corrected
  at the source (m32→m22) and the pair now lives in the m22 group, genuinely unbuilt on both sides.
  **m2 (Identity) — 1 kept, 2 dropped.** `m18.evv.device_approved`/`.device_suspended` were dropped: M18's
  own spec (§2.2.3) states the two rows — `evv_device` and M2's `device_attestation` — are
  INDEPENDENT, with M18 reading M2's row via a logical FK (a seam/FK pull), never the reverse.
  `m39.consent.revoked` is kept, decisively — M39's own locked D7 names "M2 portal-session terminate"
  explicitly, its per-type cascade table names M2 for both consent types, and a "Done means" walkthrough
  spells out the exact mechanism ("M2 consumer subscribes; iterates active sessions... terminates each
  session immediately") — the F-131 "kept, not dropped" asymmetry, since M2's own spec is silent only
  because M39 authored the cascade after M2's spec was written. **m35 (Subscription Billing) — the
  group's own reason was itself a seam-vs-push trap.** All 5 originally-declared events
  (`m32.capability.invoked`, `m32.tenant_opt_in.{recorded,revoked}`,
  `m34.tenant.{provisioned,offboarding_initiated}`) were dropped: M35's own D21 (locked) is exhaustive —
  "8 inbound subscriptions" — and names none of them; D24 states both relationships are SEAMS, not
  pushes (M32 calls `UsageMeteringIngest.ingest` directly INTO M35's own published seam; M35 consumes
  M34's `OnboardingStatusProvider` as a forward-seam deny-stub). The reverse check found the real gap —
  D21's exhaustive 8-event list (`m2.organization.{activated,suspended,closed}`, `m2.session.created`,
  `m5.patient.{created,status_changed,deceased,merged}`) had already been diagnosed, event-by-event, by
  `scripts/outbox-subscription-exceptions.ts`'s own rule-6 "no-handler" buckets — catalog agreement was
  the only thing missing. Six were corrected at the source (M2's four events, M5's `deceased`/`merged`)
  and the matching stale exception entries deleted; the other two
  (`m5.patient.{created,status_changed}`) stay untouched — M35's own D21 marks them
  `record-only-target`, a first-party M5 refusal ("would make M5's patient lifecycle a billing input, a
  coupling M5 has not agreed to") that this pass respects rather than overrides.
  `M35_SUBSCRIBED_EVENT_NAMES` (`packages/types/src/subscription-billing.ts`) rewritten to match — the
  5 wrong names removed, the list now exactly D21's 8. **Net: 287 → 280** (10 dropped, 8 added — 2
  reassigned across modules, not new gaps; module count 30 → 28, m7 and m32 fully resolved). Verified:
  `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files / 9589
  tests green with no pinned-array assertions to update this pass, `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions), and a clean `check:boot:platform` run
  against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 280 pairs across 28
  modules remain.

  **A fourth round of six small groups (m6, m37, m9, m12, m10, m3) — every group with zero prior
  citation, checked in parallel by six forks — resolved three groups outright and caught the sharpest
  reverse-direction miss of the series so far on a fourth (F-143, #248).** **m6 — 4 kept, 2 dropped.**
  `m11.order.level_of_care_change_signed`/`.recertification_signed` are decisive on M11's side (its
  locked D9/D10, each with a rejected-alternatives table: "M11 emits ...; M6 subscribes and runs its LCP
  transition" / "...validates F2F + CTI then transitions the next period") despite M6's own spec being
  comparatively silent — the F-131 "kept, not dropped" asymmetry. `m23.noe.accepted`/`m23.notr.accepted`
  are equally decisive on M23's side: its own "Done means" walkthroughs state plainly "M6's consumer
  picks up the event and closes the M6 NOE compliance window" — a genuinely NEW fact (MAC acceptance)
  M6's own F-106/F-107 emissions (which trigger the filing, not its acceptance) cannot derive.
  `m19.triage_call.gip_admission_proposed` was dropped as a straightforward misdeclaration: M19's own
  locked spec names M37, never M6, as the real consumer (cited three separate ways), and `m37` already
  correctly carries this pair in its own group. `m37.ipu_admission.bed_assigned` is the seam-vs-push trap
  from the opposite side: M6's real `confirmLocBedAssignment` route verifies the bed via a SEAM READ
  (`ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod`), never an outbox consumer. **m37 —
  2 kept, 1 dropped.** `m19.triage_call.gip_admission_proposed` and `m6.admission.discharged` are both
  named explicitly, with designated (unbuilt) consumer files, in M37's own §4.5 "Outbox Subscriptions"
  table. `m6.admission.activated` is not in that table at all — checking surfaced a genuine spec-vs-
  catalog naming mismatch worth flagging for a future pass rather than fixing here: M37's spec instead
  names two more granular events (`m6.level_of_care.requires_ipu_bed`/`.activated`) that M6's real
  catalog has never published, so M37's actual intended trigger is very likely M6's real
  `m6.loc.changed` — untouched by this pass. **m9 — 0 kept, all 3 dropped, group fully resolved and
  deleted** (the m8/m34/m7/m32/m10/m3 precedent): `m13.prn_administration_recorded` has no support
  anywhere in M9's relationship inventory; `m8.encounter.signed` and `m8.vitals.captured` both run the
  OPPOSITE direction from a push — M9's own spec states M8 calls INTO M9's `recordAssessment` API
  synchronously, and separately that M9 "may read the encounter vital series via M8's seam ... but does
  not own vital signs," moved to `seamConsumers` rather than dropped bare. **m10 — 0 kept, its one pair
  dropped, group deleted.** `m8.encounter.signed` is the identical shape one module over: M10's own spec,
  including a re-lock note explicitly correcting a prior encoding that "inverted the M8↔M10 dep
  direction," states M8 calls M10's `recordHopeTimepoint` API synchronously — M10's two real outbox
  consumers are both M6-only. **m3 — 0 kept, its one pair dropped, group deleted.**
  `m39.consent.supersedes` resolves through M3's own boot-registered `ConsentEvaluator` seam PULL,
  consulted fresh per ABAC evaluation; M3 has no `consumers/` directory and no consent-keyed cache to
  rebind (its one cache invalidates only on role/permission changes) — the event's own "cache rebind"
  phrasing reads as a mechanical carry-over from the sibling `consent.signed` consumer list rather than
  an independent M3 decision. **m12 — both catalogued pairs kept, and the reverse check found the
  sharpest miss of the series: 7 real, decisive, currently-undeclared subscriptions, one of which had
  survived FIVE prior targeted sweeps of the exact same event.** `m13.reconciliation.draft_order_requested`/
  `.discontinue_requested` are decisive on M13's own side (a separate reconciliation surface from M12's
  own D10 MedHx flow, confirmed to have no M13 involvement anywhere). Checking M12's own live
  `M12_OUTBOX_SUBSCRIPTIONS` list against the catalog — rather than trusting the group's stale
  three-live-consumers reason, which was itself off by one — found `m5.patient.created`/`.updated`/
  `.address_changed`/`.payer_changed` (D4's DoseSpot patient sync), `m6.cti.signed` (D10's MedHx pull),
  and `m11.order.verbal_expired_unsigned` (the group's own already-registered `M12_OUTBOX_SUBSCRIPTIONS`
  entry) all missing their `m12` declaration entirely — each backed by a shipped, unit-tested decider.
  `m6.admission.activated` is the one worth naming specifically: it had been individually re-scrutinized
  BY NAME in F-101, F-134, F-136, F-137 and F-140 — five separate passes, each checking it against a
  different candidate module and correctly dropping or keeping that module — and none of them checked it
  against M12, because each pass's fork was anchored to that round's own candidate list rather than to
  the full universe of modules M6 could conceivably feed. A per-event check is only as complete as the
  set of modules it's checked against; this is the first time in the series that a produced-and-declared
  event's OWN group needed the reverse check to have been thorough, not merely present, to catch a real
  gap. Two matching stale `outbox-subscription-exceptions.ts` rule-6 entries (`handler-unbound` and
  `record-only-target`, covering all 7 pairs between them) were deleted once the catalog agreed with
  M12's own subscription list. **Net: 280 → 279** (7 dropped, 7 added — a wash on the pair count that
  hides real movement: three groups fully resolved and three events reassigned to their correct module;
  28 → 25 modules, m9/m10/m3 fully resolved and deleted). Verified: `bun run build` clean, `bun run
  typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests green (two pinned-array
  assertions updated — `encounter-outbox.test.ts` to drop m9/m10 from `m8.encounter.signed`'s expected
  subscriber set, `outbox-seam-consumers.test.ts` to drop m37 and add m12 to `m6.admission.activated`'s
  expected clinical fan-out), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements both
  directions after the two stale exception entries were deleted), and a clean `check:boot:platform` run
  against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 279 pairs across 25
  modules remain.

  **Round 5 stopped checking whole groups and instead finished the F-101 sweep a PRIOR round had
  explicitly left undone inside the single largest one (F-144, #248).** By Round 4 every group in the
  registry carried an F-number — except that m22's own reason text (59 pairs, the largest group) said so
  itself: "events named by NO part of the M22 spec's §4.11 table with no redundant sibling found, kept
  declared rather than dropped absent stronger evidence — the F-101 sweep this needs has not been run on
  them," naming 38 specific events across eleven producing modules. Six forks split that subset by
  producer cluster (M11/M8; M14/M7/M15; M16/M37; M17/M21/M39/M5; M23; M24/M25/M30), each checking M22's
  own §4.11 consumer table plus the producing module's own spec/code — the same F-101 rule at the scale
  F-140's four-fork batch first applied to whole groups, now applied inside one. **28 of 38 were genuinely
  misdeclared, all variants of shapes this series has already named**: redundant-sibling co-emission
  (`m11.order.supply_fulfillment_requested` alongside `.document_requested`; `m14.meeting.adjourned`
  alongside `.minutes.signed`; `m16.bereavement.plan_opened` alongside `.outreach_artifact_requested`;
  `m25.appeal.submitted` alongside the already-live-bound `.appeal_packet.render_requested`; five of six
  M23 billing events and three of four M24 events each redundant with their module's ONE real
  `*.billing.document_render_requested` handshake, confirmed against `consumers/document-render.ts`'s
  four builder functions and their exact payload shapes); the seam-vs-push trap restated as
  "on request" (`m30.incident.submitted`/`.qapi.project_chartered`/`.pip_closed` — M30's own spec names
  five dedicated `*.render_requested` events for this purpose, none ever catalogued or emitted, a
  producer-side gap reported not fixed); a structural impossibility (`m8.encounter.voided` — the
  `ENCOUNTER_GRAPH` legalizes `void` only from `draft`, so a voided encounter can never have had a PDF to
  suppress); the identical F-115/M28 seam-pull shape one module over (`m5.patient.privacy_flag_changed`);
  a live-resolver seam (`m5.patient.unmerged`, M5's own locked D8: merge "re-points all FK references
  through the `patient_resolver`" with no destructive UPDATE, so there is nothing for a push to correct);
  and a Lock-status table naming only a sibling event, not these (`m15.discipline_assessment.amended`/
  `.plan.discharged`, both excluded from M15's own exhaustive "M22 discipline-plan PDF rendering
  subscribes to `m15.plan.version_signed`" claim). **One drop needed its own verification pass to avoid
  reintroducing a defect a PRIOR round had already found and fixed**: the M11 fork flagged
  `m11.order.level_of_care_change_signed`'s own "M22 renders the LOC-change form" spec claim as a
  candidate for keeping (and for adding `m22` to the downstream `m6.loc.changed` it feeds) — checked
  directly against M22's real `PLATFORM_TEMPLATE_TABLE` and confirmed to name no such template anywhere,
  matching a standing F-101 comment already sitting on `m6.loc.changed`'s own catalog entry for the
  identical reason. Trusting the spec text here would have undone a correct prior finding; both stay
  dropped. **`m37.ipu_admission.death_recorded`** was the sharpest catch: M22's own spec never mentions a
  magic-link or external-collaborator surface anywhere (and elsewhere explicitly disclaims a related one
  — "M2 funeral magic-link is NOT how external reviewers authenticate"), and M37's OWN spec is internally
  inconsistent about which event even triggers the session — its "Consumed by" summary and §4.10 table
  both name `death_recorded`, but its detailed body-release workflow narrative says the session is
  created off the LATER `m37.body_release.funeral_home_identified` transition instead, after the funeral
  home is actually known. No consumer file exists on the M22 side under either reading, and the real
  owner of the underlying `magicLink` plugin is M2 (`packages/auth/src/identity/auth.ts`) — dropped, with
  the misattribution reported for its own future pass rather than guessed at. **10 of 38 confirmed
  genuine**, needing no catalog change: `m14.minutes.amended`/`m7.care_plan.version_signed` (each
  decisively named in the PRODUCING module's own outbox table — the F-131 "kept, not dropped" asymmetry
  a second time this round); `m17.caregiver_reminder_due`, `m21.supply_request.delivered`, and all three
  `m39.consent.{expired,recipient_added,recipient_removed}` events (same asymmetry — none appear in
  M22's own table either, all decisively named on the producing side); and the three
  `*.billing.document_render_requested`-shaped events that anchor the M23/M24/M25 redundant-sibling
  drops above, each independently confirmed genuinely unbuilt on the PRODUCER side too (no emit site
  anywhere for any of the three) — a real gap in M22's own document-request-list maintenance, distinct
  from and additional to the catalog-declaration question this sweep answers. **Net: 279 → 251** (28
  dropped, 0 added; module count unchanged at 25 — m22 still carries 31 events, none of this round's
  groups emptied). Verified: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live
  suite 654 files / 9589 tests green with **no pinned-array assertions to update this pass** — the first
  round in the series with zero test fallout — `arch:fitness` 38/38 (`arch:outbox-bindings` 0
  disagreements both directions), and a clean `check:boot:platform` run against a freshly migrated,
  RLS-enforced disposable Postgres. Leaving #248 open — 251 pairs across 25 modules remain.

  **Round 6 applied the exact same finish-the-sweep move to the SECOND-largest group, and it reversed
  the group's own prior "strongest candidate" call (F-145, #248).** m14's own reason text (30 pairs)
  carried the identical shape m22's did before Round 5: "22 pairs checked and found NEITHER clearly
  redundant NOR named anywhere in M14's own spec... kept declared rather than dropped absent stronger
  evidence." Five forks split those 22 by producer cluster and checked each against the PRODUCING
  module's own spec — the same reverse check that resolved m22. **17 of 22 were genuinely misdeclared,
  nearly all one shape at unusual scale: the seam-vs-push trap already named for M7/M9/M10 in F-129, now
  found to cover M6 and all twelve of M13's remaining eMAR events.** M13's own D16 publishes
  `MedicationAdministrationProvider`/`ReconciliationProvider` with M14 named as a read-path consumer for
  BOTH, and M13's own PRIMARY "Consumed by 14" line is exhaustive and decisive — "IDG packets show
  administrations since last IDG via M13's `getAdministrationsSince` seam and missed-dose count since
  last IDG via the SAME seam's aggregation projection" — directly contradicting M13's own looser §4.10
  per-event table, which lists M14 as a consumer on all twelve individual events. The F-101 rule applied
  to a module's own two self-contradicting statements, trusting the decisive one over the loose table
  row. **This reverses the group's own prior framing**: `m13.scheduled_dose.missed` had been called "the
  strongest candidate to eventually bind" on a payload-shape resemblance to `PacketFlaggedEventDigest`'s
  `missed_dose` kind — a weaker signal than M13's own decisive seam-publication text, now correctly
  moved to `seamConsumers` alongside its eleven siblings (all twelve moved, not dropped bare — the seam
  relationship is real, the outbox-push framing was the error). Four M6 events
  (`admission.on_hold`/`.resumed`, `compliance.window.opened`/`.overdue`) had no support in M14's own
  exhaustive build-description at all, and `compliance.window.overdue` was directly contradicted — M6's
  own text assigns the real consumer to M36's escalation chain, an affirmative counter-claim, not mere
  silence. `m9.assessment.amended` is a redundant sibling, emitted in the same transaction as the
  correcting row's `m9.assessment.recorded` — M14's own real, live-bound subscription; the corrected
  value arrives via `.recorded` regardless. **5 of 22 confirmed genuine**, no catalog change needed:
  `m12.medication_history_pulled` and `m39.consent.expiring_soon` (each named twice over in its
  producing module's own outbox table — the F-131 "kept, not dropped" asymmetry a third time this
  series), and all three M15 events (`idg_decision.applied`, `plan.bootstrapped`, `plan.version_signed`)
  — M15's own real outbox table names M14 decisively for all three. `m15.idg_decision.applied` was
  checked specifically for the wrong-direction trap (an echo of M14's own outbound `idg.decision_recorded`
  under a confusing near-identical name) and confirmed genuinely distinct — M15's own inbound
  acknowledgment that it applied an M14 decision, the identical shape M7's own `care_plan
  .idg_decision_applied` audit event already establishes for the M7/M14 pair one module over. **Net:
  251 → 234** (17 dropped — 12 moved to `seamConsumers` rather than dropped bare, 4 dropped clean, 1
  redundant sibling — 0 added; module count unchanged at 25). Verified: `bun run build` clean, `bun run
  typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests green with no pinned-array
  assertions to update — the second consecutive round with zero test fallout — `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions), and a clean `check:boot:platform` run against
  a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 234 pairs across 25 modules
  remain.

  **Round 7 stopped checking whole groups and instead ran down the loose ends already sitting inside
  two groups' own reason text — the "kept absent stronger evidence"/"flagged for a future pass" shape
  survives a group being otherwise fully swept (F-146/F-147, #248).** A registry-wide search for that
  exact phrasing found the pair-level flags Rounds 5/6 fix (F-101 sweeps never run) had already all been
  closed; what remained were two SMALLER loose ends inside groups the series had already resolved.
  **F-146 — M18's real `m8.encounter.signed` consumer was wired against a payload missing the one fact
  it needs.** F-141 added `m8.encounter.signed` to the m18 group as a genuine, decisive, undeclared
  subscription (M18's own D6/job-catalog/checklist all name it as the auto-close trigger for a
  `closed_documented_at_encounter` missing-checkout resolution) but flagged in the same breath that the
  LOCKED payload does not carry `evvMissingReason` — the exact fact `transitionMissingResolution`'s
  `document_at_encounter` event reads as `event.encounterEvvMissingReason`. Checked against the schema
  rather than left flagged: `encounter.evv_missing_reason` is a real, already-written column
  (`documentEvvMissing`, `encounters-route-service-db.ts`), present on the `loadEnc` row already read at
  both `sign()` emit sites, gated by the same ≥20-char CHECK constraint M18's own resolution machine
  enforces. Added to the payload schema (`Type.Optional(Type.Union([Type.String(), Type.Null()]))`,
  matching the column's own nullability — null except when `evvBracketState ===
  'evv_missing_documented'`) and both emit sites. M18's actual consumer BINDING stays unbuilt — that is
  composition-root wiring work outside a catalog/payload pass, unchanged from F-141 — but a future binding
  can now resolve the fact it needs instead of being wired against a field that does not exist, the F-104
  `linked_artifact_id` shape (bind alone would have looked green and matched nothing) avoided before it
  could happen a second time. **F-147 — two IPU loose ends, opposite outcomes.** M37's own group reason
  (F-143) flagged that its dropped `m6.admission.activated` pair pointed at a real spec-vs-catalog naming
  mismatch — M37's spec wants `m6.level_of_care.requires_ipu_bed`/`.activated`, M6 publishes neither — and
  guessed the real trigger was "very likely" M6's actual `m6.loc.changed`, left unaddressed. Checked
  against M6's own production code rather than left a guess: `m6.loc.changed` is NOT it — M6's
  `pending → assigning` transition (the moment a GIP/IRC LOC change needs an IPU bed) emits NO outbox event
  at all (`state-machines/level-of-care.ts`: "No outbox event while assigning — nothing downstream should
  treat an unconfirmed IPU request as a real period of care yet"), `m6.loc.changed` fires only later at
  CONFIRMATION (which M37 already learns about through its own `assign-bed` route, not a subscription,
  the F-143 `m6`-group seam-pull finding a second time), and M6's one published LOC seam
  (`LevelOfCareReader`) deliberately excludes `assigning`-status periods from both its methods. The D2
  bidirectional handshake M37's spec describes was simply never built on the M6 side — no event, no seam,
  nothing a catalog declaration could bind M37 to — so this is real, unbuilt M6-side infrastructure
  (a new outbox event or a seam exposing `assigning`-state periods), reported rather than fixed, since
  inventing a new production event/seam sits outside a catalog-declaration pass. Separately, F-144 had
  flagged M37's own spec as "internally inconsistent" about which event triggers the M22 funeral-home
  magic-link session — its summary table names `m37.ipu_admission.death_recorded`, its detailed workflow
  names the later `m37.body_release.funeral_home_identified` — and reported a "likely misattribution"
  between M2 and M22 as the consumer, left for its own pass rather than guessed at. Run down rather than
  left open: the summary-table row is the ONE imprecise citation against 15+ other places in M37's own
  spec (the D12 rationale, the §2.11 prose, the workflow walkthrough steps 4-7, the test plan, the
  acceptance checklist) that unanimously tie the session to `funeral_home_identified`, never to
  `death_recorded`, and unanimously name M22 — never M2 — as the consumer (architecture §7.8's
  external-collaborator pattern is M22's own surface; M2 owns only the underlying Better Auth `magicLink`
  plugin mechanism, confirmed by reading `packages/auth/src/identity/auth.ts` directly, which anticipates
  an "auditor / external-collaborator / funeral-home magic-link class" but has no M22-side caller
  anywhere). Both code comments corrected to state this decisively; no catalog change on either event,
  since the actual magic-link SESSION creation — distinct from the document RENDER F-117 already
  established is covered by the co-emitted `document_requested` sibling — remains genuinely unbuilt on
  every side (no M22 route, consumer, or external-collaborator surface exists in `22-documents/` at all),
  a real, reportable feature gap one layer deeper than a declaration fix. **Net: 234 → 234** (0 dropped, 0
  added — every fix this round was a payload widening and two prose corrections, not a declaration
  change). Verified: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654
  files / 9589 tests green with no pinned-array assertions to update, `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements, pair count unchanged as expected), a clean `check:boot:platform`
  run against a freshly migrated, RLS-enforced disposable Postgres, and the `m8-encounters-write.live.test.ts`
  (50/50), `m8-encounters-read-service.live.test.ts` (4/4), and `m18-evv-write.live.test.ts` (16/16) live
  suites run individually to confirm the widened `m8.encounter.signed` payload round-trips through the real
  catalog-validating publisher with no regression. Leaving #248 open — 234 pairs across 25 modules remain.

  **Round 8 finally ran the F-101 per-event sweep on m30's own reason text — the largest remaining group,
  which F-115 had only ever checked from ONE side (F-148/F-149, #248).** F-115 (#248) had already checked
  61 of m30's declared events against M30's OWN nightly-recompute seam reads and moved 27 out that way, but
  never checked the OTHER direction — whether each PRODUCING module's own spec decisively named M30, the
  same F-101 rule this series applies everywhere else. **F-148 finished the smaller half first**: a
  follow-up pass on the six remaining M16 (Bereavement) events found five genuinely confirmed
  (`plan_closed_completed`/`.declined`/`.early`/`plan_skipped_per_patient_opt_out`/`risk_score_computed`,
  each backed by a real `BereavementComplianceProvider` seam method that exists but is DORMANT — unused by
  any of M30's eleven currently-registered measures, "bound is not computing" a further time) and one
  genuinely misdeclared: `contact_referred_external` had **no supporting comment at all**, the one event in
  the group nobody had actually checked. M30's own `M30_OUTBOX_SUBSCRIPTIONS` — its own header calls itself
  "the SINGLE SOURCE OF TRUTH" for M30's inbound topics — has exactly six keys and none is `m16.*`; M30's
  own §1.1 relationship-inventory text scopes its ENTIRE M16 relationship to the CoP-coverage measure ("M30
  emits no bereavement data and writes nothing to M16"); `IncidentKind` has no member a referral maps to;
  and M16's own worked "Done means" walkthrough for this exact transition narrates M36's alert and M22's
  letter render in full and names no M30 action at all — the event's terse table-cell citation ("M30
  incident potential") unsupported everywhere that would have to carry it if real. Dropped, no
  `seamConsumers` replacement. **F-149 then split the remaining 60 events across six parallel
  producer-clustered forks** (M11's 8 order events; M13's 12 eMAR events; M6's 9 admission/compliance/F2F
  events; M15's 4 + M16's residual 6; M20's 3 + M21's 5; and nine smaller producers spanning M14/M23/M25/
  M26/M37/M39/M12/M8/M9), each checked against M30's own §1.1 relationship inventory
  (`docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md`) and its own blanket architectural principle
  ("Outbox publication is the only cross-module communication M30 performs at the boundary … M30 *calls*
  … reader seams as in-process function calls," never a subscription) plus each PRODUCING module's own
  spec. **11 moved to `seamConsumers` rather than dropped bare** — all 8 M11 order events (M11's own §D14
  names a real `OrderProvider` seam whose completion/transmission/results methods M30 has not built yet),
  M21's 5 comfort-kit/controlled-substance/par events (a real, already-registered `SupplyFulfillmentProvider`/
  `ComfortKitDispatchProvider` seam M30 hasn't called yet), M14's 2 IDG review-clock events (confirmed
  ACTIVE — `m30-jobs.ts` calls `getSeam("IdgScheduleProvider")` today, feeding a currently-registered
  measure), and `m39.consent.signed` (M30's `ConsentEvaluator.evaluate` is likewise live, per-actor, at
  read time — a signing push has nothing to invalidate). **18 dropped clean, unsupported on both sides** —
  all 12 remaining M13 eMAR events (zero `m13.*` keys anywhere in `M30_OUTBOX_SUBSCRIPTIONS`, and the
  "reconciliation-completed-in-time" measure M13's own spec claims feeds M30 does not exist anywhere in
  M30's registered measure set), all 3 M20 field-safety events (M30's own spec is a flat denial — "Field
  safety. Module 20. No M30 consumption path"), `m37.ipu_admission.discharged` (redundant sibling — the
  death case is carved out to the already-declared `death_recorded`), and `m8.hearthnote.layer2_enhanced`
  (M30's own D16 ten-event recompute-trigger list excludes it; only the different, already-declared
  `m8.encounter.signed` is on that list). **2 corrected from an initial MOVE-TO-SEAM recommendation to
  DROP on independent re-verification, the exact discipline this series exists to enforce**: the M25/M26
  forks first read `m25.denial.opened` and both `m26.cap.*` events as real forward seams, citing M25's/
  M26's own aspirational spec text ("M30's denial-rate HQRP measure … reads M25's `DenialMetricsProvider`,"
  "forward-seam … will add M26 to M30.dependsOn") — but M30's own §1.1 inventory FLATLY denies both:
  "Remittance posting. Module 25. No M30 consumption path" and "Cap management. Module 26. No direct M30
  consumption … cap status … feeds M27 cost reports, not quality measures" — unconditional statements, not
  the genuinely conditional "may consume … when the seam lands" phrasing M30's spec uses for M19/M21's
  real forward seams. The consuming module's own decisive text wins over the producing module's
  aspirational one (F-101), so both were corrected to DROP before being applied. **Net: 234 → 197** (37
  dropped/moved — 1 from F-148, 36 from F-149; 0 added; module count unchanged at 25, m30's own two groups
  shrink from 65 to 28 combined). Verified: `bun run build` clean, `bun run typecheck` clean (0 errors),
  full non-live suite 654 files / 9589 tests green (one pinned-array assertion updated —
  `orders-outbox-consumers.test.ts`'s `m11.order.signed` fan-out, to drop `m30` from `declaredConsumers`
  and add it to `seamConsumers`), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), and a
  clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving
  #248 open — 197 pairs across 25 modules remain.
