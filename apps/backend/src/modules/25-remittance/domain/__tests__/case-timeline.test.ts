// M25 milestone 7a-1 - the one-case-view timeline: a pure merge of heterogeneous items, sorted stably, with the
// next open deadline picked across kinds.
import { describe, expect, it } from "vitest";
import { type TimelineItem, nextDeadline, sortTimeline } from "../case-timeline";

const item = (
  over: Partial<TimelineItem> & Pick<TimelineItem, "id" | "kind" | "at">,
): TimelineItem => ({
  label: over.id,
  state: "open",
  tier: null,
  deadlineAt: null,
  deadlineSource: null,
  windowConfirmed: true,
  ...over,
});

describe("sortTimeline", () => {
  it("orders by time, then kind order, then id, and does not mutate its input", () => {
    const input = [
      item({ id: "b", kind: "audit_request", at: "2026-01-02T00:00:00Z" }),
      item({ id: "c", kind: "appeal", at: "2026-01-02T00:00:00Z" }),
      item({ id: "a", kind: "adr", at: "2026-01-01T00:00:00Z" }),
      item({ id: "d", kind: "appeal", at: "2026-01-02T00:00:00Z" }),
    ];
    const copy = [...input];
    expect(sortTimeline(input).map((i) => i.id)).toEqual(["a", "c", "d", "b"]);
    expect(input).toEqual(copy);
  });
});

describe("nextDeadline", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  it("is null when nothing carries a future deadline", () => {
    expect(
      nextDeadline([item({ id: "a", kind: "adr", at: "2026-01-01T00:00:00Z" })], now),
    ).toBeNull();
  });
  it("picks the earliest deadline that has not passed, across kinds", () => {
    const items = [
      item({
        id: "past",
        kind: "adr",
        at: "2026-01-01T00:00:00Z",
        deadlineAt: "2026-02-01T00:00:00Z",
        deadlineSource: "computed",
      }),
      item({
        id: "later",
        kind: "appeal",
        at: "2026-01-01T00:00:00Z",
        deadlineAt: "2026-04-01T00:00:00Z",
        deadlineSource: "computed",
      }),
      item({
        id: "soon",
        kind: "recorded_deadline",
        at: "2026-01-01T00:00:00Z",
        deadlineAt: "2026-03-05T00:00:00Z",
        deadlineSource: "recorded",
      }),
    ];
    expect(nextDeadline(items, now)?.id).toBe("soon");
  });
  it("breaks a tie by kind order", () => {
    const at = "2026-03-05T00:00:00Z";
    const items = [
      item({
        id: "r",
        kind: "recorded_deadline",
        at: "2026-01-01T00:00:00Z",
        deadlineAt: at,
        deadlineSource: "recorded",
      }),
      item({
        id: "a",
        kind: "appeal",
        at: "2026-01-01T00:00:00Z",
        deadlineAt: at,
        deadlineSource: "computed",
      }),
    ];
    expect(nextDeadline(items, now)?.id).toBe("a");
  });
  it("keeps an unconfirmed-window deadline in play, flagged rather than hidden", () => {
    const items = [
      item({
        id: "alj",
        kind: "appeal",
        tier: "alj",
        at: "2026-01-01T00:00:00Z",
        deadlineAt: "2026-03-05T00:00:00Z",
        deadlineSource: "computed",
        windowConfirmed: false,
      }),
    ];
    const next = nextDeadline(items, now);
    expect(next?.id).toBe("alj");
    expect(next?.windowConfirmed).toBe(false);
  });
});
