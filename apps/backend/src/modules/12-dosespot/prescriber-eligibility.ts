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
 * The discipline a draft is RECORDED under. A claim the session holds is honoured (a prescriber who also holds a
 * nursing role may pick); a claim it does not hold is never trusted and never rejected here either — a nurse
 * drafting for a physician legitimately names the physician's discipline in the UI — so the draft is recorded
 * under a held discipline instead, preferring a draft-on-behalf one so the cosign axis stays closed. A session
 * holding no discipline at all cannot draft (422).
 */
export function resolveDraftingDiscipline(held: readonly string[], claimed: string): string {
  const key = claimed.trim().toLowerCase();
  const heldKeys = held.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
  if (heldKeys.includes(key)) return key;
  const onBehalf = heldKeys.find((d) => DRAFT_ON_BEHALF_DISCIPLINES.has(d));
  const fallback = onBehalf ?? heldKeys[0];
  if (fallback) return fallback;
  assertDisciplineHeld(held, claimed); // throws DISCIPLINE_NOT_HELD
  return key;
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

/** The retransmit-standing facts: the sign-standing input minus the status (retransmit is always from failure). */
export type RetransmitStandingInput = Omit<SignerStandingInput, "orderStatus">;

/**
 * The non-throwing read of {@link assertRetransmitStanding}: whether the viewer of an order could retransmit
 * it. False unless the order is `transmission_failed`; otherwise the same `signerStanding` rule the write
 * enforces, so the detail read's `viewerMayRetransmit` can never offer an action the write would refuse.
 */
export function mayRetransmit(orderStatus: string, input: RetransmitStandingInput): boolean {
  if (orderStatus !== "transmission_failed") return false;
  const standing = signerStanding({ ...input, orderStatus });
  return standing.signerEligible && standing.signerIsOrderingPhysician;
}

/**
 * Retransmit standing (spec §2.2 W-MR-08: "the prescriber clicks Retransmit ... the prescriber re-signs"):
 * a signer-eligible discipline who is the order's authoring prescriber or the named physician (roster MDM id
 * match) — the standard-sign rule; there is no on-behalf path. Throws the same machine error codes as sign.
 */
export function assertRetransmitStanding(input: RetransmitStandingInput): void {
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

// ── GAP-034 — the cosignature axis ────────────────────────────────────────────────────────────────────

/** The disciplines that may DRAFT on behalf of a prescriber (§2.1) but can never sign: their orders owe a cosign. */
export const DRAFT_ON_BEHALF_DISCIPLINES: ReadonlySet<string> = new Set([
  "rn_case_manager",
  "clinical_supervisor",
]);

/**
 * GAP-034 — whether an order drafted by `draftingDiscipline` owes a cosignature before it can be signed
 * (M11 §2.5 axis 1 analogue: an order authored below the prescriber tier is supervised). Decided from the
 * session/stored discipline, never from a body field. A prescriber-authored order owes none.
 */
export function cosignRequiredFor(draftingDiscipline: string): boolean {
  return DRAFT_ON_BEHALF_DISCIPLINES.has(draftingDiscipline.trim().toLowerCase());
}

/**
 * GAP-034 follow-up — the discipline the cosign axis is decided from at `requestSignature`: the STORED drafter
 * discipline (`medication_order.drafted_by_discipline`, written from the session at create), so an RN draft a
 * physician then submits still owes the cosign. NULL/blank = legacy/unknown row => the requesting session's
 * discipline (the pre-column behaviour).
 */
export function cosignDraftingDiscipline(
  storedDrafterDiscipline: string | null | undefined,
  requestingDiscipline: string,
): string {
  const stored = storedDrafterDiscipline?.trim();
  return stored ? stored : requestingDiscipline;
}

/** The cosigner roles the platform recognises (the `CosignRequest.cosignerRole` union). */
export type CosignerRole = "rn_case_manager" | "clinical_supervisor" | "medical_director";

/** An RN-tier draft demands a supervising-tier cosigner: a clinical supervisor, or a medical director (who outranks it). */
export const COSIGN_SUPERVISING_ROLES: ReadonlySet<string> = new Set([
  "clinical_supervisor",
  "medical_director",
]);

/** The stored facts + session facts the cosign guard decides from. Nothing here is read off the request body
 * except `claimedRole`, which is validated against `heldRoles`. */
export interface CosignStandingInput {
  readonly orderStatus: string;
  readonly cosignRequired: boolean;
  readonly cosignStatus: string | null;
  readonly claimedRole: CosignerRole;
  /** Roles/disciplines assembled from the SESSION. */
  readonly heldRoles: readonly string[];
  readonly cosignerMembershipId: string;
  readonly drafterMembershipId: string | null;
  /** The membership that will SIGN: the roster row mapped to the order's named physician MDM id (null = none). */
  readonly signerMembershipId: string | null;
}

/**
 * GAP-034 — refuse a cosign unless: the claimed role is held by the session (422), the order is awaiting
 * signature with a pending required cosign (409), the claimed role satisfies the supervising demand (403),
 * and the cosigner is neither the drafter nor the physician who will sign (403, separation of duties).
 */
export function assertCosignStanding(input: CosignStandingInput): void {
  assertDisciplineHeld(input.heldRoles, input.claimedRole);
  if (input.orderStatus !== "pending_signature") {
    throw new WardenXError(
      "COSIGN_NOT_ALLOWED_IN_STATUS",
      `a cosignature can only be attached while the order is pending_signature (it is ${input.orderStatus})`,
      HTTP_CONFLICT,
    );
  }
  if (!input.cosignRequired) {
    throw new WardenXError(
      "COSIGN_NOT_REQUIRED",
      "this medication order requires no cosignature",
      HTTP_CONFLICT,
    );
  }
  if (input.cosignStatus === "attached") {
    throw new WardenXError(
      "ALREADY_COSIGNED",
      "this medication order is already cosigned",
      HTTP_CONFLICT,
    );
  }
  if (!COSIGN_SUPERVISING_ROLES.has(input.claimedRole)) {
    throw new WardenXError(
      "COSIGNER_ROLE_MISMATCH",
      "this order needs a clinical_supervisor or medical_director cosignature",
      HTTP_FORBIDDEN,
    );
  }
  const isDrafter =
    input.drafterMembershipId !== null && input.drafterMembershipId === input.cosignerMembershipId;
  const isSigner =
    input.signerMembershipId !== null && input.signerMembershipId === input.cosignerMembershipId;
  if (isDrafter || isSigner) {
    throw new WardenXError(
      "COSIGN_SELF",
      "a medication order may not be cosigned by its own drafter or by the physician who signs it (§7.3)",
      HTTP_FORBIDDEN,
    );
  }
}

/** 409 — sign is refused while a required cosignature is not attached (M11 §2.2 cosign overlay). */
export function assertCosignSatisfied(order: {
  readonly cosignRequired: boolean;
  readonly cosignStatus: string | null;
}): void {
  if (order.cosignRequired && order.cosignStatus !== "attached") {
    throw new WardenXError(
      "COSIGN_REQUIRED",
      "this medication order requires a cosignature before it can be signed",
      HTTP_CONFLICT,
    );
  }
}
