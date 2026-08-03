// apps/backend/src/modules/29-external-interfaces/outbound — outbound ORM outbox / alert / audit descriptors
// (M29-T06, §4.10 / §4.9 / §11.A). PURE type declarations, RETURNED by the dispatch / ACK / retry cores and
// published by the T08 worker (the cores never touch the outbox, M36, or M4 — they describe intent).
//
// The two M11-facing events close the M11 `hl7_orm` outbound forward-seam (§15): M11 consumes
// `m29.lab_order.transmitted` to flip `order_record.transmission_status = 'TRANSMITTED'` and
// `m29.lab_order.transmission_failed` to flip it to `TRANSMISSION_FAILED` (spec §4.12.2 / W-XI-07..09).

/** `m29.lab_order.transmitted` — an outbound ORM the destination lab `AA`-acked (§4.12.2). M11 + M33 consume. */
export interface LabOrderTransmittedPayload {
  readonly orderId: string;
  readonly organizationId: string;
  readonly feedId: string;
  readonly outboundMessageId: string;
  /** MSH-10 of the transmitted ORM (= MSA-2 of the ack that correlated it). */
  readonly messageControlId: string;
  readonly ackReceivedAt: string;
}

/** Why an outbound ORM failed — an `AR` structural reject vs. transport-exhaustion DLQ vs. a pre-persist BAA
 *  refuse. `application_reject`/`dlq_exhausted` reach M11 as `TRANSMISSION_FAILED`; `baa_inactive` does NOT
 *  (the M29-owned DLQ auto-requeues on BAA restoration per W-XI-08 — see the dispatch planner). */
export type LabOrderTransmissionFailureReason = "application_reject" | "dlq_exhausted";

/** `m29.lab_order.transmission_failed` — a terminal outbound failure M11 + M36 consume (§4.12.2 / W-XI-09). */
export interface LabOrderTransmissionFailedPayload {
  readonly orderId: string;
  readonly organizationId: string;
  readonly feedId: string;
  /** Null only if the failure preceded row persistence (it never does for these two reasons — always set). */
  readonly outboundMessageId: string;
  readonly reason: LabOrderTransmissionFailureReason;
  /** A short, PHI-free diagnostic (MSA-3 reject text or the last transport error class). */
  readonly detail: string | null;
  /** The number of dispatch attempts made before the terminal state (1 for `AR`, 5 for a DLQ exhaustion). */
  readonly attemptCount: number;
}

/** The M11-facing outbound outbox events (§4.10). */
export type OutboundOutboxEvent =
  | { readonly name: "m29.lab_order.transmitted"; readonly payload: LabOrderTransmittedPayload }
  | { readonly name: "m29.lab_order.transmission_failed"; readonly payload: LabOrderTransmissionFailedPayload };

/** An M36 typed-alert intent (§4.9). M29 owns no delivery code — the T08 worker hands this to M36's engine. */
export interface OutboundAlert {
  readonly kind:
    | "hl7_outbound.transmission_failed"
    | "external_feed.baa_expired"
    | "external_feed.baa_missing";
  readonly severity: "HIGH" | "NORMAL";
  readonly channel: "operator-on-call" | "compliance";
  readonly feedId: string;
  /** A short, PHI-free operator-facing summary (never a segment value, §8.4). */
  readonly detail: string;
}

/** An M4 audit intent for the outbound HL7 disclosure chain (§11.A). The T08 worker calls `audit()` with the
 *  field denylist; every outbound ORM transmission is a HIPAA §164.528 disclosure. `orderRecordId` /
 *  `messageControlId` are the reproducible-accounting keys; no segment value is captured here. */
export interface OutboundAuditRecord {
  readonly kind:
    | "hl7.outbound.dispatched"
    | "hl7.outbound.acked"
    | "hl7.outbound.nacked"
    | "hl7.outbound.dlq"
    | "hl7.outbound.baa_refuse"
    | "hl7.outbound.orphan_ack";
  readonly feedId: string | null;
  readonly orderRecordId: string | null;
  readonly outboundMessageId: string | null;
  readonly messageControlId: string | null;
}
