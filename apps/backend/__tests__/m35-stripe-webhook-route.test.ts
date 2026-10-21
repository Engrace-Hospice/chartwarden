// GAP-058 - the inbound Stripe webhook is no longer a permanent 503. Drives the REAL route + the REAL
// ingestion core (HMAC verify, replay window, dedup, AES-GCM payload encryption) over an in-memory event
// store, with a genuinely signed body whose whitespace differs from JSON.stringify(parsed) - the case the old
// `JSON.stringify(request.body)` fallback got wrong.
import { createHmac } from "node:crypto";
import type { StripeWebhookEventStore } from "@chartwarden/subscription-billing";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildM35WebhookIngest } from "../src/modules/35-subscription/billing-runtime/webhook-ingest";
import {
  createWebhookPayloadCipher,
  parseWebhookPayloadKey,
} from "../src/modules/35-subscription/billing-runtime/webhook-payload-crypto";
import { registerWebhookRoutes } from "../src/modules/35-subscription/routes/webhooks.routes";

const SECRET = "whsec_test_secret";
const KEY = Buffer.alloc(32, 7).toString("base64");

function signedRequest(rawBody: string, atSeconds: number, secret = SECRET) {
  const sig = createHmac("sha256", secret).update(`${atSeconds}.${rawBody}`).digest("hex");
  return {
    method: "POST" as const,
    url: "/api/v1/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": `t=${atSeconds},v1=${sig}` },
    payload: rawBody,
  };
}

function harness() {
  const rows: Array<{
    id: string;
    payloadCiphertext: string;
    derivedOrganizationId: string | null;
  }> = [];
  const store: StripeWebhookEventStore = {
    async insertIfNew(row) {
      if (rows.some((r) => r.id === row.id)) return { inserted: false };
      rows.push(row);
      return { inserted: true };
    },
  };
  const cipher = createWebhookPayloadCipher(parseWebhookPayloadKey(KEY));
  const nowMs = Date.UTC(2026, 9, 8, 12, 0, 0);
  const app = Fastify();
  registerWebhookRoutes(app, {
    ingest: buildM35WebhookIngest({
      platformRunner: async () => {
        throw new Error("platform runner must not be used when a store is injected");
      },
      webhookSecret: SECRET,
      encryptor: cipher,
      nowMs: () => nowMs,
      store,
    }),
  });
  return { app, rows, cipher, nowSeconds: Math.floor(nowMs / 1000) };
}

// Deliberately NOT canonical JSON (extra spaces / newline): the signature covers these exact bytes.
const EVENT = (created: number) =>
  `{ "id": "evt_1",  "type": "invoice.paid", "created": ${created},\n "data": { "object": { "metadata": { "organization_id": "11111111-1111-4111-8111-111111111111" } } } }`;

describe("POST /api/v1/webhooks/stripe (GAP-058)", () => {
  it("accepts a correctly signed event over the exact raw bytes and stores it encrypted", async () => {
    const { app, rows, cipher, nowSeconds } = harness();
    const body = EVENT(nowSeconds);
    const res = await app.inject(signedRequest(body, nowSeconds));
    expect(res.statusCode).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.derivedOrganizationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(rows[0]?.payloadCiphertext).not.toContain("invoice.paid");
    expect(JSON.parse(cipher.decrypt(rows[0]?.payloadCiphertext ?? "")).id).toBe("evt_1");
    await app.close();
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    const { app, rows, nowSeconds } = harness();
    const res = await app.inject(signedRequest(EVENT(nowSeconds), nowSeconds, "whsec_wrong"));
    expect(res.statusCode).toBe(401);
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("rejects a body altered after signing with 401", async () => {
    const { app, rows, nowSeconds } = harness();
    const req = signedRequest(EVENT(nowSeconds), nowSeconds);
    const res = await app.inject({
      ...req,
      payload: req.payload.replace("invoice.paid", "invoice.void"),
    });
    expect(res.statusCode).toBe(401);
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("answers 200 on a replay of the same event id without a second row", async () => {
    const { app, rows, nowSeconds } = harness();
    const req = signedRequest(EVENT(nowSeconds), nowSeconds);
    expect((await app.inject(req)).statusCode).toBe(200);
    expect((await app.inject(req)).statusCode).toBe(200);
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it("stays fail-closed (503) when no ingest handler is bound", async () => {
    const app = Fastify();
    registerWebhookRoutes(app, {});
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
