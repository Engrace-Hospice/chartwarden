// apps/backend/src/modules/23-billing-medicare/claimmd-webhook/routes.ts — the Claim.MD webhook ingress (ADR-0053
// amendment D7). POST /api/v1/webhooks/claimmd/<usage>: no session, no permission, no Idempotency-Key (Claim.MD
// dedupes on (acct_number, eventid) and so do we); the `Auth-Signature-Base64` HMAC is the only credential. The prefix is
// CSRF-exempt (bootstrap/plugins/csrf.ts) and rides the anonymous per-IP rate tier (a 429 stores nothing; Claim.MD
// retries).
//
//   * Only the usage whose key this process holds is mounted, so a test-account delivery can never land as production.
//   * Unconfigured (no key, payload key, platform pool, or CLAIMMD_WEBHOOK_ENABLED != true) → 503
//     CLAIMMD_WEBHOOK_UNCONFIGURED from onRequest, before the body is read.
//   * Every signature failure is the same 401 INVALID_SIGNATURE. The HMAC runs over the raw Buffer: this scope drops
//     the JSON parser and reads every content type as bytes.
//   * After a valid signature content is never refused: 200 {received:n} once one transaction stored the whole batch;
//     a database failure is a 5xx (Claim.MD retries at least 30 minutes later, for up to 4 days).
import { ChartWardenError } from "@chartwarden/types";
import { verifyClaimMdSignature } from "@chartwarden/x12-837-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ClaimMdReceive, ClaimMdUsage } from "./receipt-store";

/** Claim.MD sends at most 100 events a delivery; 1 MiB is far above that and bounds an abusive body. */
export const CLAIMMD_WEBHOOK_BODY_LIMIT = 1024 * 1024;

export interface ClaimMdWebhookBinding {
  readonly usage: ClaimMdUsage;
  readonly accountKey: string;
  readonly receive: ClaimMdReceive;
}

export interface ClaimMdWebhookRouteDeps {
  /** Bound only when every prerequisite is present; null → every mounted path answers 503. */
  readonly binding: ClaimMdWebhookBinding | null;
  /** The configured usage even when unbound (mounts just that path); absent → both paths answer 503. */
  readonly usage?: ClaimMdUsage | null;
}

const unconfigured = async (): Promise<void> => {
  throw new ChartWardenError(
    "CLAIMMD_WEBHOOK_UNCONFIGURED",
    "the Claim.MD webhook is not configured",
    503,
  );
};

const invalidSignature = () =>
  new ChartWardenError("INVALID_SIGNATURE", "the webhook signature did not verify", 401);

export function registerClaimMdWebhookRoutes(
  app: FastifyInstance,
  deps: ClaimMdWebhookRouteDeps,
): void {
  const binding = deps.binding;
  const usage = binding?.usage ?? deps.usage ?? null;
  // The raw body and the signature header are passed in by each route call (so the fitness gates see them read there).
  const handle = async (body: unknown, header: unknown, reply: FastifyReply) => {
    if (!binding) return unconfigured();
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    if (!verifyClaimMdSignature(binding.accountKey, rawBody, header)) throw invalidSignature();
    const received = await binding.receive({ usage: binding.usage, rawBody });
    return reply.code(200).send({ received });
  };
  const options = {
    bodyLimit: CLAIMMD_WEBHOOK_BODY_LIMIT,
    ...(binding ? {} : { onRequest: unconfigured }),
  };

  void app.register(async (scope) => registerInScope(scope));

  function registerInScope(app: FastifyInstance): void {
    // The signature covers the exact bytes: no JSON (or any other) parsing in this scope, every content type is a Buffer.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: CLAIMMD_WEBHOOK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );
    if (usage !== "production") {
      app.post("/api/v1/webhooks/claimmd/test", options, (request: FastifyRequest, reply) =>
        handle(request.body, request.headers["auth-signature-base64"], reply),
      );
    }
    if (usage !== "test") {
      app.post("/api/v1/webhooks/claimmd/production", options, (request: FastifyRequest, reply) =>
        handle(request.body, request.headers["auth-signature-base64"], reply),
      );
    }
  }
}
