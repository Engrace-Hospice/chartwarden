// apps/backend/src/modules/13-emar/events-by-m13.ts — Module 13's outbox-event contributions
// (M13-T08, spec §4.4). The full `m13.*` taxonomy keyed on M13's own tables, under the `m13.` namespace
// (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for naming
// (`mN.<resource>.<verb>`), ownership (moduleOwner='m13'), and valid declared consumers (real module ids).
// The canonical wire `eventName` mirrors `M13_EVENT_NAMES` in @wardenx/types (the closed §4.4 set the
// administration write path / PRN trigger / missed-dose sweep / reconciliation workflow / comfort-kit drawdown
// / discharge cascade / policy admin may emit). Each entry adds the TypeBox `payloadSchema` + declared
// consumers the dispatcher validates each publish against, so "DB updated but the event never went out" is
// closed in the same transaction as the mutation (M1 §25.5/§25.6).
//
// Phase-1 boundary (§0): the events whose declared consumers are future-wave modules (M21 supplies — Wave F;
// M22 PDF render; M28 FHIR projection; M14 IDG; M30 HQRP — later) are PUBLISHED now by M13 — the producer side
// ships, the consumer attaches when that module lands. M13 never calls those modules' routes; it only emits
// the typed outbox event (§1.1: "Outbox publication is the only cross-module communication M13 performs").
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { ModuleEventContribution, ModuleToken } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const mode = Type.Union([
  Type.Literal("single_dose"),
  Type.Literal("iv_continuous_start"),
  Type.Literal("iv_continuous_rate_change"),
  Type.Literal("iv_continuous_pause"),
  Type.Literal("iv_continuous_resume"),
  Type.Literal("iv_continuous_stop"),
]);

// The §4.4 wire names mirror `M13_EVENT_NAMES` (@wardenx/types) EXACTLY — several merge resource+verb into a
// single token (`m13.prn_administration_recorded`) rather than the stricter two-dot `OutboxEventName` template.
// They satisfy check-fitness-gaps' `mN.<...>` scan; `eventName` is relaxed to `string` here (every other field
// stays fully type-checked) and cast once to `ModuleEventContribution`.
interface M13OutboxEntry {
  readonly eventName: string;
  readonly moduleOwner: ModuleToken;
  readonly description: string;
  readonly payloadSchema: TSchema;
  readonly declaredConsumers: readonly ModuleToken[];
  readonly seamConsumers?: readonly ModuleToken[];
  readonly isOutboxOnly: boolean;
}

