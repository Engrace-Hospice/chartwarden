// CW-MON-01 — `runSecurityReview`: the lock, the cursor, the retry, the cooldown, the caps and the lane split, with the reader and the
// recorder replaced by spies so each branch is deterministic (the real SQL and RLS are proven in m4-security-review.live.test.ts).
// Identifiers are synthetic.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  MAX_ALERTS_PER_RULE_PER_RUN,
  MAX_CATCH_UP_MS,
  MAX_OVERLAP_ROWS,
  MAX_SIGNAL_ROWS,
  type RaisedAlertRef,
  type ReviewEvent,
  SECURITY_RULES,
  type SecurityAlert,
  type SecurityAlertSink,
  runSecurityReview,
} from "../src/review";
import * as reader from "../src/review/reader";
import * as record from "../src/review/record";

vi.mock("../src/review/reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/review/reader")>()),
  readSignalEvents: vi.fn(),
  readBulkAccessHits: vi.fn(),
  readReviewCursor: vi.fn(),
  readRaisedAlerts: vi.fn(),
  tryAcquireReviewLock: vi.fn(),
}));
vi.mock("../src/review/record", () => ({
  recordAlertRaised: vi.fn(async () => undefined),
  recordReviewCompleted: vi.fn(async () => undefined),
}));

const NOW = new Date("2026-11-26T12:00:00.000Z");
const ORG = "00000000-0000-4000-8000-0000000000a1";
const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const tx = {} as never;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (offsetMs: number): string => new Date(NOW.getTime() - HOUR + offsetMs).toISOString();

/** A break-glass event: an `always` rule, so every such event is its own finding. */
const breakGlass = (n: number, createdAt = "2026-11-26T11:30:00.000Z"): ReviewEvent => ({
  id: uuid(n),
  createdAt,
  eventType: "m3.breakglass.invoked",
  actorUserId: uuid(1000 + n),
  contextUserId: null,
  ipPrefix: null,
  accountHash: null,
});

/** `count` failed sign-ins from one network starting `startMs` into the hour before NOW, a second apart. */
const failures = (count: number, startMs: number, ipPrefix = "192.0.2.0/24"): ReviewEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    id: uuid(5000 + startMs / 1000 + i),
    createdAt: at(startMs + i * 1000),
    eventType: "m2.auth.login_failed",
    actorUserId: null,
    contextUserId: null,
    ipPrefix,
    accountHash: null,
  }));

const signal = vi.mocked(reader.readSignalEvents);
const bulk = vi.mocked(reader.readBulkAccessHits);
const cursor = vi.mocked(reader.readReviewCursor);
const raisedBefore = vi.mocked(reader.readRaisedAlerts);
const lock = vi.mocked(reader.tryAcquireReviewLock);
const recordedAlert = vi.mocked(record.recordAlertRaised);
const recordedRun = vi.mocked(record.recordReviewCompleted);

const delivered: SecurityAlertSink = async () => "delivered";
const review = (
  sink: SecurityAlertSink = delivered,
  organizationId: string | null = ORG,
  extra: { deliveryBudgetMs?: number; now?: Date } = {},
) =>
  runSecurityReview({
    tx,
    scope: { organizationId },
    rules: SECURITY_RULES,
    sink,
    now: NOW,
    correlationId: "corr-test",
    ...extra,
  });
/** The run of a review that was not skipped. */
const ran = async (...args: Parameters<typeof review>) => {
  const result = await review(...args);
  if (result.skipped) throw new Error("expected the review to run");
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  signal.mockResolvedValue({ events: [], truncated: false });
  bulk.mockResolvedValue({ hits: [], truncated: false });
  cursor.mockResolvedValue(null);
  raisedBefore.mockResolvedValue([]);
  lock.mockResolvedValue(true);
});

describe("one run per scope at a time", () => {
  it("skips, reading and writing nothing, when another run of the scope holds the lock", async () => {
    lock.mockResolvedValue(false);
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const result = await review(sink);
    expect(result).toEqual({ skipped: true, run: null, raised: [] });
    expect(cursor).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(recordedAlert).not.toHaveBeenCalled();
    expect(recordedRun).not.toHaveBeenCalled();
  });

  it("asks for the lock of its own scope before anything else", async () => {
    await review(delivered, ORG);
    await review(delivered, null);
    expect(lock.mock.calls.map((c) => c[1])).toEqual([
      { organizationId: ORG },
      { organizationId: null },
    ]);
  });
});

