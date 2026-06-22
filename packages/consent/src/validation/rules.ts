// @wardenx/consent — the §2.3 validation rules as pure predicates.
//
// M39-T04. Each rule is a pure function the service layer composes on draft + on sign (and the
// evaluate path consults at access time). Rules that need a DB/seam lookup (the acting DPOA record,
// the patient DOB, the M38 age-of-majority, the M40 recipient entity) take the resolved fact as a
// parameter — this module stays pure and fully unit-testable; the wiring is T05/T07.
import {
  CONSENT_TYPE_STRUCTURE,
  type ConsentCaptureMethod,
  type ConsentGrantorKind,
  type ConsentRecipientKind,
  type ConsentStatus,
  type ConsentTypeKey,
} from "../interfaces/kinds";
import type { ConsentDpoaAgentKind } from "../interfaces/kinds";
import { type Decision, deny, ok } from "../lifecycle/result";

/** The DPOA grantor kinds whose authority must be proven by an `acting_consent_id` (D5). */
const DPOA_AGENT_GRANTORS = new Set<ConsentGrantorKind>([
  "dpoa_healthcare_agent",
  "dpoa_financial_agent",
]);

/**
 * §2.3 D5 chain-of-authority. A DPOA-agent grantor must reference a *different*, active acting
 * consent record (the DPOA-healthcare/financial record that proves the authority). The self-FK
 * cannot point at the row being signed (the DB CHECK `cr_no_self_acting` is the backstop; this is
 * the friendly service-layer refusal). `patient_self` / `court_guardian` etc. need no acting consent
 * here (court_guardian's evidence path is a separate route-level step-up).
 */
export function validateGrantorChain(input: {
  grantorKind: ConsentGrantorKind;
  consentRecordId: string | null; // the row being signed (null while a brand-new draft has no id)
  actingConsentId: string | null;
  actingConsent: { status: ConsentStatus; typeKey: ConsentTypeKey } | null;
}): Decision {
  if (!DPOA_AGENT_GRANTORS.has(input.grantorKind)) return ok();
  if (input.actingConsentId === null)
    return deny(
      "grantor_authority_missing",
      `${input.grantorKind} requires an acting_consent_id (D5)`,
    );
  if (input.consentRecordId !== null && input.actingConsentId === input.consentRecordId)
    return deny(
      "grantor_self_reference",
      "acting_consent_id cannot equal the consent being signed (D5)",
    );
  if (input.actingConsent === null || input.actingConsent.status !== "active")
    return deny("grantor_authority_missing", "acting consent record is not active (D5)");
  const expected: ConsentTypeKey =
    input.grantorKind === "dpoa_healthcare_agent" ? "dpoa_healthcare" : "dpoa_financial";
  if (input.actingConsent.typeKey !== expected)
    return deny("grantor_authority_missing", `acting consent must be a ${expected} record (D5)`);
  return ok();
}

/** §2.3 D5 parent_for_minor: the grantor's authority lapses when the patient reaches the age of
 *  majority in the jurisdiction. `ageOfMajorityYears` is the M38 per-jurisdiction lookup. */
export function validateParentForMinor(input: {
  grantorKind: ConsentGrantorKind;
  patientAgeYearsAtEffective: number;
  ageOfMajorityYears: number;
}): Decision {
  if (input.grantorKind !== "parent_for_minor") return ok();
  if (input.patientAgeYearsAtEffective >= input.ageOfMajorityYears)
    return deny(
      "grantor_authority_expired_on_majority",
      "parent_for_minor authority does not apply once the patient reaches the age of majority",
    );
  return ok();
}

/** §2.3 D14: `bereaved_person_self` is valid only for `bereavement_outreach_consent` and only when
 *  the patient is deceased at effective time. */
export function validateBereavementGrantor(input: {
  grantorKind: ConsentGrantorKind;
  typeKey: ConsentTypeKey;
  patientDeceased: boolean;
}): Decision {
  if (input.grantorKind !== "bereaved_person_self") return ok();
  if (input.typeKey !== "bereavement_outreach_consent")
    return deny(
      "bereavement_grantor_invalid",
      "bereaved_person_self is only valid for bereavement_outreach_consent",
    );
  if (!input.patientDeceased)
    return deny(
      "bereavement_patient_not_deceased",
      "bereavement consent requires the patient to be deceased (D14)",
    );
  return ok();
}

/** §2.3 D13: only family_caregiver_access / media_release / research_participation may set
 *  `survives_death=true`. */
export function validateSurvivesDeath(typeKey: ConsentTypeKey, survivesDeath: boolean): Decision {
  if (!survivesDeath) return ok();
  if (!CONSENT_TYPE_STRUCTURE[typeKey].survivesDeathEligible)
    return deny(
      "survives_death_not_eligible_for_type",
      `${typeKey} may not set survives_death=true (D13)`,
    );
  return ok();
}

/** §2.3 D13 evaluate-time post-death scope: a patient's own consents terminate on death unless the
 *  type is survives-death-eligible AND `survives_death=true`, or it is the post-mortem bereavement
 *  consent. Returns a refusal the evaluate path surfaces as `allowed:false`. */
export function evaluatePostDeathScope(input: {
  typeKey: ConsentTypeKey;
  survivesDeath: boolean;
  patientDeceased: boolean;
}): Decision {
  if (!input.patientDeceased) return ok();
  const s = CONSENT_TYPE_STRUCTURE[input.typeKey];
  if (s.isPostMortemEligible) return ok(); // bereavement_outreach_consent
  if (s.survivesDeathEligible && input.survivesDeath) return ok();
  return deny("consent_terminated_on_death", `${input.typeKey} terminated on patient death (D13)`);
}

