// scripts/outbox-deferred-consumers.ts — the F-043 (#103) register of DECLARED-BUT-UNBOUND outbox
// consumers.
//
// `declaredConsumers` on a catalog entry states that a module consumes that event. For most of the
// catalog that statement is not true, and until this register existed nothing said which: an event
// declaring `["m33", "m36"]` with zero consumers satisfied every rule
// `check-outbox-bindings.ts` had, because all three ran binding -> catalog and none ran
// catalog -> binding. That is the same unasked-direction defect as F-025/#59 (the live-suite gate
// checked package.json -> CI and never CI -> package.json, hiding 29 suite files), and the same fix
// applies: ask both directions, and NAME every exception.
//
// WHAT THE ABSENCE ACTUALLY COSTS AT RUNTIME. Not silence. `resolveRouting`
// (bootstrap/outbox-dispatcher.ts) marks an event `deferred` when any declared consumer module is
// not live, and the relay then finalizes each row `status: "pending"`, `attemptCount - 1`,
// `nextAttemptAt: now + deferredRetryMs` with `lastError: "deferred: one or more declared consumers
// are not live"`. Because the attempt count is DECREMENTED the row never reaches `maxAttempts` and
// never dead-letters, and the retention purge touches only `dispatched` rows — so every emission of
// a declared-but-unbound event is a row that stays pending forever and is re-claimed every 30
// minutes for the life of the deployment. `outbox-dispatcher.live.test.ts` ("deferred: a
// declared-but-not-landed type stays 'pending' with no attempt burn") is that behaviour's proof.
//
// WHAT THIS REGISTER IS AFTER #103's SECOND PASS. It held 1165 pairs; 623 of them were not deferrals
// at all. M4 captures at the DATABASE layer (write-audit triggers, in the producer's own
// transaction), M36 alerts through the `AlertEmitter` seam, and M33 pulls over `report_mv.*` — none
// of the three was ever going to bind an outbox consumer, so "deferred" described them wrongly and
// the declaration itself was what deferred 252 events forever. Those pairs moved to `seamConsumers`
// on the catalog entry, a field the dispatcher ignores by construction. What is left, 542 pairs, is
// the honest list: consumers that ARE meant to bind and do not yet.
//
// EACH ENTRY IS THE (module, event) PAIR, ENUMERATED. Grouping is by consumer module because that is
// where the reason lives — m22 is declared on 85 events for one reason, not 85 reasons — but the
// event lists are exact, so the count cannot drift and a pair that gains a binding fails the gate
// (`the deferral has outlived its reason`). Regenerate the lists with
// `bun run arch:outbox-bindings --update`; the reasons are hand-written and are never regenerated.
//
// `kind` is documentation, not a machine-checked claim; the machine-checked facts are that the pair
// is in the boot catalog and is currently unbound. `unclassified` means no reason has been
// established yet — the gate prints those loudly on every run. They are a work list, not a passing
// state.

/**
 * Why no live binding exists for this module's declared events.
 *
 * `"seam"` was the fourth kind and is deliberately gone (#103). It described 623 pairs whose consumer
 * never intended an outbox subscription at all — M4 captures at the DATABASE layer via write-audit
 * triggers, M36 alerts through the `AlertEmitter` seam, M33 pulls over `report_mv.*`. Those are not
 * deferrals waiting on work; they were the catalog using one word for two delivery mechanisms, and the
 * cost was 252 events deferred forever by a subscription nobody meant to declare. They now live in
 * `seamConsumers` on the catalog entry, which the dispatcher ignores by construction. A deferral is
 * now only ever a consumer that IS meant to bind and does not yet.
 */
export type DeferralKind =
  /** The module has consumer handler code that no `OutboxConsumerBinding` reaches. */
  | "handlers-unbound"
  /** The module has no consumer directory at all — a forward declaration against nothing. */
  | "no-consumer-surface"
  /** No reason established. Printed on every gate run; not a resting state. */
  | "unclassified";

export interface DeferredConsumerGroup {
  /** The module token named in the events' `declaredConsumers`. */
  readonly module: string;
  readonly kind: DeferralKind;
  /** Why. Must be non-empty — an unexplained deferral is the thing this register exists to end. */
  readonly reason: string;
  /** Every catalogued event that declares `module` and has no live binding from it. Exact, sorted. */
  readonly events: readonly string[];
}

