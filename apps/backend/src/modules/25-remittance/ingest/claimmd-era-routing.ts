/** Pure fail-closed payee and duplicate decisions for the account-wide Claim.MD ERA path. */
export interface EraProviderIdentity {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly npi: string;
  /** Decrypted only in the caller's short-lived, audited resolver frame. */
  readonly taxId: string;
}
export interface EraPayeeIdentity { readonly npi: string | null; readonly taxId: string | null }
export type EraPayeeResolution =
  | { readonly kind: "verified"; readonly organizationId: string; readonly providerEntityId: string }
  | { readonly kind: "held"; readonly reason: "PAYEE_IDENTITY_MISSING" | "PAYEE_IDENTITY_AMBIGUOUS" | "PAYEE_IDENTITY_CONFLICT" };

export function resolveClaimMdEraPayee(payee: EraPayeeIdentity, candidates: readonly EraProviderIdentity[]): EraPayeeResolution {
  const npi = payee.npi?.replace(/\D/g, "") ?? "";
  const tin = payee.taxId?.replace(/\D/g, "") ?? "";
  if (!npi && !tin) return { kind: "held", reason: "PAYEE_IDENTITY_MISSING" };
  // TIN is never a sufficient tenant/provider selector: affiliated entities may share one.
  if (!npi) return { kind: "held", reason: "PAYEE_IDENTITY_AMBIGUOUS" };
  const byNpi = candidates.filter((candidate) => candidate.npi.replace(/\D/g, "") === npi);
  if (byNpi.length === 0) return { kind: "held", reason: "PAYEE_IDENTITY_MISSING" };
  if (byNpi.length !== 1) return { kind: "held", reason: "PAYEE_IDENTITY_AMBIGUOUS" };
  const match = byNpi[0]!;
  if (tin && match.taxId.replace(/\D/g, "") !== tin)
    return { kind: "held", reason: "PAYEE_IDENTITY_CONFLICT" };
  return { kind: "verified", organizationId: match.organizationId, providerEntityId: match.providerEntityId };
}

export interface EraComponentIdentity {
  readonly fileIndex: number;
  readonly transactionSetControlNumber: string;
  readonly payee: EraPayeeIdentity;
}
export type EraIdentityHoldReason = "PAYEE_IDENTITY_MISSING" | "PAYEE_IDENTITY_AMBIGUOUS" | "PAYEE_IDENTITY_CONFLICT";
export type EraArtifactResolution =
  | { readonly kind: "verified"; readonly organizationId: string; readonly providerEntityId: string; readonly components: readonly EraComponentIdentity[] }
  | { readonly kind: "held"; readonly reason: "EMPTY_ARTIFACT" | "MIXED_PROVIDER_OR_TENANT" | EraIdentityHoldReason };

/** Do not split transaction sets into separate tenant copies; mixed ownership holds the whole source artifact. */
export function resolveClaimMdEraArtifact(
  components: readonly EraComponentIdentity[],
  candidates: readonly EraProviderIdentity[],
): EraArtifactResolution {
  if (components.length === 0) return { kind: "held", reason: "EMPTY_ARTIFACT" };
  let owner: { organizationId: string; providerEntityId: string } | undefined;
  for (const component of components) {
    const resolution = resolveClaimMdEraPayee(component.payee, candidates);
    if (resolution.kind !== "verified") return resolution;
    if (owner && (owner.organizationId !== resolution.organizationId || owner.providerEntityId !== resolution.providerEntityId))
      return { kind: "held", reason: "MIXED_PROVIDER_OR_TENANT" };
    owner = resolution;
  }
  return { kind: "verified", organizationId: owner!.organizationId, providerEntityId: owner!.providerEntityId, components };
}

export type EraDuplicateDecision = "new" | "exact_duplicate" | "possible_duplicate_hold";
export interface ExistingEraIdentity {
  readonly sourceDigest: string;
  readonly interchangeControlNumber: string;
  readonly transactionSetControlNumber: string;
  readonly paymentTraceDigest: string | null;
  readonly paymentAmountMinor: bigint | null;
}
/** Exact source/control identity is a duplicate. Similar trace+amount is held and never auto-merged. */
export function decideClaimMdEraDuplicate(candidate: ExistingEraIdentity, existing: readonly ExistingEraIdentity[]): EraDuplicateDecision {
  if (existing.some((row) => row.sourceDigest === candidate.sourceDigest ||
    (row.interchangeControlNumber === candidate.interchangeControlNumber && row.transactionSetControlNumber === candidate.transactionSetControlNumber)))
    return "exact_duplicate";
  if (existing.some((row) => candidate.paymentTraceDigest !== null && row.paymentTraceDigest === candidate.paymentTraceDigest &&
    candidate.paymentAmountMinor !== null && row.paymentAmountMinor === candidate.paymentAmountMinor))
    return "possible_duplicate_hold";
  return "new";
}
