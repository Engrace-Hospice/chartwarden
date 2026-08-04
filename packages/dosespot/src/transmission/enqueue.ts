// @wardenx/dosespot — the `medication_order_transmission` enqueue + outcome planners (M12-T06, spec §2.2 /
// §4.10 / §5.1 W-MR-01 / D8). PURE decision logic the `enqueue-transmission` service + `transmit-newrx`
// worker (M12-T08) execute: it never touches the DB or the DoseSpot adapter — it returns the row descriptors
// and the orthogonal `dosespot_send_state` / `medication_order_status` transitions as data. The lifecycle
// machine (§2.2, `lifecycle/`) owns the aggregate-status edge; this module owns the transmission ROW lifecycle
// and the §4.10 retry-exhaustion escalation. Determinism: `nowInstant` + `retryCount` are injected, never read.
import type {
  DoseSpotSendState,
  M12AlertPayload,
  M12EventName,
  MedicationOrderStatus,
} from "@wardenx/types";

/** §4.10 — the BullMQ job-level retry budget for a NewRx transmission (distinct from the per-call backoff in
 * `client/retry.ts`). On the 5th failed attempt the row flips to `transmission_failed` + a high-sev M36 alert. */
export const RX_TRANSMISSION_MAX_RETRIES = 5;

/** §4.9 — the `medication_order.transmission_failed` alert eventType (the discriminant of {@link M12AlertPayload}). */
export type TransmissionFailedAlert = Extract<
  M12AlertPayload,
  { eventType: "medication_order.transmission_failed" }
>;

/** §3.3 — the `medication_order_transmission` insert the enqueue step writes (a leaf projection of the row;
 * the service binds it to the Drizzle insert — this package never imports `@wardenx/db`). */
export interface PlannedTransmissionInsert {
  readonly medicationOrderId: string;
  readonly idempotencyKey: string;
  readonly rxBusinessKey: string;
  readonly correlationId: string;
  readonly retryCount: 0;
}

/** The §5.1 enqueue result: the transmission row to insert + the aggregate's orthogonal state transitions. */
export interface PlannedTransmissionEnqueue {
  readonly insert: PlannedTransmissionInsert;
  readonly status: Extract<MedicationOrderStatus, "queued_for_transmission">;
  readonly sendState: Extract<DoseSpotSendState, "queued">;
  readonly event: Extract<M12EventName, "m12.medication_order.queued_for_transmission">;
}

/** The §3.3 inputs to {@link planTransmissionEnqueue} (the precomputed D8 keys + correlation). */
export interface TransmissionEnqueueInput {
  readonly medicationOrderId: string;
  readonly idempotencyKey: string;
  readonly rxBusinessKey: string;
  readonly correlationId: string;
}

/**
 * `planTransmissionEnqueue` — at sign (§5.1 W-MR-01), declare the `medication_order_transmission` insert with
 * the D8 idempotency key (the unique `(organization_id, idempotency_key)` constraint makes a double-sign a
 * no-op), move the aggregate to `queued_for_transmission` / `dosespot_send_state='queued'`, and name the
 * `m12.medication_order.queued_for_transmission` outbox event. The BullMQ enqueue itself runs after commit.
 */
export function planTransmissionEnqueue(
  input: TransmissionEnqueueInput,
): PlannedTransmissionEnqueue {
  return {
    insert: {
      medicationOrderId: input.medicationOrderId,
      idempotencyKey: input.idempotencyKey,
      rxBusinessKey: input.rxBusinessKey,
      correlationId: input.correlationId,
      retryCount: 0,
    },
    status: "queued_for_transmission",
    sendState: "queued",
    event: "m12.medication_order.queued_for_transmission",
  };
}

/** The §5.1 success result the `transmit-newrx` worker applies on a `DoseSpotNewRxResponse`. */
export interface PlannedTransmissionSuccess {
  readonly transmissionUpdate: {
    readonly transmissionSucceededAt: string;
    readonly dosespotPrescriptionId: string;
    readonly dosespotResponseDigest: string;
  };
  readonly status: Extract<MedicationOrderStatus, "transmitted">;
  readonly sendState: Extract<DoseSpotSendState, "transmitted">;
  readonly event: Extract<M12EventName, "m12.medication_order.transmitted">;
}

