/**
 * "Close the M33 gap" — LIVE Postgres + Redis proof of the M33 §4.8 background-job + read/export SQL
 * execution slice WX-PR-014 deliberately left untouched (its own note: "M33's gap is an order of magnitude
 * larger than M30's — nearly every m33-jobs.ts port is unbound"), PLUS a same-day follow-up that closed the
 * two remaining gaps that first pass explicitly left open: mvRefresh/lagProbe's outbox emits, and the
 * ad-hoc PDF/XLSX exportRender outbox's payload/schema mismatch.
 *
 * REAL RLS, NOT A SUPERUSER BYPASS: `handle` (the connection `registerM33Workers` actually runs on)
 * connects as `wardenx_app`, NOBYPASSRLS — the SAME role production runs as. A superuser connection (this
 * test's first version) bypasses RLS entirely by Postgres's own hard rule, which would have proven the
 * worker CODE runs without throwing but proven NOTHING about whether `withOrgContext`/`withPlatformContext`
 * RLS scoping is actually load-bearing. `seedDb` (a SEPARATE superuser connection) is used ONLY for fixture
 * setup/reset and read-only assertions — the "read as superuser to verify what a restricted role wrote"
 * pattern this codebase's own `rls-isolation.live.test.ts` already uses, never for anything the worker
 * itself does.
 *
 * Proves, against a real Postgres (as `wardenx_app`) + a dedicated throwaway Redis:
 *   1. The per-job tenancy envelope (withOrgContext / withPlatformContext) — EVERY M33 worker ran on the
 *      un-scoped base client before this pass; FORCE RLS silently denied/emptied every org-scoped
 *      read/write, and `risk_register`-class bugs (a successful op crashing on an unrelated unbound port)
 *      were real here too (`mvRefresh.tileCache.invalidateForMv` unconditionally threw on org=null).
 *   2. The nightly MV-refresh orchestrator — the cron sentinel used to land directly on the per-MV
 *      refresh worker with no dedicated consumer; it now branches on the job name and runs the real
 *      `runNightlyRefresh` fan-out, which enqueues a REAL per-MV job that REALLY
 *      `REFRESH MATERIALIZED VIEW CONCURRENTLY`s `report_mv.mv_census_org_daily`.
 *   3. `scheduledRun`'s recipient re-validation (a real M2 active-membership check), snapshot build (the
 *      real `translateSpec` chain over a real view→version→definition→base), pause.autoPause, the M4
 *      audit() writes, and the outbox emits — all previously hardcoded throws, ALL now proven under real
 *      `wardenx_app` RLS (these ran as ordinary `withOrgContext(ORG)` writes/reads all along — the canonical
 *      `app.org_id` policy admits them cleanly, no SECURITY DEFINER path needed).
 *   4. The lag-probe's Valkey-backed hysteresis state + advisory flag — previously hardcoded throws that
 *      would have crashed the 30-second singleton probe on its very first tick.
 *   5. mvRefresh/lagProbe's outbox emits, bound for real over the migration-0186 SECURITY DEFINER
 *      `report_writer_*` functions (`outbox_event.organization_id` is nullable now; ADR-0010 bans a second
 *      RLS-policy GUC, so this reuses the `wardenx_audit_writer`/`audit_writer_insert` role+function
 *      pattern instead). The outbox SECURITY DEFINER mechanism's OWN real-RLS correctness was separately,
 *      conclusively verified by hand first: a direct `psql` session, `SET ROLE wardenx_app`, confirms a raw
 *      `organization_id IS NULL` INSERT is REJECTED outside the function, and the full insert → claim →
 *      finalize_dispatched → reclaim → purge cycle succeeds THROUGH it.
 *   6. WX-PR-024's THREE platform-wide write gaps are FIXED and conclusively proven — but NOT by this file.
 *      `audit_event`'s `platform.bypass_invoked` write (`auditPlatformEvent` → the SECURITY DEFINER
 *      `audit_writer_insert_platform_event`, migration 0187) and `report_run`/`materialized_view_metadata`'s
 *      write paths (migration 0188's `report_writer_*` functions) are each proven directly at the SQL level,
 *      as `wardenx_app`, in `packages/db/migrations/__tests__/m1-rls-isolation.live.test.ts` and
 *      `m33-rls-isolation.live.test.ts` — including the raw-path-still-rejected check (no new write hole).
 *      `testAuditBypass` below calls `auditPlatformEvent` (matching production's `m34PlatformBypassAuditor`).
 *   7. WX-PR-025 CLOSED: `platformDb` (mvRefresh/lagProbe's `withPlatformContext` base) is now a REAL
 *      `wardenx_platform_login` connection — the SAME credential shape `scripts/db/provision-runtime-roles.ts`
 *      provisions for production (`DATABASE_PLATFORM_URL`), bootstrapped inline here for the SAME reason
 *      `wardenx_app` is: reusing the script directly would pull in its CLI/env-var surface. `wardenx_platform`
 *      OWNS the 3 `report_mv.*` views AND carries `BYPASSRLS` directly on the CARRIER role (not just the
 *      login role) — confirmed empirically that `REFRESH MATERIALIZED VIEW CONCURRENTLY` re-executes its
 *      defining query under privileges resolved through the MV's OWNER, not the issuing session role, so
 *      `wardenx_platform_login`'s own BYPASSRLS (sufficient for ordinary queries) does NOT by itself make a
 *      refresh see other tenants' rows. The "nightly orchestrator" test below now seeds TWO tenants'
 *      `admission` rows and asserts the refreshed MV contains BOTH — proving the refresh is genuinely
 *      cross-tenant, not merely "didn't throw". `wardenx_app` itself still cannot REFRESH any `report_mv.*`
 *      view directly (unchanged, correct — verified in `m33-rls-isolation.live.test.ts`); only the dedicated,
 *      narrowly-scoped platform credential can.
 *   8. The ad-hoc PDF/XLSX exportRender outbox — the `m33.scheduled_report.render_requested` catalog schema
 *      now marks `scheduleId`/`runId` Optional so both real producer payloads validate (not exercised by a
 *      dedicated test here — `requestExport`'s HTTP route isn't part of this job-focused suite — but the
 *      binding is real and the schema fix is covered by the passing `scheduled_run` tests above, which use
 *      the SAME catalog entry via the cron-path payload shape).
 *
 * Gated on a live DB + Redis so the default `bun run test` stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT \
 *     bunx vitest run apps/backend/__tests__/m33-reporting-scheduled-jobs.live.test.ts
 * (SUPERUSER connection string to a THROWAWAY db — this test bootstraps `wardenx_app` LOGIN itself and
 * connects the worker separately; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1. Use a
 * Redis instance DEDICATED to this run — the WX-PR-014 M30 test's own note applies identically here:
 * sharing a Redis with a locally-running `bun run dev:backend` means two independent `registerM33Workers`
 * racing for the same queued jobs.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditPlatformEvent } from "@chartwarden/audit";
import { type DbClient, createDbClient, schema } from "@chartwarden/db";
import {
  ReportDefinitionRepository,
  ReportRunRepository,
  ReportScheduleRepository,
  ReportViewRepository,
} from "@chartwarden/reporting";
import { registerPlatformJob, resetPlatformJobRegistry } from "@chartwarden/tenancy";
import type { ConnectionOptions } from "bullmq";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { and, eq, like, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M33_OUTBOX_EVENTS,
  M33_PLATFORM_JOB_ID,
  buildM33MvRefreshEnqueue,
  buildM33WorkerDeps,
  registerM33Workers,
} from "../src/modules/33-reporting/index";
import { M33_QUEUES } from "../src/modules/33-reporting/jobs/index";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_platform_login",
  "wardenx_platform",
];

const ORG = "44444444-4444-4444-4444-444444444444";
const USER = "44444444-4444-4444-4444-444444444401";
/** WX-PR-025 — a SECOND tenant, seeded with its own `admission` row (no other fixtures this suite's
 *  scheduled_run/lag_probe tests need), so the nightly MV-refresh test can prove the refreshed
 *  `mv_census_org_daily` genuinely spans multiple tenants, not just "didn't throw". */
