// apps/backend/src/modules/39-consent/jobs/cascade-retry.ts — M39 §4.9 `m39.revocation_cascade_retry` (GAP-171).
//
// The revocation cascade is at-least-once, so something has to notice a cascade that never completes. Until
// this cron existed nothing did: a stuck cascade stayed `pending` forever, `partial_failed` was reachable only
// through the manual retry route, and the CRITICAL `m39.consent.revoked_cascade_failed` alert (alerts-by-m39.ts)
// had no emitter. Each tick, per org, it sweeps revocations that are `pending`/`in_progress` and older than the
// stuck threshold, and for each one spends ONE attempt of the 5-attempt budget:
//   • every live consumer has ACKed        → `completed` (no event; the consumers already did their work);
//   • budget remains, stragglers outstanding → `in_progress`, and `m39.consent.revoked` is re-published
//     (`cascadeKind: "retry"`) so the un-ACKed consumers get another delivery (they are idempotent);
//   • budget spent with stragglers          → `partial_failed` + the CRITICAL alert, once.
//
// RELAY/CRON TICKS ARE NOT REQUESTS: org-explicit, one `withOrgContext` transaction per page (the `expiration.ts`
// precedent). Rows are taken `FOR UPDATE SKIP LOCKED`, so overlapping ticks and a concurrent ACK never
// double-spend an attempt. The alert is emitted BEFORE the status flip and keyed on the revocation id
// (AlertEmitter is idempotent on `(org, correlationId)`), so a failed flip rolls back and the next tick re-emits
// harmlessly — at-least-once, never lost.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  CASCADE_ATTEMPTS_KEY,
  type CascadeEvaluation,
  type M39AlertPort,
  attemptsOf,
  evaluateCascade,
} from "../cascade-ack";
import type { ConsentWriteOutboxPort } from "../consent-store-db";
import { M39_CRON_BOUNDS } from "./index";

const REV = schema.consentRevocation;
const CR = schema.consentRecord;

export type { M39AlertPort };

/** A cascade younger than this is still in its first delivery; the sweep leaves it alone (§4.9: ">5m"). */
export const CASCADE_STUCK_AFTER_MS = 5 * 60 * 1000;

export interface CascadeRetryDeps {
  readonly db: DbClient;
  readonly outbox: ConsentWriteOutboxPort;
  readonly alerts: M39AlertPort;
  readonly now?: () => Date;
}

export interface CascadeRetrySummary {
  readonly swept: number;
  readonly completed: number;
  readonly retried: number;
  readonly failed: number;
  /** True when the per-org page cap was hit — more stuck cascades remain and drain on the next tick. */
  readonly backlogRemaining: boolean;
}

export type CascadeSweepAction = "complete" | "retry" | "fail";

/** Pure: what one sweep does with a stuck cascade, given its evaluation AFTER spending an attempt. */
export function planCascadeSweep(evaluation: CascadeEvaluation): CascadeSweepAction {
  if (evaluation.status === "completed") return "complete";
  if (evaluation.status === "partial_failed") return "fail";
  return "retry";
}

