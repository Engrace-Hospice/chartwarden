// apps/backend/src/modules/09-assessments/jobs/cron-workers.ts — TASK-040D: the LIVE BullMQ Worker +
// repeatable Queue construction for M9's §4.8 `license`/`changes`/`cadence` compliance scans (the M25
// `25-remittance/jobs/cron-workers.ts` template, restated in shape identical to the M7
// `07-care-plan/jobs/cron-workers.ts` precedent — same TASK-040D batch). Three crons fan out over the
// active orgs, open ONE per-org `withOrgContext` tx each tick, read via `./cron-store`, run the PURE
// scans already shipped in `./index` (`planLicenseStatusScan` / `planChangeEscalation` /
// `planReassessmentDueScan`), and — for `license`/`changes` — publish every planned event to the
// TRANSACTIONAL OUTBOX and persist the write-back, all inside the SAME tx (a thrown outbox validation
// error rolls back the whole org's tick). `summary`/`eraser` (`M9_QUEUES`) are OUT OF SCOPE — event-
// driven / M4-destruction-cert consumers, wired inert per the M9-T06 header note; this file touches only
// `license`, `changes`, `cadence`.
//
// Unlike M25's `alerts`/`activeOrgs` (both lazy fail-closed until bound), `outbox` here is NOT optional —
// the composition root constructs it unconditionally whenever a DB client exists, so by the time a cron
// tick runs it is guaranteed bound. Only `activeOrgs` gets the lazy fail-closed thunk (`unbound()`,
// `M9_WORKER_PORT_UNBOUND: <port> — <hint>`, the M25/M7 convention).
import { type DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  escalateSignificantChange,
  latestAssessmentsPerPatientScaleForOrg,
  openSignificantChangesForOrg,
  scaleLicensesForOrg,
  updateLicenseStatus,
} from "./cron-store";
import {
  M9_JOB_SCHEDULES,
  type M9QueueName,
  M9_QUEUE_PARAMS,
  M9_QUEUES,
  planChangeEscalation,
  planLicenseStatusScan,
  planReassessmentDueScan,
} from "./index";

/**
 * The system actor id the crons stamp on their per-org `withOrgContext` tx (audit attribution). Grepped
 * the repo for every `00000000-0000-0000-0000-0000000000xx` constant first: M7 uses `...07`, M25 uses
 * `...e5`, M26 uses `...e6` — `...09` (M9's own module number) is unused.
 */
const M9_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000009";

/**
 * The transactional-outbox publish port the composition root binds (the `AssessmentWriteOutboxPort`
 * shape from `../assessments-route-service-db.ts` / `apps/backend/src/bootstrap/outbox-persister.ts`,
 * restated locally with a concrete `tx: DbClient` so this module takes no bootstrap import edge — the M7
 * `CarePlanOutboxPublishPort` precedent). `tx` is the SAME handle the caller's `withOrgContext` callback
 * hands in — the publish and the write-back below run in that one tx, atomically.
 */
export interface AssessmentOutboxPublishPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. `outbox` is REQUIRED; `activeOrgs` defaults fail-closed. */
export interface M9WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: AssessmentOutboxPublishPort;
  readonly activeOrgs?: ActiveOrgListPort;
  now?: () => Date;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M9_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M9WorkerDeps): ActiveOrgListPort {
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

/** Build the {@link M9WorkerDeps} from the composition-root primitives (the M25/M7 `buildMxWorkerDeps` shape). */
export function buildM9WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: AssessmentOutboxPublishPort;
  activeOrgs?: ActiveOrgListPort;
}): M9WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

/** `YYYY-MM-DD` org-tz calendar date the license scan's date math runs over (mirrors
 * `assessments-route-service-db.ts`'s local `today()`). */
function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ── the per-org cron runners (fan out over active orgs, RLS-scoped, outbox-publishing) ─────────────────

