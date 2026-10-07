// apps/backend/src/modules/12-dosespot/jobs/ial2-and-epcs-sweeps.ts — two §4.8 per-org passes (GAP-037).
//
// `dosespot.ial2_expiry_warn` (daily): every enrolled, un-revoked prescriber whose `ial2_expires_at` is within 30
// days (warn) / 7 days (critical) emits `m12.ial2_expiring_warn` once per stage — `ial2_alert_stage` (migration
// 0412) is the marker, advanced by a guarded UPDATE in the SAME tx as the event. A prescriber already EXPIRED
// (`days < 0`) is flipped `ial2_status = 'expired'` and `epcs_enabled = false` (the §1311.115 consequence; the
// table CHECK requires verified IAL2 for EPCS), and still alerts critical once.
//
// `dosespot.epcs_attempt_expiry_sweep` (every minute): `epcs_signing_attempt` rows still `pending` past
// `expires_at` become `failed_timeout` (the §1311.116 60-second window). The guarded UPDATE is idempotent. The
// "revert the order to pending_signature" half is the `secondFactorFailed` machine edge; it runs only for an order
// actually in `epcs_identity_pending`, and emits the existing `m12.medication_order.epcs_2fa_failed` event.
import { schema } from "@wardenx/db";
import {
  classifyIal2ExpiryStage,
  computeDaysUntilIal2Expiry,
  planIal2ExpiryAlert,
  transitionMedicationOrder,
} from "@wardenx/dosespot";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { type M12CronDeps, inOrg, nowOf } from "./cron-common";

const DP = schema.dosespotPrescribers;
const EPCS = schema.epcsSigningAttempts;
const MO = schema.medicationOrders;

export const IAL2_SCAN_BATCH = 500;
export const EPCS_SWEEP_BATCH = 500;

export interface Ial2SweepResult {
  readonly scanned: number;
  readonly warned: number;
  readonly critical: number;
  readonly expired: number;
}

export async function runIal2ExpiryWarnForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<Ial2SweepResult> {
  const now = nowOf(deps);
  const rows = await inOrg(deps.db, organizationId, (tx) =>
    tx
      .select({
        id: DP.id,
        membershipId: DP.membershipId,
        expiresAt: DP.ial2ExpiresAt,
        status: DP.ial2Status,
        stage: DP.ial2AlertStage,
      })
      .from(DP)
      .where(and(isNull(DP.revokedAt), isNotNull(DP.ial2ExpiresAt), isNotNull(DP.enrolledAt)))
      .orderBy(asc(DP.ial2ExpiresAt))
      .limit(IAL2_SCAN_BATCH),
  );
  let warned = 0;
  let critical = 0;
  let expired = 0;
  for (const p of rows) {
    if (!p.expiresAt) continue;
    const days = computeDaysUntilIal2Expiry(p.expiresAt.toISOString(), now.toISOString());
    const stage = classifyIal2ExpiryStage(days);
    if (stage === "none") continue;
    const isExpired = days < 0;
    const needsFlip = isExpired && p.status === "verified";
    if (p.stage === stage && !needsFlip) continue; // this stage already alerted
    if (p.stage === "critical" && stage === "warn") continue; // never step back down
    const event = planIal2ExpiryAlert(stage).find((e) => e.kind === "outbox");
    const won = await inOrg(deps.db, organizationId, async (tx) => {
      const rowsUpdated = await tx
        .update(DP)
        .set({
          ial2AlertStage: stage,
          ...(isExpired ? { ial2Status: "expired" as const, epcsEnabled: false } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(DP.id, p.id),
            isNull(DP.revokedAt),
            p.stage === null ? isNull(DP.ial2AlertStage) : eq(DP.ial2AlertStage, p.stage),
          ),
        )
        .returning({ id: DP.id });
      if (rowsUpdated.length !== 1) return false;
      if (event && event.kind === "outbox" && p.stage !== stage) {
        await deps.outbox.publish(tx, {
          eventName: event.event,
          payload: {
            membershipId: p.membershipId,
            expiresAt: p.expiresAt?.toISOString(),
            daysRemaining: days,
          },
          organizationId,
          aggregateKind: "dosespot_prescriber",
          aggregateId: p.id,
        });
      }
      return true;
    });
    if (!won) continue;
    if (stage === "critical") critical += 1;
    else warned += 1;
    if (isExpired) expired += 1;
  }
  return { scanned: rows.length, warned, critical, expired };
}

export interface EpcsSweepResult {
  readonly expired: number;
  readonly ordersReverted: number;
}

export async function runEpcsAttemptExpirySweepForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<EpcsSweepResult> {
  const now = nowOf(deps);
  const due = await inOrg(deps.db, organizationId, (tx) =>
    tx
      .select({
        id: EPCS.id,
        orderId: EPCS.medicationOrderId,
        prescriber: EPCS.prescriberMembershipId,
      })
      .from(EPCS)
      .where(and(eq(EPCS.outcome, "pending"), lt(EPCS.expiresAt, now)))
      .orderBy(asc(EPCS.expiresAt))
      .limit(EPCS_SWEEP_BATCH),
  );
  let expired = 0;
  let ordersReverted = 0;
  for (const a of due) {
    const result = await inOrg(deps.db, organizationId, async (tx) => {
      const flipped = await tx
        .update(EPCS)
        .set({
          outcome: "failed_timeout",
          completedAt: now,
          outcomeDetail: "signing window expired",
        })
        .where(and(eq(EPCS.id, a.id), eq(EPCS.outcome, "pending")))
        .returning({ id: EPCS.id });
      if (flipped.length !== 1) return { flipped: false, reverted: false };
      const [order] = await tx
        .select({ id: MO.id, status: MO.status })
        .from(MO)
        .where(eq(MO.id, a.orderId))
        .limit(1);
      if (!order || order.status !== "epcs_identity_pending")
        return { flipped: true, reverted: false };
      transitionMedicationOrder("epcs_identity_pending", {
        type: "secondFactorFailed",
        isSystemActor: true,
      });
      const back = await tx
        .update(MO)
        .set({ status: "pending_signature", version: sql`${MO.version} + 1`, updatedAt: now })
        .where(and(eq(MO.id, a.orderId), eq(MO.status, "epcs_identity_pending")))
        .returning({ id: MO.id });
      if (back.length !== 1) return { flipped: true, reverted: false };
      await deps.outbox.publish(tx, {
        eventName: "m12.medication_order.epcs_2fa_failed",
        payload: {
          orderId: a.orderId,
          prescriberMembershipId: a.prescriber,
          outcomeDetail: "failed_timeout",
        },
        organizationId,
        aggregateKind: "medication_order",
        aggregateId: a.orderId,
      });
      return { flipped: true, reverted: true };
    });
    if (result.flipped) expired += 1;
    if (result.reverted) ordersReverted += 1;
  }
  return { expired, ordersReverted };
}
