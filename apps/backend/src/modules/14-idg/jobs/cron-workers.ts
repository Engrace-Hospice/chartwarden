// apps/backend/src/modules/14-idg/jobs/cron-workers.ts — GAP-092: the LIVE BullMQ Worker + repeatable
// Queue construction for M14's `idg.review-clock-sweep` (the M9/M10/M25 `jobs/cron-workers.ts` template).
// One cron fans out over the active orgs, opens ONE per-org `withOrgContext` tx per tick, reads via
// `./cron-store`, runs the PURE `planReviewClockSweep` (`./index`), and publishes every escalation to the
// TRANSACTIONAL OUTBOX inside that SAME tx (a thrown outbox validation error rolls back the whole org's
// tick — a partial escalation burst never partially commits).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { IdgWriteOutboxPort } from "../idg-route-service-db";
import { reviewClockPatientsForOrg } from "./cron-store";
import { M14_JOB_SCHEDULES, M14_QUEUES, M14_QUEUE_PARAMS, planReviewClockSweep } from "./index";

/** The system actor id the cron stamps on its per-org `withOrgContext` tx (audit attribution). Grepped the
 * repo for every `00000000-0000-0000-0000-0000000000xx` constant first: M7 uses `...07`, M9 uses `...09`,
 * M25 uses `...e5`, M26 uses `...e6` — `...14` (M14's own module number) is unused. */
const M14_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000014";

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. `outbox` is REQUIRED; `activeOrgs` defaults fail-closed
 * (the M9/M10 convention — only `activeOrgs` gets the lazy fail-closed thunk). */
export interface M14WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: IdgWriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
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

/** Build the {@link M14WorkerDeps} from the composition-root primitives (the M25/M9 `buildMxWorkerDeps` shape). */
export function buildM14WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: IdgWriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
}): M14WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

/** `idg.review-clock-sweep` (§4.8 daily / M14-F01 / ADR-0018 D2, GAP-092) — escalate every patient at
 * T-3/T-0/T+1 of their per-patient 15-day review floor. */
export async function runReviewClockSweepCron(deps: M14WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M14_WORKER_SYSTEM_USER_ID },
      async (tx) => {
        const t = tx as unknown as DbClient;
        const patients = await reviewClockPatientsForOrg(t, organizationId);
        const escalations = planReviewClockSweep(patients, now);
        for (const e of escalations) {
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
            },
            organizationId,
            aggregateKind: "idg_patient_packet",
            aggregateId: e.patientId,
          });
        }
      },
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

/** Construct the `idg.review-clock-sweep` cron `Worker` (the caller owns lifecycle — `close()` on shutdown). */
export function registerM14CronWorkers(deps: M14WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M14_QUEUES.reviewClockSweep, async () => runReviewClockSweepCron(deps), {
      connection,
      concurrency: M14_QUEUE_PARAMS.reviewClockSweep.concurrency,
    }),
  ];
}

/** Register the §4.8 repeatable cron schedule, threading the parsed backoff + `attempts` from
 * `M14_QUEUE_PARAMS`. `removeOnFail: false` keeps the queue's own failed-jobs set as the de facto DLQ (the
 * M9/M10/M25 convention — no separate literal `Queue` for `M14_DLQ`). Returns the `Queue` to `close()`. */
export async function scheduleM14Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M14_QUEUES.reviewClockSweep, { connection });
  const p = M14_QUEUE_PARAMS.reviewClockSweep;
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M14_JOB_SCHEDULES.reviewClockSweep },
      priority: p.priority,
      attempts: p.attempts,
      backoff: parseBackoff(p.backoff),
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return [queue];
}
