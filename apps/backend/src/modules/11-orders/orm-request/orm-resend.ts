// apps/backend/src/modules/11-orders/orm-request/orm-resend.ts — the RESEND of a refused lab ORM (F-182, #248).
//
// WHAT WAS MISSING. F-181's producer refuses (never fabricates) when a fact the HL7 ORM needs is not resolvable at
// sign time: the order stays signed, `transmission_status='failed'`, `transmission_failure_reason=
// 'orm_refused:<reason>'`, and M36 alerts the ordering provider. The ordering provider (or the office) then FIXES
// the fact — confirms the physician's NPI, completes the patient's DOB, links the lab feed to its facility — and
// nothing ever retried: the order sat `failed` forever. This is the explicit, authorized, audited action that
// re-runs the SAME producer for such an order. There is deliberately no automatic sweep: a human fixed a fact and
// a human says "send it now", and an unattended retry loop against a refusal that is not transient would just
// re-alert.
//
// THIS FILE is the PURE decision: is this order's current failure one a resend can act on? The DB shell (row lock,
// conditional update, publish) lives in `orders-route-service-db.ts` beside the sign path it mirrors.
//
// WHAT IS RESENDABLE. Only a `lab` order that is `active`, `transmission_status='failed'`, whose failure reason is
// one THIS producer wrote (`orm_refused:*`). A `failed` that came from M29's terminal failure
// (`application_reject` / `dlq_exhausted` — written by F-177's applier) means a message WAS built and sent and the
// lab rejected it; that is a different problem with a different remedy, and re-emitting would create a second
// outbound message for the same order (M29's idempotency key is `(feed, orm, orderId)`, so a refused order — which
// never reached M29 and therefore has no outbound row — is the ONLY case where a resend cannot collide with it).
//
// WHAT IS NEVER RESENDABLE, and why:
//   sud_restricted         — 42 CFR Part 2. The refusal is not a missing fact, it is a disclosure gate, and lifting
//                            it is a compliance decision (consent-aware release, which does not exist yet), not a
//                            data-entry fix. A resend button that any RN with `orders.amend` can press would be a
//                            de-facto override of that gate. The producer would re-run the gate and refuse again
//                            while the M5 flag is set; if the flag is genuinely cleared the remedy is a new order.
//   lab_test_codes_missing / multiple_test_codes_unsupported / no_routing_lab
//                          — the fact lives in the SIGNED order's own `data`, which is immutable. Re-running
//                            cannot change the answer; the remedy is `POST /orders/:id/correct`.
// Every other refusal (patient_*, physician_*, lab_facility_unresolved, no_active_feed, ambiguous_feed,
// no_feed_for_destination, feed_identity_incomplete, payload_invalid, dependency_unavailable) depends on facts held
// OUTSIDE the order and is resendable.

/** The prefix F-181's producer writes into `transmission_failure_reason`. */
export const ORM_REFUSAL_PREFIX = "orm_refused:";

/**
 * F-185 — the prefix the `LabTransmissionApplier` writes when the M29 worker REFUSED to persist any outbound row
 * (`m29.lab_order.dispatch_refused`: no/ambiguous/unlinked feed, incomplete MSH identity, lapsed BAA). Like an
 * emit-time refusal, NOTHING was ever sent and NO outbound row exists for the order, so F-182's resend — which
 * re-runs the producer and lets M29's guard see an order with no row — cannot duplicate it. Resendable.
 */
export const DISPATCH_REFUSED_PREFIX = "dispatch_refused:";

/** Refusals whose fact lives in the immutable signed order — a resend cannot change them; correct the order. */
export const ORM_REFUSALS_NEEDING_CORRECTED_ORDER: ReadonlySet<string> = new Set([
  "lab_test_codes_missing",
  "multiple_test_codes_unsupported",
  "no_routing_lab",
]);

/** The order-side state the eligibility decision reads. */
export interface OrmResendCandidate {
  readonly kind: string;
  readonly status: string;
  readonly transmissionStatus: string;
  readonly transmissionFailureReason: string | null;
}

export type OrmResendVerdict =
  | { readonly ok: true; readonly priorReason: string }
  | {
      readonly ok: false;
      /** Stable machine code for the 409 body / tests — never PHI. */
      readonly code:
        | "not_a_lab_order"
        | "order_not_active"
        | "not_failed"
        | "not_an_orm_refusal"
        | "sud_restricted"
        | "needs_corrected_order";
      readonly message: string;
    };

