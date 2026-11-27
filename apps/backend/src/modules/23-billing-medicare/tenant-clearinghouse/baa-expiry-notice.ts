// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/baa-expiry-notice.ts — the warning ahead of a tenant-held vendor BAA's
// end date, and the notice at it (CW-AC-17).
//
// The resolver (resolver.ts) calls this each time it resolves a LIVE configuration whose recorded BAA ends within BAA_EXPIRY_WARN_DAYS
// days or has ended. That is the existing clock: the acknowledgment / remittance pull crons and every claim job resolve each tenant
// account, so no new queue or schedule is added. Per organization and per UTC day this raises
//   - the M36 alert to the tenant (billing manager, compliance officer, org admin): `m23.tenant_clearinghouse.baa_expiring` (warn) ahead
//     of the end date, `m23.tenant_clearinghouse.baa_expired` (critical) once it has passed and the account is held, and
//   - an org-less platform-ops notice through the existing ops sink (a log line and the optional OPS_ALERT_WEBHOOK_URL).
// Ids, the end date and a day count only: never a document reference or any text. Never throws: a broken alert router must not stop a
// resolution (and so a send or a pull for other tenants).
// The tenant alert counts as raised only once its dispatch has resolved: a failed one (the router or the emitter seam not ready yet) is
// tried again on a later resolution, at most once per ALERT_RETRY_MS, rather than waiting for the next day.
// ponytail: the once-a-day memory is per process, so a restart or a second process repeats the notice; the emitter's correlation id
// (the code, the organization and the day) absorbs the tenant alert's repeat. Add a durable memory only if the repeat matters.
import type { WorkerAlertPort } from "../jobs/m23-jobs";
import type { NoticeOpsSink } from "../outbox-consumers/notice-filed-externally-late";

export const BAA_EXPIRING_ALERT = "m23.tenant_clearinghouse.baa_expiring";
export const BAA_EXPIRED_ALERT = "m23.tenant_clearinghouse.baa_expired";
/** A tenant alert whose dispatch failed is tried again after this long, not on every resolution. */
export const ALERT_RETRY_MS = 5 * 60 * 1000;

export interface BaaExpiryNoticeDeps {
  readonly opsNotice: NoticeOpsSink;
  /** The tenant alert (M36's emitter behind the composition root's port). Absent: only the ops notice is raised. */
  readonly alerts?: WorkerAlertPort | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: { readonly event: string; readonly code: string }) => void) | undefined;
}

export interface BaaEnding {
  readonly organizationId: string;
  readonly expiresOn: string;
  /** Whole days to the last day in force; negative once it has passed. */
  readonly daysLeft: number;
}

/**
 * The notifier a resolver calls. Its memory lives as long as the notifier: the ops notice's `day:code` per organization, the tenant
 * alert's `day:code` once its dispatch resolved, and when the alert was last tried (which also keeps a burst of resolutions from
 * dispatching it again while the first is in flight).
 */
export function createBaaExpiryNotifier(deps: BaaExpiryNoticeDeps): (ending: BaaEnding) => void {
  const opsRaised = new Map<string, string>();
  const alertRaised = new Map<string, string>();
  const alertTriedAt = new Map<string, number>();

  const raiseOpsNotice = (
    alertCode: string,
    { organizationId, expiresOn, daysLeft }: BaaEnding,
    day: string,
  ): void => {
    try {
      deps.opsNotice({
        kind: alertCode,
        summary:
          daysLeft < 0
            ? `organization ${organizationId}: the recorded vendor BAA ended ${expiresOn}; its clearinghouse is held until the renewed BAA is recorded and verified`
            : `organization ${organizationId}: the recorded vendor BAA ends ${expiresOn} (${daysLeft} day(s) left); the tenant must record the renewed BAA before then`,
        details: { organizationId, expiresOn, daysLeft },
        correlationId: `${alertCode}:${organizationId}:${day}`,
      });
    } catch {
      deps.log?.({ event: "clearinghouse.baa_expiry_notice_failed", code: "OPS_NOTICE_FAILED" });
    }
  };

  return (ending) => {
    const { organizationId, expiresOn, daysLeft } = ending;
    const at = (deps.now ?? (() => new Date()))();
    const day = at.toISOString().slice(0, 10);
    const ended = daysLeft < 0;
    const alertCode = ended ? BAA_EXPIRED_ALERT : BAA_EXPIRING_ALERT;
    const stamp = `${day}:${alertCode}`;
    if (opsRaised.get(organizationId) !== stamp) {
      opsRaised.set(organizationId, stamp);
      raiseOpsNotice(alertCode, ending, day);
    }
    const { alerts } = deps;
    if (!alerts || alertRaised.get(organizationId) === stamp) return;
    // per alert code: the warning and the notice at the end are different alerts
    const tried = `${organizationId}:${alertCode}`;
    const sinceLastTry = at.getTime() - (alertTriedAt.get(tried) ?? Number.NEGATIVE_INFINITY);
    if (sinceLastTry < ALERT_RETRY_MS) return;
    alertTriedAt.set(tried, at.getTime());
    // started in a microtask so a port that throws before returning a promise is caught like one that rejects
    void Promise.resolve()
      .then(() =>
        alerts.dispatch({
          alertCode,
          severity: ended ? "critical" : "warn",
          organizationId,
          payload: { expiresOn, daysLeft },
        }),
      )
      .then(() => {
        alertRaised.set(organizationId, stamp);
      })
      .catch(() => {
        deps.log?.({ event: "clearinghouse.baa_expiry_alert_failed", code: "ALERT_FAILED" });
      });
  };
}
