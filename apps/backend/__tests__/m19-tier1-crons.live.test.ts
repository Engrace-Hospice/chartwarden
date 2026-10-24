/**
 * GAP-057 (M19 §4.8) — the Tier-1 crons, LIVE: `m19.shift-open.cron`, `m19.shift-close.cron` and
 * `m19.coverage-gap-watchdog.cron`.
 *
 * THE FINDING. Only the roster-sync workers existed. `activateShift`/`completeShift` ran only from the
 * manual route, the only `coverage_gap` emit was the reactive D10 arm, so a shift past its start never
 * opened on its own and a provider entity with no RN in the next 24 hours raised nothing.
 *
 * WHY LIVE. The due predicates, the `(status, version)`-guarded UPDATE, the policy-snapshot pin, the outbox
 * row committed in the same org transaction and the cross-tenant isolation are all statements about Postgres
 * and RLS — proven here on the real NOBYPASSRLS `chartwarden_app` role with the REAL catalog-validating
 * publisher (never NOOP_OUTBOX).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m19:tier1-crons:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type DbClient, createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type M19CoverageGapDeps,
  type M19ShiftCronDeps,
  M19_OUTBOX_EVENTS,
  runCoverageGapWatchdogTick,
  runShiftCloseTick,
  runShiftOpenTick,
} from "../src/modules/19-oncall/index";
import { MAX_SHIFTS_PER_ORG_PER_TICK } from "../src/modules/19-oncall/jobs/shift-cron";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-1111057a19b0";
const ORG_B = "22222222-2222-4222-8222-2222057b19b0";

const NOW = new Date("2026-10-05T03:00:00.000Z");
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

type Seed = { pe: string; member: string };

describe.skipIf(!DB_URL)("GAP-057 M19 §4.8 Tier-1 crons — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const seeded: Record<string, Seed> = {};

  const depsFor = (orgs: readonly string[]): M19ShiftCronDeps & M19CoverageGapDeps => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M19_OUTBOX_EVENTS]));
    return {
      db: handle.db,
      activeOrgs: {
        listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
      },
      outbox: { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m19" }) },
      providerEntities: buildFoundationSiteReader(),
      now: () => NOW,
    };
  };

  async function insertShift(
    org: string,
    startsAt: Date,
    endsAt: Date,
    status: "scheduled" | "active" | "completed" = "scheduled",
    discipline = "clinical_rn",
  ): Promise<string> {
    const s = seeded[org] as Seed;
    const openedAt = status === "scheduled" ? null : startsAt;
    const closedAt = status === "completed" ? endsAt : null;
    const { rows } = await admin.query(
      `INSERT INTO on_call_shift
         (organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
          primary_on_call_membership_id, policy_snapshot, status, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{"provisional":true}'::jsonb,$7,$8,$9) RETURNING id`,
      [org, s.pe, startsAt, endsAt, discipline, s.member, status, openedAt, closedAt],
    );
    return rows[0].id as string;
  }

  const shift = async (id: string) =>
    (await admin.query("SELECT * FROM on_call_shift WHERE id = $1", [id])).rows[0];

  const outbox = async (org: string, eventType: string) =>
    (
      await admin.query(
        "SELECT payload, aggregate_id FROM outbox_event WHERE organization_id = $1 AND event_type = $2",
        [org, eventType],
      )
    ).rows;

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'g057-a','A','A','active'),($2,'g057-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `g057-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end, status)
           VALUES ($1,$2,$3,$4,'enc','12-31','active') RETURNING id`,
          [
            org,
            `CCN-G057-${org.slice(0, 4)}`,
            `G057 ${org.slice(0, 4)}`,
            `NPI-G057-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO tenant_oncall_policy
           (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
         VALUES ($1,$2,'direct','{"t":1}'::jsonb,'{}'::jsonb)`,
        [org, pe],
      );
      seeded[org] = { pe, member };
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM on_call_shift");
    await admin.query("DELETE FROM outbox_event");
    await admin.query(
      "UPDATE tenant_oncall_policy SET model = 'direct', escalation_tiers = '{\"t\":1}'::jsonb",
    );
  });

  describe("shift-open", () => {
    it("opens a due shift: active, opened_at stamped, D7 policy pinned, activated event published; a future shift is untouched", async () => {
      const due = await insertShift(ORG_A, hoursFromNow(-0.1), hoursFromNow(8));
      const future = await insertShift(ORG_A, hoursFromNow(2), hoursFromNow(10));

      await runShiftOpenTick(depsFor([ORG_A]));

      const row = await shift(due);
      expect(row.status).toBe("active");
      expect(new Date(row.opened_at).toISOString()).toBe(NOW.toISOString());
      expect(row.policy_snapshot.escalation_tiers ?? row.policy_snapshot.escalationTiers).toEqual({
        t: 1,
      });
      expect((await shift(future)).status).toBe("scheduled");
      const events = await outbox(ORG_A, "m19.oncall_shift.activated");
      expect(events).toHaveLength(1);
      expect(events[0].aggregate_id).toBe(due);
    });

    it("is idempotent: a re-run opens nothing and publishes nothing more", async () => {
      await insertShift(ORG_A, hoursFromNow(-1), hoursFromNow(8));
      await runShiftOpenTick(depsFor([ORG_A]));
      const second = await runShiftOpenTick(depsFor([ORG_A]));
      expect(second.get(ORG_A)).toEqual({ changed: 0, cancelled: 0, skipped: 0 });
      expect(await outbox(ORG_A, "m19.oncall_shift.activated")).toHaveLength(1);
    });

    it("cancels (never opens) a window that elapsed unopened, and publishes nothing", async () => {
      const missed = await insertShift(ORG_A, hoursFromNow(-9), hoursFromNow(-1));
      await runShiftOpenTick(depsFor([ORG_A]));
      const row = await shift(missed);
      expect(row.status).toBe("cancelled");
      expect(row.opened_at).toBeNull();
      expect(row.cancellation_reason).toMatch(/^system:/);
      expect(await outbox(ORG_A, "m19.oncall_shift.activated")).toHaveLength(0);
    });

    it("is bounded: at most MAX_SHIFTS_PER_ORG_PER_TICK shifts per org per tick, the rest drain next tick", async () => {
      const total = MAX_SHIFTS_PER_ORG_PER_TICK + 5;
      for (let i = 0; i < total; i++) {
        await insertShift(ORG_A, new Date(NOW.getTime() - (total - i) * 60_000), hoursFromNow(8));
      }
      const first = await runShiftOpenTick(depsFor([ORG_A]));
      expect(first.get(ORG_A)?.changed).toBe(MAX_SHIFTS_PER_ORG_PER_TICK);
      const second = await runShiftOpenTick(depsFor([ORG_A]));
      expect(second.get(ORG_A)?.changed).toBe(5);
    });

    it("one org's failure does not stop the others: a shift with no policy fails org A, org B still opens", async () => {
      await admin.query("DELETE FROM tenant_oncall_policy WHERE organization_id = $1", [ORG_A]);
      const a = await insertShift(ORG_A, hoursFromNow(-1), hoursFromNow(8));
      const b = await insertShift(ORG_B, hoursFromNow(-1), hoursFromNow(8));
      try {
        await expect(runShiftOpenTick(depsFor([ORG_A, ORG_B]))).rejects.toThrow(/M19_SHIFT_OPEN/);
        expect((await shift(a)).status).toBe("scheduled"); // rolled back, retried next tick
        expect((await shift(b)).status).toBe("active");
      } finally {
        await admin.query(
          `INSERT INTO tenant_oncall_policy (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
           VALUES ($1,$2,'direct','{"t":1}'::jsonb,'{}'::jsonb)`,
          [ORG_A, (seeded[ORG_A] as Seed).pe],
        );
      }
    });

    it("cross-tenant: a tick scoped to org A never touches org B's due shift", async () => {
      const b = await insertShift(ORG_B, hoursFromNow(-1), hoursFromNow(8));
      await runShiftOpenTick(depsFor([ORG_A]));
      expect((await shift(b)).status).toBe("scheduled");
      expect(await outbox(ORG_B, "m19.oncall_shift.activated")).toHaveLength(0);
    });
  });

  describe("shift-close", () => {
    it("closes an active shift past its end (completed, closed_at, completed event); a still-running one is untouched", async () => {
      const over = await insertShift(ORG_A, hoursFromNow(-9), hoursFromNow(-1), "active");
      const running = await insertShift(ORG_A, hoursFromNow(-1), hoursFromNow(7), "active");

      await runShiftCloseTick(depsFor([ORG_A]));

      const row = await shift(over);
      expect(row.status).toBe("completed");
      expect(new Date(row.closed_at).toISOString()).toBe(NOW.toISOString());
      expect((await shift(running)).status).toBe("active");
      const events = await outbox(ORG_A, "m19.oncall_shift.completed");
      expect(events).toHaveLength(1);
      expect(events[0].aggregate_id).toBe(over);
    });

    it("is idempotent, and never closes a scheduled (unopened) shift", async () => {
      await insertShift(ORG_A, hoursFromNow(-9), hoursFromNow(-1), "active");
      const unopened = await insertShift(ORG_A, hoursFromNow(-9), hoursFromNow(-1), "scheduled");
      await runShiftCloseTick(depsFor([ORG_A]));
      const second = await runShiftCloseTick(depsFor([ORG_A]));
      expect(second.get(ORG_A)).toEqual({ changed: 0, cancelled: 0, skipped: 0 });
      expect(await outbox(ORG_A, "m19.oncall_shift.completed")).toHaveLength(1);
      expect((await shift(unopened)).status).toBe("scheduled");
    });

    it("cross-tenant: a tick scoped to org A never closes org B's overdue shift", async () => {
      const b = await insertShift(ORG_B, hoursFromNow(-9), hoursFromNow(-1), "active");
      await runShiftCloseTick(depsFor([ORG_A]));
      expect((await shift(b)).status).toBe("active");
    });
  });

  describe("coverage-gap watchdog", () => {
    const gaps = async (org: string) => outbox(org, "m19.oncall_shift.coverage_gap");

    it("a provider entity with no RN shift in the next 24h publishes coverage_gap for the whole window", async () => {
      await runCoverageGapWatchdogTick(depsFor([ORG_A]));
      const events = await gaps(ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0].aggregate_id).toBe((seeded[ORG_A] as Seed).pe);
      expect(events[0].payload).toMatchObject({
        organizationId: ORG_A,
        providerEntityId: (seeded[ORG_A] as Seed).pe,
        gapStartsAt: NOW.toISOString(),
        gapEndsAt: hoursFromNow(24).toISOString(),
        discipline: "clinical_rn",
      });
    });

    it("fully covered (scheduled + active RN shifts back to back) raises nothing", async () => {
      await insertShift(ORG_A, hoursFromNow(-2), hoursFromNow(10), "active");
      await insertShift(ORG_A, hoursFromNow(10), hoursFromNow(30));
      await runCoverageGapWatchdogTick(depsFor([ORG_A]));
      expect(await gaps(ORG_A)).toHaveLength(0);
    });

    it("reports the hole between shifts, and a non-RN or completed shift does not count as coverage", async () => {
      await insertShift(ORG_A, hoursFromNow(-2), hoursFromNow(6), "active");
      await insertShift(ORG_A, hoursFromNow(6), hoursFromNow(30), "scheduled", "chaplain");
      await insertShift(ORG_A, hoursFromNow(6), hoursFromNow(30), "completed");
      await runCoverageGapWatchdogTick(depsFor([ORG_A]));
      const events = await gaps(ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        gapStartsAt: hoursFromNow(6).toISOString(),
        gapEndsAt: hoursFromNow(24).toISOString(),
      });
    });

    it("a standing gap re-fires on the next tick (one event per tick)", async () => {
      await runCoverageGapWatchdogTick(depsFor([ORG_A]));
      await runCoverageGapWatchdogTick(depsFor([ORG_A]));
      expect(await gaps(ORG_A)).toHaveLength(2);
    });

    it("does not watch a provider entity that has no on-call policy (no coverage promise to break)", async () => {
      await admin.query("DELETE FROM tenant_oncall_policy WHERE organization_id = $1", [ORG_A]);
      try {
        await runCoverageGapWatchdogTick(depsFor([ORG_A]));
        expect(await gaps(ORG_A)).toHaveLength(0);
      } finally {
        await admin.query(
          `INSERT INTO tenant_oncall_policy (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
           VALUES ($1,$2,'direct','{"t":1}'::jsonb,'{}'::jsonb)`,
          [ORG_A, (seeded[ORG_A] as Seed).pe],
        );
      }
    });

    it("cross-tenant: org A's gap is published under org A only; org B's own coverage is not confused with it", async () => {
      await insertShift(ORG_B, hoursFromNow(-2), hoursFromNow(30), "active");
      await runCoverageGapWatchdogTick(depsFor([ORG_A, ORG_B]));
      expect(await gaps(ORG_A)).toHaveLength(1);
      expect(await gaps(ORG_B)).toHaveLength(0);
      // The app role under org A's context cannot even see org B's shift (RLS), so it can never count it.
      const visible = await withOrgContext(
        handle.db,
        { organizationId: ORG_A, userId: "" },
        async (tx) => (await (tx as DbClient).select().from(schema.onCallShift)).length,
      );
      expect(visible).toBe(0);
    });
  });
});
