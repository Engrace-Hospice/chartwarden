// @chartwarden/audit — the durable review log of the security review (CW-MON-01): what the review wrote down.
//
// The review's evidence is the audit trail itself, in two event types, so it is append-only and kept on the 7-year compliance
// schedule (HIPAA §164.316(b)(2)). An organization's rows are sealed by the audit hash chain when it is enabled for them; the
// org-less platform-lane rows are NOT in any seal (the chain is per organization):
//   · `m4.security_review.completed`   — one row per scope per run: the window reviewed, how much was scanned, how many
//                                        findings, how many alerts went where. This is the "we reviewed the log" record, and
//                                        its `windowTo` is also the cursor the next run resumes from (see `readReviewCursor`).
//   · `m4.security_review.alert_raised` — one row per alert, with its delivery outcome (delivered / failed / no_destination).
//
// ORG scope writes through `audit()` on the org transaction; the PLATFORM scope (org-less) through the SECURITY DEFINER
// platform writer, the only sanctioned null-org write path (migration 0187). Both are written atomically with the review's
// own transaction. Context keys are ids, counts, ISO instants and codes: none is on the audit denylist.
import {
  type AuditExecutor,
  type PlatformAuditExecutor,
  audit,
  auditPlatformEvent,
} from "../audit";
import type { SecurityAlert } from "./evaluate";
import {
  type AlertDeliveryStatus,
  type ReviewScope,
  SECURITY_ALERT_RAISED_EVENT,
  SECURITY_REVIEW_COMPLETED_EVENT,
} from "./reader";
import type { SecurityReviewLane } from "./rules";

/** A review transaction can write both ways: the org insert path and the platform SQL function. */
export type ReviewWriteExecutor = AuditExecutor & PlatformAuditExecutor;

export type ReviewRunStatus = "ok" | "delivery_failed";

export interface ReviewRunRecord {
  readonly lane: SecurityReviewLane;
  readonly rulesVersion: string;
  /** `ok`: every alert was delivered (or no destination is configured) — the cursor moves to `windowTo`. `delivery_failed`: it does not, so the next run reviews the same range again. */
  readonly status: ReviewRunStatus;
  readonly windowFrom: string;
  readonly windowTo: string;
  /** The range was longer than the catch-up cap and its start was cut (the gap is in this record, not hidden). */
  readonly catchUpCapped: boolean;
  /** The signal read hit its row cap, so `windowTo` stops at the last row read and the next run continues from there. */
  readonly scanTruncated: boolean;
  readonly eventsScanned: number;
  readonly findings: number;
  readonly newAlerts: number;
  readonly delivered: number;
  readonly failed: number;
  readonly noDestination: number;
  /** New findings that were due but not attempted (the destination failed, or the delivery time budget ran out): the run is `delivery_failed` and the next one raises them. */
  readonly deferred: number;
  /** New findings past the per-run alert cap, rolled into one `review.alert_flood` alert instead of being raised one by one. */
  readonly suppressed: number;
  /** The look-back read hit its row cap, so a burst that straddled the cursor may have been missed (a `review.incomplete_scan` alert says so). */
  readonly overlapTruncated: boolean;
  /** More bulk-access buckets crossed the threshold than the aggregate returns. */
  readonly bulkTruncated: boolean;
}

async function write(
  tx: ReviewWriteExecutor,
  scope: ReviewScope,
  correlationId: string,
  event: {
    readonly eventType: string;
    readonly resourceKind: string;
    readonly severity: "info" | "warn" | "critical";
    readonly context: Record<string, unknown>;
  },
): Promise<void> {
  if (scope.organizationId === null) {
    await auditPlatformEvent(tx, { ...event, outcome: "success", correlationId });
    return;
  }
  await audit(
    tx,
    { organizationId: scope.organizationId, userId: null, actorKind: "system", correlationId },
    { ...event, outcome: "success" },
  );
}

/** One `alert_raised` row: the alert (ids and codes) and what became of its delivery. */
export function recordAlertRaised(
  tx: ReviewWriteExecutor,
  scope: ReviewScope,
  correlationId: string,
  alert: SecurityAlert,
  delivery: AlertDeliveryStatus,
): Promise<void> {
  return write(tx, scope, correlationId, {
    eventType: SECURITY_ALERT_RAISED_EVENT,
    resourceKind: "security_alert",
    severity: alert.severity,
    context: {
      ruleId: alert.ruleId,
      rulesVersion: alert.rulesVersion,
      lane: alert.lane,
      subject: alert.subject,
      count: alert.count,
      windowFrom: alert.windowFrom,
      windowTo: alert.windowTo,
      sampleEventIds: alert.sampleEventIds,
      fingerprint: alert.fingerprint,
      delivery,
    },
  });
}

/** One `completed` row: the review record, and the cursor for the next run. */
export function recordReviewCompleted(
  tx: ReviewWriteExecutor,
  scope: ReviewScope,
  correlationId: string,
  run: ReviewRunRecord,
): Promise<void> {
  return write(tx, scope, correlationId, {
    eventType: SECURITY_REVIEW_COMPLETED_EVENT,
    resourceKind: "security_review",
    severity: run.status === "ok" ? "info" : "warn",
    context: { ...run },
  });
}
