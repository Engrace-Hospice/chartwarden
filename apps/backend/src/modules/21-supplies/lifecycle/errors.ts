// apps/backend/src/modules/21-supplies/lifecycle/errors.ts — M21-T03 (§2.2–§2.7, §2.10).
//
// Every guard failure in the M21 supplies domain raises a `SupplyStateError` carrying the machine-readable
// code the §7 workflow tables and the §4.2 route error blocks name. The error extends the M1 `WardenXError`
// envelope base (packages/types — NOT the banned packages/foundation) so the M1 Fastify error handler renders
// the exact code + status with no cross-module import edge. Mirrors the M7 `CarePlanStateError` /
// M15 `DisciplinePlanStateError` / M16 `BereavementStateError` precedent.
//
// CASING NOTE: §7's edge-case tables spell M21's codes `M21_*` (unlike M16's bare SCREAMING_SNAKE). The six
// codes the spec writes VERBATIM keep that prefix because the wire code is the contract; the codes the spec
// only describes in prose follow the same shape so one module speaks one dialect.
import { WardenXError } from "@wardenx/types";

/** The §7 / §2.10 machine-readable failure-code catalog → HTTP status. */
export const M21_ERROR_STATUS = {
  // ── §2.2 supply-request lifecycle ──────────────────────────────────────────────────────────────────
  /** §7.2 — an edge that does not exist for this (status, kind). Also the two-coordinator dispatch race. */
  M21_INVALID_STATUS_TRANSITION: 409,
  M21_REQUEST_ALREADY_TERMINAL: 409,
  /** §2.10 — a row may not leave `requested` without the D4 resolution frozen onto it. */
  M21_ROUTING_NOT_RESOLVED: 422,
  /** §2.10 — `vendor` mode with no vendor, or a non-vendor mode naming one (mirrors the §3.1.7 CHECK). */
  M21_ROUTING_VENDOR_INCOHERENT: 422,
  /** §2.10 — the M40 `DmeVendor` the resolver picked is not active. */
  M21_VENDOR_NOT_ACTIVE: 422,
  M21_VENDOR_ORDER_REFERENCE_REQUIRED: 422,
  M21_SHIPMENT_TRACKING_REQUIRED: 422,
  /** §2.2 / D7 — `delivered` without a courier attestation is an unanswerable "who put the bed in the room?" */
  M21_COURIER_ATTESTATION_REQUIRED: 422,
  /** §2.2 — the 72h `system_auto_confirm` fallback fired before the grace expired. */
  M21_AUTO_CONFIRM_WINDOW_NOT_ELAPSED: 409,
  /** §2.2 — a monthly rental completes only when M11 discontinues the order. */
  M21_RENTAL_COMPLETION_REQUIRES_DISCONTINUATION: 409,
  /** §2.2 — a kit completes only on M13's ack of the deployment / replenishment. */
  M21_KIT_COMPLETION_REQUIRES_M13_ACK: 409,
  /** §2.2 — `completeReturnReconciliation` before the `comfort_kit_return` row reached `reconciled`. */
  M21_RETURN_NOT_RECONCILED: 409,
  M21_CANCELLATION_REASON_REQUIRED: 422,
  /** §2.2 — a vendor refusal must walk the row back to the state it actually left. */
  M21_CANCELLATION_RESTORE_STATE_INVALID: 422,
  /** F-193 (#248) — a caregiver signature is captured against a DELIVERY; a request that has not yet
   *  reached `delivered` has no delivery to attest to. */
  M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY: 422,
  /** F-193 (#248) — the capture is a one-time evidentiary act, matching this module's append-only
   *  posture for every other attestation (the DEA perpetual log, `order_transmission_attestation`); a
   *  second submission is refused rather than silently overwriting the first. */
  M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED: 409,
  /** F-193 (#248) — the evidence given does not satisfy the declared capture method's floor (mirrors
   *  M39's `validateCaptureEvidence` refusal). */
  M21_CAREGIVER_SIGNATURE_EVIDENCE_REQUIRED: 422,

  // ── §2.3 comfort-kit template ──────────────────────────────────────────────────────────────────────
  /** §7.2 — a tenant template removed / loosened a platform-floor medication. */
  M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR: 422,
  /** §2.3 — `system_locked` rows are platform-managed; a tenant may not delete or disarm them. */
  M21_TEMPLATE_SYSTEM_LOCKED: 409,
  /** §2.3 — dispatching against a template whose effective window does not contain the dispatch instant. */
  M21_TEMPLATE_NOT_EFFECTIVE: 422,
  /** §3.1.4 — `effective_to > effective_from`, and a supersession may not predate the row it replaces. */
  M21_TEMPLATE_EFFECTIVE_WINDOW_INVALID: 422,

  // ── §2.5 dispatch + per-medication content ─────────────────────────────────────────────────────────
  /** §7.2 — the dispatcher failed `controlled_substance_dispatcher_eligible`. */
  M21_CONTROLLED_SUBSTANCE_DISPATCHER_DENIED: 403,
  /** §2.10 / §3.1.9 — a controlled line expiring inside the tenant window (floor 14 days). */
  M21_CONTROLLED_EXPIRATION_WINDOW: 422,
  /** §2.5 — lot number is REQUIRED on every controlled line; it is the DEA 1304 identity of the physical
   *  unit that left the hub. */
  M21_LOT_NUMBER_REQUIRED: 422,
  /** §2.5 — `expirationDate` is required whenever `lotNumber` is set. */
  M21_EXPIRATION_REQUIRED_WITH_LOT: 422,
  /** §3.1.9 — `is_controlled_substance` and `controlled_substance_schedule` move together, both ways. */
  M21_CONTROLLED_SCHEDULE_MISMATCH: 422,
  M21_DISPATCH_QUANTITY_INVALID: 422,
  /** §2.5 — the supply-hub barcode the kit will be scanned by, absent. */
  M21_KIT_SERIAL_REQUIRED: 422,
  /** §2.5 — the handling policy AS DISPATCHED must be frozen onto the row, or a later policy edit silently
   *  rewrites what the courier was told to do. */
  M21_HANDLING_POLICY_DIGEST_REQUIRED: 422,
  /** §2.5 — the dispatch names a medication the referenced template does not contain. */
  M21_DISPATCH_CONTENT_NOT_IN_TEMPLATE: 422,
  M21_DISPATCH_CONTENTS_EMPTY: 422,
  /** §7.2 — the deploy transition is gated on the dispatch still being in `dispatched`. */
  M21_DISPATCH_NOT_DEPLOYABLE: 409,
  M21_DISPATCH_STATUS_TRANSITION_INVALID: 409,

  // ── §2.6 return + reconciliation ───────────────────────────────────────────────────────────────────
  M21_RETURN_STATE_TRANSITION_INVALID: 409,
  /** §7.3 — the second of two racing reconcilers. */
  M21_RETURN_ALREADY_RECONCILED: 409,
  /** §7.3 — returned + disposed exceeds dispatched; a negative unaccounted quantity may never be written. */
  M21_INVALID_RECONCILIATION_QUANTITY: 422,
  /** §7.3 — a CII–CV line reconciled with no witness on the at-home destruction path. */
  M21_WITNESS_REQUIRED_FOR_CONTROLLED_SUBSTANCE: 422,
  /** §7.3 — the reconciler is the dispatcher, or the witness is the retriever / reconciler. */
  M21_RECONCILIATION_SEPARATION_OF_DUTIES_VIOLATION: 403,
  M21_DISPOSAL_METHOD_REQUIRED: 422,
  /** §2.6 — every dispatched line must be accounted for before the return can be signed. */
  M21_RECONCILIATION_LINE_COVERAGE_INCOMPLETE: 422,
  /** §2.6 — the 90-day disposition needs an attested reason from a clinical supervisor. */
  M21_UNRETURNABLE_REASON_REQUIRED: 422,
  M21_RETURN_NOT_YET_OVERDUE: 409,

  // ── §2.7 par stock ─────────────────────────────────────────────────────────────────────────────────
  /** §2.10 — the dispatch decrement would drive the shelf negative. */
  M21_PAR_STOCK_INSUFFICIENT: 409,
  /** §2.10 — `min_safety_stock <= reorder_point`, both non-negative (mirrors the §3.1.6 CHECK). */
  M21_PAR_THRESHOLDS_INVERTED: 422,
  M21_PAR_STOCK_INACTIVE: 409,

  // ── §4.5.1 inbound-cascade resolution (M21-T04) ────────────────────────────────────────────────────
  // All three DEAD-LETTER the delivery rather than writing a guessed row. The M11/M13 outbox retries, so
  // nothing is lost: the request appears the moment the missing fact resolves.
  /** §2.8 — `m11.order.supply_fulfillment_requested` named an order `OrderProvider` cannot read back. The
   *  event carries no patient, so without the order there is no admission to anchor the request to. */
  M21_SOURCE_ORDER_UNRESOLVED: 422,
  /** §7.1 — no serving Location resolved for the cascade. `supply_request.location_id` is NOT NULL and it
   *  drives par-stock decrement and controlled-substance custody, so a guess is worse than a retry. */
  M21_SERVING_LOCATION_UNRESOLVED: 422,
  /** GAP-064 — the request body named a Location that is not the one the SERVER holds for the admission
   *  (create) or the stored supply request (dispatch). A body Location is a claim, never a fact. */
  M21_LOCATION_MISMATCH: 422,
  /** §2.5 / §2.6 — an inbound `m13.comfort_kit.*` referenced a deployment M21 has no dispatch for. */
  M21_DISPATCH_NOT_FOUND: 422,
  /** §2.8 / §3.1 — a replenish request has no M11 order behind it, so the outbox event id is its ONLY
   *  provenance and the one-upstream CHECK cannot be satisfied without it. */
  M21_REPLENISHMENT_PROVENANCE_MISSING: 422,
  /** §2.1 — `m13.comfort_kit.replenishment_needed` named a medication with no matching DISPATCHED line on
   *  the dispatch it maps to; the pharmacy identity (rxNorm/strength/dosageForm/…) cannot be assembled. */
  M21_REPLENISHMENT_LINE_NOT_FOUND: 422,
  /** §2.1 — the dispatch's originating `supply_request` carries no `deliveryAddress` snapshot to reuse
   *  (an IPU-room deployment has none); `comfort_kit_replenish`'s schema requires one unconditionally. */
  M21_REPLENISHMENT_ADDRESS_UNRESOLVED: 422,

  // ── Optimistic concurrency (§7.2 / §7.3 / §7.4) ────────────────────────────────────────────────────
  M21_STALE_VERSION: 412,
} as const;

/** A machine-readable M21 domain failure code (§7 / §2.10). */
export type M21ErrorCode = keyof typeof M21_ERROR_STATUS;

/**
 * A guard / validation failure in the M21 supplies domain. Carries the precise code so the UI renders an
 * exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2 every guard failure
 * surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class SupplyStateError extends WardenXError {
  constructor(code: M21ErrorCode, message: string) {
    super(code, message, M21_ERROR_STATUS[code]);
    this.name = "SupplyStateError";
  }
}

/** Throw a {@link SupplyStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M21ErrorCode, message: string): void {
  if (!condition) throw new SupplyStateError(code, message);
}
