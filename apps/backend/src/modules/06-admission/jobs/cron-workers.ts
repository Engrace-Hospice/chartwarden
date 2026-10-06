// apps/backend/src/modules/06-admission/jobs/cron-workers.ts
//
// Live BullMQ runtime for M6 scheduled compliance reminders.
// Pattern follows M9:
// active-org fan-out -> withOrgContext -> read -> pure planner ->
// transactional outbox publish.

import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";

import { completeActiveElectionPeriod } from "../election-period-completion";
import {
  activePeriodsPastEndForOrg,
  ctiSignatureDueRowsForOrg,
  f2fDueRowsForOrg,
  f2fWindowMissedCandidatesForOrg,
} from "./cron-store";
import {
  M6_JOB_SCHEDULES,
  M6_QUEUES,
  planCtiSignatureReminder,
  planDueReminder,
  planF2fWindowMissedScan,
} from "./index";

const CW = schema.complianceWindows;

export interface AdmissionOutboxPublishPort {
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

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<
    readonly {
      readonly organizationId: string;
    }[]
  >;
}

export interface M6WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: AdmissionOutboxPublishPort;
  readonly activeOrgs?: ActiveOrgListPort;

  now?: () => Date;
}

function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M6_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M6WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unbound("activeOrgs.listActiveOrgs", "bind the M2 active-org enumerator"),
    }
  );
}

export function buildM6WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: AdmissionOutboxPublishPort;
  activeOrgs?: ActiveOrgListPort;
}): M6WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

function calendarDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Daily F2F due-reminder scan.
 *
 * Emits:
 * - 7 days before scheduled date -> m6.f2f.due_7d
 * - 3 days before scheduled date -> m6.f2f.due_3d
 * - 1 day after scheduled date  -> m6.f2f.overdue_1d
 *
 * An attested F2F emits nothing.
 */
export async function runF2fDueNotifyCron(deps: M6WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const today = calendarDate(now);

  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const t = tx as unknown as DbClient;

      const rows = await f2fDueRowsForOrg(t, organizationId);

      for (const row of rows) {
        const reminder = planDueReminder(
          {
            resourceId: row.f2fId,
            dueDate: row.scheduledDate,

            // "completed" = encounter performed but still
            // waiting for attestation.
            completed: row.status === "attested",
          },
          today,
        );

        if (!reminder) continue;

        const eventName =
          reminder.tier === "due_7d"
            ? "m6.f2f.due_7d"
            : reminder.tier === "due_3d"
              ? "m6.f2f.due_3d"
              : "m6.f2f.overdue_1d";

        await deps.outbox.publish(t, {
          eventName,
          payload: {
            f2fId: row.f2fId,
            electionPeriodId: row.electionPeriodId,
            dueAt: row.scheduledDate,
          },
          organizationId,
          aggregateKind: "face_to_face_encounter",
          aggregateId: row.f2fId,
        });
      }
    });
  }
}

export async function runCtiSignatureNotifyCron(deps: M6WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const t = tx as unknown as DbClient;

      const rows = await ctiSignatureDueRowsForOrg(t, organizationId);

      for (const row of rows) {
        const reminder = planCtiSignatureReminder(
          {
            ctiId: row.ctiId,
            requestedAt: row.signatureRequestedAt,
            dueAt: row.signatureDueAt,
            signedAt: row.hospiceMdSignedAt,
          },
          now,
        );

        if (!reminder) continue;

        if (reminder === "due_1d") {
          await deps.outbox.publish(t, {
            eventName: "m6.cti.signature_due_1d",
            payload: {
              ctiId: row.ctiId,
              hospiceMdId: row.hospiceMdId,
              dueAt: row.signatureDueAt,
            },
            organizationId,
            aggregateKind: "certification_of_terminal_illness",
            aggregateId: row.ctiId,
          });
        }

        if (reminder === "overdue") {
          await deps.outbox.publish(t, {
            eventName: "m6.cti.signature_overdue",
            payload: {
              ctiId: row.ctiId,
              hospiceMdId: row.hospiceMdId,
              dueAt: row.signatureDueAt,
            },
            organizationId,
            aggregateKind: "certification_of_terminal_illness",
            aggregateId: row.ctiId,
          });
        }
      }
    });
  }
}

/**
 * `admission.window_alert` (F2F half, F-178b/#248) — every 15 min, scan recert election periods whose
 * CMS 418.22 F2F "prior-to" window has newly lapsed unattested and emit `m6.f2f.window_missed` exactly
 * once per window. `M6_QUEUES.windowAlert` / `M6_JOB_SCHEDULES.windowAlert` were declared (§4.3) but had
 * no runner or schedule registration anywhere — this is the first work on that queue; the OTHER
 * compliance-window kinds `planWindowAlert`/`promoteWindowStatus` (./index) are still unwired (out of
 * scope here — those assume an already-open `compliance_window` row, which `f2f_recert_30d_prior` never
 * gets outside this scan; see ./index's own comment on `planF2fWindowMissedScan`).
 *
 * Idempotent: `f2fWindowMissedCandidatesForOrg` excludes a period once its compliance_window row is
 * open (opened here, in the same tx as the outbox publish); `attestF2f`'s existing `close_window`
 * effect (admission-route-service-db.ts) closes it on a later attestation.
 */
