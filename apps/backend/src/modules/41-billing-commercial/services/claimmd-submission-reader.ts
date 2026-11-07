/** M41-owned, read-only facts for account-wide Claim.MD identity routing. No claim mutation or tenant route. */
import { type DbClient, schema } from "@chartwarden/db";
import { inArray } from "drizzle-orm";

const S = schema.commercialSubmissions;

export interface ClaimMdCommercialSubmissionFact {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly claimId: string;
  readonly controlNumber: string;
  readonly payerId: string;
  readonly vendor: string;
}

/** Runs on the caller's audited repeatable-read transaction so evidence and source facts share one snapshot. */
export async function readClaimMdCommercialSubmissionFacts(
  tx: DbClient,
  submissionIds: readonly string[],
): Promise<readonly ClaimMdCommercialSubmissionFact[]> {
  if (submissionIds.length === 0) return [];
  return tx.select({ id: S.id, organizationId: S.organizationId, providerEntityId: S.providerEntityId,
    locationId: S.locationId, claimId: S.claimId, controlNumber: S.controlNumber,
    payerId: S.clearinghousePayerId, vendor: S.clearinghouseKey })
    .from(S).where(inArray(S.id, [...new Set(submissionIds)]));
}
