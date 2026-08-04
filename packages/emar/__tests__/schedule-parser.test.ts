// @wardenx/emar — §2.3 D2 scheduled-dose materializer + frequency parser — M13-T03.
import { describe, expect, it } from "vitest";
import {
  FrequencyParseError,
  type MaterializableOrder,
  type ScheduleFrequency,
  materializeForOrder,
  materializeSchedule,
  parseFrequencyCode,
} from "../src/schedule";

const UTC = "UTC";

describe("§2.3 parseFrequencyCode", () => {
  it("maps interval codes (q4h → every 240 min anchored at midnight)", () => {
    expect(parseFrequencyCode("q4h")).toEqual({
      kind: "interval",
      everyMinutes: 240,
      anchor: "00:00",
    });
    expect(parseFrequencyCode("Q6H")).toEqual({
      kind: "interval",
      everyMinutes: 360,
      anchor: "00:00",
    });
  });
  it("maps named-time codes (BID → 08:00/20:00)", () => {
    expect(parseFrequencyCode("BID")).toEqual({ kind: "named_times", times: ["08:00", "20:00"] });
    expect(parseFrequencyCode("qid")).toEqual({
      kind: "named_times",
      times: ["08:00", "12:00", "16:00", "20:00"],
    });
  });
  it("maps meal-anchored codes (with meals → three meal events)", () => {
    expect(parseFrequencyCode("cc")).toEqual({
      kind: "event_anchored",
      events: ["breakfast", "lunch", "dinner"],
    });
  });
  it("maps weekly day codes (MWF → mon/wed/fri at default 09:00)", () => {
    expect(parseFrequencyCode("MWF")).toEqual({
      kind: "weekly_named_days",
      days: ["mon", "wed", "fri"],
      times: ["09:00"],
    });
  });
  it("maps a weekly code with an explicit time (TuTh@09:00)", () => {
    expect(parseFrequencyCode("TuTh@09:00")).toEqual({
      kind: "weekly_named_days",
      days: ["tue", "thu"],
      times: ["09:00"],
    });
  });
  it("PRN / asNeeded short-circuits to prn (no materialization)", () => {
    expect(parseFrequencyCode("PRN")).toEqual({ kind: "prn" });
    expect(parseFrequencyCode("q4h", true)).toEqual({ kind: "prn" }); // soft-schedule PRN
  });
  it("an unrecognized code raises FrequencyParseError (422, manual review)", () => {
    expect(() => parseFrequencyCode("qod")).toThrow(FrequencyParseError);
    expect(() => parseFrequencyCode("every-other-tuesday-ish")).toThrow(
      expect.objectContaining({ code: "FREQUENCY_NOT_PARSEABLE", statusCode: 422 }),
    );
  });
});

const dose = { expectedDoseAmount: 0.5, expectedDoseUnit: "mg", expectedRoute: "PO" };

