// apps/backend/src/modules/12-dosespot/jobs/transmit-newrx.ts — the §4.8 `dosespot.transmit_newrx` per-org pass
// (GAP-037) and the `dosespot.transmit_queued_on_recovery` stale-claim reclaim.
//
// THE FLOW (spec §2.2 / §4.10 / §5.1 W-MR-01), one order at a time, the vendor call OUTSIDE any transaction:
//   0. PREFLIGHT: the org's DoseSpot config is resolved once. A credential / resolver fault skips the pass whole (nothing claimed,
//      nothing written, one alert per episode): see `runTransmitNewRxForOrg`.
//   1. CLAIM (tx): `queued_for_transmission` + `dosespot_send_state='queued'` orders, `FOR UPDATE SKIP LOCKED`, those
//      whose retry backoff (1,2,4,8 min by retry count) has elapsed are moved to `in_flight`. A concurrent tick cannot re-claim them.
//   2. CALL: build the NewRx from the stored order + the recorded DoseSpot patient/prescriber ids, STAMP the transmission row's
//      `transmission_started_at` in its own committed transaction (the call is about to be made), then call
//      `DoseSpotClient.transmitNewRx` with the D8 idempotency key held on the transmission row. The stamp is what tells a stale claim
//      apart: one WITHOUT it never reached the vendor and is released for a re-send; one WITH it may have, and the drain HOLDS it.
//   3. SETTLE (tx), every UPDATE matches the order by ID and asserts the row count (the partition-key timestamp
//      round-trips lossily, so matching `created_at` never hits):
//        success    -> `transmitted` / send_state `transmitted`, prescription id recorded, `m12.medication_order.transmitted`.
//        breaker open -> back to `queued`, NO retry consumed (an outage must not exhaust the budget: that is what
//                       the queued-on-recovery drain exists for).
//        failure    -> the §4.10 planner: re-queue while budget remains, else `transmission_failed` + event; a
//                       permanent vendor rejection or an unfixable order exhausts immediately.
//        unconfirmed -> DoseSpot ACCEPTED the call (2xx) but its answer was unreadable or carried no id: the prescription may already
//                       exist there. The order is HELD, still `in_flight`, its transmission row naming why
//                       (`UNCONFIRMED_OUTCOME_CLASS` (hold.ts)): not failed (it did not fail), not re-queued, not retried, and skipped by the
//                       stale-claim drain (a second send could dispense twice). `m12.medication_order.transmission_unconfirmed` is
//                       published in the same transaction and M36 tells the tenant's administrators, who check the prescriber's DoseSpot
//                       account and either find it sent or discontinue the order and sign a new one.
// Nothing here ever marks an order transmitted without a real `DoseSpotNewRxResponse`.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type DoseSpotNewRxPayload,
  RX_TRANSMISSION_MAX_RETRIES,
  isConfigUnavailableError,
  isDegradedError,
  isNotEnabledError,
  isUnconfirmedOutcomeError,
  planTransmissionFailure,
  planTransmissionSuccess,
  transitionMedicationOrder,
} from "@chartwarden/dosespot";
import { and, asc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { isPrescriptionIdTaken, lockPrescriptionId } from "../prescription-id";
import { type M12CronDeps, errorClassOf, inOrg, isCircuitOpenError, nowOf } from "./cron-common";
import { reportDegradation, reportRecovery } from "./degradation-reports";
import { UNCONFIRMED_OUTCOME_CLASS } from "./hold";
import { DosespotSyncQueueRepository } from "./repository";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;
const SYNC = schema.dosespotPatientSync;
const DP = schema.dosespotPrescribers;

export const TRANSMIT_BATCH_SIZE = 25;
export const RECOVERY_BATCH_SIZE = 100;
/** An `in_flight` claim older than this is a crashed worker's; the recovery drain re-queues it. */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;
const DUPLICATE_ID_DETAIL =
  "DoseSpot returned a prescription id already recorded on another order, so this order was not marked sent. The prescription may exist at DoseSpot.";
const STALE_CALL_DETAIL =
  "A worker stopped after the call to DoseSpot was made, before the answer was recorded. The prescription may already exist at DoseSpot.";
const MAX_BACKOFF_MINUTES = 60;

type OrderRow = typeof MO.$inferSelect;
type TransmissionRow = typeof MOT.$inferSelect;

export interface TransmitPassResult {
  readonly claimed: number;
  readonly transmitted: number;
  readonly requeued: number;
  readonly failed: number;
  /** Orders held because DoseSpot accepted the call but did not confirm what it created: neither retried nor failed. */
  readonly held: number;
  /** Claims this worker no longer owned when it came to write (drained and taken over, or resolved meanwhile): nothing of its was written. */
  readonly skipped: number;
  readonly deferredByOutage: number;
  /** 1 when the org's config could not be read or opened, so the pass was skipped whole (no claim, no write); 0 otherwise. */
  readonly skippedConfigFault: number;
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
  /** The `updated_at` this claim wrote: the fence compares against it, so a claim that was drained and taken over no longer matches. */
  readonly claimedAt: Date;
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
      claimed.push({ order, transmission, claimedAt: now });
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

/**
 * The FENCE before a vendor call. In one committed transaction it (1) moves the order's `updated_at` from the claim's value to the call's, but
 * only while the order is still THIS worker's claim (`in_flight` with the `updated_at` this claim wrote), and (2) stamps the transmission row's
 * `transmission_started_at`. Zero rows at (1) means the claim was drained and taken over (or the order changed) while this worker was busy with
 * an earlier order of its batch: it returns false and the caller makes NO call, so the order cannot be sent twice with one key. Moving
 * `updated_at` also restarts the stale-claim clock at the call (it used to run from the claim, which a slow batch could outlast).
 * It returns the fence time: from here on the stamp is what the worker owns (see {@link Ownership}), the order's `updated_at` only keeps the stale clock.
 * A worker that dies after this and before its settle leaves a stale claim carrying the stamp, which the drain HOLDS instead of re-sending. A
 * failure here throws and the order is not called: it stays a claim without the stamp, which the drain releases.
 */
async function markCallStarted(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
): Promise<Date | null> {
  const now = nowOf(deps);
  return inOrg(deps.db, organizationId, async (tx) => {
    const fenced = await tx
      .update(MO)
      .set({ updatedAt: now })
      .where(
        and(
          eq(MO.id, c.order.id),
          eq(MO.status, "queued_for_transmission"),
          eq(MO.dosespotSendState, "in_flight"),
          eq(MO.updatedAt, c.claimedAt),
        ),
      )
      .returning({ id: MO.id });
    if (fenced.length !== 1) return null;
    const stamped = await tx
      .update(MOT)
      .set({ transmissionStartedAt: now })
      .where(eq(MOT.id, c.transmission.id))
      .returning({ id: MOT.id });
    if (stamped.length !== 1) throw new Error("transmission row vanished before the vendor call");
    return now;
  });
}

/**
 * Persist the id of a prescription that was CREATED at DoseSpot but not yet sent, on the transmission row, before the send. The order itself
 * carries an id only once it is really sent (webhooks bind by it). A failure here propagates: the send is not attempted, the order is retried.
 *
 * It answers only while the worker still owns the call (see {@link Ownership}): the adapter SENDS the prescription once this returns, so a worker
 * that lost the order meanwhile (an administrator resolved it NOT SENT, say) must not go on to send it. It throws instead, and the adapter stops
 * before the send. The prescription it just created stays at DoseSpot as an unsent draft, which the administrator's own check of the prescriber's
 * account shows. Locks the order, then the transmission row, like every other writer.
 */
async function rememberCreated(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  startedAt: Date,
  prescriptionId: string,
): Promise<void> {
  await inOrg(deps.db, organizationId, async (tx) => {
    if (!(await lockOwnership(tx, c, { stage: "call", startedAt }))) {
      throw new Error(
        "this worker no longer owns the order, so the created prescription is not sent",
      );
    }
    await tx
      .update(MOT)
      .set({ dosespotPrescriptionId: prescriptionId })
      .where(eq(MOT.id, c.transmission.id));
  });
}

type Outcome =
  | { kind: "success"; prescriptionId: string; transmittedAt: Date }
  | { kind: "outage" }
  | { kind: "superseded" }
  | { kind: "unconfirmed"; detail: string }
  | {
      kind: "failure";
      errorClass: string;
      detail: string;
      permanent: boolean;
      syncPatient: boolean;
    };

/**
 * What a worker owns when it comes to write. BEFORE the fence it owns the CLAIM: the order's `updated_at` that the claim wrote. AFTER the fence it
 * owns the CALL: the `transmission_started_at` the fence stamped on the transmission row. `updated_at` cannot stay the token after the fence: it
 * is shared with writes that have nothing to do with the claim (a coverage determination is allowed in every status, a correction bumps the
 * original order's version), and one of them during the call would turn the legitimate owner into a "skipped" one, orphaning a prescription
 * DoseSpot had accepted and leaving a stamp the drain then holds.
 */
type Ownership =
  | { readonly stage: "claim"; readonly claimedAt: Date }
  | { readonly stage: "call"; readonly startedAt: Date };

/** What a worker found, and what it owns when it comes to write it. */
interface Attempt {
  readonly outcome: Outcome;
  readonly owns: Ownership;
}

async function attemptOne(deps: M12CronDeps, organizationId: string, c: Claimed): Promise<Attempt> {
  const beforeFence = (outcome: Outcome): Attempt => ({
    outcome,
    owns: { stage: "claim", claimedAt: c.claimedAt },
  });
  const built = await buildPayload(deps, organizationId, c.order);
  if (built.kind === "patient_not_synced") {
    return beforeFence({
      kind: "failure",
      errorClass: "patient_not_synced",
      detail: "no DoseSpot patient id is recorded yet; a patient sync was requested",
      permanent: false,
      syncPatient: true,
    });
  }
  if (built.kind === "permanent") {
    return beforeFence({
      kind: "failure",
      errorClass: built.errorClass,
      detail: "the order cannot be transmitted as written",
      permanent: true,
      syncPatient: false,
    });
  }
  let startedAt: Date;
  try {
    // the fence: null = this worker no longer owns the claim (it was drained and taken over): make no call and touch nothing
    const fencedAt = await markCallStarted(deps, organizationId, c);
    if (fencedAt === null) return beforeFence({ kind: "superseded" });
    startedAt = fencedAt;
  } catch {
    // the stamp could not be committed, so the vendor was NOT called: the order waits (no retry spent) and the drain releases the claim
    return beforeFence({ kind: "outage" });
  }
  const owned = (outcome: Outcome): Attempt => ({ outcome, owns: { stage: "call", startedAt } });
  try {
    const res = await deps.client.transmitNewRx(
      organizationId,
      built.payload,
      c.transmission.idempotencyKey,
      {
        // a created-but-unsent id from an earlier attempt (possibly on another replica): the send is re-run, the create is not
        ...(c.transmission.dosespotPrescriptionId
          ? { createdPrescriptionId: c.transmission.dosespotPrescriptionId }
          : {}),
        onCreated: (id) => rememberCreated(deps, organizationId, c, startedAt, id),
      },
    );
    return owned({
      kind: "success",
      prescriptionId: res.dosespotPrescriptionId,
      transmittedAt: new Date(res.transmittedAt),
    });
  } catch (error) {
    // an open circuit, or a registration that stopped being live since this batch was claimed: the order WAITS (no retry spent)
    // A resolver / key-ring / KEK / credential / database fault (`ConfigUnavailableError`) is the platform's, not the order's: it waits too.
    if (isCircuitOpenError(error) || isNotEnabledError(error) || isConfigUnavailableError(error)) {
      return owned({ kind: "outage" });
    }
    // accepted but unreadable / no id: the prescription may exist, so the order is held, not failed and not retried
    if (isUnconfirmedOutcomeError(error)) {
      return owned({
        kind: "unconfirmed",
        detail: `${error.customerMessage} The prescription may already exist at DoseSpot.`,
      });
    }
    return owned({
      kind: "failure",
      errorClass: errorClassOf(error),
      detail: isDegradedError(error) ? error.customerMessage : "unexpected adapter failure",
      permanent: isDegradedError(error) && !error.retryable,
      syncPatient: false,
    });
  }
}

/**
 * A worker that no longer owns what it found writes nothing. It says so, with ids only and the KIND of what it discarded (never the content of it: a
 * success carries a prescription id), so a lost claim is visible whatever the worker found. A success is the case that matters most: DoseSpot
 * accepted a prescription for an order this worker could not record it on (an administrator resolved the order while the call ran, say).
 */
function discarded(
  deps: M12CronDeps,
  organizationId: string,
  orderId: string,
  found: Outcome["kind"],
): "skipped" {
  deps.warn?.(
    { organizationId, orderId, found },
    found === "success"
      ? "M12 transmit: DoseSpot accepted a prescription for an order this worker no longer owns; nothing was recorded here"
      : "M12 transmit: this worker no longer owns the order; what it found was discarded",
  );
  return "skipped";
}

/** The order row only while it is still in flight under the status it was claimed in and, before the fence, with the `updated_at` the claim wrote. */
function orderStillTheWorkers(orderId: string, owns: Ownership) {
  return and(
    eq(MO.id, orderId),
    eq(MO.status, "queued_for_transmission"),
    eq(MO.dosespotSendState, "in_flight"),
    owns.stage === "claim" ? eq(MO.updatedAt, owns.claimedAt) : undefined,
  );
}

/**
 * Lock what the worker owns and say whether it still owns it: the ORDER row, then (after the fence) the TRANSMISSION row carrying the stamp this
 * worker wrote. That is the order the administrator's resolution and the drain lock them in, so none of them can deadlock; the locks last to the end of the
 * transaction, so what is checked here still holds for every write after it.
 */
async function lockOwnership(tx: DbClient, c: Claimed, owns: Ownership): Promise<boolean> {
  const [order] = await tx
    .select({ id: MO.id })
    .from(MO)
    .where(orderStillTheWorkers(c.order.id, owns))
    .limit(1)
    .for("update");
  if (!order) return false;
  if (owns.stage === "claim") return true;
  const [stamp] = await tx
    .select({ id: MOT.id })
    .from(MOT)
    .where(and(eq(MOT.id, c.transmission.id), eq(MOT.transmissionStartedAt, owns.startedAt)))
    .limit(1)
    .for("update");
  return stamp !== undefined;
}

/**
 * SETTLE: write what the attempt found. Every write to the order is conditional on the claim still being THIS worker's (see {@link Ownership}), so
 * a worker whose claim was drained and taken over (a slow batch, a payload build that failed after a takeover), or whose order an administrator
 * resolved meanwhile, can neither requeue, exhaust, hold nor record over the new owner: it writes nothing and answers "skipped". Lock order is
 * the advisory lock for a prescription id (success only), then the ORDER row, then the transmission row.
 */
async function settle(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  attempt: Attempt,
): Promise<"transmitted" | "requeued" | "failed" | "deferred" | "held" | "skipped"> {
  const { outcome, owns } = attempt;
  // a superseded claim belongs to another worker now: nothing of this worker's is written
  if (outcome.kind === "superseded")
    return discarded(deps, organizationId, c.order.id, outcome.kind);
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
    /** Every MO write below repeats the predicate. */
    const stillMine = orderStillTheWorkers(orderId, owns);

    if (outcome.kind === "success")
      await lockPrescriptionId(tx, organizationId, outcome.prescriptionId);
    const lost = () => discarded(deps, organizationId, orderId, outcome.kind);
    if (!(await lockOwnership(tx, c, owns))) return lost();

    if (outcome.kind === "outage") {
      const back = await tx
        .update(MO)
        .set({ dosespotSendState: "queued", updatedAt: now })
        .where(stillMine)
        .returning({ id: MO.id });
      if (back.length !== 1) return lost();
      // nothing reached the vendor (an open circuit, a registration not live, a config fault, or the stamp itself failed): no call began, so the
      // stamp goes, and so does a hold the drain set while this worker was still in its call (the order is queued again, not "held")
      await tx
        .update(MOT)
        .set({
          transmissionStartedAt: null,
          lastErrorClass: sql`CASE WHEN ${MOT.lastErrorClass} = ${UNCONFIRMED_OUTCOME_CLASS} THEN NULL ELSE ${MOT.lastErrorClass} END`,
          lastErrorDetail: sql`CASE WHEN ${MOT.lastErrorClass} = ${UNCONFIRMED_OUTCOME_CLASS} THEN NULL ELSE ${MOT.lastErrorDetail} END`,
        })
        .where(eq(MOT.id, c.transmission.id));
      return "deferred";
    }

    // The order stays `in_flight` (nothing re-claims it: the claim takes only `queued`, and the drain skips a held one); only the row that
    // says why, and the event that tells a person, are written. No retry is spent and no failure timestamp is set.
    const hold = async (detail: string): Promise<"held"> => {
      const held = await tx
        .update(MOT)
        .set({ lastErrorClass: UNCONFIRMED_OUTCOME_CLASS, lastErrorDetail: detail })
        .where(
          and(
            eq(MOT.id, c.transmission.id),
            sql`${MOT.lastErrorClass} IS DISTINCT FROM ${UNCONFIRMED_OUTCOME_CLASS}`,
          ),
        )
        .returning({ id: MOT.id });
      // already held (the drain held this claim while the call was still running): announced once, not again
      if (held.length === 0) return "held";
      await emit("m12.medication_order.transmission_unconfirmed", {
        orderId,
        lastErrorClass: UNCONFIRMED_OUTCOME_CLASS,
      });
      return "held";
    };

    if (outcome.kind === "unconfirmed") return hold(outcome.detail);

    if (outcome.kind === "success") {
      // webhooks bind an order by its prescription id and take the first match: an id another order already carries must not be recorded
      // twice (the same guard the administrator's "sent" resolution uses). Held for a person, like any outcome that cannot be trusted.
      if (await isPrescriptionIdTaken(tx, organizationId, outcome.prescriptionId, orderId)) {
        return hold(DUPLICATE_ID_DETAIL);
      }
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
        .where(stillMine)
        .returning({ id: MO.id });
      if (o.length !== 1) return lost();
      await tx
        .update(MOT)
        .set({
          transmissionSucceededAt: outcome.transmittedAt,
          dosespotPrescriptionId: outcome.prescriptionId,
          dosespotResponseDigest: plan.transmissionUpdate.dosespotResponseDigest,
          // a hold the drain set while this call was still running is stale now that the call answered: clear it (any other class stays as history)
          lastErrorClass: sql`CASE WHEN ${MOT.lastErrorClass} = ${UNCONFIRMED_OUTCOME_CLASS} THEN NULL ELSE ${MOT.lastErrorClass} END`,
          lastErrorDetail: sql`CASE WHEN ${MOT.lastErrorClass} = ${UNCONFIRMED_OUTCOME_CLASS} THEN NULL ELSE ${MOT.lastErrorDetail} END`,
        })
        .where(eq(MOT.id, c.transmission.id));
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
    // the ORDER first (it is the ownership test), the transmission row only if the order matched
    const recordFailure = () =>
      tx
        .update(MOT)
        .set({
          transmissionFailedAt: now,
          // the attempt is over: a claim of the requeued order that later dies before its vendor call must not look like one that called
          ...(plan.exhausted ? {} : { transmissionStartedAt: null }),
          retryCount: plan.transmissionUpdate.retryCount,
          lastErrorClass: outcome.errorClass,
          lastErrorDetail: outcome.detail,
        })
        .where(eq(MOT.id, c.transmission.id));
    if (!plan.exhausted) {
      const back = await tx
        .update(MO)
        .set({ dosespotSendState: "queued", updatedAt: now })
        .where(stillMine)
        .returning({ id: MO.id });
      if (back.length !== 1) return lost();
      await recordFailure();
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
      .where(stillMine)
      .returning({ id: MO.id });
    if (o.length !== 1) return lost();
    await recordFailure();
    await emit(plan.event, {
      orderId,
      lastErrorClass: outcome.errorClass,
      retryCount: plan.transmissionUpdate.retryCount,
    });
    return "failed";
  });
}

/** The fault from resolving the org's config, or null when it resolves (or is not live: that is not a fault, the pass handles it). */
async function configFaultOf(deps: M12CronDeps, organizationId: string): Promise<unknown> {
  if (!deps.config) return null;
  try {
    await deps.config.configFor(organizationId, "operate");
    return null;
  } catch (fault) {
    return fault ?? new Error("unknown");
  }
}

/**
 * One org's transmit pass.
 *
 * The org's config is resolved ONCE, before anything is claimed. A credential or resolver fault (a corrupt sealed key, an unavailable key
 * ring or KEK, a database error) then skips the whole pass: no order is claimed, no row is updated, so no audit row is written, instead of
 * every queued order being claimed and put back on every tick. The fault is logged (org id and error class, never a message that could
 * carry a value), counted in the result, and alerted once per episode; the orders stay `queued` and the age alert covers how long.
 */
export async function runTransmitNewRxForOrg(
  deps: M12CronDeps,
  organizationId: string,
  batchSize = TRANSMIT_BATCH_SIZE,
): Promise<TransmitPassResult> {
  const fault = await configFaultOf(deps, organizationId);
  if (fault !== null) {
    const code = (fault as { code?: unknown }).code;
    deps.warn?.(
      {
        organizationId,
        cause: fault instanceof Error ? fault.name : "unknown",
        ...(typeof code === "string" ? { code } : {}),
      },
      "DoseSpot config could not be resolved; the transmit pass was skipped and the orders stay queued",
    );
    await reportDegradation(deps, organizationId, "config_unavailable");
    return {
      claimed: 0,
      transmitted: 0,
      requeued: 0,
      failed: 0,
      held: 0,
      skipped: 0,
      deferredByOutage: 0,
      skippedConfigFault: 1,
    };
  }
  await reportRecovery(deps, organizationId, "config_unavailable");
  const claimed = await claim(deps, organizationId, batchSize);
  let transmitted = 0;
  let requeued = 0;
  let failed = 0;
  let held = 0;
  let skipped = 0;
  let deferredByOutage = 0;
  for (const c of claimed) {
    const attempt = await attemptOne(deps, organizationId, c);
    const result = await settle(deps, organizationId, c, attempt);
    if (result === "transmitted") transmitted += 1;
    else if (result === "requeued") requeued += 1;
    else if (result === "failed") failed += 1;
    else if (result === "held") held += 1;
    else if (result === "skipped") skipped += 1;
    else deferredByOutage += 1;
  }
  return {
    claimed: claimed.length,
    transmitted,
    requeued,
    failed,
    held,
    skipped,
    deferredByOutage,
    skippedConfigFault: 0,
  };
}

/**
 * A stale claim whose transmission row says the vendor call BEGAN (`transmission_started_at`, stamped just before the call) belongs to a
 * worker that died, or whose settle failed, somewhere after that: DoseSpot may have accepted the prescription. It is HELD exactly like an
 * unconfirmed outcome (marker, detail, event) so the drain below skips it and a person is told, instead of being re-queued and re-sent.
 * A claim without the stamp never reached the vendor and is left for the release.
 */
async function holdStaleCallsInProgress(
  deps: M12CronDeps,
  tx: DbClient,
  organizationId: string,
  cutoff: Date,
): Promise<void> {
  // The candidates are chosen BY the stamp (a join), so the batch limit applies to the claims that need holding, not to stale claims in general:
  // a stamped claim cannot sit behind a hundred unstamped ones. Rows are locked on the order (the lock every writer of the order takes).
  const called = await tx
    .select({ id: MOT.id, orderId: MOT.medicationOrderId })
    .from(MOT)
    .innerJoin(MO, eq(MO.id, MOT.medicationOrderId))
    .where(
      and(
        eq(MO.status, "queued_for_transmission"),
        eq(MO.dosespotSendState, "in_flight"),
        lt(MO.updatedAt, cutoff),
        sql`${MOT.transmissionStartedAt} IS NOT NULL`,
        sql`${MOT.lastErrorClass} IS DISTINCT FROM ${UNCONFIRMED_OUTCOME_CLASS}`,
      ),
    )
    .limit(RECOVERY_BATCH_SIZE)
    .for("update", { of: MO, skipLocked: true });
  for (const t of called) {
    const held = await tx
      .update(MOT)
      .set({ lastErrorClass: UNCONFIRMED_OUTCOME_CLASS, lastErrorDetail: STALE_CALL_DETAIL })
      .where(
        and(
          eq(MOT.id, t.id),
          sql`${MOT.lastErrorClass} IS DISTINCT FROM ${UNCONFIRMED_OUTCOME_CLASS}`,
        ),
      )
      .returning({ id: MOT.id });
    // a worker set (or is setting) the marker itself: it announced it, so neither re-apply nor publish a second event
    if (held.length === 0) continue;
    await deps.outbox.publish(tx, {
      eventName: "m12.medication_order.transmission_unconfirmed",
      payload: { orderId: t.orderId, lastErrorClass: UNCONFIRMED_OUTCOME_CLASS },
      organizationId,
      aggregateKind: "medication_order",
      aggregateId: t.orderId,
    });
  }
}

/**
 * `dosespot.transmit_queued_on_recovery` (§4.8 / D11): re-queue claims a crashed worker abandoned (`in_flight`
 * past {@link IN_FLIGHT_STALE_MS}, except an order HELD for an unconfirmed outcome), then drain the accumulated `queued` backlog with the larger recovery batch.
 * Returns how many stale claims were released.
 */
export async function runRecoveryDrainForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<{ readonly released: number; readonly pass: TransmitPassResult }> {
  const now = nowOf(deps);
  const cutoff = new Date(now.getTime() - IN_FLIGHT_STALE_MS);
  const released = await inOrg(deps.db, organizationId, async (tx) => {
    await holdStaleCallsInProgress(deps, tx, organizationId, cutoff);
    const rows = await tx
      .update(MO)
      .set({ dosespotSendState: "queued", updatedAt: now })
      .where(
        and(
          eq(MO.status, "queued_for_transmission"),
          eq(MO.dosespotSendState, "in_flight"),
          lt(MO.updatedAt, cutoff),
          // an order HELD for an unconfirmed outcome, or whose call BEGAN (the stamp), is not a claim that never reached the vendor: re-queueing it
          // would send it again. A stamped claim beyond the hold batch above waits, unmoved, for the next drain to hold it.
          notExists(
            tx
              .select({ one: sql`1` })
              .from(MOT)
              .where(
                and(
                  eq(MOT.medicationOrderId, MO.id),
                  or(
                    eq(MOT.lastErrorClass, UNCONFIRMED_OUTCOME_CLASS),
                    sql`${MOT.transmissionStartedAt} IS NOT NULL`,
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ id: MO.id });
    return rows.length;
  });
  const pass = await runTransmitNewRxForOrg(deps, organizationId, RECOVERY_BATCH_SIZE);
  return { released, pass };
}
