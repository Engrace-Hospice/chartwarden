// WP 5.11 / W6 — the native push transports (FCM v1, APNs) and the push router, driven with fakes (no network).
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ApnsRequest,
  NATIVE_PUSH_BODY,
  NATIVE_PUSH_TITLE,
  NATIVE_PUSH_TYPE,
  PUSH_TOKEN_UNREGISTERED,
  TRANSPORT_NOT_CONFIGURED,
  TransportError,
  createApnsTransport,
  createFcmTransport,
  createPushRouter,
  encodeNativeDestination,
  isValidNativePushToken,
  parseFcmServiceAccount,
  parseNativeDestination,
  sanitizeForOutOfBand,
} from "../src/index";

const NOTIFICATION = sanitizeForOutOfBand({
  alertOrMessage: {
    kind: "alert",
    alertId: "a-1",
    notificationDeliveryId: "d-1",
    category: "field_safety",
    payload: { patientName: "Jane Doe" },
  },
  channel: "push",
  recipientUserId: "u-1",
  baseUrl: "https://app.example.test",
});

const ALERT_ID = "0b6f1d3e-9c1a-4b0e-8d57-2f6f4c1a7e11";
const FCM_TOKEN = "fcm_token_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:APA91bSECRET";
const APNS_TOKEN = "ab".repeat(32);
const fcmDestination = encodeNativeDestination({
  provider: "fcm",
  token: FCM_TOKEN,
  alertId: ALERT_ID,
});
const apnsDestination = encodeNativeDestination({
  provider: "apns",
  token: APNS_TOKEN,
  alertId: ALERT_ID,
});

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rsaPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ecPem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const serviceAccount = parseFcmServiceAccount(
  JSON.stringify({
    project_id: "chartwarden-test",
    client_email: "svc@chartwarden-test.iam.gserviceaccount.com",
    private_key: rsaPem,
  }),
);

async function rejection(p: Promise<unknown>): Promise<TransportError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError);
    return e as TransportError;
  }
  throw new Error("expected a TransportError");
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("native destination", () => {
  it("round-trips and rejects anything that is not a bounded token + uuid", () => {
    expect(parseNativeDestination(fcmDestination)).toEqual({
      provider: "fcm",
      token: FCM_TOKEN,
      alertId: ALERT_ID,
    });
    expect(parseNativeDestination(apnsDestination)?.provider).toBe("apns");
    // A Web Push subscription is not a native destination.
    expect(
      parseNativeDestination(JSON.stringify({ endpoint: "https://x.test/y", keys: {} })),
    ).toBeNull();
    expect(parseNativeDestination("not json")).toBeNull();
    const bad = (o: object) => parseNativeDestination(JSON.stringify(o));
    expect(bad({ provider: "fcm", token: "short", alertId: ALERT_ID })).toBeNull();
    expect(bad({ provider: "apns", token: "zz".repeat(32), alertId: ALERT_ID })).toBeNull();
    expect(bad({ provider: "fcm", token: FCM_TOKEN, alertId: "nope" })).toBeNull();
  });

  it("validates token shape per provider", () => {
    expect(isValidNativePushToken("fcm", FCM_TOKEN)).toBe(true);
    expect(isValidNativePushToken("fcm", "has space and is long enough to pass the floor!!")).toBe(
      false,
    );
    expect(isValidNativePushToken("fcm", "a".repeat(513))).toBe(false);
    expect(isValidNativePushToken("apns", APNS_TOKEN)).toBe(true);
    expect(isValidNativePushToken("apns", "a".repeat(201))).toBe(false);
    expect(isValidNativePushToken("apns", "https://evil.test/".padEnd(40, "a"))).toBe(false);
  });
});

