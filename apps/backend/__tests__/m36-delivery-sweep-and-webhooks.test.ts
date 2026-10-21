// M36 GAP-101 — the delivery sweep (claim -> dispatch -> settle, isolation, bounds) and the §4.9 webhook mount
// (fail-closed 503, replay window, signature auth, urlencoded body, forward to the reconcile service).
import {
  type ClaimedDelivery,
  TransportError,
  computeTwilioSignature,
  createFakeTransports,
} from "@chartwarden/messaging";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { DeliveryDispatchStore } from "../src/modules/36-messaging/delivery/delivery-dispatch-store-db";
import { runDeliverySweep } from "../src/modules/36-messaging/delivery/delivery-sweep";
import { mountMessagingWebhookRoutes } from "../src/modules/36-messaging/delivery/webhook-mount";
import type { VendorDeliveryUpdate } from "../src/modules/36-messaging/routes/webhook-routes";

const NOW = new Date("2026-10-05T12:00:00Z");

function claimFor(org: string, id: string, over: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    deliveryId: id,
    organizationId: org,
    alertId: `alert-${id}`,
    recipientUserId: "u",
    channel: "sms",
    alertCategory: "clinical_urgent",
    alertSeverity: "critical",
    attemptCount: 1,
    vendorMessageId: null,
    ...over,
  };
}

function memoryStore(
  queue: Record<string, ClaimedDelivery[]>,
  opts: { hasEndpoint?: boolean; throwOrg?: string } = {},
) {
  const log: string[] = [];
  const store: DeliveryDispatchStore = {
    async claimBatch(org, _channel, limit) {
      if (org === opts.throwOrg) throw new Error("org down");
      return (queue[org] ?? []).slice(0, limit);
    },
    async resolveDestination() {
      return opts.hasEndpoint === false ? null : { endpointId: "e", value: "+1555" };
    },
    async markSent(c, vendorId, _e, onAccept) {
      log.push(`sent:${c.deliveryId}:${vendorId}:${onAccept}`);
    },
    async scheduleRetry(c, reason, delay) {
      log.push(`retry:${c.deliveryId}:${reason}:${delay}`);
    },
    async markFailed(c, reason) {
      log.push(`failed:${c.deliveryId}:${reason}`);
    },
  };
  return { store, log };
}

const orgs = (...ids: string[]) => ({
  listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
});

describe("runDeliverySweep", () => {
  it("dispatches every claimed delivery and settles it through the store", async () => {
    const { store, log } = memoryStore({ o1: [claimFor("o1", "d1"), claimFor("o1", "d2")] });
    const { transports } = createFakeTransports();
    const res = await runDeliverySweep(
      { store, transports, appBaseUrl: "https://app", activeOrgs: orgs("o1"), now: () => NOW },
      "sms",
    );
    expect(res).toEqual({ claimed: 2, sent: 2, retried: 0, failed: 0, errors: 0 });
    expect(log).toEqual(["sent:d1:fake-sms-1:false", "sent:d2:fake-sms-2:false"]);
  });

  it("retries a transient vendor failure and fails a no-endpoint recipient", async () => {
    const q = { o1: [claimFor("o1", "d1")], o2: [claimFor("o2", "d2")] };
    const transient = createFakeTransports({
      failWith: () => new TransportError("vendor_5xx", true),
    });
    const a = memoryStore({ o1: q.o1 });
    const ra = await runDeliverySweep(
      {
        store: a.store,
        transports: transient.transports,
        appBaseUrl: "",
        activeOrgs: orgs("o1"),
        now: () => NOW,
      },
      "sms",
    );
    expect(ra.retried).toBe(1);
    expect(a.log[0]).toBe("retry:d1:vendor_5xx:5000");
    const b = memoryStore({ o2: q.o2 }, { hasEndpoint: false });
    const rb = await runDeliverySweep(
      {
        store: b.store,
        transports: createFakeTransports().transports,
        appBaseUrl: "",
        activeOrgs: orgs("o2"),
        now: () => NOW,
      },
      "sms",
    );
    expect(rb.failed).toBe(1);
    expect(b.log[0]).toBe("failed:d2:no_verified_endpoint");
  });

  it("one org failing does not stop the others", async () => {
    const { store, log } = memoryStore({ o2: [claimFor("o2", "d9")] }, { throwOrg: "o1" });
    const seen: string[] = [];
    const res = await runDeliverySweep(
      {
        store,
        transports: createFakeTransports().transports,
        appBaseUrl: "",
        activeOrgs: orgs("o1", "o2"),
        now: () => NOW,
        onError: (c) => seen.push(c.organizationId),
      },
      "sms",
    );
    expect(res).toMatchObject({ sent: 1, errors: 1 });
    expect(seen).toEqual(["o1"]);
    expect(log).toEqual(["sent:d9:fake-sms-1:false"]);
  });

  it("a delivery whose settle throws is counted and the rest of the batch still goes out", async () => {
    const { store, log } = memoryStore({ o1: [claimFor("o1", "d1"), claimFor("o1", "d2")] });
    const flaky: DeliveryDispatchStore = {
      ...store,
      markSent: async (c, ...rest) => {
        if (c.deliveryId === "d1") throw new Error("settle failed");
        return store.markSent(c, ...rest);
      },
    };
    const res = await runDeliverySweep(
      {
        store: flaky,
        transports: createFakeTransports().transports,
        appBaseUrl: "",
        activeOrgs: orgs("o1"),
        now: () => NOW,
      },
      "sms",
    );
    expect(res).toMatchObject({ claimed: 2, sent: 1, errors: 1 });
    expect(log).toHaveLength(1);
  });
});

