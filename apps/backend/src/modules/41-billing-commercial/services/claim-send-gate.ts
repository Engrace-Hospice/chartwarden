// apps/backend/src/modules/41-billing-commercial/services/claim-send-gate.ts - the claim-level SEND GATE (ADR-0100 D4, D5; ADR-0053 D10).
//
// PURE and fail closed. It answers every reason a claim cannot be sent, each a stable code with a fixed message that says what to do
// next (no value from a rule, a vendor or a patient is ever interpolated). Order is fixed so the UI renders the same list the
// route answers:
//   1. claim state       - the claim must be `ready`; any other state is the only reason reported (the rest is moot)
//   2. in flight         - no queued / sent / in-doubt submission of this claim exists
//   3. validation        - nothing unresolved blocks, judged on the CURRENT facts (not the stored run); split out below
//   4. authorization     - the `authorization_on_file` rule (hard when the plan requires it, soft for `confirm_with_payer`)
//   5. eligibility       - the `eligibility_freshness` rule (blocking per plan policy or when the payer answered "not active")
//   6. transport bound   - the platform ClearinghouseTransport is bound (no direct-to-payer channel, no fallback: ADR-0053 D10)
//   7. route             - the plan has a route in effect for THAT clearinghouse, and it is the payer id the claim was built with
//   8. enrollment        - the provider entity is `enrolled` with the payer on that clearinghouse on the service date
// Steps 6 to 8 reuse `evaluateSendGate` (the eligibility lane's gate) so both lanes refuse identically.
import {
  COMMERCIAL_SEND_GATE_CODES,
  COMMERCIAL_SEND_REFUSAL,
  type CommercialSendGateCode,
} from "@chartwarden/types";
import { type GateEnrollment, type GateRoute, evaluateSendGate } from "../eligibility/send-gate";

export const AUTHORIZATION_RULE_KEY = "authorization_on_file";
export const ELIGIBILITY_RULE_KEY = "eligibility_freshness";

export interface GateValidationResult {
  readonly ruleKey: string;
  /** True when the result still blocks (a failure that no valid override covers). */
  readonly blocking: boolean;
}

export interface ClaimSendGateInput {
  readonly claimState: string;
  /** The claim already has a queued, sent or in-doubt submission. */
  readonly hasLiveSubmission: boolean;
  /** The rules evaluated on the claim's current facts. */
  readonly validation: readonly GateValidationResult[];
  /** The bound clearinghouse's key (`binding.vendor`), or null when unbound. */
  readonly clearinghouseKey: string | null;
  readonly routes: readonly GateRoute[];
  readonly enrollments: readonly GateEnrollment[];
  /** The last service day, ISO yyyy-mm-dd: the date routing and enrollment are judged on. */
  readonly serviceDate: string;
  /** The payer id the claim's 837I was assembled with (`commercial_claim.clearinghouse_payer_id`). */
  readonly claimClearinghousePayerId: string | null;
}

export interface SendGateReason {
  readonly code: CommercialSendGateCode;
  readonly message: string;
  /** Rule keys behind a validation, authorization or eligibility reason. Keys only, never rule text. */
  readonly ruleKeys?: readonly string[];
}

export type ClaimSendGateResult =
  | { readonly ok: true; readonly clearinghouseKey: string; readonly clearinghousePayerId: string }
  | { readonly ok: false; readonly reasons: readonly SendGateReason[] };

const MESSAGES = {
  [COMMERCIAL_SEND_GATE_CODES.CLAIM_NOT_READY]:
    "Only a ready claim can be sent. Validate the claim and clear every block first; a claim that was already sent cannot be sent again.",
  [COMMERCIAL_SEND_GATE_CODES.SUBMISSION_IN_FLIGHT]:
    "A submission of this claim is already waiting to be sent, was sent, or is being reconciled. Wait for its outcome before sending again.",
  [COMMERCIAL_SEND_GATE_CODES.VALIDATION_BLOCKED]:
    "The claim has validation blocks that are not resolved. Fix the data, or record an audited override where one is allowed, then validate again.",
  [COMMERCIAL_SEND_GATE_CODES.AUTHORIZATION_NOT_SATISFIED]:
    "The payer's pre-authorization requirement is not satisfied for every billed day. Record an approved authorization that covers the stay, or confirm the requirement with the payer.",
  [COMMERCIAL_SEND_GATE_CODES.ELIGIBILITY_NOT_CURRENT]:
    "Eligibility is missing, stale or reports the coverage as not active. Run a new eligibility check before sending.",
  [COMMERCIAL_SEND_GATE_CODES.ROUTE_CHANGED]:
    "The payer id this claim was built with is not the one the connected clearinghouse routes this plan on. Void and assemble the claim again.",
} as const;

