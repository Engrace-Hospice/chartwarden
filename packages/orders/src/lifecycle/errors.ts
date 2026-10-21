// @chartwarden/orders — M11 order-lifecycle failure-code catalog (§2.2 / §2.5, M11-T03).
//
// Every guard / validation failure in the pure order-lifecycle domain raises an `OrderStateError`
// carrying the machine-readable code below. The error extends the M1 `ChartWardenError` envelope base
// (`@chartwarden/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler renders it
// with the precise code + HTTP status with no cross-module import edge (the M8/M9 lifecycle convention).
// Nothing transitions on a string match — each code is an enumerated constant; the §3.4 DB triggers
// (`ACTIVE_ORDER_IMMUTABLE`, `TARGET_NOT_PENDING_SIGNATURE`, `REPLACED_ORDER_NOT_REPLACEABLE`, M11-T02)
// repeat the strongest of these at the schema layer as defense in depth. The route layer (M11-T06)
// reuses these codes verbatim.
import { ChartWardenError } from "@chartwarden/types";

/** The M11 order-lifecycle failure-code catalog → canonical HTTP status. */
export const M11_ERROR_STATUS = {
  // §2.2 — the lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_ORDER_TRANSITION: 409,
  // §2.2 `requestSignature` — the per-kind required `data` fields are not yet complete.
  ORDER_REQUIRED_FIELDS_INCOMPLETE: 422,
  // §2.2 cosign overlay — `sign` is blocked while `cosign_status='pending'` (LPN-drafted / escalation jump).
  COSIGN_PENDING: 412,
  // §2.1 / §4.7 `discipline_can_order` — the drafting discipline may not author this kind.
  DISCIPLINE_CANNOT_ORDER: 403,
  // §2.2 / §4.7 `signer_eligible` — the signing discipline is not eligible for this kind.
  SIGNER_NOT_ELIGIBLE: 403,
  // §2.2 — the signer is neither the named ordering practitioner nor an authorized on-behalf signer.
  SIGNER_NOT_NAMED_PRACTITIONER: 403,
  // §2.2 — sign-on-behalf is reserved to a medical_director, and is never permitted in the verbal flow.
  ON_BEHALF_NOT_PERMITTED: 403,
  // §2.3 — `recordVerbal` attempted on a written-ab-initio kind (`allowsVerbal: false`).
  VERBAL_NOT_ALLOWED_FOR_KIND: 422,
  // §2.3 — the recording RN's verbal-communication attestation is missing.
  VERBAL_ATTESTATION_REQUIRED: 422,
  // §2.3 — the recording actor lacks `orders.verbal.record` / is not RN+.
  VERBAL_RECORDER_NOT_ELIGIBLE: 403,
  // §2.2 — `expire` fired before `now() >= deadline_at` (worker clock guard).
  VERBAL_DEADLINE_NOT_REACHED: 422,
  // §2.2 / §2.4 — a transition reserved to the system worker was attempted by a human actor.
  NOT_SYSTEM_ACTOR: 403,
  // §2.2 `discardDraft` — actor is neither the drafter nor a supervisor.
  DISCARD_NOT_PERMITTED: 403,
  // §2.2 `discardDraft` — the draft is referenced by an external `order_record` and cannot be discarded.
  ORDER_HAS_EXTERNAL_REFERENCES: 409,
  // §2.2 `withdraw` — actor is not the drafter, supervisor, or signer.
  WITHDRAW_NOT_PERMITTED: 403,
  // §2.2 `complete` — the kind-specific completion criterion is not met.
  COMPLETION_CRITERION_NOT_MET: 422,
  // §2.5 — a cosignature was attested on an order that does not require one.
  COSIGN_NOT_REQUIRED: 422,
  // §2.5 — a second cosignature row for an already-cosigned order.
  ALREADY_COSIGNED: 409,
  // §2.5 / §6 — the cosigner's role does not satisfy the required cosign axis.
  COSIGNER_NOT_ELIGIBLE: 403,
  // §2.3 D3 — a tenant `order_verbal_policy.window_hours` set above the 48h platform floor (tighten-only).
  VERBAL_WINDOW_EXCEEDS_FLOOR: 422,
  // §2.3 D3 — a tenant `order_verbal_policy.window_hours` below the minimum (must be ≥ 1).
  VERBAL_WINDOW_OUT_OF_RANGE: 422,
  // GAP-017 -- a verbal order's `received_at` (the instant the 48h signature clock starts) is in the future
  // beyond clock skew, or older than the bounded look-back. The clock starts at a server-checked instant.
  VERBAL_RECEIVED_AT_OUT_OF_RANGE: 422,
  // §2.4 D5 — a standing-order template kind ∉ {lab, supply, ancillary_service}.
  STANDING_KIND_NOT_ELIGIBLE: 422,
  // §2.4 D5 — the standing-order template is not yet signed (the spawn signature-anchor is missing).
  STANDING_ORDER_NOT_SIGNED: 412,
  // §2.4 D5 — a spawn was attempted from a non-`active` standing-order template.
  STANDING_ORDER_NOT_ACTIVE: 409,
  // §2.4 D5 — `now()` is outside the template's `[effective_from, effective_until]` bounds.
  STANDING_OUTSIDE_EFFECTIVE_WINDOW: 422,
  // §2.4 D5 — the template's `max_spawns` cap has been reached.
  STANDING_MAX_SPAWNS_REACHED: 409,
} as const;

/** A machine-readable M11 order-lifecycle failure code (§2.2 / §2.5). */
export type M11ErrorCode = keyof typeof M11_ERROR_STATUS;

/**
 * A guard / validation failure in the M11 order-lifecycle domain. Carries the precise `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard
 * failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class OrderStateError extends ChartWardenError {
  constructor(code: M11ErrorCode, message: string) {
    super(code, message, M11_ERROR_STATUS[code]);
    this.name = "OrderStateError";
  }
}

/** Throw an {@link OrderStateError} when `condition` is false (guard helper). */
export function require_(
  condition: boolean,
  code: M11ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new OrderStateError(code, message);
}
