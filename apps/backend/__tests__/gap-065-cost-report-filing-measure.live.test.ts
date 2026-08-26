/**
 * GAP-065 — the CoP 418.310 cost-report filing indicator, proven end-to-end over real Postgres + BullMQ.
 *
 * Before this fix the whole chain existed EXCEPT the two links that make it do anything: M27 published
 * `CostReportFilingStatusReader`, M30's `buildM30CostReportConsumer` adapter projected it onto the
 * `QualityCostReportConsumer` view, and `bindQualityConsumedSeams` could assemble it — but no composition
 * root ever bound the adapter, and no measure in `MEASURE_CATALOG` read `costReport.filingStatusForOrg`
 * (there was no CoP-418.310 measure code at all). Boot comments nonetheless claimed the indicator
 * "resolves the live filing posture". This test drives the REAL chain:
 *
 *   1. `registerM27PublishedSeams` registers M27's live reader into the M1 registry.
 *   2. `buildM30WorkerDeps` binds `buildM30CostReportConsumer()` by DEFAULT (the wiring that was missing).
 *   3. The REAL `registerM30Workers` measure_recompute worker runs the new
 *      `cost_report_filing_compliance` registration for real, inside its own `withOrgContext`.
 *   4. A NON-SUPPRESSED `quality_measure_value` row lands — the audit's explicit verification bar.
 *   5. With M27's seam absent the same job still completes, writing a SUPPRESSED (`insufficient_n`, null
 *      rate) row rather than a fabricated 0% or 100% — the D6/D13 forward-seam posture.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://localhost:PORT \
 *     bunx vitest run apps/backend/__tests__/gap-065-cost-report-filing-measure.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1. Use a
 * Redis instance dedicated to this run — a shared one means two worker sets racing for the same job.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { type QualityHopeConsumer, buildMeasureRegistry } from "@wardenx/quality";
import { type ConnectionOptions, Queue, QueueEvents, type Worker } from "bullmq";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerM27PublishedSeams } from "../src/modules/27-cost-report/index";
import { buildM30WorkerDeps, registerM30Workers } from "../src/modules/30-quality/index";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "65656565-6565-6565-6565-656565656565";
const PROVIDER_ENTITY = "00000000-0000-0000-0000-0000000000e1";
const MEASURE = "cost_report_filing_compliance";

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/** Records every publish so the emit can be asserted without a live outbox dispatcher. */
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

