// apps/backend/src/modules/41-billing-commercial/eligibility/send-gate.ts - the routing and enrollment gate (ADR-0100 D4, D5).
//
// PURE and fail closed. Nothing is sent to a clearinghouse unless, in this order:
//   1. the platform transport is bound (there is no direct-to-payer channel and no fallback clearinghouse),
//   2. the plan has a route in effect on the service date for THAT clearinghouse (the payer id it routes on), and
//   3. the provider entity has an enrollment with status 'enrolled' in effect that day for this payer on THAT clearinghouse.
// A refusal carries a stable code and a message that says what to do next. The claim submission lane (#722) calls the same gate.
import {
  COMMERCIAL_SEND_REFUSAL,
  type CommercialEnrollmentStatus,
  type CommercialSendRefusalCode,
} from "@chartwarden/types";

export interface GateRoute {
  readonly clearinghousePayerId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface GateEnrollment {
  readonly status: CommercialEnrollmentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface SendGateInput {
  /** The bound clearinghouse's key (`binding.vendor`), or null when unbound. */
  readonly clearinghouseKey: string | null;
  /** The plan's routes for that clearinghouse (any dates; the gate picks the one in effect). */
  readonly routes: readonly GateRoute[];
  /** The provider entity's enrollments for the plan's payer on that clearinghouse (any dates). */
  readonly enrollments: readonly GateEnrollment[];
  /** ISO yyyy-mm-dd the send is for. */
  readonly serviceDate: string;
}

export type SendGateResult =
  | { readonly ok: true; readonly clearinghousePayerId: string }
  | { readonly ok: false; readonly code: CommercialSendRefusalCode; readonly message: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const inEffect = (
  p: { readonly effectiveFrom: string; readonly effectiveTo: string | null },
  day: string,
): boolean => p.effectiveFrom <= day && (p.effectiveTo === null || p.effectiveTo >= day);

export function evaluateSendGate(input: SendGateInput): SendGateResult {
  if (!ISO_DAY.test(input.serviceDate)) throw new RangeError("serviceDate must be yyyy-mm-dd");
  if (input.clearinghouseKey === null) {
    return {
      ok: false,
      code: COMMERCIAL_SEND_REFUSAL.NOT_WIRED,
      message:
        "No clearinghouse is connected to this platform, so nothing was sent. Ask a platform administrator to configure the clearinghouse.",
    };
  }
  const route = input.routes.find((r) => inEffect(r, input.serviceDate));
  if (!route) {
    return {
      ok: false,
      code: COMMERCIAL_SEND_REFUSAL.PAYER_NOT_ROUTED,
      message:
        "The connected clearinghouse has no payer id on file for this plan on the service date, so nothing was sent. Add the payer id the clearinghouse routes this plan on.",
    };
  }
  const enrolled = input.enrollments.some(
    (e) => e.status === "enrolled" && inEffect(e, input.serviceDate),
  );
  if (!enrolled) {
    return {
      ok: false,
      code: COMMERCIAL_SEND_REFUSAL.PROVIDER_NOT_ENROLLED,
      message:
        "This provider entity is not enrolled with this payer on the connected clearinghouse, so nothing was sent. Complete enrollment and record it before retrying.",
    };
  }
  return { ok: true, clearinghousePayerId: route.clearinghousePayerId };
}
