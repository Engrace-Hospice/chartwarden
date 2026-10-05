// apps/backend/src/modules/12-dosespot/prescriber-eligibility.ts — M12-T08 the §2.1 / §4.7 prescriber-
// eligibility matrix, in its own leaf module so BOTH the §4.7 ABAC predicate resolver (abac-predicates.ts)
// and the route service (routes/service.ts) can import it without a circular dependency (the service injects
// its `DoseSpotAbacResolver` type into abac-predicates, so the eligibility primitive must live below both).
import { type MedClass, WardenXError } from "@wardenx/types";

/** The disciplines eligible to author a non-controlled medication order (RN drafting-on-behalf included). */
export const PRESCRIBE_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
  "rn_case_manager",
  "clinical_supervisor",
]);

/** The disciplines eligible to author a controlled-substance order (prescriber-only — no RN/CS drafting). */
export const CONTROLLED_PRESCRIBE_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
]);

/**
 * §2.1 / §4.7 — whether a discipline may author a medication order of `medClass`. Controlled substances are
 * prescriber-only (DEA-registered MD/NP/PA); standard / compounded permit the RN-drafting-on-behalf path.
 */
export function prescriberEligible(discipline: string, medClass: MedClass): boolean {
  const d = discipline.toLowerCase();
  if (medClass === "controlled_substance") return CONTROLLED_PRESCRIBE_DISCIPLINES.has(d);
  return PRESCRIBE_DISCIPLINES.has(d);
}

/** The disciplines eligible to SIGN a medication order (§4.6 — prescriber-only; RN drafts, never signs). */
export const SIGNER_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
]);

/** GAP-035 — whether ANY of the caller's session-derived disciplines may sign a medication order. */
export function signerEligibleFor(disciplines: readonly string[]): boolean {
  return disciplines.some((d) => SIGNER_DISCIPLINES.has(d.toLowerCase()));
}

/** The stored facts of the order being signed, plus the signer's server-resolved identity. */
export interface SignerStandingInput {
  readonly disciplines: readonly string[];
  readonly signerMembershipId: string;
  /** `dosespot_prescriber.external_physician_mdm_id` of the signer's ACTIVE roster row (null = none). */
  readonly signerMdmId: string | null;
  readonly orderStatus: string;
  readonly orderPrescriberMembershipId: string | null;
  readonly orderPrescribingPhysicianMdmId: string;
}

/**
 * GAP-035 — the two sign-guard facts, decided from the session actor and the STORED order, never from the
 * request body. Verbal follow-up (§2.3, CMS no-proxy rule): the signer's roster MDM id must equal the
 * named prescriber the recorder stored. Standard sign: the signer authored the order, or is the physician
 * the order names. Anyone else is another prescriber's order; no proxy mechanism exists, so it is refused.
 */
export function signerStanding(input: SignerStandingInput): {
  readonly signerEligible: boolean;
  readonly signerIsOrderingPhysician: boolean;
} {
  const mdmMatches =
    input.signerMdmId !== null && input.signerMdmId === input.orderPrescribingPhysicianMdmId;
  const isAuthor =
    input.orderPrescriberMembershipId !== null &&
    input.orderPrescriberMembershipId === input.signerMembershipId;
  return {
    signerEligible: signerEligibleFor(input.disciplines),
    signerIsOrderingPhysician:
      input.orderStatus === "verbal_pending" ? mdmMatches : isAuthor || mdmMatches,
  };
}

const HTTP_UNPROCESSABLE = 422;
const HTTP_FORBIDDEN = 403;

/**
 * Refuse (422 DISCIPLINE_NOT_HELD) a body-supplied discipline the authenticated caller's session does not
 * hold — the M11 `assertDisciplineHeld` idiom, kept local so M12 takes no import edge into M11. The body
 * still names a discipline (the API contract) but the value the lifecycle machine sees is one the actor has.
 */
export function assertDisciplineHeld(held: readonly string[], claimed: string): void {
  const key = claimed.trim().toLowerCase();
  if (held.some((d) => d.trim().toLowerCase() === key)) return;
  throw new WardenXError(
    "DISCIPLINE_NOT_HELD",
    `The caller does not hold the '${claimed}' discipline.`,
    HTTP_UNPROCESSABLE,
  );
}

/**
 * Spec §2.2 rule "recording actor is RN+": the seniority floor for RECORDING a verbal order (an RN may record
 * one she could not author). LPN, aide and non-nursing disciplines are below it. Local copy of M11's set
 * (`11-orders/routes/server-derived-facts.ts`) — M12 takes no import edge into M11. Role keys double as
 * disciplines here, so the RN-equivalent and physician role keys are included.
 */
export const VERBAL_RECORDER_DISCIPLINES: ReadonlySet<string> = new Set([
  "rn",
  "rn_case_manager",
  "np",
  "pa",
  "md",
  "physician",
  "hospice_physician",
  "medical_director",
]);

export function isVerbalRecorderDiscipline(discipline: string): boolean {
  return VERBAL_RECORDER_DISCIPLINES.has(discipline.trim().toLowerCase());
}

const HTTP_CONFLICT = 409;

/** 409 — the external physician MDM id is already mapped to another ACTIVE roster row in this tenant. */
export function mdmIdAlreadyEnrolled(): WardenXError {
  return new WardenXError(
    "MDM_ID_ALREADY_ENROLLED",
    "That external physician MDM id is already enrolled for another prescriber in this organization; revoke that roster entry first.",
    HTTP_CONFLICT,
  );
}

/** 422 — the verbal order's named prescriber MDM id has no active roster row, so nobody could ever sign it. */
export function namedPrescriberNotEnrolled(): WardenXError {
  return new WardenXError(
    "NAMED_PRESCRIBER_NOT_ENROLLED",
    "No enrolled DoseSpot prescriber is mapped to the named prescriber; enroll them (with their external physician MDM id) before recording the verbal order.",
    HTTP_UNPROCESSABLE,
  );
}

/**
 * Retransmit standing (spec §2.2 W-MR-08: "the prescriber clicks Retransmit ... the prescriber re-signs"):
 * a signer-eligible discipline who is the order's authoring prescriber or the named physician (roster MDM id
 * match) — the standard-sign rule; there is no on-behalf path. Throws the same machine error codes as sign.
 */
export function assertRetransmitStanding(input: Omit<SignerStandingInput, "orderStatus">): void {
  const standing = signerStanding({ ...input, orderStatus: "transmission_failed" });
  if (!standing.signerEligible) {
    throw new WardenXError(
      "SIGNER_NOT_ELIGIBLE",
      "the retransmitting discipline is not eligible to sign medication orders",
      HTTP_FORBIDDEN,
    );
  }
  if (!standing.signerIsOrderingPhysician) {
    throw new WardenXError(
      "SIGNER_NOT_ORDERING_PHYSICIAN",
      "only the order's prescriber or the named ordering physician may retransmit it",
      HTTP_FORBIDDEN,
    );
  }
}