/** Unused by this fixture's one registered measure — every method refuses rather than returning zeros. */
const hopeStub: QualityHopeConsumer = {
  async sfvTimelinessRollup() {
    throw new Error("unused by this fixture");
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

describe.skipIf(!DB_URL || !REDIS_URL)(
  "GAP-065 — CoP 418.310 cost-report filing measure, LIVE Postgres + Redis",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let connection: ConnectionOptions;
    let outbox: ReturnType<typeof fakeOutbox>;
    let workers: Worker[] | undefined;

    async function applyMigrations(): Promise<void> {
      const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap-065','A','A')",
        [ORG],
      );
      await admin.query(
        `INSERT INTO provider_entity
           (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end, status)
         VALUES ($1,$2,'990065','GAP-065 Test Hospice','1999990065','enc-placeholder','0930','active')`,
        [PROVIDER_ENTITY, ORG],
      );
      // A cost report whose FYE + 5 months is long past, still in `draft` — the 418.310 trigger. The
      // reader keeps the LATEST fiscal year per provider entity, so one row is the whole obligation.
      await admin.query(
        `INSERT INTO cost_report (organization_id, provider_entity_id, fiscal_year_start_date,
           fiscal_year_end_date, state, bad_debt_claimed, wage_source)
         VALUES ($1,$2,'2020-10-01','2021-09-30','draft',false,'manual')`,
        [ORG, PROVIDER_ENTITY],
      );
      handle = createDbClient({ connectionString: DB_URL! });
      connection = parseRedisUrl(REDIS_URL!);
      const flusher = new IORedis({ ...connection, maxRetriesPerRequest: null });
      await flusher.flushall();
      await flusher.quit();
      outbox = fakeOutbox();
    }, 120_000);

    afterAll(async () => {
      if (workers) await Promise.all(workers.map((w) => w.close()));
      if (handle) await handle.close();
      if (admin) await admin.end();
    });

    // Narrowed to the ONE measure under test, using the REAL production registration (the calculator from
    // `buildMeasureRegistry()`), so nothing else competes for the queue.
    const registrations = () => new Map([[MEASURE, buildMeasureRegistry().get(MEASURE)!]]);

    const deps = () =>
      buildM30WorkerDeps({
        connection,
        db: handle.db,
        hopeProvider: hopeStub,
        outboxPublisher: outbox.port,
        registrations: registrations(),
        // `costReport` deliberately NOT passed — the point is that `buildM30WorkerDeps` binds the live
        // adapter by default. Passing one here would test the test, not the wiring GAP-065 was about.
      });

    /** Enqueue one measure_recompute job for this measure and await the REAL worker's verdict. */
    async function runRecompute(suffix: string): Promise<{ outcome: string }> {
      const key = `measure_recompute:${ORG}:${MEASURE}:${suffix}`;
      const q = new Queue("m30.measure_recompute", { connection });
      const queueEvents = new QueueEvents("m30.measure_recompute", { connection });
      await queueEvents.waitUntilReady();
      try {
        const job = await q.add(
          "m30.measure_recompute",
          {
            jobId: key,
            organizationId: ORG,
            providerEntityId: PROVIDER_ENTITY,
            measureCode: MEASURE,
            periodStart: "2025-01-01T00:00:00.000Z",
            periodEnd: "2026-01-01T00:00:00.000Z",
            reason: "adhoc",
            computeVersion: "0.1.0",
            enqueuedBy: null,
          },
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
      } finally {
        await q.close();
        await queueEvents.close();
      }
    }

    it("with M27's seam absent the measure SUPPRESSES (insufficient_n, null rate) instead of fabricating a filing posture", async () => {
      // No `registerM27PublishedSeams` yet: `getSeam("CostReportFilingStatusReader")` is the M1 deny-stub,
      // the adapter degrades to FORWARD_SEAM_UNAVAILABLE, and the resolver hands the calculator 0/0.
      workers = registerM30Workers(deps());
      const result = await runRecompute("suppressed");
      expect(result.outcome).toBe("recomputed");

      // `quality_measure_value` persists no band column — the `insufficient_n` band IS the null ratio
      // (the read layer re-derives the band), so a null `ratio` on a 0 denominator is the suppression.
      const row = await admin.query(
        `SELECT numerator, denominator, ratio, threshold_met FROM quality_measure_value
           WHERE organization_id=$1 AND measure_code=$2`,
        [ORG, MEASURE],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].ratio).toBeNull(); // never a fabricated 0% or 100%
      expect(row.rows[0].threshold_met).toBeNull();
      expect(Number(row.rows[0].denominator)).toBe(0);
    });

    it("with M27's seam registered the measure COMPUTES a non-suppressed value from the live filing posture", async () => {
      // The wiring under test: M27 publishes, M30's default `costReport` binding reads it, and the CoP
      // 418.310 indicator finally produces a real value — one assessed provider entity, past its deadline
      // and unfiled, so 0-of-1 compliant against the regulatory 100% floor.
      registerM27PublishedSeams(handle.db);
      const result = await runRecompute("computed");
      expect(result.outcome).toBe("recomputed");

      const rows = await admin.query(
        `SELECT numerator, denominator, ratio, threshold_met FROM quality_measure_value
           WHERE organization_id=$1 AND measure_code=$2 AND superseded_at IS NULL`,
        [ORG, MEASURE],
      );
      expect(rows.rows).toHaveLength(1);
      const value = rows.rows[0];
      expect(Number(value.denominator)).toBe(1); // the provider entity WAS assessed — not suppressed
      expect(Number(value.numerator)).toBe(0); // and it is past deadline unfiled
      expect(Number(value.ratio)).toBe(0);
      expect(value.threshold_met).toBe(false); // 0% against the 418.310 100% floor

      // The prior (suppressed) row for the same triple is soft-superseded, not deleted — and the pair
      // proves the supersede-then-insert ordering fix: `uq_quality_measure_value_current` is a
      // NON-deferrable partial unique index, so the old ordering (insert, then stamp superseded_at) made
      // every value-CHANGING recompute fail outright. This is the first end-to-end recompute of a triple
      // whose result actually moved.
      const all = await admin.query(
        `SELECT superseded_by FROM quality_measure_value
           WHERE organization_id=$1 AND measure_code=$2 AND superseded_at IS NOT NULL`,
        [ORG, MEASURE],
      );
      expect(all.rows).toHaveLength(1);

      expect(outbox.emissions.some((e) => e.eventName === "m30.measure.value_emitted")).toBe(true);

      // The red-band transition also emits the breach — a path that could not run at all until now: the
      // worker calls this emit UNCONDITIONALLY on a transition into red, and the port was fail-closed on a
      // payload/schema mismatch, so a breaching recompute threw and rolled back instead of persisting.
      const breach = outbox.emissions.filter(
        (e) => e.eventName === "m30.measure.threshold_breached",
      );
      expect(breach).toHaveLength(1);
      expect(breach[0]!.payload.indicatorId).toBe(MEASURE);
      expect(breach[0]!.payload.threshold).toBe(1); // the 418.310 regulatory floor, carried through
      expect(breach[0]!.payload.rate).toBe(0);
    });
  },
);
