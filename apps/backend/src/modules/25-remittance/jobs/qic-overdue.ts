// apps/backend/src/modules/25-remittance/jobs/qic-overdue.ts - M25 milestone 4: the nightly QIC overdue watch. PURE
// over an injected store port (the m25-jobs.ts posture). A reconsideration the QIC is reviewing whose recorded
// decision date (receipt + 60 days + extensions) has passed, with no escalation request recorded yet, gets one
// `appeal.qic_decision_overdue` alert per night until someone requests escalation or the QIC decides. Folded into the
// existing appeal-deadline cron, so there is no new queue.
//
// The cron has no per-provider zone, so it measures the due day in the LATEST-ending US zone (American Samoa): the
// alert can never fire before the screen offers escalation (which uses the provider's own zone), only up to a day
// after. SME-UNCONFIRMED anchor and day counting: see domain/qic.ts.
import { type QicExtension, deriveQicDecisionClock, isQicOverdue, qicDaysOverdue } from "../domain";
import type { AlertEmission } from "./m25-jobs";

const LATEST_ENDING_US_ZONE = "Pacific/Pago_Pago";

/** An under-review reconsideration with a recorded receipt date, as the overdue cron sees it. */
export interface QicOverdueRow {
  readonly id: string;
  readonly receivedOn: string;
  readonly extensions: readonly QicExtension[];
  readonly escalationRequested: boolean;
}

export interface QicOverdueStore {
  overdueCandidates(): Promise<QicOverdueRow[]>;
}

export async function runQicOverdueWatch(
  store: QicOverdueStore,
  now: Date,
): Promise<{ readonly alerts: AlertEmission[] }> {
  const alerts: AlertEmission[] = [];
  for (const r of await store.overdueCandidates()) {
    if (r.escalationRequested) continue;
    const clock = deriveQicDecisionClock({
      receivedOn: r.receivedOn,
      extensions: r.extensions,
      zones: [LATEST_ENDING_US_ZONE],
    });
    if (!isQicOverdue(clock, now)) continue;
    alerts.push({
      kind: "appeal.qic_decision_overdue",
      appealCaseId: r.id,
      detail: { appealCaseId: r.id, daysOverdue: qicDaysOverdue(clock, now) },
    });
  }
  return { alerts };
}
