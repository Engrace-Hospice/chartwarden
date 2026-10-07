// apps/backend/src/modules/05-patient/jobs/amendment-sla-scan.ts — the M5 `m5.amendment_sla_scan` job
// (GAP-118, M5 §4.5; HIPAA 45 CFR 164.526(b)(2): act on an amendment request within 60 days).
//
// `slaDueAt` (= received + 60 days) was stamped at submit and read by nothing, so a request could age past its
// deadline unnoticed. Once a day, per active org, this claims every PENDING request that
//   - is within {@link SLA_WARN_DAYS} of its deadline (not yet due)  -> `m5.patient.amendment_sla_due_soon`
//   - is past its deadline                                           -> `m5.patient.amendment_sla_overdue`
// exactly once each: the marker column is stamped by the same guarded UPDATE that claims the row, in the same
// transaction as the outbox publish, so a replayed tick or a racing replica matches nothing the second time.
// M36 turns the events into pages (`36-messaging/outbox-consumers/amendment-sla-alerts.ts`).
//
// The fan-out is org-explicit (a cron tick is not a request): one org's failure never skips the others, and the
// pass rejects at the end so BullMQ retries.
import { type DbClient, schema } from "@wardenx/db";
import { registerPlatformJob, systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { M5OutboxPort } from "../deceased-db";
import { M5_JOB_SCHEDULES, M5_QUEUES } from "./index";

const AR = schema.patientAmendmentRequests;

/** A pending request this close to its deadline (days) is "due soon". */
export const SLA_WARN_DAYS = 10;
const DAY_MS = 24 * 3600 * 1000;

export const M5_AMENDMENT_SLA_QUEUE = M5_QUEUES.amendmentSlaScan;
export const M5_AMENDMENT_SLA_SCHEDULE = M5_JOB_SCHEDULES.amendmentSlaScan;
/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M5_AMENDMENT_SLA_PLATFORM_JOB_ID = "m5.amendment_sla_scan";

export function wireAmendmentSlaTenancy(): void {
  registerPlatformJob(M5_AMENDMENT_SLA_PLATFORM_JOB_ID);
}

export interface AmendmentSlaDeps {
  readonly db: DbClient;
  readonly outbox: M5OutboxPort;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
}

export interface AmendmentSlaCounts {
  readonly dueSoon: number;
  readonly overdue: number;
}

interface Claimed {
  id: string;
  patientId: string;
  slaDueAt: Date;
}

async function scanOrg(
  deps: AmendmentSlaDeps,
  organizationId: string,
  now: Date,
): Promise<AmendmentSlaCounts> {
  return withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
    const t = tx as unknown as DbClient;
    const returning = { id: AR.id, patientId: AR.patientId, slaDueAt: AR.slaDueAt };
    const emit = async (eventName: string, rows: readonly Claimed[]): Promise<void> => {
      for (const r of rows) {
        await deps.outbox.publish(t, {
          eventName,
          payload: {
            patientId: r.patientId,
            organizationId,
            amendmentId: r.id,
            slaDueAt: r.slaDueAt.toISOString(),
          },
          organizationId,
          aggregateKind: "patient",
          aggregateId: r.patientId,
        });
      }
    };

    // Overdue first: a request past its deadline is never reported as merely "due soon".
    const overdue = (await t
      .update(AR)
      .set({ slaOverdueNotifiedAt: now })
      .where(and(eq(AR.status, "pending"), isNull(AR.slaOverdueNotifiedAt), lte(AR.slaDueAt, now)))
      .returning(returning)) as Claimed[];
    await emit("m5.patient.amendment_sla_overdue", overdue);

    const dueSoon = (await t
      .update(AR)
      .set({ slaDueSoonNotifiedAt: now })
      .where(
        and(
          eq(AR.status, "pending"),
          isNull(AR.slaDueSoonNotifiedAt),
          gt(AR.slaDueAt, now),
          lte(AR.slaDueAt, new Date(now.getTime() + SLA_WARN_DAYS * DAY_MS)),
        ),
      )
      .returning(returning)) as Claimed[];
    await emit("m5.patient.amendment_sla_due_soon", dueSoon);

    return { dueSoon: dueSoon.length, overdue: overdue.length };
  });
}

/** One scan over every active org. */
export async function runAmendmentSlaScan(deps: AmendmentSlaDeps): Promise<AmendmentSlaCounts> {
  const now = (deps.now ?? (() => new Date()))();
  const failures: string[] = [];
  let dueSoon = 0;
  let overdue = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      const c = await scanOrg(deps, organizationId, now);
      dueSoon += c.dueSoon;
      overdue += c.overdue;
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0)
    throw new Error(
      `m5.amendment_sla_scan failed for ${failures.length} org(s): ${failures.join("; ")}`,
    );
  return { dueSoon, overdue };
}

export function registerAmendmentSlaWorker(
  connection: ConnectionOptions,
  deps: AmendmentSlaDeps,
): Worker {
  return new Worker(M5_AMENDMENT_SLA_QUEUE, async () => runAmendmentSlaScan(deps), {
    connection,
    concurrency: 1,
  });
}

export async function scheduleAmendmentSla(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M5_AMENDMENT_SLA_QUEUE, { connection });
  await queue.add(
    "daily",
    {},
    {
      repeat: { pattern: M5_AMENDMENT_SLA_SCHEDULE },
      jobId: "m5-amendment-sla-daily",
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
