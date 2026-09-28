// apps/backend/src/modules/26-cap/events-by-m26.ts — Module 26's outbox-event contributions (spec §4.10).
// The `m26.cap.*` taxonomy under the `m26.` namespace (M01 D8 / M03 D9 / M04 D9). check-fitness-gaps.ts
// scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m26'), and valid declared
// consumers (real module ids). The composition root merges this into the platform event catalog at boot
// (the M23/M25/M27/M30/M33 events-by-mN precedent); the dispatcher validates each `m26.cap.*` publish
// against the TypeBox payloadSchema inside the SAME transaction as the mutation (transactional outbox).
//
// NO PHI/MBI in any payload (D13) — IDs + cents + dates + bands only. The pure payload schemas live in
// @wardenx/cap-management (events.ts); this file binds them to declared consumers + the module-owner tag.
import {
  AccrualRecordedPayload,
  ProjectionUpdatedPayload,
  PsrVarianceRaisedPayload,
  SettlementFinalizedPayload,
  SettlementProposedPayload,
  ThresholdCrossedPayload,
  YearClosedPayload,
  YearClosingPayload,
  YearOpenedPayload,
} from "@wardenx/cap-management";
import type { ModuleEventContribution } from "@wardenx/types";

export const M26_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m26.cap.accrual_recorded",
    moduleOwner: "m26",
    description:
      "A remittance-derived cap accrual line was recorded; the per-beneficiary roll-up updated.",
    payloadSchema: AccrualRecordedPayload,
    // F-130 (#248) — m27 REMOVED: M27's own §1.1 dependency line names `CapAccrualReader`/`CapPeriodReader`
    // as forward-seam-deny-stub PULLS ("the aggregate-cap-per-beneficiary running accrual … the M26
    // provider is forward-seam-deny-stub at M27 lock and wires to live at M26 lock") — never an outbox
    // subscription to individual accrual events.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.projection_updated",
    moduleOwner: "m26",
    description: "A projection snapshot was persisted (nightly batch or remittance recompute).",
    payloadSchema: ProjectionUpdatedPayload,
    declaredConsumers: ["m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.threshold_crossed",
    moduleOwner: "m26",
    description: "A projection crossed into a higher alert band; a cap_threshold_event was raised.",
    payloadSchema: ThresholdCrossedPayload,
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.year_opened",
    moduleOwner: "m26",
    description: "A new cap period was opened (manual or the Oct 1 auto-open).",
    payloadSchema: YearOpenedPayload,
    // F-130 (#248) — m27 REMOVED: same reasoning as `m26.cap.accrual_recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.year_closing",
    moduleOwner: "m26",
    description:
      "A cap period transitioned active → in_settlement (Sep 30 + grace, or manual close).",
    payloadSchema: YearClosingPayload,
    // F-130 (#248) — m27 REMOVED: same reasoning as `m26.cap.accrual_recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.year_closed",
    moduleOwner: "m26",
    description: "A cap period reached settled (final settlement); the cap year is closed.",
    payloadSchema: YearClosedPayload,
    // F-130 (#248) — m27 REMOVED: same reasoning as `m26.cap.accrual_recorded` above.
    declaredConsumers: ["m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.settlement_proposed",
    moduleOwner: "m26",
    description: "A settlement worksheet was proposed from the current accruals.",
    payloadSchema: SettlementProposedPayload,
    // F-130 (#248) — m27 REMOVED: same reasoning as `m26.cap.accrual_recorded` above. `seamConsumers`
    // added: `cap_settlement` is one row per `cap_period` (proposed → finalized are two states of the
    // SAME row), and its sibling `settlement_finalized` already declares m33 against it — the omission
    // here looks like a pre-existing oversight this catalog entry had simply never noticed.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.settlement_finalized",
    moduleOwner: "m26",
    description: "A settlement was finalized (step-up); the period closed to settled.",
    payloadSchema: SettlementFinalizedPayload,
    // F-130 (#248) — m27 REMOVED: same reasoning as `m26.cap.accrual_recorded` above.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m26.cap.psr_variance_raised",
    moduleOwner: "m26",
    description: "PS&R reconciliation produced a non-zero variance above the per-tenant threshold.",
    payloadSchema: PsrVarianceRaisedPayload,
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];