export const DEFERRED_CONSUMERS: readonly DeferredConsumerGroup[] = [
  // ADR-0082 (PROPOSED) slice S1 - the catalog entry lands first, flag-off and unpublished (no producer: slice S3 publishes it).
  // The M19 D10 consumer that opens the triage call is slice S2 and needs the M19 owner. Ends on S2's commit, which binds the
  // consumer and deletes this group in the same change.
  {
    module: "m19",
    kind: "no-consumer-surface",
    reason:
      "ADR-0082 slice S1 declares m36.afterhours_triage.requested for m19, but the M19 consumer (consumers/m36-afterhours-triage-requested.ts) is slice S2 and does not exist yet. Nothing publishes the event until slice S3 behind the flag messaging.afterhours_triage (absent = off), so no row is deferred in the meantime. S2 binds the consumer and removes this entry.",
    events: ["m36.afterhours_triage.requested"],
  },
  // F-205 (#248) — the m30 `handlers-unbound` group is GONE, not merely emptied. `m18.evv.visit_verified`
  // was bound earlier by F-194 (M18's check-out write path never called the `recordEvent` decider that
  // declared this event's effect; fixed by emitting it inline, then binding M30's pre-existing
  // `hvldl_near_death_recompute` handler). `m12.medication.error_reported`, the group's last remaining
  // pair, is now bound too. F-165/F-174 had found this event's real blocker was "no producer anywhere"
  // (the actor-identity half F-150 originally blamed was wrong — the catalogued payload already carries a
  // real `reportedByMembershipId`). The user has since decided the missing producer: a new explicit
  // clinician-initiated "report error" action on the medication order (M12), not an auto-derived one.
  // Built: `POST /api/v1/medication-orders/:id/report-error` (`reportMedicationError`), and
  // `buildM30MedicationErrorReportedConsumer` binding the pre-existing pure
  // `handleMedicationErrorReported`/`createIncidentDraft` handler (real since F-185), resolving
  // `providerEntityId`/`locationId` via a new M12→M6 seam chain (`medicationOrderScheduleContextForOrg` →
  // `admissionSchedulingContextForOrg`), the F-166 M13 dose-materializer precedent.
  // F-215 (#248) — the LAST m30 pair (`m15.volunteer.ratio_recomputed`) is dropped at the producing catalog
  // entry (misdeclared: numerator-only event, M30 names only `volunteer_compliance_gate_rate` from M15, read-time
  // seam pull), and the m30 group is deleted outright (the F-115/F-164/F-198 "group empties -> delete" precedent).
  // F-235 (#248) — the `m22` group is GONE, not merely emptied: the register is EMPTY. Its last two pairs
  // were the DocLens extraction back-refs, settled by the user's F-231 decisions A1 + B (2026-10-03).
  // `m12.medication_order.draft_created_from_extraction` is DROPPED at the source (A1: medications never
  // write back — M12 D12 / AI Governance §2.1.1 — so no M22 commit can target M12 and `m22` is removed from
  // that event's `declaredConsumers`). `m5.patient.draft_created_from_extraction` is BOUND (B): review
  // completion publishes `m22.extraction.commit_requested` (low-risk contact fields only, onto the batch's
  // already-resolved patient), M5 applies it in one transaction and replies, and M22's
  // `m22.extraction-writeback-backref` stamps `extraction_provenance` and emits `m22.extraction.commit_completed`.
  // The group's full history (F-099 … F-231) is in `docs/history/outbox-248-builds.md`.
  // F-234 (#248) — the `m14` group is GONE, not merely emptied. Its last pair, `m15.idg_decision.applied`, is
  // BOUND: M15 gained the intake side of the M14 IDG-decision contract (`discipline_plan_update`, ADR-0023 /
  // M15-F07; M15 spec §7.7 — `consumers/m14-idg-decision-recorded.ts` opens a draft next version on the named
  // discipline plan, applies the mutations, and emits this event), and M14 consumes the acknowledgement
  // (`consumers/m15-idg-decision-applied.ts` → `idg_decision_application_ack`). The earlier history of the
  // group (F-104 auto-close, F-129/F-145 misdeclared drops, F-164 "since last IDG" cache, F-167/F-171 worker,
  // F-176/F-218/F-230 seam-pull resolutions) is in `docs/history/outbox-248-builds.md`.
  // F-115 (#248) — the `m28` group (52 pairs) is GONE, not merely emptied. M28's FHIR gateway resolves
  // every seam it reads (M5/M6/M7/M8/M11/M12/M13) fresh at REQUEST time (§164.528 D3, F-035) and holds no
  // cached/derived state any of these events would ever need to invalidate — it never subscribes to
  // anything, on any topic, and the "no consumer directory … forward declarations against a subscriber
  // that does not exist" reason was correct about the SURFACE and wrong about the CONCLUSION: the
  // declarations were not future work, they were never going to be true. All 52 `m28` entries on the
  // `declaredConsumers` catalog have been removed (each event's own `events-by-mNN.ts`), leaving nothing
  // to defer.
  // F-164 (#248) — the `m23` group is GONE, not merely emptied. `m25.taxonomy.unmapped_code_observed`,
  // the group's last remaining pair (M23's own §11.A/D13 30-day-rolling-occurrence / 50-threshold alert),
  // is now bound: a new per-row `unmapped_taxonomy_occurrence` table (migration 0255 — one row per
  // delivered occurrence rather than a maintained counter, since a rolling window needs individual rows to
  // age OUT, which a counter can never express), idempotent on `(organization_id, source_event_id)`, and a
  // new consumer that inserts the occurrence then dispatches the existing `WorkerAlertPort` → M36
  // `AlertEmitter` seam (the same mechanism M23's own cron alerts already use — no new alert-delivery
  // mechanism invented) once the org's rolling 30-day count for that CARC code exceeds 50.
  // F-207 (#248) — the `m27` group is GONE, not merely emptied. `m21.supply_request.invoice_accrued`/
  // `.invoice_reconciled`, the group's last remaining pair, are now bound. F-130/F-167/F-174 sharpened the
  // real blocker over three passes: M27's expense-input model is GL-account-level and period-aggregated
  // (`trial_balance_import`/`cost_center_mapping`/Worksheet A), with no per-transaction accrual precedent
  // except `bad_debt_record` (scoped to one already-created cost report) and no fiscal-year field on
  // either M21 payload. The user has since decided this as a 4th cost-basis precedence tier, additive to
  // D17's M13 administration -> M12 ordered -> manual entry chain (M27 spec D17), not a replacement of the
  // GL-mapped Worksheet A figure. Built: a new `vendor_invoice_line` table (migration 0276) and
  // `buildM27VendorInvoiceConsumer`, which resolves the fiscal-year `cost_report` by
  // `(providerEntityId, factDate)`, inserts an idempotent accrual row (`ON CONFLICT DO NOTHING`), and
  // updates the same row on reconciliation guarded on `status = 'accrued'` — dead-lettering (not guessing)
  // when a fact falls outside every open report's window.
  // F-164 (#248) — the `m26` group is GONE, not merely emptied. `m25.remittance.claim_recouped`, the
  // group's last remaining pair, is now bound. The real blocker was three missing facts, not the two the
  // prior reason named: `patientId` was genuinely absent from the payload; `priorPaidAmountCents` was
  // never the right field to blame (`handleClaimReversed`'s `cents()` helper is a passthrough, not a
  // dollars→cents conversion, so the real fix is a payload field ALREADY in cents, not a smarter reader);
  // and `cap_beneficiary_accrual_line.service_from`/`.service_to` (NOT NULL) were also missing, found only
  // by tracing the real insert path. Fixed by widening `m25.remittance.claim_recouped`'s payload at its one
  // real emit site (`patientId` via the already-in-scope M23 `ClaimMatchCandidateProvider` seam —
  // `postAdjustments`'s own PR-ledger seed already reads it two functions up in the same file —
  // `recoupedAmountCents` computed directly from the same float dollars the existing `recoupedAmount`
  // string already carries, `serviceFrom`/`serviceTo` from the 835's own optional DTM claim-service-period
  // dates, honestly `null` when the payer's 835 omits them) and routing it to the SAME `record-reversal-line`
  // action `m23.claim.replaced`/`.voided` already use. `m23.claim.replaced`/`.voided` themselves stay a
  // documented, pre-existing no-op independent of this fix — neither of THEIR payloads carries `patientId`
  // or any amount field under any of the names `handleClaimReversed` reads; a future pass could widen them
  // the same way, using M23's own claim row (already in hand at their emit site, no cross-module seam call
  // needed).
  // F-215 (#248) — the m17 group's last pair (`m20.safety.high_risk_area_entered`) is dropped at the producing
  // catalog entry (M17's spec never mentions it; no producer); the group is deleted outright.
  // F-227 (#248) — the m16 group is GONE, not merely emptied: `m6.discharge.cosigned` is BOUND (`buildM16DischargeCosignedConsumer`).
  // The F-159/F-167 "payload mismatch" was real but was M6's gap, not a reason to stay blocked: M6 now stamps an HL7-external
  // death with `source`/`source_proposal_id`/`cosign_required` (migration 0300, W-M6-31) and its route-40 cosign attests it,
  // widening the catalogued payload with `sourceProposalId` + `medicalDirectorMembershipId`; M16 releases the D18 gate on it.
  // F-158 (#248) — the `m25` group is GONE, not merely emptied. Both remaining pairs are now BUILT:
  // `m23.claim.rejected` and `m18.evv.aggregator_rejected` each seed a real `denial_case` row via
  // `buildM23ClaimRejectedConsumer`/`buildM18EvvAggregatorRejectedConsumer`
  // (`25-remittance/outbox-consumers/`). The two schema gaps F-153 found (no unique index backing
  // either idempotency key shape; `DenialSeedStore.seedDenial` had no `taxonomyStatus` field) are
  // fixed: migration 0249 adds `denial_case.source_idempotency_key` + a plain
  // `UNIQUE(organization_id, source_idempotency_key)` constraint (Postgres's NULL-distinctness lets
  // the pre-existing `remittance_adjustment`-sourced rows, which never set the column, coexist with no
  // partial `WHERE` needed), and both handlers now resolve `taxonomyStatus` through a new
  // `resolveDenialCategory` helper that reuses the existing `effectiveCategory` CARC-category
  // resolution rather than re-deriving it. Building it surfaced a third, undocumented blocker: neither
  // catalogued payload carries `providerEntityId`, which `denial_case` requires NOT NULL — resolved
  // per event: M23's via a direct `@wardenx/billing` `ClaimRepository.findById` read (legal — M25's
  // `dependsOn` includes 23); M18's via M17's `VisitReader` seam, wrapped in `runWithRequestContext`
  // since `SchedulingSeamStore.visitById` opens `withOrgContextFromRequest` and a dispatcher tick is
  // not a request (the same F-118 fix `19-oncall`/`20-field-safety` already apply for this identical
  // M17 dependency). `denial_case` itself has no document-reference column at all (checked directly,
  // not assumed), so `handlers.ts`'s header claim of a "resolution_letter ref" back-ref stays
  // aspirational — reported, not built, since neither target event needed it.
  // F-225 (#248) — the `m31` group is GONE, not merely emptied (the F-198 `m11` / F-115 `m28` shape). Its last
  // pair, `m22.document.rendered`, is DROPPED at the source (events-by-m22.ts): M31 answers "what can this
  // account see" by SEAM PULL (`PortalDocumentReader.documentsForPatient`), and the approved drop's
  // accounting premise — that M4/M22 audit covers portal document disclosures — was made TRUE by F-225
  // (the portal mint now appends a `document_access_log` row; the route's M4 read-audit carries the document
  // id and fires only on an actual mint). Full per-pair history of this group (F-139..F-176, F-220..F-225):
  // docs/history/m31-portal-deferrals.md + docs/history/outbox-bindings-*.md.
  // F-198 (#248) — the `m11` group is GONE, not merely emptied (the F-115/F-164 m28/m23 shape). Its last
  // two pairs, `m39.consent.dpoa.agent_appointed`/`.agent_removed`, are DROPPED — the last holdout of the
  // M7/M14 pattern already established (F-129/F-142 dropped both of those on the strength of a real,
  // documented pull alternative each module had built: M7's write-time `acting_consent_id` attribution,
  // M14's build-time packet read). M11 has neither: every order in M11's own catalog (`events-by-m11.ts`)
  // carries only `orderingPhysicianMdmId`/`certifyingPhysicianMdmId` — every order is physician-signed,
  // never patient/representative-signed — and an exhaustive grep of `11-orders/` and `packages/orders/`
  // for any consent/authorization/decision-making concept returns nothing. There is no mechanism, at
  // write time or read time, for "DPOA attribution refresh" to attach to. `declaredConsumers` corrected
  // at the source (`events-by-m39.ts`). The group's own long history (F-137 through F-177) — the M21
  // supply-cancellation split, the M7 intervention-linkage drop, the M29 lab-transmission-applier build —
  // stays in `git log`/`docs/history/outbox-248-builds.md` rather than repeated here now that nothing in
  // this group remains open.
  // F-216 (#248) — the m5 group (its last pair, `m39.consent.expired`) is GONE: M39 now has a real producer (the
  // hourly `m39.consent_expiration` cron, `39-consent/jobs/`) and M5's `m39-consent-privacy` consumer binds the event
  // (a lapsed Part-2 consent re-restricts the persisted `sud` flag; see the consumer header for the renewal-safety rule).
  // F-166 (#248) — the m13 group (4 pairs, all M21 comfort-kit events) is now FULLY RESOLVED and
  // deleted from this registry outright, the F-132/F-155(#m35)/etc. "group empties → delete, don't leave
  // a hollow entry" precedent. Both real blockers this group's own text had accumulated across F-140/
  // F-159/F-166 are fixed, not merely re-scoped a fourth time:
  //   1. `m21.comfort_kit.returned` double-emission (`21-supplies/routes/write-service-drizzle.ts`'s
  //      `createReturn`, which published this event at return-REQUEST time with placeholder empty-string
  //      `disposalMethod`/`reconciledByMembershipId`) is DELETED at the source — checked against M21's
  //      own spec (WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:48) first, which is
  //      unambiguous that `.returned` fires only at reconciliation; no `.return_requested` (or any other
  //      spelling) event was invented in its place, because no consumer anywhere needs a "return was
  //      requested" signal (`comfort_kit_deployment.disposal_status` has no state between
  //      `return_required` and `returned` to carry one) — inventing an unconsumed event would have been
  //      the identical mistake being fixed, restated. `.returned`'s only real emission is now
  //      `reconcileReturn`'s own `{ kind: "outbox", event: "m21.comfort_kit.returned" }` effect
  //      (`21-supplies/lifecycle/return.ts`), which fires once a return actually reaches `reconciled`.
  //   2. The nullable-`medicationOrderId` gap (`ComfortKitDispatchedContentPayload.medicationOrderId`,
  //      null for an IPU-stock-kit-on-room line with no per-patient order — a real, documented M21
  //      business concept, `WARDENX_MODULE_21...md:58`) was investigated fresh rather than re-asserted:
  //      confirmed, by reading every M13 table (`administration_record`, `comfort_kit_drawdown`) and the
  //      whole pure `@wardenx/emar` comfort-kit core, that NO precedent anywhere represents an order-less
  //      drawdown/administration — inventing one now would be deciding unreviewed DEA-adjacent
  //      controlled-substance-accounting semantics on the fly (the F-102 "a guessed provider entity is a
  //      mis-stated cost report" lesson one module over). Resolved by SCOPING rather than guessing: the
  //      four new consumers (`13-emar/outbox-consumers/m21-comfort-kit-{deployed,replenished,returned,
  //      return-reconciliation}.ts`) track every ORDER-LINKED line for real — the documented "typical
  //      case" per M21's own spec, a comfort-kit-deploy with the platform-floor medications prescribed at
  //      admission — and DELIBERATELY, VISIBLY skip a null-order line (reported via
  //      `skippedFloorStockLineCount` on the `m13.comfort_kit.deployed` ack, never silently dropped) — a
  //      real, honestly-reported gap (per-line floor-stock tracking), not a fabricated schema fix.
  // All four events are now live-bound: `m13.comfort_kit.deployed` completes a handshake M21's own
  // `buildM21ComfortKitDeploymentAckConsumer` (F-153) had sat waiting on, unreachable, since it was
  // built — nothing had ever published the event it subscribes to. A new pure `applyKitReplenishment`
  // (`@wardenx/emar`) fills the one genuine gap in the domain core (no function existed for "apply a
  // physically-arrived replenishment to a drawdown"), capped at `expected_quantity` rather than allowed
  // to overshoot. Migration 0259 adds `comfort_kit_deployment`'s first-ever idempotency key
  // (`(organization_id, m21_supply_dispatch_id)`, NULLS DISTINCT) — the table had no live writer before
  // this pass, so no redelivery guard had ever been needed. `M13_OUTBOX_SUBSCRIPTIONS`
  // (`13-emar/consumers/index.ts`) previously named only two of the four M21 events at all — corrected
  // in the same change, the two missing entries (`.replenished`/`.return_reconciliation`) were simply
  // never listed, not merely unbound. Proven by `m13-comfort-kit-deployment.live.test.ts` against a real
  // disposable Postgres: an order-linked deployment creates the deployment + drawdown rows and acks
  // M21's dispatch link for real end to end; a floor-stock-only line is skipped and reported, never
  // fabricated; a redelivery of `.deployed_at_patient` is a true no-op; a replenishment tops up capped at
  // `expected_quantity`; a reconciled return flips disposal status via `.returned` alone (never at
  // request time — `createReturn` no longer emits it); `.return_reconciliation` closes each drawdown's
  // `final_remaining_quantity_at_return`, flags a ≥5% controlled-substance delta via
  // `m13.comfort_kit.controlled_substance_discrepancy`, and emits the aggregate `m13.comfort_kit.returned`
  // ack; and cross-tenant isolation holds throughout.
  // F-232/F-233 (#248) — the m21 group is now FULLY RESOLVED and deleted outright (the F-175 "group empties ->
  // delete" precedent): `m11.order.supply_fulfillment_requested` is bound for dme/supply by
  // `21-supplies/outbox-consumers/m11-supply-fulfillment-intake.ts` (F-232, comfort_kit settles unbound inside
  // that binding) and `m12.medication_order.dispensed_at_pharmacy` by `m12-pharmacy-dispense.ts` (F-233,
  // Option B pharmacy-dispense fact; chain-of-custody dispatch creation remains a human decision). See
  // docs/history/outbox-248-builds.md.
  // F-175 (#248) — the m29 group (1 pair, `m11.order.hl7_orm_requested`) is now FULLY RESOLVED and deleted
  // from this registry outright, the F-166 (m13 group) / F-176 (m11 group, m7.intervention.* trio)
  // "group empties → delete, don't leave a hollow entry" precedent. `apps/backend/src/modules/
  // 29-external-interfaces/outbound/dispatch-worker.ts` is the real T08 worker `dispatch-planner.ts`'s own
  // header named and F-165/F-167 both confirmed still uncalled: it binds live on this event, resolves the
  // feed + D16 BAA gate, envelope-encrypts under M34's tenant DEK, dispatches over the injected
  // `MllpTransport`, and acts on every ack/retry/DLQ outcome — see the two NEW pairs this pass adds to the
  // `m11` group instead (`m29.lab_order.transmitted`/`.transmission_failed`, M29's own new outbound
  // production, declared-but-unbound on M11's *consuming* side; that gap is real and distinct from this one).
  // F-223 (#248) — the m6 group (1 pair, `m11.order.recertification_signed`) is now FULLY RESOLVED and deleted
  // outright (the F-175 "group empties -> delete" precedent). The user decided a signed recert order
  // auto-opens the next PENDING election period: `outbox-consumers/m11-recertification-signed.ts` (migration
  // 0297 `election_period.source_order_id` + UNIQUE(organization_id, source_order_id)) reuses the route's own
  // `openNextElectionPeriodInTx`; F2F/CTI adequacy stays gated at activation (F-217).
  // F-142 (#248) — the `m7` group is GONE, not merely emptied. All 5 pairs were checked against M7's own
  // authoritative surface: `m39.consent.dpoa.agent_appointed`/`.agent_removed` and both `m9.assessment.*`
  // events are redundant with documented build-time SEAM PULLS (M7's own D7 — a single ABAC seam to M39
  // for DPOA attribution; M7's own spec — the registered `LatestAssessmentProvider` seam for M9 scores),
  // dropped at the source with no m7 replacement. `m19.triage_call.care_plan_change_indicated` was a
  // genuine misdeclaration, not merely unsupported: M19's own D8-cascade text (§11) names the real
  // consumer as M14's IDG packet builder, not M7 — corrected at the source (declaredConsumers m7→m14) and
  // the pair now lives in the m14 group below.
  // F-172 (#248) — the `m35` group is GONE, not merely emptied. Two prior passes (F-142, F-167) declined
  // to build `PseudonymKeyProvider.activeKey()`, reasoning M34's per-tenant DEK-wrap mechanism
  // (`bootstrap/tenant-kek.ts`) "does not transfer" to a platform-singleton secret and that building one
  // was "genuinely new security-critical infrastructure, not a wiring task." Re-investigated rather than
  // re-asserted: it is the SAME already-ratified pattern (ADR-0038 app-layer AES-256-GCM envelope
  // encryption, KEK custody as a fail-closed env-sourced port) applied a fifth time — the identical
  // custody model `TWO_FACTOR_ENCRYPTION_KEY`/`M24_CREDENTIAL_ENCRYPTION_KEY`/`MESSAGING_ENCRYPTION_KEY`/
  // `M34_TENANT_KEK` already use, and the module's OWN spec (§4.11 D15/§14.3) independently commits to
  // "the standard WardenX KMS-wrapped DEK pattern" for this exact table. No real cloud KMS credential or
  // new security decision was needed: the KEY MATERIAL is a CSPRNG mint (`randomBytes(32)`, the identical
  // mechanism every DEK/KEK mint on this platform already uses — no human chooses or reviews the bytes),
  // and the only operator-configured secret is the wrapping KEK, following the established shape exactly.
  // Built: `packages/subscription-billing/src/pseudonym/key-envelope.ts` (the pure AES-256-GCM
  // seal/open, AAD-bound to `(kekId, keyEpoch)` rather than an org id — the platform-singleton analogue of
  // `tenant-kek.ts`'s tenant-binding AAD) + `35-subscription/pseudonym-key-provider.ts` (the real
  // `PseudonymKeyProvider`, driven over the PLATFORM pool `DATABASE_PLATFORM_URL` already grants
  // `patient_pseudonym_key` to — mint-on-first-use, race-safe via the table's own
  // `patient_pseudonym_key_one_active_uq` partial index rather than an app-level lock) + a new
  // `M35_PSEUDONYM_KEY_KEK` required-in-production env var (`bootstrap/env.ts`, the `M34_TENANT_KEK` rule
  // verbatim, a SEPARATE secret never interchangeable with it). `m2.session.created`'s
  // userId→membershipId gap F-142/F-167 both flagged is resolved the same way M5's own
  // `membershipUserIdForOrg` already resolves the reverse direction one module over: `membership` is
  // M1-owned (`architecture/module-manifest.ts`), M35 `dependsOn: [1]`, so M35 reads `schema.memberships`
  // directly rather than needing a new cross-module seam. `m5.patient.merged`'s "re-pseudonymize on merge
  // target" (§4.12) is the merge SURVIVOR's own raw patientId fed through the existing
  // `recordPatientActive` shape; `m5.patient.deceased`'s "mark inactive with reason='died'" is a new,
  // narrowly-scoped `markPatientInactiveForOrg` capability (NOT added to the pure `ActivePeriodStore`
  // port — an extra Drizzle-store capability beyond the minimal port, the `CaseloadStore` shape) that
  // deliberately leaves `was_active` untouched (a patient who died mid-period WAS active for part of it;
  // see that function's own header). `m5.patient.created`/`.status_changed` — D21's other two
  // `patient-active-period-aggregator` triggers — are OUT OF SCOPE: neither declares `m35` on its catalog
  // entry today (only `.deceased`/`.merged` do), a separate, unscoped catalog question this pass does not
  // answer. Proven live end to end (`m35-pseudonym-key-provider.live.test.ts`): mint-on-first-use is
  // race-safe under two concurrent callers (exactly one epoch minted), the wrapped ciphertext at rest is
  // never the plaintext, an unknown KEK id refuses with a stated reason, rotation retires the old epoch
  // and historic rows keep their original epoch tag (never rewritten), `patient_pseudonym_key` is
  // unreadable on the tenant `wardenx_app` credential (42501, the `tenant_key_ring`/M34-F02 shape), and
  // all three consumers write real `patient_active_period`/`user_active_period` rows under RLS with
  // cross-tenant isolation (org B's rows are untouched by an org A delivery).
  // F-158 (#248) — the `m2` group is GONE, not merely emptied. `m39.consent.revoked` is now BUILT:
  // `buildM2ConsentRevokedConsumer` terminates the patient's own `patient_portal` sessions when their
  // `portal_access` consent is revoked — the exact mechanism M39's spec names, deliberately scoped to
  // that ONE consent type. `family_caregiver_access` (also named in M39's per-type cascade table) is
  // NOT handled: the spec's own worked walkthrough assumes a session model migration 0219/0220 already
  // split into three classes, and — the real blocker — two independent, concurrently-active
  // `family_caregiver_access` consent records can legitimately name different caregivers for the same
  // patient with nothing in `consent-store-db.ts#createDraft` preventing it, so a blanket
  // "every `caregiver_portal` session for this patientId" sweep would terminate an unrelated
  // caregiver's still-valid session. The only disambiguating fact
  // (`portal_access_grant.source_consent_record_id`) is M31-owned and not exposed by either of M31's
  // published read seams, nor is `PortalAccessGrantReader` in the platform's `SeamName` union at all —
  // a genuine missing cross-module read surface (a new M31 seam method + `SeamName`/`REQUIRED_SEAMS`
  // registration), reported rather than guessed at.
  // F-142 (#248) — the `m32` group is GONE, not merely emptied. `m16.bereavement.risk_score_computed`
  // and `m8.hearthnote.layer2_enhanced` were both dropped on the identical shape: M32's own spec states
  // the relationship runs the OPPOSITE direction — M16/M8 each call INTO M32's registered seam
  // (`BereavementRiskNarrativeProvider.augment`/`NarrativeEnhancementProvider.enhance`) SYNCHRONOUSLY,
  // and M32 already returns everything these events' payloads carry during that call; consuming its own
  // announcement afterward would be redundant. `m19.triage.summary_requested` was a genuine
  // misdeclaration, not merely unsupported: `events-by-m19.ts`'s own inline comment ("reserved for an
  // M32 AI call-summary request") directly contradicted M19's own LOCKED spec, cited three separate ways
  // (the "Consumed by" table, the §4.10 outbox table, and the Lock-status section, all naming M22 for a
  // caregiver/attending PDF render) plus `packages/types/src/oncall.ts`'s own payload doc comment ("→ M22
  // renders the caregiver/attending summary document"). Corrected at the source (declaredConsumers
  // m32→m22) and the pair now lives in the m22 group above.
  // F-219 (#248) — the `m37` group is GONE, not merely emptied. Its last pair,
  // `m19.triage_call.gip_admission_proposed`, is resolved as a SEAM PULL, the user-decided path: M37's
  // intake worklist reads M19's org-explicit published `gipProposalsForOrg`
  // (`19-oncall/seams/gip-proposals-for-org.ts`) through `GET /api/v1/ipu-intake/gip-proposals`, wired in
  // the composition root (`apps/backend/src/index.ts`, `gipProposals` port on the M37 route service). M37
  // gains NO table: no `ipu_admission` row can exist at proposal time (`admission_id`/
  // `level_of_care_period_id`/`provider_entity_id` are NOT NULL and the LOC period is created later by M11's
  // order draft), so the worklist entry is a PROPOSAL READ, distinct from the durable M11 LOC order -> M6
  // `requires_ipu_bed` -> M37 path. M19's catalog moved `m37` from `declaredConsumers` to `seamConsumers`.
  // F-218 (#248) — the same M19 read also feeds M14: `m19.triage_call.care_plan_change_indicated` left the
  // `m14` group below (seam pull as a `triage_care_plan_change` flagged event, `flaggedEventSources`).
  // F-143 (#248) — the `m9` group is GONE, not merely emptied. All 3 pairs were checked against M9's
  // own spec: `m13.prn_administration_recorded` has no support anywhere in M9's "Depends on"/"Consumed
  // by" relationship inventory or its §2.4 outbox table; `m8.encounter.signed` is M8 calling INTO M9's
  // `recordAssessment` API synchronously (M9's own line 61), never a push M9 would subscribe to;
  // `m8.vitals.captured` is the seam-vs-push trap — M9's own spec (line 75) states trending "may read
  // the encounter vital series via M8's seam ... but M9 does not own vital signs," a documented pull
  // M9 would perform, never an outbox push. All 3 dropped at the source (`m8.vitals.captured` moved to
  // `seamConsumers` instead, recording the aspirational-but-unbuilt seam relationship).
  // F-164 (#248) — the `m12` `handlers-unbound` group is GONE, not merely emptied: all 8 remaining pairs
  // are now BUILT and live-bound. `m11.order.verbal_expired_unsigned` — all three stacked defects fixed:
  // M12's `recordVerbal` now writes M11's polymorphic `verbal_order` row through the real
  // `OrderSignatureProvider.recordVerbalOrder` seam (which itself gained a real per-org deadline read,
  // `verbalPolicyForOrg`, fixing a latent bug where every deadline used the 48h platform default); the
  // catalog payload gained the missing `targetKind` field; and M11's hourly `orders.verbal_timer` BullMQ
  // fan-out now calls the real `OrderRouteService.expireOverdueVerbals` scan, with M12's
  // `verbal-expired-binding.ts` consumer flipping the medication order to `expired_unsigned` on delivery.
  // `m13.reconciliation.draft_order_requested` — M13's real emit site now sends genuine drug content
  // (never the historical hardcoded `{}`), and M12's `draft-order-requested-binding.ts` mints a real
  // draft `medication_order`, siting/attributing it via M6's `activeAdmissionDraftContextForPatient` seam,
  // idempotent via a new non-partitioned ledger table (`medication_order_reconciliation_decision_
  // application`, migration 0254 — `medication_order` is partitioned, so a direct unique constraint on
  // the triggering decision id cannot exist). The 6 `sync-triggers.ts` events (`m5.patient.{created,
  // updated,address_changed,payer_changed}`, `m6.admission.activated`, `m6.cti.signed`) now have the full
  // job-queue tier this group's own reason said did not exist: a durable `dosespot_sync_queue` table
  // (migration 0253, `12-dosespot/jobs/schema.ts` — chosen over pure BullMQ because a Postgres
  // partial-unique index can debounce TWO DIFFERENT trigger events for the same patient close together,
  // atomically with the outbox delivery, which a BullMQ `jobId` dedupe cannot) drained by a scheduled
  // worker with an honest fail-closed `DoseSpotClient` boundary (no `DOSESPOT_*` credential exists
  // anywhere in this repo) and a real M5 demographic-snapshot read (`dosespotSyncDemographicsForOrg`,
  // M5's own org-explicit seam — `patient_address`/`patient_phone` are not in `check-table-ownership.ts`'s
  // cross-module-read exemption set, so this could not be a direct schema read despite M5 being a
  // declared dependency). `m6.cti.signed`'s missing `admissionId` resolves through M6's own org-explicit
  // `electionPeriodContextForOrg` seam, injected as a port (M12's manifest has no `dependsOn` edge to 6).
  // Two smaller gaps stay genuinely deferred, reported rather than fabricated: no RxBenefit cache exists
  // anywhere in this repository (the `invalidateRxBenefitCache` flag is preserved on the queue row for a
  // future cache layer to act on), and no table maps a WardenX patient to its DoseSpot-side id
  // (`DosespotPatientIdResolver` stays an honest deny-stub — a MedHx fetch cannot name which vendor
  // patient to pull history for until a successful patient-sync upsert has somewhere to record its
  // response, and the vendor client itself is unbound regardless).
  // F-143 (#248) — the `m10` group is GONE, not merely emptied. `m8.encounter.signed` was the sole
  // member, and M10's own spec is decisive the relationship runs the OPPOSITE direction — line 9's
  // "Consumed by" table and the spec's own re-lock note (explicitly correcting a prior encoding that
  // "inverted the M8↔M10 dep direction") both state M8 CALLS M10's `recordHopeTimepoint` API
  // synchronously; M10's two real outbox consumers (`apps/backend/src/modules/10-hope/outbox-consumers/`)
  // are both M6-only. Dropped at the source with no `seamConsumers` replacement — the relationship is a
  // synchronous API call, not a seam read either.
  // F-143 (#248) — the `m3` group is GONE, not merely emptied. `m39.consent.supersedes` was the sole
  // member; M3's own spec (line 74) states it consumes a consent attribute only via the boot-registered
  // `ConsentEvaluator` seam PULL, consulted fresh per ABAC evaluation, never an outbox subscription — M3
  // has no `consumers/` directory and no consent-keyed cache to rebind (its one cache invalidates only
  // on role/permission changes). Dropped at the source; no `seamConsumers` replacement needed since the
  // relationship the event's own description gestured at ("cache rebind") is already covered by the
  // live `ConsentEvaluator` seam regardless of this declaration.
  {
    module: "m36",
    kind: "no-consumer-surface",
    reason:
      "ADR-0082 slice S2 publishes `m19.afterhours_triage.outcome` and declares m36 as its consumer; the M36 side that records the outcome on the link row and posts the fixed-text thread line is slice S3, which also needs the S1 link table. M36 has no handler for this event yet (a forward declaration against nothing), and nothing publishes it while `messaging.afterhours_triage` is off, so no row can sit pending. Slice S3 binds it and deletes this entry.",
    events: ["m19.afterhours_triage.outcome"],
  },
];
