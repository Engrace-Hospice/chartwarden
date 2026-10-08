// GAP-026 — POST /recurring-visits must persist (and validate) the client's window, timezone, dates, count
// and byday instead of hard-coding 09:00-10:00 UTC.
import { describe, expect, it } from "vitest";

import {
  type RecurringPolicyFields,
  assertRecurringPolicyValid,
  toRecurringPolicyColumns,
} from "../src/modules/17-scheduling/recurring-policy";

const base: RecurringPolicyFields = {
  rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
  timeOfDayStart: "13:30",
  timeOfDayEnd: "14:15",
  timeZone: "America/Chicago",
  startDate: "2026-11-02",
};

describe("GAP-026 recurring policy validation", () => {
  it("accepts a complete open-ended policy", () => {
    expect(() => assertRecurringPolicyValid(base)).not.toThrow();
  });

  it("rejects endDate and count together", () => {
    expect(() => assertRecurringPolicyValid({ ...base, endDate: "2026-12-01", count: 4 })).toThrow(
      /endDate or count/,
    );
  });

  it("rejects an unknown timezone", () => {
    expect(() => assertRecurringPolicyValid({ ...base, timeZone: "Mars/Olympus" })).toThrow(
      /timeZone/,
    );
  });

  it("rejects an end time that is not after the start time", () => {
    expect(() => assertRecurringPolicyValid({ ...base, timeOfDayEnd: "13:30" })).toThrow(
      /timeOfDayEnd/,
    );
  });

  it("rejects an out-of-range hour the schema pattern lets through", () => {
    expect(() => assertRecurringPolicyValid({ ...base, timeOfDayStart: "27:00" })).toThrow(
      /timeOfDayStart/,
    );
  });

  it("rejects an endDate before the startDate", () => {
    expect(() => assertRecurringPolicyValid({ ...base, endDate: "2026-10-01" })).toThrow(/endDate/);
  });

  it("rejects an unsupported RRULE", () => {
    expect(() => assertRecurringPolicyValid({ ...base, rrule: "FREQ=MONTHLY" })).toThrow();
  });

  it("rejects a byday list that disagrees with the RRULE BYDAY", () => {
    expect(() => assertRecurringPolicyValid({ ...base, byday: ["TU"] })).toThrow(/byday/);
  });

  it("maps the client's fields onto the stored columns without defaulting", () => {
    const cols = toRecurringPolicyColumns({
      ...base,
      count: 6,
      byday: ["MO", "WE"],
      patientAddressId: "11111111-1111-4111-8111-111111111111",
    });
    expect(cols).toMatchObject({
      timeOfDayStart: "13:30",
      timeOfDayEnd: "14:15",
      timeZone: "America/Chicago",
      startDate: "2026-11-02",
      endDate: null,
      count: 6,
      byday: ["MO", "WE"],
      patientAddressId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
