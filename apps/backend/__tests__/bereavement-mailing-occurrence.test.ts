// apps/backend/__tests__/bereavement-mailing-occurrence.test.ts — ADR-0109 D10: `nextOccurrences`, the date math behind the 5-minute sweep.
import { describe, expect, it } from "vitest";
import {
  type MailingOccurrenceConfig,
  activityKindOfRun,
  nextOccurrences,
  nthSundayOfMonth,
  runKindOf,
} from "../src/modules/16-bereavement/mailings/occurrence";

const cfg = (over: Partial<MailingOccurrenceConfig> & Pick<MailingOccurrenceConfig, "mailingKey">): MailingOccurrenceConfig => ({
  enabled: true,
  leadDays: 10,
  ...over,
});

describe("nthSundayOfMonth", () => {
  it("Mother's Day is the 2nd Sunday of May", () => {
    expect(nthSundayOfMonth(2026, 5, 2)).toBe("2026-05-10");
    expect(nthSundayOfMonth(2027, 5, 2)).toBe("2027-05-09");
    expect(nthSundayOfMonth(2028, 5, 2)).toBe("2028-05-14");
    // May 1 2022 was a Sunday: the 2nd is the 8th, not the 15th
    expect(nthSundayOfMonth(2022, 5, 2)).toBe("2022-05-08");
  });

  it("Father's Day is the 3rd Sunday of June", () => {
    expect(nthSundayOfMonth(2026, 6, 3)).toBe("2026-06-21");
    expect(nthSundayOfMonth(2027, 6, 3)).toBe("2027-06-20");
    // June 1 2025 was a Sunday: the 3rd is the 15th
    expect(nthSundayOfMonth(2025, 6, 3)).toBe("2025-06-15");
  });
});