async function sweepOnePage(
  deps: CascadeRetryDeps,
  organizationId: string,
  now: Date,
): Promise<CascadeRetrySummary & { readonly pageSize: number }> {
  const stuckBefore = new Date(now.getTime() - CASCADE_STUCK_AFTER_MS);
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const rows = await tx
      .select()
      .from(REV)
      .where(
        and(
          eq(REV.organizationId, organizationId),
          inArray(REV.cascadeStatus, ["pending", "in_progress"]),
          lte(sql`coalesce(${REV.cascadeStartedAt}, ${REV.revokedAt})`, stuckBefore),
        ),
      )
      .orderBy(asc(REV.revokedAt), asc(REV.id))
      .limit(M39_CRON_BOUNDS.pageSize)
      .for("update", { skipLocked: true });

    let completed = 0;
    let retried = 0;
    let failed = 0;
    for (const rev of rows) {
      const consumerJson = rev.cascadeConsumerStatusJsonb as Record<string, boolean | number>;
      const attempts = attemptsOf(consumerJson) + 1;
      const evaluation = evaluateCascade(
        { status: rev.cascadeStatus as "pending" | "in_progress", consumerJson },
        attempts,
      );
      const action = planCascadeSweep(evaluation);
      const [consent] = await tx
        .select({ patientId: CR.patientId, typeKey: CR.typeKey })
        .from(CR)
        .where(and(eq(CR.organizationId, organizationId), eq(CR.id, rev.consentRecordId)))
        .limit(1);

      if (action === "fail") {
        await deps.alerts.emit(organizationId, {
          eventType: "m39.consent.revoked_cascade_failed",
          payload: {
            organizationId,
            patientId: consent?.patientId ?? "",
            consentRecordId: rev.consentRecordId,
            typeKey: consent?.typeKey ?? "",
            revocationId: rev.id,
            failedConsumers: evaluation.pendingConsumers,
          },
          severity: "critical",
          correlationId: `m39-cascade-failed:${rev.id}`,
        });
      } else if (action === "retry") {
        await deps.outbox.publish(tx, {
          eventName: "m39.consent.revoked",
          payload: {
            organizationId,
            patientId: consent?.patientId ?? "",
            consentRecordId: rev.consentRecordId,
            revocationId: rev.id,
            typeKey: consent?.typeKey ?? "",
            revokedAt: rev.revokedAt.toISOString(),
            revokedByKind: rev.revokedByKind,
            cascadeKind: "retry",
          },
          organizationId,
          aggregateKind: "consent_record",
          aggregateId: rev.consentRecordId,
        });
      }

      await tx
        .update(REV)
        .set({
          cascadeStatus: evaluation.status,
          // `cascade_started_at` doubles as "last swept at": stamping it every sweep both spaces the attempts
          // (the stuck window is measured from it) and keeps this tick's page loop from re-picking the row.
          cascadeStartedAt: now,
          cascadeCompletedAt:
            evaluation.status === "completed" || evaluation.status === "partial_failed"
              ? now
              : null,
          cascadeConsumerStatusJsonb: { ...consumerJson, [CASCADE_ATTEMPTS_KEY]: attempts },
        })
        .where(eq(REV.id, rev.id));

      if (action === "complete") completed += 1;
      else if (action === "retry") retried += 1;
      else failed += 1;
    }
    return {
      swept: rows.length,
      completed,
      retried,
      failed,
      backlogRemaining: false,
      pageSize: rows.length,
    };
  });
}

/** `m39.revocation_cascade_retry` for ONE org: bounded pages until nothing stuck remains or the cap is hit. */
export async function runCascadeRetryForOrg(
  deps: CascadeRetryDeps,
  organizationId: string,
): Promise<CascadeRetrySummary> {
  const now = (deps.now ?? (() => new Date()))();
  const total = { swept: 0, completed: 0, retried: 0, failed: 0 };
  for (let page = 0; page < M39_CRON_BOUNDS.maxPagesPerOrg; page += 1) {
    const r = await sweepOnePage(deps, organizationId, now);
    total.swept += r.swept;
    total.completed += r.completed;
    total.retried += r.retried;
    total.failed += r.failed;
    // A page that did not fill means nothing stuck remains (a swept row's `cascade_started_at` is `now`,
    // inside the stuck window, so it is not re-picked until a later tick).
    if (r.pageSize < M39_CRON_BOUNDS.pageSize) return { ...total, backlogRemaining: false };
  }
  return { ...total, backlogRemaining: true };
}

/** `m39.revocation_cascade_retry` across every active org. One org's failure never blocks the rest. */
export async function runCascadeRetryCron(
  deps: CascadeRetryDeps & {
    readonly activeOrgs: {
      listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
    };
  },
): Promise<CascadeRetrySummary> {
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const total = { swept: 0, completed: 0, retried: 0, failed: 0 };
  let backlogRemaining = false;
  const errors: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      const r = await runCascadeRetryForOrg(deps, organizationId);
      total.swept += r.swept;
      total.completed += r.completed;
      total.retried += r.retried;
      total.failed += r.failed;
      backlogRemaining = backlogRemaining || r.backlogRemaining;
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    // Surface (BullMQ retries / DLQ alert) AFTER every org was attempted — never silently swallowed.
    throw new AggregateError(errors, `M39 cascade-retry failed for ${errors.length} org(s)`);
  }
  return { ...total, backlogRemaining };
}
