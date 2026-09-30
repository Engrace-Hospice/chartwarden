// apps/backend/src/modules/14-idg/jobs/cron-workers.ts — GAP-092: the LIVE BullMQ Worker + repeatable
// Queue construction for M14's `idg.review-clock-sweep` (the M9/M10/M25 `jobs/cron-workers.ts` template).
// One cron fans out over the active orgs, opens ONE per-org `withOrgContext` tx per tick, reads via
// `./cron-store`, runs the PURE `planReviewClockSweep` (`./index`), and publishes every escalation to the
// TRANSACTIONAL OUTBOX inside that SAME tx (a thrown outbox validation error rolls back the whole org's
// tick — a partial escalation burst never partially commits).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { IdgWriteOutboxPort } from "../idg-route-service-db";
import type { IdgMembershipDisplayPort, IdgSiteDisplayPort } from "../routes/idg-enrichment";
import { runCarryForwardCron } from "./carry-forward";
import { locationCoordinatorsForOrg, reviewClockPatientsForOrg } from "./cron-store";
import type { ActiveOrgListPort } from "./index";
import {
  M14_JOB_SCHEDULES,
  M14_QUEUES,
  M14_QUEUE_PARAMS,
  M14_WORKER_SYSTEM_USER_ID,
  planReviewClockSweep,
} from "./index";
import type {
  Idg6PacketPort,
  Idg6RecertWindowPort,
  Idg7PacketPort,
  Idg10HopeContextPort,
  IdgFlaggedEventSourcePort,
} from "./packet-build";
import { runPacketBuildCron } from "./packet-build";
import type { Idg1LocationTimezonePort } from "./schedule-materialise";
import { runScheduleMaterialiseCron } from "./schedule-materialise";

export type { ActiveOrgListPort } from "./index";
export { M14_WORKER_SYSTEM_USER_ID } from "./index";

/** The dep bag the composition root injects. `outbox` is REQUIRED; every fan-out/cross-module port
 * defaults fail-closed (the M9/M10 convention — only these get the lazy fail-closed thunk, F-171 extends
 * it from `activeOrgs` alone to the `redis`/`m6`/`m7` ports `packet-build.ts` needs). */
