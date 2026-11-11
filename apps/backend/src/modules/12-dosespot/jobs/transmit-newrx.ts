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
//   3. SETTLE (tx; `transmit-settle.ts`, with what a worker owns and the checks that stop a worker that lost the order in `transmit-ownership.ts`),
//      every UPDATE matches the order by ID and asserts the row count (the partition-key timestamp
//      round-trips lossily, so matching `created_at` never hits):
//        success    -> `transmitted` / send_state `transmitted`, prescription id recorded, `m12.medication_order.transmitted`.
//        breaker open -> back to `queued`, NO retry consumed (an outage must not exhaust the budget: that is what
//                       the queued-on-recovery drain exists for).
//        failure    -> the §4.10 planner: re-queue while budget remains, else `transmission_failed` + event; a
//                       permanent vendor rejection or an unfixable order exhausts immediately.
//        unconfirmed -> DoseSpot may have acted on the call but did not confirm it (a 2xx that was unreadable or carried no id, a send
//                       whose answer was lost, or a send answered with a 5xx other than 503): the prescription may already exist there. The order is HELD, still `in_flight`, its transmission row naming why
//                       (`UNCONFIRMED_OUTCOME_CLASS` (hold.ts)): not failed (it did not fail), not re-queued, not retried, and skipped by the
//                       stale-claim drain (a second send could dispense twice). `m12.medication_order.transmission_unconfirmed` is
//                       published in the same transaction and M36 tells the tenant's administrators, who check the prescriber's DoseSpot
//                       account and either find it sent or discontinue the order and sign a new one.
// Nothing here ever marks an order transmitted without a real `DoseSpotNewRxResponse`.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type DoseSpotNewRxPayload,
  isConfigUnavailableError,
  isDegradedError,
  isNotEnabledError,
  isUnconfirmedOutcomeError,
} from "@chartwarden/dosespot";
import { and, asc, eq, exists, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { readRegistrationTarget } from "../tenant-config/registration-target";
import { type M12CronDeps, errorClassOf, inOrg, isCircuitOpenError, nowOf } from "./cron-common";
import { reportDegradation, reportRecovery } from "./degradation-reports";
import { UNCONFIRMED_OUTCOME_CLASS } from "./hold";
import { type Claimed, rememberCreated, requireOwnership } from "./transmit-ownership";
import { type Attempt, type Outcome, settle } from "./transmit-settle";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;
const SYNC = schema.dosespotPatientSync;
const DP = schema.dosespotPrescribers;

export const TRANSMIT_BATCH_SIZE = 25;
export const RECOVERY_BATCH_SIZE = 100;
/** An `in_flight` claim older than this is a crashed worker's; the recovery drain re-queues it. */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;
const STALE_CALL_DETAIL =
  "A worker stopped after the call to DoseSpot was made, before the answer was recorded. The prescription may already exist at DoseSpot.";
const MAX_BACKOFF_MINUTES = 60;

type OrderRow = typeof MO.$inferSelect;

export interface TransmitPassResult {
  readonly claimed: number;
  readonly transmitted: number;
  readonly requeued: number;
  readonly failed: number;
  /** Orders held because DoseSpot did not confirm what became of the call: neither retried nor failed. */
  readonly held: number;
  /** Claims this worker no longer owned when it came to write (drained and taken over, or resolved meanwhile): nothing of its was written. */
  readonly skipped: number;
  readonly deferredByOutage: number;
  /** 1 when the org's config could not be read or opened, so the pass was skipped whole (no claim, no write); 0 otherwise. */
  readonly skippedConfigFault: number;
  /**
   * Orders whose attempt or settle THREW (a database fault, a bug): logged with ids only and passed over so the rest of the batch still goes.
   * The order is left as the throw found it (an `in_flight` claim, stamped or not), which the recovery drain releases or holds.
   */
  readonly errored: number;
}

/** Minutes to wait after the Nth failed attempt: 1, 2, 4, 8, ... capped. */
export const backoffMinutes = (retryCount: number): number =>
  Math.min(2 ** Math.max(0, retryCount - 1), MAX_BACKOFF_MINUTES);

/** {@link backoffMinutes} in SQL: a transmission row whose retry backoff has elapsed at `now` (or that never failed). */
const dueForAttemptSql = (now: Date) =>
  sql`(${MOT.retryCount} = 0 OR ${MOT.transmissionFailedAt} IS NULL OR ${MOT.transmissionFailedAt}
    + make_interval(mins => LEAST(power(2, GREATEST(0, ${MOT.retryCount} - 1)), ${MAX_BACKOFF_MINUTES})::int)
    <= ${now.toISOString()}::timestamptz)`;

async function claim(
  deps: M12CronDeps,
  organizationId: string,
  batchSize: number,
): Promise<readonly Claimed[]> {
  const now = nowOf(deps);
  return inOrg(deps.db, organizationId, async (tx) => {
    // Only orders that HAVE a transmission row whose retry backoff has elapsed are candidates (`mot_order_idx`): the batch is chosen before the
    // rows are read, so an order without one (an orphan), or one still waiting out its backoff, would otherwise take a batch slot (and its row
    // lock) every tick, and enough of them, older than the real orders, would fill the whole batch.
    const candidates = await tx
      .select()
      .from(MO)
      .where(
        and(
          eq(MO.status, "queued_for_transmission"),
          eq(MO.dosespotSendState, "queued"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(MOT)
              .where(
                and(
                  eq(MOT.organizationId, organizationId),
                  eq(MOT.medicationOrderId, MO.id),
                  dueForAttemptSql(now),
                ),
              ),
          ),
          // An order whose prescriber is on the roster, not revoked, and has no vendor id yet is WAITING for the re-enrolment that follows a
          // registration move (ADR-0111 D6): it is not claimed at all, so it costs no write per tick and cannot fill the batch ahead of an order
          // that can go. It becomes claimable the moment the prescriber is linked. A revoked prescriber is not parked: the order still fails.
          notExists(
            tx
              .select({ one: sql`1` })
              .from(DP)
              .where(
                and(
                  eq(DP.organizationId, organizationId),
                  eq(DP.membershipId, MO.prescriberMembershipId),
                  isNull(DP.revokedAt),
                  isNull(DP.dosespotPrescriberId),
                ),
              ),
          ),
        ),
      )
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
      if (!transmission) continue;
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
  | {
      readonly kind: "payload";
      readonly payload: DoseSpotNewRxPayload;
      /**
       * The registration target the payload's vendor ids were read under (read BEFORE them, in the same transaction): the stamp refuses to start
       * the call if the registration names another clinic by then, because the ids in the payload may be the old clinic's.
       */
      readonly target: string;
    }
  | { readonly kind: "patient_not_synced" }
  /**
   * The prescriber is on the roster and not revoked but holds no DoseSpot id: the registration moved to another clinic since the order was
   * signed and the roster's ids were cleared (ADR-0111 D6). The claim already leaves such an order alone, so this is only the race where the
   * clear landed after the claim: the order WAITS for the re-enrolment (nothing is sent, no retry is spent).
   */
  | { readonly kind: "prescriber_enrolment_pending" }
  | { readonly kind: "permanent"; readonly errorClass: string };

/** Assemble the NewRx from the stored order + the recorded vendor ids. Never defaults a clinical field. */
async function buildPayload(
  deps: M12CronDeps,
  organizationId: string,
  order: OrderRow,
): Promise<Built> {
  const facts = await inOrg(deps.db, organizationId, async (tx) => {
    // FIRST, before the vendor ids below: a move that commits between this read and those leaves ids this target does not name, and the stamp sees it
    const target = await readRegistrationTarget(tx, organizationId);
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
    return {
      target,
      patientId: sync?.id ?? null,
      onRoster: prescriber !== undefined,
      prescriberId: prescriber?.id ?? null,
    };
  });
  if (facts.patientId === null) return { kind: "patient_not_synced" };
  if (facts.prescriberId === null) {
    // a prescriber who is no longer on the roster (revoked, or never was) cannot send: permanent. One who is on it with no vendor id is
    // waiting to be re-enrolled under the new clinic: the order waits too (the queued-order age alert tells the tenant's administrators).
    return facts.onRoster
      ? { kind: "prescriber_enrolment_pending" }
      : { kind: "permanent", errorClass: "prescriber_not_enrolled" };
  }
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
    target: facts.target,
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

/** What {@link markCallStarted} returns: the nonce it wrote, and what the call is made with. */
interface CallStart {
  readonly token: string;
  /** The registration target the call begins under (see registration-target.ts). */
  readonly target: string;
  /** A created-but-unsent prescription id an earlier attempt persisted, as the row holds it now; null when there is none. */
  readonly createdPrescriptionId: string | null;
  /** The key the call is made with, as the row holds it now. */
  readonly idempotencyKey: string;
}

/**
 * The registration named another clinic at the stamp than when the payload's vendor ids were read. Thrown inside the stamp's transaction, so the stamp
 * is rolled back and the vendor is not called: the ids in the payload may be the old clinic's, and sent under the new one they are refused for good.
 * The order waits (no retry spent) and its payload is built again. Carries no id.
 */
class RegistrationMovedBeforeCallError extends Error {
  constructor() {
    super(
      "the registration moved to another clinic after the payload was built; the call was not started",
    );
    this.name = "RegistrationMovedBeforeCallError";
  }
}

/**
 * The FENCE before a vendor call. In one committed transaction it (1) moves the order's `updated_at` from the claim's value to the call's, but
 * only while the order is still THIS worker's claim (`in_flight` with the `updated_at` this claim wrote), and (2) stamps the transmission row's
 * `transmission_started_at`. Zero rows at (1) means the claim was drained and taken over (or the order changed) while this worker was busy with
 * an earlier order of its batch: it returns false and the caller makes NO call, so the order cannot be sent twice with one key. Moving
 * `updated_at` also restarts the stale-claim clock at the call (it used to run from the claim, which a slow batch could outlast).
 * It returns the nonce it wrote with the stamp (`call_token`): from here on that token is what the worker owns (see {@link Ownership}), the order's
 * `updated_at` only keeps the stale clock. A random uuid, not the stamp's time: two cycles that stamp the same instant must still be told apart.
 * A worker that dies after this and before its settle leaves a stale claim carrying the stamp, which the drain HOLDS instead of re-sending. A
 * failure here throws and the order is not called: it stays a claim without the stamp, which the drain releases.
 *
 * It also returns what the transmission row holds AT THE STAMP: the created prescription id and the idempotency key the call is made with. Not
 * what the claim read: the registration's clear touches a claimed order that is not yet stamped (it drops the old clinic's id and replaces the key),
 * and in a batch an order is stamped only after the vendor calls of the ones before it, so the claim's copy may be a whole batch old. The stamp
 * holds the row lock, so a clear that reaches the row waits for it and then finds it stamped and leaves it; what the stamp returns is what the clear
 * left, and the target read after it is the clinic those values belong to.
 *
 * `payloadTarget` is the target the payload's vendor ids were read under: if the registration names another clinic by the stamp, those ids may be the
 * old clinic's, so it throws {@link RegistrationMovedBeforeCallError} and nothing is stamped. (A move A -> B -> A, with a re-enrolment in between, all
 * inside the milliseconds between the payload and the stamp, would read as unchanged: the same accepted ABA as registration-target.ts.)
 */
async function markCallStarted(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  payloadTarget: string,
): Promise<CallStart | null> {
  const now = nowOf(deps);
  const token = randomUUID();
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
    const [stamped] = await tx
      .update(MOT)
      .set({ transmissionStartedAt: now, callToken: token })
      .where(eq(MOT.id, c.transmission.id))
      .returning({
        createdPrescriptionId: MOT.dosespotPrescriptionId,
        idempotencyKey: MOT.idempotencyKey,
      });
    if (!stamped) throw new Error("transmission row vanished before the vendor call");
    // the clinic the registration names as the call begins: the writes that follow (the created id, the send) are refused if it moves
    const target = await readRegistrationTarget(tx, organizationId);
    if (target !== payloadTarget) throw new RegistrationMovedBeforeCallError();
    return { token, target, ...stamped };
  });
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
  if (built.kind === "prescriber_enrolment_pending") return beforeFence({ kind: "outage" });
  if (built.kind === "permanent") {
    return beforeFence({
      kind: "failure",
      errorClass: built.errorClass,
      detail: "the order cannot be transmitted as written",
      permanent: true,
      syncPatient: false,
    });
  }
  let start: CallStart;
  try {
    // the fence: null = this worker no longer owns the claim (it was drained and taken over): make no call and touch nothing
    const fenced = await markCallStarted(deps, organizationId, c, built.target);
    if (fenced === null) return beforeFence({ kind: "superseded" });
    start = fenced;
  } catch (fault) {
    // the stamp could not be committed (or the registration moved after the payload was built, which rolls the stamp back), so the vendor was NOT
    // called: the order waits (no retry spent) and the drain releases the claim
    deps.warn?.(
      {
        organizationId,
        orderId: c.order.id,
        cause: fault instanceof Error ? fault.name : "unknown",
      },
      "M12 transmit: the call-started stamp could not be committed; the vendor was not called and the order waits",
    );
    return beforeFence({ kind: "outage" });
  }
  const { token, target } = start;
  const owned = (outcome: Outcome): Attempt => ({
    outcome,
    owns: { stage: "call", token, target },
  });
  try {
    const res = await deps.client.transmitNewRx(
      organizationId,
      built.payload,
      start.idempotencyKey,
      {
        // a created-but-unsent id from an earlier attempt (possibly on another replica): the send is re-run, the create is not
        ...(start.createdPrescriptionId
          ? { createdPrescriptionId: start.createdPrescriptionId }
          : {}),
        // every request of the call is refused if the registration names another clinic than the one the stamp read (the adapter resolves the config again
        // for each request: transmit-ownership.ts guards the DB writes, this guards the requests)
        expectedTarget: target,
        onCreated: (id) => rememberCreated(deps, organizationId, c, token, id, target),
        beforeSend: () => requireOwnership(deps, organizationId, c, token, target),
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
    // an unconfirmed outcome (an unreadable 2xx or no id, a lost send answer, a send 5xx but 503): the prescription may exist, so the order
    // is held, not failed and not retried
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
      errored: 0,
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
  let errored = 0;
  for (const c of claimed) {
    let result: Awaited<ReturnType<typeof settle>>;
    try {
      result = await settle(deps, organizationId, c, await attemptOne(deps, organizationId, c));
    } catch (error) {
      // one order's fault must not strand the rest of the batch: say so with ids and the error class only (never a message: a database
      // error embeds bound values), and go on. The order stays as the throw left it; the recovery drain releases or holds it.
      errored += 1;
      deps.warn?.(
        {
          organizationId,
          orderId: c.order.id,
          cause: error instanceof Error ? error.name : "unknown",
          errorClass: errorClassOf(error),
        },
        "M12 transmit: an order's attempt or settle threw; it was passed over and the batch went on",
      );
      continue;
    }
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
    errored,
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
