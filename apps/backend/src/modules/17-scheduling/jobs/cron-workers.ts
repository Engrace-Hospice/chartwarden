import type { DbClient } from "@wardenx/db";
import type { AlertEmitter } from "@wardenx/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type SchedulingAutomationService,
  type SchedulingWriteOutboxPort,
  createDbSchedulingBackend,
} from "../scheduling-route-service-db";
import { M17_JOB_SCHEDULES, M17_QUEUES, M17_QUEUE_PARAMS } from "./index";

import { M17_SYSTEM_USER_ID as M17_WORKER_SYSTEM_USER_ID } from "../system-actor";

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M17WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: SchedulingWriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
  readonly alerts?: AlertEmitter;
  now?: () => Date;
}

function unbound<T>(port: string): Promise<T> {
  return Promise.reject(new Error(`M17_WORKER_PORT_UNBOUND: ${port}`));
}

function activeOrgsOf(deps: M17WorkerDeps): ActiveOrgListPort {
  return deps.activeOrgs ?? { listActiveOrgs: () => unbound("activeOrgs.listActiveOrgs") };
}

function alertEmitterOf(deps: M17WorkerDeps): AlertEmitter {
  return deps.alerts ?? { emit: async () => ({ alertId: "noop", resolvedRecipientCount: 0 }) };
}

export function buildM17WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: SchedulingWriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
  alerts?: AlertEmitter;
}): M17WorkerDeps {
  return { ...deps, now: () => new Date() };
}

export async function runRecurringMaterializationCron(deps: M17WorkerDeps): Promise<void> {
  const service = createDbSchedulingBackend(deps.db, deps.outbox) as SchedulingAutomationService;
  const now = (deps.now ?? (() => new Date()))();
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    await service.materializeRecurringVisitsForOrg(organizationId, M17_WORKER_SYSTEM_USER_ID, {
      now,
    });
  }
}

export async function runVisitAttentionCron(deps: M17WorkerDeps): Promise<void> {
  const service = createDbSchedulingBackend(deps.db, deps.outbox) as SchedulingAutomationService;
  const alerts = alertEmitterOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    const result = await service.scanVisitAttentionForOrg(
      organizationId,
      M17_WORKER_SYSTEM_USER_ID,
      {
        now,
      },
    );
    if (result.possibleMissedVisits > 0) {
      await alerts.emit(organizationId, {
        eventType: "visit.late",
        severity: "warn",
        correlationId: `m17:possible-missed:${organizationId}:${now.toISOString().slice(0, 13)}`,
        payload: {
          count: result.possibleMissedVisits,
          detectedAt: now.toISOString(),
          deepLink: "/scheduling/day",
          message: "Scheduled visits require attention.",
        },
      });
    }
  }
}

/**
 * Runs `perOrg` for every active org. One org's failure never stops the others; failures are collected and
 * rethrown together AFTER the full pass so BullMQ still retries the job.
 */
