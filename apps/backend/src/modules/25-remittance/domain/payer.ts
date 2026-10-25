// Pure payer classification of a denial. The payer is recorded on the remittance advice only, so a
// remittance-sourced denial reaches it through its line; a 277CA- or EVV-sourced denial has no advice and is
// `unknown` (nothing is assumed about its payer). Used by createAppeal to refuse Medicare appeal tiers on a
// Medicaid denial (Medicaid follows the state's path, not the CMS chain).
export type DenialPayerKind = "medicare" | "medicaid" | "commercial" | "unknown";

export interface DenialPayerInput {
  /** `remittance_advice.payer_kind` of the denial's linked line; null/undefined when no advice is linked. */
  readonly adviceKind: string | null | undefined;
}

const KNOWN: ReadonlySet<string> = new Set(["medicare", "medicaid", "commercial"]);

export function denialPayerKind(input: DenialPayerInput): DenialPayerKind {
  return input.adviceKind && KNOWN.has(input.adviceKind)
    ? (input.adviceKind as DenialPayerKind)
    : "unknown";
}

export interface PayerFacts {
  /** `remittance_advice.payer_kind` of the denial's linked line; null/undefined when none is linked. */
  readonly adviceKind: string | null | undefined;
  /** M23 (Medicare) knows the denial's claim id. */
  readonly m23KnowsClaim: boolean;
  /** M24 (Medicaid) knows the denial's claim id. */
  readonly m24KnowsClaim: boolean;
}

/**
 * THE payer decision, shared by the appeal guard and the denial read model so they cannot drift: the advice wins;
 * with no advice, a claim M23 does not know but M24 does is a Medicaid claim; everything else stays unknown.
 * A lookup that failed or was not made is passed as `false`.
 */
export function resolvePayerKind(facts: PayerFacts): DenialPayerKind {
  const fromAdvice = denialPayerKind({ adviceKind: facts.adviceKind });
  if (fromAdvice !== "unknown") return fromAdvice;
  return !facts.m23KnowsClaim && facts.m24KnowsClaim ? "medicaid" : "unknown";
}
