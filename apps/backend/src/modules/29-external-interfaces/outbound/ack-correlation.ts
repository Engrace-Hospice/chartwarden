// apps/backend/src/modules/29-external-interfaces/outbound — outbound ORM ACK correlation (M29-T06,
// §4.12.2, W-XI-07/09). PURE. When the destination lab returns an `MSA` segment (inside an `ORR^O02` or a
// generic `ACK`), this core:
//   1. shallow-parses the MSA (`parseAckMsa`) — MSA-1 disposition, MSA-2 = our outbound MSH-10, MSA-3 text,
//   2. correlates MSA-2 to the outbound row and decides the state transition (`correlateAck`):
//        · AA (Application Accept) → `acked`, emit `m29.lab_order.transmitted` → M11 → TRANSMITTED,
//        · AR (Application Reject) → `naked`, emit `m29.lab_order.transmission_failed` → M11, NO retry
//          (AR is a structural rejection — operator intervention, §4.12.3),
//        · AE (Application Error)  → a retryable transport error handed to the retry policy (this core does
//          NOT decide the retry — `retry-policy.ts` owns the attempt budget / DLQ),
//        · no correlating row      → `orphan`, logged `hl7.outbound.orphan_ack` and discarded (no state
//          change, §4.12.2).
//
// IO-free: the ack receipt clock and the ack payload digest are INJECTED (the worker computes `sha256(wire)`
// off the raw ACK frame and calls `envelope.encrypt` for `ack_payload_cipher` — never in this pure core).
import type { Hl7OutboundAckStatus, Hl7OutboundStatus } from "@chartwarden/types";
import type {
  LabOrderTransmissionFailedPayload,
  LabOrderTransmittedPayload,
  OutboundAlert,
  OutboundAuditRecord,
} from "./outbound-events";

/** The shallow parse of a return-channel MSA segment. */
export interface ParsedAck {
  /** MSA-1 — the ack code, upper-cased (`AA` / `AE` / `AR`; other codes fall through as retryable). */
  readonly ackCode: string;
  /** MSA-2 — the acknowledged message control id; correlates to the outbound `MSH-10`. */
  readonly messageControlId: string;
  /** MSA-3 — optional human-readable text (an `AR` reject reason or an `AE` diagnostic). */
  readonly text: string;
}

/**
 * Shallow-parse the first `MSA` segment out of a return HL7 message (segments are `\r`-delimited; a `\n` or
 * `\r\n` sender is tolerated). Reads the field separator from the leading `MSH` segment (default `|`) so a
 * non-standard separator still parses. Returns `null` when there is no MSA (nothing to correlate).
 */
export function parseAckMsa(payload: string): ParsedAck | null {
  const segments = payload.split(/\r\n|\r|\n/);
  const fieldSep = segments[0]?.startsWith("MSH") ? segments[0].charAt(3) || "|" : "|";
  const msa = segments.find((s) => s.startsWith("MSA"));
  if (!msa) return null;
  const fields = msa.split(fieldSep);
  const ackCode = (fields[1] ?? "").trim().toUpperCase();
  const messageControlId = (fields[2] ?? "").trim();
  const text = (fields[3] ?? "").trim();
  if (messageControlId === "") return null; // an MSA with no control id cannot correlate — treated as absent
  return { ackCode, messageControlId, text };
}

/** The outbound row fields the ACK correlation reads (the caller resolves the row by MSA-2 = MSH-10). */
export interface CorrelatedOutboundRow {
  readonly id: string;
  readonly feedId: string;
  readonly organizationId: string;
  /** `source_aggregate_id` — the M11 `order_record.id` the transmitted ORM originated from. */
  readonly sourceAggregateId: string;
  /** Dispatch attempts already made (1-based once dispatched); carried onto the failed-event payload. */
  readonly retryCount: number;
  /** F-200 — `hl7_message_outbound.attempt_id`, carried onto BOTH terminal events (see `RetryOutboundRow.attemptId`). */
  readonly attemptId?: string | null;
}

/** The subset of `hl7_message_outbound` columns an ACK sets. `ackPayloadCipher` is added by the worker. */
export interface AckStatusUpdate {
  readonly status: Hl7OutboundStatus;
  readonly ackStatus: Hl7OutboundAckStatus;
  readonly ackReceivedAt: Date;
  readonly ackPayloadSha256: string;
  /** Set only on `AA` (the transmission completed); null on a NAK. */
  readonly transmittedAt: Date | null;
}

