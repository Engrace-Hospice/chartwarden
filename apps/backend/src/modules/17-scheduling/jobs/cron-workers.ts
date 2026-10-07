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
          message: "Scheduled visits require attention.",
        },
      });
    }
  }
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
  return [recurring, attention];
}
