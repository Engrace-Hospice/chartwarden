// apps/backend/__tests__/messaging-webhooks.test.ts — M36-T08 inbound webhook route integration
// tests (M36 spec §4.9; SD-056 / INT-016). Exercises the §4.9 two-layer defense end-to-end through
// the M1 host via Fastify `inject`: buildServer() mounts the foundation host (incl. the error
// handler that renders WebhookError → its status), registerMessagingWebhookRoutes() mounts the
// three vendor callbacks over an in-memory reconcile service. A correctly-signed, fresh Twilio
// callback is accepted (204) and reconciled; a forged signature, a stale timestamp, a non-Postmark
// IP, and a bad bearer are each rejected before the service is touched.
import { computeTwilioSignature } from "@chartwarden/messaging";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type MessagingWebhookService,
  type VendorDeliveryUpdate,
  registerMessagingWebhookRoutes,
} from "../src/modules/36-messaging/index";

const BASE = "https://api.test";
const AUTH_TOKEN = "twilio_test_token";
const POSTMARK_TOKEN = "postmark_test_token";

function makeServer() {
  const sms: VendorDeliveryUpdate[] = [];
  const voice: VendorDeliveryUpdate[] = [];
  const postmark: VendorDeliveryUpdate[] = [];
  const service: MessagingWebhookService = {
    recordTwilioSmsStatus: async (u) => void sms.push(u),
    recordTwilioVoiceStatus: async (u) => void voice.push(u),
    recordPostmarkEvent: async (u) => void postmark.push(u),
  };
  const app = buildServer();
  registerMessagingWebhookRoutes(app, {
    publicBaseUrl: BASE,
    resolveTwilioAuthToken: () => AUTH_TOKEN,
    resolvePostmarkToken: () => POSTMARK_TOKEN,
    isPostmarkSourceAllowed: (ip) => ip === "1.2.3.4",
    service,
  });
  return { app, captured: { sms, voice, postmark } };
}

/** A fresh Twilio epoch-seconds string (inside the ±300s replay window). */
function freshEpoch(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("M36-T08 Twilio SMS-status webhook (§4.9)", () => {
  it("accepts a correctly-signed, fresh callback and reconciles the delivery", async () => {
    const { app, captured } = makeServer();
    const body = { MessageSid: "SM1", MessageStatus: "delivered" };
    const signature = computeTwilioSignature(
      `${BASE}/webhooks/twilio/sms-status`,
      body,
      AUTH_TOKEN,
    );
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/sms-status",
      headers: { "x-twilio-timestamp": freshEpoch(), "x-twilio-signature": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(204);
    expect(captured.sms).toEqual([{ vendorMessageId: "SM1", status: "delivered", raw: body }]);
  });

  it("rejects a forged signature (401) before touching the service", async () => {
    const { app, captured } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/sms-status",
      headers: { "x-twilio-timestamp": freshEpoch(), "x-twilio-signature": "forged" },
      payload: { MessageSid: "SM1", MessageStatus: "delivered" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_SIGNATURE");
    expect(captured.sms).toHaveLength(0);
  });

  it("rejects a stale timestamp (400) before signature verification", async () => {
    const { app, captured } = makeServer();
    const body = { MessageSid: "SM1", MessageStatus: "delivered" };
    const signature = computeTwilioSignature(
      `${BASE}/webhooks/twilio/sms-status`,
      body,
      AUTH_TOKEN,
    );
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/sms-status",
      headers: { "x-twilio-timestamp": stale, "x-twilio-signature": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("REPLAY_WINDOW_EXPIRED");
    expect(captured.sms).toHaveLength(0);
  });
});

describe("M36-T08 Postmark event webhook (§4.9 / INT-016)", () => {
  it("accepts a valid token from an allowlisted IP", async () => {
    const { app, captured } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/postmark/event",
      remoteAddress: "1.2.3.4",
      headers: {
        date: new Date().toUTCString(),
        authorization: `Bearer ${POSTMARK_TOKEN}`,
      },
      payload: { MessageID: "pm1", RecordType: "Delivery" },
    });
    expect(res.statusCode).toBe(204);
    expect(captured.postmark).toEqual([
      {
        vendorMessageId: "pm1",
        status: "Delivery",
        raw: { MessageID: "pm1", RecordType: "Delivery" },
      },
    ]);
  });

  it("rejects a valid token from a non-allowlisted IP (403)", async () => {
    const { app, captured } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/postmark/event",
      remoteAddress: "9.9.9.9",
      headers: { date: new Date().toUTCString(), authorization: `Bearer ${POSTMARK_TOKEN}` },
      payload: { MessageID: "pm1", RecordType: "Delivery" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_SOURCE");
    expect(captured.postmark).toHaveLength(0);
  });

  it("rejects a bad bearer token from an allowlisted IP (401)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/postmark/event",
      remoteAddress: "1.2.3.4",
      headers: { date: new Date().toUTCString(), authorization: "Bearer wrong_token_value" },
      payload: { MessageID: "pm1", RecordType: "Delivery" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_BEARER_TOKEN");
  });
});
