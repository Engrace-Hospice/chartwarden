// apps/backend/src/modules/12-dosespot/jobs/transmit-newrx.ts — the §4.8 `dosespot.transmit_newrx` per-org pass
// (GAP-037) and the `dosespot.transmit_queued_on_recovery` stale-claim reclaim.
//
// THE FLOW (spec §2.2 / §4.10 / §5.1 W-MR-01), one order at a time, the vendor call OUTSIDE any transaction:
//   1. CLAIM (tx): `queued_for_transmission` + `dosespot_send_state='queued'` orders, `FOR UPDATE SKIP LOCKED`, those
//      whose retry backoff (1,2,4,8 min by retry count) has elapsed are moved to `in_flight` and their transmission
//      row stamped `transmission_started_at`. A concurrent tick cannot re-claim them.
//   2. CALL: build the NewRx from the stored order + the recorded DoseSpot patient/prescriber ids, call
//      `DoseSpotClient.transmitNewRx` with the D8 idempotency key held on the transmission row.
//   3. SETTLE (tx), every UPDATE matches the order by ID and asserts the row count (the partition-key timestamp
//      round-trips lossily, so matching `created_at` never hits):
//        success    -> `transmitted` / send_state `transmitted`, prescription id recorded, `m12.medication_order.transmitted`.
//        breaker open -> back to `queued`, NO retry consumed (an outage must not exhaust the budget: that is what
//                       the queued-on-recovery drain exists for).
//        failure    -> the §4.10 planner: re-queue while budget remains, else `transmission_failed` + event; a
//                       permanent vendor rejection or an unfixable order exhausts immediately.
// Nothing here ever marks an order transmitted without a real `DoseSpotNewRxResponse`.
import { createHash } from "node:crypto";
import { schema } from "@chartwarden/db";
import {
  type DoseSpotNewRxPayload,
  RX_TRANSMISSION_MAX_RETRIES,
  isDegradedError,
  planTransmissionFailure,
  planTransmissionSuccess,
  transitionMedicationOrder,
} from "@chartwarden/dosespot";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { type M12CronDeps, errorClassOf, inOrg, isCircuitOpenError, nowOf } from "./cron-common";
import { DosespotSyncQueueRepository } from "./repository";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;
const SYNC = schema.dosespotPatientSync;
const DP = schema.dosespotPrescribers;

export const TRANSMIT_BATCH_SIZE = 25;
export const RECOVERY_BATCH_SIZE = 100;
/** An `in_flight` claim older than this is a crashed worker's; the recovery drain re-queues it. */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;
const MAX_BACKOFF_MINUTES = 60;

type OrderRow = typeof MO.$inferSelect;
type TransmissionRow = typeof MOT.$inferSelect;

export interface TransmitPassResult {
  readonly claimed: number;
  readonly transmitted: number;
  readonly requeued: number;
  readonly failed: number;
  readonly deferredByOutage: number;
}

/** Minutes to wait after the Nth failed attempt: 1, 2, 4, 8, ... capped. */
export const backoffMinutes = (retryCount: number): number =>
  Math.min(2 ** Math.max(0, retryCount - 1), MAX_BACKOFF_MINUTES);

function dueForAttempt(t: TransmissionRow | undefined, now: Date): boolean {
  if (!t || t.retryCount === 0 || !t.transmissionFailedAt) return true;
  return t.transmissionFailedAt.getTime() + backoffMinutes(t.retryCount) * 60_000 <= now.getTime();
}

interface Claimed {
  readonly order: OrderRow;
  readonly transmission: TransmissionRow;
}