const reason = (
  code: CommercialSendGateCode,
  message: string,
  ruleKeys?: readonly string[],
): SendGateReason => (ruleKeys === undefined ? { code, message } : { code, message, ruleKeys });

function validationReasons(results: readonly GateValidationResult[]): SendGateReason[] {
  const blocking = results.filter((r) => r.blocking).map((r) => r.ruleKey);
  const out: SendGateReason[] = [];
  const other = blocking.filter((k) => k !== AUTHORIZATION_RULE_KEY && k !== ELIGIBILITY_RULE_KEY);
  if (other.length > 0) {
    out.push(
      reason(
        COMMERCIAL_SEND_GATE_CODES.VALIDATION_BLOCKED,
        MESSAGES[COMMERCIAL_SEND_GATE_CODES.VALIDATION_BLOCKED],
        [...other].sort(),
      ),
    );
  }
  if (blocking.includes(AUTHORIZATION_RULE_KEY)) {
    out.push(
      reason(
        COMMERCIAL_SEND_GATE_CODES.AUTHORIZATION_NOT_SATISFIED,
        MESSAGES[COMMERCIAL_SEND_GATE_CODES.AUTHORIZATION_NOT_SATISFIED],
        [AUTHORIZATION_RULE_KEY],
      ),
    );
  }
  if (blocking.includes(ELIGIBILITY_RULE_KEY)) {
    out.push(
      reason(
        COMMERCIAL_SEND_GATE_CODES.ELIGIBILITY_NOT_CURRENT,
        MESSAGES[COMMERCIAL_SEND_GATE_CODES.ELIGIBILITY_NOT_CURRENT],
        [ELIGIBILITY_RULE_KEY],
      ),
    );
  }
  return out;
}

export function evaluateClaimSendGate(input: ClaimSendGateInput): ClaimSendGateResult {
  if (input.claimState !== "ready") {
    return {
      ok: false,
      reasons: [
        reason(
          COMMERCIAL_SEND_GATE_CODES.CLAIM_NOT_READY,
          MESSAGES[COMMERCIAL_SEND_GATE_CODES.CLAIM_NOT_READY],
        ),
      ],
    };
  }
  const reasons: SendGateReason[] = [];
  if (input.hasLiveSubmission) {
    reasons.push(
      reason(
        COMMERCIAL_SEND_GATE_CODES.SUBMISSION_IN_FLIGHT,
        MESSAGES[COMMERCIAL_SEND_GATE_CODES.SUBMISSION_IN_FLIGHT],
      ),
    );
  }
  reasons.push(...validationReasons(input.validation));

  const transport = evaluateSendGate({
    clearinghouseKey: input.clearinghouseKey,
    routes: input.routes,
    enrollments: input.enrollments,
    serviceDate: input.serviceDate,
  });
  if (!transport.ok) {
    reasons.push(reason(transport.code, transport.message));
  } else if (transport.clearinghousePayerId !== input.claimClearinghousePayerId) {
    reasons.push(
      reason(
        COMMERCIAL_SEND_GATE_CODES.ROUTE_CHANGED,
        MESSAGES[COMMERCIAL_SEND_GATE_CODES.ROUTE_CHANGED],
      ),
    );
  }
  if (reasons.length > 0 || !transport.ok || input.clearinghouseKey === null) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    clearinghouseKey: input.clearinghouseKey,
    clearinghousePayerId: transport.clearinghousePayerId,
  };
}

/** The HTTP status for a refusal: unbound transport is a 503 (nothing to retry against), everything else a 409. */
export function statusForReasons(reasons: readonly SendGateReason[]): number {
  return reasons.some((r) => r.code === COMMERCIAL_SEND_REFUSAL.NOT_WIRED) ? 503 : 409;
}