/** Inputs to {@link planTransmissionSuccess} (the adapter's response, post-success). */
export interface TransmissionSuccessInput {
  readonly dosespotPrescriptionId: string;
  readonly dosespotResponseDigest: string;
  readonly nowInstant: string;
}

/**
 * `planTransmissionSuccess` — on a successful adapter call, stamp `transmission_succeeded_at` +
 * `dosespot_prescription_id` on the row and move the aggregate to `transmitted` / `dosespot_send_state=
 * 'transmitted'`, emitting `m12.medication_order.transmitted` (§5.1; the webhook `ScriptStatusUpdate` later
 * flips it to `active`).
 */
export function planTransmissionSuccess(
  input: TransmissionSuccessInput,
): PlannedTransmissionSuccess {
  return {
    transmissionUpdate: {
      transmissionSucceededAt: input.nowInstant,
      dosespotPrescriptionId: input.dosespotPrescriptionId,
      dosespotResponseDigest: input.dosespotResponseDigest,
    },
    status: "transmitted",
    sendState: "transmitted",
    event: "m12.medication_order.transmitted",
  };
}

/** The §4.10 failure result — either a re-queue (retry budget remains) or the terminal exhaustion flip. */
export type PlannedTransmissionFailure =
  | {
      readonly exhausted: false;
      readonly transmissionUpdate: {
        readonly transmissionFailedAt: string;
        readonly retryCount: number;
        readonly lastErrorClass: string;
      };
      /** Re-queue with BullMQ backoff; the aggregate stays `queued_for_transmission`. */
      readonly requeue: true;
    }
  | {
      readonly exhausted: true;
      readonly transmissionUpdate: {
        readonly transmissionFailedAt: string;
        readonly retryCount: number;
        readonly lastErrorClass: string;
      };
      readonly status: Extract<MedicationOrderStatus, "transmission_failed">;
      readonly sendState: Extract<DoseSpotSendState, "failed">;
      readonly event: Extract<M12EventName, "m12.medication_order.transmission_failed">;
      readonly alert: TransmissionFailedAlert;
    };

/** Inputs to {@link planTransmissionFailure} (the CURRENT retry count + the PHI-free degraded-error class). */
export interface TransmissionFailureInput {
  readonly medicationOrderId: string;
  /** The transmission row's retry count BEFORE this attempt (the planner increments it). */
  readonly currentRetryCount: number;
  /** The `DegradedError`/`RetryableError` class — PHI-free; `last_error_detail` is denylisted separately (§7.6). */
  readonly lastErrorClass: string;
  readonly nowInstant: string;
}

/**
 * `planTransmissionFailure` — fold one failed adapter attempt into the row: increment `retry_count`, stamp
 * `transmission_failed_at`. While the incremented count is below {@link RX_TRANSMISSION_MAX_RETRIES} the job
 * re-queues (the aggregate stays `queued_for_transmission`). On the 5th failure the aggregate flips to
 * `transmission_failed` / `dosespot_send_state='failed'`, emits `m12.medication_order.transmission_failed`, and
 * dispatches the §4.9 high-severity M36 alert. Deterministic — same (count, class, instant) → same plan.
 */
export function planTransmissionFailure(
  input: TransmissionFailureInput,
): PlannedTransmissionFailure {
  const retryCount = input.currentRetryCount + 1;
  const transmissionUpdate = {
    transmissionFailedAt: input.nowInstant,
    retryCount,
    lastErrorClass: input.lastErrorClass,
  };
  if (retryCount < RX_TRANSMISSION_MAX_RETRIES) {
    return { exhausted: false, transmissionUpdate, requeue: true };
  }
  return {
    exhausted: true,
    transmissionUpdate,
    status: "transmission_failed",
    sendState: "failed",
    event: "m12.medication_order.transmission_failed",
    alert: {
      eventType: "medication_order.transmission_failed",
      orderId: input.medicationOrderId,
      retryCount,
      lastErrorClass: input.lastErrorClass,
      severity: "high",
    },
  };
}
