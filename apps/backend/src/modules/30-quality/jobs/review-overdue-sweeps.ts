// apps/backend/src/modules/30-quality/jobs/review-overdue-sweeps.ts — GAP-049.
//
// The two SCHEDULED §4.9 alerts that had no cron (alert-defs.ts `trigger.kind: "scheduled"`):
//   · mortality-review overdue sweep  -> `m30.alerts.mortality_review_due`  (info, "every 2d until completed")
//   · CoP attestation cadence sweep   -> `m30.alerts.cop_review_overdue`    (warn, "every 14d until attested")
// One daily tick reads each active org under its own RLS context (`withOrgContext`, org-explicit — a cron is not
// a request), picks the rows past their due date and raises the M36 alert through `AlertEmitter`. The alert
// correlation id carries a cadence bucket, so a re-run inside the bucket dedupes (alert is UNIQUE on
// (organization_id, correlation_id)) and a new bucket re-pages. Payloads are ids and instants only — no PHI.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";

export const M30_REVIEW_OVERDUE_QUEUE = "m30.review_overdue_sweep";
/** 08:30 UTC daily — clear of the 08:00 CAP-overdue scan. */
export const M30_REVIEW_OVERDUE_SCHEDULE = "30 8 * * *";
const MS_PER_DAY = 86_400_000;
const MORTALITY_REPEAT_DAYS = 2;
const COP_REPEAT_DAYS = 14;
const SYSTEM_USER_ID = "";

export interface OverdueMortalityReview {
  readonly reviewId: string;
  readonly targetCompletionAt: string;
}

export interface OverdueCopCitation {
  readonly statusId: string;
  readonly copCitation: string;
  readonly nextReviewDueAt: string;
}

