// apps/backend/src/modules/25-remittance/routes/recorded-deadline-view.ts - M25 milestone 7a-1: how a recorded_deadline
// row is shown. The end-of-day instant and the status are DERIVED on read from the typed date and the stored zone
// (nothing derived is stored, so nothing goes stale). Shared by the audit-request, later-tier and case-view services.
import type { schema } from "@chartwarden/db";
import {
  type RecordedDeadlineStatus,
  endOfDayInZone,
  parseNoticeDay,
  recordedDeadlineStatus,
} from "../domain";

export type RecordedDeadlineRow = typeof schema.recordedDeadline.$inferSelect;

export interface RecordedDeadlineView {
  readonly id: string;
  readonly subjectKind: "appeal" | "audit_request" | "payer_appeal";
  readonly subjectId: string;
  readonly label: string;
  /** The date as typed from the notice (YYYY-MM-DD). */
  readonly dueOn: string;
  readonly zone: string;
  /** The last instant of `dueOn` in `zone` (ISO). */
  readonly dueAt: string;
  readonly sourceNote: string;
  readonly noticeDocumentId: string | null;
  readonly satisfiedOn: string | null;
  readonly status: RecordedDeadlineStatus;
  readonly version: number;
}

export function viewRecordedDeadline(r: RecordedDeadlineRow, now: Date): RecordedDeadlineView {
  return {
    id: r.id,
    subjectKind: r.appealCaseId ? "appeal" : r.payerAppealCaseId ? "payer_appeal" : "audit_request",
    subjectId: (r.appealCaseId ?? r.payerAppealCaseId ?? r.auditRequestId) as string,
    label: r.label,
    dueOn: r.dueOn,
    zone: r.zone,
    dueAt: endOfDayInZone(parseNoticeDay(r.dueOn), r.zone).toISOString(),
    sourceNote: r.sourceNote,
    noticeDocumentId: r.noticeDocumentId,
    satisfiedOn: r.satisfiedOn,
    status: recordedDeadlineStatus(r, now),
    version: r.version,
  };
}

/** The earliest end-of-day among the unsatisfied deadlines (null = none recorded). */
export function earliestOpenDueAt(rows: readonly RecordedDeadlineRow[]): Date | null {
  const ends = rows
    .filter((r) => r.satisfiedOn === null)
    .map((r) => endOfDayInZone(parseNoticeDay(r.dueOn), r.zone).getTime());
  return ends.length > 0 ? new Date(Math.min(...ends)) : null;
}
