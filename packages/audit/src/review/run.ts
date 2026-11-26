// @chartwarden/audit — one run of the security review for one scope (CW-MON-01): read what happened since the last clean
// review, evaluate the rules, raise each NEW finding once, and write the review record.
//
// The caller owns the transaction (`withOrgContext` for an org, an audited `withPlatformContext` for the org-less lane) and
// the alert sink; this module is the whole decision procedure, so it is tested against both without a worker.
//
// ONE RUN PER SCOPE AT A TIME. The first statement is a transaction-scoped advisory lock keyed on the scope; a run that cannot
// take it (a tick that outlasted its 15 minutes, a second replica, a stalled-job re-run) is `skipped`, so two runs never read the
// same cursor and deliver every alert twice. The lock is held across delivery on purpose, and the delivery is bounded (below).
//
// RESUMABLE, NOT PERIODIC. The cursor is the `windowTo` of the newest `completed` row whose status is `ok` (see `record.ts`).
// A run that could not deliver every alert is recorded `delivery_failed` and does NOT move the cursor, so the next run reviews
// the same range again and retries — the alerts already delivered are skipped. A worker that was down for hours resumes where it
// stopped (capped at 24 h; the cap is recorded in the run and raised as a `review.incomplete_scan` alert, not hidden).
//
// ONCE, NOT EVERY RUN. A finding is skipped when its exact fingerprint was already raised, and a burst / distinct / bulk finding is
// also held back when the same (rule, subject) was alerted within `ALERT_COOLDOWN_MS` — the scan range moves every run, so a
// sustained attack would otherwise re-fire with a new anchor each time.
//
// BOUNDED. Reads are row-capped; when the forward read is cut short the cursor stops at the last row read, so a flood of events can
// neither make the next run skip anything nor stall it. More new findings than `MAX_ALERTS_PER_RUN` are rolled into one
// `review.alert_flood` alert (an attacker who can mint findings cannot pin the cursor or page-storm the destination), and delivery
// is sequential, most severe first, stops at the first failure, and stops after `DELIVERY_BUDGET_MS`.
import {
  type RaisedAlertRef,
  type ReviewEvent,
  type SecurityAlert,
  type SecurityFinding,
  bulkAccessFindings,
  evaluateSignalRules,
  isWithinCooldown,
  noticeFinding,
  toSecurityAlert,
} from "./evaluate";
import {
  type AlertDeliveryStatus,
  type ReviewScope,
  type ReviewSqlExecutor,
  readBulkAccessHits,
  readRaisedAlerts,
  readReviewCursor,
  readSignalEvents,
  tryAcquireReviewLock,
} from "./reader";
import {
  type ReviewRunRecord,
  type ReviewWriteExecutor,
  recordAlertRaised,
  recordReviewCompleted,
} from "./record";
import {
  ALERT_COOLDOWN_MS,
  type BulkAccessRule,
  REVIEW_NOTICE_RULES,
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
/** Individual alerts raised in one run; the rest become one `review.alert_flood` alert. */
export const MAX_ALERTS_PER_RUN = 50;
/** How long one run may spend delivering while it holds its transaction and the scope's lock. */
export const DELIVERY_BUDGET_MS = 30_000;

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
  /** Overrides {@link DELIVERY_BUDGET_MS} (tests). */
  readonly deliveryBudgetMs?: number;
}

export interface RaisedAlert {
  readonly alert: SecurityAlert;
  readonly delivery: AlertDeliveryStatus;
}

export type SecurityReviewResult =
  /** Another run of this scope held the lock: nothing was read or written. */
  | { readonly skipped: true; readonly run: null; readonly raised: readonly [] }
  | {
      readonly skipped: false;
      readonly run: ReviewRunRecord;
      readonly raised: readonly RaisedAlert[];
    };

/** Delivery order: smaller first. */
const SEVERITY_ORDER: Record<SecuritySeverity, number> = { critical: 0, warn: 1, info: 2 };
const bySeverityThenTime = (a: SecurityFinding, b: SecurityFinding): number =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
  Date.parse(a.windowFrom) - Date.parse(b.windowFrom);

const isBulk = (r: SecurityRule): r is BulkAccessRule => r.kind === "bulk_access";
const isSignal = (r: SecurityRule): r is SignalRule => !isBulk(r);

interface ReviewRange {
  readonly from: Date;
  readonly overlapFrom: Date;
  readonly catchUpCapped: boolean;
}