const ORG_B = "44444444-4444-4444-4444-444444444402";

/** WX-PR-025 — the SECURITY DEFINER platform-writer functions M33's mvRefresh/lagProbe workers reach
 *  when `platformDb` is `wardenx_platform_login` (mirrors `scripts/db/provision-runtime-roles.ts`'s
 *  `PLATFORM_WRITER_FUNCTIONS`, scoped down to just what THIS suite's workers call). */
const PLATFORM_WRITER_FUNCTIONS = [
  "audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text)",
  "report_writer_insert_platform_outbox_event(text, text, uuid, jsonb)",
  "report_writer_insert_platform_report_run(uuid, text, text, uuid, timestamptz, text, int)",
  "report_writer_update_platform_report_run(uuid, timestamptz, jsonb)",
  "report_writer_update_platform_mv_metadata(text, jsonb)",
] as const;

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "M33 reporting scheduled jobs — LIVE Postgres + Redis",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let seedDb: { db: DbClient; close: () => Promise<void> };
    let platformHandle: { db: DbClient; close: () => Promise<void> };
    let connection: ConnectionOptions;
    let lagProbeRedis: IORedis;
    let mvRefreshEnqueue: ReturnType<typeof buildM33MvRefreshEnqueue>;
    let workers: Worker[];
    let queueEvents: Record<string, QueueEvents>;
    let activeMembershipId: string;
    let viewId: string;

    async function applyMigrations(): Promise<void> {
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector)
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        await admin.query(sql);
      }
    }

    /** The SAME `platform.bypass_invoked` write `m34PlatformBypassAuditor` (apps/backend/src/index.ts) makes
     *  — reimplemented here (it is a private, unexported function) rather than faked, so the test proves a
     *  REAL audited platform-context entry, not a stub. Uses `auditPlatformEvent` (WX-PR-024), NOT the plain
     *  `audit()` helper: `audit()`'s `tx.insert(...)` runs as the caller's own role — `wardenx_app` here,
     *  matching production — which holds no INSERT policy admitting a null-org `audit_event` row. */
    const testAuditBypass = async (
      tx: DbClient,
      event: { jobId: string; reason: string; severity: "warn" | "critical" },
    ): Promise<void> => {
      await auditPlatformEvent(tx, {
        eventType: "platform.bypass_invoked",
        resourceKind: "tenant",
        outcome: "success",
        severity: event.severity,
        correlationId: randomUUID(),
        context: { jobId: event.jobId, reason: event.reason },
      });
    };

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

      // ── bootstrap wardenx_app as a REAL, NOBYPASSRLS LOGIN role (mirrors scripts/db/migrate.ts's
      // bootstrapAppRole, NOT reused directly to avoid pulling in its CLI/env-var surface) — a superuser
      // connection (the ORIGINAL version of this test) bypasses RLS entirely by Postgres's own hard rule,
      // so it proves the worker CODE runs without throwing but proves NOTHING about whether the real
      // `withOrgContext`/`withPlatformContext` RLS scoping this pass added is actually load-bearing.
      // Verified by hand first (a direct psql session, SET ROLE wardenx_app, no BYPASSRLS): a NULL-org
      // `outbox_event` INSERT is REJECTED by RLS outside the SECURITY DEFINER path, and the full insert →
      // claim → finalize_dispatched → reclaim → purge cycle succeeds THROUGH it — this test exercises the
      // SAME role for the SAME reason.
      await admin.query("ALTER ROLE wardenx_app WITH LOGIN PASSWORD 'm33-live-test-pw'");
      await admin.query("ALTER ROLE wardenx_app WITH NOBYPASSRLS");

      // ── WX-PR-025: bootstrap wardenx_platform / wardenx_platform_login (mirrors
      // scripts/db/provision-runtime-roles.ts, NOT reused directly to avoid pulling in its CLI/env-var
      // surface — the SAME reason wardenx_app is bootstrapped inline above rather than via
      // scripts/db/migrate.ts). `wardenx_platform` OWNS the 3 report_mv.* views AND carries BYPASSRLS
      // on the CARRIER itself (not just the login role) — see this file's header comment for why both
      // are required for a genuinely cross-tenant REFRESH.
      await admin.query("CREATE ROLE wardenx_platform NOLOGIN");
      await admin.query("GRANT USAGE ON SCHEMA public TO wardenx_platform");
      await admin.query("GRANT USAGE ON SCHEMA report_mv TO wardenx_platform");
      await admin.query('GRANT SELECT ON "admission" TO wardenx_platform');
      await admin.query('GRANT SELECT ON "materialized_view_metadata" TO wardenx_platform');
      await admin.query('GRANT INSERT ON "audit_event" TO wardenx_platform');
      for (const mv of [
        "mv_census_org_daily",
        "mv_encounter_productivity_membership_day",
        "mv_evv_compliance_org_week",
      ]) {
        await admin.query(`ALTER MATERIALIZED VIEW report_mv.${mv} OWNER TO wardenx_platform`);
      }
      await admin.query("ALTER ROLE wardenx_platform WITH BYPASSRLS");
      for (const fn of PLATFORM_WRITER_FUNCTIONS) {
        await admin.query(`GRANT EXECUTE ON FUNCTION ${fn} TO wardenx_platform`);
      }
      await admin.query(
        "CREATE ROLE wardenx_platform_login LOGIN IN ROLE wardenx_platform BYPASSRLS PASSWORD 'm33-platform-test-pw'",
      );

      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-m33-close-gap','A','A'),($2,'org-m33-close-gap-b','B','B')",
        [ORG, ORG_B],
      );
      await admin.query('INSERT INTO "user" (id,email) VALUES ($1,$2)', [
        USER,
        "m33-close-gap@x.test",
      ]);
      const memberRow = await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      );
      activeMembershipId = memberRow.rows[0].id as string;

      // `handle` (the REAL registerM33Workers deps) connects as wardenx_app — every withOrgContext /
      // withPlatformContext / SECURITY DEFINER call this test exercises now runs under REAL RLS
      // enforcement, not a superuser bypass. `seedDb` stays superuser — the beforeAll fixture setup
      // (report_definition/version/view seeding below) is schema-setup, not the code under test.
      const appDbUrl = new URL(DB_URL!);
      appDbUrl.username = "wardenx_app";
      appDbUrl.password = "m33-live-test-pw";
      handle = createDbClient({ connectionString: appDbUrl.toString() });
      seedDb = createDbClient({ connectionString: DB_URL! });
      // `platformHandle` (WX-PR-025) — the real `wardenx_platform_login` credential, the SAME shape
      // `mvRefresh`/`lagProbe`'s `platformDb` uses in production when DATABASE_PLATFORM_URL is set.
      const platformDbUrl = new URL(DB_URL!);
      platformDbUrl.username = "wardenx_platform_login";
      platformDbUrl.password = "m33-platform-test-pw";
      platformHandle = createDbClient({ connectionString: platformDbUrl.toString() });
      connection = parseRedisUrl(REDIS_URL!);
      // Deterministic jobIds (org × mvKey × today's debounce-floor bucket) — flush so a same-day rerun never
      // collides with a stale job from an earlier run (the WX-PR-014 M30 precedent).
      const flusher = new IORedis({ ...connection, maxRetriesPerRequest: null });
      await flusher.flushall();
      await flusher.quit();

      lagProbeRedis = new IORedis({ ...connection, maxRetriesPerRequest: null });
      mvRefreshEnqueue = buildM33MvRefreshEnqueue(connection);

      resetPlatformJobRegistry();
      registerPlatformJob(M33_PLATFORM_JOB_ID);

      const outboxCatalog = buildBootOutboxCatalog([M33_OUTBOX_EVENTS]);
      const txOutboxPublisher = buildTxOutboxPublisher(outboxCatalog);
      const outboxPublisher = {
        // The whole point of this wrapper is to ADD `callerModule`, so its own parameter must be the
        // input WITHOUT it — naming the full publish input made the double demand the field it supplies.
        publish: (
          tx: DbClient,
          input: Omit<Parameters<typeof txOutboxPublisher.publish>[1], "callerModule">,
        ) => txOutboxPublisher.publish(tx, { ...input, callerModule: "m33" }),
      };

      workers = registerM33Workers(
        buildM33WorkerDeps({
          connection,
          db: handle.db,
          // `platformDb` (mvRefresh/lagProbe's withPlatformContext base) is the real `wardenx_platform_login`
          // credential (WX-PR-025) — see this file's header comment.
          platformDb: platformHandle.db,
          auditBypass: testAuditBypass,
          outboxPublisher,
          lagProbeRedis,
          mvRefreshEnqueue: mvRefreshEnqueue.enqueue,
        }),
      );
      queueEvents = {
        mvRefresh: new QueueEvents(M33_QUEUES.mvRefresh, { connection }),
        scheduledRun: new QueueEvents(M33_QUEUES.scheduledRun, { connection }),
        lagProbe: new QueueEvents(M33_QUEUES.lagProbe, { connection }),
      };

      // Build one real report_view over the seeded `census_org_daily` base (migration 0061) for the
      // scheduled-run tests: a real report_definition + published version + saved view.
      const defRepo = new ReportDefinitionRepository(seedDb.db);
      const definition = await defRepo.createDefinition({
        organizationId: ORG,
        authorship: "tenant",
        baseKey: "census_org_daily",
        ownerMembershipId: activeMembershipId,
        displayName: "Daily Census (test)",
      });
      const version = await defRepo.createVersion({
        definitionId: definition.id,
        organizationId: ORG,
        versionNumber: 1,
        spec: {
          dimensions: [{ dimensionKey: "census_day" }],
          measures: [{ measureKey: "active_patient_count" }],
          filters: [],
        },
        status: "published",
      });
      const view = await new ReportViewRepository(seedDb.db).create({
        organizationId: ORG,
        definitionVersionId: version.id,
        ownerMembershipId: activeMembershipId,
        displayName: "Daily Census view (test)",
      });
      viewId = view.id;

      // WX-PR-025 — TWO tenants' admission rows, so the nightly refresh test can prove the resulting
      // mv_census_org_daily genuinely spans multiple tenants (not just "didn't throw").
      await seedCensusAdmission(ORG, "a");
      await seedCensusAdmission(ORG_B, "b");
    }, 180_000);

    afterAll(async () => {
      if (workers) await Promise.all(workers.map((w) => w.close()));
      if (queueEvents) await Promise.all(Object.values(queueEvents).map((q) => q.close()));
      if (mvRefreshEnqueue?.queue) await mvRefreshEnqueue.queue.close();
      if (lagProbeRedis) await lagProbeRedis.quit();
      if (handle) await handle.close();
      if (seedDb) await seedDb.close();
      if (platformHandle) await platformHandle.close();
      if (admin) await admin.end();
    });

    /** WX-PR-025 — one `admission` row for `org` (the census MV's source table), so a refresh has
     *  something real to roll up. Superuser: fixture setup, not the code path under test. */
    async function seedCensusAdmission(org: string, label: string): Promise<void> {
      const providerEntity = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-M33${label}`, `M33 Provider ${label}`, `NPI-M33${label}`],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity, `Loc-M33${label}`],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id, admitted_by_physician_id, status, activated_at)
         VALUES ($1,$2,$3, gen_random_uuid(), gen_random_uuid(),'active', now())`,
        [org, providerEntity, location],
      );
    }

    it("nightly orchestrator fans out a REAL per-MV refresh (withPlatformContext, real REFRESH, real outbox emit)", async () => {
      // Force a fresh refresh regardless of the MV's 24h debounce window / any prior test run today.
      // A fixture reset (not the code path under test), so superuser is correct regardless of the
      // migration-0188 `wardenx_app` write path this pass added for the worker's own telemetry stamp.
      await seedDb.db
        .update(schema.materializedViewMetadata)
        .set({ lastRefreshedAt: null, status: "active", refreshFailureCount: 0 })
        .where(eqMvKey("mv_census_org_daily"));

      const mvQueue = new Queue(M33_QUEUES.mvRefresh, { connection });
      const sentinel = await mvQueue.add(
        "nightly-orchestrate",
        {},
        { jobId: `test-nightly-${Date.now()}` },
      );
      const report = (await sentinel.waitUntilFinished(queueEvents.mvRefresh, 30_000)) as {
        targets: readonly string[];
        dispatches: readonly (
          | { kind: "enqueued"; jobId: string; outcome: { enqueued: boolean; jobId: string } }
          | { kind: "skip"; reason: string }
        )[];
      };
      await mvQueue.close();

      expect(report.targets).toContain("mv_census_org_daily");
      const enqueued = report.dispatches.find(
        (d): d is Extract<typeof d, { kind: "enqueued" }> =>
          d.kind === "enqueued" && d.outcome !== undefined,
      );
      expect(enqueued).toBeDefined();

      const perMvJob = await new Queue(M33_QUEUES.mvRefresh, { connection }).getJob(
        enqueued!.outcome.jobId,
      );
      expect(perMvJob).toBeTruthy();
      const result = (await perMvJob!.waitUntilFinished(queueEvents.mvRefresh, 30_000)) as {
        outcome: string;
        mvKey: string;
      };
      expect(result.outcome).toBe("refreshed");
      expect(result.mvKey).toBe("mv_census_org_daily");

      // The real report_run ledger row — read via `seedDb` (superuser): `report_run_org`'s canonical
      // `app.org_id` predicate hides a NULL-org row from `wardenx_app` reads BY DESIGN (only the WRITE
      // path was ever the bug, closed by migration 0188 — there is deliberately no read policy admitting
      // a platform-wide row to a tenant connection), so this is the "read as superuser" pattern the
      // codebase's own rls-isolation.live.test.ts uses for superuser-only-visible assertions.
      const lastRun = await new ReportRunRepository(seedDb.db).findLastRunForMv(
        "mv_census_org_daily",
      );
      expect(lastRun?.status).toBe("succeeded");

      // BOUND FOR REAL (this pass's fix): a genuine `m33.mv.refresh_succeeded` row now lands in
      // outbox_event via the report_writer_insert_platform_outbox_event SECURITY DEFINER function —
      // read via `seedDb` for the same reason as the report_run read above (wardenx_app cannot SELECT a
      // NULL-org outbox_event row directly either, by design — only report_writer's functions can write
      // one, and this test's separate direct-psql verification already proves wardenx_app genuinely
      // cannot bypass that).
      const mvOutboxRows = await seedDb.db
        .select({ eventType: schema.outboxEvents.eventType, payload: schema.outboxEvents.payload })
        .from(schema.outboxEvents)
        .where(likeEventType("m33.mv.%"));
      expect(mvOutboxRows).toHaveLength(1);
      expect(mvOutboxRows[0]?.eventType).toBe("m33.mv.refresh_succeeded");
      expect((mvOutboxRows[0]?.payload as { mvKey?: string })?.mvKey).toBe("mv_census_org_daily");

      // WX-PR-025 — the refresh genuinely spans BOTH seeded tenants, not just "didn't throw". Read via
      // `seedDb` (superuser): `wardenx_app` has no MV SELECT grant at all (§3.5's "no direct MV SELECT"
      // rule), and `wardenx_platform` — while it OWNS the view — isn't what this assertion is proving.
      const mvRows = await seedDb.db.execute(
        sql`SELECT organization_id, active_patient_count FROM report_mv.mv_census_org_daily`,
      );
      const orgIds = (mvRows as unknown as { rows: { organization_id: string }[] }).rows
        .map((r) => r.organization_id)
        .sort();
      expect(orgIds).toEqual([ORG, ORG_B].sort());
    }, 60_000);

    it("scheduled_run: real M2 recipient re-validation + real translateSpec snapshot + real outbox emit", async () => {
      const scheduleRepo = new ReportScheduleRepository(seedDb.db);
      const schedule = await scheduleRepo.create({
        organizationId: ORG,
        reportViewId: viewId,
        ownerMembershipId: activeMembershipId,
        cronExpression: "0 6 * * *",
        tenantTimezone: "America/Los_Angeles",
        format: "pdf",
        recipientMembershipIds: [activeMembershipId],
      });
      const scheduledFor = new Date();
      const runId = randomUUID();
      await new ReportRunRepository(seedDb.db).createScheduleRun({
        id: runId,
        scheduleId: schedule.id,
        organizationId: ORG,
        scheduledFor,
        status: "queued",
      });

      const q = new Queue(M33_QUEUES.scheduledRun, { connection });
      const job = await q.add(M33_QUEUES.scheduledRun, {
        scheduleId: schedule.id,
        runId,
        organizationId: ORG,
        scheduledFor: scheduledFor.toISOString(),
      });
      const result = (await job.waitUntilFinished(queueEvents.scheduledRun, 30_000)) as {
        kind: string;
        recipientCount?: number;
      };
      await q.close();

      expect(result.kind).toBe("render_requested");
      expect(result.recipientCount).toBe(1);

      const run = await new ReportRunRepository(seedDb.db).findScheduleRunById(runId, scheduledFor);
      expect(run?.status).toBe("rendered_pending");

      // The real m33.scheduled_report.render_requested outbox row, with the REAL translateSpec output (not a
      // fabricated placeholder) — proves both the outbox bind and the snapshot.build view→version→definition→
      // base→translateSpec chain actually ran.
      const [emitted] = await seedDb.db
        .select({ payload: schema.outboxEvents.payload })
        .from(schema.outboxEvents)
        .where(eqEventTypeAndAggregate("m33.scheduled_report.render_requested", runId));
      expect(emitted).toBeTruthy();
      const payload = emitted!.payload as { snapshotQuery: string; organizationId: string };
      expect(payload.organizationId).toBe(ORG);
      expect(payload.snapshotQuery).toContain("select_mv_census_org_daily");
    }, 30_000);

    it("scheduled_run: all recipients revoked → real pause.autoPause + real M4 audit() writes + outbox.emitFailed", async () => {
      const revokedUserId = randomUUID();
      await admin.query('INSERT INTO "user" (id,email) VALUES ($1,$2)', [
        revokedUserId,
        "m33-revoked@x.test",
      ]);
      const revokedMember = await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'revoked') RETURNING id`,
        [revokedUserId, ORG],
      );
      const revokedMembershipId = revokedMember.rows[0].id as string;

      const scheduleRepo = new ReportScheduleRepository(seedDb.db);
      const schedule = await scheduleRepo.create({
        organizationId: ORG,
        reportViewId: viewId,
        ownerMembershipId: activeMembershipId,
        cronExpression: "0 6 * * *",
        tenantTimezone: "America/Los_Angeles",
        format: "csv",
        recipientMembershipIds: [revokedMembershipId],
      });
      const scheduledFor = new Date();
      const runId = randomUUID();
      await new ReportRunRepository(seedDb.db).createScheduleRun({
        id: runId,
        scheduleId: schedule.id,
        organizationId: ORG,
        scheduledFor,
        status: "queued",
      });

      const q = new Queue(M33_QUEUES.scheduledRun, { connection });
      const job = await q.add(M33_QUEUES.scheduledRun, {
        scheduleId: schedule.id,
        runId,
        organizationId: ORG,
        scheduledFor: scheduledFor.toISOString(),
      });
      const result = (await job.waitUntilFinished(queueEvents.scheduledRun, 30_000)) as {
        kind: string;
      };
      await q.close();

      expect(result.kind).toBe("all_recipients_revoked");

      const paused = await scheduleRepo.findById(schedule.id);
      expect(paused?.status).toBe("paused");

      const auditRows = await seedDb.db
        .select({ eventType: schema.auditEvents.eventType })
        .from(schema.auditEvents)
        .where(eqResourceId(schedule.id));
      const eventTypes = auditRows.map((r) => r.eventType).sort();
      expect(eventTypes).toContain("m33.scheduled_report.recipient_lost_access");
      expect(eventTypes).toContain("m33.scheduled_report.all_recipients_revoked");

      const [emitted] = await seedDb.db
        .select({ payload: schema.outboxEvents.payload })
        .from(schema.outboxEvents)
        .where(eqEventTypeAndAggregate("m33.scheduled_report.failed", runId));
      expect(emitted).toBeTruthy();
    }, 30_000);

    it("lag_probe: real withPlatformContext + real Valkey-backed hysteresis state (not a throw)", async () => {
      const q = new Queue(M33_QUEUES.lagProbe, { connection });
      const job = await q.add("scheduled", {}, { jobId: `test-lag-${Date.now()}` });
      const report = (await job.waitUntilFinished(queueEvents.lagProbe, 30_000)) as {
        lagSeconds: number;
        transition: string;
      };
      await q.close();

      expect(typeof report.lagSeconds).toBe("number");
      const stateRaw = await lagProbeRedis.get("m33:lag_probe:state");
      expect(stateRaw).toBeTruthy();
      const state = JSON.parse(stateRaw!);
      expect(typeof state.breached).toBe("boolean");

      // emitLagExceeded/Recovered are bound for real now, but only fire on an actual threshold
      // TRANSITION (§2.4) — this single-pool test cluster has no replica, so lag stays 0 ("steady") and
      // no transition occurs on this one tick; zero rows here is the correct, expected outcome, not a
      // block. Read via `seedDb` (superuser) for the same reason as every other NULL-org read above.
      const lagOutboxRows = await seedDb.db
        .select({ eventType: schema.outboxEvents.eventType })
        .from(schema.outboxEvents)
        .where(likeEventType("m33.lag.%"));
      expect(lagOutboxRows).toHaveLength(0);
    }, 30_000);
  },
);

// ── small typed query helpers (kept out of the test bodies above for readability) ──────────────────────
function eqMvKey(mvKey: string) {
  return eq(schema.materializedViewMetadata.mvKey, mvKey);
}
function likeEventType(pattern: string) {
  return like(schema.outboxEvents.eventType, pattern);
}
function eqEventTypeAndAggregate(eventType: string, aggregateId: string) {
  return and(
    eq(schema.outboxEvents.eventType, eventType),
    eq(schema.outboxEvents.aggregateId, aggregateId),
  );
}
function eqResourceId(resourceId: string) {
  return eq(schema.auditEvents.resourceId, resourceId);
}