describe("the range a run reviews", () => {
  it("starts a first run one day back and writes an ok record ending now", async () => {
    const { run } = await ran();
    expect(run).toMatchObject({
      status: "ok",
      lane: "org",
      windowFrom: new Date(NOW.getTime() - MAX_CATCH_UP_MS).toISOString(),
      windowTo: NOW.toISOString(),
      catchUpCapped: false,
      scanTruncated: false,
      findings: 0,
      newAlerts: 0,
      suppressed: 0,
      overlapTruncated: false,
      bulkTruncated: false,
    });
    expect(recordedRun).toHaveBeenCalledTimes(1);
  });

  it("resumes from the cursor of the last clean review, reading an hour of overlap before it", async () => {
    const from = new Date(NOW.getTime() - 2 * HOUR);
    cursor.mockResolvedValue(from);
    const { run } = await ran();
    expect(run.windowFrom).toBe(from.toISOString());
    const [forward, overlap] = signal.mock.calls;
    expect(forward?.[2]).toMatchObject({ from, to: NOW, limit: MAX_SIGNAL_ROWS });
    expect(overlap?.[2]).toMatchObject({
      from: new Date(from.getTime() - HOUR),
      to: from,
      limit: MAX_OVERLAP_ROWS,
    });
  });

  it("records a gap longer than the catch-up cap AND raises an incomplete-scan alert for it", async () => {
    cursor.mockResolvedValue(new Date(NOW.getTime() - 3 * MAX_CATCH_UP_MS));
    const { run, raised } = await ran();
    expect(run.catchUpCapped).toBe(true);
    expect(run.windowFrom).toBe(new Date(NOW.getTime() - MAX_CATCH_UP_MS).toISOString());
    expect(raised.map((r) => r.alert)).toEqual([
      expect.objectContaining({
        ruleId: "review.incomplete_scan",
        severity: "warn",
        subject: { kind: "event", ref: "catch_up_capped" },
      }),
    ]);
  });

  it("never starts from a cursor that is ahead of the clock, whatever the stored row claims", async () => {
    cursor.mockResolvedValue(new Date(NOW.getTime() + 7 * 24 * HOUR)); // a forged 'reviewed up to next week'
    const { run } = await ran();
    expect(run.windowFrom).toBe(NOW.toISOString());
    expect(run.windowTo).toBe(NOW.toISOString());
  });

  it("reads the look-back newest-first, so a cap drops the oldest rows and keeps the ones a straddling burst needs", async () => {
    cursor.mockResolvedValue(new Date(NOW.getTime() - HOUR));
    await ran();
    const [forward, overlap] = signal.mock.calls;
    expect(forward?.[2].newestFirst).toBeUndefined();
    expect(overlap?.[2].newestFirst).toBe(true);
  });

  it("raises an incomplete-scan alert when the forward read hit its cap: the review is falling behind real time", async () => {
    const lastRow = breakGlass(2, "2026-11-26T11:10:00.000Z");
    signal.mockResolvedValueOnce({
      events: [breakGlass(1, "2026-11-26T11:00:00.000Z"), lastRow],
      truncated: true,
    });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    const { raised } = await ran();
    expect(
      raised.some(
        (r) =>
          r.alert.ruleId === "review.incomplete_scan" && r.alert.subject.ref === "forward_truncated",
      ),
    ).toBe(true);
  });

  it("stops the review at the last row read when the read was cut short, so the next run continues from there", async () => {
    const lastRow = breakGlass(2, "2026-11-26T11:10:00.000Z");
    signal.mockResolvedValueOnce({
      events: [breakGlass(1, "2026-11-26T11:00:00.000Z"), lastRow],
      truncated: true,
    });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    const { run } = await ran();
    expect(run.scanTruncated).toBe(true);
    expect(run.windowTo).toBe(lastRow.createdAt);
    expect(bulk.mock.calls[0]?.[2]).toMatchObject({ to: new Date(lastRow.createdAt) });
  });

  it("still moves the cursor when the cap is filled by rows stamped in one millisecond, and says it stepped", async () => {
    const from = new Date("2026-11-26T11:00:00.000Z");
    cursor.mockResolvedValue(from);
    signal.mockResolvedValueOnce({ events: [breakGlass(1, from.toISOString())], truncated: true });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    const { run, raised } = await ran();
    expect(run.scanTruncated).toBe(true);
    expect(run.windowTo).toBe(new Date(from.getTime() + 1).toISOString()); // never re-reads the same rows forever
    expect(
      raised.some(
        (r) =>
          r.alert.ruleId === "review.incomplete_scan" && r.alert.subject.ref === "cursor_stepped",
      ),
    ).toBe(true);
  });

  it("raises an incomplete-scan alert, not a green record, when the look-back or the bulk aggregate hit their caps", async () => {
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    signal.mockResolvedValueOnce({ events: [], truncated: true }); // the overlap
    cursor.mockResolvedValue(new Date(NOW.getTime() - HOUR));
    bulk.mockResolvedValue({ hits: [], truncated: true });
    const { run, raised } = await ran();
    expect(run).toMatchObject({ overlapTruncated: true, bulkTruncated: true });
    expect(raised[0]?.alert).toMatchObject({
      ruleId: "review.incomplete_scan",
      count: 2,
      subject: { kind: "event", ref: "overlap_truncated,bulk_truncated" },
    });
  });
});

