// apps/backend/src/modules/23-billing-medicare/consumers — barrel for the §4.4 / §4.10 / D3 upstream-event
// consumers + the M22 render handshake. Mirrors the M27 `27-cost-report/consumers/index.ts` precedent.
//
// The PURE, port-injected inbound half of M23: the topic→effect subscription map (the single source of truth
// for the §4.4 fan-out), one pure handler per subscribed topic family, the M22 document-render handshake
// builders/resolver (tasks 57 + 58). M26's forward-seam topic stays deny-stub until that module lands.
// GAP-205: the former `registerM23Consumers` registrar was dead scaffolding (no caller, no dispatcher took a registrar) and is deleted; the LIVE bindings are the `OutboxConsumerBinding`s under `../outbox-consumers/` (wired from apps/backend/src/index.ts, proven by `arch:outbox-bindings`).
export * from "./subscription-map";
export * from "./document-render";
export * from "./handlers";

import {
  type CapProjectionChangedEvent,
  type DocumentRenderedEvent,
  type ElectionSignedEvent,
  type M23ConsumerPorts,
  type NotrTriggerEvent,
  type PatientDeceasedEvent,
  type RemittancePostedEvent,
  type RevalidateTriggerEvent,
  type TransferCreatedEvent,
  type UpstreamConsumeReport,
  handleCapProjectionChanged,
  handleDischargeCreated,
  handleDocumentRendered,
  handleElectionSigned,
  handlePatientDeceased,
  handleRemittancePosted,
  handleRevalidateTrigger,
  handleRevocationCreated,
  handleTransferCreated,
} from "./handlers";
import { M26_CAP_PROJECTION_TOPIC, M40_CANONICAL_UPDATED_TOPIC } from "./subscription-map";

/**
 * The discriminated upstream event the inbound dispatcher delivers to M23 (the topic + its structurally-
 * minimal payload). Additive: a new subscribed topic is a new variant. LIVE topics carry their real slice;
 * the M25/M26 DENY-STUB variants carry the forward-seam slice (their handlers fail-closed).
 */
export type M23UpstreamEvent =
  // ── M6 → NOE / NOTR drafts ──
  | { readonly topic: "m6.election.signed"; readonly payload: ElectionSignedEvent }
  | { readonly topic: "m6.revocation.created"; readonly payload: NotrTriggerEvent }
  | { readonly topic: "m6.discharge.created"; readonly payload: NotrTriggerEvent }
  | { readonly topic: "m6.transfer.created"; readonly payload: TransferCreatedEvent }
  // ── M5 deceased → freeze + revalidate ──
  | { readonly topic: "m5.patient.deceased"; readonly payload: PatientDeceasedEvent }
  // ── M6 / M8 / M18 / M40 → revalidate ──
  | { readonly topic: "m6.cti.signed"; readonly payload: RevalidateTriggerEvent }
  | { readonly topic: "m6.f2f.attested"; readonly payload: RevalidateTriggerEvent }
  | { readonly topic: "m6.loc.changed"; readonly payload: RevalidateTriggerEvent }
  | { readonly topic: "m8.encounter.signed"; readonly payload: RevalidateTriggerEvent }
  | { readonly topic: "m8.encounter.cosigned"; readonly payload: RevalidateTriggerEvent }
  | { readonly topic: "m18.evv.late_check_resolved"; readonly payload: RevalidateTriggerEvent }
  | { readonly topic: typeof M40_CANONICAL_UPDATED_TOPIC; readonly payload: RevalidateTriggerEvent }
  // ── M22 render handshake ──
  | { readonly topic: "m22.document.rendered"; readonly payload: DocumentRenderedEvent }
  // ── M25 remittance → claim adjudication (LIVE since GAP-037) ──
  | { readonly topic: "m25.remittance.claim_paid"; readonly payload: RemittancePostedEvent }
  | { readonly topic: "m25.remittance.claim_partial_paid"; readonly payload: RemittancePostedEvent }
  | { readonly topic: "m25.remittance.claim_denied"; readonly payload: RemittancePostedEvent }
  | { readonly topic: "m25.remittance.claim_recouped"; readonly payload: RemittancePostedEvent }
  // ── M26 forward-seam DENY-STUB ──
  | {
      readonly topic: typeof M26_CAP_PROJECTION_TOPIC;
      readonly payload: CapProjectionChangedEvent;
    };

/**
 * Route one delivered upstream event to its pure handler (the dispatcher's single entry point). Returns the
 * structured {@link UpstreamConsumeReport}; an unmapped topic would be unrepresentable in {@link
 * M23UpstreamEvent}, so this is total over the subscribed set. Pure orchestration — the side effects all live
 * behind the injected {@link M23ConsumerPorts}. The M25/M26 variants fail-closed (forward-seam deny-stub).
 */
export async function dispatchM23UpstreamEvent(
  event: M23UpstreamEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  switch (event.topic) {
    case "m6.election.signed":
      return handleElectionSigned(event.payload, ports);
    case "m6.revocation.created":
      return handleRevocationCreated(event.payload, ports);
    case "m6.discharge.created":
      return handleDischargeCreated(event.payload, ports);
    case "m6.transfer.created":
      return handleTransferCreated(event.payload, ports);
    case "m5.patient.deceased":
      return handlePatientDeceased(event.payload, ports);
    case "m6.cti.signed":
    case "m6.f2f.attested":
    case "m6.loc.changed":
    case "m8.encounter.signed":
    case "m8.encounter.cosigned":
    case "m18.evv.late_check_resolved":
    case M40_CANONICAL_UPDATED_TOPIC:
      return handleRevalidateTrigger(event.topic, event.payload, ports);
    case "m22.document.rendered":
      return handleDocumentRendered(event.payload, ports);
    case "m25.remittance.claim_paid":
    case "m25.remittance.claim_partial_paid":
    case "m25.remittance.claim_denied":
    case "m25.remittance.claim_recouped":
      return handleRemittancePosted(event.topic, event.payload, ports);
    case M26_CAP_PROJECTION_TOPIC:
      return handleCapProjectionChanged(event.topic, event.payload, ports);
  }
}