/** PURE. Decide whether a resend may act on this order's current state. */
export function classifyOrmResend(order: OrmResendCandidate): OrmResendVerdict {
  if (order.kind !== "lab") {
    return { ok: false, code: "not_a_lab_order", message: "only a lab order has an outbound HL7 request" };
  }
  if (order.status !== "active") {
    return { ok: false, code: "order_not_active", message: "the order is not active" };
  }
  if (order.transmissionStatus !== "failed") {
    return {
      ok: false,
      code: "not_failed",
      message: `the order's transmission status is '${order.transmissionStatus}', not 'failed'`,
    };
  }
  const reason = order.transmissionFailureReason;
  // F-185 — a worker refusal (`dispatch_refused:*`) wrote no outbound row either: resendable, and the cause
  // (an inactive/unlinked feed, an incomplete MSH identity, a lapsed BAA) lives outside the order, so there is
  // no SUD / immutable-order carve-out to apply — the producer re-runs its own gates on the resend.
  if (reason !== null && reason.startsWith(DISPATCH_REFUSED_PREFIX)) {
    return { ok: true, priorReason: reason };
  }
  if (reason === null || !reason.startsWith(ORM_REFUSAL_PREFIX)) {
    return {
      ok: false,
      code: "not_an_orm_refusal",
      message:
        "the failure did not come from the ORM request step (the message was built and sent) — a resend would create a duplicate outbound message; if the lab confirms it was NOT received, use the attested recovery",
    };
  }
  const refusal = reason.slice(ORM_REFUSAL_PREFIX.length);
  if (refusal === "sud_restricted") {
    return {
      ok: false,
      code: "sud_restricted",
      message:
        "refused under the substance-use-disorder disclosure gate (42 CFR Part 2); releasing it is a compliance decision, not a resend",
    };
  }
  if (ORM_REFUSALS_NEEDING_CORRECTED_ORDER.has(refusal)) {
    return {
      ok: false,
      code: "needs_corrected_order",
      message: `'${refusal}' comes from the signed order itself, which cannot change — issue a corrected order`,
    };
  }
  return { ok: true, priorReason: reason };
}

// ── F-185 — ATTESTED RECOVERY of an M29-terminal order ──────────────────────────────────────────────────────────
//
// F-182's resend deliberately refuses an order that failed AFTER a message was built (`dlq_exhausted`,
// `application_reject`, including F-183's "held, delivery unverified" reclaim, which surfaces as `dlq_exhausted`): the
// lab MAY have received it, and re-emitting would order the test twice. Those orders were stranded with no way out.
// This is the way out — but it needs a HUMAN to establish the one fact the system cannot: what the lab actually has.
// The operator calls the lab and ATTESTS one of two outcomes, and the attestation is recorded in the order's
// write-audit diff (who, when, what):
//   `not_received_by_lab` — the lab has NO copy. The producer re-runs and M29 re-dispatches ONCE for this attestation
//                           (the single sanctioned exception to F-183's one-ORM-per-order guard; see the worker).
//   `received_by_lab`     — the lab HAS it. Nothing is sent; the order is marked `transmitted`.
// An `application_reject` (`AR`) means the lab explicitly REFUSED the message, so "the lab received it" is not a
// coherent outcome for it — only `not_received_by_lab` (i.e. re-dispatch after the cause was fixed) applies.

/** The `transmission_failure_reason` prefix that carries the attestation into the order's write-audit diff. */
export const RECOVERY_ATTESTATION_PREFIX = "recovery_attested:";

export type RecoveryAttestation = "not_received_by_lab" | "received_by_lab";
export const RECOVERY_ATTESTATIONS: readonly RecoveryAttestation[] = ["not_received_by_lab", "received_by_lab"];

/** The M29-terminal failure reasons `LabTransmissionApplier` writes verbatim (no prefix). */
export const RECOVERABLE_M29_FAILURE_REASONS: ReadonlySet<string> = new Set(["dlq_exhausted", "application_reject"]);

export type TransmissionRecoveryVerdict =
  | { readonly ok: true; readonly priorReason: string }
  | {
      readonly ok: false;
      readonly code:
        | "not_a_lab_order"
        | "order_not_active"
        | "not_failed"
        | "not_an_m29_terminal_failure"
        | "lab_rejected_order";
      readonly message: string;
    };

/** PURE. May an operator's attestation act on this order's current failure? */
export function classifyTransmissionRecovery(
  order: OrmResendCandidate,
  attestation: RecoveryAttestation,
): TransmissionRecoveryVerdict {
  if (order.kind !== "lab") {
    return { ok: false, code: "not_a_lab_order", message: "only a lab order has an outbound HL7 request" };
  }
  if (order.status !== "active") {
    return { ok: false, code: "order_not_active", message: "the order is not active" };
  }
  if (order.transmissionStatus !== "failed") {
    return {
      ok: false,
      code: "not_failed",
      message: `the order's transmission status is '${order.transmissionStatus}', not 'failed'`,
    };
  }
  const reason = order.transmissionFailureReason;
  if (reason === null || !RECOVERABLE_M29_FAILURE_REASONS.has(reason)) {
    return {
      ok: false,
      code: "not_an_m29_terminal_failure",
      message:
        "the failure did not come from an M29 terminal outcome — an emit-time or dispatch refusal is fixed and re-sent with the plain resend, not attested",
    };
  }
  if (reason === "application_reject" && attestation === "received_by_lab") {
    return {
      ok: false,
      code: "lab_rejected_order",
      message: "the lab explicitly rejected (AR) this order, so it cannot be marked as received",
    };
  }
  return { ok: true, priorReason: reason };
}