/** From the last clean review (never further back than a day) to now, plus the look-back that lets a straddling burst be seen whole. */
async function reviewRange(
  tx: ReviewSqlExecutor,
  scope: ReviewScope,
  now: Date,
  lookbackMs: number,
): Promise<ReviewRange> {
  const floor = new Date(now.getTime() - MAX_CATCH_UP_MS);
  const cursor = await readReviewCursor(tx, scope);
  const from = cursor !== null && cursor > floor ? cursor : floor;
  return {
    from,
    overlapFrom: new Date(from.getTime() - lookbackMs),
    catchUpCapped: cursor !== null && cursor < floor,
  };
}

interface Scan {
  readonly eventsScanned: number;
  readonly findings: readonly SecurityFinding[];
  readonly windowTo: Date;
  readonly forwardTruncated: boolean;
  /** The forward cap was filled by rows all stamped in one millisecond, so the cursor had to step past them. */
  readonly cursorStepped: boolean;
  readonly overlapTruncated: boolean;
  readonly bulkTruncated: boolean;
  /** The earliest instant any read started from. */
  readonly earliestReadFrom: Date;
}

async function scanRange(
  input: SecurityReviewInput,
  signalRules: readonly SignalRule[],
  bulkRules: readonly BulkAccessRule[],
  range: ReviewRange,
): Promise<Scan> {
  const { tx, scope, now } = input;
  const { from, overlapFrom } = range;
  const eventTypes = signalEventTypes(signalRules);
  const forward = await readSignalEvents(tx, scope, {
    eventTypes,
    from,
    to: now,
    limit: MAX_SIGNAL_ROWS,
  });
  const overlap =
    overlapFrom < from
      ? await readSignalEvents(tx, scope, {
          eventTypes,
          from: overlapFrom,
          to: from,
          limit: MAX_OVERLAP_ROWS,
        })
      : { events: [] as readonly ReviewEvent[], truncated: false };
  const lastForward = forward.events[forward.events.length - 1];
  // Cut short ⇒ the review stops at the last row it read; the rest is the next run's range. The cursor must always move: if the
  // cap was filled by rows all stamped in one millisecond (one transaction writing tens of thousands of events shares one
  // `created_at`), it steps one millisecond past `from` rather than re-reading the same rows forever — the rows beyond the cap in
  // that one millisecond go unreviewed, and the run says so.
  const lastMs = lastForward ? Date.parse(lastForward.createdAt) : 0;
  const cursorStepped = forward.truncated && lastMs <= from.getTime();
  const windowTo =
    forward.truncated && lastForward ? new Date(Math.max(lastMs, from.getTime() + 1)) : now;

  const events = [...overlap.events, ...forward.events];
  const findings: SecurityFinding[] = [...evaluateSignalRules(signalRules, events, scope)];
  let earliestReadFrom = overlapFrom;
  let bulkTruncated = false;
  for (const rule of bulkRules) {
    // The whole fixed bucket that holds the cursor: a bucket seen part-way last run is counted whole this run.
    const bucketFrom = new Date(Math.floor(from.getTime() / rule.windowMs) * rule.windowMs);
    if (bucketFrom < earliestReadFrom) earliestReadFrom = bucketFrom;
    const read = await readBulkAccessHits(tx, scope, {
      from: bucketFrom,
      to: windowTo,
      bucketMs: rule.windowMs,
      threshold: rule.threshold,
    });
    bulkTruncated = bulkTruncated || read.truncated;
    findings.push(...bulkAccessFindings(rule, read.hits, scope));
  }
  return {
    eventsScanned: events.length,
    findings,
    windowTo,
    forwardTruncated: forward.truncated,
    cursorStepped,
    overlapTruncated: overlap.truncated,
    bulkTruncated,
    earliestReadFrom,
  };
}

/**
 * The findings still worth raising: not an exact repeat of an alert already delivered, and not inside the cooldown of one (counting
 * the earlier findings of this very run, so several windows of one sustained attack raise once).
 */
async function newFindings(
  input: SecurityReviewInput,
  rules: readonly SecurityRule[],
  scan: Scan,
): Promise<readonly SecurityFinding[]> {
  const memory: RaisedAlertRef[] = [
    ...(await readRaisedAlerts(
      input.tx,
      input.scope,
      new Date(scan.earliestReadFrom.getTime() - ALERT_COOLDOWN_MS),
    )),
  ];
  const exact = new Set(memory.map((m) => m.fingerprint));
  const alwaysIds = new Set(rules.filter((r) => r.kind === "always").map((r) => r.id));
  const isAlways = (ruleId: string): boolean => alwaysIds.has(ruleId);
  const fresh: SecurityFinding[] = [];
  for (const finding of [...scan.findings].sort(
    (a, b) => Date.parse(a.windowFrom) - Date.parse(b.windowFrom),
  )) {
    if (exact.has(finding.fingerprint) || isWithinCooldown(finding, memory, ALERT_COOLDOWN_MS, isAlways)) {
      continue;
    }
    fresh.push(finding);
    memory.push({
      fingerprint: finding.fingerprint,
      ruleId: finding.ruleId,
      subjectKind: finding.subject.kind,
      subjectRef: finding.subject.ref,
      windowToMs: Date.parse(finding.windowTo),
    });
  }
  return fresh;
}

