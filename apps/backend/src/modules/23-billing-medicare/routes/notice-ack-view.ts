// apps/backend/src/modules/23-billing-medicare/routes/notice-ack-view.ts — the MAC's answer on a NOE / NOTR
// (migration 0377), projected for the read and write services' views alike: the 277CA acceptance date, or the
// 999 / 277CA rejection with its PHI-free reason codes. Never the raw acknowledgment.
import type { NoticeAckOutcomeView } from "./read-service";

interface NoticeAckColumns {
  readonly acceptedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly rejectionStage: "999" | "277ca" | null;
  readonly rejectionCodes: string[] | null;
}

export function noticeAckOutcomeView(row: NoticeAckColumns): NoticeAckOutcomeView {
  return {
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionStage: row.rejectionStage ?? null,
    rejectionCodes: row.rejectionCodes ?? [],
  };
}
