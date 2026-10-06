import { describe, expect, it } from "vitest";
import { HETS_HOSPICE_PERIOD_RETURN_CAP, deriveHospiceHistory } from "./hospice-history";
import type { HospiceRecord } from "./parse-271";

const AS_OF = { asOfServiceDate: "2026-10-06" };

const billed = (
  startDate: string,
  endDate: string,
  revocationCode: HospiceRecord["revocationCode"] = "1",
): HospiceRecord => ({
  kind: "benefit_period",
  startDate,
  endDate,
  daysUsed: null,
  billingActivityStart: null,
  billingActivityEnd: null,
  revocationCode,
  hospiceNpi: "1649726464",
});
const noe = (
  startDate: string,
  revocationCode: HospiceRecord["revocationCode"] = "0",
): HospiceRecord => ({
  ...billed(startDate, startDate, revocationCode),
  kind: "election",
  endDate: null,
});

describe("deriveHospiceHistory", () => {
  it("numbers billed periods oldest-first and ignores input order", () => {
    const h = deriveHospiceHistory(
      [billed("2024-04-10", "2024-07-08"), billed("2024-01-10", "2024-04-09")],
      AS_OF,
    );
    expect(h.periods.map((p) => [p.startDate, p.periodNumber])).toEqual([
      ["2024-01-10", 1],
      ["2024-04-10", 2],
    ]);
    expect(h).toMatchObject({
      electionOpen: false,
      nextPeriodNumber: 3,
      nextPeriodBasis: "computed",
    });
  });

  it("dedupes a period reported twice (transfer) by start date", () => {
    const h = deriveHospiceHistory(
      [billed("2024-01-10", "2024-04-09"), billed("2024-01-10", "2024-04-09")],
      AS_OF,
    );
    expect(h.billedPeriodCount).toBe(1);
    expect(h.nextPeriodNumber).toBe(2);
  });

  it("a revoked NOE after the last billed period is an unbilled election → no next number", () => {
    const h = deriveHospiceHistory(
      [billed("2024-01-10", "2024-04-09"), noe("2026-09-01", "1")],
      AS_OF,
    );
    expect(h.electionOpen).toBe(false);
    expect(h.nextPeriodNumber).toBeNull();
    expect(h.nextPeriodBasis).toBe("unbilled_election");
  });

  it("code 0 on a billed period that ended before the as-of date is uncertain, not open", () => {
    const h = deriveHospiceHistory([billed("2026-06-01", "2026-08-29", "0")], AS_OF);
    expect(h.electionOpen).toBeNull();
    expect(h.nextPeriodNumber).toBeNull();
    expect(h.nextPeriodBasis).toBe("election_status_uncertain");
  });

  it("code 0 on a billed period still running on the as-of date is open", () => {
    const h = deriveHospiceHistory([billed("2026-09-01", "2026-11-29", "0")], AS_OF);
    expect(h.electionOpen).toBe(true);
    expect(h.nextPeriodBasis).toBe("election_open");
  });

  it("a history at the HETS return cap is truncated → no ordinals, no next number", () => {
    const records = Array.from({ length: HETS_HOSPICE_PERIOD_RETURN_CAP }, (_, i) => {
      const start = new Date(Date.UTC(1980, 0, 1 + i * 61)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(1980, 0, 60 + i * 61)).toISOString().slice(0, 10);
      return billed(start, end);
    });
    const h = deriveHospiceHistory(records, AS_OF);
    expect(h.truncated).toBe(true);
    expect(h.periods.every((p) => p.periodNumber === null)).toBe(true);
    expect(h).toMatchObject({ nextPeriodNumber: null, nextPeriodBasis: "history_truncated" });
  });

  it("no hospice records → election closed, next period 1", () => {
    expect(deriveHospiceHistory([], AS_OF)).toMatchObject({
      periods: [],
      electionOpen: false,
      nextPeriodNumber: 1,
    });
  });
});
