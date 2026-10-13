/** WP 2.6 - the pure scheduling rules shared by the route service and the dispatcher. */
import { describe, expect, it } from "vitest";
import {
  MAX_SCHEDULE_HORIZON_MS,
  MIN_SCHEDULE_LEAD_MS,
  assertScheduleTime,
  normalizeScheduleTimeZone,
  scheduleBlockReasonFor,
  scheduleBlockedMessage,
} from "../src/scheduled-send";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("assertScheduleTime", () => {
  it("accepts a time at least the minimum lead away and inside the horizon", () => {
    expect(assertScheduleTime(at(MIN_SCHEDULE_LEAD_MS), NOW).toISOString()).toBe(
      at(MIN_SCHEDULE_LEAD_MS),
    );
    expect(() => assertScheduleTime(at(MAX_SCHEDULE_HORIZON_MS), NOW)).not.toThrow();
  });
  it("rejects a time sooner than one minute with SCHEDULE_TOO_SOON (422)", () => {
    expect(() => assertScheduleTime(at(MIN_SCHEDULE_LEAD_MS - 1), NOW)).toThrowError(
      expect.objectContaining({ code: "SCHEDULE_TOO_SOON", statusCode: 422 }),
    );
  });
  it("rejects a time beyond 30 days with SCHEDULE_TOO_FAR (422)", () => {
    expect(() => assertScheduleTime(at(MAX_SCHEDULE_HORIZON_MS + 1), NOW)).toThrowError(
      expect.objectContaining({ code: "SCHEDULE_TOO_FAR" }),
    );
  });
  it("rejects an unparseable time", () => {
    expect(() => assertScheduleTime("not a date", NOW)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

describe("normalizeScheduleTimeZone", () => {
  it("keeps a valid IANA zone, defaults to UTC, rejects junk", () => {
    expect(normalizeScheduleTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(normalizeScheduleTimeZone(undefined)).toBe("UTC");
    expect(() => normalizeScheduleTimeZone("Mars/Olympus")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

describe("block reasons", () => {
  it("maps each failed re-check to its own code, none when all hold", () => {
    expect(scheduleBlockReasonFor({ archived: true })).toBe("channel_archived");
    expect(scheduleBlockReasonFor({ member: false })).toBe("not_member");
    expect(scheduleBlockReasonFor({ permission: false })).toBe("permission_revoked");
    expect(scheduleBlockReasonFor({ announce: false })).toBe("announcement_not_permitted");
    expect(scheduleBlockReasonFor({})).toBeNull();
  });
  it("gives every reason generic text", () => {
    for (const reason of [
      "channel_archived",
      "not_member",
      "permission_revoked",
      "announcement_not_permitted",
      "dispatch_failed",
    ] as const) {
      expect(scheduleBlockedMessage(reason)).toMatch(/scheduled message/i);
    }
  });
});
