// apps/backend/src/modules/25-remittance/jobs/recorded-deadline-watch.ts - M25 milestone 7a-1: the recorded-deadline
// watch. PURE over an injected store port (the m25-jobs.ts posture). Each open recorded deadline (an ALJ / Council /
// court notice, a RAC / UPIC request letter) alerts at the T-30/14/7/1 boundaries it crosses, ONCE per boundary: the
// cron records the boundary it alerted (`markAlerted`) so a nightly tick never repeats itself. A past date never
// alerts. Folded into the existing appeal-deadline cron (no new queue). The payload is ids and counts only.
import { selectWatchDue } from "../domain";
import type { WatchDeadlineRow } from "../domain";
import type { AlertEmission } from "./m25-jobs";

export interface RecordedDeadlineWatchRow extends WatchDeadlineRow {
  readonly subjectKind: "appeal" | "audit_request" | "payer_appeal";
  readonly subjectId: string;
}

export interface RecordedDeadlineWatchStore {
  openDeadlines(): Promise<RecordedDeadlineWatchRow[]>;
}

export interface RecordedDeadlineWatchResult {
  readonly alerts: AlertEmission[];
  /** The (deadline, boundary) pairs to persist as alerted once the alerts have been dispatched. */
  readonly marks: { readonly id: string; readonly boundary: number }[];
}

export async function runRecordedDeadlineWatch(
  store: RecordedDeadlineWatchStore,
  now: Date,
): Promise<RecordedDeadlineWatchResult> {
  const rows = await store.openDeadlines();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const marks = selectWatchDue(rows, now);
  const alerts: AlertEmission[] = marks.flatMap((m) => {
    const row = byId.get(m.id);
    return row
      ? [
          {
            kind: "deadline.recorded_approaching",
            detail: {
              deadlineId: row.id,
              subjectKind: row.subjectKind,
              subjectId: row.subjectId,
              daysRemaining: m.boundary,
            },
          },
        ]
      : [];
  });
  return { alerts, marks };
}
