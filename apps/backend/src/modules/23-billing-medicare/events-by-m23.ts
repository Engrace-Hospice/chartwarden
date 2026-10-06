// apps/backend/src/modules/23-billing-medicare/events-by-m23.ts — Module 23's outbox-event contributions
// (spec §4.10 Outbox Event Catalog). The full `m23.*` taxonomy keyed on M23's own resources, under the
// `m23.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file
// for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m23'), and valid declared consumers (real
// module ids). The composition root merges this into the platform event catalog at boot (the M27/M30/M33/M34
// events-by-mN precedent); the dispatcher validates each `m23.*` publish against the TypeBox `payloadSchema`
// inside the same transaction as the mutation (the D2 transactional-outbox posture).
//
// NO PHI / NO MBI in any payload (D13, §3.6, §8.7) — every payload is IDs + control numbers + aggregate
// facts only; the MBI is never persisted nor emitted, and `patientId` is an opaque row id (not a name/MBI).
// The cross-module fan-outs target M22 (PDF render handshake), M25 (remittance), M26 (cap projection),
// M27 (cost report), M28 (FHIR), M30 (HQRP), M33 (dashboards/AR), M34 (tenant wizard), M36 (alerts), M6
// (NOE/NOTR compliance-window close), M4 (surveyor-mode reflect), and M1 (system_status).
//
// COUNT RECONCILIATION: the §4.10 prose says "31 topics", but that figure is STALE — it predates the later
// `claim.adjudicated`, `claim.line_finalized`, and `abn.required` rows AND collapses the `m23.notr.*` family
// into a single "(mirror of NOE)" table row. This file ships the COMPLETE concrete contract: the NOTR family
// is expanded into its 7 real events (the §4.8 `m23.notr.submit` / `m23.notr.window-watch` queues + the §4.9
// `m23.notr.window_*` alerts require them), yielding 40 events (18 claim + 7 noe + 7 notr + 3 eligibility +
// 1 mac_credential + 2 mac_portal + 1 billing-render + 1 abn), plus the 5 `m23.transfer_notice.*` events
// (8xC / 8xD, migration 0375) and the 2 `m23.{noe,notr}.correction_created` events (migration 0378) added after
// this count was taken. Severity (§4.10 col 2) and alert routing
// (§4.9) are NOT part of the OutboxEventEntry shape — they live in `@wardenx/billing`'s alerts.ts.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const nullableInstant = Type.Union([isoInstant, Type.Null()]);
const str = Type.String();
const cents = Type.Integer();
const int = Type.Integer();
/** Which date `payerStatusDate` is (migration 0378): the 277CA STC02, a 999's GS04 / ISA09, or our receipt date. */
const payerStatusDateSource = Type.Union([
  Type.Literal("277ca_stc02"),
  Type.Literal("999_gs04"),
  Type.Literal("999_isa09"),
  Type.Literal("receipt"),
]);

