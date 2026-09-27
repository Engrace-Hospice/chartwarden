// apps/backend/src/modules/06-admission/jobs/cron-workers.ts
//
// Live BullMQ runtime for M6 scheduled compliance reminders.
// Pattern follows M9:
// active-org fan-out -> withOrgContext -> read -> pure planner ->
// transactional outbox publish.

import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";

import { ctiSignatureDueRowsForOrg, f2fDueRowsForOrg } from "./cron-store";
import {
  M6_JOB_SCHEDULES,
  M6_QUEUES,
  planDueReminder,
  planCtiSignatureReminder,
} from "./index";

const M6_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000006";

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
        unbound(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator",
        ),
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
    await withOrgContext(
      deps.db,
      {
        organizationId,
        userId: M6_WORKER_SYSTEM_USER_ID,
      },
      async (tx) => {
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
      },
    );
  }
}

export async function runCtiSignatureNotifyCron(
  deps: M6WorkerDeps,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      {
        organizationId,
        userId: M6_WORKER_SYSTEM_USER_ID,
      },
      async (tx) => {
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
      },
    );
  }
}

/**
 * Construct the currently-live M6 cron workers.
 *
 * We only register f2fDueNotify here for now.
 * CTI signature scanning will be added immediately after
 * this path is wired and verified.
 */
export function registerM6CronWorkers(deps: M6WorkerDeps): Worker[] {
  return [
    new Worker(M6_QUEUES.f2fDueNotify, async () => runF2fDueNotifyCron(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),

    new Worker(
      M6_QUEUES.ctiSignatureNotify,
      async () => runCtiSignatureNotifyCron(deps),
      {
        connection: deps.connection,
        concurrency: 1,
      },
    ),
  ];
}

/**
 * Register the repeatable F2F due-reminder schedule.
 */
export async function scheduleM6Jobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const schedules = [
    {
      name: M6_QUEUES.f2fDueNotify,
      pattern: M6_JOB_SCHEDULES.f2fDueNotify,
    },
    {
      name: M6_QUEUES.ctiSignatureNotify,
      pattern: M6_JOB_SCHEDULES.ctiSignatureNotify,
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
