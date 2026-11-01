// apps/backend/src/modules/11-orders/jobs/critical-lab-escalation-worker.ts — #910: the 5-minute tick that escalates a
// critical lab result still quarantined with no order once its response clock (`CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS`)
// has lapsed. A thin per-org fan-out in the `order-sweeps-worker.ts` shape; the logic is
// `sweepQuarantinedCriticalLabs` (../critical-lab-result.ts). One org's failure does not stop the rest.
import type { DbClient } from "@chartwarden/db";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { type QuarantinedCritical, sweepQuarantinedCriticalLabs } from "../critical-lab-result";
import type { ActiveOrgListPort } from "./standing-spawn-worker";

export const M11_CRITICAL_LAB_ESCALATION_QUEUE = "orders.critical_lab_escalation";
export const M11_CRITICAL_LAB_ESCALATION_SCHEDULE = "*/5 * * * *";
export const M11_CRITICAL_LAB_ESCALATION_PLATFORM_JOB_ID = "m11.critical_lab_escalation";

export interface CriticalLabEscalationWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  readonly escalate: (organizationId: string, row: QuarantinedCritical) => Promise<void>;
}

export async function runCriticalLabEscalationFanout(
  deps: CriticalLabEscalationWorkerDeps,
): Promise<void> {
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      await sweepQuarantinedCriticalLabs({ db: deps.db, escalate: deps.escalate }, organizationId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `M11_CRITICAL_LAB_ESCALATION: ${failures.length} org failure(s)`,
    );
  }
}

export function registerM11CriticalLabEscalationWorker(
  deps: CriticalLabEscalationWorkerDeps,
): Worker {
  return new Worker(
    M11_CRITICAL_LAB_ESCALATION_QUEUE,
    async () => runCriticalLabEscalationFanout(deps),
    {
      connection: deps.connection,
      concurrency: 1,
    },
  );
}

export async function scheduleM11CriticalLabEscalation(
  connection: ConnectionOptions,
): Promise<Queue> {
  const queue = new Queue(M11_CRITICAL_LAB_ESCALATION_QUEUE, { connection });
  await queue.add(
    "tick",
    {},
    {
      repeat: { pattern: M11_CRITICAL_LAB_ESCALATION_SCHEDULE },
      jobId: "m11-critical-lab-escalation-5m",
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
