// GAP-149 — the cost-report cap aggregate is keyed by CCN, never "the first row for the cap year".
import { describe, expect, it } from "vitest";
import { UNBOUND_CAP_CCN, selectCapPeriodForCcn } from "./cap-period-selection";

const A = { id: "p-a", ccn: "381234" };
const B = { id: "p-b", ccn: "385678" };
const UNBOUND = { id: "p-u", ccn: UNBOUND_CAP_CCN };

describe("selectCapPeriodForCcn", () => {
  it("returns the period of the requested CCN, not the first row (two-CCN org)", () => {
    expect(selectCapPeriodForCcn([A, B], "385678")).toBe(B);
    expect(selectCapPeriodForCcn([A, B], "381234")).toBe(A);
  });

  it("an exact CCN match beats the unbound placeholder period", () => {
    expect(selectCapPeriodForCcn([UNBOUND, B], "385678")).toBe(B);
  });

  it("falls back to the single not-yet-CCN-bound period (today's openPeriod sentinel)", () => {
    expect(selectCapPeriodForCcn([UNBOUND], "385678")).toBe(UNBOUND);
  });

  it("returns null when the requested CCN has no period and nothing is unbound", () => {
    expect(selectCapPeriodForCcn([A], "999999")).toBeNull();
    expect(selectCapPeriodForCcn([A, B], "999999")).toBeNull();
    expect(selectCapPeriodForCcn([], "381234")).toBeNull();
  });

  it("keeps the single-period contract when no CCN is given", () => {
    expect(selectCapPeriodForCcn([A])).toBe(A);
    expect(selectCapPeriodForCcn([A], null)).toBe(A);
  });

  it("refuses to guess between several CCNs when none is given (fail-closed)", () => {
    expect(selectCapPeriodForCcn([A, B])).toBeNull();
    expect(selectCapPeriodForCcn([])).toBeNull();
  });
});
