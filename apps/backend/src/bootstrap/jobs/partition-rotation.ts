import type { DbClient } from "@wardenx/db";
import {
  type PlatformBypassAuditor,
  registerPlatformJob,
  withPlatformContext,
} from "@wardenx/tenancy";
// apps/backend/src/bootstrap/jobs/partition-rotation.ts — the `partition.rotate` platform job (F-033 / #93).
//
// M1 owns `apps/backend/src/bootstrap` and `packages/db` (see architecture/module-manifest.ts), and
// partition rotation is a property of the SCHEMA rather than of any module: the 43 time-RANGE tables it
// keeps ahead belong to 20-odd modules and no module can see the others'. So it lives here, as one
// platform job, not as a 21st copy of the same cron.
//
// The two SQL functions this drives (migration 0224) discover their own work from `pg_catalog`; nothing
// here carries a table list. That is the whole point — see the migration header for why a list is the
// same defect one level up, and for what actually happens when rotation is skipped (it is NOT the write
// outage the runbook predicted; every one of these tables has a DEFAULT partition, so writes silently
// divert into it and rotation then becomes impossible without downtime).
import { sql } from "drizzle-orm";

/** The allowlisted platform-job id. Registered by {@link wirePartitionRotationTenancy} at boot. */
export const PARTITION_ROTATION_JOB_ID = "platform.partition_rotate";

/**
 * How many months ahead of the current one to keep created. Three is the number the seeding migrations
 * already chose (`0001_foundation…` seeds current + next 3), so this preserves the window the schema was
 * designed around rather than inventing a new one; it also means a monthly job may miss two consecutive
 * runs before anything reaches the DEFAULT partition.
 */
export const PARTITION_MONTHS_AHEAD = 3;

/**
 * Headroom at or below which coverage is a WARNING. One month means the next monthly run is the last one
 * that can act — the point at which a human should be told, not the point at which it breaks.
 */
export const PARTITION_HEADROOM_WARN_MONTHS = 1;

/** One row of `rotate_time_partitions()`. */
export interface PartitionRotationRow {
  readonly tableName: string;
  /**
   * `created` — partitions were added. `ok` — the window was already covered.
   * `blocked` — the creator refused, almost always because the DEFAULT partition already holds rows for
   * that month; rotation can no longer repair this table on its own.
   * `no_creator` — the table is time-RANGE partitioned and no `create_*_partition(date)` function names
   * it, so nothing can ever extend it.
   */
  readonly status: "created" | "ok" | "blocked" | "no_creator";
  readonly detail: string;
}

/** One row of `time_partition_coverage()`. */
export interface PartitionCoverageRow {
  readonly tableName: string;
  /** Upper bound of the furthest-out partition; `null` when the table has only a DEFAULT partition. */
  readonly coveredThrough: string | null;
  /** Whole months from the start of this month to the coverage edge. 0 = overdue this month. */
  readonly monthsHeadroom: number;
  /** The DEFAULT partition already holds at least one row — see {@link PartitionRotationRow} `blocked`. */
  readonly defaultOccupied: boolean;
  readonly hasCreator: boolean;
}

/** The alertable verdict over a coverage read. */
export interface PartitionCoverageVerdict {
  readonly severity: "ok" | "warn" | "critical";
  readonly summary: string;
  /** Tables whose DEFAULT partition has already started collecting — the critical set. */
  readonly occupiedDefaults: readonly string[];
  /** Tables nothing can extend. */
  readonly missingCreators: readonly string[];
  /** Tables at or below {@link PARTITION_HEADROOM_WARN_MONTHS}. */
  readonly lowHeadroom: readonly string[];
  readonly minHeadroomMonths: number;
}

/**
 * Classify a coverage read. PURE — the whole point of separating it from the query is that the
 * severity rule is the part worth testing, and it does not need a database to be worth testing.
 *
 * The severity ladder deliberately does NOT treat low headroom and an occupied DEFAULT as the same kind
 * of problem, because they need different responses:
 *
 *   warn     — headroom is running out. The monthly job fixes this by itself; a human only needs to know
 *              if it keeps happening (i.e. the job is not running).
 *   critical — a DEFAULT partition is already collecting, or a table has no creator at all. Neither is
 *              self-healing: the first needs rows moved out of DEFAULT under an ACCESS EXCLUSIVE lock,
 *              and every hour of delay makes that lock longer; the second needs a migration.
 */