describe("nextOccurrences", () => {
  it("drafts nothing for a disabled config and nothing outside the lead window", () => {
    expect(nextOccurrences([cfg({ mailingKey: "mothers_day", enabled: false })], "2026-05-05")).toEqual([]);
    // Mother's Day 2026-05-10, 10 lead days: the window opens 2026-04-30
    expect(nextOccurrences([cfg({ mailingKey: "mothers_day" })], "2026-04-29")).toEqual([]);
  });

  it("opens the window exactly `leadDays` before and closes it on the day", () => {
    const first = nextOccurrences([cfg({ mailingKey: "mothers_day" })], "2026-04-30");
    expect(first).toEqual([
      { mailingKey: "mothers_day", occurrenceKey: "mothers_day:2026", scheduledFor: "2026-05-10", draftFrom: "2026-04-30" },
    ]);
    expect(nextOccurrences([cfg({ mailingKey: "mothers_day" })], "2026-05-10")).toHaveLength(1);
    // the day after the holiday it is never drafted late
    expect(nextOccurrences([cfg({ mailingKey: "mothers_day" })], "2026-05-11")).toEqual([]);
  });

  it("subtracts a tenant's lead days (3..60)", () => {
    expect(nextOccurrences([cfg({ mailingKey: "fathers_day", leadDays: 3 })], "2026-06-17")).toHaveLength(0);
    expect(nextOccurrences([cfg({ mailingKey: "fathers_day", leadDays: 3 })], "2026-06-18")).toHaveLength(1);
    expect(nextOccurrences([cfg({ mailingKey: "fathers_day", leadDays: 60 })], "2026-04-22")).toHaveLength(1);
    expect(nextOccurrences([cfg({ mailingKey: "fathers_day", leadDays: 60 })], "2026-04-21")).toHaveLength(0);
  });

  it("the quarterly newsletter has four dates a year with positional quarter keys", () => {
    const c = [cfg({ mailingKey: "newsletter_quarterly" })];
    expect(nextOccurrences(c, "2026-10-10")[0]).toMatchObject({ occurrenceKey: "newsletter_quarterly:2026-Q4", scheduledFor: "2026-10-15" });
    expect(nextOccurrences(c, "2026-04-06")[0]).toMatchObject({ occurrenceKey: "newsletter_quarterly:2026-Q2", scheduledFor: "2026-04-15" });
    expect(nextOccurrences(c, "2026-03-01")).toEqual([]);
  });

  it("looks across the year boundary: a January newsletter drafts in late December", () => {
    const c = [cfg({ mailingKey: "newsletter_quarterly", leadDays: 30 })];
    expect(nextOccurrences(c, "2026-12-20")).toEqual([
      { mailingKey: "newsletter_quarterly", occurrenceKey: "newsletter_quarterly:2027-Q1", scheduledFor: "2027-01-15", draftFrom: "2026-12-16" },
    ]);
  });

  it("the December holiday defaults to 12-15 and a tenant can move it", () => {
    expect(nextOccurrences([cfg({ mailingKey: "holiday_december" })], "2026-12-05")[0]).toMatchObject({
      occurrenceKey: "holiday_december:2026",
      scheduledFor: "2026-12-15",
    });
    const moved = cfg({ mailingKey: "holiday_december", schedule: { monthDay: "12-20" } });
    expect(nextOccurrences([moved], "2026-12-10")[0]?.scheduledFor).toBe("2026-12-20");
  });

  it("a tenant's newsletter dates override the defaults; malformed or impossible dates fall back or are dropped", () => {
    const c = cfg({ mailingKey: "newsletter_quarterly", schedule: { monthDays: ["03-01", "09-01"] } });
    expect(nextOccurrences([c], "2026-02-25")[0]).toMatchObject({ occurrenceKey: "newsletter_quarterly:2026-Q1", scheduledFor: "2026-03-01" });
    expect(nextOccurrences([c], "2026-08-25")[0]).toMatchObject({ occurrenceKey: "newsletter_quarterly:2026-Q2", scheduledFor: "2026-09-01" });
    // garbage falls back to the default four dates
    const bad = cfg({ mailingKey: "newsletter_quarterly", schedule: { monthDays: ["13-40", "nope"] } });
    expect(nextOccurrences([bad], "2026-10-10")[0]?.scheduledFor).toBe("2026-10-15");
    // Feb 29 exists in 2028 only: the common year drops it instead of rolling it into March
    const leap = cfg({ mailingKey: "newsletter_quarterly", leadDays: 3, schedule: { monthDays: ["02-29"] } });
    expect(nextOccurrences([leap], "2027-02-27")).toEqual([]);
    expect(nextOccurrences([leap], "2028-02-27")[0]?.scheduledFor).toBe("2028-02-29");
  });

  it("the deferred decedent-birthday mailing builds nothing, even when enabled", () => {
    for (const today of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      expect(nextOccurrences([cfg({ mailingKey: "decedent_birthday" })], today)).toEqual([]);
    }
  });

  it("is a pure function of its inputs and sorts by date then key", () => {
    const configs = [cfg({ mailingKey: "fathers_day", leadDays: 60 }), cfg({ mailingKey: "mothers_day", leadDays: 60 })];
    const a = nextOccurrences(configs, "2026-05-01");
    const b = nextOccurrences([...configs].reverse(), "2026-05-01");
    expect(a).toEqual(b);
    expect(a.map((o) => o.mailingKey)).toEqual(["mothers_day", "fathers_day"]);
  });

  it("maps a mailing key to its run kind and a run kind to its contact-log activity kind", () => {
    expect(runKindOf("newsletter_quarterly")).toBe("newsletter");
    expect(runKindOf("mothers_day")).toBe("holiday");
    expect(activityKindOfRun("newsletter")).toBe("newsletter_mailing");
    expect(activityKindOfRun("holiday")).toBe("holiday_mailing");
    expect(activityKindOfRun("memorial_invitation")).toBe("memorial_invitation_mailing");
  });
});
