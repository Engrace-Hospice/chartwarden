// @chartwarden/dosespot — the NewRx transmission domain (M12-T06, spec §2.2 / §4.10 / D8). The D8 idempotency-key
// computation (`rx-business-key` + `sig-canonicalize`) that makes a double-sign a no-op at the pharmacy, and
// the PURE `medication_order_transmission` enqueue / success / failure planners (with the §4.10 retry-budget
// exhaustion that flips the row to `transmission_failed` + the §4.9 M36 alert). IO-free; the service + worker
// (M12-T08) bind these to the DB + the `DoseSpotClient` adapter.
export { canonicalizeSig } from "./sig-canonicalize";
export {
  computeNewRxIdempotencyKey,
  computeRxBusinessKey,
  type NewRxIdempotencyKeyInput,
  type RxBusinessKeyInput,
} from "./rx-business-key";
export {
  RX_TRANSMISSION_MAX_RETRIES,
  planTransmissionEnqueue,
  planTransmissionFailure,
  planTransmissionSuccess,
  type PlannedTransmissionEnqueue,
  type PlannedTransmissionFailure,
  type PlannedTransmissionInsert,
  type PlannedTransmissionSuccess,
  type TransmissionEnqueueInput,
  type TransmissionFailedAlert,
  type TransmissionFailureInput,
  type TransmissionSuccessInput,
} from "./enqueue";
