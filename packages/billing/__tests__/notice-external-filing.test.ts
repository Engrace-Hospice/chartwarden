// A tenant that bills outside ChartWarden files its NOE / NOTR itself and records the date it filed (owner decision D4).
// The rules for that record: the notice is still to be filed (draft / ready), the date is a real calendar day that is not in
// the future and not before the notice's earliest date, a re-record of the same date is a no-op and a different date is
// refused, and a date after the due date is stamped as a breach on record.
import { describe, expect, it } from "vitest";
import { planExternalFilingRecord } from "../src/notice";

const base = {
  state: "ready" as const,
  externalFilingStatus: "pending" as const,
  filedExternallyOn: null,
  earliestDate: "2026-11-01",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: null,
  today: "2026-11-10",
};

describe("planExternalFilingRecord", () => {
  it.each(["draft", "ready"] as const)("records a notice in state %s", (state) => {
    expect(planExternalFilingRecord({ ...base, state, filedOn: "2026-11-04" })).toEqual({
      kind: "record",
      stampBreach: false,
      contradictsBreach: false,
      late: false,
    });
  });

  it("records a notice nobody parked yet (status null), the first time the tenant tells us", () => {
    expect(
      planExternalFilingRecord({ ...base, externalFilingStatus: null, filedOn: "2026-11-04" }),
    ).toEqual({ kind: "record", stampBreach: false, contradictsBreach: false, late: false });
  });

  it.each(["submitted", "ack_pending", "ack_accepted", "ack_rejected", "cancelled"] as const)(
    "refuses a notice in state %s: ChartWarden or Medicare already settled it",
    (state) => {
      expect(planExternalFilingRecord({ ...base, state, filedOn: "2026-11-04" })).toMatchObject({
        kind: "refuse",
        code: "NOTICE_STATE_NOT_FILEABLE",
        status: 409,
      });
    },
  );

  it("replays the same date and refuses a different one once filed", () => {
    const filed = {
      ...base,
      externalFilingStatus: "filed" as const,
      filedExternallyOn: "2026-11-04",
    };
    expect(planExternalFilingRecord({ ...filed, filedOn: "2026-11-04" })).toEqual({
      kind: "replay",
    });
    expect(planExternalFilingRecord({ ...filed, filedOn: "2026-11-05" })).toMatchObject({
      kind: "refuse",
      code: "NOTICE_ALREADY_FILED_EXTERNALLY",
      status: 409,
    });
  });

  it("refuses a date in the future, before the earliest date, or not on the calendar", () => {
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-11" })).toMatchObject({
      kind: "refuse",
      code: "FILED_ON_IN_FUTURE",
      status: 422,
    });
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-10-31" })).toMatchObject({
      kind: "refuse",
      code: "FILED_ON_BEFORE_EFFECTIVE_DATE",
      status: 422,
    });
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-02-30" })).toMatchObject({
      kind: "refuse",
      code: "INVALID_DATE",
      status: 422,
    });
  });

  it("accepts today and the earliest date themselves", () => {
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-10" })).toMatchObject({
      kind: "record",
    });
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-01" })).toMatchObject({
      kind: "record",
    });
  });

  it("stamps a breach on record when the date is after the due date and none is stamped yet, and says it was late", () => {
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-07" })).toEqual({
      kind: "record",
      stampBreach: true,
      contradictsBreach: false,
      late: true,
    });
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-06" })).toEqual({
      kind: "record",
      stampBreach: false,
      contradictsBreach: false,
      late: false,
    });
  });

  it("keeps a breach the watchdog already stamped when the filing really was late (still late: the event fires)", () => {
    expect(
      planExternalFilingRecord({ ...base, windowBreachedAt: "2026-11-07", filedOn: "2026-11-09" }),
    ).toEqual({ kind: "record", stampBreach: false, contradictsBreach: false, late: true });
  });

  // The watchdog scans an unfiled notice every 30 minutes: past the due date it stamps a breach. A tenant that says it filed ON
  // TIME but told ChartWarden afterwards cannot erase that stamp: it is what ChartWarden observed, the filing date is only the
  // tenant's word. The record keeps the stamp and says so, so the caller can put both facts in front of compliance and ops.
  it("keeps a breach stamp the watchdog set before an ON-TIME filing was recorded, and flags the contradiction", () => {
    const stamped = { ...base, windowBreachedAt: "2026-11-07" };
    expect(planExternalFilingRecord({ ...stamped, filedOn: "2026-11-05" })).toEqual({
      kind: "record",
      stampBreach: false,
      contradictsBreach: true,
      late: false,
    });
    expect(planExternalFilingRecord({ ...stamped, filedOn: "2026-11-06" })).toMatchObject({
      stampBreach: false,
      contradictsBreach: true,
      late: false,
    });
  });

  it("never offers to clear a breach stamp, whatever the filing date", () => {
    for (const filedOn of ["2026-11-02", "2026-11-06", "2026-11-09"]) {
      expect(
        planExternalFilingRecord({ ...base, windowBreachedAt: "2026-11-07", filedOn }),
      ).not.toHaveProperty("clearBreach");
    }
  });

  it("does not call a late filing a contradiction (the stamp and the filing agree)", () => {
    expect(
      planExternalFilingRecord({ ...base, windowBreachedAt: "2026-11-07", filedOn: "2026-11-09" }),
    ).toMatchObject({ contradictsBreach: false, late: true });
  });
});