/** The findings about the review itself, for what it could not do completely. */
function notices(
  scope: ReviewScope,
  range: ReviewRange,
  scan: Scan,
  suppressed: number,
): SecurityFinding[] {
  const window = { windowFrom: range.from.toISOString(), windowTo: scan.windowTo.toISOString() };
  const out: SecurityFinding[] = [];
  if (suppressed > 0) {
    out.push(
      noticeFinding(REVIEW_NOTICE_RULES.alertFlood, scope, {
        count: suppressed,
        ref: "suppressed",
        ...window,
      }),
    );
  }
  const gaps = [
    scan.overlapTruncated ? "overlap_truncated" : null,
    scan.bulkTruncated ? "bulk_truncated" : null,
    range.catchUpCapped ? "catch_up_capped" : null,
    scan.cursorStepped ? "cursor_stepped" : null,
  ].filter((g): g is string => g !== null);
  if (gaps.length > 0) {
    out.push(
      noticeFinding(REVIEW_NOTICE_RULES.incompleteScan, scope, {
        count: gaps.length,
        ref: gaps.join(","),
        ...window,
      }),
    );
  }
  return out;
}

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

/**
 * Deliver the due findings most severe first, one at a time, recording each. The first FAILED delivery stops the run (the
 * destination is down: do not wait out a timeout per alert behind it), and so does the time budget; whatever was not attempted is
 * the caller's `deferred`.
 */
async function raiseAll(
  input: SecurityReviewInput,
  due: readonly SecurityFinding[],
): Promise<RaisedAlert[]> {
  const budget = input.deliveryBudgetMs ?? DELIVERY_BUDGET_MS;
  const started = Date.now();
  const raised: RaisedAlert[] = [];
  for (const finding of due) {
    if (raised.length > 0 && Date.now() - started >= budget) break;
    const alert = toSecurityAlert(finding, SECURITY_REVIEW_RULES_VERSION);
    const delivery = await deliver(input.sink, alert);
    raised.push({ alert, delivery });
    await recordAlertRaised(input.tx, input.scope, input.correlationId, alert, delivery);
    if (delivery === "failed") break;
  }
  return raised;
}

export async function runSecurityReview(input: SecurityReviewInput): Promise<SecurityReviewResult> {
  const { tx, scope } = input;
  if (!(await tryAcquireReviewLock(tx, scope))) return { skipped: true, run: null, raised: [] };

  const lane = scope.organizationId === null ? "platform" : "org";
  const rules = rulesForLane(input.rules, lane);
  const range = await reviewRange(tx, scope, input.now, maxRuleWindowMs(rules));
  const scan = await scanRange(input, rules.filter(isSignal), rules.filter(isBulk), range);

  const fresh = [...(await newFindings(input, rules, scan))].sort(bySeverityThenTime);
  const individual = fresh.slice(0, MAX_ALERTS_PER_RUN);
  const suppressed = fresh.length - individual.length;
  const due = [...individual, ...notices(scope, range, scan, suppressed)].sort(bySeverityThenTime);
  const raised = await raiseAll(input, due);

  const count = (status: AlertDeliveryStatus): number =>
    raised.filter((r) => r.delivery === status).length;
  const failed = count("failed");
  const deferred = due.length - raised.length;
  const run: ReviewRunRecord = {
    lane,
    rulesVersion: SECURITY_REVIEW_RULES_VERSION,
    status: failed > 0 || deferred > 0 ? "delivery_failed" : "ok",
    windowFrom: range.from.toISOString(),
    windowTo: scan.windowTo.toISOString(),
    catchUpCapped: range.catchUpCapped,
    scanTruncated: scan.forwardTruncated,
    eventsScanned: scan.eventsScanned,
    findings: scan.findings.length,
    newAlerts: raised.length,
    delivered: count("delivered"),
    failed,
    noDestination: count("no_destination"),
    deferred,
    suppressed,
    overlapTruncated: scan.overlapTruncated,
    bulkTruncated: scan.bulkTruncated,
  };
  await recordReviewCompleted(tx, scope, input.correlationId, run);
  return { skipped: false, run, raised };
}
