// apps/backend/src/modules/23-billing-medicare/routes/notice-views.ts — the NOE / NOTR row → view projections, shared
// by the read and write services (one mapper, so a column added to the notice cannot reach one surface only). The
// optional `corrections` are the rows filed against this notice (`corrects_notice_id`), for the "corrected by" link.
import type { repositories } from "@wardenx/billing";
import { noticeAckOutcomeView, noticeCorrectionLinkView } from "./notice-ack-view";
import type { NoeView, NotrView } from "./read-service";

const isoReq = (d: Date): string => d.toISOString();

export function mapNoe(
  row: repositories.NoeRecord,
  corrections: readonly repositories.NoeRecord[] = [],
): NoeView {
  return {
    noeId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    electionPeriodId: row.electionPeriodId,
    state: row.state,
    electionEffectiveDate: row.electionEffectiveDate,
    windowTargetAt: row.windowTargetAt,
    windowBreachedAt: row.windowBreachedAt ?? null,
    noeControlNumber: row.noeControlNumber,
    payerNoeControlNumber: row.payerNoeControlNumber ?? null,
    ...noticeAckOutcomeView(row),
    ...noticeCorrectionLinkView(row, corrections),
    latestSubmissionId: row.latestSubmissionId ?? null,
    latestAcknowledgmentId: row.latestAcknowledgmentId ?? null,
    confirmationDocumentId: row.confirmationDocumentId ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

export function mapNotr(
  row: repositories.NotrRecord,
  corrections: readonly repositories.NotrRecord[] = [],
): NotrView {
  return {
    notrId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    triggerKind: row.triggerKind,
    revocationEventId: row.revocationEventId ?? null,
    transferEventId: row.transferEventId ?? null,
    dischargeEventId: row.dischargeEventId ?? null,
    effectiveEndDate: row.effectiveEndDate,
    windowTargetAt: row.windowTargetAt,
    windowBreachedAt: row.windowBreachedAt ?? null,
    state: row.state,
    notrControlNumber: row.notrControlNumber,
    payerNotrControlNumber: row.payerNotrControlNumber ?? null,
    ...noticeAckOutcomeView(row),
    ...noticeCorrectionLinkView(row, corrections),
    latestSubmissionId: row.latestSubmissionId ?? null,
    latestAcknowledgmentId: row.latestAcknowledgmentId ?? null,
    confirmationDocumentId: row.confirmationDocumentId ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}
