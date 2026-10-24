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