export interface ReviewOverdueAlertInput {
  readonly eventType: string;
  readonly severity: "info" | "warn";
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

export interface ReviewOverdueRunDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly scanMortality: (organizationId: string) => Promise<readonly OverdueMortalityReview[]>;
  readonly scanCop: (organizationId: string) => Promise<readonly OverdueCopCitation[]>;
  readonly emit: (organizationId: string, input: ReviewOverdueAlertInput) => Promise<unknown>;
  readonly now: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface ReviewOverdueRunSummary {
  readonly orgs: number;
  readonly mortalityRaised: number;
  readonly copRaised: number;
  readonly failedOrgs: number;
}

const bucketOf = (now: Date, days: number): number =>
  Math.floor(now.getTime() / (MS_PER_DAY * days));

/** PURE — the alert for one overdue mortality review (info; re-pages every 2 days until completed). */
export function mortalityReviewAlert(
  organizationId: string,
  review: OverdueMortalityReview,
  now: Date,
): ReviewOverdueAlertInput {
  return {
    eventType: "m30.alerts.mortality_review_due",
    severity: "info",
    correlationId: `m30:mortality_review_due:${review.reviewId}:${bucketOf(now, MORTALITY_REPEAT_DAYS)}`,
    payload: {
      orgId: organizationId,
      reviewId: review.reviewId,
      targetCompletionAt: review.targetCompletionAt,
      deepLink: "/quality/mortality",
    },
  };
}

/** PURE — the alert for one CoP citation past its re-attestation date (warn; re-pages every 14 days). */
export function copReviewOverdueAlert(
  organizationId: string,
  citation: OverdueCopCitation,
  now: Date,
): ReviewOverdueAlertInput {
  return {
    eventType: "m30.alerts.cop_review_overdue",
    severity: "warn",
    correlationId: `m30:cop_review_overdue:${citation.statusId}:${bucketOf(now, COP_REPEAT_DAYS)}`,
    payload: {
      orgId: organizationId,
      statusId: citation.statusId,
      copCitation: citation.copCitation,
      nextReviewDueAt: citation.nextReviewDueAt,
      deepLink: "/quality",
    },
  };
}

/** One pass over every active org; a failing org is counted and never stops the rest. */
export async function runReviewOverdueSweeps(
  deps: ReviewOverdueRunDeps,
): Promise<ReviewOverdueRunSummary> {
  const now = deps.now();
  const orgs = await deps.listActiveOrgs();
  let mortalityRaised = 0;
  let copRaised = 0;
  let failedOrgs = 0;
  for (const { organizationId } of orgs) {
    try {
      for (const review of await deps.scanMortality(organizationId)) {
        await deps.emit(organizationId, mortalityReviewAlert(organizationId, review, now));
        mortalityRaised += 1;
      }
      for (const citation of await deps.scanCop(organizationId)) {
        await deps.emit(organizationId, copReviewOverdueAlert(organizationId, citation, now));
        copRaised += 1;
      }
    } catch (error) {
      failedOrgs += 1;
      deps.warn?.("m30.review_overdue_sweep: org sweep failed", {
        organizationId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { orgs: orgs.length, mortalityRaised, copRaised, failedOrgs };
}

type Rows<T> = { rows?: T[] };
const rowsOf = <T>(res: unknown): T[] => (res as Rows<T>).rows ?? [];
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

/** Mortality reviews not completed whose target completion date has passed (RLS-scoped, org-explicit). */
export function scanOrgForOverdueMortalityReviews(
  db: DbClient,
  organizationId: string,
  now: Date,
): Promise<readonly OverdueMortalityReview[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id AS "reviewId", target_completion_at AS "targetCompletionAt"
        FROM mortality_review
       WHERE organization_id = ${organizationId}::uuid
         AND completed_at IS NULL
         AND status <> 'completed'::m30_mortality_review_status
         AND target_completion_at <= ${now.toISOString()}::timestamptz`);
    return rowsOf<{ reviewId: string; targetCompletionAt: string | Date }>(res).map((r) => ({
      reviewId: r.reviewId,
      targetCompletionAt: iso(r.targetCompletionAt),
    }));
  });
}

/** CoP compliance rows whose next re-attestation date has passed (RLS-scoped, org-explicit). */
export function scanOrgForOverdueCopReviews(
  db: DbClient,
  organizationId: string,
  now: Date,
): Promise<readonly OverdueCopCitation[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id AS "statusId", cop_citation AS "copCitation", next_review_due_at AS "nextReviewDueAt"
        FROM cop_compliance_status
       WHERE organization_id = ${organizationId}::uuid
         AND next_review_due_at <= ${now.toISOString()}::timestamptz`);
    return rowsOf<{ statusId: string; copCitation: string; nextReviewDueAt: string | Date }>(
      res,
    ).map((r) => ({
      statusId: r.statusId,
      copCitation: r.copCitation,
      nextReviewDueAt: iso(r.nextReviewDueAt),
    }));
  });
}

export interface ReviewOverdueWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly listActiveOrgs: ReviewOverdueRunDeps["listActiveOrgs"];
  readonly emit: ReviewOverdueRunDeps["emit"];
  readonly now?: () => Date;
  readonly warn?: ReviewOverdueRunDeps["warn"];
}

/** Construct the `m30.review_overdue_sweep` Worker over the real DB reads + the M36 emitter. */
export function registerM30ReviewOverdueWorker(deps: ReviewOverdueWorkerDeps): Worker {
  const now = deps.now ?? (() => new Date());
  return new Worker(
    M30_REVIEW_OVERDUE_QUEUE,
    async () =>
      runReviewOverdueSweeps({
        listActiveOrgs: deps.listActiveOrgs,
        scanMortality: (organizationId) =>
          scanOrgForOverdueMortalityReviews(deps.db, organizationId, now()),
        scanCop: (organizationId) => scanOrgForOverdueCopReviews(deps.db, organizationId, now()),
        emit: deps.emit,
        now,
        warn: deps.warn,
      }),
    { connection: deps.connection, concurrency: 1 },
  );
}

/** Register the daily repeatable tick; returns the schedule `Queue` for the composition root to close. */
export async function scheduleM30ReviewOverdueJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M30_REVIEW_OVERDUE_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M30_REVIEW_OVERDUE_SCHEDULE }, removeOnComplete: true },
  );
  return queue;
}
