// apps/backend/src/modules/25-remittance/jobs/cron-workers.ts — the M25 §4.8 BullMQ cron worker
// construction (the M27 m27-jobs.ts template). Two nightly crons fan out over the active orgs, open the
// per-org `withOrgContext` RLS envelope, run the PURE handlers (runDenialAging / runAppealDeadlineWatch from
// ./m25-jobs), and dispatch the §4.9 M36 alerts. The cross-module/platform ports (the M2 active-org
// enumerator, the M36 alert router, the transactional outbox) carry a LAZY fail-closed thunk default until
// the integrator binds them — so constructing the workers at boot stays green; a port only throws WHEN A
// CRON TICK RUNS (never at import). Nothing here runs at import (constructing a Worker opens Valkey).
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { type AuditNoDeadlineStore, runAuditNoDeadlineWatch } from "./audit-no-deadline-watch";
import {
  type AdrDeadlineStore,
  type AppealDeadlineStore,
  type DenialAgingStore,
  runAdrDeadlineWatch,
  runAppealDeadlineWatch,
  runDenialAging,
} from "./m25-jobs";
import { type QicOverdueStore, runQicOverdueWatch } from "./qic-overdue";
import {
  type M25CronQueueName,
  M25_CRON_QUEUES,
  M25_JOB_SCHEDULES,
  M25_QUEUE_PARAMS,
} from "./queues";
import {
  type RecordedDeadlineWatchStore,
  runRecordedDeadlineWatch,
} from "./recorded-deadline-watch";
import { type SubmissionProofStore, runSubmissionProofWatch } from "./submission-proof-watch";

/** The §4.9 M36 typed-alert dispatcher (alerts ship as defs + fire through M36). */
export interface WorkerAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. The platform ports default to a fail-closed thunk until bound. */
export interface M25WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  now?: () => Date;
  readonly alerts?: WorkerAlertPort;
  readonly activeOrgs?: ActiveOrgListPort;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M25_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M25WorkerDeps): ActiveOrgListPort {
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

function alertsOf(deps: M25WorkerDeps): WorkerAlertPort {
  return (
    deps.alerts ?? {
      dispatch: () =>
        unbound("alerts.dispatch", "bind the M36 alert router (the §4.9 typed-alert sink)"),
    }
  );
}

/** Build the {@link M25WorkerDeps} from the composition-root primitives (the M27 buildM27WorkerDeps shape). */
export function buildM25WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  alerts?: WorkerAlertPort;
  activeOrgs?: ActiveOrgListPort;
}): M25WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    alerts: deps.alerts,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

// ── the per-org cron runners (fan out over active orgs, RLS-scoped, alert-dispatching) ────────────────────

/** Nightly: rebucket every open denial's aging + dispatch the 30/90-day threshold alerts (§2.4). */
export async function runDenialAgingCron(deps: M25WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const alerts = alertsOf(deps);
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const DC = schema.denialCase;
      const store: DenialAgingStore = {
        async openCases() {
          const rows = await tx
            .select({
              id: DC.id,
              openedAt: DC.openedAt,
              currentBucketDays: DC.agingBucketDays,
              state: DC.state,
            })
            .from(DC)
            .where(sql`${DC.state} IN ('open','in_progress','escalated')`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : String(r.openedAt),
            currentBucketDays: r.currentBucketDays,
            state: r.state,
          }));
        },
        async setAgingBucketDays(denialCaseId, days) {
          await tx.update(DC).set({ agingBucketDays: days }).where(eq(DC.id, denialCaseId));
        },
      };
      const result = await runDenialAging(store, now);
      for (const a of result.alerts) {
        await alerts.dispatch({
          alertCode: a.kind,
          severity: a.kind === "denial.high_value" ? "critical" : "warn",
          organizationId,
          payload: a.detail,
        });
      }
    });
  }
}

