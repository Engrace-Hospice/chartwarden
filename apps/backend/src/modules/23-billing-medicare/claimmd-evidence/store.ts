import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  X12ClaimEvidence,
  X12SubmittedServiceLineEvidence,
} from "@chartwarden/x12-837-client";
import { and, eq } from "drizzle-orm";
import type { createClaimMdEvidenceCipher } from "./cipher";

const E = schema.claimmdSubmissionEvidence;
const L = schema.claimmdSubmissionLineEvidence;
const R = schema.claimmdSubmissionReceiptObservations;
type Cipher = ReturnType<typeof createClaimMdEvidenceCipher>;

export interface ClaimMdEvidenceInput {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly claimId: string;
  readonly billingModule: "M23" | "M41";
  readonly submissionId: string;
  readonly attemptKey: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly x12Claim: X12ClaimEvidence;
  readonly submittedLines?: readonly {
    readonly internalClaimLineId: string;
    readonly revenueCode: string | null;
    readonly procedureCode: string | null;
    readonly serviceFrom: string | null;
    readonly serviceTo: string | null;
    readonly units: string | null;
    readonly chargeCents: number | null;
  }[];
  readonly payloadSha256: string;
  readonly outboundReference: string;
  readonly reservedAt: Date;
}

export interface ClaimMdReceiptIdentifier {
  readonly field:
    | "fileid"
    | "inboundid"
    | "batchid"
    | "claimid"
    | "claimmd_id"
    | "remote_claimid"
    | "pcn"
    | "responseid"
    | "clearinghouseSubmissionId";
  readonly namespace:
    | "file"
    | "batch"
    | "claim"
    | "remote_claim"
    | "pcn"
    | "message"
    | "opaque_submission";
  readonly value: string;
}

export interface ClaimMdSubmissionEvidencePort {
  readonly accountReference: string;
  readonly usage: "test" | "production";
  reserve(evidence: ClaimMdEvidenceInput): Promise<string>;
  observe(input: {
    evidenceId: string;
    organizationId: string;
    accountReference: string;
    usage: "test" | "production";
    identifiers: readonly ClaimMdReceiptIdentifier[];
    source:
      | "upload_response"
      | "upload_reconciliation"
      | "attempt_store_replay"
      | "verified_status_response";
    sourceReference: string;
    observedAt: Date;
  }): Promise<void>;
}

