// @wardenx/dosespot — M12 refill-inbox failure-code catalog (§2.7 D9, M12-T04).
//
// Every guard / validation failure in the pure refill-inbox domain raises a `RefillStateError` carrying the
// machine-readable code below. It extends the M1 `WardenXError` envelope base (`@wardenx/types` — NOT the
// banned `packages/foundation`) so the M1 Fastify error handler renders it with the precise code + HTTP
// status with no cross-module import edge (the M11/M12 medication-order-lifecycle convention). Nothing
// transitions on a string match; the route layer (M12-T08) reuses these codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The M12 refill-inbox failure-code catalog → canonical HTTP status. */
export const M12_REFILL_ERROR_STATUS = {
  // §2.7 — the refill-request lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_REFILL_TRANSITION: 409,
  // §2.7 / §4.7 `refill_inbox_scope` — the actor may not act on this refill request (out of inbox scope).
  REFILL_ACTOR_NOT_IN_SCOPE: 403,
  // §2.7 — the source `medication_order` is not `active`; a refill renews only an active prescription.
  REFILL_SOURCE_ORDER_NOT_ACTIVE: 409,
  // §2.7 deny — a denial reason is required (denylisted free text on `refill_request.denial_reason`).
  REFILL_DENIAL_REASON_REQUIRED: 422,
  // §2.7 — `expire` is a system-actor operation (DoseSpot withdrawal / source discontinuation), not human.
  REFILL_NOT_SYSTEM_ACTOR: 403,
  // §2.7 / §1.4 controlled-substance refill rules — Schedule II medications are non-refillable.
  REFILL_SCHEDULE_II_NON_REFILLABLE: 422,
  // §2.7 / §1.4 — the requested `refillsAuthorized` exceeds the schedule's max-refill rule (≤5 III/IV/V).
  REFILL_EXCEEDS_SCHEDULE_MAX: 422,
  // §2.7 — a tenant `controlled_substance_policy` max-refill override above the platform floor (tighten-only).
  REFILL_CONTROLLED_MAX_EXCEEDS_FLOOR: 422,
  // §2.7 — a tenant `controlled_substance_policy` max-refill override that is out of range (< 0).
  REFILL_CONTROLLED_MAX_OUT_OF_RANGE: 422,
  // §2.7 SLA — a `refill_inbox_policy` SLA-hours value out of range (< 1, or warn ≥ critical).
  REFILL_SLA_HOURS_OUT_OF_RANGE: 422,
  // §2.7 SLA — a `refill_inbox_policy` SLA-hours value above the platform floor (tighten-only).
  REFILL_SLA_EXCEEDS_FLOOR: 422,
} as const;

/** A machine-readable M12 refill-inbox failure code (§2.7). */
export type M12RefillErrorCode = keyof typeof M12_REFILL_ERROR_STATUS;

/**
 * A guard / validation failure in the M12 refill-inbox domain. Carries the precise `code` so the UI renders
 * an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard failure
 * surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class RefillStateError extends WardenXError {
  constructor(code: M12RefillErrorCode, message: string) {
    super(code, message, M12_REFILL_ERROR_STATUS[code]);
    this.name = "RefillStateError";
  }
}

/** Throw a {@link RefillStateError} when `condition` is false (guard helper). */
export function requireRefill(
  condition: boolean,
  code: M12RefillErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new RefillStateError(code, message);
}
