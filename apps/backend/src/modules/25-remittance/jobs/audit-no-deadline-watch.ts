// apps/backend/src/modules/25-remittance/jobs/audit-no-deadline-watch.ts - M25 milestone 7a-1: an open audit request
// (RAC / UPIC / SMRC / other) with no recorded due date past AUDIT_NO_DEADLINE_ALERT_DAYS raises ONE
// `audit.no_deadline_recorded` alert (the cron records `no_deadline_alerted_at`, so it never repeats). No clock is
// computed for an audit: the whole point is that a person must type the date from the request letter. PURE over an
// injected store port; the payload is ids and a day count only.
import { shouldAlertNoDeadline } from "../domain";
import type { AlertEmission } from "./m25-jobs";

const MS_PER_DAY = 86_400_000;

export interface AuditNoDeadlineRow {
  readonly id: string;
  readonly state: string;
  readonly createdAt: string;
  /** True when the request has at least one unsatisfied recorded deadline. */
  readonly hasDeadline: boolean;
  readonly alreadyAlerted: boolean;
}

export interface AuditNoDeadlineStore {
  openAudits(): Promise<AuditNoDeadlineRow[]>;
}

export interface AuditNoDeadlineResult {
  readonly alerts: AlertEmission[];
  readonly alertedIds: string[];
}

export async function runAuditNoDeadlineWatch(
  store: AuditNoDeadlineStore,
  now: Date,
): Promise<AuditNoDeadlineResult> {
  const alerts: AlertEmission[] = [];
  const alertedIds: string[] = [];
  for (const r of await store.openAudits()) {
    const createdAt = new Date(r.createdAt);
    if (!shouldAlertNoDeadline({ ...r, createdAt }, now)) continue;
    alertedIds.push(r.id);
    alerts.push({
      kind: "audit.no_deadline_recorded",
      detail: {
        auditRequestId: r.id,
        daysOpen: Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY),
      },
    });
  }
  return { alerts, alertedIds };
}