export function createClaimMdSubmissionEvidenceStore(input: {
  db: DbClient;
  cipher: Cipher;
  accountReference: string;
  usage: "test" | "production";
}) {
  return {
    accountReference: input.accountReference,
    usage: input.usage,
    async reserve(evidence: ClaimMdEvidenceInput): Promise<string> {
      const id = randomUUID();
      const sealed = await input.cipher.seal({
        evidenceId: id,
        organizationId: evidence.organizationId,
        providerEntityId: evidence.providerEntityId,
        attemptKey: evidence.attemptKey,
        tin: evidence.x12Claim.billingTin,
      });
      return withOrgContext(
        input.db,
        { organizationId: evidence.organizationId, userId: "" },
        async (tx) => {
          const persistSubmittedLines = async (evidenceId: string) => {
            if (evidence.submittedLines === undefined) return;
            if (evidence.submittedLines.length !== evidence.x12Claim.serviceLines.length)
              throw new Error("CLAIMMD_LINE_EVIDENCE_COUNT_CONFLICT");
            const values = evidence.submittedLines.map((line, index) => {
              const sent: X12SubmittedServiceLineEvidence | undefined =
                evidence.x12Claim.serviceLines[index];
              if (
                !sent ||
                sent.position !== index + 1 ||
                sent.revenueCode !== line.revenueCode ||
                sent.procedureCode !== line.procedureCode ||
                sent.serviceFrom !== line.serviceFrom ||
                sent.serviceTo !== line.serviceTo ||
                sent.units !== line.units ||
                sent.chargeCents !== line.chargeCents
              )
                throw new Error("CLAIMMD_LINE_EVIDENCE_PAYLOAD_CONFLICT");
              return {
                evidenceId,
                organizationId: evidence.organizationId,
                providerEntityId: evidence.providerEntityId,
                claimId: evidence.claimId,
                submissionId: evidence.submissionId,
                attemptKey: evidence.attemptKey,
                internalClaimLineId: line.internalClaimLineId,
                linePosition: sent.position,
                lineItemControlNumber: sent.lineItemControlNumber,
                revenueCode: sent.revenueCode,
                procedureCode: sent.procedureCode,
                serviceFrom: sent.serviceFrom,
                serviceTo: sent.serviceTo,
                units: sent.units,
                chargeCents: sent.chargeCents,
                payloadSha256: evidence.payloadSha256,
                accountReference: evidence.accountReference,
                usage: evidence.usage,
              };
            });
            if (values.length) await tx.insert(L).values(values).onConflictDoNothing();
            const stored = await tx
              .select()
              .from(L)
              .where(eq(L.evidenceId, evidenceId))
              .orderBy(L.linePosition);
            if (
              stored.length !== values.length ||
              stored.some((row, index) => {
                const expected = values[index];
                return (
                  !expected ||
                  row.internalClaimLineId !== expected.internalClaimLineId ||
                  row.linePosition !== expected.linePosition ||
                  row.lineItemControlNumber !== expected.lineItemControlNumber ||
                  row.payloadSha256 !== expected.payloadSha256 ||
                  row.chargeCents !== expected.chargeCents
                );
              })
            )
              throw new Error("CLAIMMD_LINE_EVIDENCE_IMMUTABILITY_CONFLICT");
          };
          const inserted = await tx
            .insert(E)
            .values({
              id,
              organizationId: evidence.organizationId,
              providerEntityId: evidence.providerEntityId,
              locationId: evidence.locationId,
              claimId: evidence.claimId,
              billingModule: evidence.billingModule,
              submissionId: evidence.submissionId,
              attemptKey: evidence.attemptKey,
              vendor: "claimmd",
              accountReference: evidence.accountReference,
              usage: evidence.usage,
              billingNpi: evidence.x12Claim.billingNpi,
              billingTinCiphertext: sealed,
              payerId: evidence.x12Claim.payerId,
              claimType: evidence.x12Claim.claimType,
              pcn: evidence.x12Claim.pcn,
              isa13: evidence.x12Claim.isa13,
              gs06: evidence.x12Claim.gs06,
              st02: evidence.x12Claim.st02,
              serviceFrom: evidence.x12Claim.serviceFrom,
              serviceTo: evidence.x12Claim.serviceTo,
              payloadSha256: evidence.payloadSha256,
              payloadFormat: "x12",
              outboundReference: evidence.outboundReference,
              reservedAt: evidence.reservedAt,
            })
            .onConflictDoNothing()
            .returning({ id: E.id });
          if (inserted[0]) {
            await persistSubmittedLines(id);
            return id;
          }
          const [existing] = await tx
            .select()
            .from(E)
            .where(
              and(
                eq(E.organizationId, evidence.organizationId),
                eq(E.billingModule, evidence.billingModule),
                eq(E.attemptKey, evidence.attemptKey),
              ),
            )
            .limit(1);
          if (!existing) throw new Error("CLAIMMD_EVIDENCE_RESERVATION_FAILED");
          const oldTin = await input.cipher.open({
            evidenceId: existing.id,
            organizationId: existing.organizationId,
            providerEntityId: existing.providerEntityId,
            attemptKey: existing.attemptKey,
            sealed: existing.billingTinCiphertext,
          });
          if (
            existing.payloadSha256 !== evidence.payloadSha256 ||
            existing.claimId !== evidence.claimId ||
            existing.providerEntityId !== evidence.providerEntityId ||
            existing.accountReference !== evidence.accountReference ||
            existing.usage !== evidence.usage ||
            existing.billingNpi !== evidence.x12Claim.billingNpi ||
            existing.payerId !== evidence.x12Claim.payerId ||
            existing.pcn !== evidence.x12Claim.pcn ||
            oldTin !== evidence.x12Claim.billingTin
          )
            throw new Error("CLAIMMD_EVIDENCE_CONFLICT");
          await persistSubmittedLines(existing.id);
          return existing.id;
        },
      );
    },
    async observe(inputValue: {
      evidenceId: string;
      organizationId: string;
      accountReference: string;
      usage: "test" | "production";
      identifiers: readonly ClaimMdReceiptIdentifier[];
      source:
        | "upload_response"
        | "upload_reconciliation"
        | "attempt_store_replay"
        | "verified_status_response";
      sourceReference: string;
      observedAt: Date;
    }): Promise<void> {
      await withOrgContext(
        input.db,
        { organizationId: inputValue.organizationId, userId: "" },
        async (tx) => {
          for (const identifier of inputValue.identifiers) {
            await tx
              .insert(R)
              .values({
                evidenceId: inputValue.evidenceId,
                organizationId: inputValue.organizationId,
                accountReference: inputValue.accountReference,
                usage: inputValue.usage,
                vendor: "claimmd",
                sourceField: identifier.field,
                identifierNamespace: identifier.namespace,
                externalValue: identifier.value,
                observationSource: inputValue.source,
                sourceReference: inputValue.sourceReference,
                observedAt: inputValue.observedAt,
              })
              .onConflictDoNothing();
          }
        },
      );
    },
  };
}
