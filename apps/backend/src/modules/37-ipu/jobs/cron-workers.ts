// apps/backend/src/modules/37-ipu/jobs/cron-workers.ts — F-071 (#174): the LIVE BullMQ Worker +
// repeatable Queue construction for M37's `ipu.rn-coverage-watchdog` (the M9/M10/M14/M25
// `jobs/cron-workers.ts` template). One cron fans out over the active orgs, opens ONE per-org
// `withOrgContext` tx per tick, reads via `./cron-store`, runs the PURE `buildCoverageWindows`
// (@wardenx/inpatient) and `planCoverageAlerts` (`./index`), upserts the grid, and publishes every alert
// to the TRANSACTIONAL OUTBOX inside that SAME tx.
//
// The grid and the alerts committing together is the point: an outbox validation error rolls back the
// rebuild too, so the platform never ends up with a coverage table saying a unit is covered while the
// alert that said otherwise was lost.
import type { DbClient } from "@wardenx/db";
import { buildCoverageWindows } from "@wardenx/inpatient";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import type { WriteOutboxPort } from "../routes/service-drizzle";
import { activeUnitsForOrg, assignmentFactsForUnit, upsertCoverageWindows } from "./cron-store";
import {
  COVERAGE_LOOKAHEAD_HOURS,
  COVERAGE_LOOKBACK_HOURS,
  COVERAGE_WINDOW_HOURS,
  type CoverageWindowRow,
  M37_JOB_SCHEDULES,
  M37_QUEUES,
  M37_QUEUE_PARAMS,
  planCoverageAlerts,
  resolveAlertHorizonHours,
} from "./index";
import { M37_LIFECYCLE_JOBS } from "./lifecycle-workers";
import { M37_WATCHDOG_JOBS, type SignedEncountersPort } from "./watchdog-workers";

const HOUR_MS = 3_600_000;

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. `outbox` is REQUIRED; `activeOrgs` defaults fail-closed
 *  (the M9/M10/M14 convention — only `activeOrgs` gets the lazy fail-closed thunk). */
export interface M37WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
  /** M8's org-explicit signed-encounter read (nursing-note shift watchdog); the cron fails loudly when unbound. */
  readonly signedEncounters?: SignedEncountersPort;
  now?: () => Date;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M37_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M37WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unbound(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the cron fan-out source) under withPlatformContext",
        ),
    }
  );
}

/** Build the {@link M37WorkerDeps} from the composition-root primitives (the M14/M25 `buildMxWorkerDeps` shape). */
export function buildM37WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: WriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
  signedEncounters?: SignedEncountersPort;
}): M37WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    signedEncounters: deps.signedEncounters,
    now: () => new Date(),
  };
}

/**
 * A per-org checkpoint that survives a BullMQ RETRY of the same job (the M14 precedent).
 *
 * The fan-out sweeps every active org inside ONE job and each org's `withOrgContext` COMMITS
 * INDEPENDENTLY, so with `attempts: 3` a failure part-way through re-runs the whole loop. For THIS cron
 * the rebuild half is idempotent — the upsert lands the same grid — but the ALERTS are not: an org that
 * already committed would publish `rn_uncovered` again on every attempt, and that alert is
 * block-severity. `swept` has to be durable across attempts, which rules out an in-process Set; BullMQ's
 * own job data lives in Redis and a retry reuses the same job.
 */
export interface CoverageSweepCheckpoint {
  /** Org ids already swept by an earlier attempt of THIS job — skipped on re-entry. */
  readonly swept: readonly string[];
  /** Durably record that `organizationId` committed. Called after each org's tx, never inside it. */
  record(organizationId: string): Promise<void>;
}

