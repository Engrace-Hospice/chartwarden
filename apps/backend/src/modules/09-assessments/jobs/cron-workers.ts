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
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  closeReassessmentDue,
  escalateSignificantChange,
  insertReassessmentDue,
  latestAssessmentsPerPatientScaleForOrg,
  openSignificantChangesForOrg,
  reassessmentDueRowsForOrg,
  scaleCadencePoliciesForOrg,
  scaleLicensesForOrg,
  updateLicenseStatus,
  updateReassessmentDue,
  updateReassessmentDueDatesOnly,
} from "./cron-store";
import {
  type M9QueueName,
  M9_JOB_SCHEDULES,
  M9_QUEUES,
  M9_QUEUE_PARAMS,
  effectiveCadenceDays,
  planChangeEscalation,
  planLicenseStatusScan,
  planReassessmentDueScan,
} from "./index";

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

/**
 * M6's org-explicit, keyset-paginated active-admission read (`idgActiveAdmissionsForOrg`), bound at the
 * composition root as a structural port — M9's `dependsOn` has no M6 edge, so the cadence scan learns "who is
 * actively admitted" through this port rather than an import (the M14 `ActiveAdmissionPort` precedent).
 */
export interface ActiveAdmissionPort {
  activeAdmissionsForOrg(
    organizationId: string,
    afterAdmissionId: string | null,
    limit: number,
  ): Promise<readonly { readonly admissionId: string; readonly patientId: string }[]>;
}

/** Page size for the active-admission read (bounded memory per tick). */
const ACTIVE_ADMISSION_PAGE_SIZE = 500;

/** The dep bag the composition root injects. `outbox` is REQUIRED; `activeOrgs` defaults fail-closed. */
export interface M9WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: AssessmentOutboxPublishPort;
  readonly activeOrgs?: ActiveOrgListPort;
  /** The cadence scan's active-patient population (M6). Unbound => the scan fails closed, never guesses. */
  readonly activeAdmissions?: ActiveAdmissionPort;
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
  activeAdmissions?: ActiveAdmissionPort;
}): M9WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    activeAdmissions: deps.activeAdmissions,
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
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
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
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
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

/** Every patient on an ACTIVE admission in the org, paged through the injected M6 port (fail-closed if unbound). */
async function activePatientIdsOf(
  deps: M9WorkerDeps,
  organizationId: string,
): Promise<Set<string>> {
  const port = deps.activeAdmissions;
  if (!port) {
    return unbound(
      "activeAdmissions.activeAdmissionsForOrg",
      "bind M6 idgActiveAdmissionsForOrg at the composition root",
    );
  }
  const patients = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page = await port.activeAdmissionsForOrg(
      organizationId,
      after,
      ACTIVE_ADMISSION_PAGE_SIZE,
    );
    for (const a of page) patients.add(a.patientId);
    const last = page[page.length - 1];
    if (!last || page.length < ACTIVE_ADMISSION_PAGE_SIZE) return patients;
    after = last.admissionId;
  }
}

/**
 * `reassessment-due-scan` (§4.8 daily) — derive each ACTIVELY ADMITTED patient's next reassessment due date per
 * scale (CoP 418.54(d) 15-day floor, tightened — never loosened — by `scale_policy.reassessment_cadence_overrides`;
 * a disabled scale is skipped) and persist it in M9's own `assessment_reassessment_due` ledger, which the chart
 * banner reads. When a pair newly goes overdue it publishes `m9.assessment.reassessment_due` ONCE per overdue
 * episode (M36 surfaces the alert through its seam path; no cross-module write). A new capture moves `due_at`
 * forward, so the pair re-opens and the banner clears; rows for patients who left active care, or whose scale was
 * turned off, are closed. Everything for one org commits in ONE tx with the outbox rows (system actor; overdue is
 * a soft state and never blocks recording).
 */
export async function runReassessmentDueCron(deps: M9WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    const activePatients = await activePatientIdsOf(deps, organizationId);
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const t = tx as unknown as DbClient;
      const policies = await scaleCadencePoliciesForOrg(t, organizationId);
      const latest = (await latestAssessmentsPerPatientScaleForOrg(t, organizationId)).filter(
        (s) =>
          activePatients.has(s.patientId) &&
          s.providerEntityId !== undefined &&
          s.locationId !== undefined &&
          policies.get(s.scaleType)?.enabled !== false,
      );
      const flags = planReassessmentDueScan(latest, now, (scale) =>
        effectiveCadenceDays(scale, policies.get(scale)?.cadenceOverrides),
      );
      const snapshotByKey = new Map(latest.map((s) => [`${s.patientId}:${s.scaleType}`, s]));
      const existing = new Map(
        (await reassessmentDueRowsForOrg(t, organizationId)).map((r) => [
          `${r.patientId}:${r.scaleType}`,
          r,
        ]),
      );
      const seen = new Set<string>();
      for (const flag of flags) {
        const key = `${flag.patientId}:${flag.scaleType}`;
        const snap = snapshotByKey.get(key);
        if (!snap || snap.providerEntityId === undefined || snap.locationId === undefined) continue;
        seen.add(key);
        const prior = existing.get(key);
        // A NEW overdue episode: first sight, a re-open after close, or open -> overdue. A pair that stays
        // overdue is not re-announced (the alert already exists; M36 owns re-delivery).
        const newlyOverdue = flag.overdue && (!prior || prior.status !== "overdue");
        const common = {
          lastCapturedAt: new Date(snap.lastCapturedAt),
          cadenceDays: flag.cadenceDays,
          dueAt: new Date(flag.dueAt),
          status: flag.overdue ? ("overdue" as const) : ("open" as const),
        };
        const episode = newlyOverdue
          ? { overdueSince: now, alertedAt: now }
          : { overdueSince: null, alertedAt: null };
        let rowId: string;
        if (!prior) {
          rowId = await insertReassessmentDue(t, {
            organizationId,
            providerEntityId: snap.providerEntityId,
            locationId: snap.locationId,
            patientId: flag.patientId,
            scaleType: flag.scaleType,
            ...common,
            ...episode,
          });
        } else {
          rowId = prior.id;
          if (flag.overdue && !newlyOverdue) {
            // Still overdue: refresh the dates only; the episode markers on the row are untouched.
            await updateReassessmentDueDatesOnly(t, prior.id, common, now);
          } else {
            await updateReassessmentDue(t, prior.id, { ...common, ...episode }, now);
          }
        }
        if (newlyOverdue) {
          await deps.outbox.publish(t, {
            eventName: "m9.assessment.reassessment_due",
            payload: {
              patientId: flag.patientId,
              scaleType: flag.scaleType,
              dueAt: flag.dueAt,
              lastCapturedAt: snap.lastCapturedAt,
              cadenceDays: flag.cadenceDays,
            },
            organizationId,
            aggregateKind: "assessment_reassessment_due",
            aggregateId: rowId,
          });
        }
      }
      const stale = [...existing.entries()]
        .filter(([key, row]) => !seen.has(key) && row.status !== "closed")
        .map(([, row]) => row.id);
      await closeReassessmentDue(t, stale, now);
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
  const schedules: readonly [
    M9QueueName,
    string,
    (typeof M9_QUEUE_PARAMS)[keyof typeof M9_QUEUE_PARAMS],
  ][] = [
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
