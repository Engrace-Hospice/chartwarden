// apps/backend/src/modules/12-dosespot/consumers/draft-order-requested.ts — the M13 eMAR §2.8 D17
// reconciliation "draft order" handshake consumer (F-16x, #248). PHASE-1 PURE PLANNING CORE.
//
// `m13.reconciliation.draft_order_requested` used to carry a hardcoded `medicationOrderDraftPayload: {}` —
// no consumer could ever have safely minted a real `medication_order` from it, since `drug_name`/`strength`/
// `dose_form`/`route` are all NOT NULL. M13's emit side (`emar-route-service-db.ts`'s `recordDecision`,
// `routes/service.ts`'s in-memory mirror) now sources real content from the pure `@wardenx/emar`
// `planReconciliationDecision` core — for a `carry_forward` of a caregiver-reported line, or any
// `new_order`, both of which require the caller (the reconciling clinician) to supply structured drug
// content explicitly; NEVER fabricated. `carry_forward` of an `m12_active` line stays a no-op (no event —
// the order already exists), and `m12_medhx` is REFUSED at the M13 side (`RECONCILIATION_MEDHX_UNAVAILABLE`)
// because no M12 medication-history-record projection exists anywhere in this codebase to source content
// from — so `lineKind` on this event's wire payload is narrowed to the one reachable value,
// `"caregiver_reported"`, and `derivedFromHistoryId` is always null today (kept nullable for when a real
// medhx projection lands).
//
// WHO IS THE "PRESCRIBER" ON A SYSTEM-MINTED DRAFT? `medication_order.prescriber_membership_id` is a NOT
// NULL FK to `membership` — unlike the discontinue/discharge-cascade consumers beside this one, there is NO
// empty-string system-actor escape hatch available (a real membership row must exist). The honest answer is
// the membership who actually recorded the M13 reconciliation decision (`decisionMadeByMembershipId` on the
// wire, threaded from `recordDecision`'s own `userId`) — that IS who decided "carry this med forward" /
// "this is a new one", even though the draft still awaits a DIFFERENT prescriber's actual signature before
// it can transmit. This mirrors the already-live `m12.idg-decision-intake` consumer
// (`outbox-consumers/m14-idg-decision-recorded.ts`), which attributes its own system-minted drafts to
// `recordedByMembershipId` for the identical reason.
import type { DeaSchedule, MedClass } from "@wardenx/types";

/** The `m13.reconciliation.draft_order_requested` payload M12 reads (M13 owns the wire shape). */
export interface DraftOrderRequestedPayload {
  readonly worksheetId: string;
  readonly decisionId: string;
  readonly patientId: string;
  readonly decisionMadeByMembershipId: string;
  readonly lineKind: "caregiver_reported";
  readonly medicationOrderDraftPayload: {
    readonly drugName: string;
    readonly strength: string;
    readonly doseForm: string;
    readonly route: string;
    readonly medClass: MedClass;
    readonly deaSchedule?: DeaSchedule | null;
    readonly rxnormRxcui?: string | null;
    readonly ndc?: string | null;
  };
  readonly derivedFromHistoryId: string | null;
}

/** The M6-owned facts (siting + ordering physician) M12 resolves via the shared `activeAdmissionDraftContextForPatient`
 *  seam (the same one `m12.idg-decision-intake` already binds) before it can mint a sited, attributed draft. */
export interface DraftOrderAdmissionContext {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly orderingPhysicianMdmId: string;
}

/** The real `medication_order` insert values this handshake mints — every NOT NULL column honestly sourced,
 *  never fabricated: drug content from the wire (itself never fabricated at the M13 side — see the file
 *  header), siting/physician from the M6 seam, prescriber from who actually recorded the decision. */
export interface PlannedMedicationOrderDraft {
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly medClass: MedClass;
  readonly isControlledSubstance: boolean;
  readonly deaSchedule: DeaSchedule | null;
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  readonly rxnormRxcui: string | null;
  readonly ndc: string | null;
  readonly prescriberMembershipId: string;
  readonly prescribingPhysicianMdmId: string;
  readonly derivedFromHistoryId: string | null;
  readonly triggeringReconciliationDecisionId: string;
  readonly data: Record<string, unknown>;
}

/**
 * Plan the M12 draft `medication_order` insert (pure). `medication_order_controlled_schedule_consistency`
 * (`is_controlled_substance = true) = (dea_schedule IS NOT NULL)`) is the DB's own backstop against a
 * malformed `deaSchedule` — `planReconciliationDecision` already refuses to emit an inconsistent pair at the
 * M13 side, so this never fabricates a schedule, it only carries through what the wire actually said.
 */
export function planDraftMedicationOrder(
  payload: DraftOrderRequestedPayload,
  context: DraftOrderAdmissionContext,
): PlannedMedicationOrderDraft {
  const d = payload.medicationOrderDraftPayload;
  const isControlledSubstance = d.medClass === "controlled_substance";
  return {
    patientId: payload.patientId,
    admissionId: context.admissionId,
    providerEntityId: context.providerEntityId,
    locationId: context.locationId,
    medClass: d.medClass,
    isControlledSubstance,
    deaSchedule: isControlledSubstance ? (d.deaSchedule ?? null) : null,
    drugName: d.drugName,
    strength: d.strength,
    doseForm: d.doseForm,
    route: d.route,
    rxnormRxcui: d.rxnormRxcui ?? null,
    ndc: d.ndc ?? null,
    prescriberMembershipId: payload.decisionMadeByMembershipId,
    prescribingPhysicianMdmId: context.orderingPhysicianMdmId,
    derivedFromHistoryId: payload.derivedFromHistoryId ?? null,
    triggeringReconciliationDecisionId: payload.decisionId,
    data: {
      source: "m13_reconciliation",
      worksheetId: payload.worksheetId,
      decisionId: payload.decisionId,
      lineKind: payload.lineKind,
    },
  };
}