export async function runF2fWindowMissedScanCron(deps: M6WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      // The NULL (system) audit actor: this scan INSERTs an audited `compliance_window` row, and the M4
      // write-audit trigger copies `app.user_id` into `audit_event.actor_user_id` (FK to `user`), so a
      // synthetic "system user" uuid would 23503 (F-178b). Every M6 cron uses `systemOrgContext` now.
      systemOrgContext(organizationId),
      async (tx) => {
        const t = tx as unknown as DbClient;

        const orgTimeZone = await organizationTimezone(t, organizationId);
        const today = localDateInTimeZone(now, orgTimeZone);

        const candidates = await f2fWindowMissedCandidatesForOrg(t, organizationId);
        const planned = planF2fWindowMissedScan(candidates, today, orgTimeZone);

        for (const p of planned) {
          const [row] = await t
            .insert(CW)
            .values({
              organizationId,
              admissionId: p.admissionId,
              windowKind: "f2f_recert_30d_prior",
              severity: "alert",
              status: "overdue",
              startsAt: new Date(`${p.windowStart}T00:00:00.000Z`),
              mustCompleteBy: new Date(p.windowEndInstant),
              payload: { electionPeriodId: p.electionPeriodId },
            })
            .onConflictDoNothing()
            .returning({ id: CW.id });

          // `onConflictDoNothing` (the `cw_adm_kind_open_idx` partial unique) means a race with another
          // tick/replica loses the insert silently — only the tick that actually opened the row emits.
          if (!row) continue;

          await deps.outbox.publish(t, {
            eventName: "m6.f2f.window_missed",
            payload: {
              electionPeriodId: p.electionPeriodId,
            },
            organizationId,
            aggregateKind: "election_period",
            aggregateId: p.electionPeriodId,
          });
        }
      },
    );
  }
}

/**
 * Hourly benefit-period auto-end (GAP-025, spec §2.3.2 "period auto-ended at midnight on its endDate").
 * For each active org, completes every ACTIVE period whose last covered day is before the org's local
 * date and publishes `m6.election.period_ended` (M23's revalidate consumer re-checks the claims the
 * period covered). Idempotent: the status-guarded UPDATE in the shared helper means a replayed tick, or a
 * discharge racing the tick, emits at most one event per period.
 */
export async function runElectionPeriodAutoEndCron(deps: M6WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      // The NULL audit actor — this tick UPDATEs `election_period`, an audited table: a synthetic uuid
      // would 23503 on the audit trigger's `user` FK (see the F-178b note on the window-missed scan above).
      systemOrgContext(organizationId),
      async (tx) => {
        const t = tx as unknown as DbClient;
        const orgTimeZone = await organizationTimezone(t, organizationId);
        const today = localDateInTimeZone(now, orgTimeZone);
        const due = await activePeriodsPastEndForOrg(t, organizationId, today);
        for (const period of due) {
          await completeActiveElectionPeriod(
            t,
            { outbox: deps.outbox, now: () => now },
            {
              organizationId,
              period,
              cause: "next_period",
              endDate: period.scheduledEndAt,
            },
          );
        }
      },
    );
  }
}

/**
 * Construct the currently-live M6 cron workers.
 */
export function registerM6CronWorkers(deps: M6WorkerDeps): Worker[] {
  return [
    new Worker(M6_QUEUES.f2fDueNotify, async () => runF2fDueNotifyCron(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),

    new Worker(M6_QUEUES.ctiSignatureNotify, async () => runCtiSignatureNotifyCron(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),

    new Worker(M6_QUEUES.windowAlert, async () => runF2fWindowMissedScanCron(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),

    new Worker(M6_QUEUES.periodAutoEnd, async () => runElectionPeriodAutoEndCron(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/**
 * Register the repeatable F2F due-reminder / CTI-signature / window-alert schedules.
 */
export async function scheduleM6Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules = [
    {
      name: M6_QUEUES.f2fDueNotify,
      pattern: M6_JOB_SCHEDULES.f2fDueNotify,
    },
    {
      name: M6_QUEUES.ctiSignatureNotify,
      pattern: M6_JOB_SCHEDULES.ctiSignatureNotify,
    },
    {
      name: M6_QUEUES.windowAlert,
      pattern: M6_JOB_SCHEDULES.windowAlert,
    },
    {
      name: M6_QUEUES.periodAutoEnd,
      pattern: M6_JOB_SCHEDULES.periodAutoEnd,
    },
  ] as const;

  const queues: Queue[] = [];

  for (const schedule of schedules) {
    const queue = new Queue(schedule.name, {
      connection,
    });

    await queue.add(
      "scheduled",
      {},
      {
        repeat: {
          pattern: schedule.pattern,
        },
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 30_000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    queues.push(queue);
  }

  return queues;
}