export interface AckCorrelationInput {
  readonly ack: ParsedAck;
  /** The outbound row MSA-2 correlates to, or `null` for an orphan ack (no matching outstanding row). */
  readonly outbound: CorrelatedOutboundRow | null;
  /** When the ACK was received (INJECTED). */
  readonly ackReceivedAt: Date;
  /** `sha256(rawAckWire)` (INJECTED — the auditable projection of the denylisted `ack_payload_cipher`). */
  readonly ackPayloadSha256: string;
}

/** The correlation outcome. `transport_error` (AE) carries NO state change — the retry policy owns it. */
export type AckCorrelationResult =
  | { readonly kind: "orphan"; readonly audit: OutboundAuditRecord }
  | {
      readonly kind: "acked";
      readonly statusUpdate: AckStatusUpdate;
      readonly event: {
        readonly name: "m29.lab_order.transmitted";
        readonly payload: LabOrderTransmittedPayload;
      };
      readonly audit: OutboundAuditRecord;
    }
  | {
      readonly kind: "rejected";
      readonly statusUpdate: AckStatusUpdate;
      readonly event: {
        readonly name: "m29.lab_order.transmission_failed";
        readonly payload: LabOrderTransmissionFailedPayload;
      };
      readonly alert: OutboundAlert;
      readonly audit: OutboundAuditRecord;
    }
  | { readonly kind: "transport_error"; readonly ackCode: string; readonly detail: string };

/** Correlate a parsed ACK to its outbound row and decide the transition (§4.12.2). */
export function correlateAck(input: AckCorrelationInput): AckCorrelationResult {
  const { ack, outbound } = input;

  // Orphan — an ACK with no correlating outstanding row updates nothing (§4.12.2).
  if (!outbound) {
    return {
      kind: "orphan",
      audit: {
        kind: "hl7.outbound.orphan_ack",
        feedId: null,
        orderRecordId: null,
        outboundMessageId: null,
        messageControlId: ack.messageControlId,
      },
    };
  }

  const baseAudit = {
    feedId: outbound.feedId,
    orderRecordId: outbound.sourceAggregateId,
    outboundMessageId: outbound.id,
    messageControlId: ack.messageControlId,
  };

  switch (ack.ackCode) {
    case "AA":
      return {
        kind: "acked",
        statusUpdate: {
          status: "acked",
          ackStatus: "aa",
          ackReceivedAt: input.ackReceivedAt,
          ackPayloadSha256: input.ackPayloadSha256,
          transmittedAt: input.ackReceivedAt,
        },
        event: {
          name: "m29.lab_order.transmitted",
          payload: {
            orderId: outbound.sourceAggregateId,
            organizationId: outbound.organizationId,
            feedId: outbound.feedId,
            outboundMessageId: outbound.id,
            messageControlId: ack.messageControlId,
            ackReceivedAt: input.ackReceivedAt.toISOString(),
            ...(outbound.attemptId ? { attemptId: outbound.attemptId } : {}),
          },
        },
        audit: { kind: "hl7.outbound.acked", ...baseAudit },
      };

    case "AR":
      // Structural rejection (e.g. unknown patient at the lab) — NO retry, operator intervention (§4.12.3).
      return {
        kind: "rejected",
        statusUpdate: {
          status: "naked",
          ackStatus: "ar",
          ackReceivedAt: input.ackReceivedAt,
          ackPayloadSha256: input.ackPayloadSha256,
          transmittedAt: null,
        },
        event: {
          name: "m29.lab_order.transmission_failed",
          payload: {
            orderId: outbound.sourceAggregateId,
            organizationId: outbound.organizationId,
            feedId: outbound.feedId,
            outboundMessageId: outbound.id,
            reason: "application_reject",
            detail: ack.text || null,
            attemptCount: outbound.retryCount,
            ...(outbound.attemptId ? { attemptId: outbound.attemptId } : {}),
          },
        },
        alert: {
          kind: "hl7_outbound.transmission_failed",
          severity: "HIGH",
          channel: "operator-on-call",
          feedId: outbound.feedId,
          detail:
            "outbound ORM rejected by the lab (AR) — manual resend required after remediation",
        },
        audit: { kind: "hl7.outbound.nacked", ...baseAudit },
      };

    default:
      // AE (and any non-AA/AR code) — a retryable transport/application error handed to the retry policy.
      return {
        kind: "transport_error",
        ackCode: ack.ackCode,
        detail: ack.text || `ack ${ack.ackCode || "(none)"}`,
      };
  }
}