describe("mountMessagingWebhookRoutes (§4.9)", () => {
  const BASE = "https://api.example.com";
  const URL_SMS = `${BASE}/webhooks/twilio/sms-status`;
  const config = {
    publicBaseUrl: BASE,
    twilioAuthToken: "tw-token",
    postmarkToken: "pm-token",
    postmarkSourceIps: ["198.51.100.7"],
  };

  async function appWith(
    cfg:
      | typeof config
      | {
          publicBaseUrl: undefined;
          twilioAuthToken: undefined;
          postmarkToken: undefined;
          postmarkSourceIps: [];
        },
  ) {
    const calls: Array<[string, VendorDeliveryUpdate]> = [];
    const app = Fastify();
    mountMessagingWebhookRoutes(app, {
      db: {} as never,
      outbox: { publish: async () => {} },
      config: cfg,
      service: {
        recordTwilioSmsStatus: async (u) => void calls.push(["sms", u]),
        recordTwilioVoiceStatus: async (u) => void calls.push(["voice", u]),
        recordPostmarkEvent: async (u) => void calls.push(["postmark", u]),
      },
    });
    await app.ready();
    return { app, calls };
  }

  const form = (body: Record<string, string>) => new URLSearchParams(body).toString();
  const ts = () => String(Math.floor(Date.now() / 1000));

  it("accepts a correctly signed urlencoded Twilio callback and forwards it", async () => {
    const { app, calls } = await appWith(config);
    const body = { MessageSid: "SM1", MessageStatus: "delivered", To: "+15551230000" };
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/sms-status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": computeTwilioSignature(URL_SMS, body, "tw-token"),
        "x-twilio-timestamp": ts(),
      },
      payload: form(body),
    });
    expect(res.statusCode).toBe(204);
    expect(calls).toEqual([
      ["sms", expect.objectContaining({ vendorMessageId: "SM1", status: "delivered" })],
    ]);
    await app.close();
  });

  it("rejects a forged signature (401), a stale timestamp (400) and a missing timestamp (400) without reconciling", async () => {
    const { app, calls } = await appWith(config);
    const body = { MessageSid: "SM1", MessageStatus: "delivered" };
    const send = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/webhooks/twilio/sms-status",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        payload: form(body),
      });
    expect(
      (await send({ "x-twilio-signature": "forged", "x-twilio-timestamp": ts() })).statusCode,
    ).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(
      (
        await send({
          "x-twilio-signature": computeTwilioSignature(URL_SMS, body, "tw-token"),
          "x-twilio-timestamp": stale,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await send({ "x-twilio-signature": computeTwilioSignature(URL_SMS, body, "tw-token") }))
        .statusCode,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("is fail-closed: with no secrets configured every vendor callback answers 503 and nothing reconciles", async () => {
    const { app, calls } = await appWith({
      publicBaseUrl: undefined,
      twilioAuthToken: undefined,
      postmarkToken: undefined,
      postmarkSourceIps: [],
    });
    const sms = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/sms-status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "x",
        "x-twilio-timestamp": ts(),
      },
      payload: form({ MessageSid: "SM1", MessageStatus: "delivered" }),
    });
    const pm = await app.inject({
      method: "POST",
      url: "/webhooks/postmark/event",
      headers: {
        "content-type": "application/json",
        date: new Date().toISOString(),
        authorization: "Bearer x",
      },
      payload: JSON.stringify({ MessageID: "m", RecordType: "Delivery" }),
    });
    expect([sms.statusCode, pm.statusCode]).toEqual([503, 503]);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("Postmark: requires the allowlisted source IP AND the bearer token", async () => {
    const { app, calls } = await appWith(config);
    const send = (remoteAddress: string, authorization: string) =>
      app.inject({
        method: "POST",
        url: "/webhooks/postmark/event",
        remoteAddress,
        headers: {
          "content-type": "application/json",
          date: new Date().toISOString(),
          authorization,
        },
        payload: JSON.stringify({ MessageID: "pm-1", RecordType: "Bounce" }),
      });
    expect((await send("203.0.113.9", "Bearer pm-token")).statusCode).toBe(403);
    expect((await send("198.51.100.7", "Bearer wrong")).statusCode).toBe(401);
    expect((await send("198.51.100.7", "Bearer pm-token")).statusCode).toBe(204);
    expect(calls).toEqual([
      ["postmark", expect.objectContaining({ vendorMessageId: "pm-1", status: "Bounce" })],
    ]);
    await app.close();
  });
});
