/**
 * Continuation of the #248 outbox-binding arc (F-150…F-160 pattern) — LIVE Postgres proof that M35's
 * `m2.organization.{activated,suspended,closed}` binding (§4.12 `org-lifecycle-handler`) writes real
 * `subscription` state under RLS. This is M35's FIRST live outbox-consumer binding — `35-subscription/`
 * had no `outbox-consumers/` directory before this file.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m35:org-lifecycle-consumer:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import { buildM35OrgLifecycleConsumer } from "../src/modules/35-subscription/outbox-consumers/m2-organization-lifecycle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-16x continuation — M35's m2.organization.{activated,suspended,closed} consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM35OrgLifecycleConsumer>;
    let planId: string;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedSubscription(opts: {
      id: string;
      organizationId: string;
      status: string;
      cancelAtPeriodEnd?: boolean;
      startedAt: string;
    }): Promise<void> {
      await admin.query(
        `INSERT INTO subscription
           (id, organization_id, plan_id, status, cancel_at_period_end, started_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          opts.id,
          opts.organizationId,
          planId,
          opts.status,
          opts.cancelAtPeriodEnd ?? false,
          opts.startedAt,
        ],
      );
    }

    async function subscriptionRow(id: string) {
      const { rows } = await admin.query(
        `SELECT status, cancel_at_period_end, canceled_at, paused_at, paused_until, updated_at
         FROM subscription WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    }

    async function historyRows(subscriptionId: string) {
      const { rows } = await admin.query(
        `SELECT from_status, to_status, reason_code, actor_membership_id
         FROM subscription_state_history WHERE subscription_id = $1 ORDER BY transitioned_at`,
        [subscriptionId],
      );
      return rows;
    }

    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2`,
        [organizationId, eventType],
      );
      return rows;
    }

    let orgCounter = 0;
    /** A fresh org per call: `subscription_org_active_uq` allows only ONE non-canceled/non-paused
     *  subscription per org, so tests that seed an `active` row need their own org rather than
     *  reusing ORG_A across cases. */
    async function newOrg(): Promise<string> {
      orgCounter += 1;
      const id = `33333333-0000-4000-8000-${String(orgCounter).padStart(12, "0")}`;
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)`,
        [id, `m35-org-lifecycle-fresh-${orgCounter}`],
      );
      return id;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m35-org-lifecycle-a','M35 Org Lifecycle A','M35 Org Lifecycle A'),
                ($2,'m35-org-lifecycle-b','M35 Org Lifecycle B','M35 Org Lifecycle B')`,
        [ORG_A, ORG_B],
      );
      planId = (
        await admin.query(
          `INSERT INTO plan (slug,name,tier,cadence,base_price_cents,trial_period_days,is_active)
           VALUES ('starter-monthly','Starter','starter','monthly',29900,14,true) RETURNING id`,
        )
      ).rows[0].id as string;

      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M35_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      consumer = buildM35OrgLifecycleConsumer({
        db: handle.db,
        outbox: {
          async publish(tx, input) {
            if (!catalog.has(input.eventName)) {
              throw new Error(`m35 test publisher: undeclared event ${input.eventName}`);
            }
            await (tx as typeof handle.db).execute(sql`
              INSERT INTO outbox_event
                (organization_id, event_type, aggregate_kind, aggregate_id, payload)
              VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                      ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
            `);
          },
        },
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("suspended: pauses an active subscription, writes history, and emits m35.subscription.paused", async () => {
      const subId = "aaaaaaaa-0000-4000-8000-000000000001";
      await seedSubscription({
        id: subId,
        organizationId: ORG_A,
        status: "active",
        startedAt: "2026-01-01T00:00:00Z",
      });

      await consumer.handle({
        eventType: "m2.organization.suspended",
        organizationId: ORG_A,
        payload: {
          organizationId: ORG_A,
          reason: "compliance_hold",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-01T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.status).toBe("paused");
      expect(sub.paused_at).not.toBeNull();
      expect(sub.paused_until).toBeNull();

      const history = await historyRows(subId);
      expect(history).toHaveLength(1);
      expect(history[0].from_status).toBe("active");
      expect(history[0].to_status).toBe("paused");
      expect(history[0].reason_code).toBe("org_suspended_by_platform_admin");
      expect(history[0].actor_membership_id).toBeNull();

      const emissions = await outboxRows(ORG_A, "m35.subscription.paused");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload.subscriptionId).toBe(subId);
    });

    it("suspended: is a true no-op on an already-paused subscription (redelivery-safe)", async () => {
      const subId = "aaaaaaaa-0000-4000-8000-000000000002";
      await seedSubscription({
        id: subId,
        organizationId: ORG_A,
        status: "paused",
        startedAt: "2026-01-02T00:00:00Z",
      });
      const before = await outboxRows(ORG_A, "m35.subscription.paused");

      await consumer.handle({
        eventType: "m2.organization.suspended",
        organizationId: ORG_A,
        payload: {
          organizationId: ORG_A,
          reason: "compliance_hold",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-01T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.status).toBe("paused");
      const history = await historyRows(subId);
      expect(history).toHaveLength(0);
      const after = await outboxRows(ORG_A, "m35.subscription.paused");
      expect(after).toHaveLength(before.length);
    });

    it("suspended: is a no-op on a terminal (canceled) subscription", async () => {
      const subId = "aaaaaaaa-0000-4000-8000-000000000003";
      await seedSubscription({
        id: subId,
        organizationId: ORG_A,
        status: "canceled",
        startedAt: "2026-01-03T00:00:00Z",
      });

      await consumer.handle({
        eventType: "m2.organization.suspended",
        organizationId: ORG_A,
        payload: {
          organizationId: ORG_A,
          reason: "compliance_hold",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-01T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.status).toBe("canceled");
      expect(await historyRows(subId)).toHaveLength(0);
    });

    it("activated: resumes a paused subscription to active, writes history, and emits m35.subscription.resumed", async () => {
      const subId = "aaaaaaaa-0000-4000-8000-000000000004";
      await seedSubscription({
        id: subId,
        organizationId: ORG_A,
        status: "paused",
        startedAt: "2026-01-04T00:00:00Z",
      });

      await consumer.handle({
        eventType: "m2.organization.activated",
        organizationId: ORG_A,
        payload: {
          organizationId: ORG_A,
          reason: "reactivated",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-02T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.status).toBe("active");
      expect(sub.paused_at).toBeNull();
      expect(sub.paused_until).toBeNull();

      const history = await historyRows(subId);
      expect(history).toHaveLength(1);
      expect(history[0].from_status).toBe("paused");
      expect(history[0].to_status).toBe("active");
      expect(history[0].reason_code).toBe("org_activated_by_platform_admin");

      const emissions = await outboxRows(ORG_A, "m35.subscription.resumed");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload.subscriptionId).toBe(subId);
    });

    it("activated: is a documented no-op on an already-active subscription (nothing to resume)", async () => {
      const org = await newOrg();
      const subId = "aaaaaaaa-0000-4000-8000-000000000005";
      await seedSubscription({
        id: subId,
        organizationId: org,
        status: "active",
        startedAt: "2026-01-05T00:00:00Z",
      });
      const before = await outboxRows(org, "m35.subscription.resumed");

      await consumer.handle({
        eventType: "m2.organization.activated",
        organizationId: org,
        payload: {
          organizationId: org,
          reason: "first_activation",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-02T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.status).toBe("active"); // untouched
      const after = await outboxRows(org, "m35.subscription.resumed");
      expect(after).toHaveLength(before.length);
    });

    it("activated: is a documented no-op when the org has no subscription at all (the unbuilt CREATE half)", async () => {
      const org = await newOrg();
      // A brand-new org's very first activation — no subscription row exists for it at all. The
      // consumer must not throw and must not fabricate a plan choice.
      await expect(
        consumer.handle({
          eventType: "m2.organization.activated",
          organizationId: org,
          payload: {
            organizationId: org,
            reason: "first_activation",
            actorMembershipId: "cccccccc-0000-4000-8000-000000000002",
            occurredAt: "2026-02-02T00:00:00Z",
          },
        }),
      ).resolves.toBeUndefined();
      const { rows } = await admin.query(`SELECT id FROM subscription WHERE organization_id = $1`, [
        org,
      ]);
      expect(rows).toHaveLength(0);
    });

    it("closed: schedules a cancel-at-period-end without changing status or writing history", async () => {
      const org = await newOrg();
      const subId = "aaaaaaaa-0000-4000-8000-000000000006";
      await seedSubscription({
        id: subId,
        organizationId: org,
        status: "active",
        startedAt: "2026-01-06T00:00:00Z",
      });

      await consumer.handle({
        eventType: "m2.organization.closed",
        organizationId: org,
        payload: {
          organizationId: org,
          reason: "tenant_offboarded",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-03T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.status).toBe("active"); // status unchanged — scheduled, not immediate
      expect(sub.cancel_at_period_end).toBe(true);
      expect(sub.canceled_at).not.toBeNull();
      expect(await historyRows(subId)).toHaveLength(0); // no status transition to log

      const emissions = await outboxRows(org, "m35.subscription.canceled");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload.atPeriodEnd).toBe(true);
      expect(emissions[0].payload.reasonCode).toBe("org_closed_by_platform_admin");
    });

    it("closed: is a true no-op when already scheduled to cancel (redelivery-safe)", async () => {
      const org = await newOrg();
      const subId = "aaaaaaaa-0000-4000-8000-000000000007";
      await seedSubscription({
        id: subId,
        organizationId: org,
        status: "active",
        cancelAtPeriodEnd: true,
        startedAt: "2026-01-07T00:00:00Z",
      });
      const before = await outboxRows(org, "m35.subscription.canceled");

      await consumer.handle({
        eventType: "m2.organization.closed",
        organizationId: org,
        payload: {
          organizationId: org,
          reason: "tenant_offboarded",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-03T00:00:00Z",
        },
      });

      const after = await outboxRows(org, "m35.subscription.canceled");
      expect(after).toHaveLength(before.length);
    });

    it("closed: is a no-op on an already-terminal (canceled) subscription", async () => {
      const org = await newOrg();
      const subId = "aaaaaaaa-0000-4000-8000-000000000008";
      await seedSubscription({
        id: subId,
        organizationId: org,
        status: "canceled",
        startedAt: "2026-01-08T00:00:00Z",
      });

      await consumer.handle({
        eventType: "m2.organization.closed",
        organizationId: org,
        payload: {
          organizationId: org,
          reason: "tenant_offboarded",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-03T00:00:00Z",
        },
      });

      const sub = await subscriptionRow(subId);
      expect(sub.cancel_at_period_end).toBe(false);
    });

    it("does not touch org B's subscription when org A is suspended (cross-tenant isolation)", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const subA = "aaaaaaaa-0000-4000-8000-000000000009";
      const subB = "bbbbbbbb-0000-4000-8000-000000000001";
      await seedSubscription({
        id: subA,
        organizationId: orgA,
        status: "active",
        startedAt: "2026-01-09T00:00:00Z",
      });
      await seedSubscription({
        id: subB,
        organizationId: orgB,
        status: "active",
        startedAt: "2026-01-09T00:00:00Z",
      });

      await consumer.handle({
        eventType: "m2.organization.suspended",
        organizationId: orgA,
        payload: {
          organizationId: orgA,
          reason: "compliance_hold",
          actorMembershipId: "cccccccc-0000-4000-8000-000000000001",
          occurredAt: "2026-02-04T00:00:00Z",
        },
      });

      const a = await subscriptionRow(subA);
      const b = await subscriptionRow(subB);
      expect(a.status).toBe("paused");
      expect(b.status).toBe("active"); // untouched — org B never appeared in the event
    });
  },
);