async function claim(
  deps: M12CronDeps,
  organizationId: string,
  batchSize: number,
): Promise<readonly Claimed[]> {
  const now = nowOf(deps);
  return inOrg(deps.db, organizationId, async (tx) => {
    const candidates = await tx
      .select()
      .from(MO)
      .where(and(eq(MO.status, "queued_for_transmission"), eq(MO.dosespotSendState, "queued")))
      .orderBy(asc(MO.createdAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    const transmissions = await tx
      .select()
      .from(MOT)
      .where(
        inArray(
          MOT.medicationOrderId,
          candidates.map((c) => c.id),
        ),
      );
    const byOrder = new Map(transmissions.map((t) => [t.medicationOrderId, t]));
    const claimed: Claimed[] = [];
    for (const order of candidates) {
      const transmission = byOrder.get(order.id);
      if (!transmission || !dueForAttempt(transmission, now)) continue;
      const moved = await tx
        .update(MO)
        .set({ dosespotSendState: "in_flight", updatedAt: now })
        .where(and(eq(MO.id, order.id), eq(MO.dosespotSendState, "queued")))
        .returning({ id: MO.id });
      if (moved.length !== 1) continue;
      const stamped = await tx
        .update(MOT)
        .set({ transmissionStartedAt: now })
        .where(eq(MOT.id, transmission.id))
        .returning({ id: MOT.id });
      if (stamped.length !== 1) throw new Error("transmission row vanished while claiming");
      claimed.push({ order, transmission });
    }
    return claimed;
  });
}

type Built =
  | { readonly kind: "payload"; readonly payload: DoseSpotNewRxPayload }
  | { readonly kind: "patient_not_synced" }
  | { readonly kind: "permanent"; readonly errorClass: string };

/** Assemble the NewRx from the stored order + the recorded vendor ids. Never defaults a clinical field. */
async function buildPayload(
  deps: M12CronDeps,
  organizationId: string,
  order: OrderRow,
): Promise<Built> {
  const facts = await inOrg(deps.db, organizationId, async (tx) => {
    const [sync] = await tx
      .select({ id: SYNC.lastDosespotPatientId, outcome: SYNC.lastSyncOutcome })
      .from(SYNC)
      .where(and(eq(SYNC.patientId, order.patientId), eq(SYNC.lastSyncOutcome, "success")))
      .limit(1);
    const [prescriber] = await tx
      .select({ id: DP.dosespotPrescriberId })
      .from(DP)
      .where(and(eq(DP.membershipId, order.prescriberMembershipId), isNull(DP.revokedAt)))
      .limit(1);
    return { patientId: sync?.id ?? null, prescriberId: prescriber?.id ?? null };
  });
  if (facts.patientId === null) return { kind: "patient_not_synced" };
  if (facts.prescriberId === null)
    return { kind: "permanent", errorClass: "prescriber_not_enrolled" };
  const data = (order.data ?? {}) as Record<string, unknown>;
  const sig = data.sigStructured;
  const qty = (data.dispenseQuantity as { value?: unknown } | undefined)?.value;
  const days = data.daysSupply;
  if (
    !order.rxnormRxcui ||
    typeof sig !== "object" ||
    sig === null ||
    typeof qty !== "number" ||
    typeof days !== "number"
  ) {
    return { kind: "permanent", errorClass: "order_incomplete" };
  }
  return {
    kind: "payload",
    payload: {
      medicationOrderId: order.id,
      dosespotPatientId: facts.patientId,
      dosespotPrescriberId: facts.prescriberId,
      rxnormRxcui: order.rxnormRxcui,
      ...(order.ndc ? { ndc: order.ndc } : {}),
      drugName: order.drugName,
      strength: order.strength,
      sigStructured: sig as Record<string, unknown>,
      quantity: qty,
      daysSupply: days,
      refillsAuthorized: order.refillsAuthorized,
      ...(order.deaSchedule ? { deaSchedule: order.deaSchedule } : {}),
    },
  };
}

type Outcome =
  | { kind: "success"; prescriptionId: string; transmittedAt: Date }
  | { kind: "outage" }
  | {
      kind: "failure";
      errorClass: string;
      detail: string;
      permanent: boolean;
      syncPatient: boolean;
    };

async function attemptOne(deps: M12CronDeps, organizationId: string, c: Claimed): Promise<Outcome> {
  const built = await buildPayload(deps, organizationId, c.order);
  if (built.kind === "patient_not_synced") {
    return {
      kind: "failure",
      errorClass: "patient_not_synced",
      detail: "no DoseSpot patient id is recorded yet; a patient sync was requested",
      permanent: false,
      syncPatient: true,
    };
  }
  if (built.kind === "permanent") {
    return {
      kind: "failure",
      errorClass: built.errorClass,
      detail: "the order cannot be transmitted as written",
      permanent: true,
      syncPatient: false,
    };
  }
  try {
    const res = await deps.client.transmitNewRx(
      organizationId,
      built.payload,
      c.transmission.idempotencyKey,
    );
    return {
      kind: "success",
      prescriptionId: res.dosespotPrescriptionId,
      transmittedAt: new Date(res.transmittedAt),
    };
  } catch (error) {
    if (isCircuitOpenError(error)) return { kind: "outage" };
    return {
      kind: "failure",
      errorClass: errorClassOf(error),
      detail: isDegradedError(error) ? error.customerMessage : "unexpected adapter failure",
      permanent: isDegradedError(error) && !error.retryable,
      syncPatient: false,
    };
  }
}

async function settle(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  outcome: Outcome,
): Promise<"transmitted" | "requeued" | "failed" | "deferred"> {
  const now = nowOf(deps);
  return inOrg(deps.db, organizationId, async (tx) => {
    const orderId = c.order.id;
    const emit = (eventName: string, payload: Record<string, unknown>) =>
      deps.outbox.publish(tx, {
        eventName,
        payload,
        organizationId,
        aggregateKind: "medication_order",
        aggregateId: orderId,
      });

    if (outcome.kind === "outage") {
      const back = await tx
        .update(MO)
        .set({ dosespotSendState: "queued", updatedAt: now })
        .where(and(eq(MO.id, orderId), eq(MO.dosespotSendState, "in_flight")))
        .returning({ id: MO.id });
      if (back.length !== 1) throw new Error("order not in flight at outage release");
      return "deferred";
    }

    if (outcome.kind === "success") {
      transitionMedicationOrder("queued_for_transmission", {
        type: "transmissionSucceeded",
        isSystemActor: true,
      });
      const plan = planTransmissionSuccess({
        dosespotPrescriptionId: outcome.prescriptionId,
        dosespotResponseDigest: createHash("sha256")
          .update(`${outcome.prescriptionId}|${outcome.transmittedAt.toISOString()}`)
          .digest("hex"),
        nowInstant: outcome.transmittedAt.toISOString(),
      });
      const o = await tx
        .update(MO)
        .set({
          status: plan.status,
          dosespotSendState: plan.sendState,
          dosespotPrescriptionId: outcome.prescriptionId,
          transmittedAt: outcome.transmittedAt,
          version: sql`${MO.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(MO.id, orderId), eq(MO.dosespotSendState, "in_flight")))
        .returning({ id: MO.id });
      if (o.length !== 1) throw new Error("order not in flight at transmit settle");
      const t = await tx
        .update(MOT)
        .set({
          transmissionSucceededAt: outcome.transmittedAt,
          dosespotPrescriptionId: outcome.prescriptionId,
          dosespotResponseDigest: plan.transmissionUpdate.dosespotResponseDigest,
        })
        .where(eq(MOT.id, c.transmission.id))
        .returning({ id: MOT.id });
      if (t.length !== 1) throw new Error("transmission row not updated at success");
      await emit(plan.event, {
        orderId,
        dosespotPrescriptionId: outcome.prescriptionId,
        transmittedAt: outcome.transmittedAt.toISOString(),
        dispensingPharmacyMdmId: c.order.dispensingPharmacyMdmId ?? null,
      });
      return "transmitted";
    }

    // failure: permanent rejections exhaust the budget at once.
    const plan = planTransmissionFailure({
      medicationOrderId: orderId,
      currentRetryCount: outcome.permanent
        ? RX_TRANSMISSION_MAX_RETRIES - 1
        : c.transmission.retryCount,
      lastErrorClass: outcome.errorClass,
      nowInstant: now.toISOString(),
    });
    const t = await tx
      .update(MOT)
      .set({
        transmissionFailedAt: now,
        retryCount: plan.transmissionUpdate.retryCount,
        lastErrorClass: outcome.errorClass,
        lastErrorDetail: outcome.detail,
      })
      .where(eq(MOT.id, c.transmission.id))
      .returning({ id: MOT.id });
    if (t.length !== 1) throw new Error("transmission row not updated at failure");
    if (!plan.exhausted) {
      const back = await tx
        .update(MO)
        .set({ dosespotSendState: "queued", updatedAt: now })
        .where(and(eq(MO.id, orderId), eq(MO.dosespotSendState, "in_flight")))
        .returning({ id: MO.id });
      if (back.length !== 1) throw new Error("order not in flight at requeue");
      if (outcome.syncPatient) {
        await new DosespotSyncQueueRepository(tx).enqueue({
          organizationId,
          kind: "patient_sync",
          reason: "created",
          patientId: c.order.patientId,
        });
      }
      return "requeued";
    }
    transitionMedicationOrder("queued_for_transmission", {
      type: "transmissionExhausted",
      isSystemActor: true,
    });
    const o = await tx
      .update(MO)
      .set({
        status: plan.status,
        dosespotSendState: plan.sendState,
        version: sql`${MO.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(MO.id, orderId), eq(MO.dosespotSendState, "in_flight")))
      .returning({ id: MO.id });
    if (o.length !== 1) throw new Error("order not in flight at exhaustion");
    await emit(plan.event, {
      orderId,
      lastErrorClass: outcome.errorClass,
      retryCount: plan.transmissionUpdate.retryCount,
    });
    return "failed";
  });
}

/** One org's transmit pass. */
export async function runTransmitNewRxForOrg(
  deps: M12CronDeps,
  organizationId: string,
  batchSize = TRANSMIT_BATCH_SIZE,
): Promise<TransmitPassResult> {
  const claimed = await claim(deps, organizationId, batchSize);
  let transmitted = 0;
  let requeued = 0;
  let failed = 0;
  let deferredByOutage = 0;
  for (const c of claimed) {
    const outcome = await attemptOne(deps, organizationId, c);
    const result = await settle(deps, organizationId, c, outcome);
    if (result === "transmitted") transmitted += 1;
    else if (result === "requeued") requeued += 1;
    else if (result === "failed") failed += 1;
    else deferredByOutage += 1;
  }
  return { claimed: claimed.length, transmitted, requeued, failed, deferredByOutage };
}

/**
 * `dosespot.transmit_queued_on_recovery` (§4.8 / D11): re-queue claims a crashed worker abandoned (`in_flight`
 * past {@link IN_FLIGHT_STALE_MS}), then drain the accumulated `queued` backlog with the larger recovery batch.
 * Returns how many stale claims were released.
 */
export async function runRecoveryDrainForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<{ readonly released: number; readonly pass: TransmitPassResult }> {
  const now = nowOf(deps);
  const cutoff = new Date(now.getTime() - IN_FLIGHT_STALE_MS);
  const released = await inOrg(deps.db, organizationId, async (tx) => {
    const rows = await tx
      .update(MO)
      .set({ dosespotSendState: "queued", updatedAt: now })
      .where(
        and(
          eq(MO.status, "queued_for_transmission"),
          eq(MO.dosespotSendState, "in_flight"),
          lt(MO.updatedAt, cutoff),
        ),
      )
      .returning({ id: MO.id });
    return rows.length;
  });
  const pass = await runTransmitNewRxForOrg(deps, organizationId, RECOVERY_BATCH_SIZE);
  return { released, pass };
}
