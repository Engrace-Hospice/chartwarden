/**
 * GAP-058 / GAP-059 / GAP-060 / GAP-061 - LIVE Postgres proof of M35's billing runtime, connected as the real
 * NOBYPASSRLS `wardenx_app` role for every tenant-scoped path (a second superuser handle stands in for the
 * separately-credentialled platform pool, which is BYPASSRLS in production).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m35:billing-runtime:live
 *
 * What is proved (Stripe itself is faked at the `StripeClient` / `StripePaymentMethodVerifier` boundary):
 *   060  attach trusts nothing from the body; createSubscription refuses another org's payment method
 *   061  refund cap (paid only, cumulative, concurrent-safe) and approved refunds really execute / fail
 *   058  a signed webhook lands encrypted in stripe_webhook_event and is processed into billing state
 *   059  dunning walks the ladder to suspension (+ billing_blocked), payment resolves it; expiry watch,
 *        usage thresholds, revenue snapshot and the reconciler run
 */
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { StripeClient } from "@chartwarden/subscription-billing";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type M35JobDeps,
  runDunningForOrg,
  runInvoiceReconcileForOrg,
  runPaymentMethodExpiryForOrg,
  runRevenueSnapshot,
  runUsageAggregationForOrg,
} from "../src/modules/35-subscription/billing-runtime/jobs";
import { runRefundExecutionSweep } from "../src/modules/35-subscription/billing-runtime/refund-executor";
import { runWebhookHandlerSweep } from "../src/modules/35-subscription/billing-runtime/webhook-handler";
import { buildM35WebhookIngest } from "../src/modules/35-subscription/billing-runtime/webhook-ingest";
import { createWebhookPayloadCipher } from "../src/modules/35-subscription/billing-runtime/webhook-payload-crypto";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import {
  type PlatformRunner,
  type WriteOutboxPort,
  buildDrizzleM35RouteService,
} from "../src/modules/35-subscription/routes/service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const MEMBER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const MEMBER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const APPROVER = "cccccccc-0000-4000-8000-00000000000c";
const NOW = new Date("2026-10-08T12:00:00Z");
const WEBHOOK_SECRET = "whsec_live_test";
const REASON = "customer was double charged for the same period, verified with the processor";

const USER_A = "a0a0a0a0-0000-4000-8000-0000000000a1";
const USER_B = "b0b0b0b0-0000-4000-8000-0000000000b1";
const actorA = {
  organizationId: ORG_A,
  userId: USER_A,
  roles: [] as string[],
  membershipId: MEMBER_A,
  stepUpRecent: true,
};
const actorB = { ...actorA, organizationId: ORG_B, userId: USER_B, membershipId: MEMBER_B };

