// apps/backend/src/modules/23-billing-medicare/routes/notice-ack-view.ts — the MAC's answer on a NOE / NOTR
// (migration 0377), projected for the read and write services' views alike: the 277CA acceptance date, or the
// 999 / 277CA rejection with its PHI-free reason codes, and (migration 0378) Medicare's own date for that answer
// with its source. Never the raw acknowledgment. Plus the correction chain: the rejected notice a corrected one
// was filed for, and the correction filed for a rejected one.
import type { NoticeState, PayerStatusDateSource } from "@chartwarden/billing";
import type { NoticeAckOutcomeView, NoticeCorrectionLinkView } from "./read-service";

interface NoticeAckColumns {
  readonly acceptedAt: Date | null;
  readonly clearinghouseAcceptedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly rejectionStage: "999" | "277ca" | "clearinghouse" | null;
  readonly rejectionCodes: string[] | null;
  readonly payerStatusDate: string | null;
  readonly payerStatusDateSource: PayerStatusDateSource | null;
}

export function noticeAckOutcomeView(row: NoticeAckColumns): NoticeAckOutcomeView {
  return {
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    clearinghouseAcceptedAt: row.clearinghouseAcceptedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionStage: row.rejectionStage ?? null,
    rejectionCodes: row.rejectionCodes ?? [],
    payerStatusDate: row.payerStatusDate ?? null,
    payerStatusDateSource: row.payerStatusDateSource ?? null,
  };
}

interface CorrectionRow {
  readonly id: string;
  readonly state: NoticeState;
  readonly correctsNoticeId: string | null;
}

/**
 * The correction link both ways. `corrections` are the rows whose `corrects_notice_id` is this notice (newest
 * first); the one shown is the live / accepted one, else the newest (a cancelled or rejected attempt).
 */
export function noticeCorrectionLinkView(
  row: CorrectionRow & { readonly correctionReason: string | null },
  corrections: readonly CorrectionRow[],
): NoticeCorrectionLinkView {
  const mine = corrections.filter((c) => c.correctsNoticeId === row.id);
  const shown =
    mine.find((c) => c.state !== "cancelled" && c.state !== "ack_rejected") ?? mine[0] ?? null;
  return {
    correctsNoticeId: row.correctsNoticeId ?? null,
    correctionReason: row.correctionReason ?? null,
    correctedBy: shown ? { noticeId: shown.id, state: shown.state } : null,
  };
}
