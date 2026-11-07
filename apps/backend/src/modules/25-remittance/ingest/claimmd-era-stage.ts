import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, or } from "drizzle-orm";

const STAGE = schema.claimmdEraM25Stage;
const ADVICE = schema.remittanceAdvice;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface VerifiedClaimMdEraSource {
  readonly inboxId: string; readonly accountReference: string; readonly usage: "test" | "production";
  readonly eraId: string; readonly fileIndex: number; readonly digest: string;
  readonly interchangeControlNumber: string; readonly transactionSetControlNumber: string;
  readonly evidenceCodes: readonly ("EXACT_PAYEE_NPI" | "PAYEE_TIN_CONFIRMED" | "SINGLE_PROVIDER_ARTIFACT")[];
}
export interface ClaimMdEraOwner {
  readonly organizationId: string; readonly providerEntityId: string; readonly locationId: string | null;
}
export interface ClaimMdEraDuplicateFacts {
  readonly paymentTrace: string | null; readonly paymentAmount: string | null;
}

export type ClaimMdEraStageResult =
  | { readonly outcome: "staged" | "possible_duplicate" | "already_staged"; readonly stageId: string }
  | { readonly outcome: "exact_duplicate"; readonly existingAdviceId: string }
  | { readonly outcome: "held"; readonly reason: "SOURCE_UNVERIFIED" | "OWNER_UNVERIFIED" | "CONTROL_INVALID" };

/**
 * M25's no-post boundary. Both proof ports must be implemented by the composition root with audited central
 * source lookup and the M1-owned foundation reader. This service never invokes receiveAdvice/postAdvice/outbox.
 */
export async function stageVerifiedClaimMdEra(input: {
  readonly tenantDb: DbClient; readonly source: VerifiedClaimMdEraSource; readonly owner: ClaimMdEraOwner;
  readonly duplicateFacts: ClaimMdEraDuplicateFacts;
  readonly verifyCapturedSource: (source: VerifiedClaimMdEraSource) => Promise<boolean>;
  readonly verifyProviderAndLocation: (tx: Tx, owner: ClaimMdEraOwner) => Promise<boolean>;
}): Promise<ClaimMdEraStageResult> {
  if (!/^[0-9]{1,64}$/.test(input.source.eraId) || !/^[0-9a-f]{64}$/.test(input.source.digest) ||
      !/^[0-9A-Za-z]{1,9}$/.test(input.source.interchangeControlNumber) ||
      !/^[0-9A-Za-z]{1,9}$/.test(input.source.transactionSetControlNumber) ||
      !Number.isSafeInteger(input.source.fileIndex) || input.source.fileIndex < 0 || input.source.fileIndex > 99)
    return { outcome: "held", reason: "CONTROL_INVALID" };
  if (!(await input.verifyCapturedSource(input.source))) return { outcome: "held", reason: "SOURCE_UNVERIFIED" };
  return withOrgContext(input.tenantDb, { organizationId: input.owner.organizationId, userId: "" }, async (tx) => {
    if (!(await input.verifyProviderAndLocation(tx, input.owner))) return { outcome: "held", reason: "OWNER_UNVERIFIED" };
    const exact = await tx.select({ id: ADVICE.id }).from(ADVICE).where(and(eq(ADVICE.organizationId, input.owner.organizationId),
      eq(ADVICE.providerEntityId, input.owner.providerEntityId), or(eq(ADVICE.fileSha256, input.source.digest), and(
        eq(ADVICE.interchangeControlNumber, input.source.interchangeControlNumber),
        eq(ADVICE.transactionSetControlNumber, input.source.transactionSetControlNumber),
      )))).limit(1);
    const possible = exact.length || !input.duplicateFacts.paymentTrace || !input.duplicateFacts.paymentAmount ? [] :
      await tx.select({ id: ADVICE.id }).from(ADVICE).where(and(
        eq(ADVICE.organizationId, input.owner.organizationId), eq(ADVICE.providerEntityId, input.owner.providerEntityId),
        eq(ADVICE.checkOrEftTraceNumber, input.duplicateFacts.paymentTrace),
        eq(ADVICE.totalPaymentAmount, input.duplicateFacts.paymentAmount),
      )).limit(2);
    const existingStage = await tx.select({ id: STAGE.id, state: STAGE.state }).from(STAGE).where(and(
      eq(STAGE.sourceInboxId, input.source.inboxId), eq(STAGE.fileIndex, input.source.fileIndex),
      eq(STAGE.transactionSetControlNumber, input.source.transactionSetControlNumber))).limit(1);
    if (existingStage[0]) return { outcome: "already_staged", stageId: existingStage[0].id } as const;
    if (exact[0]) return { outcome: "exact_duplicate", existingAdviceId: exact[0].id } as const;
    const state = possible.length ? "possible_duplicate" : "staged";
    const [row] = await tx.insert(STAGE).values({ organizationId: input.owner.organizationId,
      providerEntityId: input.owner.providerEntityId, locationId: input.owner.locationId, sourceInboxId: input.source.inboxId,
      vendor: "claimmd", accountReference: input.source.accountReference, usage: input.source.usage,
      eraId: input.source.eraId, fileIndex: input.source.fileIndex,
      interchangeControlNumber: input.source.interchangeControlNumber,
      transactionSetControlNumber: input.source.transactionSetControlNumber, original835Digest: input.source.digest,
      sourceEvidence: { codes: [...new Set(input.source.evidenceCodes)].sort() }, state,
      safeReasonCode: possible.length ? "POSSIBLE_CROSS_SOURCE_DUPLICATE" : null,
      possibleDuplicateAdviceId: possible.length === 1 ? possible[0]!.id : null,
    }).onConflictDoNothing().returning({ id: STAGE.id });
    if (row) return { outcome: state, stageId: row.id } as const;
    const [raced] = await tx.select({ id: STAGE.id }).from(STAGE).where(and(
      eq(STAGE.sourceInboxId, input.source.inboxId), eq(STAGE.fileIndex, input.source.fileIndex),
      eq(STAGE.transactionSetControlNumber, input.source.transactionSetControlNumber))).limit(1);
    if (!raced) throw new Error("CLAIMMD_ERA_STAGE_WRITE_CONFLICT");
    return { outcome: "already_staged", stageId: raced.id } as const;
  });
}
