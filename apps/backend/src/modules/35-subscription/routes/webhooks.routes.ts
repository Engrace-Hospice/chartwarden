// apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts — M35 (§4.3 webhook surface).
//
// The single inbound Stripe webhook route. Auth is the Stripe-Signature HMAC verification (§4.14) — NO
// user session, NO permission key, and (per §4.17) NO `Idempotency-Key` guard (the webhook is natively
// idempotent: the handler dedups on the Stripe event id). The route is a thin transport shim: it reads the
// RAW request body + the `stripe-signature` header and calls the injected {@link M35WebhookIngest} handler
// (the composition root binds it over the §4.14 `ingestStripeWebhook` core + a Drizzle
// `stripe_webhook_event` store + the D15 envelope encryptor + `STRIPE_WEBHOOK_SECRET`, run under the
// platform runner + the in-tx outbox publish). It then maps the {@link WebhookIngestResult} kind onto the
// Stripe-TOS reply codes (401 invalid / 410 too-old / 200 duplicate|accepted). The payload is NEVER logged.
//
// Until a live Stripe credential + DEK are bound, `ingest` is unset and the route fails closed (503) — the
// verifier/store/encryptor wiring is the remaining live-transport follow-up; the ROUTE is complete.
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** The §4.3 verified-webhook result kind the route maps onto an HTTP reply code. */
export type M35WebhookResultKind = "invalid_signature" | "too_old" | "duplicate" | "accepted";

/** The composition-root-bound ingest handler: verify → replay-window → dedup+persist → publish → kind. */
export type M35WebhookIngest = (input: {
  readonly rawBody: string;
  readonly signatureHeader: string | undefined;
}) => Promise<{ readonly kind: M35WebhookResultKind }>;

export interface WebhookRouteDeps {
  /** The bound §4.14 ingest handler; unset ⇒ the route fails closed (503) until the live transport binds. */
  readonly ingest?: M35WebhookIngest;
}

/** Best-effort raw-body access for HMAC verification (the exact bytes Stripe signed). */
function rawBodyOf(request: FastifyRequest): string {
  const raw = (request as { rawBody?: unknown }).rawBody;
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (typeof request.body === "string") return request.body;
  return request.body === undefined ? "" : JSON.stringify(request.body);
}

/** Register the §4.3 inbound Stripe webhook route. */
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  // POST /v1/webhooks/stripe — inbound Stripe webhook (Stripe-Signature HMAC; no user session). §4.3.
  app.post("/api/v1/webhooks/stripe", async (request, reply) => {
    if (!deps.ingest) {
      throw new WardenXError(
        "STRIPE_WEBHOOK_UNCONFIGURED",
        "the Stripe webhook transport is not configured",
        503,
      );
    }
    const sigHeader = request.headers["stripe-signature"];
    const signatureHeader = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const result = await deps.ingest({ rawBody: rawBodyOf(request), signatureHeader });
    switch (result.kind) {
      case "invalid_signature":
        return reply.code(401).send({ received: false });
      case "too_old":
        return reply.code(410).send({ received: false });
      // Stripe's TOS wants a fast 200 even on a replay; `accepted` also 200.
      default:
        return reply.code(200).send({ received: true });
    }
  });
}