describe("§2.3 materializeSchedule", () => {
  it("PRN materializes no rows", () => {
    const rows = materializeSchedule(
      { kind: "prn" },
      { timeZone: UTC, windowStartDate: "2026-06-22", windowDays: 7, ...dose },
    );
    expect(rows).toEqual([]);
  });

  it("BID over one day → two ascending rows at 08:00 and 20:00", () => {
    const rows = materializeSchedule(
      { kind: "named_times", times: ["08:00", "20:00"] },
      { timeZone: UTC, windowStartDate: "2026-06-22", windowDays: 1, ...dose },
    );
    expect(rows.map((r) => r.dueAt)).toEqual([
      "2026-06-22T08:00:00.000Z",
      "2026-06-22T20:00:00.000Z",
    ]);
    expect(rows[0]).toMatchObject({
      expectedDoseAmount: 0.5,
      expectedDoseUnit: "mg",
      expectedRoute: "PO",
    });
  });

  it("q6h over one day → four rows (00/06/12/18)", () => {
    const rows = materializeSchedule(
      { kind: "interval", everyMinutes: 360, anchor: "00:00" },
      { timeZone: UTC, windowStartDate: "2026-06-22", windowDays: 1, ...dose },
    );
    expect(rows.map((r) => r.dueAt)).toEqual([
      "2026-06-22T00:00:00.000Z",
      "2026-06-22T06:00:00.000Z",
      "2026-06-22T12:00:00.000Z",
      "2026-06-22T18:00:00.000Z",
    ]);
  });

  it("MWF only materializes on mon/wed/fri", () => {
    // 2026-06-22 is a Monday; window of 7 days covers Mon..Sun.
    const rows = materializeSchedule(
      { kind: "weekly_named_days", days: ["mon", "wed", "fri"], times: ["10:00"] },
      { timeZone: UTC, windowStartDate: "2026-06-22", windowDays: 7, ...dose },
    );
    expect(rows.map((r) => r.dueAt)).toEqual([
      "2026-06-22T10:00:00.000Z", // Mon
      "2026-06-24T10:00:00.000Z", // Wed
      "2026-06-26T10:00:00.000Z", // Fri
    ]);
  });

  it("notBeforeInstant drops slots at/before order activation", () => {
    const rows = materializeSchedule(
      { kind: "named_times", times: ["08:00", "20:00"] },
      {
        timeZone: UTC,
        windowStartDate: "2026-06-22",
        windowDays: 1,
        ...dose,
        notBeforeInstant: "2026-06-22T08:00:00.000Z", // exactly the 08:00 slot → dropped
      },
    );
    expect(rows.map((r) => r.dueAt)).toEqual(["2026-06-22T20:00:00.000Z"]);
  });

  it("DST spring-forward: a US/Eastern q1h day has no duplicate/extra-collision rows", () => {
    // 2026-03-08 is the US DST spring-forward day (02:00 → 03:00 skips). q1h across the day.
    const rows = materializeSchedule(
      { kind: "interval", everyMinutes: 60, anchor: "00:00" },
      { timeZone: "America/New_York", windowStartDate: "2026-03-08", windowDays: 1, ...dose },
    );
    const instants = rows.map((r) => r.dueAt);
    expect(new Set(instants).size).toBe(instants.length); // de-duped by instant
    expect(instants).toEqual([...instants].sort()); // ascending
  });
});

describe("§2.3 materializeForOrder (M12 projection)", () => {
  const order: MaterializableOrder = {
    route: "PO",
    sigStructured: {
      doseQuantity: 0.5,
      doseUnit: "mg",
      route: "PO",
      frequencyCode: "BID",
      asNeeded: false,
    },
    activatedAt: "2026-06-22T09:00:00.000Z",
  };

  it("projects the order sig into BID rows, dropping the 08:00 (before activation)", () => {
    const rows = materializeForOrder(order, {
      timeZone: UTC,
      windowStartDate: "2026-06-22",
      windowDays: 1,
    });
    expect(rows.map((r) => r.dueAt)).toEqual(["2026-06-22T20:00:00.000Z"]);
    expect(rows[0]).toMatchObject({
      expectedDoseAmount: 0.5,
      expectedDoseUnit: "mg",
      expectedRoute: "PO",
    });
  });

  it("a PRN order materializes nothing", () => {
    const prn: MaterializableOrder = {
      ...order,
      sigStructured: { ...order.sigStructured, frequencyCode: "PRN", asNeeded: true },
    };
    expect(
      materializeForOrder(prn, { timeZone: UTC, windowStartDate: "2026-06-22", windowDays: 7 }),
    ).toEqual([]);
  });
});

// A type-level anchor so a future ScheduleFrequency variant addition trips the exhaustive switch.
const _exhaustive: ScheduleFrequency["kind"][] = [
  "interval",
  "named_times",
  "weekly_named_days",
  "event_anchored",
  "prn",
];
