// apps/backend/src/modules/18-evv/jobs/late-check-sweep.ts — the §4.8 / D6 `m18.late-check-sweep` per-org worker
// (GAP-056).
//
// THE FINDING. Nothing but correction-of-record ever created an `evv_missing_resolution` row, so a clinician who
// checked in and never checked out left no trace: the missing-checkout work queue, the late-checkout alert and the
// `unresolved_missing` billing verdict were all structurally empty.
//
// WHAT A TICK DOES (one `withOrgContext` tx per org): take the registered visits whose
// `scheduled_ended_at + grace` has passed (bounded look-back + batch), keep those with an ACTIVE check-in and NO
// active check-out, drop any that already have a `missing_checkout` resolution in ANY status (a resolved/voided
// one is history — the sweep never reopens it), insert one `open` row per remaining visit and publish
// `m18.evv.late_check_out_detected` in the same tx.
//
// IDEMPOTENCY. A second tick sees the row it created and skips; `evv_missing_resolution_open_uidx` (one OPEN row
// per (visit, kind)) + `onConflictDoNothing` backstops a concurrent tick. The grace is the D6 default (4 h): no
// tenant grace column exists yet, so there is nothing tenant-specific to resolve.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, exists, gte, isNull, lte, notExists } from "drizzle-orm";
import type { EvvWriteOutboxPort } from "../evv-route-service-db";
import {
  M18_LATE_CHECKOUT_GRACE_MS,
  M18_LATE_CHECK_LOOKBACK_MS,
  M18_TICK_BATCH_LIMIT,
} from "./queues";

const REGISTRATION = schema.evvVisitRegistrations;
const EVENT = schema.evvEvent;
const MR = schema.evvMissingResolution;

const MS_PER_HOUR = 3_600_000;

export interface LateCheckSweepDeps {
  readonly db: DbClient;
  readonly outbox: EvvWriteOutboxPort;
  readonly now?: () => Date;
}

export interface LateCheckSweepResult {
  readonly candidates: number;
  readonly opened: number;
}

/** One org's sweep. Org-explicit: opens its own tenant scope (a cron tick is not a request). */
export async function runLateCheckSweepForOrg(
  deps: LateCheckSweepDeps,
  organizationId: string,
): Promise<LateCheckSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const graceCutoff = new Date(now.getTime() - M18_LATE_CHECKOUT_GRACE_MS);
  const lookbackFloor = new Date(now.getTime() - M18_LATE_CHECK_LOOKBACK_MS);

  return withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const tx = raw as DbClient;
    const activeEvent = (kind: "check_in" | "check_out") =>
      tx
        .select({ one: EVENT.id })
        .from(EVENT)
        .where(
          and(
            eq(EVENT.organizationId, organizationId),
            eq(EVENT.visitId, REGISTRATION.visitId),
            eq(EVENT.kind, kind),
            isNull(EVENT.supersededByEventId),
          ),
        );
    const trackedMissingCheckout = tx
      .select({ one: MR.id })
      .from(MR)
      .where(
        and(
          eq(MR.organizationId, organizationId),
          eq(MR.visitId, REGISTRATION.visitId),
          eq(MR.kind, "missing_checkout"),
        ),
      );
    const late = await tx
      .select({ visitId: REGISTRATION.visitId, scheduledEndedAt: REGISTRATION.scheduledEndedAt })
      .from(REGISTRATION)
      .where(
        and(
          eq(REGISTRATION.organizationId, organizationId),
          lte(REGISTRATION.scheduledEndedAt, graceCutoff),
          gte(REGISTRATION.scheduledEndedAt, lookbackFloor),
          exists(activeEvent("check_in")),
          notExists(activeEvent("check_out")),
          notExists(trackedMissingCheckout),
        ),
      )
      .orderBy(REGISTRATION.scheduledEndedAt)
      .limit(M18_TICK_BATCH_LIMIT);

    let opened = 0;
    for (const r of late) {
      const [row] = await tx
        .insert(MR)
        .values({
          organizationId,
          visitId: r.visitId,
          kind: "missing_checkout",
          detectedAt: now,
          detectedBySource: "cron_late_check_sweep",
        })
        .onConflictDoNothing()
        .returning({ id: MR.id });
      if (!row) continue;
      opened += 1;
      await deps.outbox.publish(tx, {
        eventName: "m18.evv.late_check_out_detected",
        organizationId,
        aggregateKind: "evv_missing_resolution",
        aggregateId: row.id,
        payload: {
          visitId: r.visitId,
          missingResolutionId: row.id,
          hoursPastGrace:
            Math.round(
              ((now.getTime() - r.scheduledEndedAt.getTime() - M18_LATE_CHECKOUT_GRACE_MS) /
                MS_PER_HOUR) *
                100,
            ) / 100,
          hasCheckIn: true,
        },
      });
    }
    return { candidates: late.length, opened };
  });
}
