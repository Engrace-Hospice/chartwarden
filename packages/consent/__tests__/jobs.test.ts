// M39-T08 — the reminder/expiration job engines (§4.9).
import { describe, expect, it } from "vitest";
import { M39_QUEUES, dueReminders, isDraftStale, mostUrgentReminder, shouldExpire } from "../src/jobs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

describe("reminder cadence (§4.9 / D9)", () => {
  it("opens the windows whose threshold the remaining term has crossed", () => {
    expect(dueReminders({ expiresAtMs: NOW + 100 * DAY, nowMs: NOW })).toEqual([]);
    expect(dueReminders({ expiresAtMs: NOW + 30 * DAY, nowMs: NOW })).toEqual(["90_days", "30_days"]);
    expect(dueReminders({ expiresAtMs: NOW + 0.5 * DAY, nowMs: NOW })).toEqual([
      "90_days",
      "30_days",
      "14_days",
      "7_days",
      "1_day",
    ]);
  });

  it("indefinite consents never remind; expired terms defer to the expiration cron", () => {
    expect(dueReminders({ expiresAtMs: null, nowMs: NOW })).toEqual([]);
    expect(dueReminders({ expiresAtMs: NOW - DAY, nowMs: NOW })).toEqual([]);
  });

  it("the most-urgent window is the smallest open threshold", () => {
    expect(mostUrgentReminder({ expiresAtMs: NOW + 10 * DAY, nowMs: NOW })).toBe("14_days");
    expect(mostUrgentReminder({ expiresAtMs: NOW + 100 * DAY, nowMs: NOW })).toBeNull();
  });
});

describe("expiration + draft housekeeping (§4.9)", () => {
  it("only an active consent past expires_at flips to expired", () => {
    expect(shouldExpire({ status: "active", expiresAtMs: NOW - 1, nowMs: NOW })).toBe(true);
    expect(shouldExpire({ status: "active", expiresAtMs: NOW + 1, nowMs: NOW })).toBe(false);
    expect(shouldExpire({ status: "revoked", expiresAtMs: NOW - 1, nowMs: NOW })).toBe(false);
    expect(shouldExpire({ status: "active", expiresAtMs: null, nowMs: NOW })).toBe(false);
  });

  it("drafts older than 30 days are stale (housekeeping, not retention)", () => {
    expect(isDraftStale({ status: "draft", createdAtMs: NOW - 31 * DAY, nowMs: NOW })).toBe(true);
    expect(isDraftStale({ status: "draft", createdAtMs: NOW - 10 * DAY, nowMs: NOW })).toBe(false);
    expect(isDraftStale({ status: "active", createdAtMs: NOW - 100 * DAY, nowMs: NOW })).toBe(false);
  });

  it("ships the eight §4.9 queue names", () => {
    expect(Object.keys(M39_QUEUES)).toHaveLength(8);
    expect(M39_QUEUES.expirationReminder).toBe("m39.expiration_reminder");
  });
});
