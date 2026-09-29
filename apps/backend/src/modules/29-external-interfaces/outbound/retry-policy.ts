// apps/backend/src/modules/29-external-interfaces/outbound — outbound ORM retry / DLQ policy (M29-T06, D9,
// §4.12.1, W-XI-09). PURE. A transport failure (a TLS/connect error, or an `AE` application-error ack) is
// retried with exponential backoff up to the attempt budget; the budget-exhausting failure DLQs the row and
// emits the terminal `m29.lab_order.transmission_failed` (M11 → TRANSMISSION_FAILED; M36 → HIGH operator
// alert). An `AR` reject is NOT retried — that path is `correlateAck`'s `rejected` outcome.
//
// IO-free: the caller supplies `now`; this core computes the next state deterministically.
import type { Hl7OutboundStatus } from "@wardenx/types";
import type {
  LabOrderTransmissionFailedPayload,
  OutboundAlert,
  OutboundAuditRecord,
} from "./outbound-events";

/** D9 — the outbound dispatch attempt budget (spec §4.12.1). The fifth failed attempt DLQs. */
export const OUTBOUND_MAX_ATTEMPTS = 5;

/** D9 — exponential backoff delays (ms) applied AFTER a failed attempt, before the next (§4.12.1). Five
 *  values are pinned by the spec; the Phase-1 five-attempt budget consumes indices 0..3 (the fifth attempt
 *  DLQs rather than waiting), and index 4 (480_000) is the guard value retained for the Phase-2 profile. */
export const OUTBOUND_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const;

/** The outbound row fields the retry decision reads. */
export interface RetryOutboundRow {
  readonly id: string;
  readonly feedId: string;
  readonly organizationId: string;
  /** `source_aggregate_id` — the M11 `order_record.id`. */
  readonly sourceAggregateId: string;
  /** Dispatch attempts already made and failed BEFORE this failure (0 on the first dispatch). */
  readonly retryCount: number;
}

export interface RetryDecisionInput {
  readonly outbound: RetryOutboundRow;
  /** When the failing attempt completed (INJECTED) — the backoff is added to this. */
  readonly now: Date;
  /** A short, PHI-free transport error class (e.g. `tls_handshake_failed`, `connect_timeout`, `ack AE`). */
  readonly lastError: string;
}

/** The `hl7_message_outbound` columns a retry decision sets. */
export interface RetryStatusUpdate {
  readonly status: Hl7OutboundStatus;
  readonly retryCount: number;
  /** When the row becomes eligible for re-dispatch; null once DLQ'd. */
  readonly nextRetryAt: Date | null;
}

/** The retry outcome: schedule another attempt, or DLQ + emit the terminal failure (§4.12.1). */
export type RetryDecision =
  | {
      readonly kind: "retry";
      readonly statusUpdate: RetryStatusUpdate;
      readonly audit: OutboundAuditRecord;
    }
  | {
      readonly kind: "dlq";
      readonly statusUpdate: RetryStatusUpdate;
      readonly event: {
        readonly name: "m29.lab_order.transmission_failed";
        readonly payload: LabOrderTransmissionFailedPayload;
      };
      readonly alert: OutboundAlert;
      readonly audit: OutboundAuditRecord;
    };

/**
 * F-178 — a failure retrying can never fix (a destination/protocol the deployment REFUSES to dial): go
 * straight to the terminal DLQ decision instead of burning five backoff attempts against a target the policy
 * will refuse every time. Same event / alert / audit shape as an exhausted DLQ so M11 (F-177) and M36 treat
 * it as any other terminal failure; `detail` carries the short PHI-free refusal label and `attemptCount` is
 * the true number of attempts (this one).
 */
export function decidePermanentFailure(input: RetryDecisionInput): Extract<RetryDecision, { kind: "dlq" }> {
  const { outbound } = input;
  const attemptNumber = outbound.retryCount + 1;
  return {
    kind: "dlq",
    statusUpdate: { status: "dlq", retryCount: attemptNumber, nextRetryAt: null },
    event: {
      name: "m29.lab_order.transmission_failed",
      payload: {
        orderId: outbound.sourceAggregateId,
        organizationId: outbound.organizationId,
        feedId: outbound.feedId,
        outboundMessageId: outbound.id,
        reason: "dlq_exhausted",
        detail: input.lastError || null,
        attemptCount: attemptNumber,
      },
    },
    alert: {
      kind: "hl7_outbound.transmission_failed",
      severity: "HIGH",
      channel: "operator-on-call",
      feedId: outbound.feedId,
      detail: `outbound ORM refused by destination policy (${input.lastError || "refused"}) — fix the feed configuration, then resend`,
    },
    audit: {
      kind: "hl7.outbound.dlq",
      feedId: outbound.feedId,
      orderRecordId: outbound.sourceAggregateId,
      outboundMessageId: outbound.id,
      messageControlId: null,
    },
  };
}

