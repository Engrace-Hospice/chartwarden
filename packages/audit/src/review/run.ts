// @chartwarden/audit — one run of the security review for one scope (CW-MON-01): read what happened since the last clean
// review, evaluate the rules, raise each NEW finding once, and write the review record.
//
// The caller owns the transaction (`withOrgContext` for an org, an audited `withPlatformContext` for the org-less lane) and
// the alert sink; this function is the whole decision procedure, so it is tested against both without a worker.
//
// RESUMABLE, NOT PERIODIC. The cursor is the `windowTo` of the newest `completed` row whose status is `ok` (see `record.ts`).
// A run that could not deliver every alert is recorded `delivery_failed` and does NOT move the cursor, so the next run reviews
// the same range again and retries — the alerts already delivered are skipped by fingerprint. A worker that was down for
// hours resumes where it stopped (capped at 24 h; the cap is recorded in the run, not hidden).
//
// BOUNDED. The forward read and the look-back overlap are row-capped. When the forward read is cut short the cursor stops at the
// last row read, so a flood of events cannot make the next run skip anything and cannot stall it either.
import {
  type SecurityAlert,
  type SecurityFinding,
  bulkAccessFindings,
  evaluateSignalRules,
  toSecurityAlert,
} from "./evaluate";
import {
  type AlertDeliveryStatus,
  type ReviewScope,
  type ReviewSqlExecutor,
  readBulkAccessHits,
  readRaisedFingerprints,
  readReviewCursor,
  readSignalEvents,
} from "./reader";
import {
  type ReviewRunRecord,
  type ReviewWriteExecutor,
  recordAlertRaised,
  recordReviewCompleted,
} from "./record";
import {
  type BulkAccessRule,
  SECURITY_REVIEW_RULES_VERSION,
  type SecurityRule,
  type SecuritySeverity,
  type SignalRule,
  maxRuleWindowMs,
  rulesForLane,
  signalEventTypes,
} from "./rules";

/** How far back a run may reach when the previous clean review is older (or there is none): one day. */
export const MAX_CATCH_UP_MS = 24 * 60 * 60 * 1000;
/** Rows read for the new range of one run. */
export const MAX_SIGNAL_ROWS = 20_000;
/** Rows read for the look-back overlap that lets a burst straddling two runs be seen whole. */
export const MAX_OVERLAP_ROWS = 5_000;
/** Alerts raised in one run; the rest wait for the next (the run is recorded `delivery_failed` so the cursor holds). */
export const MAX_ALERTS_PER_RUN = 50;

/** Sends one alert to a human-reachable destination and says how it went. Must not throw (a throw counts as `failed`). */
export type SecurityAlertSink = (alert: SecurityAlert) => Promise<AlertDeliveryStatus>;

export interface SecurityReviewInput {
  /** The review's own transaction: reads and the review record are written on it. */
  readonly tx: ReviewWriteExecutor & ReviewSqlExecutor;
  /** `organizationId: null` reviews the org-less platform lane. */
  readonly scope: ReviewScope;
  readonly rules: readonly SecurityRule[];
  readonly sink: SecurityAlertSink;
  readonly now: Date;
  /** Stitches the run's audit rows together. */
  readonly correlationId: string;
}

export interface RaisedAlert {
  readonly alert: SecurityAlert;
  readonly delivery: AlertDeliveryStatus;
}

export interface SecurityReviewResult {
  readonly run: ReviewRunRecord;
  readonly raised: readonly RaisedAlert[];
}

/** Delivery order: smaller first. */
const SEVERITY_ORDER: Record<SecuritySeverity, number> = { critical: 0, warn: 1, info: 2 };

const isBulk = (r: SecurityRule): r is BulkAccessRule => r.kind === "bulk_access";
const isSignal = (r: SecurityRule): r is SignalRule => !isBulk(r);

async function deliver(
  sink: SecurityAlertSink,
  alert: SecurityAlert,
): Promise<AlertDeliveryStatus> {
  try {
    return await sink(alert);
  } catch {
    return "failed"; // a sink that throws is a failed delivery; the reason is the sink's to log
  }
}

