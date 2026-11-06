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
    });
  });

  it("records a notice nobody parked yet (status null), the first time the tenant tells us", () => {
    expect(
      planExternalFilingRecord({ ...base, externalFilingStatus: null, filedOn: "2026-11-04" }),
    ).toEqual({ kind: "record", stampBreach: false });
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

  it("stamps a breach on record when the date is after the due date and none is stamped yet", () => {
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-07" })).toEqual({
      kind: "record",
      stampBreach: true,
    });
    expect(planExternalFilingRecord({ ...base, filedOn: "2026-11-06" })).toEqual({
      kind: "record",
      stampBreach: false,
    });
    expect(
      planExternalFilingRecord({ ...base, windowBreachedAt: "2026-11-07", filedOn: "2026-11-09" }),
    ).toEqual({ kind: "record", stampBreach: false });
  });
});
