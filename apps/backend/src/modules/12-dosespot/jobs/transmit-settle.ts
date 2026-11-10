// apps/backend/src/modules/12-dosespot/jobs/transmit-settle.ts — SETTLE, the last step of one transmit attempt (split out of transmit-newrx.ts).
//
// The worker found something (`Outcome`) while owning something (`Ownership`, transmit-ownership.ts). Here it writes it, in ONE transaction, and only
// while it still owns it: a worker whose claim was drained and taken over (a slow batch, a payload build that failed after a takeover), or whose order an
// administrator resolved meanwhile, can neither requeue, exhaust, hold nor record over the new owner. It writes nothing and answers "skipped".
//   success      -> `transmitted`, the prescription id recorded, `m12.medication_order.transmitted` (an id another order carries is HELD instead)
//   outage       -> back to `queued`, no retry spent, the stamp (and a stale hold) cleared
//   failure      -> the §4.10 planner: requeue while budget remains, else `transmission_failed` + event
//   unconfirmed  -> HELD for a person: the order stays in flight, its transmission row naming why, `transmission_unconfirmed` published
// An outage or a failure of a call that BEGAN under a clinic the registration no longer names (a move: the clear skipped the stamped row) also drops the old
// clinic's created prescription id and idempotency key and, whatever it found, goes back to `queued` with no retry spent (`settleMoved`).
// Lock order is the advisory lock (for a prescription id on a success; the registration's bindings lock, shared, on an outage or a failure of a call),
// then the ORDER row, then the transmission row. The bindings lock comes FIRST because the clear takes it exclusively and then updates transmission rows:
// taking it after this transaction's row locks would let the two wait on each other.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  RX_TRANSMISSION_MAX_RETRIES,
  planTransmissionFailure,
  planTransmissionSuccess,
  transitionMedicationOrder,
} from "@chartwarden/dosespot";
import { and, eq, sql } from "drizzle-orm";
import { isPrescriptionIdTaken, lockPrescriptionId } from "../prescription-id";
import { vendorWriteIsCurrent } from "../tenant-config/registration-target";
import { type M12CronDeps, inOrg, nowOf } from "./cron-common";
import { UNCONFIRMED_OUTCOME_CLASS } from "./hold";
import { DosespotSyncQueueRepository } from "./repository";
import {
  type Claimed,
  type Ownership,
  discarded,
  lockOwnership,
  orderStillTheWorkers,
  retargetedBindings,
  warnRegistrationMoved,
} from "./transmit-ownership";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;

const DUPLICATE_ID_DETAIL =
  "DoseSpot returned a prescription id already recorded on another order, so this order was not marked sent. The prescription may exist at DoseSpot.";

export type Outcome =
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

/** What a worker found, and what it owns when it comes to write it. */
export interface Attempt {
  readonly outcome: Outcome;
  readonly owns: Ownership;
}

export type SettleResult = "transmitted" | "requeued" | "failed" | "deferred" | "held" | "skipped";

/** What every branch of the settle shares: the transaction (locks held), the claim, and the writers that repeat the ownership predicate. */
interface SettleCtx {
  readonly tx: DbClient;
  readonly organizationId: string;
  readonly c: Claimed;
  readonly orderId: string;
  readonly deps: M12CronDeps;
  readonly now: Date;
  /** Every order write repeats this predicate. */
  readonly stillMine: ReturnType<typeof orderStillTheWorkers>;
  readonly emit: (eventName: string, payload: Record<string, unknown>) => Promise<void>;
  /** The ownership was lost between the lock and a write: nothing is written, the result is discarded (said, ids only). */
  readonly lost: () => "skipped";
}

/** A hold the drain set while this call was still running is stale once the call answered: clear it (any other class stays as history). */
const clearedHoldClass = sql`CASE WHEN ${MOT.lastErrorClass} = ${UNCONFIRMED_OUTCOME_CLASS} THEN NULL ELSE ${MOT.lastErrorClass} END`;
const clearedHoldDetail = sql`CASE WHEN ${MOT.lastErrorClass} = ${UNCONFIRMED_OUTCOME_CLASS} THEN NULL ELSE ${MOT.lastErrorDetail} END`;

async function settleOutage(x: SettleCtx, movedClinic = false): Promise<SettleResult> {
  const { tx, c, now, stillMine } = x;
  const back = await tx
    .update(MO)
    .set({ dosespotSendState: "queued", updatedAt: now })
    .where(stillMine)
    .returning({ id: MO.id });
  if (back.length !== 1) return x.lost();
  // an outage: an open circuit, a registration not live, a config fault, the stamp itself failing, or (`movedClinic`) a call that ended after the
  // registration moved to another clinic. Either way the attempt is over and spent nothing, so the stamp and its token go, and so does a hold the
  // drain set while this worker was still in its call (the order is queued again, not "held")
  await tx
    .update(MOT)
    .set({
      transmissionStartedAt: null,
      callToken: null,
      lastErrorClass: clearedHoldClass,
      lastErrorDetail: clearedHoldDetail,
      // the registration moved to another clinic during the call: the old clinic's created id and key do not go with the order into its requeue
      ...(movedClinic ? retargetedBindings() : {}),
    })
    .where(eq(MOT.id, c.transmission.id));
  if (movedClinic) warnRegistrationMoved(x.deps, x.organizationId, x.orderId);
  return "deferred";
}

