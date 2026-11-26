// CW-MON-01 — `runSecurityReview`: the cursor, the retry, the caps and the lane split, with the reader and the recorder
// replaced by spies so each branch is deterministic (the real SQL and RLS are proven in m4-security-review.live.test.ts).
// Identifiers are synthetic.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ALERTS_PER_RUN,
  MAX_CATCH_UP_MS,
  MAX_OVERLAP_ROWS,
  MAX_SIGNAL_ROWS,
  type ReviewEvent,
  SECURITY_RULES,
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
  readRaisedFingerprints: vi.fn(),
}));
vi.mock("../src/review/record", () => ({
  recordAlertRaised: vi.fn(async () => undefined),
  recordReviewCompleted: vi.fn(async () => undefined),
}));

const NOW = new Date("2026-11-26T12:00:00.000Z");
const ORG = "00000000-0000-4000-8000-0000000000a1";
const HOUR = 60 * 60_000;
const tx = {} as never;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

const signal = vi.mocked(reader.readSignalEvents);
const bulk = vi.mocked(reader.readBulkAccessHits);
const cursor = vi.mocked(reader.readReviewCursor);
const fingerprints = vi.mocked(reader.readRaisedFingerprints);
const recordedAlert = vi.mocked(record.recordAlertRaised);
const recordedRun = vi.mocked(record.recordReviewCompleted);

const delivered: SecurityAlertSink = async () => "delivered";
const review = (sink: SecurityAlertSink = delivered, organizationId: string | null = ORG) =>
  runSecurityReview({
    tx,
    scope: { organizationId },
    rules: SECURITY_RULES,
    sink,
    now: NOW,
    correlationId: "corr-test",
  });

beforeEach(() => {
  vi.clearAllMocks();
  signal.mockResolvedValue({ events: [], truncated: false });
  bulk.mockResolvedValue([]);
  cursor.mockResolvedValue(null);
  fingerprints.mockResolvedValue(new Set());
});

describe("the range a run reviews", () => {
  it("starts a first run one day back and writes an ok record ending now", async () => {
    const { run } = await review();
    expect(run).toMatchObject({
      status: "ok",
      lane: "org",
      windowFrom: new Date(NOW.getTime() - MAX_CATCH_UP_MS).toISOString(),
      windowTo: NOW.toISOString(),
      catchUpCapped: false,
      scanTruncated: false,
      findings: 0,
      newAlerts: 0,
    });
    expect(recordedRun).toHaveBeenCalledTimes(1);
  });

  it("resumes from the cursor of the last clean review, reading an hour of overlap before it", async () => {
    const from = new Date(NOW.getTime() - 2 * HOUR);
    cursor.mockResolvedValue(from);
    const { run } = await review();
    expect(run.windowFrom).toBe(from.toISOString());
    const [forward, overlap] = signal.mock.calls;
    expect(forward?.[2]).toMatchObject({ from, to: NOW, limit: MAX_SIGNAL_ROWS });
    expect(overlap?.[2]).toMatchObject({ from: new Date(from.getTime() - HOUR), to: from, limit: MAX_OVERLAP_ROWS });
  });

  it("records, rather than hides, a gap longer than the catch-up cap", async () => {
    cursor.mockResolvedValue(new Date(NOW.getTime() - 3 * MAX_CATCH_UP_MS));
    const { run } = await review();
    expect(run.catchUpCapped).toBe(true);
    expect(run.windowFrom).toBe(new Date(NOW.getTime() - MAX_CATCH_UP_MS).toISOString());
  });

  it("stops the review at the last row read when the read was cut short, so the next run continues from there", async () => {
    const lastRow = breakGlass(2, "2026-11-26T11:10:00.000Z");
    signal.mockResolvedValueOnce({ events: [breakGlass(1, "2026-11-26T11:00:00.000Z"), lastRow], truncated: true });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    const { run } = await review();
    expect(run.scanTruncated).toBe(true);
    expect(run.windowTo).toBe(lastRow.createdAt);
    expect(bulk.mock.calls[0]?.[2]).toMatchObject({ to: new Date(lastRow.createdAt) });
  });

  it("still moves the cursor when the cap is filled by rows stamped in one millisecond (one transaction, one created_at)", async () => {
    const from = new Date("2026-11-26T11:00:00.000Z");
    cursor.mockResolvedValue(from);
    signal.mockResolvedValueOnce({ events: [breakGlass(1, from.toISOString())], truncated: true });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    const { run } = await review();
    expect(run.scanTruncated).toBe(true);
    expect(run.windowTo).toBe(new Date(from.getTime() + 1).toISOString()); // never re-reads the same rows forever
  });
});

