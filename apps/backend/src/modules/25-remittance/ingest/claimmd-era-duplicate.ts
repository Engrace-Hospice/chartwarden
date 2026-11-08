export interface ClaimMdEraRemittanceIdentity {
  readonly rawFileDigest: string; readonly interchangeControlNumber: string; readonly transactionSetControlNumber: string;
  readonly paymentTrace: string | null; readonly paymentAmount: string | null; readonly contentDigest: string;
}
export type ClaimMdEraCrossSourceDuplicate = "distinct" | "exact_duplicate" | "possible_duplicate";

/** Shared xact-lock key used by non-posting staging and the legacy M25 receive transaction. */
export function claimMdEraM25SerializationKey(input: { readonly organizationId: string; readonly providerEntityId: string;
  readonly paymentTrace: string | null; readonly interchangeControlNumber: string; readonly transactionSetControlNumber: string }): string {
  const identity = input.paymentTrace ? `TRN:${input.paymentTrace}` :
    `ISA:${input.interchangeControlNumber}|ST:${input.transactionSetControlNumber}`;
  return `${input.organizationId}|${input.providerEntityId}|${identity}`;
}

/**
 * Cross-channel identity is deliberately conservative: exact requires the same raw file and ISA/ST identity.
 * Reused ISA/ST controls or TRN+amount are review holds because the legacy M25 row has no vendor payer identity
 * that can safely distinguish an unrelated payer. Amount/date alone never establish a duplicate.
 */
export function classifyClaimMdEraCrossSourceDuplicate(candidate: ClaimMdEraRemittanceIdentity,
  existing: readonly ClaimMdEraRemittanceIdentity[]): ClaimMdEraCrossSourceDuplicate {
  if (existing.some((row) => row.rawFileDigest === candidate.rawFileDigest &&
      row.interchangeControlNumber === candidate.interchangeControlNumber &&
      row.transactionSetControlNumber === candidate.transactionSetControlNumber)) return "exact_duplicate";
  if (existing.some((row) => (row.interchangeControlNumber === candidate.interchangeControlNumber &&
      row.transactionSetControlNumber === candidate.transactionSetControlNumber) ||
      (candidate.paymentTrace !== null && candidate.paymentAmount !== null &&
        row.paymentTrace === candidate.paymentTrace && row.paymentAmount === candidate.paymentAmount))) return "possible_duplicate";
  return "distinct";
}
