// apps/backend/src/modules/12-dosespot/jobs/transmission-sweep.ts — the §4.8 `dosespot.transmission_timeout_sweep`
// per-org pass (GAP-037). It is BOTH the ack/nack poller and the 24 h timeout:
//
//   • DoseSpot's public v2 surface exposes no push channel we could verify, so the pharmacy outcome is POLLED:
//     for every order in `transmitted`, `getPrescriptionStatus` is read and mapped through the §2.2 machine —
//     `sent` (eRxSent/FaxSent/PharmacyVerified) => `ack_received` then the immediate `activate` => `active`;
//     `failed` (Error/EpcsError/Retracted/Deleted) => `nack_received`; `pending` / `needs_pharmacy` => wait.
//   • An order still not acknowledged 24 h after `transmitted_at` is flipped to `transmission_failed` and
//     announced (spec: "no webhook within 24h"), so a prescription that silently died does not sit "transmitted".
//   • The webhook handler (when DoseSpot is configured to push) may settle the same order first; every UPDATE is
//     guarded on `status = 'transmitted'` and asserts its row count, so the loser is a no-op, never a double emit.
// Poll failures never settle anything: a degraded call leaves the order for the next tick.
import { schema } from "@chartwarden/db";
import { isDegradedError } from "@chartwarden/dosespot";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type M12CronDeps, inOrg, nowOf } from "./cron-common";
import { applyPharmacyAck, applyPharmacyNack } from "./order-outcomes";

const MO = schema.medicationOrders;
const SYNC = schema.dosespotPatientSync;

export const TRANSMISSION_ACK_DEADLINE_MS = 24 * 3_600_000;
export const SWEEP_BATCH_SIZE = 100;

export interface SweepResult {
  readonly polled: number;
  readonly acknowledged: number;
  readonly nacked: number;
  readonly timedOut: number;
  readonly pollFailures: number;
}

type Verdict = "ack" | "nack" | "timeout" | "wait";

export function decideSweepVerdict(input: {
  readonly phase: "sent" | "pending" | "failed" | "needs_pharmacy";
  readonly transmittedAt: Date;
  readonly now: Date;
}): Verdict {
  if (input.phase === "sent") return "ack";
  if (input.phase === "failed") return "nack";
  return input.now.getTime() - input.transmittedAt.getTime() >= TRANSMISSION_ACK_DEADLINE_MS
    ? "timeout"
    : "wait";
}

export async function runTransmissionSweepForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<SweepResult> {
  const now = nowOf(deps);
  const orders = await inOrg(deps.db, organizationId, (tx) =>
    tx
      .select({
        id: MO.id,
        patientId: MO.patientId,
        prescriptionId: MO.dosespotPrescriptionId,
        transmittedAt: MO.transmittedAt,
        pharmacy: MO.dispensingPharmacyMdmId,
        dosespotPatientId: SYNC.lastDosespotPatientId,
      })
      .from(MO)
      .leftJoin(
        SYNC,
        and(eq(SYNC.patientId, MO.patientId), eq(SYNC.organizationId, MO.organizationId)),
      )
      .where(
        and(
          eq(MO.status, "transmitted"),
          eq(MO.dosespotSendState, "transmitted"),
          isNotNull(MO.dosespotPrescriptionId),
          isNotNull(MO.transmittedAt),
        ),
      )
      .orderBy(asc(MO.transmittedAt))
      .limit(SWEEP_BATCH_SIZE),
  );
  let acknowledged = 0;
  let nacked = 0;
  let timedOut = 0;
  let pollFailures = 0;
  for (const o of orders) {
    if (!o.prescriptionId || !o.transmittedAt) continue;
    let phase: "sent" | "pending" | "failed" | "needs_pharmacy" = "pending";
    let rawStatus = "unknown";
    if (o.dosespotPatientId) {
      try {
        const s = await deps.client.getPrescriptionStatus(
          organizationId,
          o.dosespotPatientId,
          o.prescriptionId,
        );
        phase = s.phase;
        rawStatus = s.rawStatus;
      } catch (error) {
        if (!isDegradedError(error)) throw error;
        pollFailures += 1;
        // A failed poll can still time the order out: the deadline does not depend on the vendor answering.
      }
    }
    const verdict = decideSweepVerdict({ phase, transmittedAt: o.transmittedAt, now });
    if (verdict === "wait") continue;
    const settled = await inOrg(deps.db, organizationId, async (tx) => {
      const emit = (eventName: string, payload: Record<string, unknown>) =>
        deps.outbox.publish(tx, {
          eventName,
          payload,
          organizationId,
          aggregateKind: "medication_order",
          aggregateId: o.id,
        });
      const guard = and(eq(MO.id, o.id), eq(MO.status, "transmitted"));
      if (verdict === "ack") {
        const ok = await applyPharmacyAck(tx, deps.outbox, {
          organizationId,
          orderId: o.id,
          rawStatus,
          at: now,
        });
        return ok ? ("ack" as const) : ("lost" as const);
      }
      if (verdict === "nack") {
        const ok = await applyPharmacyNack(tx, deps.outbox, {
          organizationId,
          orderId: o.id,
          rejectionReason: rawStatus,
          pharmacyMdmId: o.pharmacy ?? null,
          at: now,
        });
        return ok ? ("nack" as const) : ("lost" as const);
      }
      // timeout: `transmitted` has no machine edge to `transmission_failed` (the exhausted edge leaves
      // `queued_for_transmission`); the sweep is the system actor closing a dead prescription, written directly.
      const r = await tx
        .update(MO)
        .set({
          status: "transmission_failed",
          dosespotSendState: "failed",
          version: sql`${MO.version} + 1`,
          updatedAt: now,
        })
        .where(guard)
        .returning({ id: MO.id });
      if (r.length !== 1) return "lost" as const;
      await emit("m12.medication_order.transmission_failed", {
        orderId: o.id,
        lastErrorClass: "no_pharmacy_ack_24h",
        retryCount: 0,
      });
      return "timeout" as const;
    });
    if (settled === "ack") acknowledged += 1;
    else if (settled === "nack") nacked += 1;
    else if (settled === "timeout") timedOut += 1;
  }
  return { polled: orders.length, acknowledged, nacked, timedOut, pollFailures };
}
