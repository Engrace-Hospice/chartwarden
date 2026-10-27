// apps/backend/src/modules/06-admission/nomnc/scan.ts — milestone 10a: the 15-minute alert scan over typed expedited
// deadlines (folded into the existing `admission.window_alert` worker, never the nightly one). For each unsatisfied
// deadline whose parent is still live (an ACTIVE notice / an OPEN review) it publishes the tightest newly crossed
// product boundary (`m6.expedited_deadline.approaching`) or the one-time `m6.expedited_deadline.overdue`. The
// bookkeeping mark is written in the SAME transaction as the publish and guarded in the UPDATE itself, so a second
// replica or a replayed tick cannot page twice. PHI-free payloads: ids, kind and instants only.
import { type DbClient } from "@chartwarden/db";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  EXPEDITED_ALERT_BOUNDARY_HOURS,
  type ExpeditedAlertSelection,
  selectExpeditedAlerts,
} from "./domain";
import type { NomncOutboxPort } from "./service";
import { D, N, R } from "./store";

const WIDEST_BOUNDARY_MS = Math.max(...EXPEDITED_ALERT_BOUNDARY_HOURS) * 3_600_000;

/** Run one org's scan inside the caller's org-context tx. Returns how many alerts were published. */
export async function scanExpeditedDeadlinesInTx(
  tx: DbClient,
  outbox: NomncOutboxPort,
  organizationId: string,
  now: Date,
): Promise<number> {
  const horizon = new Date(now.getTime() + WIDEST_BOUNDARY_MS);
  const candidates = await tx
    .select({ d: D, noticeStatus: N.status, reviewState: R.state })
    .from(D)
    .leftJoin(N, eq(N.id, D.nomncNoticeId))
    .leftJoin(R, eq(R.id, D.expeditedReviewId))
    .where(
      and(
        eq(D.organizationId, organizationId),
        isNull(D.satisfiedAt),
        isNull(D.overdueAlertedAt),
        lte(D.dueAt, horizon),
        // The parent is still live: an active notice, or an open review.
        or(eq(N.status, "active"), eq(R.state, "open")),
      ),
    );
  const byId = new Map(candidates.map((c) => [c.d.id, c.d]));
  const selected = selectExpeditedAlerts(
    candidates.map(({ d }) => ({
      id: d.id,
      dueAt: d.dueAt,
      satisfiedAt: d.satisfiedAt,
      lastAlertedBoundaryHours: d.lastAlertedBoundaryHours,
      overdueAlertedAt: d.overdueAlertedAt,
    })),
    now,
  );
  let published = 0;
  for (const alert of selected) {
    const d = byId.get(alert.id);
    if (d && (await markAndPublish(tx, outbox, organizationId, d, alert, now))) published += 1;
  }
  return published;
}

export async function markAndPublish(
  tx: DbClient,
  outbox: NomncOutboxPort,
  organizationId: string,
  d: typeof D.$inferSelect,
  alert: ExpeditedAlertSelection,
  now: Date,
): Promise<boolean> {
  // The guard lives in the UPDATE: only the tick that actually moves the mark publishes.
  const [marked] =
    alert.kind === "overdue"
      ? await tx
          .update(D)
          .set({ overdueAlertedAt: now, updatedAt: now })
          .where(
            and(
              eq(D.id, d.id),
              eq(D.dueAt, d.dueAt),
              isNull(D.overdueAlertedAt),
              isNull(D.satisfiedAt),
            ),
          )
          .returning({ id: D.id })
      : await tx
          .update(D)
          .set({ lastAlertedBoundaryHours: alert.boundaryHours, updatedAt: now })
          .where(
            and(
              eq(D.id, d.id),
              // A deadline moved since this scan read it is not marked or alerted on the stale value.
              eq(D.dueAt, d.dueAt),
              isNull(D.satisfiedAt),
              or(
                isNull(D.lastAlertedBoundaryHours),
                sql`${D.lastAlertedBoundaryHours} > ${alert.boundaryHours}`,
              ),
            ),
          )
          .returning({ id: D.id });
  if (!marked) return false;
  const base = {
    expeditedDeadlineId: d.id,
    subject: d.nomncNoticeId ? "notice" : "review",
    kind: d.kind,
    admissionId: d.admissionId,
    patientId: d.patientId,
    dueAt: d.dueAt.toISOString(),
  };
  await outbox.publish(tx, {
    eventName:
      alert.kind === "overdue"
        ? "m6.expedited_deadline.overdue"
        : "m6.expedited_deadline.approaching",
    payload: alert.kind === "overdue" ? base : { ...base, boundaryHours: alert.boundaryHours },
    organizationId,
    aggregateKind: "expedited_deadline",
    aggregateId: d.id,
  });
  return true;
}