describe("raising alerts", () => {
  it("delivers each new finding once and records the alert with its delivery", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1), breakGlass(2)], truncated: false });
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const { run, raised } = await ran(sink);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(raised.map((r) => r.delivery)).toEqual(["delivered", "delivered"]);
    expect(recordedAlert).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ status: "ok", findings: 2, newAlerts: 2, delivered: 2, failed: 0 });
  });

  it("does not raise a finding whose fingerprint was already delivered", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    const first = await ran();
    const alert = first.raised[0]?.alert as SecurityAlert;
    vi.clearAllMocks();
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    bulk.mockResolvedValue({ hits: [], truncated: false });
    cursor.mockResolvedValue(null);
    lock.mockResolvedValue(true);
    raisedBefore.mockResolvedValue([
      {
        fingerprint: alert.fingerprint,
        ruleId: alert.ruleId,
        subjectKind: alert.subject.kind,
        subjectRef: alert.subject.ref,
        windowToMs: Date.parse(alert.windowTo),
      },
    ]);
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const second = await ran(sink);
    expect(sink).not.toHaveBeenCalled();
    expect(second.run).toMatchObject({ status: "ok", findings: 1, newAlerts: 0 });
  });

  it("records a failed delivery, stops at it, and holds the cursor (delivery_failed) so the next run raises the rest", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1), breakGlass(2)], truncated: false });
    const sink = vi.fn<SecurityAlertSink>(async () => "failed");
    const { run, raised } = await ran(sink);
    // the destination is down: one attempt, not a timeout per alert behind it
    expect(sink).toHaveBeenCalledTimes(1);
    expect(raised.map((r) => r.delivery)).toEqual(["failed"]);
    expect(run).toMatchObject({
      status: "delivery_failed",
      failed: 1,
      delivered: 0,
      newAlerts: 1,
      deferred: 1,
    });
    expect(recordedRun.mock.calls[0]?.[3]).toMatchObject({ status: "delivery_failed" });
  });

  it("stops delivering when the delivery time budget is spent, deferring the rest and holding the cursor", async () => {
    signal.mockResolvedValueOnce({
      events: [breakGlass(1), breakGlass(2), breakGlass(3)],
      truncated: false,
    });
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const { run } = await ran(sink, ORG, { deliveryBudgetMs: 0 });
    expect(sink).toHaveBeenCalledTimes(1); // at least one attempt, then the budget
    expect(run).toMatchObject({ status: "delivery_failed", delivered: 1, failed: 0, deferred: 2 });
  });

  it("delivers the most severe alert first, one at a time", async () => {
    const warn: ReviewEvent = {
      ...breakGlass(1, "2026-11-26T11:00:00.000Z"),
      eventType: "m2.auth.2fa_disabled",
    };
    const critical = breakGlass(2, "2026-11-26T11:20:00.000Z");
    signal.mockResolvedValueOnce({ events: [warn, critical], truncated: false });
    const order: string[] = [];
    const sink: SecurityAlertSink = async (alert) => {
      order.push(`${alert.severity}:${alert.ruleId}`);
      return "delivered";
    };
    await review(sink);
    expect(order).toEqual([
      "critical:access.break_glass_invoked",
      "warn:access.second_factor_disabled",
    ]);
  });

  it("counts a sink that throws as a failed delivery", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    const { run } = await ran(async () => {
      throw new Error("sink exploded");
    });
    expect(run).toMatchObject({ status: "delivery_failed", failed: 1 });
  });

  it("treats no configured destination as a terminal, visible outcome (status ok, counted separately)", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    const { run, raised } = await ran(async () => "no_destination");
    expect(raised[0]?.delivery).toBe("no_destination");
    expect(run).toMatchObject({ status: "ok", noDestination: 1, delivered: 0 });
  });
});

