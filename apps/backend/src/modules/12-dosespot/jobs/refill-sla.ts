// apps/backend/src/modules/12-dosespot/jobs/refill-sla.ts — the §4.8 `dosespot.refill_sla` per-org pass (GAP-037).
// Hourly scan of PENDING refill requests: >= 48 h => `m12.refill_request_sla_warn`, >= 72 h =>
// `m12.refill_request_sla_critical` (the platform-default policy; the tenant-tightening `refill_inbox_policy`
// table does not exist in Phase 1, so the default is authoritative). The clock math is the pure
// `classifyRefillSlaStage` in `@wardenx/dosespot`.
//
// ONCE PER STAGE: each stage stamps its `sla_*_emitted_at` marker (migration 0412) with a guarded UPDATE
// (`... IS NULL`, row count asserted) in the SAME transaction as the outbox event, so two replicas racing the
// tick emit exactly one event and a re-run emits nothing. A request that jumped straight past 72 h gets the
// critical event only. The upstream rows come from the webhook `refill_request` handler.
import { schema } from "@wardenx/db";
import { classifyRefillSlaStage, computeHoursPending, planRefillSlaAlert } from "@wardenx/dosespot";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type M12CronDeps, inOrg, nowOf } from "./cron-common";

const RR = schema.refillRequests;
export const REFILL_SLA_BATCH = 500;

export interface RefillSlaResult {
  readonly scanned: number;
  readonly warned: number;
  readonly critical: number;
}

export async function runRefillSlaForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<RefillSlaResult> {
  const now = nowOf(deps);
  const pending = await inOrg(deps.db, organizationId, (tx) =>
    tx
      .select({
        id: RR.id,
        receivedAt: RR.receivedAt,
        warnAt: RR.slaWarnEmittedAt,
        criticalAt: RR.slaCriticalEmittedAt,
      })
      .from(RR)
      .where(eq(RR.status, "pending"))
      .orderBy(asc(RR.receivedAt))
      .limit(REFILL_SLA_BATCH),
  );
  let warned = 0;
  let critical = 0;
  for (const r of pending) {
    const hoursPending = computeHoursPending(r.receivedAt.toISOString(), now.toISOString());
    const stage = classifyRefillSlaStage(hoursPending);
    if (stage === "none") continue;
    if (stage === "warn" && r.warnAt !== null) continue;
    if (stage === "critical" && r.criticalAt !== null) continue;
    const event = planRefillSlaAlert(stage).find((e) => e.kind === "outbox");
    if (!event || event.kind !== "outbox") continue;
    const won = await inOrg(deps.db, organizationId, async (tx) => {
      const marker =
        stage === "critical" ? { slaCriticalEmittedAt: now } : { slaWarnEmittedAt: now };
      const guard =
        stage === "critical"
          ? and(eq(RR.id, r.id), eq(RR.status, "pending"), isNull(RR.slaCriticalEmittedAt))
          : and(eq(RR.id, r.id), eq(RR.status, "pending"), isNull(RR.slaWarnEmittedAt));
      const rows = await tx
        .update(RR)
        .set({ ...marker, updatedAt: now })
        .where(guard)
        .returning({ id: RR.id });
      if (rows.length !== 1) return false;
      await deps.outbox.publish(tx, {
        eventName: event.event,
        payload: {
          refillRequestId: r.id,
          hoursPending,
          severity: stage === "critical" ? "high" : "warn",
        },
        organizationId,
        aggregateKind: "refill_request",
        aggregateId: r.id,
      });
      return true;
    });
    if (won) {
      if (stage === "critical") critical += 1;
      else warned += 1;
    }
  }
  return { scanned: pending.length, warned, critical };
}