export const M23_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── claim lifecycle (§2.2 / §4.10) ────────────────────────────────────────────────────────────────
  {
    eventName: "m23.claim.draft_created",
    moduleOwner: "m23",
    description:
      "A claim DRAFT was assembled from clinical artifacts (PE + patient + admission + TOB + service window).",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      patientId: id,
      admissionId: id,
      tob: str,
      serviceFrom: isoInstant,
      serviceTo: isoInstant,
    }),
    // F-136 (#248) — m23 (self) REMOVED: the spec's own state-transition table (§2.2, "created (DRAFT)")
    // names the real consumers as M33 (reporting) and M22 ("no render yet — wait for SUBMITTED") — never
    // M23 itself. No handler anywhere reads its own draft-created event.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.validation_started",
    moduleOwner: "m23",
    description:
      "A claim entered VALIDATING; a validation_run was enqueued against the current claim state.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id, trigger: str }),
    // GAP-070: m23 consumes its own request (the outbox bridge that creates the validation-run job).
    declaredConsumers: ["m23"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.validation_failed",
    moduleOwner: "m23",
    description:
      "A validation run produced one or more failing rules; the failed rule keys are attached.",
    payloadSchema: Type.Object({
      claimId: id,
      validationRunId: id,
      failedRuleKeys: Type.Array(str),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.ready_for_submission",
    moduleOwner: "m23",
    description:
      "Validation completed with no unresolved blocking failures; the claim transitioned VALIDATING → READY.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submit_requested",
    moduleOwner: "m23",
    description:
      "The user clicked Submit (D2): the same-transaction outbox emit that drives the claim.submit worker.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      claimControlNumber: str,
      attemptIndex: int,
    }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submitted",
    moduleOwner: "m23",
    description:
      "The submission worker uploaded the 837I to the MAC portal; the claim transitioned READY → SUBMITTED.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      claimControlNumber: str,
      macJurisdiction: str,
      submittedAt: isoInstant,
    }),
    // F-135 (#248) — m25 REMOVED: M25's own §4.4 spec text (the `boot.ts` subscribe list) and its real
    // `consumers/subscription-map.ts` name exactly three inbound topics — `m23.claim.rejected`,
    // `m18.evv.aggregator_rejected`, `m22.document.rendered` — and this is not one of them. A submission
    // ack carries no CARC/denial fact for M25 to seed a worklist row from.
    // F-144 (#248) — m22 REMOVED: M23's own spec (§4.10 outbox table) is decisive that M22 renders off
    // exactly one trigger set — "NOE submitted / NOTR submitted / claim acknowledged" — via the
    // dedicated `m23.billing.document_render_requested` event, never off plain submission.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submission_failed",
    moduleOwner: "m23",
    description:
      "The submission worker reported a MAC-portal upload failure; the retry worker picks it up.",
    payloadSchema: Type.Object({ claimId: id, submissionId: id, attemptIndex: int, reason: str }),
    // F-020 (#49) — `m23` is on this list because M23 CONSUMES ITS OWN EVENT: the description's
    // "the retry worker picks it up" is `m23.submission-request-enqueue`
    // (outbox-consumers/submit-requests.ts), which binds this name and enqueues `claim.submit.retry`.
    // The list said `["m33"]`, so the dispatcher threw at boot — the backend did not start in any
    // deployment with `DATABASE_PLATFORM_URL` set, and the retry it names never ran in any other.
    declaredConsumers: ["m23"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submission_stalled",
    moduleOwner: "m23",
    description:
      "The retry worker exhausted its attempts (max 5); the stalled-submission alert is dispatched.",
    payloadSchema: Type.Object({ claimId: id, submissionId: id, attemptIndex: int, reason: str }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.acknowledged",
    moduleOwner: "m23",
    description:
      "The 277CA accepted the claim; ACK_PENDING → ACK_ACCEPTED with the payer claim control number.",
    payloadSchema: Type.Object({ claimId: id, acknowledgmentId: id, payerClaimControlNumber: str }),
    // F-131 (#248) — m26 REMOVED: M26's own §4.4 subscription-map (the authoritative consumer surface)
    // names no `m23.claim.acknowledged` topic; the cap ledger's claim-side inputs are the paid amount
    // (`m25.remittance.advice_posted`), reversal (`.replaced`/`.voided`) and inpatient-day
    // (`.line_finalized`) events only — an acknowledgment carries no cap-relevant fact.
    // F-135 (#248) — m25 REMOVED: M25's own §4.4 subscribe list names `m23.claim.rejected` as the sole
    // pre-835 seed trigger, never a plain acceptance ack — an ACK_ACCEPTED carries no denial code.
    // F-140 (#248) — m24 ADDED: M24's own authoritative `M24_SUBSCRIPTION_MAP` names this exact event
    // (`resolve-medicare-primary`) — the COB precondition for billing Medicaid secondary once Medicare
    // paid primary — with a real handler (`handleMedicarePrimaryAck`) in `consumers/handlers.ts`.
    // F-144 (#248) — m22 REMOVED: redundant sibling — `document-render.ts`'s
    // `buildClaimAcknowledgmentLetterRequest` fires off the same ACK_ACCEPTED transition via the
    // dedicated `m23.billing.document_render_requested` event (M23's own §4.10 table names that event,
    // not this one, as the M22 trigger).
    declaredConsumers: ["m24"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.acknowledgment_partial",
    moduleOwner: "m23",
    description:
      "The 277CA partially accepted the claim; ACK_PENDING → ACK_PARTIAL with per-line accept/reject sets.",
    payloadSchema: Type.Object({
      claimId: id,
      acknowledgmentId: id,
      acceptedLineNumbers: Type.Array(int),
      rejectedLineNumbers: Type.Array(int),
      rejectionCodes: Type.Array(str),
    }),
    // F-135 (#248) — m25 REMOVED: M25's real subscription-map has no key for a PARTIAL ack — only the
    // full `m23.claim.rejected` topic seeds a denial worklist row before an 835 lands.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.rejected",
    moduleOwner: "m23",
    description:
      "A 999 syntax fail or 277CA reject; the claim transitioned to ACK_REJECTED with the rejection stage + codes.",
    payloadSchema: Type.Object({
      claimId: id,
      acknowledgmentId: id,
      rejectionStage: str,
      rejectionCodes: Type.Array(str),
    }),
    // F-144 (#248) — m22 REMOVED: redundant sibling — `document-render.ts`'s
    // `buildDenialAppealCoverLetterRequest` fires off this exact transition (its payload
    // `{claimId, claimControlNumber, rejectionStage, rejectionCodes}` matches only this event's fields)
    // via the dedicated `m23.billing.document_render_requested` event, per M23's own §4.10 table.
    declaredConsumers: ["m25"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.paid",
    moduleOwner: "m23",
    description:
      "M25 posted the 835 with full payment; ACK_ACCEPTED → PAID with the paid amount (cents).",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceAdviceId: id,
      paidAmountCents: cents,
      paidAt: isoInstant,
    }),
    // F-130 (#248) — m27 REMOVED: M27's own §1.1 dependency line names M23's `PatientDaysProvider`/
    // `ClaimSettlementProvider` as forward-seam-deny-stub PULLS ("the billed and accepted census … M23's
    // seams are forward-seam-deny-stubs at M27 lock and wire to live at M23 lock") — never an outbox
    // subscription to individual claim-lifecycle events.
    // F-131 (#248) — m26 REMOVED: M26's own dependency text is explicit that "M25 is the authoritative
    // paid-amount source — every cent in a cap accrual line traces to an 835-derived remittance line", and
    // its subscription-map keys `record-accrual-line` on `m25.remittance.advice_posted` alone, never on
    // this claim-side milestone.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.denied",
    moduleOwner: "m23",
    description: "M25 posted a denial 835; ACK_ACCEPTED → DENIED with the denial codes.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceAdviceId: id,
      denialCodes: Type.Array(str),
    }),
    // F-135 (#248) — m25 REMOVED: this event is M25's OWN OUTPUT reused — `ACK_ACCEPTED → DENIED` fires
    // only after M25 posts a denial 835 (per the description above), so M25 is the producer here, not a
    // consumer of its own downstream effect.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.adjudicated",
    moduleOwner: "m23",
    description:
      "The claim reached a terminal adjudication outcome (the single 'adjudication complete' signal for measure recompute).",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      outcome: Type.Union([
        Type.Literal("paid"),
        Type.Literal("partial_paid"),
        Type.Literal("denied"),
      ]),
      remittanceAdviceId: id,
      adjudicatedAt: isoInstant,
    }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.line_finalized",
    moduleOwner: "m23",
    description:
      "A claim_line reached a final adjudicated state (per posted remittance line) — day-level accrual signal.",
    payloadSchema: Type.Object({
      claimId: id,
      claimLineId: id,
      revenueCode: str,
      // GAP-077 — the facts M26's inpatient 20% cap accrual (`handleInpatientDay`) reads. M23 emits this
      // for each 0655/0656 claim_line when the 835 pays the claim; the tenant is the envelope's, never a
      // payload field. `serviceFrom`/`serviceTo` are the line's own service dates (ISO dates).
      patientId: id,
      serviceFrom: str,
      serviceTo: str,
      serviceDate: isoInstant,
      days: int,
      finalizedAt: isoInstant,
    }),
    declaredConsumers: ["m26"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.replaced",
    moduleOwner: "m23",
    description:
      "A TOB 817 replacement was accepted at 277CA; the original claim transitioned ACK_ACCEPTED → REPLACED.",
    payloadSchema: Type.Object({ originalClaimId: id, replacementClaimId: id, reason: str }),
    // F-130 (#248) — m27 REMOVED: same reasoning as `m23.claim.paid` above.
    declaredConsumers: ["m26"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.voided",
    moduleOwner: "m23",
    description:
      "A TOB 818 void was accepted at 277CA; the original claim transitioned ACK_ACCEPTED → VOIDED.",
    payloadSchema: Type.Object({ originalClaimId: id, voidClaimId: id, reason: str }),
    // F-130 (#248) — m27 REMOVED: same reasoning as `m23.claim.paid` above.
    declaredConsumers: ["m26"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.override_applied",
    moduleOwner: "m23",
    description:
      "A validation_override was inserted against a failing result (audit-prominent; surveyor-mode reflected).",
    payloadSchema: Type.Object({
      claimId: id,
      validationRunId: id,
      resultId: id,
      overrideId: id,
      ruleKey: str,
      overrideRoleApplied: str,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m4"],
    isOutboxOnly: true,
  },
  // ── NOE lifecycle (§3.x / §4.10) ──────────────────────────────────────────────────────────────────
  {
    eventName: "m23.noe.draft_created",
    moduleOwner: "m23",
    description:
      "A NOE draft was created from m6.election.signed; the 5-day filing window target was computed.",
    payloadSchema: Type.Object({
      noeId: id,
      providerEntityId: id,
      admissionId: id,
      electionEffectiveDate: isoInstant,
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.submit_requested",
    moduleOwner: "m23",
    description:
      "A NOE became READY; the same-transaction outbox emit that drives the noe.submit worker.",
    payloadSchema: Type.Object({ noeId: id, submissionId: id, noeControlNumber: str }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.submitted",
    moduleOwner: "m23",
    description: "The noe.submit worker uploaded the NOE to the MAC portal; READY → SUBMITTED.",
    payloadSchema: Type.Object({ noeId: id, submissionId: id, submittedAt: isoInstant }),
    // F-144 (#248) — m22 REMOVED: redundant sibling — `document-render.ts`'s
    // `buildNoeConfirmationReceiptRequest` fires off this exact transition via the dedicated
    // `m23.billing.document_render_requested` event, per M23's own §4.10 table.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.accepted",
    moduleOwner: "m23",
    // F-155 (#248) — `m6` REMOVED (was misdeclared): no `compliance_window_kind` value, table, or
    // column anywhere in M6's schema references NOE/NOTR (`notice_of_rights` is the unrelated CoP
    // Notice of Rights document), M6's `dependsOn` excludes 23 so it has no seam to resolve which
    // admission's window to touch even if one existed, and "closing the window" is already a side
    // effect of THIS transition on the M23 side alone — `NoeRepository.listWindowWatchCandidates`
    // filters `notInArray(N.state, NOE_TERMINAL_DB)`, so an `ACK_ACCEPTED` row self-excludes from
    // every future watchdog scan with no cross-module handshake needed.
    description:
      "The 277CA accepted the NOE; ACK_PENDING → ACK_ACCEPTED. `acceptedAt` is the acceptance date recorded on the NOE.",
    payloadSchema: Type.Object({
      noeId: id,
      acknowledgmentId: id,
      payerNoeControlNumber: str,
      acceptedAt: isoInstant,
      payerStatusDate: isoInstant,
      payerStatusDateSource,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.rejected",
    moduleOwner: "m23",
    description:
      "The 999 or 277CA rejected the NOE; → ACK_REJECTED. The PHI-free reason codes are attached for remediation; the worker raises the biller alert of the same name.",
    payloadSchema: Type.Object({
      noeId: id,
      acknowledgmentId: id,
      rejectionStage: Type.Union([Type.Literal("999"), Type.Literal("277ca")]),
      rejectionCodes: Type.Array(str),
      rejectedAt: isoInstant,
      payerStatusDate: isoInstant,
      payerStatusDateSource,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.correction_created",
    moduleOwner: "m23",
    description:
      "A biller filed a corrected NOE after Medicare rejected one (ch. 11 §20.1.1; M23 §2.2 'corrected NOE is its own row'): the new DRAFT `noeId` copies the rejected `correctsNoeId`, with its notice date possibly corrected (`dateCorrected`). The biller's reason stays on the row, never in this payload.",
    payloadSchema: Type.Object({
      noeId: id,
      correctsNoeId: id,
      admissionId: id,
      rejectionStage: Type.Union([Type.Literal("999"), Type.Literal("277ca"), Type.Null()]),
      dateCorrected: Type.Boolean(),
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.window_warning",
    moduleOwner: "m23",
    description:
      "The day-3 NOE-window watchdog tick fired (the 5-day CMS filing window is at risk).",
    payloadSchema: Type.Object({ noeId: id, admissionId: id, daysIntoWindow: int }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.window_breached",
    moduleOwner: "m23",
    description: "The day-5+1 NOE-window watchdog tick fired (the CMS filing window was breached).",
    payloadSchema: Type.Object({ noeId: id, admissionId: id, breachedAt: isoInstant }),
    // F-180 (#248) — m30 DROPPED: misdeclared, not a genuine gap. M30's own locked spec never names NOE,
    // NOTR, or window_breached anywhere (its `risk_register_view` source union is `sra_finding`/
    // `incident_report`/`qapi_project`/`cop_compliance_status` only). The breach fact this event announces
    // is already fully served without any M30 involvement: `noe_record.windowBreachedAt` is a real,
    // persisted column (`packages/db/src/schema/billing/noe-record.ts`), returned directly by
    // `GET /api/v1/noe-records` (a frontend REST read, the same F-179 shape), alerted on by M36's critical
    // severity binding (M23 spec §5), and dashboarded live via M33's bound
    // `mv_noe_window_breach_org_month` materialized view (`outbox-subscription-map.ts`) — three real
    // consumers, none of them M30.
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── NOTR lifecycle (§4.10 "mirror of NOE", expanded to the 7 concrete events) ──────────────────────
  {
    eventName: "m23.notr.draft_created",
    moduleOwner: "m23",
    description:
      "A NOTR draft was created from a discharge/revocation; the filing window target was computed.",
    payloadSchema: Type.Object({
      notrId: id,
      providerEntityId: id,
      admissionId: id,
      terminationEffectiveDate: isoInstant,
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.submit_requested",
    moduleOwner: "m23",
    description:
      "A NOTR became READY; the same-transaction outbox emit that drives the notr.submit worker.",
    payloadSchema: Type.Object({ notrId: id, submissionId: id, notrControlNumber: str }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.submitted",
    moduleOwner: "m23",
    description: "The notr.submit worker uploaded the NOTR to the MAC portal; READY → SUBMITTED.",
    payloadSchema: Type.Object({ notrId: id, submissionId: id, submittedAt: isoInstant }),
    // F-144 (#248) — m22 REMOVED: redundant sibling — `document-render.ts`'s
    // `buildNotrConfirmationReceiptRequest` fires off this exact transition via the dedicated
    // `m23.billing.document_render_requested` event, per M23's own §4.10 table.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.accepted",
    moduleOwner: "m23",
    // F-155 (#248) — `m6` REMOVED, the identical finding one event up (`m23.noe.accepted`): no M6
    // mechanism, table, or seam exists to close a "NOTR compliance window," M6 cannot reach M23
    // (`dependsOn` excludes 23), and the watchdog's own terminal-state exclusion already retires the
    // row on the M23 side alone.
    description:
      "The 277CA accepted the NOTR; ACK_PENDING → ACK_ACCEPTED. `acceptedAt` is the acceptance date recorded on the NOTR.",
    payloadSchema: Type.Object({
      notrId: id,
      acknowledgmentId: id,
      payerNotrControlNumber: str,
      acceptedAt: isoInstant,
      payerStatusDate: isoInstant,
      payerStatusDateSource,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.rejected",
    moduleOwner: "m23",
    description:
      "The 999 or 277CA rejected the NOTR; → ACK_REJECTED (it no longer closes the election). The PHI-free reason codes are attached; the worker raises the biller alert of the same name.",
    payloadSchema: Type.Object({
      notrId: id,
      acknowledgmentId: id,
      rejectionStage: Type.Union([Type.Literal("999"), Type.Literal("277ca")]),
      rejectionCodes: Type.Array(str),
      rejectedAt: isoInstant,
      payerStatusDate: isoInstant,
      payerStatusDateSource,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.correction_created",
    moduleOwner: "m23",
    description:
      "A biller filed a corrected NOTR after Medicare rejected one (ch. 11 §20.1.2; M23 §2.2 'corrected NOTR is its own row'): the new DRAFT `notrId` copies the rejected `correctsNotrId`, with its notice date possibly corrected (`dateCorrected`). The biller's reason stays on the row, never in this payload.",
    payloadSchema: Type.Object({
      notrId: id,
      correctsNotrId: id,
      admissionId: id,
      rejectionStage: Type.Union([Type.Literal("999"), Type.Literal("277ca"), Type.Null()]),
      dateCorrected: Type.Boolean(),
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.window_warning",
    moduleOwner: "m23",
    description: "The day-3 NOTR-window watchdog tick fired (the filing window is at risk).",
    payloadSchema: Type.Object({ notrId: id, admissionId: id, daysIntoWindow: int }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.window_breached",
    moduleOwner: "m23",
    description: "The day-5+1 NOTR-window watchdog tick fired (the filing window was breached).",
    payloadSchema: Type.Object({ notrId: id, admissionId: id, breachedAt: isoInstant }),
    // F-180 (#248) — m30 DROPPED: same reasoning as the `m23.noe.window_breached` sibling above — no M30
    // spec support, and the fact is already served by `notr_record.windowBreachedAt` (REST-read via
    // `GET /api/v1/notr-records`) + M36 alerting. NOTE: unlike its NOE sibling, this event is NOT yet
    // actually bound in M33's `outbox-subscription-map.ts` despite carrying `seamConsumers: ["m33"]` here
    // — a real M33-side asymmetry, out of scope for this pass, reported not fixed.
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── transfer notice (TOB 8xC / corrected 8xC / 8xD void) — CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4 ────
  // The receiving hospice's notice of a change of hospice. No 5-day window (CGS CR 8877 FAQ: 8XC transactions
  // are not subject to the 5-day timely filing requirement), so there are no window_* events; the hold is the
  // staff confirmation that the transferring hospice finalized its billing (`transfer_notice_record`).
  {
    eventName: "m23.transfer_notice.draft_created",
    moduleOwner: "m23",
    description:
      "A transfer notice (8xC original, 8xC correction or 8xD void) was drafted for a transfer-in.",
    payloadSchema: Type.Object({
      transferNoticeId: id,
      providerEntityId: id,
      admissionId: id,
      transferEventId: id,
      action: Type.Union([
        Type.Literal("original"),
        Type.Literal("correction"),
        Type.Literal("void"),
      ]),
      tob: str,
      statementFromDate: isoInstant,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.transfer_notice.submit_requested",
    moduleOwner: "m23",
    description:
      "A transfer notice became READY and was submitted by staff; the same-transaction emit that drives the transfer-notice.submit worker.",
    payloadSchema: Type.Object({ transferNoticeId: id, submissionId: id, controlNumber: str }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.transfer_notice.submitted",
    moduleOwner: "m23",
    description: "The worker uploaded the transfer notice to the MAC; READY → SUBMITTED.",
    payloadSchema: Type.Object({ transferNoticeId: id, submissionId: id, submittedAt: isoInstant }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.transfer_notice.accepted",
    moduleOwner: "m23",
    description: "Medicare accepted the transfer notice (277CA); ACK_PENDING → ACK_ACCEPTED.",
    payloadSchema: Type.Object({
      transferNoticeId: id,
      acknowledgmentId: id,
      payerControlNumber: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.transfer_notice.rejected",
    moduleOwner: "m23",
    description:
      "The transfer notice was rejected (999 or 277CA); the rejection codes are attached.",
    payloadSchema: Type.Object({ transferNoticeId: id, rejectionCodes: Type.Array(str) }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── eligibility (§4.8 / §4.10) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m23.eligibility.refresh_requested",
    moduleOwner: "m23",
    description:
      "A HETS 270/271 refresh was requested (route 22 or stale-at-assembly); drives the eligibility.refresh worker.",
    payloadSchema: Type.Object({
      patientId: id,
      providerEntityId: id,
      asOfServiceDate: isoInstant,
    }),
    // GAP-070: m23 consumes its own request (the outbox bridge that creates the eligibility.refresh job).
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.eligibility.checked",
    moduleOwner: "m23",
    description:
      "An eligibility_check row was inserted (MBI never persisted); the outcome + staleAt are attached.",
    payloadSchema: Type.Object({
      checkId: id,
      patientId: id,
      asOfServiceDate: isoInstant,
      outcome: str,
      checkedAt: isoInstant,
      staleAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.eligibility.expired",
    moduleOwner: "m23",
    description:
      "The stale-watch cron marked an eligibility_check past its staleAt; the re-check prompt is raised.",
    payloadSchema: Type.Object({ patientId: id, lastCheckedAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── MAC credential + portal health (§4.8 / §4.10) ─────────────────────────────────────────────────
  {
    eventName: "m23.mac_credential.updated",
    moduleOwner: "m23",
    description:
      "A per-PE mac_submitter_credential was upserted (secrets never emitted); the version is bumped.",
    payloadSchema: Type.Object({ providerEntityId: id, macJurisdiction: str, version: int }),
    // F-132 (#248) — m34 REMOVED: M23's own description calls this "M34 (wizard completion signal)", but
    // M34's own onboarding spec names the actual `ccn_registered → mac_configured` mechanism as a seam
    // pull (M29's `ExternalFeedReader`, "Phase 1 uses platform-ops attestation") evaluated on-demand at
    // advance-attempt time by `precondition_dsl`, never a reactive listener on this event; the advance
    // worker's only trigger is M34's OWN `m34.onboarding.task_completed` event. M34's own spec never
    // names M23 in its "Depends on"/"Consumed by" header at all.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.mac_portal.unavailable",
    moduleOwner: "m23",
    description:
      "The health cron observed a MAC portal transition to down; a Tier-3 system-status event is raised.",
    payloadSchema: Type.Object({
      macJurisdiction: str,
      lastSeenUpAt: nullableInstant,
      downedAt: isoInstant,
    }),
    declaredConsumers: ["m1"],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.mac_portal.recovered",
    moduleOwner: "m23",
    description:
      "The health cron observed a MAC portal transition back up; the system-status event clears.",
    payloadSchema: Type.Object({
      macJurisdiction: str,
      downedAt: isoInstant,
      recoveredAt: isoInstant,
    }),
    declaredConsumers: ["m1"],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── M22 render handshake + ABN (§4.10) ────────────────────────────────────────────────────────────
  {
    eventName: "m23.billing.document_render_requested",
    moduleOwner: "m23",
    description:
      "An M22 PDF render+store was requested at NOE/NOTR submit or claim ack — typed per document kind.",
    payloadSchema: Type.Object({
      kind: Type.Union([
        Type.Literal("noe_confirmation_receipt"),
        Type.Literal("notr_confirmation_receipt"),
        Type.Literal("claim_acknowledgment_letter"),
        Type.Literal("denial_appeal_cover_letter"),
      ]),
      aggregateId: id,
      payload: Type.Record(Type.String(), Type.Unknown()),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.abn.required",
    moduleOwner: "m23",
    description:
      "A coverage determination resolved a service line as non-covered; the CMS-R-131 ABN render is requested.",
    payloadSchema: Type.Object({
      abnId: id,
      patientId: id,
      organizationId: id,
      claimId: nullableId,
      serviceDescription: str,
      estimatedCost: cents,
      reasonNoncovered: str,
      requiredBy: isoInstant,
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
