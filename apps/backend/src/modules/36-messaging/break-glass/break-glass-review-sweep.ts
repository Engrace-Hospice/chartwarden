// M36 ADR-0087 (PROPOSED), WP 5.8, D5 - the overdue escalation: a break-glass review still open this many days after its grant ended
// (BREAK_GLASS_REVIEW_ESCALATE_DAYS) raises ONE fixed-text alert to the review-permission holders (rule `m36.break_glass.review_overdue`,
// system_locked, the tenant administrators as the backstop).
//
// Idempotent without a marker column: the alert is unique on (organization, correlation id) and the id carries the review id, so an hourly
// sweep that sees the same review again re-emits harmlessly and never alerts twice. A review stays in the sweep until it is completed;
// every overdue open review is visited each tick, in pages. A failed emit throws, so the job fails and BullMQ retries.
// The alert carries ids, a count of days and one fixed sentence: no name, channel, patient or reason.
import { type DbClient, schema } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  BREAK_GLASS_REVIEW_ESCALATE_DAYS,
  BREAK_GLASS_REVIEW_OVERDUE_ALERT,
} from "@chartwarden/types";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { BREAK_GLASS_REVIEW_DEEP_LINK } from "../outbox-consumers/break-glass-notifications";

const G = schema.messageBreakGlassGrants;
const R = schema.messageBreakGlassReviews;

/** Reviews read per page. */
export const SWEEP_BATCH = 200;
/** Pages per org per tick (a runaway tenant is bounded; the next tick continues from the start, deduped). */
export const MAX_PAGES = 25;

/** Provisional copy (compliance sign-off pending): what is overdue, never who, where or why. */
export const BREAK_GLASS_OVERDUE_ALERT_TEXT =
  "A break-glass access review is overdue. Every read is recorded; please complete the review" as const;

export interface BreakGlassReviewSweepDeps {
  readonly db: DbClient;
  readonly alerts: AlertEmitter;
}

export interface BreakGlassReviewSweepResult {
  /** Overdue open reviews found (each emitted once; a repeat is absorbed by the alert dedupe). */
  readonly overdue: number;
}

export function createBreakGlassReviewSweep(deps: BreakGlassReviewSweepDeps) {
  return {
    async overdueForOrg(organizationId: string): Promise<BreakGlassReviewSweepResult> {
      // Page through EVERY overdue open review (keyset on id): a fixed oldest-first window would let reviews that stay open forever starve
      // the newer ones. The alert dedupe makes the repeat emits of already-alerted reviews harmless; the hard cap bounds a runaway tenant.
      let overdue = 0;
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const due = await withOrgContext(deps.db, systemOrgContext(organizationId), (tx) =>
          tx
            .select({ reviewId: R.id, grantId: G.id })
            .from(R)
            .innerJoin(G, and(eq(G.organizationId, R.organizationId), eq(G.id, R.grantId)))
            .where(
              and(
                eq(R.organizationId, organizationId),
                isNull(R.reviewedAt),
                after ? gt(R.id, after) : undefined,
                // The end of the grant is the earlier of its expiry and its revocation, on the database clock.
                sql`least(${G.expiresAt}, coalesce(${G.revokedAt}, ${G.expiresAt})) <= now() - make_interval(days => ${BREAK_GLASS_REVIEW_ESCALATE_DAYS})`,
              ),
            )
            .orderBy(asc(R.id))
            .limit(SWEEP_BATCH),
        );
        for (const row of due) {
          await deps.alerts.emit(organizationId, {
            eventType: BREAK_GLASS_REVIEW_OVERDUE_ALERT,
            severity: "warn",
            correlationId: `break-glass:${row.reviewId}:overdue`,
            payload: {
              reviewId: row.reviewId,
              grantId: row.grantId,
              overdueAfterDays: BREAK_GLASS_REVIEW_ESCALATE_DAYS,
              message: BREAK_GLASS_OVERDUE_ALERT_TEXT,
              deepLink: BREAK_GLASS_REVIEW_DEEP_LINK,
            },
          });
        }
        overdue += due.length;
        if (due.length < SWEEP_BATCH) break;
        after = due[due.length - 1]?.reviewId ?? null;
      }
      return { overdue };
    },
  };
}

export type BreakGlassReviewSweep = ReturnType<typeof createBreakGlassReviewSweep>;