describe("a flood of findings", () => {
  it("raises MAX_ALERTS_PER_RULE_PER_RUN of one rule individually and rolls the rest into ONE alert-flood alert, so the cursor still moves", async () => {
    const events = Array.from({ length: MAX_ALERTS_PER_RULE_PER_RUN + 7 }, (_, i) => breakGlass(i + 1));
    signal.mockResolvedValueOnce({ events, truncated: false });
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const { run, raised } = await ran(sink);
    expect(sink).toHaveBeenCalledTimes(MAX_ALERTS_PER_RULE_PER_RUN + 1);
    const flood = raised.filter((r) => r.alert.ruleId === "review.alert_flood");
    expect(flood).toHaveLength(1);
    expect(flood[0]?.alert).toMatchObject({ count: 7, severity: "critical" });
    expect(run).toMatchObject({
      status: "ok",
      suppressed: 7,
      deferred: 0,
      newAlerts: MAX_ALERTS_PER_RULE_PER_RUN + 1,
    });
  });

  it("does not let one rule's findings crowd out another's: ten decoys of one rule, and a different rule's alert still goes out", async () => {
    const decoys = Array.from({ length: MAX_ALERTS_PER_RULE_PER_RUN * 3 }, (_, i) => breakGlass(i + 1));
    const other: ReviewEvent = { ...breakGlass(900), eventType: "m2.auth.2fa_disabled" };
    signal.mockResolvedValueOnce({ events: [...decoys, other], truncated: false });
    const { raised } = await ran();
    expect(raised.map((r) => r.alert.ruleId)).toContain("access.second_factor_disabled");
  });

  it("holds a flood notice back while an earlier one is inside the cooldown, so it pages about once an hour, not once a run", async () => {
    const events = Array.from({ length: MAX_ALERTS_PER_RULE_PER_RUN + 3 }, (_, i) => breakGlass(i + 1));
    signal.mockResolvedValue({ events, truncated: false });
    const first = await ran();
    const flood = first.raised.find((r) => r.alert.ruleId === "review.alert_flood")?.alert as SecurityAlert;
    raisedBefore.mockResolvedValue([
      {
        fingerprint: flood.fingerprint,
        ruleId: flood.ruleId,
        subjectKind: flood.subject.kind,
        subjectRef: flood.subject.ref,
        windowToMs: Date.parse(flood.windowTo) - 15 * MINUTE,
      },
    ]);
    const second = await ran();
    expect(second.raised.some((r) => r.alert.ruleId === "review.alert_flood")).toBe(false);
    expect(second.run.suppressed).toBeGreaterThan(0); // still counted in the record
  });

  it("gives a notice the same fingerprint when a held cursor makes the next run re-raise it (a receiver can drop the repeat)", async () => {
    cursor.mockResolvedValue(new Date(NOW.getTime() - 2 * HOUR)); // held: the cursor did not move between the two runs
    bulk.mockResolvedValue({ hits: [], truncated: true });
    const first = await ran(async () => "failed");
    const retry = await ran(async () => "delivered", ORG, { now: new Date(NOW.getTime() + 15 * MINUTE) });
    expect(first.raised[0]?.alert.ruleId).toBe("review.incomplete_scan");
    expect(retry.raised[0]?.alert.windowTo).not.toBe(first.raised[0]?.alert.windowTo); // a different run…
    expect(retry.raised[0]?.alert.fingerprint).toBe(first.raised[0]?.alert.fingerprint); // …the same notice
  });
});

