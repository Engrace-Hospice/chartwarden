// @chartwarden/scheduling — §2.2.3 D4 / §7.7 RRULE materializer + discontinuation — M17-T03.
import { describe, expect, it } from "vitest";
import {
  type MaterializeInput,
  materializeRecurrence,
  outboxEvents,
  parseRrule,
  planRecurrenceDiscontinuation,
  weekdayCode,
} from "../src/lifecycle";

const TZ = "America/Los_Angeles";

/** Format an ISO instant's wall-clock `HH:MM` in `tz` (DST round-trip assertions). */
function localHourMinute(instant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("hour")}:${get("minute")}`;
}

const baseInput = (
  rrule: string,
  startDate: string,
  endDate: string | null = null,
): MaterializeInput => ({
  rule: parseRrule(rrule),
  startDate,
  endDate,
  timeOfDayStart: "10:00",
  timeOfDayEnd: "11:00",
  timeZone: TZ,
});

describe("§2.2.5 parseRrule subset", () => {
  it("parses a WEEKLY MO,WE,FR rule", () => {
    expect(parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toEqual({
      freq: "WEEKLY",
      interval: 1,
      byDay: ["MO", "WE", "FR"],
      count: null,
      until: null,
    });
  });

  it("parses a DAILY rule with INTERVAL and COUNT", () => {
    expect(parseRrule("FREQ=DAILY;INTERVAL=2;COUNT=5")).toEqual({
      freq: "DAILY",
      interval: 2,
      byDay: [],
      count: 5,
      until: null,
    });
  });

  it("rejects FREQ=MONTHLY / YEARLY (RECURRENCE_FREQUENCY_NOT_SUPPORTED)", () => {
    for (const f of ["MONTHLY", "YEARLY"]) {
      expect(() => parseRrule(`FREQ=${f};INTERVAL=1`)).toThrowError(
        expect.objectContaining({ code: "RECURRENCE_FREQUENCY_NOT_SUPPORTED", statusCode: 422 }),
      );
    }
  });

  it("rejects both COUNT and UNTIL (RECURRENCE_TERMINATOR_CONFLICT)", () => {
    expect(() => parseRrule("FREQ=DAILY;COUNT=3;UNTIL=20261231")).toThrowError(
      expect.objectContaining({ code: "RECURRENCE_TERMINATOR_CONFLICT" }),
    );
  });

  it("rejects a WEEKLY rule with no BYDAY, and BYDAY on a DAILY rule", () => {
    expect(() => parseRrule("FREQ=WEEKLY")).toThrowError(
      expect.objectContaining({ code: "RECURRENCE_BYDAY_INVALID" }),
    );
    expect(() => parseRrule("FREQ=DAILY;BYDAY=MO")).toThrowError(
      expect.objectContaining({ code: "RECURRENCE_INVALID_RRULE" }),
    );
  });

  it("rejects out-of-subset operators (BYSETPOS) and malformed input", () => {
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1")).toThrowError(
      expect.objectContaining({ code: "RECURRENCE_INVALID_RRULE" }),
    );
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY")).toThrowError(
      expect.objectContaining({ code: "RECURRENCE_INVALID_RRULE" }),
    );
  });
});

describe("§7.7 materialization", () => {
  it("materializes only the BYDAY weekdays across the horizon", () => {
    // 2026-07-01 is a Wednesday.
    const occ = materializeRecurrence(
      baseInput("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-07-01"),
      "2026-07-01",
      90,
    );
    expect(occ.length).toBeGreaterThan(30);
    for (const o of occ) {
      expect(["MO", "WE", "FR"]).toContain(weekdayCode(o.serviceDate));
    }
    // Strictly increasing dates; all within the rolling window.
    for (let i = 1; i < occ.length; i++) {
      expect(occ[i]!.serviceDate > occ[i - 1]!.serviceDate).toBe(true);
    }
    expect(occ[0]!.serviceDate).toBe("2026-07-01");
  });

  it("honors a biweekly INTERVAL (every 14 days)", () => {
    // 2026-07-06 is a Monday.
    const occ = materializeRecurrence(
      baseInput("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-07-06"),
      "2026-07-06",
      90,
    );
    expect(occ[0]!.serviceDate).toBe("2026-07-06");
    expect(occ[1]!.serviceDate).toBe("2026-07-20");
    expect(occ[2]!.serviceDate).toBe("2026-08-03");
  });

  it("caps at COUNT total occurrences", () => {
    const occ = materializeRecurrence(
      baseInput("FREQ=WEEKLY;BYDAY=MO;COUNT=3", "2026-07-06"),
      "2026-07-06",
      90,
    );
    expect(occ.map((o) => o.serviceDate)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
  });

  it("stops at the UNTIL terminator (inclusive)", () => {
    const occ = materializeRecurrence(
      baseInput("FREQ=DAILY;UNTIL=20260705", "2026-07-01"),
      "2026-07-01",
      90,
    );
    expect(occ.map((o) => o.serviceDate)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("honors the recurring_visit end_date column alongside the rule (earliest wins)", () => {
    const occ = materializeRecurrence(
      baseInput("FREQ=DAILY", "2026-07-01", "2026-07-03"),
      "2026-07-01",
      90,
    );
    expect(occ.map((o) => o.serviceDate)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });

  it("is idempotent — identical inputs produce the identical set", () => {
    const a = materializeRecurrence(
      baseInput("FREQ=WEEKLY;BYDAY=TU,TH", "2026-07-01"),
      "2026-07-01",
      90,
    );
    const b = materializeRecurrence(
      baseInput("FREQ=WEEKLY;BYDAY=TU,TH", "2026-07-01"),
      "2026-07-01",
      90,
    );
    expect(a).toEqual(b);
  });

  it("COUNT counts occurrences from the rule start, not the window start", () => {
    // 6 weekly Mondays exist, but 3 fall before the window — only the remaining ones are emitted.
    const occ = materializeRecurrence(
      baseInput("FREQ=WEEKLY;BYDAY=MO;COUNT=6", "2026-07-06"),
      "2026-07-27",
      90,
    );
    expect(occ.map((o) => o.serviceDate)).toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
  });
});

describe("§9.8 DST-boundary round-trip", () => {
  it("keeps a 10:00 org-local visit at 10:00 local across spring-forward (2026-03-08)", () => {
    const occ = materializeRecurrence(baseInput("FREQ=DAILY", "2026-03-06"), "2026-03-06", 5);
    expect(occ.map((o) => o.serviceDate)).toContain("2026-03-08");
    for (const o of occ) {
      expect(localHourMinute(o.scheduledStartedAt, TZ)).toBe("10:00");
      expect(localHourMinute(o.scheduledEndedAt, TZ)).toBe("11:00");
    }
  });

  it("keeps a 10:00 org-local visit at 10:00 local across fall-back (2026-11-01)", () => {
    const occ = materializeRecurrence(baseInput("FREQ=DAILY", "2026-10-30"), "2026-10-30", 5);
    expect(occ.map((o) => o.serviceDate)).toContain("2026-11-01");
    for (const o of occ) {
      expect(localHourMinute(o.scheduledStartedAt, TZ)).toBe("10:00");
    }
  });
});

describe("§2.2.3 discontinuation", () => {
  it("emits m17.recurring_visit.discontinued from an active policy", () => {
    const effects = planRecurrenceDiscontinuation("active");
    expect(outboxEvents(effects)).toEqual(["m17.recurring_visit.discontinued"]);
    expect(effects).toContainEqual({ kind: "set_timestamp", field: "discontinued_at" });
  });

  it("rejects discontinuing an already-discontinued policy (409)", () => {
    expect(() => planRecurrenceDiscontinuation("discontinued")).toThrowError(
      expect.objectContaining({ code: "RECURRENCE_POLICY_NOT_ACTIVE", statusCode: 409 }),
    );
  });
});