/**
 * `license-status-scan` (§4.8 daily) — recompute every org's `scale_license` statuses and persist +
 * publish every changed transition.
 *
 * AGGREGATE-ID NOTE: `LicenseScanPlan.events` carries no `scaleLicenseId` (only `scaleType` +
 * `expiresAt`/`expiredAt`), and its positional correspondence to `transitions` is NOT a contract worth
 * trusting (only `changed` transitions landing on `pending_renewal`/`expired` emit an event — a `changed`
 * transition back to `active` does not, which is exactly the kind of silent index-drift bug a positional
 * zip invites). Instead this loop walks `plan.transitions` directly — every transition already carries
 * its own `scaleLicenseId` — and looks up `expiresAt` from the INPUT `licenses` snapshot list (read
 * moments earlier, in the same tx) rather than from the output events at all. Every `changed` transition
 * gets its status persisted regardless of whether it also emits an event.
 */
export async function runLicenseStatusCron(deps: M9WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M9_WORKER_SYSTEM_USER_ID }, async (tx) => {
      const t = tx as unknown as DbClient;
      const licenses = await scaleLicensesForOrg(t, organizationId);
      const expiresAtById = new Map(licenses.map((l) => [l.scaleLicenseId, l.expiresAt]));
      const plan = planLicenseStatusScan(licenses, today(now));
      for (const transition of plan.transitions) {
        if (!transition.changed) continue;
        await updateLicenseStatus(t, transition.scaleLicenseId, transition.toStatus);
        const expiresAt = expiresAtById.get(transition.scaleLicenseId);
        if (expiresAt === undefined) continue;
        if (transition.toStatus === "pending_renewal") {
          await deps.outbox.publish(t, {
            eventName: "m9.scale.license_pending_renewal",
            payload: { scaleType: transition.scaleType, expiresAt },
            organizationId,
            aggregateKind: "scale_license",
            aggregateId: transition.scaleLicenseId,
          });
        } else if (transition.toStatus === "expired") {
          await deps.outbox.publish(t, {
            eventName: "m9.scale.license_lapsed",
            payload: { scaleType: transition.scaleType, expiredAt: expiresAt },
            organizationId,
            aggregateKind: "scale_license",
            aggregateId: transition.scaleLicenseId,
          });
        }
      }
    });
  }
}

/**
 * `change-escalation` (§4.8 hourly) — flip every CRITICAL `open` significant-change event past the 24h
 * no-ack mark to `escalated`, persist, and publish. Here `eventId` IS in `PlannedAssessmentEvent.payload`
 * (no correspondence problem), so the events publish straight through.
 */
export async function runChangeEscalationCron(deps: M9WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M9_WORKER_SYSTEM_USER_ID }, async (tx) => {
      const t = tx as unknown as DbClient;
      const changes = await openSignificantChangesForOrg(t, organizationId);
      const plan = planChangeEscalation(changes, now);
      for (const escalation of plan.escalations) {
        await escalateSignificantChange(t, escalation.eventId, new Date(escalation.escalatedAt));
      }
      for (const event of plan.events) {
        await deps.outbox.publish(t, {
          eventName: event.eventName,
          payload: event.payload,
          organizationId,
          aggregateKind: "significant_change_event",
          aggregateId: String(event.payload.eventId),
        });
      }
    });
  }
}

/**
 * `reassessment-due-scan` (§4.8 daily) — flag (patient, scale) past its reassessment cadence. Per the
 * pure function's own header comment, the runner is meant to "refresh the chart-banner cache" — but no
 * such cache-write seam exists anywhere in this codebase yet (confirmed by prior research), and building
 * new cache infrastructure is out of this task's scope. So this cron does the scan and structured-logs
 * the overdue count only: it still runs on schedule and is observable via logs, without inventing a new
 * persistence layer the rest of the app doesn't read from yet.
 */
