/**
 * GAP-101 — M36 out-of-band delivery workers + vendor-webhook reconcile, END TO END over real Postgres.
 *
 * Nothing on the persistence side is stubbed: the dispatch store and the webhook service run as the
 * NOBYPASSRLS `chartwarden_app` role (migration 0355's SECURITY DEFINER endpoint/locator functions included)
 * through the REAL catalog-validating outbox publisher. The ONLY fakes are the vendor transports — vendors
 * are external, so a test double stands where Twilio/Postmark/web-push would.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:delivery:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import {
  PUSH_TOKEN_UNREGISTERED,
  TransportError,
  createDenyTransports,
  createFakeTransports,
} from "@chartwarden/messaging";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzleDeliveryDispatchStore } from "../src/modules/36-messaging/delivery/delivery-dispatch-store-db";
import { runDeliverySweep } from "../src/modules/36-messaging/delivery/delivery-sweep";
import { bindOutOfBandTransports } from "../src/modules/36-messaging/delivery/transport-binding";
import { createDbMessagingWebhookService } from "../src/modules/36-messaging/delivery/webhook-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";
const USER_C = "55555555-5555-5555-5555-555555555555";
let fakeSeq = 0;
/** A fake transport whose vendor ids are unique across the whole database (vendor ids are globally unique). */
const fakes = (opts?: Parameters<typeof createFakeTransports>[0]) => {
  fakeSeq += 1;
  return createFakeTransports({ ...opts, idPrefix: `t${fakeSeq}` });
};
const NOW = new Date("2026-10-05T12:00:00.000Z");