export interface M14WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: IdgWriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
  /** F-171 — the Valkey client `packet-build.ts`'s F-164 "since last IDG" cache read needs. */
  readonly redis?: Redis;
  /** F-171 — the M6 §2.3 D9 inclusion + current-LOC org-explicit port (`packet-build.ts`). */
  readonly m6?: Idg6PacketPort;
  /** F-171 — the M7 §2.4 care-plan-summary org-explicit port (`packet-build.ts`). */
  readonly m7?: Idg7PacketPort;
  /** §2.4 cover recert/F2F facts (M6 `idgRecertWindowsForOrg`); unbound ⇒ the cover fields stay null. */
  readonly recertWindows?: Idg6RecertWindowPort;
  /** §2.4 `sinceLastIdg.flaggedEvents` sources (M6 hospital/ER, M13 missed dose, M30 fall/infection); unbound ⇒ `[]`. */
  readonly flaggedEventSources?: readonly IdgFlaggedEventSourcePort[];
  /** §2.4 `hopeContext` (M10 `idgHopeContextForOrg`); unbound ⇒ `null` (not captured). */
  readonly hope?: Idg10HopeContextPort;
  /** M1 `siteDisplayForOrg` (org + location NAMES) for the packet PDF header; unbound ⇒ header omits the names. */
  readonly siteDisplay?: IdgSiteDisplayPort;
  /** M2 `membershipDisplayForOrg` (names only) for the carry-forward assignees; unbound ⇒ "Member xxxxxxxx". */
  readonly membershipDisplay?: IdgMembershipDisplayPort;
  /** F-171 — the M1 `FoundationSiteReader.locationTimezone` org-explicit port (`schedule-materialise.ts`). */
  readonly locationTimezone?: Idg1LocationTimezonePort;
  now?: () => Date;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M14_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M14WorkerDeps): ActiveOrgListPort {
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

function m6Of(deps: M14WorkerDeps): Idg6PacketPort {
  return (
    deps.m6 ?? {
      inclusionForOrg: () =>
        unbound("m6.inclusionForOrg", "bind idgPacketInclusionForOrg at the composition root"),
      currentLevelOfCareForOrg: () =>
        unbound(
          "m6.currentLevelOfCareForOrg",
          "bind idgCurrentLevelOfCareForOrg at the composition root",
        ),
    }
  );
}

function m7Of(deps: M14WorkerDeps): Idg7PacketPort {
  return (
    deps.m7 ?? {
      carePlanContextForOrg: () =>
        unbound(
          "m7.carePlanContextForOrg",
          "bind idgPacketCarePlanContextForOrg at the composition root",
        ),
    }
  );
}

function locationTimezoneOf(deps: M14WorkerDeps): Idg1LocationTimezonePort {
  return (
    deps.locationTimezone ?? {
      locationTimezone: () =>
        unbound(
          "locationTimezone.locationTimezone",
          "bind M1's FoundationSiteReader.locationTimezone at the composition root",
        ),
    }
  );
}

function redisOf(deps: M14WorkerDeps): Redis {
  if (deps.redis) return deps.redis;
  const err = (): never => {
    throw new Error(
      "M14_WORKER_PORT_UNBOUND: redis — bind the Valkey client at the composition root",
    );
  };
  return new Proxy({}, { get: () => err }) as Redis;
}

/** Build the {@link M14WorkerDeps} from the composition-root primitives (the M25/M9 `buildMxWorkerDeps` shape). */
export function buildM14WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: IdgWriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
  redis?: Redis;
  m6?: Idg6PacketPort;
  m7?: Idg7PacketPort;
  recertWindows?: Idg6RecertWindowPort;
  flaggedEventSources?: readonly IdgFlaggedEventSourcePort[];
  hope?: Idg10HopeContextPort;
  siteDisplay?: IdgSiteDisplayPort;
  membershipDisplay?: IdgMembershipDisplayPort;
  locationTimezone?: Idg1LocationTimezonePort;
}): M14WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    redis: deps.redis,
    m6: deps.m6,
    m7: deps.m7,
    recertWindows: deps.recertWindows,
    flaggedEventSources: deps.flaggedEventSources,
    hope: deps.hope,
    siteDisplay: deps.siteDisplay,
    membershipDisplay: deps.membershipDisplay,
    locationTimezone: deps.locationTimezone,
    now: () => new Date(),
  };
}

/**
 * A per-org checkpoint that survives a BullMQ RETRY of the same job.
 *
 * Why this exists: the fan-out sweeps every active org inside ONE job, and each org's
 * `withOrgContext` COMMITS INDEPENDENTLY. With `attempts: 3`, a failure part-way through the loop
 * re-runs the whole loop, so every org that already committed gets its escalations published a
 * second (and on the third attempt a third) time — every patient sitting exactly on T-3/T-0/T+1 in
 * those orgs is escalated again, at `critical`, to every consumer. The transactional outbox makes a
 * single org's burst all-or-nothing; it says nothing about the loop around it.
 *
 * `swept` therefore has to be durable across attempts, which rules out an in-process Set. BullMQ's
 * own job data is the natural home: it lives in Redis, and a retry reuses the SAME job, so the list
 * written by attempt 1 is visible to attempt 2.
 */
export interface ReviewClockSweepCheckpoint {
  /** Org ids already swept by an earlier attempt of THIS job — skipped on re-entry. */
  readonly swept: readonly string[];
  /** Durably record that `organizationId` committed. Called after each org's tx, never inside it. */
  record(organizationId: string): Promise<void>;
}

/** `idg.review-clock-sweep` (§4.8 daily / M14-F01 / ADR-0018 D2, GAP-092) — escalate every patient at
 * T-3/T-0/T+1 of their per-patient 15-day review floor.
 *
 * Two retry-safety properties, both load-bearing:
 *   (1) an org already swept by an earlier ATTEMPT is skipped (see {@link ReviewClockSweepCheckpoint});
 *   (2) one org's failure no longer aborts the tick for the orgs after it — failures are collected and
 *       rethrown together at the end, so a single bad tenant cannot silently deny every tenant that
 *       sorts after it a day's escalations. The throw still fails the job (so the DLQ/alerting sees
 *       it), but the retry now only has the un-swept orgs left to do. */