describe.skipIf(!DB_URL)("M35 billing runtime - LIVE Postgres", () => {
  let admin: Client;
  let tenant: ReturnType<typeof createDbClient>;
  let platform: ReturnType<typeof createDbClient>;
  let planId: string;
  const cipher = createWebhookPayloadCipher(Buffer.alloc(32, 9));

  const platformRunner: PlatformRunner = (fn) =>
    platform.db.transaction((tx) => fn(tx as unknown as Parameters<typeof fn>[0]));

  const catalog = new Set<string>(M35_OUTBOX_EVENTS.map((e) => e.eventName));
  const outbox: WriteOutboxPort = {
    async publish(tx, input) {
      if (!catalog.has(input.eventName)) throw new Error(`undeclared event ${input.eventName}`);
      const db = tx as typeof tenant.db;
      if (input.organizationId === null) {
        await db.execute(sql`
          SELECT report_writer_insert_platform_outbox_event(
            ${input.eventName}, ${input.aggregateKind}, ${input.aggregateId},
            ${JSON.stringify(input.payload)}::jsonb)`);
        return;
      }
      await db.execute(sql`
        INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
        VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)`);
    },
  };

  const jobsAt = (now: Date): M35JobDeps => ({
    db: tenant.db,
    platformRunner,
    outbox,
    listOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    now: () => now,
  });

  async function events(orgId: string | null, type: string) {
    const { rows } = await admin.query(
      orgId === null
        ? "SELECT payload FROM outbox_event WHERE organization_id IS NULL AND event_type = $1"
        : "SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2",
      orgId === null ? [type] : [orgId, type],
    );
    return rows;
  }

  async function seedSubscription(orgId: string, customer: string | null, status = "active") {
    const { rows } = await admin.query(
      `INSERT INTO subscription (organization_id, plan_id, status, stripe_customer_id, started_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [orgId, planId, status, customer, "2026-01-01T00:00:00Z"],
    );
    return rows[0].id as string;
  }

  async function seedInvoice(orgId: string, stripeId: string, status: string, paid: number) {
    const { rows } = await admin.query(
      `INSERT INTO invoice (organization_id, stripe_invoice_id, status, subtotal_cents, tax_cents,
                            total_cents, amount_paid_cents)
       VALUES ($1,$2,$3,$4,0,$4,$5) RETURNING id`,
      [orgId, stripeId, status, paid, paid],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m35-rt-a','M35 RT A','M35 RT A'), ($2,'m35-rt-b','M35 RT B','M35 RT B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'a@m35rt.test'),($2,'b@m35rt.test')`,
      [USER_A, USER_B],
    );
    planId = (
      await admin.query(
        `INSERT INTO plan (slug,name,tier,cadence,base_price_cents,trial_period_days,is_active)
         VALUES ('starter-monthly','Starter','starter','monthly',29900,0,true) RETURNING id`,
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    tenant = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    platform = createDbClient({ connectionString: DB_URL as string });
  }, 240_000);

  afterAll(async () => {
    await tenant?.close();
    await platform?.close();
    if (admin) await admin.end();
  });

  // ── GAP-060 ────────────────────────────────────────────────────────────────────────────────────────

  describe("GAP-060 payment-method trust", () => {
    const verifierFor = (customerOnStripe: string | null, type = "card") => ({
      async verifyAttachable(input: { stripeCustomerId: string; stripePaymentMethodId: string }) {
        if (customerOnStripe !== input.stripeCustomerId) {
          const { PaymentMethodRejectedError } = await import("@chartwarden/subscription-billing");
          throw new PaymentMethodRejectedError("not_attached_to_customer", "not yours");
        }
        return {
          kind: type as "card",
          cardBrand: "visa",
          cardLast4: "4242",
          cardExpMonth: 12,
          cardExpYear: 2031,
          achBankName: null,
          achAccountLast4: null,
          achAccountType: null,
          sepaCountry: null,
          sepaLast4: null,
        };
      },
    });

    it("refuses 503 when no Stripe verifier is bound (nothing is trusted from the body)", async () => {
      const svc = buildDrizzleM35RouteService(tenant.db, { outbox });
      await expect(
        svc.attachPaymentMethod(actorA, { stripePaymentMethodId: "pm_fake" }),
      ).rejects.toMatchObject({ statusCode: 503 });
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM payment_method");
      expect(rows[0].n).toBe(0);
    });

    it("refuses 409 for an org with no Stripe customer yet", async () => {
      const svc = buildDrizzleM35RouteService(tenant.db, {
        outbox,
        paymentMethodVerifier: verifierFor("cus_A"),
      });
      await expect(
        svc.attachPaymentMethod(actorA, { stripePaymentMethodId: "pm_x" }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("rejects 422 a payment method that is not attached to the org's Stripe customer", async () => {
      await seedSubscription(ORG_A, "cus_A");
      const svc = buildDrizzleM35RouteService(tenant.db, {
        outbox,
        paymentMethodVerifier: verifierFor("cus_SOMEONE_ELSE"),
      });
      await expect(
        svc.attachPaymentMethod(actorA, { stripePaymentMethodId: "pm_squat" }),
      ).rejects.toMatchObject({ statusCode: 422, code: "PAYMENT_METHOD_REJECTED" });
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM payment_method");
      expect(rows[0].n).toBe(0);
    });

    it("stores Stripe-sourced metadata for a verified payment method and blocks squatting by another org", async () => {
      const svc = buildDrizzleM35RouteService(tenant.db, {
        outbox,
        paymentMethodVerifier: verifierFor("cus_A"),
      });
      const view = await svc.attachPaymentMethod(actorA, {
        stripePaymentMethodId: "pm_good",
        setAsDefault: true,
      });
      expect(view).toMatchObject({ brand: "visa", last4: "4242", isDefault: true });
      const { rows } = await admin.query(
        "SELECT expires_at, organization_id FROM payment_method WHERE stripe_payment_method_id='pm_good'",
      );
      expect(rows[0].organization_id).toBe(ORG_A);
      expect(new Date(rows[0].expires_at).toISOString()).toBe("2032-01-01T00:00:00.000Z");
      expect(await events(ORG_A, "m35.payment_method.added")).toHaveLength(1);

      // org B (customer cus_B) cannot claim the same pm id even if its verifier were fooled: the id is taken.
      await seedSubscription(ORG_B, "cus_B");
      const svcB = buildDrizzleM35RouteService(tenant.db, {
        outbox,
        paymentMethodVerifier: verifierFor("cus_B"),
      });
      await expect(
        svcB.attachPaymentMethod(actorB, { stripePaymentMethodId: "pm_good" }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("createSubscription refuses a payment method id that is not the org's own", async () => {
      const own = (
        await admin.query("SELECT id FROM payment_method WHERE stripe_payment_method_id='pm_good'")
      ).rows[0].id as string;
      await admin.query("UPDATE subscription SET status='canceled' WHERE organization_id=$1", [
        ORG_B,
      ]);
      const svc = buildDrizzleM35RouteService(tenant.db, { outbox });
      // ORG_A's pm id presented by ORG_B, and a random uuid: both 422.
      for (const paymentMethodId of [own, "99999999-9999-4999-8999-999999999999"]) {
        await expect(
          svc.createSubscription(actorB, { planSlug: "starter-monthly", paymentMethodId }),
        ).rejects.toMatchObject({ statusCode: 422, code: "PAYMENT_METHOD_NOT_FOUND" });
      }
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM subscription WHERE organization_id=$1 AND status<>'canceled'",
        [ORG_B],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  // ── GAP-061 ────────────────────────────────────────────────────────────────────────────────────────

  describe("GAP-061 refund cap and execution", () => {
    const platformSvc = () =>
      buildDrizzleM35RouteService(tenant.db, { outbox, platformRunner, now: () => NOW });
    const request = (invoiceId: string, amountCents: number) =>
      platformSvc().requestRefund(
        { ...actorA, membershipId: MEMBER_A },
        { invoiceId, amountCents, kind: "partial", reasonCode: "duplicate", reasonDetail: REASON },
      );

    it("rejects an amount above amount_paid, a non-paid invoice, and a cumulative overrun", async () => {
      const paid = await seedInvoice(ORG_A, "in_cap", "paid", 10_000);
      await expect(request(paid, 10_001)).rejects.toMatchObject({
        statusCode: 422,
        code: "REFUND_EXCEEDS_REFUNDABLE",
      });
      const open = await seedInvoice(ORG_A, "in_open", "open", 10_000);
      await expect(request(open, 100)).rejects.toMatchObject({ code: "REFUND_INVOICE_NOT_PAID" });

      await request(paid, 6_000);
      await expect(request(paid, 4_001)).rejects.toMatchObject({
        code: "REFUND_EXCEEDS_REFUNDABLE",
      });
      await request(paid, 4_000); // exactly the remainder
    });

    it("a denied refund frees its headroom", async () => {
      const inv = await seedInvoice(ORG_A, "in_deny", "paid", 5_000);
      const first = await request(inv, 5_000);
      await expect(request(inv, 1)).rejects.toMatchObject({ code: "REFUND_EXCEEDS_REFUNDABLE" });
      await platformSvc().denyRefund(
        { ...actorA, membershipId: APPROVER },
        first.id,
        "not eligible",
      );
      await request(inv, 5_000);
    });

    it("two concurrent requests cannot jointly exceed amount_paid", async () => {
      const inv = await seedInvoice(ORG_A, "in_race", "paid", 10_000);
      const results = await Promise.allSettled([request(inv, 6_000), request(inv, 6_000)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const { rows } = await admin.query(
        "SELECT coalesce(sum(amount_cents),0)::int AS total FROM refund WHERE invoice_id=$1",
        [inv],
      );
      expect(rows[0].total).toBe(6_000);
    });

    const fakeStripe = (
      behaviour: (n: number) => Promise<{ id: string }>,
    ): StripeClient & { calls: number } => {
      const client = {
        calls: 0,
        async execute() {
          client.calls += 1;
          const body = await behaviour(client.calls);
          return { statusCode: 200, body };
        },
      };
      return client;
    };

    async function approvedRefund(invoiceStripeId: string, amount: number) {
      const inv = await seedInvoice(ORG_A, invoiceStripeId, "paid", amount);
      const r = await request(inv, amount);
      await platformSvc().approveRefund({ ...actorA, membershipId: APPROVER }, r.id);
      return r.id;
    }

    it("executes an approved refund through the dispatcher: executed_success + m35.refund.executed", async () => {
      const id = await approvedRefund("in_exec_ok", 2_500);
      const client = fakeStripe(async () => ({ id: "re_ok" }));
      const result = await runRefundExecutionSweep({
        platformRunner,
        client,
        outbox,
        now: () => NOW,
      });
      expect(result.executed).toBeGreaterThanOrEqual(1);
      const { rows } = await admin.query(
        "SELECT status, stripe_refund_id, executed_at FROM refund WHERE id=$1",
        [id],
      );
      expect(rows[0]).toMatchObject({ status: "executed_success", stripe_refund_id: "re_ok" });
      expect(rows[0].executed_at).not.toBeNull();
      const evs = await events(ORG_A, "m35.refund.executed");
      expect(evs.some((e) => e.payload.refundId === id && e.payload.amountCents === 2_500)).toBe(
        true,
      );
      const audit = await admin.query(
        "SELECT response_status_code FROM stripe_api_call_audit WHERE stripe_idempotency_key LIKE $1",
        [`stripe-idem-refund.create-${id}-%`],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].response_status_code).toBe(200);
      // A second sweep does not call Stripe again for an executed refund.
      await runRefundExecutionSweep({ platformRunner, client, outbox, now: () => NOW });
      expect(client.calls).toBe(1);
    });

    it("a permanent Stripe failure marks executed_failed + m35.refund.failed; a transient one stays approved and retries", async () => {
      const failId = await approvedRefund("in_exec_fail", 1_100);
      const permanent = {
        async execute() {
          throw Object.assign(new Error("charge already refunded"), {
            statusCode: 400,
            retryable: false,
          });
        },
      };
      await runRefundExecutionSweep({ platformRunner, client: permanent, outbox, now: () => NOW });
      expect(
        (await admin.query("SELECT status, stripe_failure_code FROM refund WHERE id=$1", [failId]))
          .rows[0],
      ).toMatchObject({
        status: "executed_failed",
        stripe_failure_code: "charge already refunded",
      });
      expect(
        (await events(ORG_A, "m35.refund.failed")).some((e) => e.payload.refundId === failId),
      ).toBe(true);

      const retryId = await approvedRefund("in_exec_retry", 900);
      let attempt = 0;
      const sentKeys: string[] = [];
      const flaky = {
        async execute(_req: unknown, opts?: { idempotencyKey?: string }) {
          sentKeys.push(opts?.idempotencyKey ?? "");
          attempt += 1;
          if (attempt === 1) {
            throw Object.assign(new Error("rate limited"), { statusCode: 429, retryable: true });
          }
          return { statusCode: 200, body: { id: "re_second_try" } };
        },
      };
      const first = await runRefundExecutionSweep({
        platformRunner,
        client: flaky,
        outbox,
        now: () => NOW,
      });
      expect(first.retryLater).toBe(1);
      expect(
        (await admin.query("SELECT status FROM refund WHERE id=$1", [retryId])).rows[0].status,
      ).toBe("approved");
      await runRefundExecutionSweep({ platformRunner, client: flaky, outbox, now: () => NOW });
      expect(
        (await admin.query("SELECT status, stripe_refund_id FROM refund WHERE id=$1", [retryId]))
          .rows[0],
      ).toMatchObject({ status: "executed_success", stripe_refund_id: "re_second_try" });
      // Both attempts used ONE idempotency key: a retry under a new key could refund twice if attempt 1 timed
      // out after Stripe created the refund. The attempt count lives on the single audit row.
      expect(sentKeys).toEqual([
        `stripe-idem-refund.create-${retryId}-0`,
        `stripe-idem-refund.create-${retryId}-0`,
      ]);
      const keys = await admin.query(
        "SELECT stripe_idempotency_key, attempt_index FROM stripe_api_call_audit WHERE stripe_idempotency_key LIKE $1 ORDER BY 1",
        [`stripe-idem-refund.create-${retryId}-%`],
      );
      expect(keys.rows).toEqual([
        { stripe_idempotency_key: `stripe-idem-refund.create-${retryId}-0`, attempt_index: 1 },
      ]);
    });
  });

  // ── GAP-058 + GAP-059 ──────────────────────────────────────────────────────────────────────────────

  describe("GAP-058/059 webhook -> dunning -> suspension -> payment", () => {
    const ingest = buildM35WebhookIngest({
      platformRunner,
      webhookSecret: WEBHOOK_SECRET,
      encryptor: cipher,
      nowMs: () => NOW.getTime(),
    });
    const sign = (body: string) => {
      const t = Math.floor(NOW.getTime() / 1000);
      const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
      return `t=${t},v1=${sig}`;
    };
    const send = async (event: Record<string, unknown>) => {
      const body = JSON.stringify(event);
      return ingest({ rawBody: body, signatureHeader: sign(body) });
    };
    const invoiceEvent = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
      id,
      type,
      created: Math.floor(NOW.getTime() / 1000),
      data: {
        object: {
          id: "in_dunning_1",
          customer: "cus_DUN",
          subtotal: 29_900,
          tax: 0,
          total: 29_900,
          amount_paid: 0,
          attempt_count: 1,
          lines: { data: [{ id: "il_1", amount: 29_900, description: "Starter", quantity: 1 }] },
          ...extra,
        },
      },
    });
    const ORG_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let subId: string;
    const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
    const subStatus = async () =>
      (await admin.query("SELECT status FROM subscription WHERE id=$1", [subId])).rows[0].status;

    beforeAll(async () => {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m35-rt-d','D','D')`,
        [ORG_D],
      );
      subId = await seedSubscription(ORG_D, "cus_DUN");
    });

    it("rejects a bad signature and stores nothing; stores a good event encrypted", async () => {
      const bad = await ingest({ rawBody: "{}", signatureHeader: "t=1,v1=00" });
      expect(bad.kind).toBe("invalid_signature");
      expect((await send(invoiceEvent("evt_pf", "invoice.payment_failed"))).kind).toBe("accepted");
      expect((await send(invoiceEvent("evt_pf", "invoice.payment_failed"))).kind).toBe("duplicate");
      const { rows } = await admin.query(
        "SELECT payload_ciphertext, processed_at FROM stripe_webhook_event WHERE id='evt_pf'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload_ciphertext).not.toContain("in_dunning_1");
      expect(rows[0].processed_at).toBeNull();
    });

    it("the handler mirrors the invoice, opens dunning at day_1 and moves the subscription to past_due", async () => {
      const result = await runWebhookHandlerSweep({ ...jobsAt(NOW), cipher });
      expect(result.processed).toBe(1);
      expect(await subStatus()).toBe("past_due");
      const inv = await admin.query(
        "SELECT status, total_cents FROM invoice WHERE stripe_invoice_id='in_dunning_1'",
      );
      expect(inv.rows[0]).toMatchObject({ status: "open", total_cents: "29900" });
      const dun = await admin.query(
        "SELECT stage FROM dunning_state WHERE subscription_id=$1 AND exited_at IS NULL",
        [subId],
      );
      expect(dun.rows[0].stage).toBe("day_1");
      expect(await events(ORG_D, "m35.dunning.entered_stage")).toHaveLength(1);
      expect(await events(ORG_D, "m35.invoice.payment_failed")).toHaveLength(1);
      expect(
        (await admin.query("SELECT processed_at FROM stripe_webhook_event WHERE id='evt_pf'"))
          .rows[0].processed_at,
      ).not.toBeNull();
      // Replaying the sweep does nothing further.
      expect((await runWebhookHandlerSweep({ ...jobsAt(NOW), cipher })).processed).toBe(0);
    });

    it("the dunning engine walks day_1 -> day_7 -> day_14 -> day_21 -> day_28_suspend and suspends the tenant", async () => {
      const stage = async () =>
        (
          await admin.query(
            "SELECT stage FROM dunning_state WHERE subscription_id=$1 AND exited_at IS NULL",
            [subId],
          )
        ).rows[0].stage;
      // not due yet: nothing moves
      expect(await runDunningForOrg(jobsAt(days(2)), ORG_D)).toBe(0);
      expect(await stage()).toBe("day_1");
      for (const [offset, expected] of [
        [6, "day_7"],
        [13, "day_14"],
        [20, "day_21"],
        [27, "day_28_suspend"],
      ] as const) {
        expect(await runDunningForOrg(jobsAt(days(offset)), ORG_D)).toBe(1);
        expect(await stage()).toBe(expected);
      }
      expect(await subStatus()).toBe("suspended");
      const blocked = await events(ORG_D, "m35.tenant.billing_blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0].payload).toMatchObject({
        organizationId: ORG_D,
        dunningStage: "day_28_suspend",
      });
      const history = await admin.query(
        "SELECT from_status, to_status FROM subscription_state_history WHERE subscription_id=$1 ORDER BY transitioned_at, to_status",
        [subId],
      );
      expect(history.rows.map((r) => `${r.from_status}>${r.to_status}`)).toEqual(
        expect.arrayContaining(["past_due>at_risk", "at_risk>suspended"]),
      );
    });

    it("a paid invoice resolves dunning and reactivates the suspended subscription", async () => {
      await send(
        invoiceEvent("evt_paid", "invoice.paid", { amount_paid: 29_900, status_transitions: {} }),
      );
      expect((await runWebhookHandlerSweep({ ...jobsAt(days(30)), cipher })).processed).toBe(1);
      expect(await subStatus()).toBe("active");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM dunning_state WHERE subscription_id=$1 AND exited_at IS NULL",
            [subId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await admin.query("SELECT status FROM invoice WHERE stripe_invoice_id='in_dunning_1'"))
          .rows[0].status,
      ).toBe("paid");
      expect(await events(ORG_D, "m35.dunning.resolved")).toHaveLength(1);
    });

    it("an event for a customer M35 has no subscription for is left unprocessed with an error (never guessed)", async () => {
      await send(invoiceEvent("evt_unknown", "invoice.paid", { customer: "cus_NOBODY" }));
      const result = await runWebhookHandlerSweep({ ...jobsAt(NOW), cipher });
      expect(result.failed).toBe(1);
      const { rows } = await admin.query(
        "SELECT processed_at, processing_attempt_count, error_text FROM stripe_webhook_event WHERE id='evt_unknown'",
      );
      expect(rows[0].processed_at).toBeNull();
      expect(rows[0].processing_attempt_count).toBe(1);
      expect(rows[0].error_text).toContain("no subscription");
    });
  });

  describe("GAP-059 the remaining workers", () => {
    it("payment-method expiry: warns in the 7-day window once, and deactivates an expired method", async () => {
      const org = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m35-rt-e','E','E')`,
        [org],
      );
      const insert = (pm: string, expires: Date) =>
        admin.query(
          `INSERT INTO payment_method (organization_id, stripe_payment_method_id, kind, expires_at)
           VALUES ($1,$2,'card',$3)`,
          [org, pm, expires.toISOString()],
        );
      await insert("pm_exp_7", new Date(NOW.getTime() + 7 * 86_400_000 - 3_600_000));
      await insert("pm_exp_20", new Date(NOW.getTime() + 20 * 86_400_000));
      await insert("pm_expired", new Date(NOW.getTime() - 86_400_000));
      const result = await runPaymentMethodExpiryForOrg(jobsAt(NOW), org);
      expect(result).toEqual({ warned: 1, expired: 1 });
      expect(await events(org, "m35.payment_method.expiring_soon")).toHaveLength(1);
      expect(await events(org, "m35.payment_method.expired")).toHaveLength(1);
      const { rows } = await admin.query(
        "SELECT stripe_payment_method_id, is_active FROM payment_method WHERE organization_id=$1 ORDER BY 1",
        [org],
      );
      expect(rows.find((r) => r.stripe_payment_method_id === "pm_expired").is_active).toBe(false);
      // Idempotent: the expired one is no longer active, so it is not re-announced.
      expect((await runPaymentMethodExpiryForOrg(jobsAt(NOW), org)).expired).toBe(0);
    });

    it("usage aggregator: emits the 80% warning and the 100% breach exactly once each", async () => {
      const org = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m35-rt-f','F','F')`,
        [org],
      );
      const subId = await seedSubscription(org, null);
      await admin.query(
        `INSERT INTO plan_meter (plan_id, event_type, inclusive_quantity, overage_unit_price_cents, billing_aggregation)
         VALUES ($1,'active_patient',100,500,'sum') ON CONFLICT DO NOTHING`,
        [planId],
      );
      const usage = (qty: number, n: number) =>
        admin.query(
          `INSERT INTO usage_event (organization_id, subscription_id, event_type, quantity, recorded_at,
                                    source_module, source_event_id)
           VALUES ($1,$2,'active_patient',$3,$4,'m5',$5)`,
          [org, subId, qty, "2026-10-05T00:00:00Z", `u-${n}`],
        );
      await usage(85, 1);
      await runUsageAggregationForOrg(jobsAt(NOW), org);
      expect(await events(org, "m35.usage.overage_threshold_warning")).toHaveLength(1);
      expect(await events(org, "m35.usage.overage_threshold_breached")).toHaveLength(0);
      await runUsageAggregationForOrg(jobsAt(NOW), org); // idempotent
      expect(await events(org, "m35.usage.overage_threshold_warning")).toHaveLength(1);

      await usage(30, 2);
      await runUsageAggregationForOrg(jobsAt(NOW), org);
      await runUsageAggregationForOrg(jobsAt(NOW), org);
      expect(await events(org, "m35.usage.overage_threshold_breached")).toHaveLength(1);
      const agg = await admin.query(
        "SELECT total_quantity, inclusive_quantity, overage_quantity FROM usage_period_aggregate WHERE subscription_id=$1",
        [subId],
      );
      expect(agg.rows[0]).toMatchObject({
        total_quantity: "115",
        inclusive_quantity: "100",
        overage_quantity: "15",
      });
    });

    it("revenue snapshot: computes the closed month once, platform-wide", async () => {
      const first = await runRevenueSnapshot(jobsAt(NOW));
      expect(first).toEqual({ computed: true, month: "2026-09" });
      expect((await runRevenueSnapshot(jobsAt(NOW))).computed).toBe(false);
      const { rows } = await admin.query(
        "SELECT mrr_cents FROM revenue_recognition_snapshot WHERE snapshot_month='2026-09'",
      );
      expect(rows).toHaveLength(1);
      expect(await events(null, "m35.revenue.monthly_snapshot_computed")).toHaveLength(1);
    });

    it("reconciler: flags an invoice whose lines do not sum to its subtotal", async () => {
      const inv = await seedInvoice(ORG_A, "in_recon_bad", "open", 10_000);
      await admin.query(
        `INSERT INTO invoice_line (organization_id, invoice_id, stripe_line_id, kind, description, total_cents)
         VALUES ($1,$2,'il_recon','subscription','x',9000)`,
        [ORG_A, inv],
      );
      const mismatches = await runInvoiceReconcileForOrg(jobsAt(NOW), ORG_A);
      expect(mismatches.map((m) => m.stripeInvoiceId)).toContain("in_recon_bad");
    });
  });
});