describe("the cooldown on a sustained pattern", () => {
  const burstRef = (windowToMs: number): RaisedAlertRef => ({
    fingerprint: "fingerprint-of-an-earlier-window",
    ruleId: "auth.brute_force_by_network",
    subjectKind: "ip_prefix",
    subjectRef: "192.0.2.0/24",
    windowToMs,
  });
  const startOfBurst = (offsetMs: number): number => Date.parse(at(offsetMs));

  it("raises a burst that no earlier alert covers", async () => {
    signal.mockResolvedValueOnce({ events: failures(15, 0), truncated: false });
    const { raised } = await ran(delivered, null);
    expect(raised.map((r) => r.alert.ruleId)).toEqual(["auth.brute_force_by_network"]);
  });

  it("holds a later window of the same pattern back while the earlier alert is within the cooldown", async () => {
    signal.mockResolvedValueOnce({ events: failures(15, 0), truncated: false });
    raisedBefore.mockResolvedValue([burstRef(startOfBurst(0) - 30 * MINUTE)]); // alerted 30 minutes before this burst began
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const { run } = await ran(sink, null);
    expect(sink).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: "ok", findings: 1, newAlerts: 0 });
  });

  it("raises it again once the cooldown has passed", async () => {
    signal.mockResolvedValueOnce({ events: failures(15, 0), truncated: false });
    raisedBefore.mockResolvedValue([burstRef(startOfBurst(0) - ALERT_COOLDOWN_MS - 5 * MINUTE)]);
    const { raised } = await ran(delivered, null);
    expect(raised).toHaveLength(1);
  });

  it("does not hold back the same pattern from another network", async () => {
    signal.mockResolvedValueOnce({ events: failures(15, 0, "198.51.100.0/24"), truncated: false });
    raisedBefore.mockResolvedValue([burstRef(startOfBurst(0) - 5 * MINUTE)]);
    const { raised } = await ran(delivered, null);
    expect(raised).toHaveLength(1);
  });

  it("raises several windows of ONE sustained attack once, counting the earlier windows of the same run", async () => {
    // two bursts 20 minutes apart from one network: two findings, one alert
    signal.mockResolvedValueOnce({
      events: [...failures(15, 0), ...failures(15, 20 * MINUTE)],
      truncated: false,
    });
    const { run, raised } = await ran(delivered, null);
    expect(run.findings).toBe(2);
    expect(raised).toHaveLength(1);
  });

  it("never holds back an `always` finding: each such event is its own alert", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1), breakGlass(2)], truncated: false });
    raisedBefore.mockResolvedValue([
      {
        fingerprint: "an-earlier-break-glass",
        ruleId: "access.break_glass_invoked",
        subjectKind: "event",
        subjectRef: uuid(1),
        windowToMs: NOW.getTime() - MINUTE,
      },
    ]);
    const { raised } = await ran();
    expect(raised).toHaveLength(2);
  });

  it("looks for earlier alerts a full cooldown before the earliest instant it read", async () => {
    const from = new Date(NOW.getTime() - 2 * HOUR);
    cursor.mockResolvedValue(from);
    await ran(delivered, null);
    const since = raisedBefore.mock.calls[0]?.[2] as Date;
    expect(since.getTime()).toBe(from.getTime() - HOUR - ALERT_COOLDOWN_MS);
  });
});

describe("the lanes", () => {
  it("reviews only org-less authentication rules in the platform lane, and never reads bulk access there", async () => {
    await ran(delivered, null);
    const eventTypes = signal.mock.calls.flatMap((c) => c[2].eventTypes);
    expect(eventTypes.length).toBeGreaterThan(0);
    expect(eventTypes.every((t) => t.startsWith("m2.auth."))).toBe(true);
    expect(bulk).not.toHaveBeenCalled();
    expect(recordedRun.mock.calls[0]?.[1]).toEqual({ organizationId: null });
    expect(recordedRun.mock.calls[0]?.[3]).toMatchObject({ lane: "platform" });
  });

  it("reviews the org lane's own rules and reads bulk access from the start of the bucket that holds the cursor", async () => {
    const from = new Date("2026-11-26T10:07:30.000Z");
    cursor.mockResolvedValue(from);
    await ran();
    const eventTypes = signal.mock.calls.flatMap((c) => c[2].eventTypes);
    expect(eventTypes).toContain("m3.breakglass.invoked");
    expect(eventTypes).not.toContain("m2.auth.login_failed");
    expect(bulk.mock.calls[0]?.[2]).toMatchObject({
      from: new Date("2026-11-26T10:00:00.000Z"),
      bucketMs: 15 * 60_000,
    });
  });
});