/**
 * `ipu.rn-coverage-watchdog` (§4.8 every 5 min / §2.3 D3, F-071) — rebuild `ipu_rn_coverage_window` for
 * every active unit in every active org over the rolling 168h-back + 48h-forward range, and raise the two
 * §2.3 alerts.
 *
 * This is the producer that did not exist. The table it writes is read by `openAdmission`, `requestBed`,
 * `initiateTransfer` and `applyRestraint`, each of which treats an absent row as uncovered — so before
 * this worker, every GIP and inpatient-respite admission was refused at open on every deployment.
 *
 * Two retry-safety properties, both load-bearing and both inherited from M14's sweep:
 *   (1) an org already swept by an earlier ATTEMPT is skipped;
 *   (2) one org's failure no longer aborts the tick for the orgs after it — failures are collected and
 *       rethrown together, so a single bad tenant cannot deny every tenant that sorts after it a
 *       coverage rebuild. The throw still fails the job so the DLQ sees it.
 */
export async function runRnCoverageWatchdogCron(
  deps: M37WorkerDeps,
  checkpoint?: CoverageSweepCheckpoint,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const windowStartMs = currentHourMs - COVERAGE_LOOKBACK_HOURS * HOUR_MS;
  const windowEndMs = currentHourMs + COVERAGE_LOOKAHEAD_HOURS * HOUR_MS;

  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const alreadySwept = new Set(checkpoint?.swept ?? []);
  const failures: { organizationId: string; error: unknown }[] = [];

  for (const { organizationId } of orgs) {
    if (alreadySwept.has(organizationId)) continue;
    try {
      await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
        const t = tx as unknown as DbClient;
        const units = await activeUnitsForOrg(t, organizationId);
        for (const unit of units) {
          const facts = await assignmentFactsForUnit(
            t,
            unit.unitId,
            new Date(windowStartMs),
            new Date(windowEndMs),
          );
          const grid = buildCoverageWindows(facts, windowStartMs, COVERAGE_WINDOW_HOURS);
          const rows: CoverageWindowRow[] = grid.map((h) => ({
            unitId: unit.unitId,
            hourStartAt: new Date(h.hourStartMs),
            isCovered: h.isCovered,
            rnAssignmentIds: h.rnAssignmentIds,
          }));
          await upsertCoverageWindows(t, organizationId, rows);

          const horizon = resolveAlertHorizonHours(unit.rnCoverageHorizonHours);
          const outcome = planCoverageAlerts(unit.unitId, rows, nowMs, horizon);

          if (outcome.currentHourUncovered) {
            await deps.outbox.publish(t, {
              eventName: "m37.shift.rn_uncovered",
              payload: {
                unitId: unit.unitId,
                organizationId,
                hourStartAt: new Date(currentHourMs).toISOString(),
                coveredHours: outcome.coveredHours,
                totalHours: outcome.totalHours,
              },
              organizationId,
              aggregateKind: "inpatient_unit",
              aggregateId: unit.unitId,
            });
          }
          if (outcome.projectedGapAt) {
            await deps.outbox.publish(t, {
              eventName: "m37.shift.coverage_gap_projected",
              payload: {
                unitId: unit.unitId,
                organizationId,
                gapStartsAt: outcome.projectedGapAt.toISOString(),
                alertHorizonHours: horizon,
              },
              organizationId,
              aggregateKind: "inpatient_unit",
              aggregateId: unit.unitId,
            });
          }
        }
      });
    } catch (error) {
      failures.push({ organizationId, error });
      continue;
    }
    // Only AFTER the org's tx committed. If recording the checkpoint itself fails, the org is swept again
    // on retry — a duplicate alert for one org, which is better than treating an uncommitted org as done
    // and leaving its coverage grid stale for five minutes with admissions blocked behind it.
    await checkpoint?.record(organizationId);
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M37_RN_COVERAGE_WATCHDOG: ${failures.length} of ${orgs.length} org(s) failed — ` +
        `${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}

// ── backoff-string parsing (M37_QUEUE_PARAMS.backoff is a STRING, not BullMQ's {type,delay} shape) ─────
// Duplicated per-module rather than shared (the M9/M10/M14 convention — implementation detail, not a
// cross-module seam).

