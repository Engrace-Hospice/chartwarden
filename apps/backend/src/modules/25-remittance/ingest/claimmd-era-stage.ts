import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { ClaimMdProtectedPayloadCipher } from "../../../bootstrap/claimmd-payload-cipher";
import {
  claimMdEraM25SerializationKey,
  classifyClaimMdEraCrossSourceDuplicate,
} from "./claimmd-era-duplicate";

const STAGE = schema.claimmdEraM25Stage;
const ADVICE = schema.remittanceAdvice;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface VerifiedClaimMdEraSource {
  readonly inboxId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly eraId: string;
  readonly fileIndex: number;
  readonly digest: string;
  readonly fileDigest: string;
  readonly resolutionId: string;
  readonly resolutionVersion: number;
  readonly idempotencyKey: string;
  readonly contentDigest: string;
  readonly paymentTraceDigest: string | null;
  readonly interchangeControlNumber: string;
  readonly transactionSetControlNumber: string;
  readonly evidenceCodes: readonly (
    | "EXACT_PAYEE_NPI"
    | "PAYEE_TIN_CONFIRMED"
    | "SINGLE_PROVIDER_ARTIFACT"
  )[];
}
export interface ClaimMdEraOwner {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
}
export interface ClaimMdEraDuplicateFacts {
  readonly paymentTrace: string | null;
  readonly paymentAmount: string | null;
  readonly contentDigest: string;
}
export type ClaimMdEraStageResult =
  | {
      readonly outcome: "staged" | "possible_duplicate" | "exact_duplicate" | "already_staged";
      readonly stageId: string;
      readonly existingAdviceId?: string | null;
    }
  | { readonly outcome: "held"; readonly reason: string };

