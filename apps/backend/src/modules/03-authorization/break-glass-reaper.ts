// apps/backend/src/modules/03-authorization/break-glass-reaper.ts — the M3 `reap_breakglass` cron (GAP-117,
// M3 spec §7.4). Reads were always time-boxed (`findActiveGrant` filters `expires_at > now`), but nothing ever
// moved a lapsed row out of `active` / `cosign_pending`, so the console listed dead grants as live and no
// `m3.breakglass.ended` (outcome `expired`) was ever published. This sweep closes that: every lapsed,
// unsettled grant becomes `expired` and the event is published in the same transaction. Idempotent — the
// status-guarded UPDATE matches a row at most once, so a replayed tick or a racing replica emits nothing twice.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { registerPlatformJob, systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, inArray, lte } from "drizzle-orm";
import type { M3OutboxPublisher } from "./authz-ports";

export const M3_PLATFORM_JOB_ID = "m3-breakglass-reaper";
export const M3_BREAKGLASS_REAP_QUEUE = "authz.reap_breakglass";
/** Every five minutes: a dead grant should leave the console promptly, but reads are already time-boxed. */
export const M3_BREAKGLASS_REAP_SCHEDULE = "*/5 * * * *";

export interface BreakGlassReaperDeps {
  readonly db: DbClient;
  readonly outbox: M3OutboxPublisher;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
}

/** Allow the reaper to enter platform context for the active-org fan-out. */
export function wireM3ReaperTenancy(): void {
  registerPlatformJob(M3_PLATFORM_JOB_ID);
}

/** Expire every lapsed unsettled grant in one org; returns the number reaped. */
async function reapOrg(
  deps: BreakGlassReaperDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  return withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
    const t = tx as unknown as DbClient;
    const reaped = (await t
      .update(schema.breakGlassEvents)
      .set({ status: "expired" })
      .where(
        and(
          inArray(schema.breakGlassEvents.status, ["active", "cosign_pending"]),
          lte(schema.breakGlassEvents.expiresAt, now),
        ),
      )
      .returning({
        id: schema.breakGlassEvents.id,
        organizationId: schema.breakGlassEvents.organizationId,
      })) as Array<{ id: string; organizationId: string }>;
    for (const row of reaped) {
      await deps.outbox.publish(t as never, {
        eventName: "m3.breakglass.ended",
        payload: { breakGlassId: row.id, organizationId: row.organizationId, outcome: "expired" },
        organizationId: row.organizationId,
        aggregateKind: "break_glass_event",
        aggregateId: row.id,
      });
    }
    return reaped.length;
  });
}

/**
 * One reaper pass over every active org. A failing org does not stop the others; the pass rejects at the end
 * so BullMQ retries it.
 */
export async function runBreakGlassReaperCron(deps: BreakGlassReaperDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  let total = 0;
  const failures: string[] = [];
  for (const { organizationId } of orgs) {
    try {
      total += await reapOrg(deps, organizationId, now);
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`reap_breakglass failed for ${failures.length} org(s): ${failures.join("; ")}`);
  }
  return total;
}

export function registerM3CronWorkers(
  connection: ConnectionOptions,
  deps: BreakGlassReaperDeps,
): Worker[] {
  return [
    new Worker(M3_BREAKGLASS_REAP_QUEUE, async () => runBreakGlassReaperCron(deps), {
      connection,
      concurrency: 1,
    }),
  ];
}

export async function scheduleM3Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M3_BREAKGLASS_REAP_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M3_BREAKGLASS_REAP_SCHEDULE },
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return [queue];
}