describe("raising alerts", () => {
  it("delivers each new finding once and records the alert with its delivery", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1), breakGlass(2)], truncated: false });
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const { run, raised } = await review(sink);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(raised.map((r) => r.delivery)).toEqual(["delivered", "delivered"]);
    expect(recordedAlert).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ status: "ok", findings: 2, newAlerts: 2, delivered: 2, failed: 0 });
  });

  it("does not raise a finding whose fingerprint was already delivered", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    const first = await review();
    const fingerprint = first.raised[0]?.alert.fingerprint as string;
    vi.clearAllMocks();
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    signal.mockResolvedValueOnce({ events: [], truncated: false });
    bulk.mockResolvedValue([]);
    cursor.mockResolvedValue(null);
    fingerprints.mockResolvedValue(new Set([fingerprint]));
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const second = await review(sink);
    expect(sink).not.toHaveBeenCalled();
    expect(second.run).toMatchObject({ status: "ok", findings: 1, newAlerts: 0 });
  });

  it("records a failed delivery, stops at it, and holds the cursor (delivery_failed) so the next run raises the rest", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1), breakGlass(2)], truncated: false });
    const sink = vi.fn<SecurityAlertSink>(async () => "failed");
    const { run, raised } = await review(sink);
    // the destination is down: one attempt, not a timeout per alert behind it
    expect(sink).toHaveBeenCalledTimes(1);
    expect(raised.map((r) => r.delivery)).toEqual(["failed"]);
    expect(run).toMatchObject({ status: "delivery_failed", failed: 1, delivered: 0, newAlerts: 1, deferred: 1 });
    expect(recordedRun.mock.calls[0]?.[3]).toMatchObject({ status: "delivery_failed" });
  });

  it("delivers the most severe alert first, one at a time", async () => {
    const warn: ReviewEvent = { ...breakGlass(1, "2026-11-26T11:00:00.000Z"), eventType: "m2.auth.2fa_disabled" };
    const critical = breakGlass(2, "2026-11-26T11:20:00.000Z");
    signal.mockResolvedValueOnce({ events: [warn, critical], truncated: false });
    const order: string[] = [];
    const sink: SecurityAlertSink = async (alert) => {
      order.push(`${alert.severity}:${alert.ruleId}`);
      return "delivered";
    };
    await review(sink);
    expect(order).toEqual(["critical:access.break_glass_invoked", "warn:access.second_factor_disabled"]);
  });

  it("counts a sink that throws as a failed delivery", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    const { run } = await review(async () => {
      throw new Error("sink exploded");
    });
    expect(run).toMatchObject({ status: "delivery_failed", failed: 1 });
  });

  it("treats no configured destination as a terminal, visible outcome (status ok, counted separately)", async () => {
    signal.mockResolvedValueOnce({ events: [breakGlass(1)], truncated: false });
    const { run, raised } = await review(async () => "no_destination");
    expect(raised[0]?.delivery).toBe("no_destination");
    expect(run).toMatchObject({ status: "ok", noDestination: 1, delivered: 0 });
  });

  it("raises at most MAX_ALERTS_PER_RUN and defers the rest, holding the cursor", async () => {
    const events = Array.from({ length: MAX_ALERTS_PER_RUN + 7 }, (_, i) => breakGlass(i + 1));
    signal.mockResolvedValueOnce({ events, truncated: false });
    const sink = vi.fn<SecurityAlertSink>(async () => "delivered");
    const { run } = await review(sink);
    expect(sink).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN);
    expect(run).toMatchObject({ status: "delivery_failed", newAlerts: MAX_ALERTS_PER_RUN, deferred: 7 });
  });
});

describe("the lanes", () => {
  it("reviews only org-less authentication rules in the platform lane, and never reads bulk access there", async () => {
    await review(delivered, null);
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
    await review();
    const eventTypes = signal.mock.calls.flatMap((c) => c[2].eventTypes);
    expect(eventTypes).toContain("m3.breakglass.invoked");
    expect(eventTypes).not.toContain("m2.auth.login_failed");
    expect(bulk.mock.calls[0]?.[2]).toMatchObject({ from: new Date("2026-11-26T10:00:00.000Z"), bucketMs: 15 * 60_000 });
  });
});
