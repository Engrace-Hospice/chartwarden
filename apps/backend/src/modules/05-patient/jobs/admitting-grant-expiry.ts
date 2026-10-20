// apps/backend/src/modules/05-patient/jobs/admitting-grant-expiry.ts — the `m5.admitting_grant_expiry` job.
//
// Backstop for the creator's `admitting_staff` access grant. It normally ends with the referral's closing
// event or the admission's activation/discharge; this daily sweep ends any that are still open after
// {@link ADMITTING_GRANT_MAX_AGE_DAYS}, so a missed or never-delivered event cannot leave a non-clinical user
// on a patient's caseload forever.
//
// AGE ONLY, NOT "no activated admission": an activated admission already ended the grant (activation consumer),
// and M5 may not read the M6 `admission` table, so a still-open grant past the limit is by definition one whose
// admission has not activated. A creator whose referral is still in progress after 14 days loses chart access
// until they are assigned (a clinician) — the intended trade-off.
//
// Org-explicit (a cron tick is not a request): per active org, `withOrgContext`; one org's failure never skips the
// others and the pass rejects at the end so BullMQ retries. Idempotent (a second pass finds nothing open).
import { type DbClient, schema } from "@wardenx/db";
import { registerPlatformJob, systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, isNull, lte } from "drizzle-orm";
import { ADMITTING_STAFF_ASSIGNMENT_ROLE } from "../seams/care-team-provider";
import { M5_JOB_SCHEDULES, M5_QUEUES } from "./index";

const PA = schema.patientAssignments;

/** How long a creator's access grant may stay open before the sweep ends it. */
export const ADMITTING_GRANT_MAX_AGE_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;

export const M5_ADMITTING_GRANT_EXPIRY_QUEUE = M5_QUEUES.admittingGrantExpiry;
export const M5_ADMITTING_GRANT_EXPIRY_SCHEDULE = M5_JOB_SCHEDULES.admittingGrantExpiry;
/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M5_ADMITTING_GRANT_EXPIRY_PLATFORM_JOB_ID = "m5.admitting_grant_expiry";

export function wireAdmittingGrantExpiryTenancy(): void {
  registerPlatformJob(M5_ADMITTING_GRANT_EXPIRY_PLATFORM_JOB_ID);
}

export interface AdmittingGrantExpiryDeps {
  readonly db: DbClient;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
}

async function expireForOrg(db: DbClient, organizationId: string, now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - ADMITTING_GRANT_MAX_AGE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
    const ended = await (tx as unknown as DbClient)
      .update(PA)
      .set({ unassignedAt: today })
      .where(
        and(
          eq(PA.organizationId, organizationId),
          eq(PA.role, ADMITTING_STAFF_ASSIGNMENT_ROLE),
          isNull(PA.unassignedAt),
          lte(PA.assignedAt, cutoff),
        ),
      )
      .returning({ id: PA.id });
    return ended.length;
  });
}

/** One sweep over every active org; returns how many grants it ended. */
export async function runAdmittingGrantExpiry(deps: AdmittingGrantExpiryDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const failures: string[] = [];
  let ended = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      ended += await expireForOrg(deps.db, organizationId, now);
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0)
    throw new Error(
      `m5.admitting_grant_expiry failed for ${failures.length} org(s): ${failures.join("; ")}`,
    );
  return ended;
}

export function registerAdmittingGrantExpiryWorker(
  connection: ConnectionOptions,
  deps: AdmittingGrantExpiryDeps,
): Worker {
  return new Worker(M5_ADMITTING_GRANT_EXPIRY_QUEUE, async () => runAdmittingGrantExpiry(deps), {
    connection,
    concurrency: 1,
  });
}

export async function scheduleAdmittingGrantExpiry(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M5_ADMITTING_GRANT_EXPIRY_QUEUE, { connection });
  await queue.add(
    "daily",
    {},
    {
      repeat: { pattern: M5_ADMITTING_GRANT_EXPIRY_SCHEDULE },
      jobId: "m5-admitting-grant-expiry-daily",
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