/**
 * Decide the fate of a failed outbound dispatch attempt (D9). `attemptNumber` is the 1-based count including
 * this failure (`retryCount + 1`). When it reaches `OUTBOUND_MAX_ATTEMPTS` the row DLQs; otherwise it
 * re-queues with the exponential backoff delay for that attempt.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const { outbound } = input;
  const attemptNumber = outbound.retryCount + 1;
  const baseAudit = {
    feedId: outbound.feedId,
    orderRecordId: outbound.sourceAggregateId,
    outboundMessageId: outbound.id,
    messageControlId: null,
  };

  if (attemptNumber >= OUTBOUND_MAX_ATTEMPTS) {
    return {
      kind: "dlq",
      statusUpdate: { status: "dlq", retryCount: attemptNumber, nextRetryAt: null },
      event: {
        name: "m29.lab_order.transmission_failed",
        payload: {
          orderId: outbound.sourceAggregateId,
          organizationId: outbound.organizationId,
          feedId: outbound.feedId,
          outboundMessageId: outbound.id,
          reason: "dlq_exhausted",
          detail: input.lastError || null,
          attemptCount: attemptNumber,
        },
      },
      alert: {
        kind: "hl7_outbound.transmission_failed",
        severity: "HIGH",
        channel: "operator-on-call",
        feedId: outbound.feedId,
        detail: `outbound ORM DLQ after ${attemptNumber} attempts — manual resend required`,
      },
      audit: { kind: "hl7.outbound.dlq", ...baseAudit },
    };
  }

  // Re-queue: backoff delay indexed by the attempt just failed (attempt 1 → index 0 → 30s, …).
  const delayMs =
    OUTBOUND_BACKOFF_MS[attemptNumber - 1] ?? OUTBOUND_BACKOFF_MS[OUTBOUND_BACKOFF_MS.length - 1]!;
  const nextRetryAt = new Date(input.now.getTime() + delayMs);
  return {
    kind: "retry",
    statusUpdate: { status: "queued", retryCount: attemptNumber, nextRetryAt },
    audit: { kind: "hl7.outbound.dispatched", ...baseAudit },
  };
}

// ── F-179: the `in_flight` lease + reclaim decision ──────────────────────────────────────────────────────────
//
// A row is claimed `in_flight` in its OWN committed transaction BEFORE the socket send, with `next_retry_at` set
// to a LEASE EXPIRY (`now + OUTBOUND_IN_FLIGHT_LEASE_MS`); the outcome is written in a second transaction. If the
// process dies between the two, the committed `in_flight` row is what a reclaim sweep finds once the lease
// expires. Reclaiming is a STATE TRANSITION only — it never touches a socket:
//   • the row goes back to `queued` (attempt counted, exponential backoff) and the existing retry sweep resends
//     the STORED wire, i.e. the SAME MSH-10 message control id, so a receiver that already processed the crashed
//     attempt can dedupe (HL7 v2 receivers dedupe on MSH-10; a resend with a NEW id would be a second order);
//   • the reclaim is an attempt, so it draws on the SAME `OUTBOUND_MAX_ATTEMPTS` budget: an outcome that stays
//     unknown across the whole budget goes terminal (`dlq`) for human verification with the lab, never a loop.

/** How long a claimed `in_flight` row is presumed to have a live worker behind it. Must sit well above the
 *  worst-case attempt (10s connect + 30s ack wait + rate-limiter wait + DB round trips): reclaiming a row whose
 *  worker is merely slow would make a live send look like a duplicate. 5 minutes is >7x that worst case. */
export const OUTBOUND_IN_FLIGHT_LEASE_MS = 5 * 60_000;

/** The fixed, PHI-free `lastError` label a reclaim records. */
export const IN_FLIGHT_RECLAIM_LABEL = "in_flight_lease_expired";

export type InFlightReclaimDecision =
  | (Extract<RetryDecision, { kind: "retry" }> & { readonly alert: OutboundAlert })
  | Extract<RetryDecision, { kind: "dlq" }>;

/**
 * Decide the fate of an `in_flight` row whose lease expired. Reuses `decideRetry` (one budget, one backoff
 * ladder, one DLQ event shape — M11's F-177 applier and M36 treat it like any other terminal failure) and adds
 * the operator alert a reclaim always raises: a crashed/lost attempt is never silent.
 */
export function decideInFlightReclaim(input: {
  readonly outbound: RetryOutboundRow;
  readonly now: Date;
}): InFlightReclaimDecision {
  const decision = decideRetry({ ...input, lastError: IN_FLIGHT_RECLAIM_LABEL });
  const attemptNumber = input.outbound.retryCount + 1;
  if (decision.kind === "dlq") {
    return {
      ...decision,
      alert: {
        ...decision.alert,
        detail: `outbound ORM in_flight lease expired ${attemptNumber} times with delivery unknown — verify with the lab whether it arrived, then resend`,
      },
    };
  }
  return {
    ...decision,
    alert: {
      kind: "hl7_outbound.transmission_failed",
      severity: "NORMAL",
      channel: "operator-on-call",
      feedId: input.outbound.feedId,
      detail: `outbound ORM in_flight lease expired (attempt ${attemptNumber} of ${OUTBOUND_MAX_ATTEMPTS}) — requeued with the same message control id`,
    },
  };
}
