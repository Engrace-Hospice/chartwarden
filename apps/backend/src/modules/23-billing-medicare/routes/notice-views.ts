// apps/backend/src/modules/23-billing-medicare/routes/notice-views.ts — the NOE / NOTR row → view projections, shared
// by the read and write services (one mapper, so a column added to the notice cannot reach one surface only). The
// optional `corrections` are the rows filed against this notice (`corrects_notice_id`), for the "corrected by" link.
import type { repositories } from "@chartwarden/billing";
import { noticeAckOutcomeView, noticeCorrectionLinkView } from "./notice-ack-view";
import type {
  NoeView,
  NoticeEvidenceEventView,
  NoticeAttemptSummaryView,
  NoticeExternalFilingView,
  NotrView,
} from "./read-service";
import { assessNoticeDeadline } from "../services/notice-deadline-policy";

const isoReq = (d: Date): string => d.toISOString();

function noticeEvidenceTimeline(input: {
  readonly id: string;
  readonly createdAt: Date;
  readonly latestSubmissionId: string | null;
  readonly acceptedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly externalFilingStatus: "pending" | "filed" | null;
  readonly filedExternallyOn: string | null;
  readonly filedExternallyRecordedAt: Date | null;
  readonly attempt: NoticeAttemptSummaryView | null;
}): NoticeEvidenceEventView[] {
  const events: NoticeEvidenceEventView[] = [{
    kind: "notice_created",
    source: "m23_notice_record",
    at: input.createdAt.toISOString(),
    referenceId: input.id,
    submissionId: null,
    verification: "recorded",
    safeSummary: "Notice record created.",
  }];
  if (input.attempt) events.push({
    kind: "submission_requested", source: "m23_submission_attempt", at: input.attempt.createdAt,
    referenceId: input.attempt.submissionId, submissionId: input.attempt.submissionId,
    verification: "recorded", safeSummary: "Durable submission attempt recorded; this is not proof of transport dispatch.",
  });
  if (input.attempt?.dispatchStartedAt) events.push({
    kind: "dispatch_started", source: "m23_submission_attempt", at: input.attempt.dispatchStartedAt,
    referenceId: input.attempt.submissionId, submissionId: input.attempt.submissionId,
    verification: "recorded", safeSummary: "Dispatch-started boundary recorded; remote receipt is not established by this event.",
  });
  if (input.attempt?.outcome === "submitted" && input.attempt.submittedAt) events.push({
    kind: "transport_receipt_recorded", source: "m23_submission_attempt", at: input.attempt.submittedAt,
    referenceId: input.attempt.submissionId, submissionId: input.attempt.submissionId,
    verification: "recorded", safeSummary: "Transport response recorded; this is not Medicare acceptance evidence.",
  });
  if (input.externalFilingStatus === "filed" && input.filedExternallyRecordedAt) {
    events.push({
      kind: "external_filing_recorded",
      source: "tenant_recorded_external_filing",
      at: input.filedExternallyRecordedAt.toISOString(),
      referenceId: input.id,
      submissionId: input.latestSubmissionId,
      verification: "recorded",
      safeSummary: `Tenant recorded external filing${input.filedExternallyOn ? ` on ${input.filedExternallyOn}` : ""}; this is not MAC acceptance evidence.`,
    });
  }
  if (input.acceptedAt) events.push({
    kind: "mac_accepted", source: "verified_mac_acknowledgment", at: input.acceptedAt.toISOString(),
    referenceId: input.id, submissionId: input.latestSubmissionId, verification: "verified",
    safeSummary: "MAC acceptance recorded from acknowledgment evidence.",
  });
  if (input.rejectedAt) events.push({
    kind: "mac_rejected", source: "verified_mac_acknowledgment", at: input.rejectedAt.toISOString(),
    referenceId: input.id, submissionId: input.latestSubmissionId, verification: "verified",
    safeSummary: "MAC rejection recorded from acknowledgment evidence.",
  });
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

interface ExternalFilingColumns {
  readonly externalFilingStatus: "pending" | "filed" | null;
  readonly filedExternallyOn: string | null;
  readonly filedExternallyRecordedAt: Date | null;
}

/** The "file with your biller" fact (owner decision D4); never who recorded it. */
export function noticeExternalFilingView(
  row: ExternalFilingColumns,
): NoticeExternalFilingView | null {
  if (row.externalFilingStatus === null) return null;
  if (row.externalFilingStatus === "pending") {
    return { status: "filed_externally_pending", filedOn: null, recordedAt: null };
  }
  return {
    status: "filed_externally",
    filedOn: row.filedExternallyOn,
    recordedAt: row.filedExternallyRecordedAt?.toISOString() ?? null,
  };
}

export function mapNoe(
  row: repositories.NoeRecord,
  corrections: readonly repositories.NoeRecord[] = [],
  now: Date = new Date(),
  attempt: NoticeAttemptSummaryView | null = null,
): NoeView {
  const ack = noticeAckOutcomeView(row);
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
    deadline: assessNoticeDeadline({
      kind: "noe", state: row.state, triggerDate: row.electionEffectiveDate,
      persistedDueDate: row.windowTargetAt, acceptedAt: ack.acceptedAt,
      rejectedAt: ack.rejectedAt, now,
      externalFilingOn: row.externalFilingStatus === "filed" ? row.filedExternallyOn ?? null : null,
      attempt,
    }),
    evidenceTimeline: noticeEvidenceTimeline({
      id: row.id, createdAt: row.createdAt, latestSubmissionId: row.latestSubmissionId ?? null,
      acceptedAt: row.acceptedAt ?? null, rejectedAt: row.rejectedAt ?? null,
      externalFilingStatus: row.externalFilingStatus ?? null,
      filedExternallyOn: row.filedExternallyOn ?? null,
      filedExternallyRecordedAt: row.filedExternallyRecordedAt ?? null,
      attempt,
    }),
    externalFiling: noticeExternalFilingView(row),
    noeControlNumber: row.noeControlNumber,
    payerNoeControlNumber: row.payerNoeControlNumber ?? null,
    ...noticeAckOutcomeView(row),
    ...noticeCorrectionLinkView(row, corrections),
    latestSubmissionId: row.latestSubmissionId ?? null,
    latestAttempt: attempt,
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
  now: Date = new Date(),
  finalClaimFiled = false,
  attempt: NoticeAttemptSummaryView | null = null,
): NotrView {
  const ack = noticeAckOutcomeView(row);
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
    deadline: assessNoticeDeadline({
      kind: row.triggerKind === "transfer_out" ? "transfer_8xc" : "notr",
      state: row.state, triggerDate: row.effectiveEndDate,
      persistedDueDate: row.windowTargetAt, acceptedAt: ack.acceptedAt,
      rejectedAt: ack.rejectedAt, now, finalClaimFiled,
      externalFilingOn: row.externalFilingStatus === "filed" ? row.filedExternallyOn ?? null : null,
      attempt,
    }),
    evidenceTimeline: noticeEvidenceTimeline({
      id: row.id, createdAt: row.createdAt, latestSubmissionId: row.latestSubmissionId ?? null,
      acceptedAt: row.acceptedAt ?? null, rejectedAt: row.rejectedAt ?? null,
      externalFilingStatus: row.externalFilingStatus ?? null,
      filedExternallyOn: row.filedExternallyOn ?? null,
      filedExternallyRecordedAt: row.filedExternallyRecordedAt ?? null,
      attempt,
    }),
    externalFiling: noticeExternalFilingView(row),
    state: row.state,
    notrControlNumber: row.notrControlNumber,
    payerNotrControlNumber: row.payerNotrControlNumber ?? null,
    ...noticeAckOutcomeView(row),
    ...noticeCorrectionLinkView(row, corrections),
    latestSubmissionId: row.latestSubmissionId ?? null,
    latestAttempt: attempt,
    latestAcknowledgmentId: row.latestAcknowledgmentId ?? null,
    confirmationDocumentId: row.confirmationDocumentId ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}
