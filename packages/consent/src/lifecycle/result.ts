// @wardenx/consent — the shared decision result for the lifecycle machines + §2.3 validators.
//
// M39-T04. Every pure decision returns a discriminated `Decision`: a transition/validation either
// succeeds (`ok: true`, carrying the resolved next state where relevant) or is refused with a
// stable machine-readable `code` + a human message. The service layer (T05+) maps a refusal to a
// 409/412/422 and an audit deny-reason; the evaluate path (§4.3) maps it to `allowed:false reason`.

export type DecisionCode =
  // status machine (§2.2.1)
  | "invalid_transition"
  | "draft_cannot_supersede"
  | "revoked_is_terminal"
  | "already_in_state"
  // recipient machine (§2.2.2)
  | "recipient_already_removed"
  // cascade machine (§2.2.3)
  | "cascade_retry_budget_exhausted"
  | "cascade_invalid_transition"
  // renewal machine (§2.4)
  | "renewal_cycle_not_open"
  // tenant overlay (§7.6)
  | "overlay_loosens_platform_floor"
  // validation rules (§2.3)
  | "grantor_self_reference"
  | "grantor_authority_missing"
  | "grantor_authority_expired_on_majority"
  | "survives_death_not_eligible_for_type"
  | "consent_terminated_on_death"
  | "supersedes_type_mismatch"
  | "supersedes_not_active"
  | "renewed_from_status_invalid"
  | "renewed_from_type_mismatch"
  | "capture_method_below_floor"
  | "revocation_reason_too_short"
  | "revocation_evidence_required"
  | "effective_at_future"
  | "expires_before_effective"
  | "term_exceeds_max"
  | "dpoa_primary_required"
  | "dpoa_duplicate_agent_kind"
  | "recipient_fk_kind_mismatch"
  | "bereavement_grantor_invalid"
  | "bereavement_patient_not_deceased";

export type Decision<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; value: T })
  | { ok: false; code: DecisionCode; message: string };

export function ok(): Decision;
export function ok<T>(value: T): Decision<T>;
export function ok<T>(value?: T): Decision<T> {
  return (value === undefined ? { ok: true } : { ok: true, value }) as Decision<T>;
}

export function deny<T = undefined>(code: DecisionCode, message: string): Decision<T> {
  return { ok: false, code, message };
}
