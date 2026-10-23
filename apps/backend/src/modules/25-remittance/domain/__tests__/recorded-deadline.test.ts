// M25 milestone 7a-1 - the recorded deadline: a due date typed from a notice, with a mandatory source note. Pure;
// every date is a fixed fixture. No CMS window is encoded here: the date always comes from the user.
import { describe, expect, it } from "vitest";
import {
  DUE_SOON_DAYS,
  checkRecordedDeadline,
  deriveRecordedDeadline,
  recordedDeadlineStatus,
  selectWatchDue,
} from "../recorded-deadline";

const NOW = new Date("2026-03-01T15:00:00.000Z");

describe("deriveRecordedDeadline", () => {
  it("ends the typed day in the provider zone", () => {
    const d = deriveRecordedDeadline("2026-03-10", ["America/New_York"]);
    expect(d.dueAt.toISOString()).toBe("2026-03-11T03:59:59.999Z");
    expect(d.zone).toBe("America/New_York");
  });

  it("uses the earliest-ending zone when locations disagree", () => {
    const d = deriveRecordedDeadline("2026-03-10", ["America/Los_Angeles", "America/New_York"]);
    expect(d.zone).toBe("America/New_York");
  });

  it("falls back to the default zone when none is known", () => {
    expect(deriveRecordedDeadline("2026-03-10", []).zone).toBe("America/New_York");
  });

  it("does not roll a weekend back: the user typed the date as printed on the notice", () => {
    // 2026-03-14 is a Saturday; DST began 2026-03-08 so New York is UTC-4.
    const d = deriveRecordedDeadline("2026-03-14", ["America/New_York"]);
    expect(d.dueAt.toISOString()).toBe("2026-03-15T03:59:59.999Z");
  });

  it("rejects a date that is not a real calendar day", () => {
    expect(() => deriveRecordedDeadline("2026-02-30", [])).toThrow(RangeError);
  });
});

describe("checkRecordedDeadline", () => {
  const ok = { label: "Hearing notice response", dueOn: "2026-03-10", sourceNote: "Notice p.2" };
  it("accepts a labelled date with a source note", () => {
    expect(checkRecordedDeadline(ok)).toBeNull();
  });
  it("requires a label", () => {
    expect(checkRecordedDeadline({ ...ok, label: "  " })).toBe("LABEL_REQUIRED");
  });
  it("requires a real date", () => {
    expect(checkRecordedDeadline({ ...ok, dueOn: "03/10/2026" })).toBe("DUE_DATE_INVALID");
    expect(checkRecordedDeadline({ ...ok, dueOn: "2026-02-30" })).toBe("DUE_DATE_INVALID");
  });
  it("requires a non-blank source note: a date nobody can trace is not recorded", () => {
    expect(checkRecordedDeadline({ ...ok, sourceNote: "   " })).toBe("SOURCE_NOTE_REQUIRED");
  });
});

describe("recordedDeadlineStatus", () => {
  const base = { dueOn: "2026-03-20", zone: "America/New_York", satisfiedOn: null };
  it("is open when far off", () => {
    expect(recordedDeadlineStatus(base, NOW)).toBe("open");
  });
  it(`is due_soon within ${DUE_SOON_DAYS} days`, () => {
    expect(recordedDeadlineStatus({ ...base, dueOn: "2026-03-05" }, NOW)).toBe("due_soon");
  });
  it("is past once the day has ended, and still due on the day itself", () => {
    expect(recordedDeadlineStatus({ ...base, dueOn: "2026-03-01" }, NOW)).toBe("due_soon");
    expect(recordedDeadlineStatus({ ...base, dueOn: "2026-02-28" }, NOW)).toBe("past");
  });
  it("is satisfied once marked, whatever the date", () => {
    expect(
      recordedDeadlineStatus({ ...base, dueOn: "2026-02-01", satisfiedOn: "2026-02-01" }, NOW),
    ).toBe("satisfied");
  });
});

describe("selectWatchDue", () => {
  const row = (over: Partial<Parameters<typeof selectWatchDue>[0][number]> = {}) => ({
    id: "d1",
    dueOn: "2026-03-20",
    zone: "America/New_York",
    satisfiedOn: null,
    lastAlertedBoundary: null,
    ...over,
  });

  it("alerts at the tightest boundary the remaining days fall in", () => {
    expect(selectWatchDue([row({ dueOn: "2026-03-07" })], NOW)).toEqual([
      { id: "d1", boundary: 7 },
    ]);
  });
  it("does not alert beyond 30 days", () => {
    expect(selectWatchDue([row({ dueOn: "2026-06-01" })], NOW)).toEqual([]);
  });
  it("never alerts for a past date", () => {
    expect(selectWatchDue([row({ dueOn: "2026-02-20" })], NOW)).toEqual([]);
  });
  it("never alerts for a satisfied deadline", () => {
    expect(selectWatchDue([row({ dueOn: "2026-03-07", satisfiedOn: "2026-03-02" })], NOW)).toEqual(
      [],
    );
  });
  it("alerts once per boundary: the same or a wider boundary is skipped, a tighter one fires", () => {
    const due = "2026-03-07";
    expect(selectWatchDue([row({ dueOn: due, lastAlertedBoundary: 7 })], NOW)).toEqual([]);
    expect(selectWatchDue([row({ dueOn: due, lastAlertedBoundary: 14 })], NOW)).toEqual([
      { id: "d1", boundary: 7 },
    ]);
    expect(selectWatchDue([row({ dueOn: due, lastAlertedBoundary: 1 })], NOW)).toEqual([]);
  });
});
