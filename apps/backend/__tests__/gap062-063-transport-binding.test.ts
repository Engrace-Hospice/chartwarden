// GAP-062 / GAP-063 — the env-gated binding of the out-of-band vendor transports and the endpoint-verification
// sender. Driven with a fake fetch; the real adapters' wire behaviour is covered in packages/messaging.
import { createECDH } from "node:crypto";
import { TRANSPORT_NOT_CONFIGURED, sanitizeForOutOfBand } from "@wardenx/messaging";
import { WardenXError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { bindOutOfBandTransports } from "../src/modules/36-messaging/delivery/transport-binding";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";

const NOTIFICATION = sanitizeForOutOfBand({
  alertOrMessage: {
    kind: "alert",
    alertId: "a-1",
    notificationDeliveryId: "d-1",
    category: "field_safety",
    payload: {},
  },
  channel: "sms",
  recipientUserId: "u-1",
  baseUrl: "https://app.example.test",
});

const vapid = (() => {
  const k = createECDH("prime256v1");
  k.generateKeys();
  return {
    VAPID_PUBLIC_KEY: k.getPublicKey().toString("base64url"),
    VAPID_PRIVATE_KEY: k.getPrivateKey().toString("base64url"),
    VAPID_SUBJECT: "mailto:ops@example.test",
  };
})();

const FULL_ENV = {
  TWILIO_ACCOUNT_SID: "AC1",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_SMS_FROM: "+15550001111",
  TWILIO_VOICE_FROM: "+15550002222",
  MESSAGING_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test/",
  POSTMARK_SERVER_TOKEN: "pm",
  POSTMARK_FROM_ADDRESS: "alerts@example.test",
  POSTMARK_SENDER_VERIFIED: "true",
  ...vapid,
};

function recordingFetch() {
  const calls: { url: string; body: string }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: typeof init.body === "string" ? init.body : "" });
    const json = url.includes("postmarkapp")
      ? { ErrorCode: 0, MessageID: "pm-1" }
      : { sid: url.includes("Calls") ? "CA1" : "SM1" };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  return { fetch, calls };
}

async function denied(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ reason: TRANSPORT_NOT_CONFIGURED, retryable: false });
}

describe("bindOutOfBandTransports", () => {
  it("with nothing configured every channel stays on the deny transport and SOS voice is flagged unavailable", async () => {
    const logs: string[] = [];
    const b = bindOutOfBandTransports({ env: {}, log: (l) => logs.push(l) });
    expect(b.bound).toEqual({ push: false, sms: false, voice: false, email: false });
    expect(b.sosVoiceAvailable).toBe(false);
    for (const c of ["push", "sms", "voice", "email"] as const)
      await denied(b.transports[c].send({ notification: NOTIFICATION, destination: "x" }));
    expect(logs.some((l) => l.includes("SOS voice escalation is UNAVAILABLE"))).toBe(true);
    expect(logs.join("\n")).toContain("TWILIO_VOICE_FROM");
  });

  it("binds every real adapter when fully configured and the SOS voice path places a call", async () => {
    const f = recordingFetch();
    const logs: string[] = [];
    const b = bindOutOfBandTransports({ env: FULL_ENV, log: (l) => logs.push(l), fetch: f.fetch });
    expect(b.bound).toEqual({ push: true, sms: true, voice: true, email: true });
    expect(b.sosVoiceAvailable).toBe(true);
    expect(logs).toEqual([]);

    const call = await b.transports.voice.send({
      notification: NOTIFICATION,
      destination: "+15553334444",
    });
    expect(call.vendorMessageId).toBe("CA1");
    expect(f.calls[0]?.url).toContain("/Calls.json");
    expect(new URLSearchParams(f.calls[0]?.body).get("StatusCallback")).toBe(
      "https://api.example.test/webhooks/twilio/voice-status",
    );

    const sms = await b.transports.sms.send({
      notification: NOTIFICATION,
      destination: "+15553334444",
    });
    expect(sms.vendorMessageId).toBe("SM1");
    expect(new URLSearchParams(f.calls[1]?.body).get("StatusCallback")).toBe(
      "https://api.example.test/webhooks/twilio/sms-status",
    );
    const email = await b.transports.email.send({
      notification: NOTIFICATION,
      destination: "rn@example.test",
    });
    expect(email.vendorMessageId).toBe("pm-1");
  });

  it("binds channels independently: Twilio missing its public callback base never half-binds sms/voice", async () => {
    const { MESSAGING_WEBHOOK_PUBLIC_BASE_URL: _drop, ...env } = FULL_ENV;
    const b = bindOutOfBandTransports({ env, log: () => {} });
    expect(b.bound).toEqual({ push: true, sms: false, voice: false, email: true });
    expect(b.missing.sms).toContain("MESSAGING_WEBHOOK_PUBLIC_BASE_URL");
  });

  it("rejects a malformed E.164 sender and a malformed VAPID pair without throwing at boot", () => {
    const b = bindOutOfBandTransports({
      env: {
        ...FULL_ENV,
        TWILIO_SMS_FROM: "555-0001",
        VAPID_PUBLIC_KEY: "abc",
        VAPID_PRIVATE_KEY: "def",
      },
      log: () => {},
    });
    expect(b.bound.sms).toBe(false);
    expect(b.bound.push).toBe(false);
    expect(b.missing.sms.join()).toContain("invalid E.164");
  });
});

