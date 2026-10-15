// M36 WP 3.10 - who a medication question goes to (ADR-0067 D5). Pure: the caller supplies the care team, the primary
// nurse and the eligibility verdict (a lookup that throws must already have been turned into "not eligible").

export type MedicationQuestionAssignee =
  | { readonly kind: "chosen"; readonly userId: string }
  | { readonly kind: "primary_rn"; readonly userId: string }
  | { readonly kind: "unrouted" }
  | { readonly kind: "invalid" };

export interface MedicationQuestionRoutingInput {
  /** The caller's own pick, if any. */
  readonly chosen: string | null;
  /** The patient's open primary-RN assignment, or null. */
  readonly primaryRn: string | null;
  readonly careTeam: readonly string[];
  readonly callerId: string;
  readonly isEligible: (userId: string) => Promise<boolean>;
}

/**
 * 1. A chosen colleague must be on the care team, not the caller, and eligible - else `invalid` (the caller is told, nothing
 *    is written). 2. Otherwise the primary RN, if not the caller and eligible. 3. Otherwise `unrouted`: never a guess.
 */
export async function resolveMedicationQuestionAssignee(
  input: MedicationQuestionRoutingInput,
): Promise<MedicationQuestionAssignee> {
  const { chosen, primaryRn, careTeam, callerId, isEligible } = input;
  if (chosen !== null) {
    const ok = chosen !== callerId && careTeam.includes(chosen) && (await isEligible(chosen));
    return ok ? { kind: "chosen", userId: chosen } : { kind: "invalid" };
  }
  if (primaryRn !== null && primaryRn !== callerId && (await isEligible(primaryRn))) {
    return { kind: "primary_rn", userId: primaryRn };
  }
  return { kind: "unrouted" };
}