/** Nightly: emit the T-30/14/7/1 appeal- and ADR-deadline alerts at each case's tightest boundary (§2.4 / D6). */
export async function runAppealDeadlineCron(deps: M25WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const alerts = alertsOf(deps);
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const AC = schema.appealCase;
      const store: AppealDeadlineStore = {
        async watchableAppeals() {
          const rows = await tx
            .select({ id: AC.id, tierDeadlineAt: AC.tierDeadlineAt, state: AC.state })
            .from(AC)
            .where(sql`${AC.state} IN ('draft','submitted','under_review')`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            tierDeadlineAt:
              r.tierDeadlineAt instanceof Date
                ? r.tierDeadlineAt.toISOString()
                : String(r.tierDeadlineAt),
            state: r.state,
          }));
        },
      };
      const ADR = schema.adrCase;
      const adrStore: AdrDeadlineStore = {
        async watchableAdrs() {
          const rows = await tx
            .select({ id: ADR.id, responseDueAt: ADR.responseDueAt })
            .from(ADR)
            .where(sql`${ADR.state} IN ('received','in_assembly','in_review')`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            responseDueAt:
              r.responseDueAt instanceof Date
                ? r.responseDueAt.toISOString()
                : String(r.responseDueAt),
          }));
        },
      };
      // Milestone 4: a QIC reconsideration past its recorded decision date with no escalation requested.
      const qicStore: QicOverdueStore = {
        async overdueCandidates() {
          const rows = await tx
            .select({
              id: AC.id,
              receivedOn: AC.qicReceivedOn,
              extensions: AC.qicClockExtensions,
              escalationRequestedAt: AC.escalationRequestedAt,
            })
            .from(AC)
            .where(
              sql`${AC.tier} = 'reconsideration' AND ${AC.state} = 'under_review' AND ${AC.qicReceivedOn} IS NOT NULL`,
            )
            .limit(100000);
          return rows.flatMap((r) =>
            r.receivedOn === null
              ? []
              : [
                  {
                    id: r.id,
                    receivedOn: r.receivedOn,
                    extensions: Array.isArray(r.extensions)
                      ? (r.extensions as { days: number; recordedAt: string }[])
                      : [],
                    escalationRequested: r.escalationRequestedAt !== null,
                  },
                ],
          );
        },
      };
      // Milestone 6a: a filing whose receipt was never recorded (attempt still needs_manual) past the threshold.
      const SA = schema.submissionAttempt;
      const proofStore: SubmissionProofStore = {
        async needsManualAttempts() {
          const rows = await tx
            .select({
              id: SA.id,
              adrCaseId: SA.adrCaseId,
              appealCaseId: SA.appealCaseId,
              reopeningCaseId: SA.reopeningCaseId,
              createdAt: SA.createdAt,
              adrState: schema.adrCase.state,
              appealState: AC.state,
              reopeningState: schema.reopeningCase.state,
            })
            .from(SA)
            .leftJoin(schema.adrCase, eq(schema.adrCase.id, SA.adrCaseId))
            .leftJoin(AC, eq(AC.id, SA.appealCaseId))
            .leftJoin(schema.reopeningCase, eq(schema.reopeningCase.id, SA.reopeningCaseId))
            .where(sql`${SA.status} = 'needs_manual' AND ${SA.auditRequestId} IS NULL`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            subjectKind: r.adrCaseId
              ? ("adr" as const)
              : r.reopeningCaseId
                ? ("reopening" as const)
                : ("appeal" as const),
            subjectId: r.adrCaseId ?? r.reopeningCaseId ?? r.appealCaseId ?? "",
            subjectState: r.adrState ?? r.reopeningState ?? r.appealState ?? "",
            createdAt: r.createdAt.toISOString(),
          }));
        },
      };
      const result = {
        alerts: [
          ...(await runAppealDeadlineWatch(store, now)).alerts,
          ...(await runAdrDeadlineWatch(adrStore, now)).alerts,
          ...(await runQicOverdueWatch(qicStore, now)).alerts,
          ...(await runSubmissionProofWatch(proofStore, now)).alerts,
        ],
      };
      for (const a of result.alerts) {
        await alerts.dispatch({
          alertCode: a.kind,
          severity: "warn",
          organizationId,
          payload: a.detail,
        });
      }

      // Milestone 7a-1: deadlines typed from a notice alert once per boundary; an open audit request with no
      // recorded due date alerts once. The boundary / alert time is written AFTER the alerts are dispatched, in the
      // same org transaction: a dispatch that throws rolls the transaction back, so nothing is marked and the next
      // tick retries. The alert sink is outside this transaction, so a COMMIT that fails after a successful dispatch
      // can repeat an alert (at-least-once; the M36 router de-duplicates). The mark update is compare-and-set on the
      // boundary that was read, so only one of two overlapping ticks can move the mark. DISPATCH PRECEDES that
      // compare-and-set, though: two overlapping ticks that read the same boundary can BOTH dispatch the alert. Delivery
      // is at-least-once and relies on the M36 router to de-duplicate; only the mark is single-winner.
      // A deadline of a finished subject (a closed / withdrawn appeal or audit request) never alerts.
      const RD = schema.recordedDeadline;
      const readBoundary = new Map<string, number | null>();
      const deadlineStore: RecordedDeadlineWatchStore = {
        async openDeadlines() {
          const rows = await tx
            .select()
            .from(RD)
            .where(
              sql`${RD.satisfiedOn} IS NULL
                AND (${RD.appealCaseId} IS NULL OR EXISTS (SELECT 1 FROM appeal_case a WHERE a.id = ${RD.appealCaseId} AND a.state::text NOT IN ('closed','withdrawn')))
                AND (${RD.auditRequestId} IS NULL OR EXISTS (SELECT 1 FROM audit_request r WHERE r.id = ${RD.auditRequestId} AND r.state NOT IN ('closed','withdrawn')))`,
            )
            .limit(100000);
          for (const r of rows) readBoundary.set(r.id, r.lastAlertedBoundary);
          return rows.map((r) => ({
            id: r.id,
            subjectKind: r.appealCaseId ? ("appeal" as const) : ("audit_request" as const),
            subjectId: (r.appealCaseId ?? r.auditRequestId) as string,
            dueOn: r.dueOn,
            zone: r.zone,
            satisfiedOn: r.satisfiedOn,
            lastAlertedBoundary: r.lastAlertedBoundary,
          }));
        },
      };
      const recorded = await runRecordedDeadlineWatch(deadlineStore, now);
      for (const a of recorded.alerts) {
        await alerts.dispatch({
          alertCode: a.kind,
          severity: "warn",
          organizationId,
          payload: a.detail,
        });
      }
      for (const m of recorded.marks) {
        await tx
          .update(RD)
          .set({ lastAlertedBoundary: m.boundary })
          .where(
            and(
              eq(RD.id, m.id),
              sql`${RD.lastAlertedBoundary} IS NOT DISTINCT FROM ${readBoundary.get(m.id) ?? null}`,
            ),
          );
      }
      const AR = schema.auditRequest;
      const auditStore: AuditNoDeadlineStore = {
        async openAudits() {
          const rows = await tx
            .select({
              id: AR.id,
              state: AR.state,
              createdAt: AR.createdAt,
              alerted: AR.noDeadlineAlertedAt,
              noneStated: AR.deadlineNoneStatedAt,
              openDeadlines: sql<number>`(SELECT count(*)::int FROM recorded_deadline d WHERE d.audit_request_id = ${AR.id} AND d.satisfied_on IS NULL)`,
            })
            .from(AR)
            .where(sql`${AR.state} NOT IN ('withdrawn','closed')`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            state: r.state,
            createdAt: r.createdAt.toISOString(),
            hasDeadline: r.openDeadlines > 0,
            alreadyAlerted: r.alerted !== null,
            noneStatedAttested: r.noneStated !== null,
          }));
        },
      };
      const noDeadline = await runAuditNoDeadlineWatch(auditStore, now);
      for (const a of noDeadline.alerts) {
        await alerts.dispatch({
          alertCode: a.kind,
          severity: "warn",
          organizationId,
          payload: a.detail,
        });
      }
      for (const id of noDeadline.alertedIds) {
        await tx.update(AR).set({ noDeadlineAlertedAt: now }).where(eq(AR.id, id));
      }
    });
  }
}

// ── BullMQ construction (the M27 registerM27CronWorkers / scheduleM27Jobs template) ───────────────────────

/** Construct one BullMQ `Worker` per §4.8 cron queue. The caller owns lifecycle (`close()` on shutdown). */
export function registerM25CronWorkers(deps: M25WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M25_CRON_QUEUES.denialAgingScan, async () => runDenialAgingCron(deps), {
      connection,
      concurrency: M25_QUEUE_PARAMS.denialAgingScan.concurrency,
    }),
    new Worker(M25_CRON_QUEUES.appealDeadlineScan, async () => runAppealDeadlineCron(deps), {
      connection,
      concurrency: M25_QUEUE_PARAMS.appealDeadlineScan.concurrency,
    }),
  ];
}

/** Register the §4.8 repeatable cron schedules on their dedicated queues. Returns the `Queue`s to `close()`. */
export async function scheduleM25Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [M25CronQueueName, string][] = [
    [M25_CRON_QUEUES.denialAgingScan, M25_JOB_SCHEDULES.denialAgingScan],
    [M25_CRON_QUEUES.appealDeadlineScan, M25_JOB_SCHEDULES.appealDeadlineScan],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}