/**
 * The call began under one clinic and the registration names another now (and the call did not end in a send whose outcome a person must check): the
 * order WAITS for the new registration whatever the call found, since a failure after a move may be the move's doing (a send under the new clinic with
 * the old clinic's prescription id is refused for good), so no retry is spent and nothing is exhausted. It leaves no old-clinic id or key behind.
 */
const settleMoved = (x: SettleCtx): Promise<SettleResult> => settleOutage(x, true);

/** Did the registration move to another clinic since this call began? Only an outage or a failure of a call that began is asked (see the header). */
async function registrationMovedSince(
  tx: DbClient,
  organizationId: string,
  attempt: Attempt,
): Promise<boolean> {
  const { outcome, owns } = attempt;
  if (owns.stage !== "call" || (outcome.kind !== "outage" && outcome.kind !== "failure")) {
    return false;
  }
  return !(await vendorWriteIsCurrent(tx, organizationId, owns.target));
}

/**
 * HOLD for a person. The order stays `in_flight` (nothing re-claims it: the claim takes only `queued`, and the drain skips a held one); only the
 * row that says why, and the event that tells a person, are written. No retry is spent and no failure timestamp is set.
 */
async function holdForPerson(x: SettleCtx, detail: string): Promise<"held"> {
  const { tx, c, orderId } = x;
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
  // already held (the drain held this claim while the call was still running): announced once, not again. The drain knew only that a worker
  // stopped; this worker knows WHY (a duplicate id, an unreadable answer), which is what the administrator reads, so the detail is replaced.
  if (held.length === 0) {
    await tx.update(MOT).set({ lastErrorDetail: detail }).where(eq(MOT.id, c.transmission.id));
    return "held";
  }
  await x.emit("m12.medication_order.transmission_unconfirmed", {
    orderId,
    lastErrorClass: UNCONFIRMED_OUTCOME_CLASS,
  });
  return "held";
}

async function settleSuccess(
  x: SettleCtx,
  outcome: Extract<Outcome, { kind: "success" }>,
): Promise<SettleResult> {
  const { tx, organizationId, c, orderId, now, stillMine } = x;
  // webhooks bind an order by its prescription id and take the first match: an id another order already carries must not be recorded
  // twice (the same guard the administrator's "sent" resolution uses). Held for a person, like any outcome that cannot be trusted.
  if (await isPrescriptionIdTaken(tx, organizationId, outcome.prescriptionId, orderId)) {
    return holdForPerson(x, DUPLICATE_ID_DETAIL);
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
  if (o.length !== 1) return x.lost();
  await tx
    .update(MOT)
    .set({
      transmissionSucceededAt: outcome.transmittedAt,
      dosespotPrescriptionId: outcome.prescriptionId,
      dosespotResponseDigest: plan.transmissionUpdate.dosespotResponseDigest,
      lastErrorClass: clearedHoldClass,
      lastErrorDetail: clearedHoldDetail,
    })
    .where(eq(MOT.id, c.transmission.id));
  await x.emit(plan.event, {
    orderId,
    dosespotPrescriptionId: outcome.prescriptionId,
    transmittedAt: outcome.transmittedAt.toISOString(),
    dispensingPharmacyMdmId: c.order.dispensingPharmacyMdmId ?? null,
  });
  return "transmitted";
}

async function settleFailure(
  x: SettleCtx,
  outcome: Extract<Outcome, { kind: "failure" }>,
): Promise<SettleResult> {
  const { tx, organizationId, c, orderId, now, stillMine } = x;
  // permanent rejections exhaust the budget at once
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
        ...(plan.exhausted ? {} : { transmissionStartedAt: null, callToken: null }),
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
    if (back.length !== 1) return x.lost();
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
  if (o.length !== 1) return x.lost();
  await recordFailure();
  await x.emit(plan.event, {
    orderId,
    lastErrorClass: outcome.errorClass,
    retryCount: plan.transmissionUpdate.retryCount,
  });
  return "failed";
}

/** SETTLE: write what the attempt found, if the worker still owns it (see the header). */
export async function settle(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  attempt: Attempt,
): Promise<SettleResult> {
  const { outcome, owns } = attempt;
  const orderId = c.order.id;
  // a superseded claim belongs to another worker now: nothing of this worker's is written
  if (outcome.kind === "superseded") return discarded(deps, organizationId, orderId, outcome.kind);
  const now = nowOf(deps);
  return inOrg(deps.db, organizationId, async (tx) => {
    const ctx: SettleCtx = {
      tx,
      organizationId,
      c,
      orderId,
      deps,
      now,
      stillMine: orderStillTheWorkers(orderId, owns),
      emit: (eventName, payload) =>
        deps.outbox.publish(tx, {
          eventName,
          payload,
          organizationId,
          aggregateKind: "medication_order",
          aggregateId: orderId,
        }),
      lost: () => discarded(deps, organizationId, orderId, outcome.kind),
    };
    // FIRST, before any row lock (see the header)
    const movedClinic = await registrationMovedSince(tx, organizationId, attempt);
    if (outcome.kind === "success")
      await lockPrescriptionId(tx, organizationId, outcome.prescriptionId);
    if (!(await lockOwnership(tx, c, owns))) return ctx.lost();
    if (movedClinic) return settleMoved(ctx);
    switch (outcome.kind) {
      case "outage":
        return settleOutage(ctx);
      case "unconfirmed":
        return holdForPerson(ctx, outcome.detail);
      case "success":
        return settleSuccess(ctx, outcome);
      case "failure":
        return settleFailure(ctx, outcome);
    }
  });
}
