/**
 * Continuation of the #248 outbox-binding arc (F-150…F-160 pattern) — LIVE Postgres proof that M35's
 * `m2.organization.{activated,suspended,closed}` binding (§4.12 `org-lifecycle-handler`) writes real
 * `subscription` state under RLS. This is M35's FIRST live outbox-consumer binding — `35-subscription/`
 * had no `outbox-consumers/` directory before this file.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m35:org-lifecycle-consumer:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { M35JobDeps } from "../src/modules/35-subscription/billing-runtime/jobs";
import {
  runPauseResumeForOrg,
  runPauseResumeSweep,
} from "../src/modules/35-subscription/billing-runtime/pause-resume";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import { buildM35OrgLifecycleConsumer } from "../src/modules/35-subscription/outbox-consumers/m2-organization-lifecycle";
import type { M35WriteActor } from "../src/modules/35-subscription/routes/service";
import { buildDrizzleM35RouteService } from "../src/modules/35-subscription/routes/service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-16x continuation — M35's m2.organization.{activated,suspended,closed} consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM35OrgLifecycleConsumer>;
    let publisher: Parameters<typeof buildM35OrgLifecycleConsumer>[0]["outbox"];
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

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M35_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      publisher = {
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
      };
      consumer = buildM35OrgLifecycleConsumer({ db: handle.db, outbox: publisher });
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

    it("suspended: an operator's pause whose end date has PASSED is over for billing, so a suspension now is a new pause: the ledger ends the old one at its date, then starts the new one", async () => {
      const orgId = await newOrg();
      const subId = "aaaaaaaa-0000-4000-8000-0000000000f1";
      await seedSubscription({
        id: subId,
        organizationId: orgId,
        status: "paused",
        startedAt: "2026-10-01T00:00:00Z",
      });
      // the operator's pause (the only row whose detail is an end date) of Dec 1 .. Dec 15, which the hourly sweep has not resumed yet (this event arrived first)
      await admin.query(
        `UPDATE subscription SET paused_at='2026-12-01T00:00:00Z', paused_until='2026-12-15T00:00:00Z' WHERE id=$1`,
        [subId],
      );
      await admin.query(
        `INSERT INTO subscription_state_history
           (subscription_id, organization_id, from_status, to_status, transitioned_at, reason_code, reason_detail)
         VALUES ($1,$2,'active','paused','2026-12-01T00:00:00Z','platform_ops_pause','paused_until=2026-12-15T00:00:00.000Z')`,
        [subId, orgId],
      );
      const late = buildM35OrgLifecycleConsumer({
        db: handle.db,
        outbox: publisher,
        now: () => new Date("2026-12-20T00:00:00Z"),
      });
      const suspend = (organizationId: string) =>
        late.handle({
          eventType: "m2.organization.suspended",
          organizationId,
          payload: { organizationId, reason: "compliance_hold" },
        });

      await suspend(orgId);

      expect(
        (
          await admin.query(
            `SELECT from_status, to_status, reason_code, transitioned_at FROM subscription_state_history
              WHERE subscription_id=$1 ORDER BY transitioned_at`,
            [subId],
          )
        ).rows.map((r) => [
          r.from_status,
          r.to_status,
          r.reason_code,
          r.transitioned_at.toISOString(),
        ]),
      ).toEqual([
        ["active", "paused", "platform_ops_pause", "2026-12-01T00:00:00.000Z"],
        ["paused", "active", "platform_ops_pause_lapsed", "2026-12-15T00:00:00.000Z"],
        ["active", "paused", "org_suspended_by_platform_admin", "2026-12-20T00:00:00.000Z"],
      ]);
      const row = await subscriptionRow(subId);
      expect(row.status).toBe("paused");
      expect(row.paused_until).toBeNull();
      expect(row.paused_at.toISOString()).toBe("2026-12-20T00:00:00.000Z");
      // a redelivery finds a pause that is running (open-ended now) and changes nothing
      await suspend(orgId);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM subscription_state_history WHERE subscription_id=$1",
            [subId],
          )
        ).rows[0].n,
      ).toBe(3);
    });

    it("suspended: an operator's DATED pause that is still running is made open-ended (a suspended org stays billing-exempt past the old date): the date is cleared, a paused -> paused ledger row is dated at the suspension, the pause keeps its start; a redelivery changes nothing; reactivation then resumes it", async () => {
      const org = await newOrg();
      const subId = "aaaaaaaa-0000-4000-8000-0000000000f2";
      await seedSubscription({
        id: subId,
        organizationId: org,
        status: "paused",
        startedAt: "2026-10-01T00:00:00Z",
      });
      await admin.query(
        `UPDATE subscription SET paused_at='2026-12-01T00:00:00Z', paused_until='2027-01-15T00:00:00Z' WHERE id=$1`,
        [subId],
      );
      await admin.query(
        `INSERT INTO subscription_state_history
           (subscription_id, organization_id, from_status, to_status, transitioned_at, reason_code, reason_detail)
         VALUES ($1,$2,'active','paused','2026-12-01T00:00:00Z','platform_ops_pause','paused_until=2027-01-15T00:00:00.000Z')`,
        [subId, org],
      );
      const at = (iso: string) =>
        buildM35OrgLifecycleConsumer({
          db: handle.db,
          outbox: publisher,
          now: () => new Date(iso),
        });
      const send = (iso: string, eventType: string) =>
        at(iso).handle({
          eventType,
          organizationId: org,
          payload: { organizationId: org, reason: "compliance_hold" },
        });

      await send("2026-12-20T00:00:00Z", "m2.organization.suspended");

      const row = await subscriptionRow(subId);
      expect(row.status).toBe("paused");
      expect(row.paused_until).toBeNull(); // open-ended now
      expect(row.paused_at.toISOString()).toBe("2026-12-01T00:00:00.000Z"); // one continuous pause
      expect(
        (
          await admin.query(
            `SELECT from_status, to_status, reason_code, reason_detail, transitioned_at, actor_membership_id
               FROM subscription_state_history WHERE subscription_id=$1 ORDER BY transitioned_at, id`,
            [subId],
          )
        ).rows.map((r) => [
          r.from_status,
          r.to_status,
          r.reason_code,
          r.reason_detail,
          r.transitioned_at.toISOString(),
          r.actor_membership_id,
        ]),
      ).toEqual([
        [
          "active",
          "paused",
          "platform_ops_pause",
          "paused_until=2027-01-15T00:00:00.000Z",
          "2026-12-01T00:00:00.000Z",
          null,
        ],
        [
          "paused",
          "paused",
          "org_suspended_by_platform_admin",
          "compliance_hold",
          "2026-12-20T00:00:00.000Z",
          null,
        ],
      ]);
      const announced = await outboxRows(org, "m35.subscription.paused");
      expect(announced).toHaveLength(1);
      expect(announced[0].payload).toEqual({
        subscriptionId: subId,
        organizationId: org,
        pausedAt: "2026-12-01T00:00:00.000Z",
        pausedUntil: null,
      });

      // a redelivery finds an open-ended pause: nothing more is written or announced
      await send("2026-12-21T00:00:00Z", "m2.organization.suspended");
      expect(await historyRows(subId)).toHaveLength(2);
      expect(await outboxRows(org, "m35.subscription.paused")).toHaveLength(1);

      // reactivation resumes it (the sweep never would: the date is gone), closing the one continuous pause
      await send("2027-02-01T00:00:00Z", "m2.organization.activated");
      expect((await subscriptionRow(subId)).status).toBe("active");
      expect(
        (await historyRows(subId)).map((r) => [r.from_status, r.to_status, r.reason_code]),
      ).toEqual([
        ["active", "paused", "platform_ops_pause"],
        ["paused", "paused", "org_suspended_by_platform_admin"],
        ["paused", "active", "org_activated_by_platform_admin"],
      ]);
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
    // ── the hourly pause-resume sweep, on the real NOBYPASSRLS application role ─────────────────────────────────────────────────────────
    describe("pause-resume sweep: a lapsed operator pause is resumed, and composes with the `.suspended` consumer", () => {
      const PAUSED_AT = "2026-12-01T00:00:00.000Z";
      const UNTIL = "2026-12-15T00:00:00.000Z";
      const SWEPT_AT = new Date("2026-12-20T03:05:00Z");
      let subCounter = 0;
      const nextSubId = () => {
        subCounter += 1;
        return `dddddddd-0000-4000-8000-${String(subCounter).padStart(12, "0")}`;
      };

      /** An operator's pause as the admin route writes it: the row, and the ledger row whose detail keeps the end date. */
      async function seedOperatorPause(
        organizationId: string,
        until: string | null = UNTIL,
        startedAt = "2026-10-01T00:00:00Z",
      ): Promise<string> {
        const id = nextSubId();
        await seedSubscription({
          id,
          organizationId,
          status: "paused",
          startedAt,
        });
        await admin.query("UPDATE subscription SET paused_at=$2, paused_until=$3 WHERE id=$1", [
          id,
          PAUSED_AT,
          until,
        ]);
        await admin.query(
          `INSERT INTO subscription_state_history
             (subscription_id, organization_id, from_status, to_status, transitioned_at, reason_code, reason_detail)
           VALUES ($1,$2,'active','paused',$3,'platform_ops_pause',$4)`,
          [id, organizationId, PAUSED_AT, until ? `paused_until=${until}` : null],
        );
        return id;
      }

      const jobs = (listOrgs: M35JobDeps["listOrgs"], now: Date = SWEPT_AT): M35JobDeps => ({
        db: handle.db,
        platformRunner: (async () => {
          throw new Error("the sweep must not open a platform transaction");
        }) as never,
        outbox: publisher,
        listOrgs,
        now: () => now,
      });
      const only = (organizationId: string) => async () => [{ organizationId }];

      async function ledger(subscriptionId: string) {
        const { rows } = await admin.query(
          `SELECT from_status, to_status, reason_code, transitioned_at, actor_membership_id
             FROM subscription_state_history WHERE subscription_id=$1
            ORDER BY transitioned_at, id`,
          [subscriptionId],
        );
        return rows.map((r) => [
          r.from_status,
          r.to_status,
          r.reason_code,
          r.transitioned_at.toISOString(),
          r.actor_membership_id,
        ]);
      }
      /**
       * Wait until `count` sessions are blocked on a row lock in a `... FOR UPDATE` statement (polled from pg_stat_activity, not slept): the
       * races below queue two lock waiters behind a held lock, and the order they queue in is the order they are served in.
       */
      async function waitForLockWaiters(count: number, timeoutMs = 15_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const { rows } = await admin.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query ILIKE '%for update%'`,
          );
          if (rows[0].n >= count) return;
          if (Date.now() > deadline) throw new Error(`no ${count} sessions waiting on a row lock`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const suspendNow = (organizationId: string, now: Date = SWEPT_AT) =>
        buildM35OrgLifecycleConsumer({ db: handle.db, outbox: publisher, now: () => now }).handle({
          eventType: "m2.organization.suspended",
          organizationId,
          payload: { organizationId, reason: "compliance_hold" },
        });

      it("resumes a lapsed pause: the row is active with the pause columns cleared, the ledger is dated at the OLD end date, ONE resumed event; a second run changes nothing", async () => {
        const org = await newOrg();
        const subId = await seedOperatorPause(org);

        expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(1);

        const row = await subscriptionRow(subId);
        expect(row.status).toBe("active");
        expect(row.paused_at).toBeNull();
        expect(row.paused_until).toBeNull();
        expect(row.updated_at.toISOString()).toBe(SWEPT_AT.toISOString());
        expect(await ledger(subId)).toEqual([
          ["active", "paused", "platform_ops_pause", PAUSED_AT, null],
          ["paused", "active", "platform_ops_pause_lapsed", UNTIL, null], // the date, not the sweep's instant
        ]);
        const events = await outboxRows(org, "m35.subscription.resumed");
        expect(events).toHaveLength(1);
        expect(events[0].payload).toEqual({
          subscriptionId: subId,
          organizationId: org,
          resumedAt: UNTIL,
        });

        // the write-audit triggers (migration 0143) copy the sweep's rows into the tenant's audit trail, as the system: no operator, no actor
        // (the seed's own writes are `subscription.update` / `.insert` rows too, so what identifies the sweep's is the row's content)
        const audited = (
          await admin.query(
            `SELECT event_type, actor_kind, actor_user_id FROM audit_event
              WHERE organization_id=$1
                AND ((event_type='subscription.update' AND resource_id=$2::uuid AND after->>'status'='active')
                  OR (event_type='subscription_state_history.insert' AND after->>'subscription_id'=$2::text
                      AND after->>'reason_code'='platform_ops_pause_lapsed'))
              ORDER BY event_type`,
            [org, subId],
          )
        ).rows.map((r) => [r.event_type, r.actor_kind, r.actor_user_id]);
        expect(audited).toHaveLength(2);
        expect(audited).toEqual(
          expect.arrayContaining([
            ["subscription.update", "system", null],
            ["subscription_state_history.insert", "system", null],
          ]),
        );

        // idempotent: a second run (and a run an hour later) finds nothing
        expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(0);
        expect(
          await runPauseResumeForOrg(jobs(only(org), new Date("2026-12-20T04:05:00Z")), org),
        ).toBe(0);
        expect(await ledger(subId)).toHaveLength(2);
        expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(1);
        expect((await subscriptionRow(subId)).updated_at.toISOString()).toBe(
          SWEPT_AT.toISOString(),
        );
      });

      it("leaves an open-ended pause, a pause whose date is ahead, an active and a canceled subscription alone", async () => {
        const openEnded = await newOrg();
        const openId = await seedOperatorPause(openEnded, null);
        const ahead = await newOrg();
        const aheadId = await seedOperatorPause(ahead, "2027-01-15T00:00:00.000Z");
        const active = await newOrg();
        const activeId = nextSubId();
        await seedSubscription({
          id: activeId,
          organizationId: active,
          status: "active",
          startedAt: "2026-10-01T00:00:00Z",
        });
        const canceled = await newOrg();
        const canceledId = nextSubId();
        await seedSubscription({
          id: canceledId,
          organizationId: canceled,
          status: "canceled",
          startedAt: "2026-10-01T00:00:00Z",
        });
        const all = [openEnded, ahead, active, canceled];

        await runPauseResumeSweep(
          jobs(async () => all.map((organizationId) => ({ organizationId }))),
        );

        expect((await subscriptionRow(openId)).status).toBe("paused");
        expect((await subscriptionRow(aheadId)).status).toBe("paused");
        expect((await subscriptionRow(aheadId)).paused_until.toISOString()).toBe(
          "2027-01-15T00:00:00.000Z",
        );
        expect((await subscriptionRow(activeId)).status).toBe("active");
        expect((await subscriptionRow(canceledId)).status).toBe("canceled");
        for (const [org, id] of [
          [openEnded, openId],
          [ahead, aheadId],
        ] as const) {
          expect(await ledger(id)).toHaveLength(1); // only the seeded pause row
          expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
        }
      });

      it("RLS: the application role sees only its own org's subscriptions, and a sweep for org A cannot touch org B's lapsed pause", async () => {
        const orgA = await newOrg();
        const orgB = await newOrg();
        const subA = await seedOperatorPause(orgA);
        const subB = await seedOperatorPause(orgB);

        // with NO org predicate at all, the NOBYPASSRLS role reads one tenant's row under A's context
        const { withOrgContext } = await import("@chartwarden/tenancy");
        const visible = await withOrgContext(
          handle.db,
          { organizationId: orgA, userId: "" },
          async (tx) =>
            (
              (await (tx as typeof handle.db).execute(
                sql`SELECT id FROM subscription WHERE status = 'paused' AND paused_until IS NOT NULL`,
              )) as unknown as { rows: { id: string }[] }
            ).rows.map((r) => r.id),
        );
        expect(visible).toContain(subA);
        expect(visible).not.toContain(subB);

        expect(await runPauseResumeForOrg(jobs(only(orgA)), orgA)).toBe(1);
        expect((await subscriptionRow(subA)).status).toBe("active");
        expect((await subscriptionRow(subB)).status).toBe("paused"); // B's lapsed pause: untouched
        expect(await ledger(subB)).toHaveLength(1);
        expect(await outboxRows(orgB, "m35.subscription.resumed")).toHaveLength(0);

        expect(await runPauseResumeForOrg(jobs(only(orgB)), orgB)).toBe(1);
        expect((await subscriptionRow(subB)).status).toBe("active");
      });

      it("a SUSPENDED organization's subscription is never resumed: the fan-out lists active orgs only, and a suspension's pause carries no end date to lapse", async () => {
        // an operator's dated pause that was still running when the platform suspended the organization BEFORE the consumer made such a
        // pause open-ended (a suspension that predates it left the row dated), and whose date has now passed: the sweep must not visit it
        const suspendedOrg = await newOrg();
        const suspendedSub = await seedOperatorPause(suspendedOrg);
        await admin.query("UPDATE organization SET status='suspended' WHERE id=$1", [suspendedOrg]);
        const liveOrg = await newOrg();
        const liveSub = await seedOperatorPause(liveOrg);
        await admin.query("UPDATE organization SET status='active' WHERE id=$1", [liveOrg]);
        // the active-org enumerator's own filter (organization.status = 'active'; bootstrap/active-org-enumerator.ts)
        const activeOrgs = async () =>
          (
            await admin.query(
              "SELECT id FROM organization WHERE status='active' AND id IN ($1,$2)",
              [suspendedOrg, liveOrg],
            )
          ).rows.map((r) => ({ organizationId: r.id as string }));

        await runPauseResumeSweep(jobs(activeOrgs));

        expect((await subscriptionRow(liveSub)).status).toBe("active");
        expect((await subscriptionRow(suspendedSub)).status).toBe("paused");
        expect(await ledger(suspendedSub)).toHaveLength(1);
        expect(await outboxRows(suspendedOrg, "m35.subscription.resumed")).toHaveLength(0);

        // and a suspension's own pause (the consumer's) is open-ended: even a sweep pointed straight at it matches nothing
        const orgSuspendedNow = await newOrg();
        const activeSub = nextSubId();
        await seedSubscription({
          id: activeSub,
          organizationId: orgSuspendedNow,
          status: "active",
          startedAt: "2026-10-01T00:00:00Z",
        });
        await suspendNow(orgSuspendedNow, new Date("2026-12-01T00:00:00Z"));
        const paused = await subscriptionRow(activeSub);
        expect(paused.status).toBe("paused");
        expect(paused.paused_until).toBeNull();
        expect(await runPauseResumeForOrg(jobs(only(orgSuspendedNow)), orgSuspendedNow)).toBe(0);
        expect((await subscriptionRow(activeSub)).status).toBe("paused");

        // and a dated pause that was running when the suspension arrived is made open-ended by the consumer, so past its old date even a
        // sweep pointed straight at the suspended org (which the fan-out never does) matches nothing and the org stays billing-exempt
        const orgRunning = await newOrg();
        const runningSub = await seedOperatorPause(orgRunning); // Dec 1 .. Dec 15
        await suspendNow(orgRunning, new Date("2026-12-10T00:00:00Z"));
        expect((await subscriptionRow(runningSub)).paused_until).toBeNull();
        expect(
          await runPauseResumeForOrg(
            jobs(only(orgRunning), new Date("2026-12-20T03:05:00Z")),
            orgRunning,
          ),
        ).toBe(0);
        expect((await subscriptionRow(runningSub)).status).toBe("paused");
        expect(await outboxRows(orgRunning, "m35.subscription.resumed")).toHaveLength(0);
      });

      it("two lapsed pauses in one org: the sweep resumes only the org's LATEST subscription, the older one is untouched (even over repeated sweeps)", async () => {
        const org = await newOrg();
        // the older one is inserted FIRST, so the heap's first row is the older one: an unordered read would pick it
        const older = await seedOperatorPause(org, UNTIL, "2026-09-01T00:00:00Z");
        const latest = await seedOperatorPause(org, UNTIL, "2026-11-01T00:00:00Z");

        expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(1);
        expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(0);
        await runPauseResumeSweep(jobs(only(org)));

        expect((await subscriptionRow(latest)).status).toBe("active");
        const untouched = await subscriptionRow(older);
        expect(untouched.status).toBe("paused");
        expect(untouched.paused_until.toISOString()).toBe(UNTIL);
        expect(await ledger(older)).toHaveLength(1); // only its own pause row
        expect(await ledger(latest)).toHaveLength(2);
        const events = await outboxRows(org, "m35.subscription.resumed");
        expect(events.map((e) => e.payload.subscriptionId)).toEqual([latest]);
      });

      it("a lapsed pause under a NEWER canceled subscription is never resurrected: nothing is resumed, written or logged", async () => {
        const org = await newOrg();
        const superseded = await seedOperatorPause(org, UNTIL, "2026-09-01T00:00:00Z");
        const canceled = nextSubId();
        await seedSubscription({
          id: canceled,
          organizationId: org,
          status: "canceled",
          startedAt: "2026-11-01T00:00:00Z",
        });
        const logged: string[] = [];

        expect(
          await runPauseResumeForOrg({ ...jobs(only(org)), log: (m) => void logged.push(m) }, org),
        ).toBe(0);

        expect((await subscriptionRow(superseded)).status).toBe("paused");
        expect((await subscriptionRow(canceled)).status).toBe("canceled");
        expect(await ledger(superseded)).toHaveLength(1);
        expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
        expect(logged).toEqual([]);
      });

      it("a lapsed pause under a NEWER active subscription is left alone, with no warning every hour", async () => {
        const org = await newOrg();
        const oldPaused = await seedOperatorPause(org, UNTIL, "2026-09-01T00:00:00Z");
        const current = nextSubId();
        await seedSubscription({
          id: current,
          organizationId: org,
          status: "active",
          startedAt: "2026-12-10T00:00:00Z",
        });
        const logged: string[] = [];

        await runPauseResumeSweep({ ...jobs(only(org)), log: (m) => void logged.push(m) });
        await runPauseResumeSweep({ ...jobs(only(org)), log: (m) => void logged.push(m) });

        expect((await subscriptionRow(oldPaused)).status).toBe("paused");
        expect((await subscriptionRow(current)).status).toBe("active");
        expect(await ledger(oldPaused)).toHaveLength(1);
        expect(logged).toEqual([]);
      });

      describe("the exact blocked state: an OLDER subscription A is live, the newest B is paused with a date that has passed", () => {
        const TENANT_USER_BLOCKED = "0a000000-0000-4000-8000-0000000000b4";
        const tenantResume = (organizationId: string) =>
          buildDrizzleM35RouteService(handle.db, {
            outbox: publisher,
            now: () => SWEPT_AT,
          }).resumeSubscription({
            organizationId,
            userId: TENANT_USER_BLOCKED,
            roles: ["org_admin"],
            membershipId: "0b000000-0000-4000-8000-0000000000b4",
            stepUpRecent: true,
          });
        async function blockedOrg() {
          await admin.query(
            `INSERT INTO "user" (id,email,name) VALUES ($1,'tenant-b4@m35-live.example','tenant b4')
             ON CONFLICT (id) DO NOTHING`,
            [TENANT_USER_BLOCKED],
          );
          const org = await newOrg();
          const a = nextSubId();
          await seedSubscription({
            id: a,
            organizationId: org,
            status: "active",
            startedAt: "2026-09-01T00:00:00Z",
          });
          const b = await seedOperatorPause(org, UNTIL, "2026-11-01T00:00:00Z");
          return { org, a, b };
        }
        const HOUR_MS = 3_600_000;

        it("the tenant's resume is a typed 409 SUBSCRIPTION_OTHER_LIVE_EXISTS (not the unique index's raw failure), and nothing is written or announced", async () => {
          const { org, a, b } = await blockedOrg();
          const before = await subscriptionRow(b);

          await expect(tenantResume(org)).rejects.toMatchObject({
            code: "SUBSCRIPTION_OTHER_LIVE_EXISTS",
            statusCode: 409,
          });

          const after = await subscriptionRow(b);
          expect(after.status).toBe("paused");
          expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
          expect((await subscriptionRow(a)).status).toBe("active");
          expect(await ledger(b)).toHaveLength(1);
          expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
        });

        it("the sweep leaves it alone and reports it (log and ops alert) at most once a DAY per subscription; once the operator cancels A the next sweep resumes B", async () => {
          const { org, a, b } = await blockedOrg();
          const logged: string[] = [];
          const alerts: unknown[] = [];
          const sweepAt = (hours: number) =>
            runPauseResumeSweep({
              ...jobs(only(org), new Date(SWEPT_AT.getTime() + hours * HOUR_MS)),
              log: (m) => void logged.push(m),
              onPauseBlocked: (e) => void alerts.push(e),
            });

          await sweepAt(0);
          await sweepAt(1);
          await sweepAt(23);
          expect(alerts).toEqual([
            { organizationId: org, subscriptionId: b, olderLiveSubscriptionId: a },
          ]);
          expect(logged).toEqual([
            "m35 lapsed pause not resumed: an older subscription of the organization is live",
          ]);
          await sweepAt(25); // a day later: reported again
          expect(alerts).toHaveLength(2);
          expect((await subscriptionRow(b)).status).toBe("paused");
          expect(await ledger(b)).toHaveLength(1);

          // the operator cancels the older one (by id): the next tick resumes B, and B is forgotten
          await admin.query(
            "UPDATE subscription SET status='canceled', canceled_at=now() WHERE id=$1",
            [a],
          );
          await sweepAt(26);
          expect((await subscriptionRow(b)).status).toBe("active");
          expect(
            (await outboxRows(org, "m35.subscription.resumed")).map(
              (e) => e.payload.subscriptionId,
            ),
          ).toEqual([b]);
          expect(alerts).toHaveLength(2);
        });
      });

      it("a canceled subscription with a cancel-at-period-end flag still set is final: the tenant's resume is refused 409 SUBSCRIPTION_CANCELED and the row is not touched", async () => {
        await admin.query(
          `INSERT INTO "user" (id,email,name) VALUES ($1,'tenant-b5@m35-live.example','tenant b5')
           ON CONFLICT (id) DO NOTHING`,
          ["0a000000-0000-4000-8000-0000000000b5"],
        );
        const org = await newOrg();
        const subId = nextSubId();
        await seedSubscription({
          id: subId,
          organizationId: org,
          status: "canceled",
          cancelAtPeriodEnd: true,
          startedAt: "2026-10-01T00:00:00Z",
        });
        await admin.query(
          "UPDATE subscription SET canceled_at='2026-11-01T00:00:00Z' WHERE id=$1",
          [subId],
        );
        const before = await subscriptionRow(subId);

        await expect(
          buildDrizzleM35RouteService(handle.db, {
            outbox: publisher,
            now: () => SWEPT_AT,
          }).resumeSubscription({
            organizationId: org,
            userId: "0a000000-0000-4000-8000-0000000000b5",
            roles: ["org_admin"],
            membershipId: "0b000000-0000-4000-8000-0000000000b5",
            stepUpRecent: true,
          }),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELED", statusCode: 409 });

        const after = await subscriptionRow(subId);
        expect(after.status).toBe("canceled");
        expect(after.cancel_at_period_end).toBe(true); // the flag was not flipped
        expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
        expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
      });

      it("a lapsed pause under a NEWER open-ended pause (an org suspension's) is never resurrected", async () => {
        const org = await newOrg();
        const lapsed = await seedOperatorPause(org, UNTIL, "2026-09-01T00:00:00Z");
        const suspension = await seedOperatorPause(org, null, "2026-11-01T00:00:00Z");

        expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(0);

        expect((await subscriptionRow(lapsed)).status).toBe("paused");
        expect((await subscriptionRow(suspension)).status).toBe("paused");
        expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
      });

      describe("two subscriptions that START at the same instant (one transaction inserted both): every reader and writer picks the same one", () => {
        const SAME_START = "2026-10-01T00:00:00Z";
        const TIE_USER = "0a000000-0000-4000-8000-0000000000b6";
        const tieActor = (organizationId: string) => ({
          organizationId,
          userId: TIE_USER,
          roles: ["org_admin"],
          membershipId: "0b000000-0000-4000-8000-0000000000b6",
          stepUpRecent: true,
        });
        const service = () =>
          buildDrizzleM35RouteService(handle.db, { outbox: publisher, now: () => SWEPT_AT });
        /** Both paused with a lapsed date. The lower id is inserted FIRST, so the heap's first row is not the winner: only the id picks. */
        async function tiedOrg() {
          await admin.query(
            `INSERT INTO "user" (id,email,name) VALUES ($1,'tenant-b6@m35-live.example','tenant b6')
             ON CONFLICT (id) DO NOTHING`,
            [TIE_USER],
          );
          const org = await newOrg();
          const low = await seedOperatorPause(org, UNTIL, SAME_START);
          const high = await seedOperatorPause(org, UNTIL, SAME_START);
          expect(high > low).toBe(true);
          return { org, low, high };
        }

        it("the tenant's read, the sweep, the tenant's resume and the suspension consumer all act on the higher id", async () => {
          const read = await tiedOrg();
          expect((await service().getSubscription(tieActor(read.org)))?.id).toBe(read.high);

          const sweep = await tiedOrg();
          expect(await runPauseResumeForOrg(jobs(only(sweep.org)), sweep.org)).toBe(1);
          expect((await subscriptionRow(sweep.high)).status).toBe("active");
          expect((await subscriptionRow(sweep.low)).status).toBe("paused");

          const tenant = await tiedOrg();
          expect((await service().resumeSubscription(tieActor(tenant.org))).id).toBe(tenant.high);
          expect((await subscriptionRow(tenant.high)).status).toBe("active");
          expect((await subscriptionRow(tenant.low)).status).toBe("paused");

          const consumerOrg = await tiedOrg();
          await suspendNow(consumerOrg.org);
          expect((await ledger(consumerOrg.high)).map((r) => r[2])).toEqual([
            "platform_ops_pause",
            "platform_ops_pause_lapsed",
            "org_suspended_by_platform_admin",
          ]);
          expect(await ledger(consumerOrg.low)).toHaveLength(1);
        });
      });

      it("an organization whose newest subscription is NOT a lapsed pause takes no row lock: a held lock does not stall its sweep", async () => {
        const org = await newOrg();
        const active = nextSubId();
        await seedSubscription({
          id: active,
          organizationId: org,
          status: "active",
          startedAt: "2026-10-01T00:00:00Z",
        });
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM subscription WHERE id=$1 FOR UPDATE", [active]);

          const outcome = await Promise.race([
            runPauseResumeForOrg(jobs(only(org)), org).then(() => "done"),
            new Promise((resolve) => setTimeout(() => resolve("stalled"), 4_000)),
          ]);

          expect(outcome).toBe("done"); // read plainly: the holder's lock was never waited on
        } finally {
          await holder.query("ROLLBACK");
          await holder.end();
        }
      });

      it("a lapsed pause whose row is held longer than the lock timeout fails THAT org's run (SQLSTATE 55P03), the other orgs are still processed, and the next run resumes it", async () => {
        const stuckOrg = await newOrg();
        const stuck = await seedOperatorPause(stuckOrg);
        const freeOrg = await newOrg();
        const free = await seedOperatorPause(freeOrg);
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        const both = async () => [{ organizationId: stuckOrg }, { organizationId: freeOrg }];
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM subscription WHERE id=$1 FOR UPDATE", [stuck]);

          const failure = await runPauseResumeSweep({
            ...jobs(both),
            lockTimeoutMs: 300,
            log: () => undefined,
          }).then(
            () => null,
            (error: unknown) => error as AggregateError,
          );

          expect(failure).toBeInstanceOf(AggregateError);
          const [first] = (failure as AggregateError).errors as {
            code?: string;
            cause?: { code?: string };
          }[];
          expect(first?.cause?.code ?? first?.code).toBe("55P03");
          expect((await subscriptionRow(stuck)).status).toBe("paused"); // nothing of the failed run survived
          expect(await ledger(stuck)).toHaveLength(1);
          expect((await subscriptionRow(free)).status).toBe("active"); // the next org in the fan-out was still processed
        } finally {
          await holder.query("COMMIT");
          await holder.end();
        }

        await runPauseResumeSweep(jobs(both)); // the next hour
        expect((await subscriptionRow(stuck)).status).toBe("active");
      });

      it("a failing publish rolls the WHOLE org transaction back (no ledger row, status unchanged, no event), the other orgs are still processed, and the next run retries it", async () => {
        const badOrg = await newOrg();
        const badSub = await seedOperatorPause(badOrg);
        const goodOrg = await newOrg();
        const goodSub = await seedOperatorPause(goodOrg);
        const before = await subscriptionRow(badSub);
        const refusing: M35JobDeps["outbox"] = {
          publish: async (tx, input) => {
            if (input.organizationId === badOrg) throw new Error("catalog refused");
            await publisher.publish(tx, input);
          },
        };
        const both = async () => [{ organizationId: badOrg }, { organizationId: goodOrg }];

        await expect(
          runPauseResumeSweep({ ...jobs(both), outbox: refusing, log: () => undefined }),
        ).rejects.toThrow(/pause_resume: 1 org\(s\) failed/);

        // the failed org: nothing of the transaction survived
        const bad = await subscriptionRow(badSub);
        expect(bad.status).toBe("paused");
        expect(bad.paused_until.toISOString()).toBe(UNTIL);
        expect(bad.paused_at.toISOString()).toBe(before.paused_at.toISOString());
        expect(bad.updated_at.toISOString()).toBe(before.updated_at.toISOString());
        expect(await ledger(badSub)).toHaveLength(1);
        expect(await outboxRows(badOrg, "m35.subscription.resumed")).toHaveLength(0);
        // the other org was processed, and the job still failed
        expect((await subscriptionRow(goodSub)).status).toBe("active");
        expect(await outboxRows(goodOrg, "m35.subscription.resumed")).toHaveLength(1);

        // the next run, with a healthy publisher, retries the failed org
        await runPauseResumeSweep(jobs(both));
        expect((await subscriptionRow(badSub)).status).toBe("active");
        expect(await outboxRows(badOrg, "m35.subscription.resumed")).toHaveLength(1);
        expect(await outboxRows(goodOrg, "m35.subscription.resumed")).toHaveLength(1);
      });

      describe("a tenant's own resume racing the sweep (a raw transaction holds the row, so both really wait)", () => {
        const TENANT_USER = "0a000000-0000-4000-8000-0000000000b3";
        const tenantActor = (organizationId: string): M35WriteActor => ({
          organizationId,
          userId: TENANT_USER,
          roles: ["org_admin"],
          membershipId: "0b000000-0000-4000-8000-0000000000b3",
          stepUpRecent: true,
        });
        const tenantResume = (organizationId: string) =>
          buildDrizzleM35RouteService(handle.db, {
            outbox: publisher,
            now: () => SWEPT_AT,
          }).resumeSubscription(tenantActor(organizationId));

        async function race(order: "sweep first" | "tenant first") {
          await admin.query(
            `INSERT INTO "user" (id,email,name) VALUES ($1,'tenant-b3@m35-live.example','tenant b3')
             ON CONFLICT (id) DO NOTHING`,
            [TENANT_USER],
          );
          const org = await newOrg();
          const subId = await seedOperatorPause(org);
          const holder = new Client({ connectionString: DB_URL });
          await holder.connect();
          try {
            await holder.query("BEGIN");
            await holder.query("SELECT id FROM subscription WHERE id=$1 FOR UPDATE", [subId]);
            const sweep = () => runPauseResumeForOrg(jobs(only(org)), org);
            const first = order === "sweep first" ? sweep() : tenantResume(org);
            await waitForLockWaiters(1); // the first is queued behind the holder's lock ...
            const second = order === "sweep first" ? tenantResume(org) : sweep();
            await waitForLockWaiters(2); // ... then the second behind it
            await holder.query("COMMIT");
            const [a, b] = await Promise.allSettled([first, second]);
            return {
              org,
              subId,
              sweep: order === "sweep first" ? a : b,
              tenant: order === "sweep first" ? b : a,
            };
          } finally {
            await holder.end();
          }
        }

        it("sweep first: the sweep resumes it (one lapse row), and the tenant's resume is refused 409 with nothing written or announced", async () => {
          const { org, subId, sweep, tenant } = await race("sweep first");

          expect(sweep).toMatchObject({ status: "fulfilled", value: 1 });
          expect(tenant).toMatchObject({
            status: "rejected",
            reason: { code: "SUBSCRIPTION_NOT_PAUSED", statusCode: 409 },
          });
          expect((await subscriptionRow(subId)).status).toBe("active");
          expect((await ledger(subId)).map((r) => r[2])).toEqual([
            "platform_ops_pause",
            "platform_ops_pause_lapsed",
          ]);
          const events = await outboxRows(org, "m35.subscription.resumed");
          expect(events).toHaveLength(1);
          expect(events[0].payload.resumedAt).toBe(UNTIL);
        });

        it("tenant first: the tenant resumes it, the sweep then finds an active row and writes nothing: exactly one resumed event", async () => {
          const { org, subId, sweep, tenant } = await race("tenant first");

          expect(tenant).toMatchObject({ status: "fulfilled" });
          expect(sweep).toMatchObject({ status: "fulfilled", value: 0 });
          expect((await subscriptionRow(subId)).status).toBe("active");
          // the tenant route writes no ledger row of its own (it never has); the sweep added none
          expect((await ledger(subId)).map((r) => r[2])).toEqual(["platform_ops_pause"]);
          const events = await outboxRows(org, "m35.subscription.resumed");
          expect(events).toHaveLength(1);
          expect(events[0].payload.resumedAt).toBe(SWEPT_AT.toISOString());
        });

        it("a tenant's resume of a subscription that is neither paused nor scheduled to cancel is refused 409; one scheduled to cancel just clears the schedule, announcing nothing", async () => {
          await admin.query(
            `INSERT INTO "user" (id,email,name) VALUES ($1,'tenant-b3@m35-live.example','tenant b3')
             ON CONFLICT (id) DO NOTHING`,
            [TENANT_USER],
          );
          const idle = await newOrg();
          const idleSub = nextSubId();
          await seedSubscription({
            id: idleSub,
            organizationId: idle,
            status: "active",
            startedAt: "2026-10-01T00:00:00Z",
          });
          await expect(tenantResume(idle)).rejects.toMatchObject({
            code: "SUBSCRIPTION_NOT_PAUSED",
            statusCode: 409,
          });
          expect(await outboxRows(idle, "m35.subscription.resumed")).toHaveLength(0);

          const scheduled = await newOrg();
          const scheduledSub = nextSubId();
          await seedSubscription({
            id: scheduledSub,
            organizationId: scheduled,
            status: "active",
            cancelAtPeriodEnd: true,
            startedAt: "2026-10-01T00:00:00Z",
          });
          await tenantResume(scheduled);
          expect((await subscriptionRow(scheduledSub)).cancel_at_period_end).toBe(false);
          expect(await outboxRows(scheduled, "m35.subscription.resumed")).toHaveLength(0);
        });
      });

      describe("the `.activated` consumer (which reads the same row under the same lock) against the sweep", () => {
        const activate = (organizationId: string) =>
          buildM35OrgLifecycleConsumer({
            db: handle.db,
            outbox: publisher,
            now: () => SWEPT_AT,
          }).handle({
            eventType: "m2.organization.activated",
            organizationId,
            payload: { organizationId, reason: "reinstated" },
          });
        const resumedLedger = async (subId: string) =>
          (await ledger(subId)).filter((r) => r[0] === "paused" && r[1] === "active");

        it("sweep first: the activation finds an active row: one resume in total", async () => {
          const org = await newOrg();
          const subId = await seedOperatorPause(org);

          await runPauseResumeForOrg(jobs(only(org)), org);
          await activate(org);

          expect((await subscriptionRow(subId)).status).toBe("active");
          expect((await resumedLedger(subId)).map((r) => r[2])).toEqual([
            "platform_ops_pause_lapsed",
          ]);
          expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(1);
        });

        it("activation first: the sweep finds an active row: one resume in total", async () => {
          const org = await newOrg();
          const subId = await seedOperatorPause(org);

          await activate(org);
          expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(0);

          expect((await subscriptionRow(subId)).status).toBe("active");
          expect((await resumedLedger(subId)).map((r) => r[2])).toEqual([
            "org_activated_by_platform_admin",
          ]);
          expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(1);
        });

        it("a REAL race (both at once, many times): always exactly one resume, one ledger row out of the pause, one event", async () => {
          for (let i = 0; i < 12; i += 1) {
            const org = await newOrg();
            const subId = await seedOperatorPause(org);

            await Promise.all([runPauseResumeForOrg(jobs(only(org)), org), activate(org)]);

            expect((await subscriptionRow(subId)).status).toBe("active");
            expect(await resumedLedger(subId)).toHaveLength(1);
            expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(1);
          }
        });
      });

      describe("either order against the `.suspended` consumer", () => {
        const threeRows = (subId: string) => [
          ["active", "paused", "platform_ops_pause", PAUSED_AT, null],
          ["paused", "active", "platform_ops_pause_lapsed", UNTIL, null],
          ["active", "paused", "org_suspended_by_platform_admin", SWEPT_AT.toISOString(), null],
        ];

        it("sweep first: the consumer meets an active row and writes a plain suspension; exactly one lapse row", async () => {
          const org = await newOrg();
          const subId = await seedOperatorPause(org);

          await runPauseResumeForOrg(jobs(only(org)), org);
          await suspendNow(org);

          expect(await ledger(subId)).toEqual(threeRows(subId));
          const row = await subscriptionRow(subId);
          expect(row.status).toBe("paused");
          expect(row.paused_until).toBeNull();
          expect(row.paused_at.toISOString()).toBe(SWEPT_AT.toISOString());
          expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(1);
          expect(await outboxRows(org, "m35.subscription.paused")).toHaveLength(1);
        });

        it("consumer first: it writes the lapse and the new open-ended pause itself, so the sweep finds nothing and adds nothing", async () => {
          const org = await newOrg();
          const subId = await seedOperatorPause(org);

          await suspendNow(org);
          expect(await runPauseResumeForOrg(jobs(only(org)), org)).toBe(0);

          expect(await ledger(subId)).toEqual(threeRows(subId));
          expect((await subscriptionRow(subId)).paused_until).toBeNull();
          expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
          expect(await outboxRows(org, "m35.subscription.paused")).toHaveLength(1);
        });

        it("a REAL race (the sweep and the suspension at once, many times): always one lapse row, one suspension row, a paused open-ended row, never a dropped suspension", async () => {
          for (let i = 0; i < 12; i += 1) {
            const org = await newOrg();
            const subId = await seedOperatorPause(org);

            await Promise.all([runPauseResumeForOrg(jobs(only(org)), org), suspendNow(org)]);

            expect(await ledger(subId)).toEqual(threeRows(subId));
            const row = await subscriptionRow(subId);
            expect(row.status).toBe("paused");
            expect(row.paused_until).toBeNull();
            // whichever won, the suspension is announced once; the resume is announced only if the sweep won
            expect(await outboxRows(org, "m35.subscription.paused")).toHaveLength(1);
            expect((await outboxRows(org, "m35.subscription.resumed")).length).toBeLessThanOrEqual(
              1,
            );
          }
        });
      });

      it("a lost race to an operator's resume (a writer holding the row): the sweep waits on the lock, then updates nothing, writes no ledger row and no event", async () => {
        const org = await newOrg();
        const subId = await seedOperatorPause(org);
        const operator = new Client({ connectionString: DB_URL });
        await operator.connect();
        try {
          await operator.query("BEGIN");
          // the operator's resume, as adminResumeSubscription writes it, not yet committed
          await operator.query(
            "UPDATE subscription SET status='active', paused_at=NULL, paused_until=NULL, updated_at=$2 WHERE id=$1",
            [subId, "2026-12-20T03:00:00Z"],
          );
          await operator.query(
            `INSERT INTO subscription_state_history
               (subscription_id, organization_id, from_status, to_status, transitioned_at, reason_code)
             VALUES ($1,$2,'paused','active','2026-12-20T03:00:00Z','platform_ops_resume')`,
            [subId, org],
          );
          const sweep = runPauseResumeForOrg(jobs(only(org)), org);
          await waitForLockWaiters(1); // it is waiting on the operator's row lock, not racing past it
          await operator.query("COMMIT");

          expect(await sweep).toBe(0);
        } finally {
          await operator.end();
        }
        expect(await ledger(subId)).toEqual([
          ["active", "paused", "platform_ops_pause", PAUSED_AT, null],
          ["paused", "active", "platform_ops_resume", "2026-12-20T03:00:00.000Z", null],
        ]);
        expect(await outboxRows(org, "m35.subscription.resumed")).toHaveLength(0);
        expect((await subscriptionRow(subId)).updated_at.toISOString()).toBe(
          "2026-12-20T03:00:00.000Z",
        );
      });
    });
  },
);
