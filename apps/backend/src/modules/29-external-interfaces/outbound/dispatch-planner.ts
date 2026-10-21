import type { NewHl7MessageOutboundRow } from "@chartwarden/db/schema";
// apps/backend/src/modules/29-external-interfaces/outbound — outbound ORM dispatch planning (M29-T06,
// §4.12.1, W-XI-07/08). PURE. The pinch-point core: it turns a resolved `m11.order.hl7_orm_requested`
// request + the D16 M40 BAA decision into either
//   • `dispatch`    — the built ORM^O01 wire + the `hl7_message_outbound` insert draft (status `queued`) +
//                     the `hl7.outbound.dispatched` audit intent, or
//   • `baa_refused` — NO row (the refusal is PRE-PERSIST per W-XI-08), the `hl7.outbound.baa_refuse` audit
//                     intent, and a HIGH-severity compliance alert. Critically it emits NO M11
//                     `transmission_failed` event: a BAA lapse is transient, the M29-owned DLQ requeues the
//                     order automatically when M40 re-activates the BAA — flipping M11 to TRANSMISSION_FAILED
//                     would prematurely fail an order that self-heals.
//
// Determinism (mirrors `planLabAttach`, T05): the caller supplies `outboundMessageId` / `messageControlId` /
// `queuedAt` and the already-resolved `BaaGateDecision` (from `decideBaaGate` over the live seam result), so
// the result is a pure function of its inputs. The T08 worker mints the ids + clock, resolves the BAA seam,
// envelope-encrypts the wire into `payload_cipher`, does the insert, and dispatches over MLLP.
import type { OrmRequestedPayload } from "@chartwarden/types";
import type { Hl7OutboundSourceKind } from "@chartwarden/types";
import type { BaaGateDecision, BaaGateRefuseReason } from "../feed/baa-gate";
import { sha256Hex } from "../listener/mllp-framing";
import { type OrmEndpoint, buildOrmO01, summarizeSegments } from "./orm-o01";
import type { OutboundAlert, OutboundAuditRecord } from "./outbound-events";

/** The `source_aggregate_kind` a Phase-1 outbound ORM originates from (an M11 order). */
export const ORM_SOURCE_KIND: Hl7OutboundSourceKind = "m11.order_record";

/** The `hl7_message_outbound` insert draft the planner produces. `payload_cipher` is OMITTED — the worker
 *  envelope-encrypts the wire at persist (the core stays IO-free); the digest (`payload_sha256`) IS pure and
 *  materialized here. The ack-* columns and `transmitted_at` are filled later by the ACK-correlation core. */
export type OutboundRowDraft = Omit<
  NewHl7MessageOutboundRow,
  | "payloadCipher"
  | "ackPayloadCipher"
  | "ackPayloadSha256"
  | "ackStatus"
  | "ackReceivedAt"
  | "transmittedAt"
>;

export interface OutboundDispatchInput {
  /** The typed M11 ORM request. */
  readonly request: OrmRequestedPayload;
  /** The resolved active feed the order dispatches over (matched by `labDestinationFacilityId` at T08). */
  readonly feed: {
    readonly id: string;
    readonly organizationId: string;
    readonly endpoint: OrmEndpoint;
  };
  /** The D16 BAA decision (resolved by the caller via `decideBaaGate` over the M40 seam, as-of `queuedAt`). */
  readonly baa: BaaGateDecision;
  /** The M40 facility id the ORM dispatches to (app-side ref; null when unresolved). */
  readonly destinationFacilityId: string | null;
  // ── Caller-supplied identity + clock (determinism) ──
  readonly outboundMessageId: string;
  readonly messageControlId: string;
  readonly queuedAt: Date;
}

/** The dispatch outcome: build + persist + send, or refuse pre-persist on a failed BAA gate. */
export type OutboundDispatchPlan =
  | {
      readonly kind: "dispatch";
      readonly row: OutboundRowDraft;
      /** The built ORM^O01 wire — the worker envelope-encrypts this into `payload_cipher`. */
      readonly wire: string;
      readonly audit: OutboundAuditRecord;
    }
  | {
      readonly kind: "baa_refused";
      readonly reason: BaaGateRefuseReason;
      readonly baaStatus: string;
      readonly audit: OutboundAuditRecord;
      readonly alert: OutboundAlert;
    };

/** The §2.6 permanent dispatch dedup key: `hash(feed_id, source_aggregate_kind, source_aggregate_id)`. */
export function outboundIdempotencyKey(
  feedId: string,
  sourceKind: string,
  sourceAggregateId: string,
): string {
  return sha256Hex(`${feedId}|${sourceKind}|${sourceAggregateId}`);
}

/**
 * Plan an outbound ORM dispatch (§4.12.1). Fails CLOSED on the BAA gate (D16): a `missing`/`expired`/
 * `pending` BAA refuses PRE-PERSIST — no `hl7_message_outbound` row is written (W-XI-08). Otherwise it builds
 * the ORM^O01 wire, materializes the sha256 digest + segment summary, and returns the `queued` insert draft.
 */
export function planOutboundDispatch(input: OutboundDispatchInput): OutboundDispatchPlan {
  const { request, feed } = input;
  const orderRecordId = request.orderId;

  // ── D16 BAA gate — refuse pre-persist. ──
  if (!input.baa.allowed) {
    const expired = input.baa.reason === "expired_baa";
    return {
      kind: "baa_refused",
      reason: input.baa.reason,
      baaStatus: input.baa.status,
      audit: {
        kind: "hl7.outbound.baa_refuse",
        feedId: feed.id,
        orderRecordId,
        outboundMessageId: null,
        messageControlId: null,
      },
      alert: {
        kind: expired ? "external_feed.baa_expired" : "external_feed.baa_missing",
        severity: "HIGH",
        channel: "compliance",
        feedId: feed.id,
        detail: `outbound ORM dispatch refused: BAA ${input.baa.status} for the destination facility`,
      },
    };
  }

  // ── Build the ORM^O01 wire (D8: OBR-2 = placer order number). ──
  const wire = buildOrmO01({
    request,
    endpoint: feed.endpoint,
    messageControlId: input.messageControlId,
    messageTimestamp: hl7Timestamp(input.queuedAt),
  });

  const row: OutboundRowDraft = {
    id: input.outboundMessageId,
    organizationId: feed.organizationId,
    feedId: feed.id,
    messageType: "ORM^O01",
    messageControlId: input.messageControlId,
    payloadSha256: sha256Hex(wire),
    segmentsSummary: summarizeSegments(wire),
    sourceAggregateKind: ORM_SOURCE_KIND,
    sourceAggregateId: orderRecordId,
    destinationFacilityId: input.destinationFacilityId,
    queuedAt: input.queuedAt,
    retryCount: 0,
    nextRetryAt: null,
    status: "queued",
    idempotencyKey: outboundIdempotencyKey(feed.id, ORM_SOURCE_KIND, orderRecordId),
  };

  return {
    kind: "dispatch",
    row,
    wire,
    audit: {
      kind: "hl7.outbound.dispatched",
      feedId: feed.id,
      orderRecordId,
      outboundMessageId: input.outboundMessageId,
      messageControlId: input.messageControlId,
    },
  };
}

/** Format a `Date` as an HL7 `YYYYMMDDHHMMSS` UTC timestamp (MSH-7). Local to the planner's clock injection. */
function hl7Timestamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
  );
}
