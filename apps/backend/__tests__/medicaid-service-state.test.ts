import { describe, expect, it } from "vitest";
import { resolveServiceState } from "../src/modules/24-billing-medicaid/routes/service-state";

const d = (s: string) => new Date(s);
const cred = (serviceState: string, from: string, to: string | null) => ({
  serviceState,
  activeFrom: d(from),
  activeTo: to ? d(to) : null,
});

describe("resolveServiceState (GAP-196)", () => {
  it("resolves the single state in force", () => {
    const r = resolveServiceState([cred("OR", "2026-01-01", null)], d("2026-06-01"));
    expect(r).toEqual({ kind: "resolved", state: "OR" });
  });

  it("ignores expired and not-yet-active credentials", () => {
    const r = resolveServiceState(
      [
        cred("WA", "2025-01-01", "2026-01-01"),
        cred("OR", "2026-01-01", null),
        cred("CA", "2027-01-01", null),
      ],
      d("2026-06-01"),
    );
    expect(r).toEqual({ kind: "resolved", state: "OR" });
  });

  it("reports ambiguity for a multi-state tenant instead of picking the first row", () => {
    const r = resolveServiceState(
      [cred("WA", "2026-01-01", null), cred("OR", "2026-01-01", null)],
      d("2026-06-01"),
    );
    expect(r).toEqual({ kind: "ambiguous", states: ["OR", "WA"] });
  });

  it("returns none when nothing is in force", () => {
    expect(resolveServiceState([], d("2026-06-01"))).toEqual({ kind: "none" });
  });
});
