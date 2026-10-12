// @wardenx/messaging — out-of-band transport SEAMS (M36 GAP-101, spec §4.4 / §4.7).
//
// The push / SMS / voice / email vendors (web-push, Twilio, Postmark) are EXTERNAL. M36 owns the dispatch
// policy; the vendor call itself sits behind these four ports, and the ONLY thing that may cross them is a
// {@link SanitizedNotification} (§4.7 — an id, one generic line and a content-free deep link). A transport
// never sees a message body, a patient name or an alert payload.
//
// NOTHING HERE TALKS TO A VENDOR. The production binding today is {@link createDenyTransports}: it refuses
// every send with a NON-retryable `transport_not_configured`, so a delivery settles `failed` (and raises
// `m36.notification.delivery_failed`) instead of sitting `pending` forever or being reported as sent. A real
// adapter implements {@link OutOfBandTransport} and is injected at the composition root.
import type { SanitizedNotification } from "../notification/sanitize";

/** The four out-of-band channels a transport serves. */
export type OutOfBandTransportChannel = "push" | "sms" | "voice" | "email";

/** What a transport is asked to send: the sanitized notification + the resolved destination. */
export interface TransportSendRequest {
  readonly notification: SanitizedNotification;
  /** Web-push subscription | E.164 number | email address — the verified endpoint's value. */
  readonly destination: string;
}

/** A vendor accepted the send. `vendorMessageId` is the id the webhook correlates back on (SID / MessageID). */
export interface TransportSendResult {
  readonly vendorMessageId: string;
  /**
   * True when the vendor's acceptance IS the only delivery confirmation the channel offers (web-push has no
   * delivery callback), so the row may settle `delivered` on acceptance. False for SMS/voice/email, whose
   * `delivered` comes from the vendor webhook.
   */
  readonly settlesOnAcceptance: boolean;
}

/** A transport refusal. `retryable` decides retry-with-backoff vs terminal failure. */
export class TransportError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
    /** A vendor `Retry-After` (429), honoured as a floor under the queue backoff. */
    readonly retryAfterMs?: number,
  ) {
    super(reason);
    this.name = "TransportError";
  }
}

/** One vendor transport. Throws {@link TransportError}; any other throw is treated as retryable. */
export interface OutOfBandTransport {
  send(request: TransportSendRequest): Promise<TransportSendResult>;
}

export type OutOfBandTransports = { readonly [C in OutOfBandTransportChannel]: OutOfBandTransport };

/** The reason code a deny-stub fails with (stable: ops dashboards and the delivery_failed consumers key on it). */
export const TRANSPORT_NOT_CONFIGURED = "transport_not_configured";

/** A transport that refuses every send, terminally. The fail-closed production default. */
export function createDenyTransport(): OutOfBandTransport {
  return {
    send: () => Promise.reject(new TransportError(TRANSPORT_NOT_CONFIGURED, false)),
  };
}

export function createDenyTransports(): OutOfBandTransports {
  return {
    push: createDenyTransport(),
    sms: createDenyTransport(),
    voice: createDenyTransport(),
    email: createDenyTransport(),
  };
}

/** One recorded send, for assertions. */
export interface FakeTransportCall {
  readonly channel: OutOfBandTransportChannel;
  readonly request: TransportSendRequest;
}

/**
 * Deterministic fake transports for tests ONLY (never bound in production): every send succeeds with a
 * synthetic vendor id unless `failWith` says otherwise. This is a test double, not a stand-in for a vendor.
 */
export function createFakeTransports(opts?: {
  readonly failWith?: (channel: OutOfBandTransportChannel, n: number) => TransportError | undefined;
  /** Prefixed onto the synthetic vendor ids so two fakes in one database never mint the same id. */
  readonly idPrefix?: string;
}): { transports: OutOfBandTransports; calls: FakeTransportCall[] } {
  const calls: FakeTransportCall[] = [];
  const make = (channel: OutOfBandTransportChannel): OutOfBandTransport => ({
    send: (request) => {
      calls.push({ channel, request });
      const failure = opts?.failWith?.(channel, calls.length);
      if (failure) return Promise.reject(failure);
      return Promise.resolve({
        vendorMessageId: `${opts?.idPrefix ?? "fake"}-${channel}-${calls.length}`,
        settlesOnAcceptance: channel === "push",
      });
    },
  });
  return {
    transports: {
      push: make("push"),
      sms: make("sms"),
      voice: make("voice"),
      email: make("email"),
    },
    calls,
  };
}