async function forEachActiveOrg(
  deps: M17WorkerDeps,
  label: string,
  perOrg: (organizationId: string) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    try {
      await perOrg(organizationId);
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${label} failed for ${failures.join("; ")}`);
}

/** §4.8 `m17.reassignment-scan` — flags published visits inside every approved PTO window. */
export async function runReassignmentScanCron(deps: M17WorkerDeps): Promise<void> {
  const service = createDbSchedulingBackend(deps.db, deps.outbox) as SchedulingAutomationService;
  const now = (deps.now ?? (() => new Date()))();
  await forEachActiveOrg(deps, "M17 reassignment-scan", async (organizationId) => {
    await service.scanTimeOffReassignmentsForOrg(organizationId, M17_WORKER_SYSTEM_USER_ID, {
      now,
    });
  });
}

/** §4.8 `m17.caregiver-reminder.cron` — `m17.caregiver_reminder_due` for opted-in visits ≤24h out. */
export async function runCaregiverReminderCron(deps: M17WorkerDeps): Promise<void> {
  const service = createDbSchedulingBackend(deps.db, deps.outbox) as SchedulingAutomationService;
  const now = (deps.now ?? (() => new Date()))();
  await forEachActiveOrg(deps, "M17 caregiver-reminder", async (organizationId) => {
    await service.emitCaregiverRemindersForOrg(organizationId, M17_WORKER_SYSTEM_USER_ID, { now });
  });
}

export function registerM17CronWorkers(deps: M17WorkerDeps): Worker[] {
  return [
    new Worker(M17_QUEUES.recurringMaterialize, async () => runRecurringMaterializationCron(deps), {
      connection: deps.connection,
      concurrency: M17_QUEUE_PARAMS.recurringMaterialize.concurrency,
    }),
    new Worker(M17_QUEUES.visitAttention, async () => runVisitAttentionCron(deps), {
      connection: deps.connection,
      concurrency: M17_QUEUE_PARAMS.visitAttention.concurrency,
    }),
    new Worker(M17_QUEUES.reassignmentScan, async () => runReassignmentScanCron(deps), {
      connection: deps.connection,
      concurrency: M17_QUEUE_PARAMS.reassignmentScan.concurrency,
    }),
    new Worker(M17_QUEUES.caregiverReminder, async () => runCaregiverReminderCron(deps), {
      connection: deps.connection,
      concurrency: M17_QUEUE_PARAMS.caregiverReminder.concurrency,
    }),
  ];
}

export async function scheduleM17Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const recurring = new Queue(M17_QUEUES.recurringMaterialize, { connection });
  await recurring.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M17_JOB_SCHEDULES.recurringMaterialize },
      priority: M17_QUEUE_PARAMS.recurringMaterialize.priority,
      attempts: M17_QUEUE_PARAMS.recurringMaterialize.attempts,
      backoff: M17_QUEUE_PARAMS.recurringMaterialize.backoff,
      removeOnComplete: M17_QUEUE_PARAMS.recurringMaterialize.removeOnComplete,
      removeOnFail: M17_QUEUE_PARAMS.recurringMaterialize.removeOnFail,
    },
  );
  const attention = new Queue(M17_QUEUES.visitAttention, { connection });
  await attention.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M17_JOB_SCHEDULES.visitAttention },
      priority: M17_QUEUE_PARAMS.visitAttention.priority,
      attempts: M17_QUEUE_PARAMS.visitAttention.attempts,
      backoff: M17_QUEUE_PARAMS.visitAttention.backoff,
      removeOnComplete: M17_QUEUE_PARAMS.visitAttention.removeOnComplete,
      removeOnFail: M17_QUEUE_PARAMS.visitAttention.removeOnFail,
    },
  );
  const reassignment = new Queue(M17_QUEUES.reassignmentScan, { connection });
  await reassignment.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M17_JOB_SCHEDULES.reassignmentScan },
      priority: M17_QUEUE_PARAMS.reassignmentScan.priority,
      attempts: M17_QUEUE_PARAMS.reassignmentScan.attempts,
      backoff: M17_QUEUE_PARAMS.reassignmentScan.backoff,
      removeOnComplete: M17_QUEUE_PARAMS.reassignmentScan.removeOnComplete,
      removeOnFail: M17_QUEUE_PARAMS.reassignmentScan.removeOnFail,
    },
  );
  const reminder = new Queue(M17_QUEUES.caregiverReminder, { connection });
  await reminder.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M17_JOB_SCHEDULES.caregiverReminder },
      priority: M17_QUEUE_PARAMS.caregiverReminder.priority,
      attempts: M17_QUEUE_PARAMS.caregiverReminder.attempts,
      backoff: M17_QUEUE_PARAMS.caregiverReminder.backoff,
      removeOnComplete: M17_QUEUE_PARAMS.caregiverReminder.removeOnComplete,
      removeOnFail: M17_QUEUE_PARAMS.caregiverReminder.removeOnFail,
    },
  );
  return [recurring, attention, reassignment, reminder];
}
