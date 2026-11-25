// WF09 — the ADL levels of the patient's previous signed visit (pure): which earlier visit the note's change-in-dependence statement
// compares against. The query that feeds it (signed visits only, the patient's own, tenant-scoped) is proven live in m8-findings.live.test.ts.
import { describe, expect, it } from "vitest";
import { type PriorAdlRow, pickPriorAdl } from "../src/modules/08-encounters/findings/prior-adl";

let clock = 0;
/** One earlier visit's ADL record: later calls were saved later. */
const visit = (serviceDate: string, items: PriorAdlRow["items"]): PriorAdlRow => ({
  serviceDate,
  updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, clock++)),
  items,
});

describe("pickPriorAdl", () => {
  it("is null for a patient with no earlier record", () => {
    expect(pickPriorAdl([])).toBeNull();
  });

  it("is the most recent earlier visit's levels and its service date, whatever order the rows arrive in", () => {
    const older = visit("2026-03-03", { bathing: "limited_assist" });
    const newer = visit("2026-03-10", { bathing: "extensive_assist", eating: "independent" });
    const expected = {
      on: "2026-03-10",
      items: { bathing: "extensive_assist", eating: "independent" },
    };
    expect(pickPriorAdl([older, newer])).toEqual(expected);
    expect(pickPriorAdl([newer, older])).toEqual(expected);
  });

  it("skips a more recent visit that assessed no ADL and takes the latest one that did", () => {
    const assessed = visit("2026-03-03", { dressing: "supervision" });
    const empty = visit("2026-03-10", undefined);
    const noneOccurred = visit("2026-03-11", { bathing: "did_not_occur" });
    expect(pickPriorAdl([empty, noneOccurred, assessed])).toEqual({
      on: "2026-03-03",
      items: { dressing: "supervision" },
    });
  });

  it("is null when no earlier visit assessed an ADL", () => {
    expect(
      pickPriorAdl([visit("2026-03-10", {}), visit("2026-03-03", { bathing: "did_not_occur" })]),
    ).toBeNull();
  });

  it("breaks a tie on the service date by the later save", () => {
    const first = visit("2026-03-10", { bathing: "limited_assist" });
    const second = visit("2026-03-10", { bathing: "total_dependence" });
    expect(pickPriorAdl([first, second])?.items).toEqual({ bathing: "total_dependence" });
    expect(pickPriorAdl([second, first])?.items).toEqual({ bathing: "total_dependence" });
  });

  it("does not mutate the rows it is given", () => {
    const rows = [
      visit("2026-03-03", { bathing: "limited_assist" }),
      visit("2026-03-10", { bathing: "independent" }),
    ];
    const before = JSON.stringify(rows);
    pickPriorAdl(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