/** Tenant-scoped, protected, non-posting M25 stage. It has no dependency on the receive/post service or outbox. */
export async function stageVerifiedClaimMdEra(input: {
  readonly tenantDb: DbClient;
  readonly source: VerifiedClaimMdEraSource;
  readonly owner: ClaimMdEraOwner;
  readonly duplicateFacts: ClaimMdEraDuplicateFacts;
  readonly protectedDetails: Readonly<Record<string, unknown>>;
  readonly protectedCipher: ClaimMdProtectedPayloadCipher;
  readonly protectedKeyId: string;
  readonly verifyCapturedSource: (source: VerifiedClaimMdEraSource) => Promise<boolean>;
  readonly verifyProviderAndLocation: (tx: Tx, owner: ClaimMdEraOwner) => Promise<boolean>;
}): Promise<ClaimMdEraStageResult> {
  if (
    !/^[0-9]{1,64}$/.test(input.source.eraId) ||
    !/^[0-9a-f]{64}$/.test(input.source.digest) ||
    !/^[0-9a-f]{64}$/.test(input.source.fileDigest) ||
    !/^[0-9a-f]{64}$/.test(input.source.idempotencyKey) ||
    !/^[0-9a-f]{64}$/.test(input.source.contentDigest) ||
    !input.source.resolutionId ||
    !Number.isSafeInteger(input.source.resolutionVersion) ||
    input.source.resolutionVersion < 1 ||
    !/^[0-9A-Za-z]{1,9}$/.test(input.source.interchangeControlNumber) ||
    !/^[0-9A-Za-z]{1,9}$/.test(input.source.transactionSetControlNumber) ||
    !Number.isSafeInteger(input.source.fileIndex) ||
    input.source.fileIndex < 0 ||
    input.source.fileIndex > 99
  )
    return { outcome: "held", reason: "CONTROL_INVALID" };
  if (!(await input.verifyCapturedSource(input.source)))
    return { outcome: "held", reason: "SOURCE_UNVERIFIED" };
  return withOrgContext(
    input.tenantDb,
    { organizationId: input.owner.organizationId, userId: "" },
    async (tx) => {
      if (!(await input.verifyProviderAndLocation(tx, input.owner)))
        return { outcome: "held", reason: "OWNER_UNVERIFIED" };
      const serializationKey = claimMdEraM25SerializationKey({
        organizationId: input.owner.organizationId,
        providerEntityId: input.owner.providerEntityId,
        paymentTrace: input.duplicateFacts.paymentTrace,
        interchangeControlNumber: input.source.interchangeControlNumber,
        transactionSetControlNumber: input.source.transactionSetControlNumber,
      });
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${serializationKey}, 1))`);
      const exact = await tx
        .select({ id: ADVICE.id })
        .from(ADVICE)
        .where(
          and(
            eq(ADVICE.organizationId, input.owner.organizationId),
            eq(ADVICE.providerEntityId, input.owner.providerEntityId),
            eq(ADVICE.fileSha256, input.source.fileDigest),
            eq(ADVICE.interchangeControlNumber, input.source.interchangeControlNumber),
            eq(ADVICE.transactionSetControlNumber, input.source.transactionSetControlNumber),
            ne(ADVICE.parseStatus, "failed"),
          ),
        )
        .limit(1);
      const sameControls = exact.length
        ? []
        : await tx
            .select({
              id: ADVICE.id,
              fileSha256: ADVICE.fileSha256,
              interchangeControlNumber: ADVICE.interchangeControlNumber,
              transactionSetControlNumber: ADVICE.transactionSetControlNumber,
              checkOrEftTraceNumber: ADVICE.checkOrEftTraceNumber,
              totalPaymentAmount: ADVICE.totalPaymentAmount,
              contentDigest: ADVICE.contentDigest,
            })
            .from(ADVICE)
            .where(
              and(
                eq(ADVICE.organizationId, input.owner.organizationId),
                eq(ADVICE.providerEntityId, input.owner.providerEntityId),
                eq(ADVICE.interchangeControlNumber, input.source.interchangeControlNumber),
                eq(ADVICE.transactionSetControlNumber, input.source.transactionSetControlNumber),
              ),
            )
            .limit(2);
      const traceCandidates =
        !input.duplicateFacts.paymentTrace || !input.duplicateFacts.paymentAmount
          ? []
          : await tx
              .select({
                id: ADVICE.id,
                fileSha256: ADVICE.fileSha256,
                interchangeControlNumber: ADVICE.interchangeControlNumber,
                transactionSetControlNumber: ADVICE.transactionSetControlNumber,
                checkOrEftTraceNumber: ADVICE.checkOrEftTraceNumber,
                totalPaymentAmount: ADVICE.totalPaymentAmount,
                contentDigest: ADVICE.contentDigest,
              })
              .from(ADVICE)
              .where(
                and(
                  eq(ADVICE.organizationId, input.owner.organizationId),
                  eq(ADVICE.providerEntityId, input.owner.providerEntityId),
                  eq(ADVICE.checkOrEftTraceNumber, input.duplicateFacts.paymentTrace),
                  eq(ADVICE.totalPaymentAmount, input.duplicateFacts.paymentAmount),
                ),
              )
              .limit(3);
      const existingStage = await tx
        .select({
          id: STAGE.id,
          state: STAGE.state,
          safeReasonCode: STAGE.safeReasonCode,
          possibleDuplicateAdviceId: STAGE.possibleDuplicateAdviceId,
        })
        .from(STAGE)
        .where(
          and(
            eq(STAGE.sourceInboxId, input.source.inboxId),
            eq(STAGE.fileIndex, input.source.fileIndex),
            eq(STAGE.transactionSetControlNumber, input.source.transactionSetControlNumber),
          ),
        )
        .limit(1);
      if (existingStage[0]) {
        const [row] = await tx
          .select({
            organizationId: STAGE.organizationId,
            providerEntityId: STAGE.providerEntityId,
            original835Digest: STAGE.original835Digest,
            resolutionVersion: STAGE.resolutionVersion,
          })
          .from(STAGE)
          .where(eq(STAGE.id, existingStage[0].id))
          .limit(1);
        if (
          !row ||
          row.organizationId !== input.owner.organizationId ||
          row.providerEntityId !== input.owner.providerEntityId ||
          row.original835Digest !== input.source.digest ||
          row.resolutionVersion !== input.source.resolutionVersion
        )
          return { outcome: "held", reason: "OWNER_UNVERIFIED" } as const;
        if (
          existingStage[0].state === "possible_duplicate" ||
          existingStage[0].safeReasonCode === "POSSIBLE_CROSS_SOURCE_DUPLICATE"
        )
          return {
            outcome: "possible_duplicate",
            stageId: existingStage[0].id,
            existingAdviceId: existingStage[0].possibleDuplicateAdviceId,
          } as const;
        if (existingStage[0].safeReasonCode === "EXACT_DUPLICATE_FROM_M25")
          return {
            outcome: "exact_duplicate",
            stageId: existingStage[0].id,
            existingAdviceId: existingStage[0].possibleDuplicateAdviceId,
          } as const;
        if (existingStage[0].state === "staged")
          return { outcome: "already_staged", stageId: existingStage[0].id } as const;
        if (existingStage[0].safeReasonCode !== "DELIVERY_PREPARED")
          return {
            outcome: "held",
            reason: existingStage[0].safeReasonCode ?? "STAGE_HELD",
          } as const;
        return { outcome: "already_staged", stageId: existingStage[0].id } as const;
      }
      const duplicate = classifyClaimMdEraCrossSourceDuplicate(
        {
          rawFileDigest: input.source.fileDigest,
          interchangeControlNumber: input.source.interchangeControlNumber,
          transactionSetControlNumber: input.source.transactionSetControlNumber,
          paymentTrace: input.duplicateFacts.paymentTrace,
          paymentAmount: input.duplicateFacts.paymentAmount,
          contentDigest: input.duplicateFacts.contentDigest,
        },
        [...sameControls, ...traceCandidates].map((row) => ({
          rawFileDigest: row.fileSha256,
          interchangeControlNumber: row.interchangeControlNumber,
          transactionSetControlNumber: row.transactionSetControlNumber,
          paymentTrace: row.checkOrEftTraceNumber,
          paymentAmount: row.totalPaymentAmount,
          contentDigest: row.contentDigest ?? "",
        })),
      );
      const outcome =
        exact.length || duplicate === "exact_duplicate"
          ? "exact_duplicate"
          : duplicate === "possible_duplicate"
            ? "possible_duplicate"
            : "staged";
      const matchingExisting =
        [...sameControls, ...traceCandidates].find(
          (row) =>
            row.fileSha256 === input.source.fileDigest &&
            row.interchangeControlNumber === input.source.interchangeControlNumber &&
            row.transactionSetControlNumber === input.source.transactionSetControlNumber,
        ) ??
        [...sameControls, ...traceCandidates].find(
          (row) =>
            row.interchangeControlNumber === input.source.interchangeControlNumber &&
            row.transactionSetControlNumber === input.source.transactionSetControlNumber,
        ) ??
        [...sameControls, ...traceCandidates].find(
          (row) =>
            input.duplicateFacts.paymentTrace !== null &&
            row.checkOrEftTraceNumber === input.duplicateFacts.paymentTrace &&
            row.totalPaymentAmount === input.duplicateFacts.paymentAmount,
        );
      const duplicateAdviceId = exact[0]?.id ?? matchingExisting?.id ?? null;
      const ciphertext = input.protectedCipher
        .seal(
          input.source.inboxId,
          input.source.idempotencyKey,
          JSON.stringify(input.protectedDetails),
        )
        .toString("base64");
      const [row] = await tx
        .insert(STAGE)
        .values({
          organizationId: input.owner.organizationId,
          providerEntityId: input.owner.providerEntityId,
          locationId: input.owner.locationId,
          sourceInboxId: input.source.inboxId,
          vendor: "claimmd",
          accountReference: input.source.accountReference,
          usage: input.source.usage,
          eraId: input.source.eraId,
          fileIndex: input.source.fileIndex,
          interchangeControlNumber: input.source.interchangeControlNumber,
          transactionSetControlNumber: input.source.transactionSetControlNumber,
          original835Digest: input.source.digest,
          sourceFileDigest: input.source.fileDigest,
          resolutionId: input.source.resolutionId,
          resolutionVersion: input.source.resolutionVersion,
          idempotencyKey: input.source.idempotencyKey,
          protectedDetailsCipher: ciphertext,
          protectedDetailsKeyId: input.protectedKeyId,
          contentDigest: input.source.contentDigest,
          paymentTraceDigest: input.source.paymentTraceDigest,
          sourceEvidence: { codes: [...new Set(input.source.evidenceCodes)].sort() },
          state: "held",
          safeReasonCode:
            outcome === "exact_duplicate"
              ? "EXACT_DUPLICATE_FROM_M25"
              : outcome === "possible_duplicate"
                ? "POSSIBLE_CROSS_SOURCE_DUPLICATE"
                : "DELIVERY_PREPARED",
          possibleDuplicateAdviceId: duplicateAdviceId,
        })
        .onConflictDoNothing()
        .returning({ id: STAGE.id });
      if (row) return { outcome, stageId: row.id, existingAdviceId: duplicateAdviceId } as const;
      const [raced] = await tx
        .select({
          id: STAGE.id,
          organizationId: STAGE.organizationId,
          providerEntityId: STAGE.providerEntityId,
          original835Digest: STAGE.original835Digest,
          resolutionVersion: STAGE.resolutionVersion,
        })
        .from(STAGE)
        .where(
          and(
            eq(STAGE.sourceInboxId, input.source.inboxId),
            eq(STAGE.fileIndex, input.source.fileIndex),
            eq(STAGE.transactionSetControlNumber, input.source.transactionSetControlNumber),
          ),
        )
        .limit(1);
      if (
        !raced ||
        raced.organizationId !== input.owner.organizationId ||
        raced.providerEntityId !== input.owner.providerEntityId ||
        raced.original835Digest !== input.source.digest ||
        raced.resolutionVersion !== input.source.resolutionVersion
      )
        return { outcome: "held", reason: "OWNER_UNVERIFIED" } as const;
      return { outcome: "already_staged", stageId: raced.id } as const;
    },
  );
}

/** Finalizes a tenant row only after the durable central delivery receipt is committed. */
export async function finalizeClaimMdEraStage(input: {
  readonly tenantDb: DbClient;
  readonly organizationId: string;
  readonly stageIds: readonly string[];
  readonly disposition: "delivered" | "possible_duplicate" | "exact_duplicate" | "held";
  readonly safeReasonCode?: string | null;
  readonly forceHold?: boolean;
}): Promise<void> {
  if (!input.stageIds.length) return;
  const state =
    input.disposition === "delivered"
      ? "staged"
      : input.disposition === "possible_duplicate"
        ? "possible_duplicate"
        : "held";
  const reason =
    input.disposition === "delivered"
      ? null
      : (input.safeReasonCode ??
        (input.disposition === "possible_duplicate"
          ? "POSSIBLE_CROSS_SOURCE_DUPLICATE"
          : input.disposition === "exact_duplicate"
            ? "EXACT_DUPLICATE_FROM_M25"
            : "DELIVERY_HELD"));
  await withOrgContext(
    input.tenantDb,
    { organizationId: input.organizationId, userId: "" },
    async (tx) => {
      const rows = await tx
        .select({ id: STAGE.id, state: STAGE.state, safeReasonCode: STAGE.safeReasonCode })
        .from(STAGE)
        .where(inArray(STAGE.id, [...input.stageIds]));
      if (rows.length !== new Set(input.stageIds).size)
        throw new Error("CLAIMMD_ERA_STAGE_SCOPE_MISMATCH");
      for (const row of rows) {
        if (row.state === state && row.safeReasonCode === reason) continue;
        if (
          row.state !== "held" &&
          !(input.forceHold && (row.state === "staged" || row.state === "possible_duplicate"))
        )
          throw new Error("CLAIMMD_ERA_STAGE_STATE_CONFLICT");
      }
      await tx
        .update(STAGE)
        .set({ state, safeReasonCode: reason })
        .where(
          and(
            inArray(STAGE.id, [...input.stageIds]),
            eq(STAGE.organizationId, input.organizationId),
            inArray(
              STAGE.state,
              input.forceHold ? ["held", "staged", "possible_duplicate"] : ["held"],
            ),
          ),
        );
    },
  );
}