export async function runSecurityReview(input: SecurityReviewInput): Promise<SecurityReviewResult> {
  const { tx, scope, now } = input;
  const lane = scope.organizationId === null ? "platform" : "org";
  const rules = rulesForLane(input.rules, lane);
  const signalRules = rules.filter(isSignal);
  const bulkRules = rules.filter(isBulk);
  const lookbackMs = maxRuleWindowMs(rules);

  // ── the range this run reviews ───────────────────────────────────────────────────────────────────────────────────
  const floor = new Date(now.getTime() - MAX_CATCH_UP_MS);
  const cursor = await readReviewCursor(tx, scope);
  const from = cursor !== null && cursor > floor ? cursor : floor;
  const catchUpCapped = cursor !== null && cursor < floor;
  const overlapFrom = new Date(from.getTime() - lookbackMs);

  const eventTypes = signalEventTypes(signalRules);
  const forward = await readSignalEvents(tx, scope, {
    eventTypes,
    from,
    to: now,
    limit: MAX_SIGNAL_ROWS,
  });
  const overlap =
    lookbackMs > 0
      ? await readSignalEvents(tx, scope, {
          eventTypes,
          from: overlapFrom,
          to: from,
          limit: MAX_OVERLAP_ROWS,
        })
      : { events: [], truncated: false };
  const lastForward = forward.events[forward.events.length - 1];
  // Cut short ⇒ the review stops at the last row it read; the rest is the next run's range. The cursor must always move: if the
  // cap was filled by rows all stamped in one millisecond (one transaction writing tens of thousands of events shares one
  // `created_at`), it steps one millisecond past `from` rather than re-reading the same rows forever — the rows beyond the cap in
  // that one millisecond go unreviewed, and `scanTruncated` says so in the record.
  const windowTo =
    forward.truncated && lastForward
      ? new Date(Math.max(Date.parse(lastForward.createdAt), from.getTime() + 1))
      : now;

  // ── findings ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const events = [
    ...overlap.events,
    ...forward.events.filter((e) => Date.parse(e.createdAt) <= windowTo.getTime()),
  ];
  const findings: SecurityFinding[] = [...evaluateSignalRules(signalRules, events, scope)];
  let bucketFrom = from;
  for (const rule of bulkRules) {
    // The whole fixed bucket that holds the cursor: a bucket seen part-way last run is counted whole this run.
    bucketFrom = new Date(Math.floor(from.getTime() / rule.windowMs) * rule.windowMs);
    const hits = await readBulkAccessHits(tx, scope, {
      from: bucketFrom,
      to: windowTo,
      bucketMs: rule.windowMs,
      threshold: rule.threshold,
    });
    findings.push(...bulkAccessFindings(rule, hits, scope));
  }

  // ── raise each new finding once ──────────────────────────────────────────────────────────────────────────────────
  const since = new Date(Math.min(overlapFrom.getTime(), bucketFrom.getTime()));
  const already = await readRaisedFingerprints(tx, scope, since);
  const fresh = findings.filter((f) => !already.has(f.fingerprint));
  // Most severe first, one at a time: a receiver with a rate limit is not flooded, the alerts that matter most go out first, and
  // the first FAILED delivery stops the run (the destination is down: do not wait out a timeout for every alert behind it).
  // Whatever was not attempted is `deferred`, the run is `delivery_failed`, and the next run raises it.
  const ordered = [...fresh]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        Date.parse(a.windowFrom) - Date.parse(b.windowFrom),
    )
    .slice(0, MAX_ALERTS_PER_RUN);
  const raised: RaisedAlert[] = [];
  for (const finding of ordered) {
    const alert = toSecurityAlert(finding, SECURITY_REVIEW_RULES_VERSION);
    const delivery = await deliver(input.sink, alert);
    raised.push({ alert, delivery });
    await recordAlertRaised(tx, scope, input.correlationId, alert, delivery);
    if (delivery === "failed") break;
  }
  const deferred = fresh.length - raised.length;

  // ── the review record (and, when clean, the next cursor) ─────────────────────────────────────────────────────────
  const count = (status: AlertDeliveryStatus): number =>
    raised.filter((r) => r.delivery === status).length;
  const failed = count("failed");
  const run: ReviewRunRecord = {
    lane,
    rulesVersion: SECURITY_REVIEW_RULES_VERSION,
    status: failed > 0 || deferred > 0 ? "delivery_failed" : "ok",
    windowFrom: from.toISOString(),
    windowTo: windowTo.toISOString(),
    catchUpCapped,
    scanTruncated: forward.truncated,
    eventsScanned: events.length,
    findings: findings.length,
    newAlerts: raised.length,
    delivered: count("delivered"),
    failed,
    noDestination: count("no_destination"),
    deferred,
  };
  await recordReviewCompleted(tx, scope, input.correlationId, run);
  return { run, raised };
}
