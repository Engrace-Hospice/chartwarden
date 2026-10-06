// apps/backend/src/modules/13-emar/consumers/index.ts — the M13 outbox-subscription surface (M13-T08,
// spec §4.5). Each entry binds an event another module emits to the M13 consumer that handles it; the PURE
// decision core for the four M6 reconciliation triggers ships + is tested here, and the live boot wiring (when
// the M13 backend is mounted) binds the handler to the dispatcher and executes the returned action through
// M13's service path (worksheet open / schedule materialize / schedule cancel / kit deploy/return / PDF
// back-ref).
//
// The M12 medication-order producers (active / discontinued) and the M6 admission/discharge/CTI producers
// exist in Wave D/E — these bindings are LIVE-eligible. The M21 comfort-kit producers are ALSO now bound
// live (F-166, #248) — `.deployed_at_patient` / `.replenished` / `.returned` / `.return_reconciliation`
// under `../outbox-consumers/m21-comfort-kit-*.ts`; this list previously named only two of the four (the
// other two were simply missing, corrected below). M22's document.rendered is a
// cross producer. (GAP-040 — the former `m9.prn_reassessment_overdue` subscription is GONE: M13 itself owns the
// PRN overdue sweep and emits `m13.prn_reassessment.overdue`; see `../jobs/deadline-sweeps.ts`.) Every consumed event name is a STRING literal (no
// cross-module schema import): M13 reads other modules solely through the foundation outbox, so this task
// adds NO new edge to M13's manifest dependsOn (§1.1: outbox is the only cross-module communication).
import {
  type ReconciliationTriggerEnvelope,
  type ReconciliationWorksheetPlan,
  buildReconciliationWorksheet,
} from "@wardenx/emar";
import type { ReconciliationTriggerKind } from "@wardenx/types";

/** §4.5 — the four M6 events that open a reconciliation worksheet, mapped to their D17 trigger kind. */
export const M6_RECONCILIATION_TRIGGER_KIND: Readonly<Record<string, ReconciliationTriggerKind>> = {
  "m6.admission.activated": "admission",
  "m6.transfer.created": "transfer_in",
  "m6.discharge.created": "discharge",
  "m6.cti.signed": "recertification",
};

/**
 * §2.8 D17 — decide the reconciliation worksheet to open for one of the four M6 trigger events. PURE: maps the
 * source event name to the trigger kind and delegates to the @wardenx/emar `buildReconciliationWorksheet`
 * (which computes the per-kind `due_at`). Returns `null` for an event name M13 does not subscribe (defensive;
 * the dispatcher only routes the four subscribed names here). The handler upserts on the `(admission,
 * triggerKind, triggerOutboxEventId)` unique, so re-delivery is an idempotent no-op.
 */
export function decideReconciliationTrigger(
  sourceEventName: string,
  envelope: Omit<ReconciliationTriggerEnvelope, "triggerKind">,
): ReconciliationWorksheetPlan | null {
  const triggerKind = M6_RECONCILIATION_TRIGGER_KIND[sourceEventName];
  if (!triggerKind) return null;
  return buildReconciliationWorksheet({ ...envelope, triggerKind });
}

/** The §4.5 event → M13-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s
 * handler at boot; the pure decider each handler runs ships in @wardenx/emar (reconciliation / schedule /
 * cascade / comfort-kit). Names mirror the §4.5 handler layout. Consumer dedup is keyed on `(eventId,
 * consumerName)` per the M1 outbox-consumer pattern; re-delivery is safe. */
export const M13_OUTBOX_SUBSCRIPTIONS = [
  { eventName: "m12.medication_order.active", consumerName: "m13.materialize-schedule" },
  { eventName: "m12.medication_order.discontinued", consumerName: "m13.cancel-future-schedule" },
  { eventName: "m6.admission.activated", consumerName: "m13.reconciliation-admission" },
  { eventName: "m6.transfer.created", consumerName: "m13.reconciliation-transfer-completed" },
  { eventName: "m6.discharge.created", consumerName: "m13.reconciliation-discharge-executed" },
  { eventName: "m6.admission.discharged", consumerName: "m13.admission-discharged-cascade" },
  { eventName: "m6.cti.signed", consumerName: "m13.reconciliation-recertification-signed" },
  { eventName: "m21.comfort_kit.deployed_at_patient", consumerName: "m13.comfort-kit-deployed" },
  { eventName: "m21.comfort_kit.replenished", consumerName: "m13.comfort-kit-replenished" },
  { eventName: "m21.comfort_kit.returned", consumerName: "m13.comfort-kit-returned" },
  {
    eventName: "m21.comfort_kit.return_reconciliation",
    consumerName: "m13.comfort-kit-return-reconciliation",
  },
  { eventName: "m22.document.rendered", consumerName: "m13.pdf-rendered-backref" },
] as const;
