import { describe, expect, it } from "vitest";
import {
  SCHEDULE_MAX_DAYS,
  SCHEDULE_MIN_LEAD_MINUTES,
  blockedReasonText,
  defaultScheduleValue,
  fromLocalInputValue,
  scheduleBounds,
  scheduleErrorText,
  toLocalInputValue,
} from "./scheduled-send-utils";

describe("local datetime input helpers", () => {
  it("round-trips a local wall-clock time through the input format", () => {
    const date = new Date(2026, 9, 12, 14, 5); // local 2026-10-12 14:05
    expect(toLocalInputValue(date)).toBe("2026-10-12T14:05");
    expect(fromLocalInputValue("2026-10-12T14:05")?.getTime()).toBe(date.getTime());
  });
  it("accepts HH:mm:ss values (M6)", () => {
    expect(fromLocalInputValue("2026-10-12T14:05:30")?.getSeconds()).toBe(30);
  });
  it("rejects an empty or malformed input", () => {
    expect(fromLocalInputValue("")).toBeNull();
    expect(fromLocalInputValue("tomorrow")).toBeNull();
  });
});

describe("scheduleBounds", () => {
  it("starts a safe margin past the 1-minute server minimum and ends at 30 days", () => {
    const now = new Date(2026, 9, 12, 14, 0, 30);
    const { min, max } = scheduleBounds(now);
    expect(min.getTime() - now.getTime()).toBeGreaterThanOrEqual(
      SCHEDULE_MIN_LEAD_MINUTES * 60_000,
    );
    expect(SCHEDULE_MIN_LEAD_MINUTES).toBeGreaterThan(1);
    expect(max.getTime() - now.getTime()).toBeLessThanOrEqual(SCHEDULE_MAX_DAYS * 86_400_000);
  });
  it("suggests a default inside the bounds", () => {
    const now = new Date(2026, 9, 12, 14, 0, 30);
    const { min, max } = scheduleBounds(now);
    const suggested = fromLocalInputValue(defaultScheduleValue(now));
    expect(suggested && suggested >= min && suggested <= max).toBe(true);
  });
});

describe("messages", () => {
  it("explains each server refusal in plain words", () => {
    expect(scheduleErrorText("SCHEDULE_TOO_SOON")).toMatch(/at least/i);
    expect(scheduleErrorText("SCHEDULE_TOO_FAR")).toMatch(/30 days/);
    expect(scheduleErrorText("SCHEDULE_LIMIT_REACHED")).toMatch(/50/);
    expect(scheduleErrorText("CHANNEL_ARCHIVED")).toMatch(/closed|archived/i);
    expect(scheduleErrorText("SOMETHING_ELSE")).toBeNull();
  });
  it("says why a message was not sent without naming a channel or patient", () => {
    for (const reason of [
      "channel_archived",
      "not_member",
      "permission_revoked",
      "announcement_not_permitted",
      "parent_unavailable",
      "dispatch_failed",
    ] as const) {
      expect(blockedReasonText(reason).length).toBeGreaterThan(10);
    }
  });
  it("gives an unrecognised or missing reason a generic note that never echoes the code", () => {
    for (const reason of ["RAW_UNKNOWN_REASON_CODE", "", null, undefined]) {
      expect(blockedReasonText(reason)).toBe(
        "This message could not be sent. Reschedule it to try again.",
      );
    }
  });
});
