// GAP-062 — the real out-of-band vendor transports, driven against a fake `fetch` (no network).
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TransportError,
  buildVapidAuthorization,
  createPostmarkAlertEmailTransport,
  createTwilioSmsTransport,
  createTwilioVoiceTransport,
  createWebPushTransport,
  encryptWebPushPayload,
  sanitizeForEmergencyContactCall,
  sanitizeForOutOfBand,
  sendPostmarkEmail,
  sendTwilioSms,
} from "../src/index";

// Issued by the real sanitizer: the renderer (WP 4.7) trusts only notifications it minted.
const NOTIFICATION = sanitizeForOutOfBand({
  alertOrMessage: {
    kind: "alert",
    alertId: "a-1",
    notificationDeliveryId: "d-1",
    category: "field_safety",
    payload: {},
  },
  channel: "push",
  recipientUserId: "u-1",
  baseUrl: "https://app.example.test",
});

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const c = { url, init };
    calls.push(c);
    return respond(c);
  };
  return { fetch, calls };
}
const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

async function rejection(p: Promise<unknown>): Promise<TransportError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError);
    return e as TransportError;
  }
  throw new Error("expected a TransportError");
}

describe("Twilio SMS transport", () => {
  const base = {
    accountSid: "AC123",
    authToken: "secret-token",
    sender: { kind: "number", from: "+15550001111" } as const,
    statusCallbackUrl: "https://api.example.test/webhooks/twilio/sms-status",
  };

  it("posts a form-encoded message with basic auth and returns the message SID", async () => {
    const f = fakeFetch(() => json(201, { sid: "SM999" }));
    const t = createTwilioSmsTransport({ ...base, fetch: f.fetch });
    const out = await t.send({ notification: NOTIFICATION, destination: "+15552223333" });
    expect(out).toEqual({ vendorMessageId: "SM999", settlesOnAcceptance: false });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("AC123:secret-token").toString("base64")}`,
    );
    const form = new URLSearchParams(String(call.init.body));
    expect(form.get("To")).toBe("+15552223333");
    expect(form.get("From")).toBe("+15550001111");
    expect(form.get("StatusCallback")).toBe(base.statusCallbackUrl);
    expect(form.get("Body")).toBe(`${NOTIFICATION.short} ${NOTIFICATION.deepLink}`);
  });

  it("uses a Messaging Service SID instead of From when configured", async () => {
    const f = fakeFetch(() => json(201, { sid: "SM1" }));
    await sendTwilioSms(
      {
        ...base,
        sender: { kind: "messaging_service", messagingServiceSid: "MG1" },
        fetch: f.fetch,
      },
      { to: "+15552223333", text: "x" },
    );
    const form = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(form.get("MessagingServiceSid")).toBe("MG1");
    expect(form.has("From")).toBe(false);
  });

  it("classifies 429 (with Retry-After) and 5xx as retryable, other 4xx as terminal", async () => {
    const t = (status: number, headers?: Record<string, string>, body: unknown = { code: 21211 }) =>
      createTwilioSmsTransport({
        ...base,
        fetch: fakeFetch(() => json(status, body, headers)).fetch,
      }).send({ notification: NOTIFICATION, destination: "+1" });
    const limited = await rejection(t(429, { "retry-after": "7" }));
    expect(limited.retryable).toBe(true);
    expect(limited.retryAfterMs).toBe(7000);
    expect((await rejection(t(503))).retryable).toBe(true);
    const rejected = await rejection(t(400));
    expect(rejected.retryable).toBe(false);
    expect(rejected.reason).toBe("twilio_rejected:400:21211");
  });

  it("treats a network failure as retryable and never puts a destination or credential in the reason", async () => {
    const t = createTwilioSmsTransport({
      ...base,
      fetch: async () => {
        throw new Error("ECONNRESET +15552223333 secret-token");
      },
    });
    const err = await rejection(
      t.send({ notification: NOTIFICATION, destination: "+15552223333" }),
    );
    expect(err.retryable).toBe(true);
    expect(err.reason).toBe("twilio_unreachable");
    expect(JSON.stringify(err.reason)).not.toContain("secret-token");
  });

  it("a 2xx without a SID is a terminal fault, not a success", async () => {
    const t = createTwilioSmsTransport({ ...base, fetch: fakeFetch(() => json(201, {})).fetch });
    const err = await rejection(t.send({ notification: NOTIFICATION, destination: "+1" }));
    expect(err).toMatchObject({ reason: "twilio_invalid_response", retryable: false });
  });
});

describe("Twilio voice transport (Tier-1 SOS)", () => {
  it("places a call speaking only the escaped sanitized script, with the voice status callback", async () => {
    const f = fakeFetch(() => json(201, { sid: "CA555" }));
    const t = createTwilioVoiceTransport({
      accountSid: "AC123",
      authToken: "tok",
      from: "+15550002222",
      statusCallbackUrl: "https://api.example.test/webhooks/twilio/voice-status",
      fetch: f.fetch,
    });
    const out = await t.send({
      notification: sanitizeForEmergencyContactCall({
        idempotencyKey: "k-1",
        agencyName: "Harbor & Sons",
        subjectDisplayName: "Sam",
      }),
      destination: "+15553334444",
    });
    expect(out).toEqual({ vendorMessageId: "CA555", settlesOnAcceptance: false });
    expect(f.calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    const form = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(form.get("To")).toBe("+15553334444");
    expect(form.get("StatusCallback")).toBe(
      "https://api.example.test/webhooks/twilio/voice-status",
    );
    const twiml = form.get("Twiml") ?? "";
    expect(twiml).toContain("Harbor &amp; Sons");
    expect(twiml).not.toContain("Harbor & Sons");
    expect(twiml).not.toContain(NOTIFICATION.deepLink);
  });
});

describe("Postmark alert email transport", () => {
  const opts = { serverToken: "pm-token", from: "alerts@example.test", messageStream: "outbound" };

  it("posts the sanitized notification and returns the MessageID (no tracking)", async () => {
    const f = fakeFetch(() => json(200, { ErrorCode: 0, MessageID: "pm-abc" }));
    const t = createPostmarkAlertEmailTransport({ ...opts, fetch: f.fetch });
    const out = await t.send({ notification: NOTIFICATION, destination: "rn@example.test" });
    expect(out).toEqual({ vendorMessageId: "pm-abc", settlesOnAcceptance: false });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.postmarkapp.com/email");
    expect((call.init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe(
      "pm-token",
    );
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({ To: "rn@example.test", TrackOpens: false, TrackLinks: "None" });
    expect(body.TextBody).toContain(NOTIFICATION.deepLink);
  });

  it("classifies a 422 as terminal with the Postmark error code and a 5xx as retryable", async () => {
    const send = (status: number) =>
      sendPostmarkEmail(
        { ...opts, fetch: fakeFetch(() => json(status, { ErrorCode: 406 })).fetch },
        { to: "x@example.test", subject: "s", text: "t" },
      );
    expect(await rejection(send(422))).toMatchObject({
      reason: "postmark_rejected:422:406",
      retryable: false,
    });
    expect((await rejection(send(500))).retryable).toBe(true);
  });
});

// ── Web Push ──────────────────────────────────────────────────────────────────────────────────────
const b64u = (b: Buffer) => b.toString("base64url");

function receiverKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey(), auth: Buffer.from("0123456789abcdef") };
}

/** The RFC 8291 §3.4 receiver side, implemented independently of the sender under test. */
function decryptAes128gcm(body: Buffer, rx: ReturnType<typeof receiverKeys>): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = rx.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), rx.p256dh, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, rx.auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.subarray(0, padded.length - 1).toString("utf8");
}

describe("Web Push transport", () => {
  it("matches the RFC 8291 Appendix A test vector byte for byte", () => {
    const asEcdh = createECDH("prime256v1");
    asEcdh.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
    const body = encryptWebPushPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        p256dh: Buffer.from(
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
          "base64url",
        ),
        auth: Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url"),
      },
      { ecdh: asEcdh, salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url") },
    );
    expect(b64u(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  function vapidPair() {
    const k = createECDH("prime256v1");
    k.generateKeys();
    return { pub: b64u(k.getPublicKey()), priv: b64u(k.getPrivateKey()), ecdh: k };
  }

  it("delivers an encrypted sanitized payload with a verifiable VAPID signature and settles on acceptance", async () => {
    const rx = receiverKeys();
    const vapid = vapidPair();
    const f = fakeFetch(
      () =>
        new Response(null, { status: 201, headers: { location: "https://push.example.test/m/1" } }),
    );
    const t = createWebPushTransport({
      vapidPublicKey: vapid.pub,
      vapidPrivateKey: vapid.priv,
      subject: "mailto:ops@example.test",
      fetch: f.fetch,
      now: () => new Date("2026-10-08T12:00:00Z"),
    });
    const destination = JSON.stringify({
      endpoint: "https://push.example.test/send/abc",
      keys: { p256dh: b64u(rx.p256dh), auth: b64u(rx.auth) },
    });
    const out = await t.send({ notification: NOTIFICATION, destination });
    expect(out).toEqual({
      vendorMessageId: "https://push.example.test/m/1",
      settlesOnAcceptance: true,
    });

    const call = f.calls[0]!;
    expect(call.url).toBe("https://push.example.test/send/abc");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(JSON.parse(decryptAes128gcm(Buffer.from(call.init.body as Uint8Array), rx))).toEqual({
      id: "d-1",
      title: "WardenX",
      short: NOTIFICATION.short,
      deepLink: NOTIFICATION.deepLink,
    });

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization ?? "");
    expect(match?.[2]).toBe(vapid.pub);
    const [h, c, sig] = (match?.[1] ?? "").split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({
      aud: "https://push.example.test",
      sub: "mailto:ops@example.test",
    });
    const pubKey = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64u(vapid.ecdh.getPublicKey().subarray(1, 33)),
        y: b64u(vapid.ecdh.getPublicKey().subarray(33, 65)),
      },
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key: pubKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig!, "base64url"),
      ),
    ).toBe(true);
  });

  it("treats a gone subscription (410) as terminal, a push-service 503 as retryable, a bad destination as terminal", async () => {
    const rx = receiverKeys();
    const vapid = vapidPair();
    const mk = (status: number) =>
      createWebPushTransport({
        vapidPublicKey: vapid.pub,
        vapidPrivateKey: vapid.priv,
        subject: "mailto:ops@example.test",
        fetch: fakeFetch(() => new Response(null, { status })).fetch,
      });
    const destination = JSON.stringify({
      endpoint: "https://push.example.test/send/abc",
      keys: { p256dh: b64u(rx.p256dh), auth: b64u(rx.auth) },
    });
    expect(
      await rejection(mk(410).send({ notification: NOTIFICATION, destination })),
    ).toMatchObject({
      reason: "webpush_rejected:410",
      retryable: false,
    });
    expect(
      (await rejection(mk(503).send({ notification: NOTIFICATION, destination }))).retryable,
    ).toBe(true);
    expect(
      await rejection(mk(201).send({ notification: NOTIFICATION, destination: "not-json" })),
    ).toMatchObject({ reason: "push_destination_invalid", retryable: false });
    expect(
      await rejection(
        mk(201).send({
          notification: NOTIFICATION,
          destination: JSON.stringify({
            endpoint: "http://insecure.example.test/x",
            keys: { p256dh: b64u(rx.p256dh), auth: b64u(rx.auth) },
          }),
        }),
      ),
    ).toMatchObject({ reason: "push_destination_invalid" });
  });

  it("refuses to construct with a malformed VAPID key pair", () => {
    expect(() =>
      createWebPushTransport({
        vapidPublicKey: "abc",
        vapidPrivateKey: "def",
        subject: "mailto:a@b.test",
      }),
    ).toThrow(/VAPID/);
    expect(() =>
      buildVapidAuthorization(
        { vapidPublicKey: "abc", vapidPrivateKey: "def", subject: "x" },
        "https://a.test",
        0,
      ),
    ).toThrow();
  });
});