/** §2.3 D1 supersession invariant: the superseded row must match type/patient/org and be active. */
export function validateSupersession(input: {
  prior: {
    typeKey: ConsentTypeKey;
    patientId: string;
    organizationId: string;
    status: ConsentStatus;
  };
  next: { typeKey: ConsentTypeKey; patientId: string; organizationId: string };
}): Decision {
  const { prior, next } = input;
  if (
    prior.typeKey !== next.typeKey ||
    prior.patientId !== next.patientId ||
    prior.organizationId !== next.organizationId
  )
    return deny(
      "supersedes_type_mismatch",
      "superseded row must match type_key + patient_id + organization_id",
    );
  if (prior.status !== "active")
    return deny("supersedes_not_active", "only an active consent record may be superseded (D1)");
  return ok();
}

/** §2.3 D13 renewal invariant: the renewed-from row matches type/patient and is expired or revoked
 *  (the renewal chain is distinct from the supersession chain). */
export function validateRenewal(input: {
  prior: { typeKey: ConsentTypeKey; patientId: string; status: ConsentStatus };
  next: { typeKey: ConsentTypeKey; patientId: string };
}): Decision {
  const { prior, next } = input;
  if (prior.typeKey !== next.typeKey || prior.patientId !== next.patientId)
    return deny("renewed_from_type_mismatch", "renewed-from row must match type_key + patient_id");
  if (prior.status !== "expired" && prior.status !== "revoked")
    return deny("renewed_from_status_invalid", "renewed-from row must be expired or revoked (D13)");
  return ok();
}

/** §2.3 D4/D8: the capture method must be in the platform floor and, when a tenant overlay narrows
 *  the set, in the tighter subset too. */
export function validateCaptureMethod(input: {
  method: ConsentCaptureMethod;
  floor: readonly ConsentCaptureMethod[];
  tighter?: readonly ConsentCaptureMethod[];
}): Decision {
  if (!input.floor.includes(input.method))
    return deny(
      "capture_method_below_floor",
      `${input.method} is not in the platform capture-method floor`,
    );
  if (input.tighter && !input.tighter.includes(input.method))
    return deny(
      "capture_method_below_floor",
      `${input.method} is excluded by the tenant capture-method overlay`,
    );
  return ok();
}

/** §2.3: staff-initiated revocation requires a ≥40-char reason + an evidence document; a patient
 *  revoking via portal is not required to justify. */
export function validateRevocation(input: {
  actorIsStaff: boolean;
  reasonText: string;
  evidenceDocumentId: string | null;
}): Decision {
  if (!input.actorIsStaff) return ok();
  if (input.reasonText.trim().length < 40)
    return deny(
      "revocation_reason_too_short",
      "staff revocation requires a reason ≥ 40 characters",
    );
  if (input.evidenceDocumentId === null)
    return deny(
      "revocation_evidence_required",
      "staff revocation requires an uploaded evidence document",
    );
  return ok();
}

/** §2.3: no future-dated signatures; expiry (if set) is after effective and within the per-type
 *  term ceiling. Times are epoch milliseconds. */
export function validateEffectiveWindow(input: {
  effectiveAtMs: number;
  nowMs: number;
  expiresAtMs: number | null;
  maxTermSeconds: number | null;
}): Decision {
  if (input.effectiveAtMs > input.nowMs)
    return deny("effective_at_future", "effective_at must not be in the future");
  if (input.expiresAtMs !== null) {
    if (input.expiresAtMs <= input.effectiveAtMs)
      return deny("expires_before_effective", "expires_at must be after effective_at");
    if (
      input.maxTermSeconds !== null &&
      input.expiresAtMs - input.effectiveAtMs > input.maxTermSeconds * 1000
    )
      return deny("term_exceeds_max", "consent term exceeds the per-type platform ceiling");
  }
  return ok();
}

/** §2.3: exactly one active `primary` DPOA agent, at most one of each alternate. */
export function validateDpoaAgents(activeAgentKinds: readonly ConsentDpoaAgentKind[]): Decision {
  const counts = new Map<ConsentDpoaAgentKind, number>();
  for (const k of activeAgentKinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  if ((counts.get("primary") ?? 0) !== 1)
    return deny(
      "dpoa_primary_required",
      "a DPOA consent requires exactly one active primary agent",
    );
  for (const alt of ["alternate_1", "alternate_2"] as const)
    if ((counts.get(alt) ?? 0) > 1)
      return deny("dpoa_duplicate_agent_kind", `at most one active ${alt} agent is allowed`);
  return ok();
}

/** §2.3 + D6: a `free_text` recipient carries no entity FK and a ≥5-char name; every other kind
 *  carries the entity FK (validated against the matching M40 table by the service). */
export function validateRecipientFk(input: {
  kind: ConsentRecipientKind;
  entityId: string | null;
  freeText: string | null;
}): Decision {
  if (input.kind === "free_text") {
    if (input.entityId !== null || (input.freeText ?? "").trim().length < 5)
      return deny(
        "recipient_fk_kind_mismatch",
        "free_text recipient needs a null entity FK + a ≥5-char name",
      );
    return ok();
  }
  if (input.entityId === null)
    return deny(
      "recipient_fk_kind_mismatch",
      `recipient_kind '${input.kind}' requires an entity FK`,
    );
  return ok();
}
