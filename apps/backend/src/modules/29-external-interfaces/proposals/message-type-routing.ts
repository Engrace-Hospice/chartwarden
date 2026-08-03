// apps/backend/src/modules/29-external-interfaces/proposals — ADT message-type → proposal routing (M29-T04 /
// T-29.06 §3). The SINGLE source of truth for which downstream owner module (M5 demographics vs M6 admission)
// an inbound ADT trigger applies through, and whether a no-match should propose a new patient or drop with
// audit (§2.1 of T-29.06: A01/A04/A08 → propose new_patient; A03/A11 → cannot act on an unknown patient).
import type { Hl7InboundProposalKind, Hl7ProposalOwnerModule } from "@wardenx/types";

/** The five ADT trigger events the Phase-1 inbound flow supports (§2.2 / T-29.06 §2.2). */
export type AdtMessageType = "ADT^A01" | "ADT^A03" | "ADT^A04" | "ADT^A08" | "ADT^A11";

/** How a `no_match` cascade outcome is handled per trigger (§4.6 / T-29.06 §2.1). */
export type NoMatchBehavior = "propose_new_patient" | "drop_with_audit";

export interface MessageTypeRouting {
  readonly resourceKind: Hl7InboundProposalKind;
  readonly ownerModule: Hl7ProposalOwnerModule;
  readonly noMatchBehavior: NoMatchBehavior;
}

/**
 * ADT trigger → (resource_kind, owner_module, no-match behavior). A08 patient-updates live in M5; A01/A04
 * admits and A03/A11 discharge/cancel live in M6. A discharge/cancel for an unknown patient is dropped
 * (you cannot act on someone you have no record of); a new admit/update for an unknown patient proposes a
 * new_patient row for an M5 reviewer to create.
 */
export const MESSAGE_TYPE_ROUTING: Readonly<Record<AdtMessageType, MessageTypeRouting>> = {
  "ADT^A01": { resourceKind: "admission_event", ownerModule: "m6", noMatchBehavior: "propose_new_patient" },
  "ADT^A04": { resourceKind: "admission_event", ownerModule: "m6", noMatchBehavior: "propose_new_patient" },
  "ADT^A08": { resourceKind: "patient_demographic_update", ownerModule: "m5", noMatchBehavior: "propose_new_patient" },
  "ADT^A03": { resourceKind: "discharge_event", ownerModule: "m6", noMatchBehavior: "drop_with_audit" },
  "ADT^A11": { resourceKind: "cancel_admission", ownerModule: "m6", noMatchBehavior: "drop_with_audit" },
};

/** True when `messageType` is one of the five supported ADT triggers (narrows to {@link AdtMessageType}). */
export function isSupportedAdt(messageType: string): messageType is AdtMessageType {
  return messageType in MESSAGE_TYPE_ROUTING;
}