const M13_OUTBOX_ENTRIES: readonly M13OutboxEntry[] = [
  // ── administration lifecycle (§2.2 / §4.4) ──────────────────────────────────────────────────────────────
  {
    eventName: "m13.administration.recorded",
    moduleOwner: "m13",
    description:
      "`record-administration` committed a clinician administration (single_dose or IV continuous); the broad eMAR/FHIR/portal/HQRP fan-out.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      patientId: id,
      admissionId: id,
      medicationOrderId: id,
      mode,
      administeredAt: isoInstant,
      isControlled: Type.Boolean(),
      isComfortKitDrawdown: Type.Boolean(),
      encounterId: Type.Union([id, Type.Null()]),
      scheduledDoseId: Type.Union([id, Type.Null()]),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-139 (#248) — m31 removed: M31's own §4.10 "M31 consumes" table names no M13 event — the
    // lay-language administration history is a seam PULL (`MedicationAdministrationProvider.
    // getPortalAdministrationSummary`, §4.4 "Depends on" item 13), never a push subscription.
    // F-145 (#248) — m14 moved to seamConsumers: M13's own D16 publishes `MedicationAdministrationProvider`
    // with M14 as a named read-path consumer, and M14's own exhaustive "Done means" build walkthrough
    // (the eleven seam reads + four Valkey-projected outbox topics) never names any M13 event —
    // confirmed the seam-vs-push trap, the identical F-129 shape already found for M7/M9/M10.
    // F-149 (#248) — m30 REMOVED: M30's own §1.1 relationship inventory states flatly "Outbox
    // publication is the only cross-module communication M30 performs at the boundary" — it never
    // subscribes to any upstream outbox event, only calls seams. M30's own live measures for this
    // domain (`missedDoseCountsForOrg`/`prnReassessmentObligationsForOrg`) scan `scheduled_dose`/
    // PRN-specific rows, not the general administration-recorded stream, so there is no seam this
    // event's fact correlates to either — genuinely unsupported on both sides, dropped clean (all 12
    // M13 `administration`/`caregiver_administration`/`comfort_kit`/`policy`/`reconciliation` events
    // checked this pass share this same finding — `M30_OUTBOX_SUBSCRIPTIONS`,
    // `packages/quality/src/consumers/subscription-map.ts`, has exactly six keys and none is `m13.*`).
    declaredConsumers: [],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.administration.controlled_witnessed",
    moduleOwner: "m13",
    description:
      "The controlled-substance commit captured the second-clinician witness on the `administration_witness` row.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      witnessMembershipId: id,
      witnessesScope: id,
      deaSchedule: Type.Optional(id),
    }),
    // F-149 (#248) — m30 removed: same basis as `administration.recorded` above.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.administration.controlled_wasted",
    moduleOwner: "m13",
    description:
      "A partial-dose draw-down destroyed the remainder; the wastage carries its own witness.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      wastageAmount: Type.Number(),
      wastageUnit: id,
      witnessMembershipId: id,
    }),
    // F-149 (#248) — m30 removed: same basis as `administration.recorded` above.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.administration.refused",
    moduleOwner: "m13",
    description: "The refusal path recorded a patient-declined dose (no medication given).",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      patientId: id,
      medicationOrderId: id,
      refusalAt: isoInstant,
    }),
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `administration.recorded` above.
    // F-149 (#248) — m30 removed: same basis as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.administration.corrected",
    moduleOwner: "m13",
    description: "`correct-administration` created a new row that supersedes the original.",
    payloadSchema: Type.Object({
      originalAdministrationId: id,
      newAdministrationId: id,
      reason: Type.String(),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-149 (#248) — m30 removed: same basis as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.administration.voided",
    moduleOwner: "m13",
    description:
      "`void-administration` hard-voided a row recorded in error (step-up); M36 high-severity alert.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      voidReason: Type.String(),
      voidedBy: id,
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-149 (#248) — m30 removed: same basis as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.administration.recorded_caregiver_attested",
    moduleOwner: "m13",
    description:
      "`record-caregiver-attested` logged a caregiver-given dose (`requiresRnReview=true`); M36 queues the case-manager cosign alert.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      patientId: id,
      medicationOrderId: id,
      caregiverSessionId: id,
      requiresRnReview: Type.Boolean(),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m14", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.caregiver_administration.acknowledged",
    moduleOwner: "m13",
    description:
      "`acknowledge-caregiver` — the RN case manager confirmed a caregiver-attested row.",
    payloadSchema: Type.Object({ administrationRecordId: id, acknowledgedBy: id }),
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.caregiver_administration.disputed",
    moduleOwner: "m13",
    description:
      "`dispute-caregiver` — the RN case manager disputed a caregiver-attested row; M36 high-severity.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      disputedBy: id,
      disputeReason: Type.String(),
    }),
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `administration.recorded` above.
    // F-149 (#248) — m30 removed: same basis as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m14", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.prn_administration_recorded",
    moduleOwner: "m13",
    description:
      "The PRN path committed a PRN administration; M9 owns the reassessment scale (D3, `reassessmentDueAt`).",
    payloadSchema: Type.Object({
      prnAdministrationId: id,
      administrationRecordId: id,
      patientId: id,
      medicationOrderId: id,
      administeredAt: isoInstant,
      reassessmentDueAt: isoInstant,
      recommendedReassessmentScale: id,
    }),
    // F-115 (#248) — m30 moved to seamConsumers: reads PRN-effectiveness data via
    // `MedicationAdministrationProvider.getPrnEffectivenessCountsForOrg` on its nightly cadence.
    // F-143 (#248) — m9 REMOVED: no support anywhere in M9's own spec — M13/PRN is never named in
    // M9's "Depends on"/"Consumed by" relationship inventory or its §2.4 outbox table, and
    // `09-assessments/` has no `consumers/` directory at all.
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `administration.recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  // ── scheduled-dose pipeline (§2.3 / §2.5 / §4.4) ────────────────────────────────────────────────────────
  {
    eventName: "m13.scheduled_dose.materialized",
    moduleOwner: "m13",
    description:
      "`materialize-schedule` inserted scheduled-dose rows seven days ahead (worker pickup signal).",
    payloadSchema: Type.Object({
      scheduledDoseIds: Type.Array(Type.String()),
      medicationOrderId: id,
      materializationWindowDays: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.scheduled_dose.missed",
    moduleOwner: "m13",
    description:
      "The 15-minute missed-dose sweep found a scheduled dose past its grace window with no administration; M36 typed alert.",
    payloadSchema: Type.Object({
      scheduledDoseId: id,
      missedDoseId: id,
      patientId: id,
      medicationOrderId: id,
      dueAt: isoInstant,
      isControlled: Type.Boolean(),
      isComfortKitMedication: Type.Boolean(),
    }),
    // F-115 (#248) — m30 moved to seamConsumers: reads `getMissedDoseCountsForOrg` (missed_dose_rate) on
    // its nightly cadence, not by reacting to this event.
    // F-145 (#248) — m14 moved to seamConsumers: reversing this group's own prior "strongest candidate
    // to keep" framing — M13's own D16 seam-publication text is decisive that M14 reads
    // `MedicationAdministrationProvider`'s "missed-dose count since last IDG" via the SAME aggregation
    // seam, not a per-event push; M14's own exhaustive build-description names no M13 event either.
    declaredConsumers: [],
    seamConsumers: ["m14", "m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.scheduled_dose.cancelled",
    moduleOwner: "m13",
    description:
      "`cancel-future-schedule` cancelled a future scheduled dose (order discontinued / admission discharged).",
    payloadSchema: Type.Object({
      scheduledDoseId: id,
      medicationOrderId: id,
      cancellationReason: id,
      sourceEventId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.scheduled_dose.intentionally_held",
    moduleOwner: "m13",
    description:
      "The intentional-hold route recorded a clinician-held dose before the grace window expired.",
    payloadSchema: Type.Object({
      scheduledDoseId: id,
      recordedBy: id,
      missedKind: Type.Literal("intentionally_held"),
    }),
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `scheduled_dose.missed` above.
    declaredConsumers: [],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.missed_dose.acknowledged",
    moduleOwner: "m13",
    description: "`acknowledge-missed-dose` — the case manager acknowledged a missed dose.",
    payloadSchema: Type.Object({ missedDoseId: id, acknowledgedBy: id }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.missed_dose.reverted",
    moduleOwner: "m13",
    description:
      "A late administration / offline-sync arrived for a row the sweep had already marked missed; M36 suppresses the alert.",
    payloadSchema: Type.Object({
      missedDoseId: id,
      administrationRecordId: id,
      revertReason: Type.String(),
    }),
    // F-145 (#248) — m14 moved to seamConsumers: no retraction/supersede handling exists anywhere in
    // M14's builder for flagged events (nothing populates the field to retract in the first place) —
    // moot until `missed_dose` itself is built, and would use the same seam-pull mechanism then too.
    declaredConsumers: [],
    seamConsumers: ["m14", "m36"],
    isOutboxOnly: true,
  },
  // ── reconciliation workflow (§2.8 / §4.4) ───────────────────────────────────────────────────────────────
  {
    eventName: "m13.reconciliation.opened",
    moduleOwner: "m13",
    description:
      "A reconciliation trigger opened a worksheet (admission / transfer_in / discharge / recertification).",
    payloadSchema: Type.Object({
      worksheetId: id,
      patientId: id,
      admissionId: id,
      triggerKind: id,
      dueAt: isoInstant,
    }),
    // F-145 (#248) — m14 moved to seamConsumers: M13's own D16 names `ReconciliationProvider`'s
    // read-path consumers as M14/M30 — M14's own spec never mentions "reconciliation" anywhere.
    declaredConsumers: [],
    seamConsumers: ["m14", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.due_at_warning",
    moduleOwner: "m13",
    description: "The `reconciliation-due-warning` cron crossed the 24h-remaining threshold.",
    payloadSchema: Type.Object({
      worksheetId: id,
      dueAt: isoInstant,
      hoursRemaining: Type.Number(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.overdue",
    moduleOwner: "m13",
    description:
      "The `reconciliation-due-warning` cron found an overdue worksheet; M36 high-severity, M30 survey log.",
    payloadSchema: Type.Object({ worksheetId: id, dueAt: isoInstant, overdueHours: Type.Number() }),
    // F-149 (#248) — m30 removed: no support anywhere (see `administration.recorded` above for the
    // governing finding this pass established for all twelve M13 events checked).
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.draft_order_requested",
    moduleOwner: "m13",
    description:
      "A `carry_forward` / `new_order` decision asked M12 to mint a draft medication order.",
    payloadSchema: Type.Object({
      worksheetId: id,
      decisionId: id,
      medicationOrderDraftPayload: Type.Unknown(),
      derivedFromHistoryId: Type.Optional(Type.Union([id, Type.Null()])),
      lineKind: id,
    }),
    declaredConsumers: ["m12"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.discontinue_requested",
    moduleOwner: "m13",
    description: "A `discontinue` decision asked M12 to discontinue an active medication order.",
    payloadSchema: Type.Object({
      worksheetId: id,
      decisionId: id,
      medicationOrderId: id,
      reason: Type.Literal("reconciled_discontinue"),
    }),
    declaredConsumers: ["m12"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.completed",
    moduleOwner: "m13",
    description:
      "`finalize-reconciliation` finalized the worksheet (every line decided); the same transaction " +
      "also emits `m13.reconciliation.document_requested`, the actual live-bound M22 render request.",
    payloadSchema: Type.Object({
      worksheetId: id,
      triggerKind: id,
      patientId: id,
      admissionId: id,
      finalizedAt: isoInstant,
      finalizedBy: id,
      lineSummary: Type.Unknown(),
    }),
    // F-117 (#248) — m22 removed: redundant with `document_requested`, emitted alongside this
    // event in the same transaction (emar-route-service-db.ts).
    // F-145 (#248) — m14 moved to seamConsumers: same `ReconciliationProvider` D16 shape as
    // `reconciliation.opened` above.
    // F-149 (#248) — m30 removed: no support anywhere; not on `M30_OUTBOX_SUBSCRIPTIONS` and M13's own
    // spec claim ("M30 computes the reconciliation-completed-in-time measure") describes a measure that
    // does not exist anywhere in M30's registered measure set.
    declaredConsumers: [],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.voided",
    moduleOwner: "m13",
    description:
      "`void-reconciliation` voided a worksheet (e.g., re-triggered by a transfer-correction).",
    payloadSchema: Type.Object({ worksheetId: id, voidReason: Type.String() }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── comfort-kit deployment + drawdown (§2.7 / §4.4) ─────────────────────────────────────────────────────
  {
    eventName: "m13.comfort_kit.deployed",
    moduleOwner: "m13",
    description:
      "The `m21.comfort_kit.deployed_at_patient` consumer created a deployment + per-medication drawdown rows.",
    payloadSchema: Type.Object({
      deploymentId: id,
      patientId: id,
      admissionId: id,
      contents: Type.Unknown(),
    }),
    // F-094/#205 — `m21` was absent while `consumers/m13-comfort-kit.ts` has decided on this topic
    // since M21-T04 and `M21_SUBSCRIBED_EVENT_NAMES` has named it since M21-T01. The relay routed a kit
    // deployment past the only module that stocks one.
    // F-145 (#248) — m14 moved to seamConsumers: same shape as `administration.recorded` above.
    declaredConsumers: ["m21"],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.comfort_kit.replenishment_needed",
    moduleOwner: "m13",
    description:
      "A drawdown decrement crossed the replenishment threshold; M21 (forward seam) consumes the supply request.",
    payloadSchema: Type.Object({
      deploymentId: id,
      medicationOrderId: id,
      drugName: id,
      remainingQuantity: Type.Number(),
      requestedQuantity: Type.Number(),
      urgencyKind: id,
    }),
    declaredConsumers: ["m21"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.comfort_kit.return_required",
    moduleOwner: "m13",
    description:
      "The admission-discharge cascade flagged an active deployment for return; M21 (forward seam) + M36.",
    payloadSchema: Type.Object({
      deploymentId: id,
      patientId: id,
      admissionId: id,
      returnRequiredAt: isoInstant,
    }),
    declaredConsumers: ["m21"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.comfort_kit.returned",
    moduleOwner: "m13",
    description:
      "The `m21.comfort_kit.returned` consumer reconciled the returned kit's remaining quantities.",
    payloadSchema: Type.Object({
      deploymentId: id,
      returnedAt: isoInstant,
      finalRemainingByMedication: Type.Unknown(),
      disposalReconciliationStatus: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.comfort_kit.return_overdue",
    moduleOwner: "m13",
    description:
      "The nightly `kit-return-overdue` cron found a deployment not returned within the window.",
    payloadSchema: Type.Object({ deploymentId: id, daysOverdue: Type.Integer({ minimum: 0 }) }),
    // F-149 (#248) — m30 removed: no support anywhere (see `administration.recorded` above).
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.comfort_kit.controlled_substance_discrepancy",
    moduleOwner: "m13",
    description:
      "Return reconciliation found a ≥5% controlled-substance delta; M36 high-severity + compliance log.",
    payloadSchema: Type.Object({
      deploymentId: id,
      medicationOrderId: id,
      deltaQuantity: Type.Number(),
      deltaPercent: Type.Number(),
    }),
    // F-094/#205 — same as `comfort_kit.deployed`: M21 owns the CII discrepancy's supply-side
    // reconciliation (`consumers/m13-comfort-kit.ts`) and was declared nowhere.
    // F-149 (#248) — m30 removed: the only real M30 controlled-substance-discrepancy path is
    // `m12.medication.error_reported` (`M30_OUTBOX_SUBSCRIPTIONS`); no M13-sourced incident_draft
    // mechanism exists, and this event's own "compliance log" phrasing is unsupported anywhere in
    // M30's spec or code.
    declaredConsumers: ["m21"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── document render + policy (§4.4) ─────────────────────────────────────────────────────────────────────
  {
    eventName: "m13.administration_record.document_requested",
    moduleOwner: "m13",
    description:
      "A tenant-policy-enabled commit asked M22 to render the eMAR administration-record PDF.",
    payloadSchema: Type.Object({
      administrationRecordId: id,
      formTemplate: Type.Literal("administration_record_v1"),
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.reconciliation.document_requested",
    moduleOwner: "m13",
    description: "`finalize-reconciliation` asked M22 to render the reconciliation-worksheet PDF.",
    payloadSchema: Type.Object({
      worksheetId: id,
      formTemplate: Type.Literal("reconciliation_worksheet_v1"),
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m13.policy.changed",
    moduleOwner: "m13",
    description:
      "`admin-policy-update` changed the tenant administration policy; M33 + M30 survey log.",
    payloadSchema: Type.Object({ policyDeltaSummary: Type.Unknown() }),
    // F-149 (#248) — m30 removed: "M30 survey log" is unsupported anywhere in M30's spec/code; M30's
    // own closest real surface (`cop_compliance_status`) is populated manually by the Compliance
    // Officer (D10), not event-driven.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];

/** Module 13's §4.4 outbox-event catalog contribution (the boot UPSERTs each into `outbox_event_catalog`). */
export const M13_OUTBOX_EVENTS: ModuleEventContribution =
  M13_OUTBOX_ENTRIES as unknown as ModuleEventContribution;
