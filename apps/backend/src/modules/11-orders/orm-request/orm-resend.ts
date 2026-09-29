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
  if (reason === null || !reason.startsWith(ORM_REFUSAL_PREFIX)) {
    return {
      ok: false,
      code: "not_an_orm_refusal",
      message:
        "the failure did not come from the ORM request step (the message was built and sent) — a resend would create a duplicate outbound message",
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