describe.skipIf(!DB_URL)("GAP-101 — M36 out-of-band delivery, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleDeliveryDispatchStore>;
  let webhooks: ReturnType<typeof createDbMessagingWebhookService>;
  const orgs = {
    listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
  };
  let seq = 0;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** One alert + one out-of-band delivery row (and optionally a verified endpoint for its recipient). */
  async function delivery(
    org: string,
    user: string,
    channel: "sms" | "email" | "push" | "voice" | "in_app",
    over: { category?: string; severity?: string; payload?: object; endpoint?: boolean } = {},
  ) {
    seq += 1;
    const category = over.category ?? "clinical_urgent";
    const severity = over.severity ?? "critical";
    const alert = (
      await admin.query(
        `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id, outcome)
         VALUES ($1,'m19.triage.case_opened',$2,$3,$4,'pending') RETURNING id`,
        [
          org,
          severity,
          JSON.stringify(over.payload ?? { sourceAggregateId: "call-1" }),
          `g101-${seq}`,
        ],
      )
    ).rows[0].id as string;
    const id = (
      await admin.query(
        `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel, status)
         VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
        [alert, user, category, severity, channel],
      )
    ).rows[0].id as string;
    if (over.endpoint !== false && channel !== "in_app") {
      const endpointChannel = channel === "voice" ? "sms" : channel;
      await admin.query(
        `INSERT INTO delivery_endpoint (user_id, channel, endpoint_value, verification_status, verified_at)
         VALUES ($1,$2,$3,'verified', now()) ON CONFLICT DO NOTHING`,
        [user, endpointChannel, endpointChannel === "email" ? "u@example.test" : "+15550001111"],
      );
    }
    return { id, alert };
  }

  async function row(id: string) {
    return (await admin.query("SELECT * FROM notification_delivery WHERE id=$1", [id])).rows[0];
  }
  async function alertOutcome(id: string) {
    return (await admin.query("SELECT outcome FROM alert WHERE id=$1", [id])).rows[0]
      .outcome as string;
  }
  async function failedEvents(org?: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, aggregate_id, payload FROM outbox_event
        WHERE event_type='m36.notification.delivery_failed' ${org ? "AND organization_id=$1" : ""}`,
      org ? [org] : [],
    );
    return rows as {
      organization_id: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }[];
  }
  const sweepDeps = (
    transports: ReturnType<typeof createFakeTransports>["transports"],
    now = NOW,
  ) => ({
    store,
    transports,
    appBaseUrl: "https://app.example.test",
    activeOrgs: orgs,
    now: () => now,
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'a@x.test'),($2,'b@x.test'),($3,'c@x.test')`,
      [USER_A, USER_B, USER_C],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    store = createDrizzleDeliveryDispatchStore(handle.db, outbox as never);
    webhooks = createDbMessagingWebhookService({
      db: handle.db,
      outbox: outbox as never,
      now: () => NOW,
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("pending SMS -> sent through the worker: vendor id stored, endpoint recorded, alert stays pending", async () => {
    const d = await delivery(ORG_A, USER_A, "sms");
    const fake = fakes();

    const res = await runDeliverySweep(sweepDeps(fake.transports), "sms");

    expect(res).toMatchObject({ claimed: 1, sent: 1, errors: 0 });
    const r = await row(d.id);
    expect(r).toMatchObject({
      status: "sent",
      vendor_message_id: expect.stringMatching(/^t\d+-sms-1$/),
      attempt_count: 1,
    });
    expect(r.endpoint_id).not.toBeNull();
    expect(r.sent_at).not.toBeNull();
    expect(r.settled_at).toBeNull();
    // The vendor got ONLY the sanitized notification + the verified endpoint value.
    expect(fake.calls[0]?.request.destination).toBe("+15550001111");
    expect(Object.keys(fake.calls[0]?.request.notification ?? {}).sort()).toEqual([
      "deepLink",
      "notificationDeliveryId",
      "short",
    ]);
    expect(await alertOutcome(d.alert)).toBe("pending"); // in flight until the vendor callback settles it
  });

  it("is idempotent: a second sweep claims nothing and re-sends nothing", async () => {
    const fake = fakes();
    const res = await runDeliverySweep(sweepDeps(fake.transports), "sms");
    expect(res.claimed).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("the Twilio callback settles sent -> delivered and the alert outcome rolls up; a replay and a late contradiction are no-ops", async () => {
    const d = await delivery(ORG_A, USER_A, "sms");
    await runDeliverySweep(sweepDeps(fakes().transports), "sms");
    const sid = (await row(d.id)).vendor_message_id as string;
    // the in-app floor already delivered, so the roll-up can settle once the SMS lands
    await admin.query(
      `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel, status, settled_at)
       VALUES ($1,$2,'clinical_urgent','critical','in_app','delivered', now())`,
      [d.alert, USER_A],
    );

    await webhooks.recordTwilioSmsStatus({ vendorMessageId: sid, status: "delivered", raw: {} });
    const settled = await row(d.id);
    expect(settled.status).toBe("delivered");
    expect(settled.settled_at).not.toBeNull();
    expect(await alertOutcome(d.alert)).toBe("delivered");

    const auditBefore = (await admin.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n;
    await webhooks.recordTwilioSmsStatus({ vendorMessageId: sid, status: "delivered", raw: {} }); // replay
    await webhooks.recordTwilioSmsStatus({ vendorMessageId: sid, status: "failed", raw: {} }); // late contradiction
    expect((await row(d.id)).status).toBe("delivered");
    expect((await admin.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n).toBe(
      auditBefore,
    );
    expect(await failedEvents(ORG_A)).toHaveLength(0);
  });

  it("an unknown vendor id and an in-flight status are ignored", async () => {
    await webhooks.recordTwilioSmsStatus({
      vendorMessageId: "SM-never-sent",
      status: "delivered",
      raw: {},
    });
    const d = await delivery(ORG_A, USER_A, "sms");
    await runDeliverySweep(sweepDeps(fakes().transports), "sms");
    const sid = (await row(d.id)).vendor_message_id as string;
    await webhooks.recordTwilioSmsStatus({ vendorMessageId: sid, status: "queued", raw: {} });
    expect((await row(d.id)).status).toBe("sent");
  });

  it("a Postmark Bounce settles the email delivery FAILED, fails the alert and publishes m36.notification.delivery_failed", async () => {
    const d = await delivery(ORG_A, USER_A, "email");
    await runDeliverySweep(sweepDeps(fakes().transports), "email");
    const mid = (await row(d.id)).vendor_message_id as string;

    await webhooks.recordPostmarkEvent({
      vendorMessageId: mid,
      status: "Bounce",
      raw: { Type: "HardBounce" },
    });

    const r = await row(d.id);
    expect(r).toMatchObject({ status: "failed", fail_reason: "postmark_event:Bounce:HardBounce" });
    expect(await alertOutcome(d.alert)).toBe("failed");
    const evs = (await failedEvents(ORG_A)).filter((e) => e.aggregate_id === d.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toMatchObject({
      notificationId: d.id,
      organizationId: ORG_A,
      channel: "email",
      alertEventType: "m19.triage.case_opened",
      sourceAggregateId: "call-1",
    });
  });

  it("transient vendor failures back off then fail terminally once the attempt budget is spent", async () => {
    const d = await delivery(ORG_A, USER_A, "push");
    const failing = fakes({ failWith: () => new TransportError("vendor_5xx", true) });
    let now = NOW;
    let guard = 0;
    while ((await row(d.id)).status === "pending" && guard < 10) {
      guard += 1;
      await runDeliverySweep(sweepDeps(failing.transports, now), "push");
      const r = await row(d.id);
      if (r.status === "pending") {
        expect(r.next_attempt_at).not.toBeNull();
        // not claimable before its backoff elapses
        const early = await runDeliverySweep(sweepDeps(failing.transports, now), "push");
        expect(early.claimed).toBe(0);
        now = new Date(new Date(r.next_attempt_at).getTime() + 1);
      }
    }
    const r = await row(d.id);
    expect(r.status).toBe("failed");
    expect(r.attempt_count).toBe(4); // send_push attempts (§4.4.1)
    expect(r.fail_reason).toBe("vendor_5xx");
    expect((await failedEvents(ORG_A)).some((e) => e.aggregate_id === d.id)).toBe(true);
  });

  it("push settles delivered on acceptance (no delivery callback exists for web-push)", async () => {
    const d = await delivery(ORG_A, USER_A, "push");
    await runDeliverySweep(sweepDeps(fakes().transports), "push");
    expect((await row(d.id)).status).toBe("delivered");
  });

  // GAP-062 — the REAL bound adapters (Twilio SMS/voice, Postmark) end to end: only the vendor HTTP boundary is
  // stubbed. A pending SOS voice delivery is placed through the Twilio Calls API, stores the call SID, and the
  // vendor status callback settles it; the same for SMS and email.
  it("GAP-062: the bound Twilio voice/SMS and Postmark adapters take pending rows to sent, and the callbacks settle them", async () => {
    const requests: { url: string; body: string }[] = [];
    const vendorFetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, body: String(init.body) });
      seq += 1;
      const json = url.includes("postmarkapp.com")
        ? { ErrorCode: 0, MessageID: `pm-real-${seq}` }
        : { sid: `${url.includes("Calls") ? "CA" : "SM"}real${seq}` };
      return new Response(JSON.stringify(json), { status: 201 });
    };
    const binding = bindOutOfBandTransports({
      env: {
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "tok",
        TWILIO_SMS_FROM: "+15550009999",
        TWILIO_VOICE_FROM: "+15550008888",
        MESSAGING_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test",
        POSTMARK_SERVER_TOKEN: "pm",
        POSTMARK_FROM_ADDRESS: "alerts@example.test",
        POSTMARK_SENDER_VERIFIED: "true",
      },
      log: () => {},
      fetch: vendorFetch,
    });
    expect(binding.sosVoiceAvailable).toBe(true);
    const deps = sweepDeps(binding.transports);

    const voice = await delivery(ORG_A, USER_A, "voice", {
      category: "field_safety",
      severity: "critical",
    });
    expect(await runDeliverySweep(deps, "voice")).toMatchObject({ claimed: 1, sent: 1, errors: 0 });
    const placed = await row(voice.id);
    expect(placed.status).toBe("sent");
    expect(placed.vendor_message_id).toMatch(/^CAreal/);
    const callRequest = requests.find((r) => r.url.includes("/Calls.json"));
    const callForm = new URLSearchParams(callRequest?.body);
    expect(callForm.get("To")).toBe("+15550001111");
    expect(callForm.get("StatusCallback")).toBe(
      "https://api.example.test/webhooks/twilio/voice-status",
    );
    await webhooks.recordTwilioVoiceStatus({
      vendorMessageId: placed.vendor_message_id as string,
      status: "completed",
      raw: {},
    });
    expect((await row(voice.id)).status).toBe("delivered");

    const sms = await delivery(ORG_A, USER_A, "sms");
    await runDeliverySweep(deps, "sms");
    const sent = await row(sms.id);
    expect(sent.vendor_message_id).toMatch(/^SMreal/);
    await webhooks.recordTwilioSmsStatus({
      vendorMessageId: sent.vendor_message_id as string,
      status: "delivered",
      raw: {},
    });
    expect((await row(sms.id)).status).toBe("delivered");

    const email = await delivery(ORG_A, USER_A, "email");
    await runDeliverySweep(deps, "email");
    const mailed = await row(email.id);
    expect(mailed.vendor_message_id).toMatch(/^pm-real-/);
    await webhooks.recordPostmarkEvent({
      vendorMessageId: mailed.vendor_message_id as string,
      status: "Delivery",
      raw: {},
    });
    expect((await row(email.id)).status).toBe("delivered");
  });

  // GAP-063 — the SMS endpoint-verification code is actually DELIVERED (through the bound Twilio adapter), the
  // endpoint becomes `verified` only with that code, and only then is it a delivery target.
  it("GAP-063: the registered SMS endpoint's code is delivered, verifies it, and the endpoint then receives deliveries", async () => {
    const sentBodies: string[] = [];
    const binding = bindOutOfBandTransports({
      env: {
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "tok",
        TWILIO_SMS_FROM: "+15550009999",
        MESSAGING_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test",
      },
      log: () => {},
      fetch: async (_url, init) => {
        sentBodies.push(String(init.body));
        seq += 1;
        return new Response(JSON.stringify({ sid: `SMverify${seq}` }), { status: 201 });
      },
    });
    const service = createDbMessagingRouteService(handle.db, {
      sendEndpointVerificationCode: binding.sendEndpointVerificationCode,
    });
    const phone = "+15557770000";

    const registered = await service.registerEndpoint(ORG_B, USER_B, {
      channel: "sms",
      target: phone,
    });
    expect(registered.verificationStatus).toBe("pending");
    const form = new URLSearchParams(sentBodies[0]);
    expect(form.get("To")).toBe(phone);
    const code = /code is (\d+)/.exec(form.get("Body") ?? "")?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);

    await expect(
      service.verifyEndpoint(ORG_B, USER_B, registered.endpointId, "000000"),
    ).rejects.toBeDefined();
    const verified = await service.verifyEndpoint(ORG_B, USER_B, registered.endpointId, code);
    expect(verified.verificationStatus).toBe("verified");

    // unbound provider => a clear 503 and NO row is left behind
    const before = (await admin.query("SELECT count(*)::int AS n FROM delivery_endpoint")).rows[0]
      .n;
    const unbound = createDbMessagingRouteService(handle.db);
    await expect(
      unbound.registerEndpoint(ORG_B, USER_B, { channel: "email", target: "x@example.test" }),
    ).rejects.toMatchObject({ code: "ENDPOINT_VERIFICATION_UNAVAILABLE" });
    expect((await admin.query("SELECT count(*)::int AS n FROM delivery_endpoint")).rows[0].n).toBe(
      before,
    );
  });

  it("the fail-closed deny-stub settles failed (never pending forever, never faked as sent) and escalates", async () => {
    const d = await delivery(ORG_A, USER_A, "voice", {
      category: "field_safety",
      severity: "critical",
    });
    const res = await runDeliverySweep(
      { ...sweepDeps(fakes().transports), transports: createDenyTransports() },
      "voice",
    );
    expect(res.failed).toBe(1);
    expect(await row(d.id)).toMatchObject({
      status: "failed",
      fail_reason: "transport_not_configured",
    });
    expect((await failedEvents(ORG_A)).some((e) => e.aggregate_id === d.id)).toBe(true);
  });

  it("a recipient with no verified endpoint settles failed (no_verified_endpoint)", async () => {
    const d = await delivery(ORG_A, USER_B, "email", { endpoint: false });
    await runDeliverySweep(sweepDeps(fakes().transports), "email");
    expect(await row(d.id)).toMatchObject({
      status: "failed",
      fail_reason: "no_verified_endpoint",
    });
  });

  it("never touches in-app deliveries", async () => {
    const d = await delivery(ORG_A, USER_A, "in_app");
    for (const ch of ["push", "sms", "voice", "email"] as const)
      await runDeliverySweep(sweepDeps(fakes().transports), ch);
    expect((await row(d.id)).status).toBe("pending");
  });

  // WP 5.11 / W6 — migration 1153: a native endpoint's bare device token reaches the transport together with the delivery's own
  // alert id, a Web Push row is passed through untouched, and the provider is only legal on the push channel.
  it("W6: a native endpoint resolves to {provider, token, alertId}; a web row is untouched; sms cannot carry a native provider", async () => {
    const FCM = `${"a".repeat(40)}:tok`;
    const d = await delivery(ORG_A, USER_A, "push", { endpoint: false });
    await admin.query(
      `INSERT INTO delivery_endpoint (user_id, channel, provider, endpoint_value, verification_status, verified_at)
       VALUES ($1,'push','fcm',$2,'verified', now())`,
      [USER_A, FCM],
    );
    const fake = fakes();
    await runDeliverySweep(sweepDeps(fake.transports), "push");
    const sent = fake.calls.find((c) => c.request.destination.includes(FCM));
    expect(sent).toBeDefined();
    expect(JSON.parse(sent!.request.destination)).toEqual({
      provider: "fcm",
      token: FCM,
      alertId: d.alert,
      emergency: true, // the helper's default severity is critical (ADR-0106)
    });
    expect((await row(d.id)).status).toBe("delivered");

    await expect(
      admin.query(
        `INSERT INTO delivery_endpoint (user_id, channel, provider, endpoint_value) VALUES ($1,'sms','apns','+15550009999')`,
        [USER_A],
      ),
    ).rejects.toThrow(/delivery_endpoint_provider_push_only_chk/);

    // a different recipient's web-provider push row is handed over verbatim (no native envelope)
    const w = await delivery(ORG_B, USER_B, "push", { endpoint: false });
    await admin.query(
      `INSERT INTO delivery_endpoint (user_id, channel, endpoint_value, verification_status, verified_at)
       VALUES ($1,'push','{"endpoint":"https://push.example.test/x","keys":{}}','verified', now())`,
      [USER_B],
    );
    const webFake = fakes();
    await runDeliverySweep(sweepDeps(webFake.transports), "push");
    const webCall = webFake.calls.find((c) => c.request.destination.includes("push.example.test"));
    expect(webCall?.request.destination).toBe(
      '{"endpoint":"https://push.example.test/x","keys":{}}',
    );
    expect((await row(w.id)).status).toBe("delivered");
  });

  it("CROSS-TENANT: org B's sweep and endpoint resolution never reach org A's deliveries", async () => {
    const a = await delivery(ORG_A, USER_A, "sms");
    // org B's own claim (as chartwarden_app, RLS-enforced) must not see org A's pending row
    const claimedByB = await store.claimBatch(ORG_B, "sms", 50, NOW, 120_000);
    expect(claimedByB.map((c) => c.deliveryId)).not.toContain(a.id);
    expect((await row(a.id)).attempt_count).toBe(0);

    // a spoofed claim naming org A's delivery under org B resolves NO endpoint (the definer function is
    // scoped by (organization, delivery) and verifies the alert's org)
    const spoof = await store.resolveDestination({
      deliveryId: a.id,
      organizationId: ORG_B,
      alertId: a.alert,
      recipientUserId: USER_A,
      channel: "sms",
      alertCategory: "clinical_urgent",
      alertSeverity: "critical",
      attemptCount: 1,
      vendorMessageId: null,
    });
    expect(spoof).toBeNull();

    // and a settle attempted under org B for org A's delivery is a no-op (row not visible / org mismatch)
    await store.markFailed(
      {
        deliveryId: a.id,
        organizationId: ORG_B,
        alertId: a.alert,
        recipientUserId: USER_A,
        channel: "sms",
        alertCategory: "clinical_urgent",
        alertSeverity: "critical",
        attemptCount: 1,
        vendorMessageId: null,
      },
      "spoof",
      null,
      NOW,
    );
    expect((await row(a.id)).status).toBe("pending");
    expect(await failedEvents(ORG_B)).toHaveLength(0);

    // org B's own delivery IS dispatched, with ITS recipient's endpoint, and the vendor callback settles only it
    const b = await delivery(ORG_B, USER_B, "sms");
    const fake = fakes();
    await runDeliverySweep(sweepDeps(fake.transports), "sms");
    expect((await row(b.id)).status).toBe("sent");
    const sidB = (await row(b.id)).vendor_message_id as string;
    await webhooks.recordTwilioSmsStatus({ vendorMessageId: sidB, status: "delivered", raw: {} });
    expect((await row(b.id)).status).toBe("delivered");
  });

  it("W6: a dead native token settles terminally and its endpoint is expired; a web endpoint is left verified", async () => {
    const DEAD = `${"d".repeat(40)}:dead`;
    const d = await delivery(ORG_A, USER_A, "push", { endpoint: false });
    await admin.query(
      `INSERT INTO delivery_endpoint (user_id, channel, provider, endpoint_value, verification_status, verified_at, created_at)
       VALUES ($1,'push','fcm',$2,'verified', now(), now() + interval '1 hour')`,
      [USER_A, DEAD],
    );
    const dead = fakes({
      failWith: () => new TransportError(PUSH_TOKEN_UNREGISTERED, false),
    });
    await runDeliverySweep(sweepDeps(dead.transports), "push");
    const settled = await row(d.id);
    expect(settled.status).toBe("failed");
    expect(settled.fail_reason).toBe(PUSH_TOKEN_UNREGISTERED);
    const state = async (value: string) =>
      (
        await admin.query(
          "SELECT verification_status FROM delivery_endpoint WHERE user_id=$1 AND endpoint_value=$2",
          [USER_A, value],
        )
      ).rows[0]?.verification_status;
    expect(await state(DEAD)).toBe("expired");

    // The same terminal reason against a Web Push endpoint never expires it (provider <> 'web' guard).
    const w = await delivery(ORG_B, USER_B, "push", { endpoint: false });
    await admin.query(
      `INSERT INTO delivery_endpoint (user_id, channel, endpoint_value, verification_status, verified_at)
       VALUES ($1,'push','{"endpoint":"https://push.example.test/dead","keys":{}}','verified', now())`,
      [USER_B],
    );
    await runDeliverySweep(sweepDeps(dead.transports), "push");
    expect((await row(w.id)).status).toBe("failed");
    expect(
      (
        await admin.query(
          "SELECT verification_status FROM delivery_endpoint WHERE user_id=$1 AND endpoint_value LIKE '%dead%'",
          [USER_B],
        )
      ).rows[0].verification_status,
    ).toBe("verified");
  });
  // ADR-0106 follow-ups: an emergency push reaches EVERY verified native device; the APNs host follows each token's environment.
  describe("multi-device emergency fan-out and per-token APNs environment", () => {
    const APNS_DEV = "a1".repeat(32);
    const APNS_PROD = "b2".repeat(32);
    const FCM_TOK = `${"c".repeat(40)}:multi`;
    async function device(
      user: string,
      provider: "fcm" | "apns",
      value: string,
      ageMinutes: number,
      environment: "sandbox" | "production" | null,
    ) {
      await admin.query(
        `INSERT INTO delivery_endpoint (user_id, channel, provider, endpoint_value, environment, verification_status, verified_at, created_at)
         VALUES ($1,'push',$2,$3,$4,'verified', now(), now() - ($5 || ' minutes')::interval)`,
        [user, provider, value, environment, String(ageMinutes)],
      );
    }
    const siblings = async (alert: string) =>
      (
        await admin.query(
          "SELECT id, status, endpoint_id, fail_reason FROM notification_delivery WHERE alert_id=$1 ORDER BY queued_at, id",
          [alert],
        )
      ).rows;
    const sentTokens = (calls: { request: { destination: string } }[]) =>
      calls.map((c) => JSON.parse(c.request.destination) as Record<string, unknown>);

    it("a critical push goes to every verified device once, loud, with each APNs token's own environment", async () => {
      await device(USER_C, "fcm", FCM_TOK, 30, null);
      await device(USER_C, "apns", APNS_DEV, 20, "sandbox");
      await device(USER_C, "apns", APNS_PROD, 10, "production");
      const d = await delivery(ORG_A, USER_C, "push", { endpoint: false });

      const first = fakes();
      await runDeliverySweep(sweepDeps(first.transports), "push");
      const second = fakes();
      await runDeliverySweep(sweepDeps(second.transports), "push");
      const third = fakes();
      await runDeliverySweep(sweepDeps(third.transports), "push");

      const all = sentTokens([...first.calls, ...second.calls]);
      expect(all.map((c) => c.token).sort()).toEqual([APNS_DEV, APNS_PROD, FCM_TOK].sort());
      expect(all.every((c) => c.emergency === true && c.alertId === d.alert)).toBe(true);
      const byToken = Object.fromEntries(all.map((c) => [c.token as string, c]));
      expect(byToken[APNS_DEV]?.environment).toBe("sandbox");
      expect(byToken[APNS_PROD]?.environment).toBe("production");
      expect(byToken[FCM_TOK]).not.toHaveProperty("environment");
      // Idempotent per (alert, device): the third sweep and a re-run add neither sends nor rows.
      expect(third.calls).toHaveLength(0);
      const rows = await siblings(d.alert);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === "delivered")).toBe(true);
      expect(new Set(rows.map((r) => r.endpoint_id)).size).toBe(3);
    });

    it("a failing or dead device token does not block the others and expires only itself", async () => {
      const DEAD = `${"e".repeat(40)}:dead2`;
      const LIVE = `${"f".repeat(40)}:live2`;
      await device(USER_C, "fcm", LIVE, 5, null);
      await device(USER_C, "fcm", DEAD, 1, null); // newest = the original delivery's device
      const d = await delivery(ORG_A, USER_C, "push", { endpoint: false });
      // Earlier tests left USER_C three more verified devices, so five in all; kill whichever send carries DEAD.
      for (let sweep = 0; sweep < 2; sweep += 1) {
        const f = createFakeTransports({
          idPrefix: `d${sweep}-${seq}`,
          failWith: (_channel, n) =>
            f.calls[n - 1]?.request.destination.includes(DEAD)
              ? new TransportError(PUSH_TOKEN_UNREGISTERED, false)
              : undefined,
        });
        await runDeliverySweep(sweepDeps(f.transports), "push");
      }
      const rows = await siblings(d.alert);
      expect(rows).toHaveLength(5);
      expect(rows.filter((r) => r.status === "failed").map((r) => r.fail_reason)).toEqual([
        PUSH_TOKEN_UNREGISTERED,
      ]);
      expect(rows.filter((r) => r.status === "delivered")).toHaveLength(4);
      const states = (
        await admin.query(
          "SELECT endpoint_value, verification_status FROM delivery_endpoint WHERE user_id=$1 AND endpoint_value = ANY($2)",
          [USER_C, [DEAD, LIVE]],
        )
      ).rows;
      expect(
        Object.fromEntries(states.map((r) => [r.endpoint_value, r.verification_status])),
      ).toEqual({
        [DEAD]: "expired",
        [LIVE]: "verified",
      });
    });

    it("a non-critical push still goes to the newest device only, with no fan-out", async () => {
      const d = await delivery(ORG_A, USER_C, "push", {
        endpoint: false,
        severity: "info",
        category: "clinical_routine",
      });
      const f = fakes();
      await runDeliverySweep(sweepDeps(f.transports), "push");
      await runDeliverySweep(sweepDeps(fakes().transports), "push");
      expect(await siblings(d.alert)).toHaveLength(1);
      expect(f.calls.some((c) => c.request.destination.includes(d.alert))).toBe(true);
      expect(
        sentTokens(f.calls.filter((c) => c.request.destination.includes(d.alert))),
      ).toHaveLength(1);
    });

    // PR #937 review (HIGH): a slow resolve that outlives its lease is re-claimed, so two resolveDestination runs overlap on the SAME
    // unbound critical delivery. Neither sees the other's uncommitted siblings; without the DB-level guard (migration 1303 + ON CONFLICT
    // DO NOTHING) each phone gets the emergency push twice. A fresh user keeps this independent of the devices earlier tests left behind.
    it("overlapping fan-outs of one critical delivery create each sibling exactly once", async () => {
      const USER_D = "66666666-6666-6666-6666-666666666666";
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'d@x.test')`, [USER_D]);
      await device(USER_D, "fcm", `${"1".repeat(40)}:race`, 40, null);
      await device(USER_D, "apns", "c3".repeat(32), 30, "production");
      await device(USER_D, "apns", "d4".repeat(32), 20, "sandbox");
      await device(USER_D, "fcm", `${"2".repeat(40)}:race`, 10, null);

      // Repeated so the pool is warm after the first round: with one warm connection the runs never overlap.
      for (let round = 0; round < 3; round += 1) {
        const d = await delivery(ORG_A, USER_D, "push", { endpoint: false });
        const claim = {
          organizationId: ORG_A,
          deliveryId: d.id,
          channel: "push",
          alertSeverity: "critical",
        } as unknown as Parameters<typeof store.resolveDestination>[0];

        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () => store.resolveDestination(claim)),
        );

        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        const rows = await siblings(d.alert);
        expect(rows).toHaveLength(4);
        expect(new Set(rows.map((r) => r.endpoint_id)).size).toBe(4);
      }
    });

    // Review of the fix above (HIGH): a vacation-forwarded copy is a SECOND critical push row for the same (alert, recipient) when the
    // backup is also a direct recipient. Both bind to the recipient's newest device; the unique index must not make the second bind throw
    // (it would error on every retry and the delivery would stay pending for ever).
    it("a forwarded copy and a direct delivery for one recipient both resolve and bind", async () => {
      const USER_E = "77777777-7777-7777-7777-777777777777";
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'e@x.test')`, [USER_E]);
      await device(USER_E, "fcm", `${"3".repeat(40)}:fwd`, 20, null);
      await device(USER_E, "fcm", `${"4".repeat(40)}:fwd`, 10, null);
      const alert = (
        await admin.query(
          `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id, outcome)
           VALUES ($1,'m19.triage.case_opened','critical','{"sourceAggregateId":"call-fwd"}','g101-fwd','pending') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      const insertDelivery = async (forwardedFrom: string | null) =>
        (
          await admin.query(
            `INSERT INTO notification_delivery (alert_id, recipient_user_id, forwarded_from_user_id, alert_category, alert_severity, channel, status)
             VALUES ($1,$2,$3,'clinical_urgent','critical','push','pending') RETURNING id`,
            [alert, USER_E, forwardedFrom],
          )
        ).rows[0].id as string;
      const direct = await insertDelivery(null);
      const forwarded = await insertDelivery(USER_A);
      const claimOf = (id: string) =>
        ({
          organizationId: ORG_A,
          deliveryId: id,
          channel: "push",
          alertSeverity: "critical",
        }) as unknown as Parameters<typeof store.resolveDestination>[0];

      const results = await Promise.allSettled([
        store.resolveDestination(claimOf(direct)),
        store.resolveDestination(claimOf(forwarded)),
      ]);
      // A second pass is what a lease-lapse re-claim does; it must still not throw.
      const again = await Promise.allSettled([
        store.resolveDestination(claimOf(direct)),
        store.resolveDestination(claimOf(forwarded)),
      ]);

      expect([...results, ...again].filter((r) => r.status === "rejected")).toEqual([]);
      const bound = (
        await admin.query(
          "SELECT id, endpoint_id FROM notification_delivery WHERE alert_id=$1 AND id = ANY($2)",
          [alert, [direct, forwarded]],
        )
      ).rows;
      expect(bound.every((r) => r.endpoint_id !== null)).toBe(true);
      // one fan-out sibling for the other device, not one per delivery
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM notification_delivery WHERE alert_id=$1", [alert])).rows[0].n,
      ).toBe(3);
    });
  });
});
