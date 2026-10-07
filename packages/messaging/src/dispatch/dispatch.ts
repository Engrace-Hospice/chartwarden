// @wardenx/messaging — the out-of-band dispatch decision for ONE claimed delivery (M36 GAP-101, §4.4 / §4.7).
//
// Pure over ports: the sweep (apps/backend, Drizzle) claims a `notification_delivery` row and hands it here;
// this decides what happened and the sweep persists it. No clock, no I/O beyond the injected ports.
//
//   • IDEMPOTENT — a row that already carries a `vendor_message_id` was handed to the vendor before (a crash
//     between the send and the write-back); it is NOT sent again, it settles as `sent` on the stored id.
//   • SOS-ONLY VOICE — re-checked here at consumer entry (the DB CHECK is the second wall, §2.5 / M36-F06d).
//   • SANITIZED — the vendor payload is built ONLY by `sanitizeForOutOfBand` (§4.7); the claim carries ids and
//     the category, never a payload or a body.
//   • RETRY — a retryable refusal backs off per the §4.4.1 queue params (honouring a vendor Retry-After) until
//     the attempt budget is spent, then fails terminally; a non-retryable refusal fails at once.
import type { AlertCategory, AlertSeverity } from "../interfaces/kinds";
import { sanitizeForOutOfBand } from "../notification/sanitize";
import { backoffDelayMs, hasAttemptsLeft, queueParametersFor } from "./retry";
import {
  type OutOfBandTransportChannel,
  type OutOfBandTransports,
  TransportError,
} from "./transports";

/** A delivery row a sweep has claimed (attemptCount ALREADY includes this attempt). */
export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly organizationId: string;
  readonly alertId: string;
  readonly recipientUserId: string;
  readonly channel: OutOfBandTransportChannel;
  readonly alertCategory: AlertCategory;
  readonly alertSeverity: AlertSeverity;
  readonly attemptCount: number;
  readonly vendorMessageId: string | null;
}

/** The recipient's verified destination for the delivery's channel (the endpoint resolver's answer). */
export interface ResolvedDestination {
  readonly endpointId: string;
  readonly value: string;
}

export interface DispatchPorts {
  readonly transports: OutOfBandTransports;
  /** Null when the recipient has no verified endpoint on the channel. */
  resolveDestination(claim: ClaimedDelivery): Promise<ResolvedDestination | null>;
  /** The authenticated app origin the content-free deep link points into. */
  readonly appBaseUrl: string;
}

export type DispatchOutcome =
  | {
      readonly kind: "sent";
      readonly vendorMessageId: string;
      readonly endpointId: string | null;
      /** True when the channel offers no delivery callback, so acceptance settles the row `delivered`. */
      readonly settlesOnAcceptance: boolean;
    }
  | {
      readonly kind: "retry";
      readonly delayMs: number;
      readonly reason: string;
      readonly endpointId: string | null;
    }
  | { readonly kind: "failed"; readonly reason: string; readonly endpointId: string | null };

const VOICE_SOS_ONLY_REASON = "voice_not_sos";
const NO_ENDPOINT_REASON = "no_verified_endpoint";
const UNEXPECTED_ERROR_REASON = "transport_error";

function isSosEligible(claim: ClaimedDelivery): boolean {
  return claim.alertCategory === "field_safety" && claim.alertSeverity === "critical";
}

function failure(reason: string, endpointId: string | null): DispatchOutcome {
  return { kind: "failed", reason, endpointId };
}

/** Turn a refusal into a retry (budget left) or a terminal failure. */
function settleRefusal(
  claim: ClaimedDelivery,
  error: unknown,
  endpointId: string,
): DispatchOutcome {
  const refusal =
    error instanceof TransportError ? error : new TransportError(UNEXPECTED_ERROR_REASON, true);
  const params = queueParametersFor(claim.channel);
  if (!refusal.retryable || !hasAttemptsLeft(params, claim.attemptCount)) {
    return failure(refusal.reason, endpointId);
  }
  const delayMs = Math.max(backoffDelayMs(params, claim.attemptCount), refusal.retryAfterMs ?? 0);
  return { kind: "retry", delayMs, reason: refusal.reason, endpointId };
}

/** Decide the fate of one claimed delivery. Never throws: every refusal is an outcome. */
export async function dispatchClaimedDelivery(
  claim: ClaimedDelivery,
  ports: DispatchPorts,
): Promise<DispatchOutcome> {
  if (claim.channel === "voice" && !isSosEligible(claim))
    return failure(VOICE_SOS_ONLY_REASON, null);

  if (claim.vendorMessageId !== null) {
    // Already handed to the vendor on an earlier attempt: re-sending would page the recipient twice.
    return {
      kind: "sent",
      vendorMessageId: claim.vendorMessageId,
      endpointId: null,
      settlesOnAcceptance: false,
    };
  }

  const destination = await ports.resolveDestination(claim);
  if (destination === null) return failure(NO_ENDPOINT_REASON, null);

  const notification = sanitizeForOutOfBand({
    alertOrMessage: {
      kind: "alert",
      alertId: claim.alertId,
      notificationDeliveryId: claim.deliveryId,
      category: claim.alertCategory,
      payload: {},
    },
    channel: claim.channel,
    recipientUserId: claim.recipientUserId,
    baseUrl: ports.appBaseUrl,
  });

  try {
    const result = await ports.transports[claim.channel].send({
      notification,
      destination: destination.value,
    });
    return {
      kind: "sent",
      vendorMessageId: result.vendorMessageId,
      endpointId: destination.endpointId,
      settlesOnAcceptance: result.settlesOnAcceptance,
    };
  } catch (error) {
    return settleRefusal(claim, error, destination.endpointId);
  }
}