export async function runReviewClockSweepCron(
  deps: M14WorkerDeps,
  checkpoint?: ReviewClockSweepCheckpoint,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const alreadySwept = new Set(checkpoint?.swept ?? []);
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    if (alreadySwept.has(organizationId)) continue;
    try {
      await withOrgContext(
        deps.db,
        { organizationId, userId: M14_WORKER_SYSTEM_USER_ID },
        async (tx) => {
          const t = tx as unknown as DbClient;
          const patients = await reviewClockPatientsForOrg(t, organizationId);
          const escalations = planReviewClockSweep(patients, now);
          // The coordinator tier of the M36 alert (only read when something escalates; one batched read).
          const coordinators =
            escalations.length === 0
              ? new Map<string, string>()
              : await locationCoordinatorsForOrg(
                  t,
                  organizationId,
                  [...new Set(escalations.map((e) => e.locationId))],
                  now,
                );
          for (const e of escalations) {
            const coordinatorMembershipId = coordinators.get(e.locationId);
            await deps.outbox.publish(t, {
              eventName: "m14.review_clock.escalated",
              payload: {
                admissionId: e.admissionId,
                patientId: e.patientId,
                locationId: e.locationId,
                lastIdgReviewedAt: e.lastIdgReviewedAt,
                floorAt: e.floorAt,
                stage: e.stage,
                severity: e.severity,
                ...(coordinatorMembershipId === undefined ? {} : { coordinatorMembershipId }),
              },
              organizationId,
              aggregateKind: "idg_patient_packet",
              aggregateId: e.patientId,
            });
          }
        },
      );
    } catch (error) {
      failures.push({ organizationId, error });
      continue;
    }
    // Only AFTER the org's tx committed. If recording the checkpoint itself fails, the org is swept
    // again on retry — a duplicate escalation for one org, which is strictly better than treating an
    // uncommitted org as done and dropping its escalations entirely.
    await checkpoint?.record(organizationId);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M14_REVIEW_CLOCK_SWEEP: ${failures.length} of ${orgs.length} org(s) failed — ` +
        `${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}

// ── backoff-string parsing (M14_QUEUE_PARAMS.backoff is a STRING, not BullMQ's {type,delay} shape) ─────
// Duplicated per-module rather than shared (the M9/M10 convention — each module's jobs/cron-workers.ts
// carries its own copy; this is implementation detail, not a cross-module seam).

interface ParsedBackoff {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

function parseDurationMs(token: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(token);
  if (!m) throw new Error(`M14_BACKOFF_PARSE: unrecognized duration token '${token}'`);
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
      throw new Error(`M14_BACKOFF_PARSE: unreachable unit '${unit}'`);
  }
}

/** Parse `M14_QUEUE_PARAMS[*].backoff` — a STRING like `"exponential 120s"` — into the `{type, delay}`
 * shape BullMQ's `queue.add()` options need (the M9/M10 `parseBackoff` precedent). */
function parseBackoff(spec: string): ParsedBackoff {
  const head = spec.split(",")[0] ?? spec;
  const [type, duration] = head.trim().split(/\s+/);
  if (type !== "exponential" && type !== "fixed") {
    throw new Error(`M14_BACKOFF_PARSE: unrecognized backoff type '${type}' in '${spec}'`);
  }
  if (!duration) throw new Error(`M14_BACKOFF_PARSE: missing duration in '${spec}'`);
  return { type, delay: parseDurationMs(duration) };
}

// ── BullMQ construction (the M9/M10/M25 registerMxCronWorkers / scheduleMxJobs template) ────────────────

/** Back {@link ReviewClockSweepCheckpoint} with the BullMQ job's own `data`, which Redis persists and a
 * RETRY of the same job re-reads — so orgs swept by attempt 1 are skipped by attempt 2. `updateData`
 * rewrites the whole data blob, so the existing fields are spread back in. */
function bullmqCheckpoint(job: Job): ReviewClockSweepCheckpoint {
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

/** Construct all FOUR M14 crons (+ `idg.carry-forward`, §2.7) (the caller owns lifecycle — `close()` on shutdown): the pre-existing
 * `idg.review-clock-sweep`, plus F-171's `idg.schedule-materialise` (§7.1) and `idg.packets-cron` (§4.9.1
 * `tminus-24h-build`) — the real T-24h packet-build worker. `m6`/`m7`/`redis` resolve through the same
 * fail-closed-thunk pattern `activeOrgs` already uses, so an unwired port throws loudly on first USE
 * rather than at construction. */
export function registerM14CronWorkers(deps: M14WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(
      M14_QUEUES.reviewClockSweep,
      async (job) => runReviewClockSweepCron(deps, bullmqCheckpoint(job)),
      {
        connection,
        concurrency: M14_QUEUE_PARAMS.reviewClockSweep.concurrency,
      },
    ),
    new Worker(
      M14_QUEUES.scheduleMaterialise,
      async () =>
        runScheduleMaterialiseCron({
          db: deps.db,
          outbox: deps.outbox,
          activeOrgs: activeOrgsOf(deps),
          locationTimezone: locationTimezoneOf(deps),
          now: deps.now,
        }),
      { connection, concurrency: M14_QUEUE_PARAMS.scheduleMaterialise.concurrency },
    ),
    new Worker(
      M14_QUEUES.packetsBuild,
      async () =>
        runPacketBuildCron({
          db: deps.db,
          outbox: deps.outbox,
          activeOrgs: activeOrgsOf(deps),
          redis: redisOf(deps),
          m6: m6Of(deps),
          m7: m7Of(deps),
          recertWindows: deps.recertWindows,
          flaggedEventSources: deps.flaggedEventSources,
          hope: deps.hope,
          siteDisplay: deps.siteDisplay,
          membershipDisplay: deps.membershipDisplay,
          now: deps.now,
        }),
      { connection, concurrency: M14_QUEUE_PARAMS.packetsBuild.concurrency },
    ),
    new Worker(
      M14_QUEUES.carryForward,
      async () =>
        runCarryForwardCron({
          db: deps.db,
          outbox: deps.outbox,
          activeOrgs: activeOrgsOf(deps),
          now: deps.now,
        }),
      { connection, concurrency: M14_QUEUE_PARAMS.carryForward.concurrency },
    ),
  ];
}

/** Register the §4.8 repeatable cron schedules for all three M14 queues, threading the parsed backoff +
 * `attempts` from `M14_QUEUE_PARAMS`. `removeOnFail: false` keeps each queue's own failed-jobs set as the
 * de facto DLQ (the M9/M10/M25 convention — no separate literal `Queue` for `M14_DLQ`). Returns the
 * `Queue`s to `close()`. */
export async function scheduleM14Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const specs: ReadonlyArray<{
    readonly queue: (typeof M14_QUEUES)[keyof typeof M14_QUEUES];
    readonly pattern: string;
    readonly params: (typeof M14_QUEUE_PARAMS)[keyof typeof M14_QUEUE_PARAMS];
  }> = [
    {
      queue: M14_QUEUES.reviewClockSweep,
      pattern: M14_JOB_SCHEDULES.reviewClockSweep,
      params: M14_QUEUE_PARAMS.reviewClockSweep,
    },
    {
      queue: M14_QUEUES.scheduleMaterialise,
      pattern: M14_JOB_SCHEDULES.scheduleMaterialise,
      params: M14_QUEUE_PARAMS.scheduleMaterialise,
    },
    {
      queue: M14_QUEUES.packetsBuild,
      pattern: M14_JOB_SCHEDULES.packetsBuild,
      params: M14_QUEUE_PARAMS.packetsBuild,
    },
    {
      queue: M14_QUEUES.carryForward,
      pattern: M14_JOB_SCHEDULES.carryForward,
      params: M14_QUEUE_PARAMS.carryForward,
    },
  ];
  const queues: Queue[] = [];
  for (const spec of specs) {
    const queue = new Queue(spec.queue, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: spec.pattern },
        priority: spec.params.priority,
        attempts: spec.params.attempts,
        backoff: parseBackoff(spec.params.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