describe("sendEndpointVerificationCode (GAP-063)", () => {
  it("delivers the code by SMS through the bound adapter, without a status callback", async () => {
    const f = recordingFetch();
    const b = bindOutOfBandTransports({ env: FULL_ENV, log: () => {}, fetch: f.fetch });
    await b.sendEndpointVerificationCode({
      channel: "sms",
      target: "+15553334444",
      code: "123456",
    });
    const form = new URLSearchParams(f.calls[0]?.body);
    expect(form.get("To")).toBe("+15553334444");
    expect(form.get("Body")).toContain("123456");
    expect(form.has("StatusCallback")).toBe(false);
  });

  it("delivers the code by email through Postmark", async () => {
    const f = recordingFetch();
    const b = bindOutOfBandTransports({ env: FULL_ENV, log: () => {}, fetch: f.fetch });
    await b.sendEndpointVerificationCode({
      channel: "email",
      target: "rn@example.test",
      code: "654321",
    });
    const body = JSON.parse(f.calls[0]?.body ?? "{}");
    expect(body.To).toBe("rn@example.test");
    expect(body.TextBody).toContain("654321");
  });

  it("answers a clear 503 when that channel's provider is not bound (never silently pending)", async () => {
    const b = bindOutOfBandTransports({ env: {}, log: () => {} });
    for (const channel of ["sms", "email"] as const) {
      const err = await b
        .sendEndpointVerificationCode({ channel, target: "x", code: "111111" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WardenXError);
      expect(err).toMatchObject({ code: "ENDPOINT_VERIFICATION_UNAVAILABLE" });
    }
  });

  it("maps a vendor refusal to a generic 503 that does not echo the vendor detail", async () => {
    const b = bindOutOfBandTransports({
      env: FULL_ENV,
      log: () => {},
      fetch: async () =>
        new Response(JSON.stringify({ code: 21211, message: "bad number +1555" }), { status: 400 }),
    });
    const err = await b
      .sendEndpointVerificationCode({ channel: "sms", target: "+1", code: "111111" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ENDPOINT_VERIFICATION_DELIVERY_FAILED" });
    expect(String((err as Error).message)).not.toContain("21211");
  });
});

describe("registerEndpoint without a verification sender (GAP-063)", () => {
  it("refuses sms and email with a 503 before touching the database", async () => {
    const svc = createDbMessagingRouteService({} as never);
    for (const channel of ["sms", "email"] as const) {
      await expect(
        svc.registerEndpoint("org", "user", { channel, target: "x" }),
      ).rejects.toMatchObject({ code: "ENDPOINT_VERIFICATION_UNAVAILABLE", statusCode: 503 });
    }
  });
});
