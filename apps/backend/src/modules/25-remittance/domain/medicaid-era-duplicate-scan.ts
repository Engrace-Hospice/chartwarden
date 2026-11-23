import type { MedicaidEraObservation } from "./medicaid-era-observation";

/** Replay verdict for one transaction set. `conflict` outranks `exact`, which outranks `possible`. */
export type MedicaidEraDuplicateDecision = "none" | "exact" | "possible" | "conflict";

const RANK: Readonly<Record<MedicaidEraDuplicateDecision, number>> = {
  none: 0,
  possible: 1,
  exact: 2,
  conflict: 3,
};

export function strictestDuplicate(
  ...decisions: readonly MedicaidEraDuplicateDecision[]
): MedicaidEraDuplicateDecision {
  return decisions.reduce((worst, next) => (RANK[next] > RANK[worst] ? next : worst), "none");
}

/** What a set pays: the payment amount and each claim's control numbers, status and amounts. */
const contentKey = (observation: MedicaidEraObservation): string =>
  JSON.stringify([
    observation.source.paymentCents,
    observation.claims.map((claim) => [
      claim.patientControlNumber,
      claim.payerClaimControlNumber,
      claim.statusCode,
      claim.chargeCents,
      claim.paidCents,
    ]),
  ]);

function relation(
  earlier: MedicaidEraObservation,
  later: MedicaidEraObservation,
): MedicaidEraDuplicateDecision {
  const trace = earlier.source.traceNumber;
  if (trace !== null && trace === later.source.traceNumber)
    return contentKey(earlier) === contentKey(later) ? "exact" : "conflict";
  const earlierIcns = new Set(
    earlier.claims.flatMap((claim) =>
      claim.payerClaimControlNumber ? [claim.payerClaimControlNumber] : [],
    ),
  );
  const sharesIcn = later.claims.some(
    (claim) => claim.payerClaimControlNumber && earlierIcns.has(claim.payerClaimControlNumber),
  );
  // Equal zero-dollar sets are routine (denials), so only a repeated nonzero payment amount counts.
  const sharesPayment =
    later.source.paymentCents !== null &&
    later.source.paymentCents > 0 &&
    later.source.paymentCents === earlier.source.paymentCents;
  return sharesIcn || sharesPayment ? "possible" : "none";
}

/**
 * Replay inside ONE artifact: the reader port only knows previously staged files, so two sets in a single interchange
 * that repeat a trace number, a payer claim control number or a nonzero payment amount are classified here. The first
 * set is the original and later repeats are held; a reused trace number with different content is a conflict for both.
 */
// ponytail: pairwise comparison, fine for the handful of sets one interchange carries; index by key if that ever grows.
export function classifyIntraArtifactDuplicates(
  observations: readonly MedicaidEraObservation[],
): readonly MedicaidEraDuplicateDecision[] {
  const decisions: MedicaidEraDuplicateDecision[] = observations.map(() => "none");
  for (let later = 1; later < observations.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const verdict = relation(observations[earlier]!, observations[later]!);
      decisions[later] = strictestDuplicate(decisions[later]!, verdict);
      if (verdict === "conflict") decisions[earlier] = "conflict";
    }
  }
  return decisions;
}
