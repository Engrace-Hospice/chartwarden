/**
 * WX-PR-014 — "Complete M30 (and M33) launch jobs", LIVE Postgres + Redis proof (the M30 slice).
 *
 * Proves the M30 §4.8 CRON → WORK-QUEUE background-job path end-to-end for real, closing the gap a
 * dedicated research pass found: `nightlyRecompute.enqueue.enqueueForOrg` /
 * `riskRegisterRefreshCron.enqueue.enqueueRefresh` were hardcoded fail-closed thunks with NO fan-out logic
 * at all — the 03:15 nightly recompute and the 04:00 daily risk-register refresh were silent no-ops in
 * production, forever. Binding them surfaced two more blocking gaps this test also proves closed:
 *   1. `processing_log` had no table at all (not merely unbound wiring) — every one of the four §4.8
 *      work-queue processors threw on their very first line, on every job, always (migration 0185 +
 *      `buildProcessingLogPort`).
 *   2. `measure_recompute`/`risk_register_refresh` call their `outbox.emit*` port UNCONDITIONALLY before
 *      `processingLog.markProcessed` — with it unbound, every successful run threw on its last line and
 *      rolled the whole per-job transaction back (nothing persisted, not even the already-computed value).
 *      Bound over the SAME tx-scoped `m30` outbox publisher the command routes already use.
 *   3. `risk_register_refresh` never actually ran inside `withOrgContext` (its own repository's doc comment
 *      said it must) — FORCE RLS silently returned zero rows from every source table on every run.
 *   4. `refreshConcurrently` ran `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view` — but migration
 *      0067 DELIBERATELY made `risk_register_view` a plain (non-materialized) view, since a precomputed
 *      matview cannot re-filter per reading session and would leak cross-org rows (its own comment says so).
 *      Postgres rejects the statement outright ("is not a materialized view"), so this write path has never
 *      once succeeded since M30 shipped. Fixed to a documented no-op — a plain view has nothing to refresh.
 *
 * GAP-067 later extended this suite with the `m30.outbreak_detection` proof (the fourth §4.8 work queue):
 * its trailing-window org event read had no repo method behind it at all and its §4.10 emit was unbound, so
 * the processor threw M30WorkerPortUnbound on its very first data read. Both are now bound
 * (`InfectionRepository.listEventsForOrgWindow` + the same tx-scoped `m30` outbox publisher).
 *
 * This test constructs the REAL `registerM30Workers` (not a hand-rolled copy of its logic) against a real
 * throwaway Redis, so the actual per-job `withOrgContext` wrap + `processingLogFactory` + `outboxPublisher`
 * wiring all run for real — `Job.waitUntilFinished` awaits real BullMQ consumption, not a direct function
 * call (the M27 WX-PR-013 precedent skipped this because no Worker existed to construct at all; M30's
 * workers already existed, so exercising them for real is both possible and the stronger proof).
 *
 * Gated on a live DB + Redis so the default `bun run test` stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://localhost:PORT \
 *     bunx vitest run apps/backend/__tests__/m30-quality-scheduled-jobs.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1. Use a Redis
 * instance DEDICATED to this test run, distinct from any locally-running `bun run dev:backend` — sharing one
 * means two independent `registerM30Workers` racing for the same queued jobs, which reads as a mysterious,
 * hard-to-diagnose failure since the OTHER process's worker can win the race and fail against its own DB.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { ActiveOrgListPort, QualityHopeConsumer } from "@wardenx/quality";
import { M30WorkerPortUnbound, buildMeasureRegistry } from "@wardenx/quality";
import type { ConnectionOptions } from "bullmq";
import { Queue, QueueEvents, type Worker } from "bullmq";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOrgProviderEntityLister } from "../src/bootstrap/provider-entity-resolver";
import {
  buildM30CronPorts,
  buildM30RecomputeEnqueue,
  buildM30WorkerDeps,
  registerM30Workers,
} from "../src/modules/30-quality/index";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "33333333-3333-3333-3333-333333333333";
const PROVIDER_ENTITY = "00000000-0000-0000-0000-0000000000c1";

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/** Same shape as the WX-PR-013 M27 fixture — records every publish for assertion. */
function fakeOutbox() {
  const emissions: { eventName: string; payload: Record<string, unknown> }[] = [];
  return {
    emissions,
    port: {
      async publish(
        _tx: unknown,
        input: { eventName: string; payload: Record<string, unknown> },
      ): Promise<void> {
        emissions.push({ eventName: input.eventName, payload: input.payload });
      },
    },
  };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "WX-PR-014 M30 scheduled-jobs slice — LIVE Postgres + Redis",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let connection: ConnectionOptions;
    let recompute: ReturnType<typeof buildM30RecomputeEnqueue>;
    let outbox: ReturnType<typeof fakeOutbox>;
    let workers: Worker[] | undefined;

    async function applyMigrations(): Promise<void> {
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          // GAP-067: this suite's original one-line stripper only ever matched the QUOTED, first
          // occurrence, so `WARDENX_TEST_NO_PGVECTOR=1` never actually worked here — it died on 0014's
          // unquoted `EXTENSION IF NOT EXISTS vector`. All three strips are required (the M4/M7 form):
          // the extension appears both quoted (0001) and unquoted (0014) → `/gm`; 0014 also declares an
          // `embedding vector(384)` COLUMN whose type must still resolve → shim to `text`; and its
          // `USING hnsw (…)` index needs a pgvector-only access method → drop the line.
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
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-wx-pr-014','A','A')",
        [ORG],
      );
      await admin.query(
        `INSERT INTO provider_entity
           (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end, status)
         VALUES ($1,$2,'990099','WX-PR-014 Test Hospice','1999999999','enc-placeholder','1231','active')`,
        [PROVIDER_ENTITY, ORG],
      );
      handle = createDbClient({ connectionString: DB_URL! });
      connection = parseRedisUrl(REDIS_URL!);
      // This suite's BullMQ jobIds are deterministic (org × measure × PE × resolved period × today's date
      // bucket), so a stale job from an EARLIER run on the same calendar day would otherwise collide with
      // this run's `Queue.add` and short-circuit straight to its old (possibly failed) terminal state
      // instead of actually running again — flush the throwaway Redis first so every run starts clean.
      const flusher = new IORedis({ ...connection, maxRetriesPerRequest: null });
      await flusher.flushall();
      await flusher.quit();
      recompute = buildM30RecomputeEnqueue(connection);
      outbox = fakeOutbox();
    }, 120_000);

    afterAll(async () => {
      if (workers) await Promise.all(workers.map((w) => w.close()));
      await Promise.all(recompute.queues.map((q) => q.close()));
      if (handle) await handle.close();
      if (admin) await admin.end();
    });

    // A hand-written `QualityHopeConsumer` returning deterministic, clearly-passing counts (100% — no
    // threshold-breach path, which is a genuine separate schema mismatch this task deliberately leaves
    // unbound, see m30-jobs.ts). Every other method throws — unused by this fixture's one registered measure.
    const hopeStub: QualityHopeConsumer = {
      async sfvTimelinessRollup() {
        return { sfvDue: 10, sfvOnTime: 10 };
      },
      async timepointCompletionRollup() {
        throw new Error("unused by this fixture");
      },
      async submissionPostureRollup() {
        throw new Error("unused by this fixture");
      },
      async j2051FollowUpRollup() {
        throw new Error("unused by this fixture");
      },
      async openSfvObligationCount() {
        throw new Error("unused by this fixture");
      },
    };

    // Narrowed to ONE measure so the fan-out is deterministic (1 provider entity × 1 measure = 1 job) —
    // the REAL production descriptor + calculator (`buildMeasureRegistry()`), not a fake.
    const registrations = new Map([
      ["hope_sfv_on_time_rate", buildMeasureRegistry().get("hope_sfv_on_time_rate")!],
    ]);

    const activeOrgs: ActiveOrgListPort = {
      listActiveOrgs: async () => [{ organizationId: ORG }],
    };

    const deps = () =>
      buildM30WorkerDeps({
        connection,
        db: handle.db,
        hopeProvider: hopeStub,
        activeOrgs,
        providerEntities: buildOrgProviderEntityLister(handle.db),
        recomputeEnqueue: recompute.enqueue,
        outboxPublisher: outbox.port,
        registrations,
      });

    it("nightly-recompute: real fan-out enqueues one job per (provider entity × active measure) onto real BullMQ, and the REAL registerM30Workers worker completes it end-to-end", async () => {
      const ports = buildM30CronPorts(deps());
      const report = await ports.nightlyRecompute.enqueue.enqueueForOrg(ORG, new Date());
      expect(report.enqueued).toBe(1);

      const inspectQueue = new Queue("m30.measure_recompute", { connection });
      let jobId: string;
      // The `processing_log` idempotency key is `job.data.jobId` (the RAW, colon-delimited key the fan-out
      // embeds in the payload) — distinct from the outer BullMQ `job.id` (SANITIZED, `:` → `__`, since
      // BullMQ rejects colons in a custom jobId). Two different identifier spaces by design; the worker's
      // processing_log lookup uses the former.
      let processingLogKey: string;
      try {
        const jobs = await inspectQueue.getJobs([
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
        ]);
        expect(jobs).toHaveLength(1);
        const job = jobs[0]!;
        jobId = job.id!;
        processingLogKey = job.data.jobId;
        expect(job.data.measureCode).toBe("hope_sfv_on_time_rate");
        expect(job.data.organizationId).toBe(ORG);
        expect(job.data.providerEntityId).toBe(PROVIDER_ENTITY);
        expect(job.data.reason).toBe("nightly_cron");
      } finally {
        await inspectQueue.close();
      }

      // Construct the REAL worker set (registerM30Workers) — starts consuming Redis for real.
      workers = registerM30Workers(deps());
      const queueEvents = new QueueEvents("m30.measure_recompute", { connection });
      await queueEvents.waitUntilReady();
      try {
        const q = new Queue("m30.measure_recompute", { connection });
        const job = (await q.getJob(jobId))!;
        try {
          const result = await job.waitUntilFinished(queueEvents, 20_000);
          expect(result.outcome).toBe("recomputed");
        } catch (err) {
          // Surface the real BullMQ failedReason on assertion failure — the raw promise-rejection message
          // alone doesn't say WHY the job failed.
          const reloaded = await q.getJob(jobId);
          throw new Error(`job did not complete cleanly: ${reloaded?.failedReason}`, {
            cause: err,
          });
        } finally {
          await q.close();
        }
      } finally {
        await queueEvents.close();
      }

      const valueRow = await admin.query(
        "SELECT numerator, denominator, ratio FROM quality_measure_value WHERE organization_id=$1 AND measure_code='hope_sfv_on_time_rate'",
        [ORG],
      );
      expect(valueRow.rows).toHaveLength(1);
      expect(Number(valueRow.rows[0].numerator)).toBe(10);
      expect(Number(valueRow.rows[0].denominator)).toBe(10);

      const logRow = await admin.query(
        "SELECT queue_name, outcome FROM processing_log WHERE organization_id=$1 AND job_id=$2",
        [ORG, processingLogKey],
      );
      expect(logRow.rows).toHaveLength(1);
      expect(logRow.rows[0].queue_name).toBe("m30.measure_recompute");

      expect(outbox.emissions.some((e) => e.eventName === "m30.measure.value_emitted")).toBe(true);

      // A DLQ replay re-delivers the SAME `data` (including `data.jobId`, the processing_log key) under a
      // fresh BullMQ envelope — the `processing_log` guard, not BullMQ's own jobId dedup, must short-circuit
      // it: no second `quality_measure_value` row, no second outbox emission.
      const emissionsBeforeReplay = outbox.emissions.length;
      const q2 = new Queue("m30.measure_recompute", { connection });
      const replayQueueEvents = new QueueEvents("m30.measure_recompute", { connection });
      await replayQueueEvents.waitUntilReady();
      let replayResult: unknown;
      try {
        const original = await q2.getJob(jobId);
        const replayJob = await q2.add("m30.measure_recompute", original!.data, {
          jobId: `${jobId}-replay-envelope`,
        });
        replayResult = await replayJob.waitUntilFinished(replayQueueEvents, 20_000);
      } finally {
        await q2.close();
        await replayQueueEvents.close();
      }
      expect(replayResult).toEqual({ skipped: true, reason: "already_processed" });

      const valueRowAfter = await admin.query(
        "SELECT count(*)::int AS n FROM quality_measure_value WHERE organization_id=$1 AND measure_code='hope_sfv_on_time_rate'",
        [ORG],
      );
      expect(Number(valueRowAfter.rows[0].n)).toBe(1);
      expect(outbox.emissions.length).toBe(emissionsBeforeReplay); // no new emission on replay
    });

    it("risk-register-refresh: enqueue.enqueueRefresh dedupes on (orgId, dateBucket), and the REAL worker completes it end-to-end (per-job withOrgContext wrap, WX-PR-014 fix)", async () => {
      const ports = buildM30CronPorts(deps());
      const dateBucket = "2026-08-05";
      const first = await ports.riskRegisterRefresh.enqueue.enqueueRefresh(ORG, dateBucket);
      const second = await ports.riskRegisterRefresh.enqueue.enqueueRefresh(ORG, dateBucket);
      expect(first.enqueued).toBe(true);
      expect(second.enqueued).toBe(true);

      const inspectQueue = new Queue("m30.risk_register_refresh", { connection });
      let jobId: string;
      let processingLogKey: string;
      try {
        // BullMQ dedupes identical custom jobIds — one call, one job, regardless of the two enqueue() calls.
        // Workers from the PRIOR test are already running (constructed once, reused via `workers`), so this
        // job may already be active/completed/failed by the time we inspect it — check every state.
        const jobs = await inspectQueue.getJobs([
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
        ]);
        expect(jobs).toHaveLength(1);
        jobId = jobs[0]!.id!;
        processingLogKey = jobs[0]!.data.jobId;
      } finally {
        await inspectQueue.close();
      }

      if (!workers) workers = registerM30Workers(deps());
      const queueEvents = new QueueEvents("m30.risk_register_refresh", { connection });
      await queueEvents.waitUntilReady();
      try {
        const q = new Queue("m30.risk_register_refresh", { connection });
        try {
          const job = (await q.getJob(jobId))!;
          const result = await job.waitUntilFinished(queueEvents, 20_000);
          expect(result.outcome).toBe("refreshed");
        } finally {
          await q.close();
        }
      } finally {
        await queueEvents.close();
      }

      const logRow = await admin.query(
        "SELECT outcome FROM processing_log WHERE organization_id=$1 AND job_id=$2",
        [ORG, processingLogKey],
      );
      expect(logRow.rows).toHaveLength(1);
      expect(logRow.rows[0].outcome.outcome).toBe("refreshed");

      expect(outbox.emissions.some((e) => e.eventName === "m30.risk_register.refreshed")).toBe(
        true,
      );
    });

    // GAP-067 — before this, `outbreakDetection.events.recentForOrg` and `outbox.emitOutbreakOpened` were
    // both fail-closed thunks with no production override anywhere: the processor threw
    // M30WorkerPortUnbound on its very FIRST data read, so no assertion beyond "it throws" was possible and
    // none existed. This runs the real §7.8 detector through the real worker over real Postgres.
    it("outbreak-detection: the REAL worker runs the org-wide trailing-window detector end-to-end — opens a case, emits m30.infection.outbreak_opened, and dedupes the window on a re-run (GAP-067)", async () => {
      const PATHOGEN = "influenza a";
      const BODY_SITE = "respiratory tract";
      const FILED_BY = "00000000-0000-0000-0000-0000000000f1";
      const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

      // Three events on ONE (provider, pathogen, body_site) triple inside the 14-day window — the D11
      // ≥3-events/14d threshold. Seeded directly (not through R-91) precisely so the worker's own
      // org-wide read is what has to find them: the R-91 write path runs its own inline detector and
      // would have opened the case itself, proving nothing about this port.
      const eventIds: string[] = [];
      for (const d of [5, 3, 1]) {
        const inserted = await admin.query(
          `INSERT INTO infection_surveillance_event
             (organization_id, provider_entity_id, observed_at, pathogen, body_site,
              transmission_context, filed_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,'unknown',$6) RETURNING id`,
          [ORG, PROVIDER_ENTITY, daysAgo(d), PATHOGEN, BODY_SITE, FILED_BY],
        );
        eventIds.push(inserted.rows[0].id);
      }

      if (!workers) workers = registerM30Workers(deps());
      const queueEvents = new QueueEvents("m30.outbreak_detection", { connection });
      await queueEvents.waitUntilReady();
      const q = new Queue("m30.outbreak_detection", { connection });

      /** Enqueue one detection job keyed on a triggering event, and await the REAL worker's verdict. */
      async function runDetection(surveillanceEventId: string): Promise<{
        outcome: string;
        clustersDetected: number;
        casesOpened: number;
      }> {
        // `data.jobId` is the processing_log idempotency key (raw, colon-delimited); the BullMQ custom id
        // is the sanitized form — BullMQ rejects ':' in a custom id (the WX-PR-013/014 bug class).
        const key = `outbreak_detection:${ORG}:${surveillanceEventId}`;
        const job = await q.add(
          "m30.outbreak_detection",
          { jobId: key, organizationId: ORG, surveillanceEventId },
          { jobId: key.replace(/:/g, "__") },
        );
        try {
          return await job.waitUntilFinished(queueEvents, 20_000);
        } catch (err) {
          const reloaded = await q.getJob(job.id!);
          throw new Error(`job did not complete cleanly: ${reloaded?.failedReason}`, {
            cause: err,
          });
        }
      }

      try {
        const first = await runDetection(eventIds[2]!);
        expect(first.outcome).toBe("detected");
        expect(first.clustersDetected).toBe(1);
        expect(first.casesOpened).toBe(1);

        const cases = await admin.query(
          `SELECT id, status, triggering_event_count FROM infection_outbreak_case
             WHERE organization_id=$1 AND pathogen=$2 AND body_site=$3`,
          [ORG, PATHOGEN, BODY_SITE],
        );
        expect(cases.rows).toHaveLength(1);
        expect(cases.rows[0].status).toBe("open");
        expect(Number(cases.rows[0].triggering_event_count)).toBe(3);

        const opened = outbox.emissions.filter(
          (e) => e.eventName === "m30.infection.outbreak_opened",
        );
        expect(opened).toHaveLength(1);
        expect(opened[0]!.payload.caseId).toBe(cases.rows[0].id);
        expect(opened[0]!.payload.eventCount).toBe(3);

        // A SECOND job under a different triggering event (so `processing_log` does NOT short-circuit it)
        // re-detects the same cluster and must dedupe on the `uq_outbreak_window` unique instead: the
        // detector still reports the cluster, but no second case and no second M36 alert (V-18).
        const second = await runDetection(eventIds[1]!);
        expect(second.outcome).toBe("detected");
        expect(second.clustersDetected).toBe(1);
        expect(second.casesOpened).toBe(0);

        const casesAfter = await admin.query(
          "SELECT count(*)::int AS n FROM infection_outbreak_case WHERE organization_id=$1",
          [ORG],
        );
        expect(Number(casesAfter.rows[0].n)).toBe(1);
        expect(
          outbox.emissions.filter((e) => e.eventName === "m30.infection.outbreak_opened"),
        ).toHaveLength(1);
      } finally {
        await q.close();
        await queueEvents.close();
      }
    });

    it("missing producer — enqueueForOrg / enqueueRefresh fail closed (typed M30WorkerPortUnbound) rather than silently dropping the nightly fan-out when no BullMQ connection is bound", async () => {
      const unboundPorts = buildM30CronPorts(
        buildM30WorkerDeps({
          connection,
          db: handle.db,
          hopeProvider: hopeStub,
          activeOrgs,
          providerEntities: buildOrgProviderEntityLister(handle.db),
          // recomputeEnqueue deliberately omitted — the production posture before this task shipped, and
          // still the posture for any deployment that boots without a Valkey connection configured.
          registrations,
        }),
      );
      await expect(
        unboundPorts.nightlyRecompute.enqueue.enqueueForOrg(ORG, new Date()),
      ).rejects.toThrow(M30WorkerPortUnbound);
      await expect(
        unboundPorts.riskRegisterRefresh.enqueue.enqueueRefresh(ORG, "2026-08-05"),
      ).rejects.toThrow(M30WorkerPortUnbound);
    });
  },
);