export function classifyPartitionCoverage(
  rows: readonly PartitionCoverageRow[],
  warnAtMonths: number = PARTITION_HEADROOM_WARN_MONTHS,
): PartitionCoverageVerdict {
  const occupiedDefaults = rows.filter((r) => r.defaultOccupied).map((r) => r.tableName);
  const missingCreators = rows.filter((r) => !r.hasCreator).map((r) => r.tableName);
  const lowHeadroom = rows.filter((r) => r.monthsHeadroom <= warnAtMonths).map((r) => r.tableName);
  // An empty read is not "ok": the discovery query returning nothing means either the migration is not
  // applied or the schema has no partitioned tables, and on this schema the second cannot be true. A
  // probe that reports health when it has measured nothing is the failure mode probes exist to avoid.
  if (rows.length === 0) {
    return {
      severity: "critical",
      summary: "partition coverage query returned no rows — the probe measured nothing",
      occupiedDefaults: [],
      missingCreators: [],
      lowHeadroom: [],
      minHeadroomMonths: 0,
    };
  }
  const minHeadroomMonths = Math.min(...rows.map((r) => r.monthsHeadroom));
  if (occupiedDefaults.length > 0 || missingCreators.length > 0) {
    const parts: string[] = [];
    if (occupiedDefaults.length > 0)
      parts.push(`${occupiedDefaults.length} table(s) already writing into DEFAULT`);
    if (missingCreators.length > 0)
      parts.push(`${missingCreators.length} table(s) have no partition creator`);
    return {
      severity: "critical",
      summary: parts.join("; "),
      occupiedDefaults,
      missingCreators,
      lowHeadroom,
      minHeadroomMonths,
    };
  }
  if (lowHeadroom.length > 0) {
    return {
      severity: "warn",
      summary: `${lowHeadroom.length} table(s) at or below ${warnAtMonths} month(s) of partition headroom`,
      occupiedDefaults,
      missingCreators,
      lowHeadroom,
      minHeadroomMonths,
    };
  }
  return {
    severity: "ok",
    summary: `${rows.length} partitioned table(s), min ${minHeadroomMonths} month(s) headroom`,
    occupiedDefaults,
    missingCreators,
    lowHeadroom,
    minHeadroomMonths,
  };
}

/** Summarise a rotation run for the log line / job result. PURE. */
export function summarizeRotation(rows: readonly PartitionRotationRow[]): {
  readonly created: number;
  readonly ok: number;
  readonly blocked: readonly string[];
  readonly noCreator: readonly string[];
  readonly healthy: boolean;
} {
  const blocked = rows.filter((r) => r.status === "blocked").map((r) => r.tableName);
  const noCreator = rows.filter((r) => r.status === "no_creator").map((r) => r.tableName);
  return {
    created: rows.filter((r) => r.status === "created").length,
    ok: rows.filter((r) => r.status === "ok").length,
    blocked,
    noCreator,
    healthy: blocked.length === 0 && noCreator.length === 0 && rows.length > 0,
  };
}

/** Read partition coverage. Read-only, so it needs no platform context — any pooled client will do. */
export async function readPartitionCoverage(db: DbClient): Promise<PartitionCoverageRow[]> {
  const { rows } = await db.execute(sql`SELECT * FROM time_partition_coverage()`);
  return (rows as Record<string, unknown>[]).map((r) => ({
    tableName: String(r.table_name),
    coveredThrough: r.covered_through === null ? null : String(r.covered_through),
    monthsHeadroom: Number(r.months_headroom),
    defaultOccupied: r.default_occupied === true,
    hasCreator: r.has_creator === true,
  }));
}

/**
 * Run one rotation. Enters `withPlatformContext` because partition DDL is cross-tenant by nature — the
 * tables it extends carry every tenant's rows — so the entry is allowlist-gated and writes the mandatory
 * `platform.bypass_invoked` audit row like every other platform-context entry.
 *
 * `crossTenant` is FALSE deliberately, and the distinction is not cosmetic: that flag drives audit
 * severity, and it asks whether the unit of work reads or writes tenant DATA. Creating an empty partition
 * reads no row and writes no row. Marking this `critical` alongside the genuine cross-tenant data jobs
 * would put a routine monthly no-op at the same severity as a support-session bypass, which is how a
 * critical-severity channel stops being read.
 */
export async function runPartitionRotation(deps: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly monthsAhead?: number;
}): Promise<PartitionRotationRow[]> {
  const monthsAhead = deps.monthsAhead ?? PARTITION_MONTHS_AHEAD;
  return withPlatformContext(
    deps.platformDb,
    {
      jobId: PARTITION_ROTATION_JOB_ID,
      reason: `create the current + ${monthsAhead} following months of time-range partitions`,
      crossTenant: false,
    },
    deps.auditBypass,
    async (tx) => {
      const { rows } = await (tx as unknown as DbClient).execute(
        sql`SELECT * FROM rotate_time_partitions(${monthsAhead})`,
      );
      return (rows as Record<string, unknown>[]).map((r) => ({
        tableName: String(r.table_name),
        status: String(r.status) as PartitionRotationRow["status"],
        detail: String(r.detail),
      }));
    },
  );
}

/**
 * Register the job id on the `@wardenx/tenancy` platform-context allowlist. The allowlist starts EMPTY
 * and `withPlatformContext` throws for an unregistered caller, so without this call rotation refuses
 * itself — which is the intended fail-closed shape, not an accident to route around.
 */
export function wirePartitionRotationTenancy(): void {
  registerPlatformJob(PARTITION_ROTATION_JOB_ID);
}

/** The queue name and its cron. */
export const PARTITION_ROTATION_QUEUE = "platform.partition-rotate";

/**
 * 03:10 on the 1st, 8th and 15th of each month — three chances, not one. A single monthly tick is one
 * missed run away from being no job at all, and the window this maintains (3 months) is wide enough that
 * running it more often costs nothing: every run after the first is `CREATE TABLE IF NOT EXISTS` against
 * partitions that already exist. The cheap thing is the one worth doing repeatedly.
 */
export const PARTITION_ROTATION_CRON = "10 3 1,8,15 * *";
