// Late NOE — CMS Pub. 100-04 ch. 11 §20.1.1: a timely NOE is submitted to AND accepted by the MAC within 5
// calendar days after the hospice admission date; otherwise the days from the admission date through the day
// before the acceptance (receipt) date are provider liability, reported on the claim as occurrence span 77.
import { describe, expect, it } from "vitest";
import { claimLateNoeSpans, lateNoeOccurrenceSpan, noeTimeliness } from "../src/notice";

describe("noeTimeliness — accepted within admission + 5 calendar days", () => {
  it("is timely when the MAC accepted it on the fifth day after admission", () => {
    expect(noeTimeliness({ admissionDate: "2026-03-01", acceptedDate: "2026-03-06" })).toEqual({
      status: "timely",
      dueDate: "2026-03-06",
      daysLate: 0,
    });
  });

  it("is timely when accepted on the admission day", () => {
    expect(noeTimeliness({ admissionDate: "2026-03-01", acceptedDate: "2026-03-01" }).status).toBe(
      "timely",
    );
  });

  it("is late by 1 when accepted on the sixth day", () => {
    expect(noeTimeliness({ admissionDate: "2026-03-01", acceptedDate: "2026-03-07" })).toEqual({
      status: "late",
      dueDate: "2026-03-06",
      daysLate: 1,
    });
  });

  it("is unknown without an acceptance date", () => {
    expect(noeTimeliness({ admissionDate: "2026-03-01", acceptedDate: null })).toEqual({
      status: "unknown",
      dueDate: "2026-03-06",
      daysLate: null,
    });
  });
});

describe("lateNoeOccurrenceSpan — OSC 77 from admission through the day before acceptance", () => {
  const claim = { serviceFrom: "2026-03-01", serviceTo: "2026-03-31" };

  it("reports no span for a timely NOE", () => {
    expect(
      lateNoeOccurrenceSpan({ admissionDate: "2026-03-01", acceptedDate: "2026-03-06", ...claim }),
    ).toBeNull();
  });

  it("late by 1: admission through the day before acceptance (six liable days)", () => {
    expect(
      lateNoeOccurrenceSpan({ admissionDate: "2026-03-01", acceptedDate: "2026-03-07", ...claim }),
    ).toEqual({ code: "77", from: "2026-03-01", through: "2026-03-06" });
  });

  it("late across a claim-period boundary: each claim reports only its own liable days", () => {
    const late = { admissionDate: "2026-03-20", acceptedDate: "2026-04-10" };
    // The March claim is liable from admission to its last day.
    expect(
      lateNoeOccurrenceSpan({ ...late, serviceFrom: "2026-03-20", serviceTo: "2026-03-31" }),
    ).toEqual({ code: "77", from: "2026-03-20", through: "2026-03-31" });
    // The April claim is liable from its first day through the day before acceptance.
    expect(
      lateNoeOccurrenceSpan({ ...late, serviceFrom: "2026-04-01", serviceTo: "2026-04-30" }),
    ).toEqual({ code: "77", from: "2026-04-01", through: "2026-04-09" });
    // A May claim has no liable days.
    expect(
      lateNoeOccurrenceSpan({ ...late, serviceFrom: "2026-05-01", serviceTo: "2026-05-31" }),
    ).toBeNull();
  });

  it("reports no span when the acceptance date is missing (the rule reports it instead)", () => {
    expect(
      lateNoeOccurrenceSpan({ admissionDate: "2026-03-01", acceptedDate: null, ...claim }),
    ).toBeNull();
  });

  it("rejects malformed dates rather than mis-billing", () => {
    expect(() =>
      lateNoeOccurrenceSpan({ admissionDate: "2026-02-30", acceptedDate: "2026-03-09", ...claim }),
    ).toThrow(RangeError);
  });
});

describe("claimLateNoeSpans — the spans persisted on the claim", () => {
  const claim = { serviceFrom: "2026-03-01", serviceTo: "2026-03-31" };
  const noe = { electionEffectiveDate: "2026-03-01", acceptedDate: "2026-03-09" };

  it("derives the OSC 77 span from an accepted late NOE", () => {
    expect(claimLateNoeSpans({ ...noe, state: "ack_accepted" }, claim)).toEqual([
      { code: "77", from: "2026-03-01", through: "2026-03-08" },
    ]);
  });

  it("derives nothing for a NOE that is not accepted, or no NOE", () => {
    expect(claimLateNoeSpans({ ...noe, state: "ack_pending" }, claim)).toEqual([]);
    expect(claimLateNoeSpans(null, claim)).toEqual([]);
  });
});
