/**
 * GAP-050 — scheduled reports are creatable again, proven over real Postgres as the NOBYPASSRLS
 * `wardenx_app` role.
 *
 * `CronPort.nextRunAfter` was a fail-closed stub (`M33InfraPortUnbound`, a 5xx), and the production
 * write service computes `next_run_at` through it on THREE paths — create, update, resume. So no tenant
 * could create a scheduled report at all, and the §4.8 `report.scheduled_run` cron had nothing to fire:
 * M33's whole scheduled-delivery half was unreachable in production. The in-memory slice binds a
 * deterministic stub cron, so `reporting-inject.test.ts` created, updated and resumed schedules happily
 * throughout — which is exactly why the route suite never noticed.
 *
 * These tests drive `createDrizzleM33WriteBackend` — the service the composition root mounts — with the
 * production `LIVE_CRON` adapter, against real rows under real RLS.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m33:schedule-cron:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { ReportDefinitionRepository, ReportViewRepository } from "@chartwarden/reporting";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CronExpressionInvalidError,
  CronTooFrequentError,
  createDrizzleM33WriteBackend,
} from "../src/modules/33-reporting/routes/index";
import { LIVE_CRON } from "../src/modules/33-reporting/wiring";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111151";
const ORG_B = "22222222-2222-2222-2222-222222222252";
const USER = "33333333-3333-3333-3333-333333333353";

describe.skipIf(!DB_URL)("GAP-050 — M33 schedule cron, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let seedDb: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDrizzleM33WriteBackend>["service"];
  const memberOf: Record<string, string> = {};
  const viewOf: Record<string, string> = {};

  /** The SAME actor shape `writeActorOf` builds from a real session: org + user id + active membership. */
  const actorFor = (org: string) => ({
    organizationId: org,
    userId: USER,
    membershipId: memberOf[org] as string,
    roles: ["administrator"],
  });

  /** The persisted `next_run_at`, read back with a SEPARATE superuser connection (never the writer's). */
  async function nextRunAtOf(scheduleId: string): Promise<Date | null> {
    const { rows } = await admin.query("SELECT next_run_at FROM report_schedule WHERE id=$1", [
      scheduleId,
    ]);
    return (rows[0]?.next_run_at as Date | null) ?? null;
  }
  /** How many schedules the tenant actually owns — a refused create must leave NO row behind. */
  async function scheduleCount(org: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM report_schedule WHERE organization_id=$1",
      [org],
    );
    return rows[0].n as number;
  }
  /** The wall-clock hour `instant` lands on in `tz` — what a tenant actually experiences. */
  const localHour = (instant: Date, tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
      instant,
    );

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
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-cron-a','A','A'),($2,'org-cron-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'cron@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    seedDb = createDbClient({ connectionString: DB_URL as string });

    // One saved view per tenant over the migration-0061 `census_org_daily` base (schema fixture, seeded
    // as superuser — the code under test is the schedule write path, not the definition chain).
    for (const org of [ORG_A, ORG_B]) {
      const defRepo = new ReportDefinitionRepository(seedDb.db);
      const definition = await defRepo.createDefinition({
        organizationId: org,
        authorship: "tenant",
        baseKey: "census_org_daily",
        ownerMembershipId: memberOf[org] as string,
        displayName: "Daily Census (cron test)",
      });
      const version = await defRepo.createVersion({
        definitionId: definition.id,
        organizationId: org,
        versionNumber: 1,
        spec: {
          dimensions: [{ dimensionKey: "census_day" }],
          measures: [{ measureKey: "active_patient_count" }],
          filters: [],
        },
        status: "published",
      });
      const view = await new ReportViewRepository(seedDb.db).create({
        organizationId: org,
        definitionVersionId: version.id,
        ownerMembershipId: memberOf[org] as string,
        displayName: "Daily Census view (cron test)",
      });
      viewOf[org] = view.id;
    }

    // The production write service, with the production cron adapter. No outbox publisher: the §4.10
    // `m33.report_schedule.created` emit is a best-effort no-op when omitted, and it is not under test here.
    service = createDrizzleM33WriteBackend({
      db: handle.db,
      cron: LIVE_CRON,
      now: () => new Date(),
    }).service;
  }, 180_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (seedDb) await seedDb.close();
    if (admin) await admin.end();
  });

  const createArgs = (org: string, over: Record<string, unknown> = {}) => ({
    reportViewId: viewOf[org] as string,
    cronExpression: "0 9 * * *",
    tenantTimezone: "America/New_York",
    format: "csv" as const,
    recipientMembershipIds: [memberOf[org] as string],
    ...over,
  });

  it("creates a schedule and persists a real next_run_at in the TENANT's timezone", async () => {
    // Every assertion below was a 503 before the adapter was bound — `createSchedule` never reached its
    // INSERT at all.
    const before = new Date();
    const created = await service.createSchedule(actorFor(ORG_A), createArgs(ORG_A));

    const persisted = await nextRunAtOf(created.id);
    expect(persisted).toBeInstanceOf(Date);
    expect((persisted as Date).getTime()).toBeGreaterThan(before.getTime());
    // The point of storing tenant_timezone: 09:00 means 09:00 in New York, whatever the server's zone
    // and whichever side of a DST transition the next fire lands on.
    expect(localHour(persisted as Date, "America/New_York")).toBe("09");
    // …and it is NOT 09:00 UTC, which is what a timezone-naive parse would have written.
    expect((persisted as Date).getUTCHours()).not.toBe(9);
  });

  it("refuses a per-minute cron with the §2.3 cadence floor and writes NO row", async () => {
    const n = await scheduleCount(ORG_A);
    await expect(
      service.createSchedule(actorFor(ORG_A), createArgs(ORG_A, { cronExpression: "* * * * *" })),
    ).rejects.toBeInstanceOf(CronTooFrequentError);
    expect(await scheduleCount(ORG_A)).toBe(n);
  });

  it("refuses a BLANK cron rather than persisting an every-minute schedule", async () => {
    // cron-parser reads "" as `* * * * *`. On this path the cadence floor would have caught it anyway;
    // `resumeSchedule` (below) is the path where it would not have.
    const n = await scheduleCount(ORG_A);
    await expect(
      service.createSchedule(actorFor(ORG_A), createArgs(ORG_A, { cronExpression: "  " })),
    ).rejects.toBeInstanceOf(CronExpressionInvalidError);
    expect(await scheduleCount(ORG_A)).toBe(n);
  });

  it("refuses a timezone Intl does not recognize", async () => {
    await expect(
      service.createSchedule(
        actorFor(ORG_A),
        createArgs(ORG_A, { tenantTimezone: "Atlantis/Central" }),
      ),
    ).rejects.toBeInstanceOf(CronExpressionInvalidError);
  });

  it("recomputes next_run_at on update, and on resume after a pause", async () => {
    const created = await service.createSchedule(
      actorFor(ORG_A),
      createArgs(ORG_A, { cronExpression: "0 9 * * *" }),
    );
    const atCreate = await nextRunAtOf(created.id);

    // update: a new expression re-derives the fire time through the same adapter.
    await service.updateSchedule(actorFor(ORG_A), created.id, { cronExpression: "0 17 * * *" });
    const atUpdate = await nextRunAtOf(created.id);
    expect(atUpdate).toBeInstanceOf(Date);
    expect((atUpdate as Date).getTime()).not.toBe((atCreate as Date).getTime());
    expect(localHour(atUpdate as Date, "America/New_York")).toBe("17");

    // pause clears it; resume must compute a fresh future one (the third caller of the cron port).
    await service.pauseSchedule(actorFor(ORG_A), created.id);
    expect(await nextRunAtOf(created.id)).toBeNull();

    await service.resumeSchedule(actorFor(ORG_A), created.id);
    const atResume = await nextRunAtOf(created.id);
    expect(atResume).toBeInstanceOf(Date);
    expect((atResume as Date).getTime()).toBeGreaterThan(Date.now());
    expect(localHour(atResume as Date, "America/New_York")).toBe("17");
  });

  it("keeps schedules tenant-scoped under real RLS", async () => {
    const a = await service.createSchedule(
      actorFor(ORG_A),
      createArgs(ORG_A, { cronExpression: "30 6 * * 1" }),
    );
    // Org B, on the same NOBYPASSRLS connection, cannot read org A's schedule…
    await expect(service.getSchedule(actorFor(ORG_B), a.id)).rejects.toThrow();
    // …and its own create lands in its own tenant.
    const b = await service.createSchedule(actorFor(ORG_B), createArgs(ORG_B));
    const { rows } = await admin.query("SELECT organization_id FROM report_schedule WHERE id=$1", [
      b.id,
    ]);
    expect(rows[0].organization_id).toBe(ORG_B);
  });
});