export async function runReassessmentDueCron(deps: M9WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M9_WORKER_SYSTEM_USER_ID }, async (tx) => {
      const t = tx as unknown as DbClient;
      const latest = await latestAssessmentsPerPatientScaleForOrg(t, organizationId);
      const flags = planReassessmentDueScan(latest, now);
      const overdueCount = flags.filter((f) => f.overdue).length;
      // No chart-banner cache seam exists yet (see this function's header) — log-only, on purpose.
      console.log(
        `M9 cadence scan: organizationId=${organizationId} evaluated=${flags.length} overdue=${overdueCount}`,
      );
    });
  }
}

// ── backoff-string parsing (M9_QUEUE_PARAMS.backoff is a STRING, not BullMQ's {type,delay} shape) ─────

interface ParsedBackoff {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

function parseDurationMs(token: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(token);
  if (!m) throw new Error(`M9_BACKOFF_PARSE: unrecognized duration token '${token}'`);
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
      throw new Error(`M9_BACKOFF_PARSE: unreachable unit '${unit}'`);
  }
}

/**
 * Parse `M9_QUEUE_PARAMS[*].backoff` — a STRING like `"exponential 60s"` or `"exponential 30s, max 5m"` —
 * into the `{type, delay}` shape BullMQ's `queue.add()` options need. BullMQ has no native "max delay
 * cap" at add-time in the basic backoff form, so a `", max ..."` qualifier is parsed and DROPPED — only
 * the base delay is threaded. (A custom backoff-strategy function was the alternative; not warranted for
 * M9's three light cron queues, so documenting the deviation here instead.)
 */
export function parseBackoff(spec: string): ParsedBackoff {
  const head = spec.split(",")[0] ?? spec;
  const [type, duration] = head.trim().split(/\s+/);
  if (type !== "exponential" && type !== "fixed") {
    throw new Error(`M9_BACKOFF_PARSE: unrecognized backoff type '${type}' in '${spec}'`);
  }
  if (!duration) throw new Error(`M9_BACKOFF_PARSE: missing duration in '${spec}'`);
  return { type, delay: parseDurationMs(duration) };
}

// ── BullMQ construction (the M25 registerM25CronWorkers / scheduleM25Jobs template) ────────────────────

/** Construct the three §4.8 cron `Worker`s (the caller owns lifecycle — `close()` on shutdown). */
export function registerM9CronWorkers(deps: M9WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M9_QUEUES.license, async () => runLicenseStatusCron(deps), {
      connection,
      concurrency: M9_QUEUE_PARAMS.license.concurrency,
    }),
    new Worker(M9_QUEUES.changes, async () => runChangeEscalationCron(deps), {
      connection,
      concurrency: M9_QUEUE_PARAMS.changes.concurrency,
    }),
    new Worker(M9_QUEUES.cadence, async () => runReassessmentDueCron(deps), {
      connection,
      concurrency: M9_QUEUE_PARAMS.cadence.concurrency,
    }),
  ];
}

/**
 * Register the §4.8 repeatable cron schedules on their dedicated queues, threading the parsed
 * backoff + `attempts` from `M9_QUEUE_PARAMS`. `removeOnFail: false` keeps a queue's own failed-jobs set
 * as the de facto DLQ (no `M9_DLQ` entries are constructed as separate literal `Queue`s — no existing
 * module does that; DLQ-promotion alerting attaches externally to the `Worker`s `registerM9CronWorkers`
 * returns, outside this file's scope). Returns the `Queue`s to `close()`.
 */
export async function scheduleM9Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [M9QueueName, string, (typeof M9_QUEUE_PARAMS)[keyof typeof M9_QUEUE_PARAMS]][] = [
    [M9_QUEUES.license, M9_JOB_SCHEDULES.license, M9_QUEUE_PARAMS.license],
    [M9_QUEUES.changes, M9_JOB_SCHEDULES.changes, M9_QUEUE_PARAMS.changes],
    [M9_QUEUES.cadence, M9_JOB_SCHEDULES.cadence, M9_QUEUE_PARAMS.cadence],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern, p] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern },
        priority: p.priority,
        attempts: p.attempts,
        backoff: parseBackoff(p.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