describe("FCM v1 transport", () => {
  it("rejects a service account without a usable key", () => {
    expect(parseFcmServiceAccount("{}")).toBeNull();
    expect(
      parseFcmServiceAccount(
        JSON.stringify({
          project_id: "chartwarden-test",
          client_email: "a@b",
          private_key: "nope",
        }),
      ),
    ).toBeNull();
  });

  function setup(sendResponse: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token")
        return json(200, { access_token: "ya29.test", expires_in: 3600 });
      return sendResponse();
    };
    const transport = createFcmTransport({ serviceAccount: serviceAccount!, fetch });
    return { transport, calls };
  }

  it("signs an RS256 assertion, sends a PHI-free data message and caches the access token", async () => {
    const { transport, calls } = setup(() => json(200, { name: "projects/p/messages/m-1" }));
    const first = await transport.send({
      notification: NOTIFICATION,
      destination: fcmDestination,
    });
    await transport.send({ notification: NOTIFICATION, destination: fcmDestination });

    expect(first).toEqual({
      vendorMessageId: "projects/p/messages/m-1",
      settlesOnAcceptance: true,
    });
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1); // cached across sends

    const assertion = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
    const [h, p, s] = assertion.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toMatchObject({ alg: "RS256" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({
      iss: "svc@chartwarden-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(
      verify("RSA-SHA256", Buffer.from(`${h}.${p}`), rsa.publicKey, Buffer.from(s!, "base64url")),
    ).toBe(true);

    const send = calls[1]!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/chartwarden-test/messages:send");
    expect((send.init.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test");
    const body = JSON.parse(String(send.init.body)).message;
    expect(body.token).toBe(FCM_TOKEN);
    expect(body.data).toEqual({ type: NATIVE_PUSH_TYPE, alertId: ALERT_ID });
    expect(body.notification).toEqual({ title: NATIVE_PUSH_TITLE, body: NATIVE_PUSH_BODY });
    // Nothing from the sanitized notification (its text or link) reaches a native payload.
    expect(JSON.stringify(body)).not.toContain(NOTIFICATION.short);
    expect(JSON.stringify(body)).not.toContain("app.example.test");
  });

  it("maps a dead token to a terminal reason that never carries the token", async () => {
    const { transport } = setup(() =>
      json(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }),
    );
    const err = await rejection(
      transport.send({ notification: NOTIFICATION, destination: fcmDestination }),
    );
    expect(err.reason).toBe(PUSH_TOKEN_UNREGISTERED);
    expect(err.retryable).toBe(false);
    expect(err.reason).not.toContain(FCM_TOKEN);
  });

  it("does not call a bare 404 (wrong project) a dead token", async () => {
    const { transport } = setup(() => json(404, { error: { status: "NOT_FOUND" } }));
    const err = await rejection(
      transport.send({ notification: NOTIFICATION, destination: fcmDestination }),
    );
    expect(err.reason).toBe("fcm_rejected:404");
    expect(err.retryable).toBe(false);
  });

  it("retries 5xx and 429, and fails other 4xx terminally", async () => {
    for (const [status, retryable] of [
      [503, true],
      [429, true],
      [403, false],
    ] as const) {
      const { transport } = setup(() => json(status, {}));
      const err = await rejection(
        transport.send({ notification: NOTIFICATION, destination: fcmDestination }),
      );
      expect(err.retryable).toBe(retryable);
    }
  });

  it("refuses an APNs or malformed destination without calling the vendor", async () => {
    const { transport, calls } = setup(() => json(200, {}));
    for (const destination of [apnsDestination, "garbage"]) {
      const err = await rejection(transport.send({ notification: NOTIFICATION, destination }));
      expect(err.reason).toBe("push_destination_invalid");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("APNs transport", () => {
  function setup(
    respond: (input: Parameters<ApnsRequest>[0]) => {
      status: number;
      body?: string;
      apnsId?: string;
    },
  ) {
    const calls: Array<Parameters<ApnsRequest>[0]> = [];
    const request: ApnsRequest = async (input) => {
      calls.push(input);
      const r = respond(input);
      return { status: r.status, apnsId: r.apnsId, body: r.body ?? "" };
    };
    const transport = createApnsTransport({
      keyP8: ecPem,
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
      bundleId: "com.example.app",
      request,
    });
    return { transport, calls };
  }

  it("sends an ES256-authenticated PHI-free alert and reuses the provider token", async () => {
    const { transport, calls } = setup(() => ({ status: 200, apnsId: "apns-id-1" }));
    const result = await transport.send({
      notification: NOTIFICATION,
      destination: apnsDestination,
    });
    await transport.send({ notification: NOTIFICATION, destination: apnsDestination });
    expect(result).toEqual({ vendorMessageId: "apns-id-1", settlesOnAcceptance: true });

    const first = calls[0]!;
    expect(first.host).toBe("api.push.apple.com");
    expect(first.path).toBe(`/3/device/${APNS_TOKEN}`);
    expect(first.headers["apns-topic"]).toBe("com.example.app");
    expect(first.headers["apns-push-type"]).toBe("alert");
    expect(calls[1]!.headers.authorization).toBe(first.headers.authorization);

    const jwt = first.headers.authorization!.replace(/^bearer /, "");
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEYID12345",
    });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString()).iss).toBe("TEAMID1234");
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s!, "base64url"),
      ),
    ).toBe(true);

    expect(JSON.parse(first.body)).toEqual({
      aps: { alert: { title: NATIVE_PUSH_TITLE, body: NATIVE_PUSH_BODY }, sound: "default" },
      type: NATIVE_PUSH_TYPE,
      alertId: ALERT_ID,
    });
  });

  it("uses the sandbox host when asked", async () => {
    const hosts: string[] = [];
    const transport = createApnsTransport({
      keyP8: ecPem,
      keyId: "K",
      teamId: "T",
      bundleId: "b",
      sandbox: true,
      request: async (i) => {
        hosts.push(i.host);
        return { status: 200, apnsId: undefined, body: "" };
      },
    });
    await transport.send({ notification: NOTIFICATION, destination: apnsDestination });
    expect(hosts).toEqual(["api.sandbox.push.apple.com"]);
  });

  it("classifies vendor refusals", async () => {
    const cases: Array<[number, string | undefined, string, boolean]> = [
      [410, undefined, PUSH_TOKEN_UNREGISTERED, false],
      [400, '{"reason":"Unregistered"}', PUSH_TOKEN_UNREGISTERED, false],
      [400, '{"reason":"BadDeviceToken"}', "apns_rejected:400:BadDeviceToken", false],
      [403, '{"reason":"InvalidProviderToken"}', "apns_rejected:403:InvalidProviderToken", false],
      [403, '{"reason":"free text with spaces"}', "apns_rejected:403", false],
      [429, undefined, "apns_rate_limited", true],
      [503, undefined, "apns_unavailable:503", true],
    ];
    for (const [status, body, reason, retryable] of cases) {
      const { transport } = setup(() => ({ status, ...(body ? { body } : {}) }));
      const err = await rejection(
        transport.send({ notification: NOTIFICATION, destination: apnsDestination }),
      );
      expect(err.reason).toBe(reason);
      expect(err.retryable).toBe(retryable);
    }
  });

  it("fails at construction on a malformed key", () => {
    expect(() =>
      createApnsTransport({ keyP8: "nope", keyId: "K", teamId: "T", bundleId: "b" }),
    ).toThrow();
  });
});

describe("push router", () => {
  const stub = (id: string) => ({
    send: async () => ({ vendorMessageId: id, settlesOnAcceptance: true }),
  });
  const webDestination = JSON.stringify({ endpoint: "https://push.example.test/x", keys: {} });

  it("sends each destination to its own provider", async () => {
    const router = createPushRouter({ web: stub("web"), fcm: stub("fcm"), apns: stub("apns") });
    const send = (destination: string) => router.send({ notification: NOTIFICATION, destination });
    expect((await send(webDestination)).vendorMessageId).toBe("web");
    expect((await send(fcmDestination)).vendorMessageId).toBe("fcm");
    expect((await send(apnsDestination)).vendorMessageId).toBe("apns");
  });

  it("settles transport_not_configured for a provider that is not bound", async () => {
    const router = createPushRouter({ web: stub("web"), fcm: stub("fcm") });
    const err = await rejection(
      router.send({ notification: NOTIFICATION, destination: apnsDestination }),
    );
    expect(err.reason).toBe(TRANSPORT_NOT_CONFIGURED);
    expect(err.retryable).toBe(false);
  });
});
