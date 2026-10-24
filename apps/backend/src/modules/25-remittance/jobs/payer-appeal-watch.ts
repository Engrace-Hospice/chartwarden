// apps/backend/src/modules/25-remittance/jobs/payer-appeal-watch.ts - M25 milestone 12a-1: the two payer-appeal alert
// watches, folded into the existing appeal-deadline cron (no new queue). PURE over injected store ports.
//  * `payer_appeal.deadline_approaching`: a draft level whose path-computed filing deadline crosses the T-30/14/7/1
//    boundaries (the same boundaries as every other deadline), ONCE per boundary (an event row marks it). A deadline a person TYPED rides the existing
//    `deadline.recorded_approaching` (recorded-deadline-watch.ts, subjectKind `payer_appeal`).
//  * `payer_appeal.no_deadline`: an open draft with neither kind of deadline past PAYER_APPEAL_NO_DEADLINE_ALERT_DAYS raises
//    ONE alert (the cron records an event so it never repeats). Nothing is computed for such a case: a person types the date.
// Payloads are ids and day counts only.
import { deadlineAlertBoundary, shouldAlertPayerNoDeadline } from "../domain";
import type { AlertEmission } from "./m25-jobs";

export interface PayerAppealDeadlineRow {
  readonly id: string;
  readonly deadlineAt: string;
  /** The tightest boundary already alerted for this case (null = none yet), read from its `deadline_alerted` events. */
  readonly lastAlertedBoundary: number | null;
}
export interface PayerAppealDeadlineStore {
  draftsWithComputedDeadline(): Promise<PayerAppealDeadlineRow[]>;
}

export async function runPayerAppealDeadlineWatch(
  store: PayerAppealDeadlineStore,
  now: Date,
): Promise<{
  readonly alerts: AlertEmission[];
  /** The (case, boundary) pairs to persist as alerted once the alerts have been dispatched. */
  readonly marks: { readonly id: string; readonly boundary: number }[];
}> {
  const alerts: AlertEmission[] = [];
  const marks: { id: string; boundary: number }[] = [];
  for (const r of await store.draftsWithComputedDeadline()) {
    const boundary = deadlineAlertBoundary(new Date(r.deadlineAt), now);
    // One alert per boundary: a boundary at or wider than the last one alerted is skipped, so a nightly tick never repeats.
    if (boundary !== null && (r.lastAlertedBoundary === null || boundary < r.lastAlertedBoundary)) {
      marks.push({ id: r.id, boundary });
      alerts.push({
        kind: "payer_appeal.deadline_approaching",
        detail: { payerAppealCaseId: r.id, daysRemaining: boundary },
      });
    }
  }
  return { alerts, marks };
}

export interface PayerAppealNoDeadlineRow {
  readonly id: string;
  readonly state: string;
  readonly createdAt: string;
  /** A path-computed deadline or an open recorded deadline exists. */
  readonly hasDeadline: boolean;
  readonly alreadyAlerted: boolean;
}
export interface PayerAppealNoDeadlineStore {
  openDrafts(): Promise<PayerAppealNoDeadlineRow[]>;
}

export async function runPayerAppealNoDeadlineWatch(
  store: PayerAppealNoDeadlineStore,
  now: Date,
): Promise<{ readonly alerts: AlertEmission[]; readonly alertedIds: string[] }> {
  const alerts: AlertEmission[] = [];
  const alertedIds: string[] = [];
  for (const r of await store.openDrafts()) {
    const createdAt = new Date(r.createdAt);
    if (!shouldAlertPayerNoDeadline({ ...r, createdAt }, now)) continue;
    alertedIds.push(r.id);
    alerts.push({
      kind: "payer_appeal.no_deadline",
      detail: { payerAppealCaseId: r.id },
    });
  }
  return { alerts, alertedIds };
}
