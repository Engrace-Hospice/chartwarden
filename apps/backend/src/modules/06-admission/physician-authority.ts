// apps/backend/src/modules/06-admission/physician-authority.ts — the 42 CFR 418.25(a) / 418.26(b) physician
// signer set (FY 2026 / FY 2027 hospice rules). PURE: no I/O, no throw — every caller loads the signer's facts
// (role grants + IDG care-team membership) server-side and maps a refusal onto its own error code.
//
// The same three capacities recur across 418.22(c)(1)(i), 418.25(a)/(b), 418.26(b) and 418.102(b)/(c):
//   · the hospice MEDICAL DIRECTOR                — role key `medical_director`;
//   · the PHYSICIAN DESIGNEE (§ 418.3)            — role key `hospice_physician` (the repo-wide convention:
//                                                   `cti.is_hospice_md` already treats it as the designee);
//   · the PHYSICIAN MEMBER OF THE PATIENT'S IDG   — an MD/DO (role `md`, `hospice_physician` or
//                                                   `medical_director`) holding an OPEN `md` care-team
//                                                   assignment on THIS patient (M5 `patient_assignment`).
// The attending physician (care-team role `attending_clinician`), NPs and PAs are never in the set — FR-F
// declined to add PAs, and the IDG physician seat is MD/DO only (M07-F01 / ADR-0018 D3).
//
// Effective dates (eCFR version history, docs/research/FY2027_HOSPICE_COP_RESEARCH.md §2, §5):
//   · 418.26(b) discharge order — the full set from 2026-10-01; before that the text named only "the hospice
//     medical director", and M6 did not capture an order at all (the legacy rule: no order required).
//   · 418.25(a) admission recommendation — the IDG physician member joined on 2025-10-01; before that the
//     medical director or physician designee only.

/** The signer capacities, in preference order (a user holding several is recorded under the first). */
export const PHYSICIAN_SIGNER_CAPACITIES = [
  "medical_director",
  "physician_designee",
  "idg_physician_member",
] as const;
export type PhysicianSignerCapacity = (typeof PHYSICIAN_SIGNER_CAPACITIES)[number];

/** 418.26(b) as amended by CMS-1851-F: the discharge order is required, from the full signer set. */
export const DISCHARGE_ORDER_EFFECTIVE_DATE = "2026-10-01";
/** 418.25(a) as amended by the FY 2026 rule (90 FR 37431): the IDG physician member may recommend. */
export const IDG_PHYSICIAN_RECOMMENDATION_EFFECTIVE_DATE = "2025-10-01";

/** The role key of the hospice medical director. */
export const MEDICAL_DIRECTOR_ROLE_KEY = "medical_director";
/** The role key the platform uses for the § 418.3 physician designee. */
export const PHYSICIAN_DESIGNEE_ROLE_KEY = "hospice_physician";
/** MD/DO role keys — only these may fill the IDG physician seat (an NP may not). */
export const MD_DO_ROLE_KEYS: ReadonlySet<string> = new Set([
  "md",
  PHYSICIAN_DESIGNEE_ROLE_KEY,
  MEDICAL_DIRECTOR_ROLE_KEY,
]);

/**
 * 418.25(a)'s blocking decision. The recommendation is a SUBPART B PAYMENT condition (not a CoP): missing it
 * makes the episode's claims vulnerable on medical review, it does not make care unlawful. The activation gate
 * already HARD-blocks on the hospice-physician CTI signature (418.22(c)(1)(i): the same signer set, who must
 * weigh the 418.25(b) information), so the recommendation is surfaced as a non-blocking `action_required`
 * checklist item rather than a second hard stop. Flip this to `true` to make it blocking.
 */
export const ADMISSION_RECOMMENDATION_BLOCKS_ACTIVATION = false;

/** The facts a signer is judged on — loaded server-side, never from the request body. */
export interface PhysicianSignerFacts {
  /** The user's live role keys in the org; `null` = no active membership. */
  readonly roleKeys: readonly string[] | null;
  /** True when the user holds an open `md` care-team assignment on THIS patient. */
  readonly idgPhysicianOfPatient: boolean;
}

/** Every capacity the facts back, in preference order. */
export function heldSignerCapacities(facts: PhysicianSignerFacts): PhysicianSignerCapacity[] {
  const roles = facts.roleKeys;
  if (roles === null) return [];
  const held: PhysicianSignerCapacity[] = [];
  if (roles.includes(MEDICAL_DIRECTOR_ROLE_KEY)) held.push("medical_director");
  if (roles.includes(PHYSICIAN_DESIGNEE_ROLE_KEY)) held.push("physician_designee");
  if (facts.idgPhysicianOfPatient && roles.some((r) => MD_DO_ROLE_KEYS.has(r)))
    held.push("idg_physician_member");
  return held;
}

