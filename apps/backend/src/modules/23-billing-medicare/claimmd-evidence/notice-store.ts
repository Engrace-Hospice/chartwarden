import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import type { X12NoticeEvidence } from "@chartwarden/x12-837-client";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type { createClaimMdEvidenceCipher } from "./cipher";

const E = schema.claimmdNoticeSubmissionEvidence;
const R = schema.claimmdNoticeReceiptObservations;
type Cipher = ReturnType<typeof createClaimMdEvidenceCipher>;
export interface ClaimMdNoticeEvidenceInput {
  readonly organizationId: string; readonly providerEntityId: string; readonly locationId: string | null;
  readonly noticeId: string; readonly noticeKind: "noe" | "notr" | "transfer_notice"; readonly submissionId: string; readonly attemptIndex: number;
  readonly noticeControlNumber: string; readonly accountReference: string; readonly usage: "test" | "production";
  readonly x12: X12NoticeEvidence; readonly outboundReference: string; readonly reservedAt: Date;
}
export interface ClaimMdNoticeEvidencePort {
  readonly accountReference: string; readonly usage: "test" | "production";
  reserve(input: ClaimMdNoticeEvidenceInput): Promise<string>;
  observe(input: { evidenceId: string; organizationId: string; accountReference: string; usage: "test" | "production";
    identifiers: readonly { field: string; namespace: string; value: string }[]; source: "upload_response" | "upload_reconciliation" | "attempt_store_replay" | "verified_status_response";
    sourceReference: string; observedAt: Date }): Promise<void>;
}
export function createClaimMdNoticeEvidenceStore(input: { db: DbClient; cipher: Cipher; accountReference: string; usage: "test" | "production" }): ClaimMdNoticeEvidencePort {
  return {
    accountReference: input.accountReference, usage: input.usage,
    async reserve(v: ClaimMdNoticeEvidenceInput) {
      const id = randomUUID();
      const sealed = await input.cipher.seal({ evidenceId: id, organizationId: v.organizationId, providerEntityId: v.providerEntityId,
        attemptKey: `${v.submissionId}:${v.attemptIndex}`, tin: v.x12.billingTin, recordKind: "notice" });
      return withOrgContext(input.db, { organizationId: v.organizationId, userId: "" }, async (tx) => {
        const inserted = await tx.insert(E).values({ id, organizationId: v.organizationId, providerEntityId: v.providerEntityId,
          locationId: v.locationId, noticeId: v.noticeId, noticeKind: v.noticeKind, submissionId: v.submissionId, attemptIndex: v.attemptIndex,
          vendor: "claimmd", accountReference: v.accountReference, usage: v.usage, billingNpi: v.x12.billingNpi,
          billingTinCiphertext: sealed, payerId: v.x12.payerId, interchangeSenderId: v.x12.interchangeSenderId,
          interchangeReceiverId: v.x12.interchangeReceiverId, functionalSenderId: v.x12.functionalSenderId,
          functionalReceiverId: v.x12.functionalReceiverId, transactionSet: v.x12.transactionSet,
          noticeControlNumber: v.noticeControlNumber, outboundBusinessControlNumber: v.x12.outboundBusinessControlNumber,
          isa13: v.x12.isa13, gs06: v.x12.gs06, st02: v.x12.st02, payloadSha256: v.x12.payloadSha256,
          outboundReference: v.outboundReference, reservedAt: v.reservedAt }).onConflictDoNothing().returning({ id: E.id });
        if (inserted[0]) return id;
        const [old] = await tx.select().from(E).where(and(eq(E.organizationId, v.organizationId), eq(E.submissionId, v.submissionId))).limit(1);
        if (!old) throw new Error("CLAIMMD_NOTICE_EVIDENCE_RESERVATION_FAILED");
        const oldTin = await input.cipher.open({ evidenceId: old.id, organizationId: old.organizationId, providerEntityId: old.providerEntityId,
          attemptKey: `${old.submissionId}:${old.attemptIndex}`, sealed: old.billingTinCiphertext, recordKind: "notice" });
        if (old.noticeId !== v.noticeId || old.noticeKind !== v.noticeKind || old.attemptIndex !== v.attemptIndex ||
            old.providerEntityId !== v.providerEntityId || old.locationId !== v.locationId || old.accountReference !== v.accountReference || old.usage !== v.usage ||
            old.noticeControlNumber !== v.noticeControlNumber || old.outboundBusinessControlNumber !== v.x12.outboundBusinessControlNumber ||
            old.transactionSet !== v.x12.transactionSet || old.isa13 !== v.x12.isa13 || old.gs06 !== v.x12.gs06 || old.st02 !== v.x12.st02 ||
            old.payloadSha256 !== v.x12.payloadSha256 || old.billingNpi !== v.x12.billingNpi || old.payerId !== v.x12.payerId ||
            old.interchangeSenderId !== v.x12.interchangeSenderId || old.interchangeReceiverId !== v.x12.interchangeReceiverId ||
            old.functionalSenderId !== v.x12.functionalSenderId || old.functionalReceiverId !== v.x12.functionalReceiverId || oldTin !== v.x12.billingTin)
          throw new Error("CLAIMMD_NOTICE_EVIDENCE_CONFLICT");
        return old.id;
      });
    },
    async observe(v) {
      await withOrgContext(input.db, { organizationId: v.organizationId, userId: "" }, async (tx) => {
        for (const x of v.identifiers) await tx.insert(R).values({ evidenceId: v.evidenceId, organizationId: v.organizationId,
          accountReference: v.accountReference, usage: v.usage, sourceField: x.field, identifierNamespace: x.namespace,
          externalValue: x.value, observationSource: v.source, sourceReference: v.sourceReference, observedAt: v.observedAt }).onConflictDoNothing();
      });
    },
  };
}