interface ParsedBackoff {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

function parseDurationMs(token: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(token);
  if (!m) throw new Error(`M37_BACKOFF_PARSE: unrecognized duration token '${token}'`);
  const [, digits, unit] = m;
  const n = Number(digits);
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      throw new Error(`M37_BACKOFF_PARSE: unreachable unit '${unit}'`);
  }
}

/** Parse `M37_QUEUE_PARAMS[*].backoff` — a STRING like `"exponential 60s"` — into the `{type, delay}`
 *  shape BullMQ's `queue.add()` options need (the M9/M10/M14 `parseBackoff` precedent). */
function parseBackoff(spec: string): ParsedBackoff {
  const head = spec.split(",")[0] ?? spec;
  const [type, duration] = head.trim().split(/\s+/);
  if (type !== "exponential" && type !== "fixed") {
    throw new Error(`M37_BACKOFF_PARSE: unrecognized backoff type '${type}' in '${spec}'`);
  }
  if (!duration) throw new Error(`M37_BACKOFF_PARSE: missing duration in '${spec}'`);
  return { type, delay: parseDurationMs(duration) };
}

// ── BullMQ construction (the M9/M10/M14/M25 registerMxCronWorkers / scheduleMxJobs template) ───────────

/** Back {@link CoverageSweepCheckpoint} with the BullMQ job's own `data`, which Redis persists and a
 *  RETRY of the same job re-reads. `updateData` rewrites the whole blob, so existing fields are spread. */
function bullmqCheckpoint(job: Job): CoverageSweepCheckpoint {
  const data = (job.data ?? {}) as { sweptOrgIds?: unknown };
  const swept = Array.isArray(data.sweptOrgIds) ? (data.sweptOrgIds as string[]) : [];
  const accumulated = [...swept];
  return {
    swept,
    async record(organizationId: string) {
      accumulated.push(organizationId);
      await job.updateData({ ...(job.data ?? {}), sweptOrgIds: accumulated });
    },
  };
}

/** Construct the `ipu.rn-coverage-watchdog` cron `Worker` (the caller owns lifecycle — `close()` on shutdown). */
export function registerM37CronWorkers(deps: M37WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(
      M37_QUEUES.rnCoverageWatchdog,
      async (job) => runRnCoverageWatchdogCron(deps, bullmqCheckpoint(job)),
      { connection, concurrency: M37_QUEUE_PARAMS.rnCoverageWatchdog.concurrency },
    ),
    // GAP-105 — irc-cap / census / restraint / bed-cleaning / GIP-staleness (`./watchdog-workers`).
    ...[...M37_WATCHDOG_JOBS, ...M37_LIFECYCLE_JOBS].map(
      (job) =>
        new Worker(job.queue, async () => job.run(deps), {
          connection,
          concurrency: job.params.concurrency,
        }),
    ),
  ];
}

/** Register the §4.8 repeatable cron schedule, threading the parsed backoff + `attempts` from
 *  `M37_QUEUE_PARAMS`. `removeOnFail: false` keeps the queue's own failed-jobs set as the de facto DLQ
 *  (the M9/M10/M14/M25 convention). Returns the `Queue` to `close()`. */
export async function scheduleM37Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M37_QUEUES.rnCoverageWatchdog, { connection });
  const p = M37_QUEUE_PARAMS.rnCoverageWatchdog;
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M37_JOB_SCHEDULES.rnCoverageWatchdog },
      priority: p.priority,
      attempts: p.attempts,
      backoff: parseBackoff(p.backoff),
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  const watchdogQueues = await Promise.all(
    [...M37_WATCHDOG_JOBS, ...M37_LIFECYCLE_JOBS].map(async (job) => {
      const jobQueue = new Queue(job.queue, { connection });
      await jobQueue.add(
        "scheduled",
        {},
        {
          repeat: { pattern: job.schedule },
          priority: job.params.priority,
          attempts: job.params.attempts,
          backoff: parseBackoff(job.params.backoff),
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      return jobQueue;
    }),
  );
  return [queue, ...watchdogQueues];
}