/** ISO date (YYYY-MM-DD) of an ISO date or date-time string. */
const isoDay = (value: string): string => value.slice(0, 10);

/** The capacities 418.26(b) admits for a discharge dated `dischargeDate`. */
export function dischargeOrderCapacities(
  dischargeDate: string,
): readonly PhysicianSignerCapacity[] {
  return isoDay(dischargeDate) >= DISCHARGE_ORDER_EFFECTIVE_DATE
    ? PHYSICIAN_SIGNER_CAPACITIES
    : ["medical_director"];
}

/** The capacities 418.25(a) admits for a recommendation made at `recommendedAt`. */
export function admissionRecommendationCapacities(
  recommendedAt: string,
): readonly PhysicianSignerCapacity[] {
  return isoDay(recommendedAt) >= IDG_PHYSICIAN_RECOMMENDATION_EFFECTIVE_DATE
    ? PHYSICIAN_SIGNER_CAPACITIES
    : ["medical_director", "physician_designee"];
}

/**
 * 418.26(b) — does this discharge need a physician order captured WITH the filing? Every live discharge dated
 * on/after the effective date does. `death` is not a 418.26(a) reason. `for_cause` is excluded because its order
 * IS the route-40 physician cosign, which completes the discharge (the admission stays active until then), so
 * the order still precedes the discharge.
 */
export function dischargeOrderRequiredAtFiling(reason: string, dischargeDate: string): boolean {
  if (reason === "death" || reason === "for_cause") return false;
  return isoDay(dischargeDate) >= DISCHARGE_ORDER_EFFECTIVE_DATE;
}

/** 418.26(b) — does this discharge need a physician order at all (at filing, or via the for-cause cosign)? */
export function dischargeOrderRequired(reason: string, dischargeDate: string): boolean {
  return reason !== "death" && isoDay(dischargeDate) >= DISCHARGE_ORDER_EFFECTIVE_DATE;
}

/** The verdict on a proposed signer. */
export type SignerVerdict =
  | { readonly ok: true; readonly capacity: PhysicianSignerCapacity }
  | { readonly ok: false; readonly message: string };

/**
 * Judge a signer against an allowed capacity set. `claimed` (optional) must be both held and allowed; absent,
 * the first held-and-allowed capacity in preference order is recorded.
 */
export function resolvePhysicianSigner(args: {
  readonly facts: PhysicianSignerFacts;
  readonly allowed: readonly PhysicianSignerCapacity[];
  readonly claimed?: PhysicianSignerCapacity;
}): SignerVerdict {
  const { facts, allowed, claimed } = args;
  if (facts.roleKeys === null)
    return { ok: false, message: "the signer has no active membership in this organization" };
  const held = heldSignerCapacities(facts);
  const eligible = PHYSICIAN_SIGNER_CAPACITIES.filter(
    (c) => held.includes(c) && allowed.includes(c),
  );
  if (claimed !== undefined) {
    if (!allowed.includes(claimed))
      return { ok: false, message: `capacity '${claimed}' is not permitted for this date` };
    if (!held.includes(claimed))
      return { ok: false, message: `the signer does not hold the '${claimed}' capacity` };
    return { ok: true, capacity: claimed };
  }
  const first = eligible[0];
  if (first === undefined)
    return {
      ok: false,
      message:
        "the signer must be the hospice medical director, a physician designee, or the physician member of this patient's IDG",
    };
  return { ok: true, capacity: first };
}

/** True when `signedAt` is not in the future and falls no later than the end of `dischargeDate` (+1 day of TZ slack). */
export function dischargeOrderTimingValid(
  signedAt: string,
  dischargeDate: string,
  now: Date,
): boolean {
  const signed = Date.parse(signedAt);
  if (Number.isNaN(signed) || signed > now.getTime()) return false;
  const dayAfter = Date.parse(`${isoDay(dischargeDate)}T00:00:00Z`) + 2 * 24 * 60 * 60 * 1000;
  return signed < dayAfter;
}

/** A physician who may sign for this patient, with the capacities they hold (for the signer picker). */
export interface PhysicianSignerCandidate {
  readonly userId: string;
  readonly name: string | null;
  readonly capacities: readonly PhysicianSignerCapacity[];
}

/**
 * The server-side source of a signer's facts. Memberships/roles are M3's tables and the care team is M5's, so
 * the production binding (physician-authority-db.ts) reads them through their sanctioned paths; the in-memory
 * slice binds a seeded map. Never consulted with a client-supplied role.
 */
export interface PhysicianAuthorityPort {
  signerFacts(
    organizationId: string,
    userId: string,
    patientId: string,
  ): Promise<PhysicianSignerFacts>;
  listSignerCandidates(
    organizationId: string,
    patientId: string,
  ): Promise<readonly PhysicianSignerCandidate[]>;
}
