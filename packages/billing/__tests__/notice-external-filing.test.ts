// A tenant that bills outside ChartWarden files its NOE / NOTR itself and records the date it filed (owner decision D4).
// The rules for that record: the notice is still to be filed (draft / ready), the date is a real calendar day that is not in
// the future and not before the notice's earliest date, a re-record of the same date is a no-op and a different date is
// refused, and a date after the due date is stamped as a breach on record.
import { describe, expect, it } from "vitest";
import { planExternalFilingRecord, planExternalFilingWithdrawal } from "../src/notice";

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

// A platform operator can withdraw a tenant's "filed outside ChartWarden" record (a mistaken or fraudulent one: the tenant itself
// cannot, and cancel refuses). The withdrawal is pinned to the record the operator read (its recordedAt).
describe("planExternalFilingWithdrawal", () => {
  const RECORDED = "2026-11-10T15:00:00.000Z";
  const filed = {
    externalFilingStatus: "filed" as const,
    filedExternallyOn: "2026-11-04",
    filedExternallyRecordedAt: RECORDED,
    expectedRecordedAt: RECORDED,
    externalFilingSetBreach: false,
  };

  it("withdraws the record the operator read, and says which filed date it withdrew", () => {
    expect(planExternalFilingWithdrawal(filed)).toEqual({
      kind: "withdraw",
      withdrawnFiledOn: "2026-11-04",
      withdrawnRecordedAt: RECORDED,
      clearBreach: false,
    });
  });

  // A LATE record stamps `window_breached_at = filedOn` itself and says so (`externalFilingSetBreach`). Withdrawing that record must
  // take its own stamp back (the notice was never filed late: it was never filed), or re-recording the true on-time date reads as
  // contradicting a breach nobody observed.
  it("clears the breach stamp the withdrawn LATE record wrote itself (the record's own flag says so)", () => {
    expect(
      planExternalFilingWithdrawal({
        ...filed,
        filedExternallyOn: "2026-11-08",
        externalFilingSetBreach: true,
      }),
    ).toEqual({
      kind: "withdraw",
      withdrawnFiledOn: "2026-11-08",
      withdrawnRecordedAt: RECORDED,
      clearBreach: true,
    });
  });

  // The stamp's OWNER is recorded, not inferred from dates: a tenant that files exactly one day late records filedOn = target + 1,
  // the very day the watchdog stamps (`medicareReceiptDay(now)` on its first tick after the due day). The dates cannot tell the two
  // writers apart; only the record's own flag can. Here the watchdog stamped 2026-11-07 first (target 2026-11-06) and the tenant
  // then recorded 2026-11-07: the flag is false, so the stamp stays whatever the dates say.
  it("keeps a watchdog stamp that happens to equal the record's late filed date (the watchdog stamped first, the record never wrote it)", () => {
    expect(
      planExternalFilingWithdrawal({ ...filed, filedExternallyOn: "2026-11-07" }),
    ).toMatchObject({ kind: "withdraw", clearBreach: false });
  });

  it.each([null, "pending"] as const)(
    "refuses a notice that is not recorded as filed (marker %s): there is nothing to withdraw",
    (externalFilingStatus) => {
      expect(
        planExternalFilingWithdrawal({
          ...filed,
          externalFilingStatus,
          filedExternallyOn: null,
          filedExternallyRecordedAt: null,
        }),
      ).toMatchObject({ kind: "refuse", code: "NOTICE_NOT_FILED_EXTERNALLY", status: 409 });
    },
  );

  // The operator can only retry if the refusal says what the record's recordedAt is NOW (the If-Match to send).
  it("refuses when the record changed since the operator read it (re-recorded after a withdrawal), naming the current recordedAt to retry with", () => {
    expect(
      planExternalFilingWithdrawal({
        ...filed,
        filedExternallyRecordedAt: "2026-11-11T09:00:00.000Z",
      }),
    ).toMatchObject({
      kind: "refuse",
      code: "NOTICE_FILING_RECORD_CHANGED",
      status: 409,
      currentRecordedAt: "2026-11-11T09:00:00.000Z",
    });
  });

  it("answers a withdrawal that named no record (no If-Match) with 428 and the current recordedAt to send", () => {
    expect(planExternalFilingWithdrawal({ ...filed, expectedRecordedAt: null })).toMatchObject({
      kind: "refuse",
      code: "IF_MATCH_REQUIRED",
      status: 428,
      currentRecordedAt: RECORDED,
    });
  });

  it("answers an un-pinned withdrawal of a notice that is not filed with the 409 'nothing to withdraw' (there is no record to name)", () => {
    expect(
      planExternalFilingWithdrawal({
        ...filed,
        expectedRecordedAt: null,
        externalFilingStatus: null,
        filedExternallyOn: null,
        filedExternallyRecordedAt: null,
      }),
    ).toMatchObject({ kind: "refuse", code: "NOTICE_NOT_FILED_EXTERNALLY", status: 409 });
  });
});
