/**
 * "Close the M33 gap" — LIVE Postgres + Redis proof of the M33 §4.8 background-job + read/export SQL
 * execution slice WX-PR-014 deliberately left untouched (its own note: "M33's gap is an order of magnitude
 * larger than M30's — nearly every m33-jobs.ts port is unbound").
 *
 * Proves, against a real Postgres + a dedicated throwaway Redis:
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
 *      audit() writes, and the outbox emits — all previously hardcoded throws.
 *   4. The lag-probe's Valkey-backed hysteresis state + advisory flag — previously hardcoded throws that
 *      would have crashed the 30-second singleton probe on its very first tick.
 *   5. The genuine, NOT-closeable infra gaps found while wiring (documented, not routed around): mvRefresh/
 *      lagProbe's outbox emits (OutboxPublishPort requires a non-null organizationId; these are
 *      organizationId=null/absent platform events by design) and the ad-hoc PDF/XLSX exportRender outbox
 *      (a payload/schema mismatch against the shared catalog entry) stay unbound — proven by asserting
 *      ZERO m33.mv.* / m33.lag.* rows land in outbox_event even after a real, successful refresh + probe.
 *
 * Gated on a live DB + Redis so the default `bun run test` stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://localhost:PORT \
 *     bunx vitest run apps/backend/__tests__/m33-reporting-scheduled-jobs.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1. Use a Redis
 * instance DEDICATED to this run — the WX-PR-014 M30 test's own note applies identically here: sharing a
 * Redis with a locally-running `bun run dev:backend` means two independent `registerM33Workers` racing for
 * the same queued jobs.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { audit } from "@wardenx/audit";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import {
  ReportDefinitionRepository,
  ReportRunRepository,
  ReportScheduleRepository,
  ReportViewRepository,
} from "@wardenx/reporting";
import { registerPlatformJob, resetPlatformJobRegistry } from "@wardenx/tenancy";
import type { ConnectionOptions } from "bullmq";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { and, eq, like } from "drizzle-orm";
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

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "44444444-4444-4444-4444-444444444444";
const USER = "44444444-4444-4444-4444-444444444401";

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "M33 reporting scheduled jobs — LIVE Postgres + Redis",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let connection: ConnectionOptions;
    let lagProbeRedis: IORedis;
    let mvRefreshEnqueue: ReturnType<typeof buildM33MvRefreshEnqueue>;
    let workers: Worker[];
    let queueEvents: Record<string, QueueEvents>;
    let activeMembershipId: string;
    let viewId: string;

    async function applyMigrations(): Promise<void> {
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
     *  REAL audited platform-context entry, not a stub. */
    const testAuditBypass = async (
      tx: DbClient,
      event: { jobId: string; reason: string; severity: "warn" | "critical" },
    ): Promise<void> => {
      await audit(
        tx,
        { organizationId: null, userId: null, actorKind: "system", correlationId: randomUUID() },
        {
          eventType: "platform.bypass_invoked",
          resourceKind: "tenant",
          outcome: "success",
          severity: event.severity,
          context: { jobId: event.jobId, reason: event.reason },
        },
      );
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
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-m33-close-gap','A','A')",
        [ORG],
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

      handle = createDbClient({ connectionString: DB_URL! });
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
        publish: (tx: DbClient, input: Parameters<typeof txOutboxPublisher.publish>[1]) =>
          txOutboxPublisher.publish(tx, { ...input, callerModule: "m33" }),
      };

      workers = registerM33Workers(
        buildM33WorkerDeps({
          connection,
          db: handle.db,
          platformDb: handle.db,
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
      const defRepo = new ReportDefinitionRepository(handle.db);
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
      const view = await new ReportViewRepository(handle.db).create({
        organizationId: ORG,
        definitionVersionId: version.id,
        ownerMembershipId: activeMembershipId,
        displayName: "Daily Census view (test)",
      });
      viewId = view.id;
    }, 180_000);

    afterAll(async () => {
      if (workers) await Promise.all(workers.map((w) => w.close()));
      if (queueEvents) await Promise.all(Object.values(queueEvents).map((q) => q.close()));
      if (mvRefreshEnqueue?.queue) await mvRefreshEnqueue.queue.close();
      if (lagProbeRedis) await lagProbeRedis.quit();
      if (handle) await handle.close();
      if (admin) await admin.end();
    });

    it("nightly orchestrator fans out a REAL per-MV refresh (withPlatformContext, real REFRESH, documented outbox block)", async () => {
      // Force a fresh refresh regardless of the MV's 24h debounce window / any prior test run today.
      await handle.db
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

      // The real report_run ledger row — proves withPlatformContext really opened a tx the runs repo wrote
      // through (a base-client run under FORCE RLS with no GUC would have thrown, not merely emptied, since
      // report_run is platform-scoped — the assertion is that this SUCCEEDED at all).
      const lastRun = await new ReportRunRepository(handle.db).findLastRunForMv(
        "mv_census_org_daily",
      );
      expect(lastRun?.status).toBe("succeeded");

      // The documented, NOT-closeable infra block: mvRefresh.outbox.* stays unbound (OutboxPublishPort
      // requires a non-null organizationId; this is a platform-wide organizationId=null event) — a real
      // successful refresh must leave ZERO m33.mv.* rows in outbox_event.
      const mvOutboxRows = await handle.db
        .select({ eventType: schema.outboxEvents.eventType })
        .from(schema.outboxEvents)
        .where(likeEventType("m33.mv.%"));
      expect(mvOutboxRows).toHaveLength(0);
    }, 60_000);

    it("scheduled_run: real M2 recipient re-validation + real translateSpec snapshot + real outbox emit", async () => {
      const scheduleRepo = new ReportScheduleRepository(handle.db);
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
      await new ReportRunRepository(handle.db).createScheduleRun({
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

      const run = await new ReportRunRepository(handle.db).findScheduleRunById(runId, scheduledFor);
      expect(run?.status).toBe("rendered_pending");

      // The real m33.scheduled_report.render_requested outbox row, with the REAL translateSpec output (not a
      // fabricated placeholder) — proves both the outbox bind and the snapshot.build view→version→definition→
      // base→translateSpec chain actually ran.
      const [emitted] = await handle.db
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

      const scheduleRepo = new ReportScheduleRepository(handle.db);
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
      await new ReportRunRepository(handle.db).createScheduleRun({
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

      const auditRows = await handle.db
        .select({ eventType: schema.auditEvents.eventType })
        .from(schema.auditEvents)
        .where(eqResourceId(schedule.id));
      const eventTypes = auditRows.map((r) => r.eventType).sort();
      expect(eventTypes).toContain("m33.scheduled_report.recipient_lost_access");
      expect(eventTypes).toContain("m33.scheduled_report.all_recipients_revoked");

      const [emitted] = await handle.db
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

      // Same documented block as mvRefresh: no organizationId at all on this platform singleton → outbox
      // stays unbound even on a real, successful tick.
      const lagOutboxRows = await handle.db
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
