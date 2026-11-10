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
      ): Promise<string> {
        const id = nextSubId();
        await seedSubscription({
          id,
          organizationId,
          status: "paused",
          startedAt: "2026-10-01T00:00:00Z",
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

      it("a superseded pause is left alone when the org started another subscription (resuming it would break one-live-per-org), and the org's sweep does not fail", async () => {
        const org = await newOrg();
        const oldPaused = await seedOperatorPause(org);
        const current = nextSubId();
        await seedSubscription({
          id: current,
          organizationId: org,
          status: "active",
          startedAt: "2026-12-10T00:00:00Z",
        });
        const logged: string[] = [];

        await runPauseResumeSweep({ ...jobs(only(org)), log: (m) => void logged.push(m) });

        expect((await subscriptionRow(oldPaused)).status).toBe("paused");
        expect((await subscriptionRow(current)).status).toBe("active");
        expect(await ledger(oldPaused)).toHaveLength(1);
        expect(logged).toEqual([
          "m35 lapsed pause not resumed: the organization has another live subscription",
        ]);
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
          let settled = false;
          const sweep = runPauseResumeForOrg(jobs(only(org)), org).finally(() => {
            settled = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 600));
          expect(settled).toBe(false); // it is waiting on the operator's row lock, not racing past it
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
