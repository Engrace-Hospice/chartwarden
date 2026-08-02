// @wardenx/subscription-billing — §8.7 the typed Stripe client SHAPE (M35-T04).
//
// Mirrors `@wardenx/xero-client`'s `LiveXeroClient`: a thin, SDK-free wrapper over the injected
// {@link StripeHttpPort}. It imports NO vendor SDK and performs NO direct network I/O — every call routes
// through the injected port, so the whole `packages/subscription-billing` tree stays inside the
// VENDOR_ADAPTERS boundary even though the `stripe` npm package is never `import`ed here (the T06
// composition root is the one place a live transport — SDK-backed or hand-rolled HTTPS — is constructed).
//
// The client's ONE responsibility beyond forwarding is to carry the deterministic idempotency key onto the
// transport call. Redaction + auditing live in the dispatcher (dispatcher.ts), not here, so this stays a
// pure passthrough that is trivial to fake in a unit test.

import { STRIPE_NOT_CONFIGURED, type StripeApiRequest, type StripeApiResponse, type StripeCallOptions, type StripeHttpPort } from "./types";

/** The typed Stripe client the dispatcher calls. */
export interface StripeClient {
  execute(request: StripeApiRequest, options: StripeCallOptions): Promise<StripeApiResponse>;
}

/** SDK-free client: forwards `(request, { idempotencyKey })` to the injected transport verbatim. */
export class LiveStripeClient implements StripeClient {
  constructor(private readonly http: StripeHttpPort) {}

  execute(request: StripeApiRequest, options: StripeCallOptions): Promise<StripeApiResponse> {
    return this.http.execute(request, options);
  }
}

/**
 * The fail-closed default transport. Until T06 wires a live Stripe transport, every outbound call throws
 * {@link STRIPE_NOT_CONFIGURED} rather than silently succeeding — a mis-wired env can never appear to have
 * billed a customer. Matches `@wardenx/xero-client`'s `XERO_NOT_CONNECTED` default-port posture.
 */
export function failClosedStripeHttpPort(): StripeHttpPort {
  return {
    execute(request: StripeApiRequest): Promise<StripeApiResponse> {
      return Promise.reject(new Error(`${STRIPE_NOT_CONFIGURED}: no live Stripe transport wired for '${request.operation}'`));
    },
  };
}

/** Build a {@link StripeClient} over an explicit transport, defaulting to the fail-closed port. */
export function createStripeClient(http: StripeHttpPort = failClosedStripeHttpPort()): StripeClient {
  return new LiveStripeClient(http);
}
