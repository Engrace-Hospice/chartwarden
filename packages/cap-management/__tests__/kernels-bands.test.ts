import { describe, expect, it } from "vitest";
import {
  aggregateBand,
  asPercent,
  bandRank,
  capYearForDate,
  capYearWindow,
  elapsedFraction,
  inclusiveDays,
  inpatientBand,
  isEscalation,
  isResolution,
  ratio,
  round4,
  roundCents,
  safeBandFor,
} from "../src/index";

describe("cap-year window math (D1)", () => {
  it("maps FY2026 to its Oct 1 2025 – Sep 30 2026 federal-FY window", () => {
    expect(capYearWindow("FY2026")).toEqual({ startsOn: "2025-10-01", endsOn: "2026-09-30" });
  });
  it("a full cap year is 365 days (FY2026 is non-leap across the span)", () => {
    expect(inclusiveDays("2025-10-01", "2026-09-30")).toBe(365);
  });
  it("assigns Oct–Dec to the next federal FY label, Jan–Sep to the calendar year", () => {
    expect(capYearForDate("2025-10-01")).toBe("FY2026");
    expect(capYearForDate("2026-09-30")).toBe("FY2026");
    expect(capYearForDate("2026-10-01")).toBe("FY2027");
    expect(capYearForDate("2026-01-15")).toBe("FY2026");
  });
  it("elapsed fraction is 1 at/after close and the run-rate denominator mid-year", () => {
    const w = capYearWindow("FY2026");
    expect(elapsedFraction(w, "2026-09-30")).toBe(1);
    // Oct1 → Mar31 inclusive = 182 days of 365.
    expect(round4(elapsedFraction(w, "2026-03-31"))).toBe(round4(182 / 365));
  });
});

describe("money kernels (§2.3 cents)", () => {
  it("rounds half-away-from-zero, symmetric on sign", () => {
    expect(roundCents(100.5)).toBe(101);
    expect(roundCents(-100.5)).toBe(-101);
  });
  it("ratio is 0 (not NaN) on a zero denominator", () => {
    expect(ratio(5, 0)).toBe(0);
  });
  it("round4 trims to the numeric(7,4) grain; asPercent renders 2-decimal percent", () => {
    expect(round4(0.951234)).toBe(0.9512);
    expect(asPercent(0.9512)).toBe(95.12);
  });
});

describe("threshold bands (D7)", () => {
  it("aggregate bands at 90 / 95 / 100", () => {
    expect(aggregateBand(0.899)).toBe("safe");
    expect(aggregateBand(0.9)).toBe("watch_90");
    expect(aggregateBand(0.95)).toBe("warn_95");
    expect(aggregateBand(0.9999)).toBe("warn_95");
    expect(aggregateBand(1.0)).toBe("breach_100");
    expect(aggregateBand(1.5)).toBe("breach_100");
  });
  it("inpatient bands flank the 20% rule at 18 / 20", () => {
    expect(inpatientBand(0.1799)).toBe("inpatient_safe");
    expect(inpatientBand(0.18)).toBe("inpatient_watch_18");
    expect(inpatientBand(0.1999)).toBe("inpatient_watch_18");
    expect(inpatientBand(0.2)).toBe("inpatient_breach_20");
  });
  it("tenant tightening lowers the trigger (never loosens)", () => {
    expect(aggregateBand(0.85, { watch: 0.8, warn: 0.9, breach: 0.95 })).toBe("watch_90");
  });
  it("escalation/resolution use the per-family rank", () => {
    expect(isEscalation("safe", "warn_95")).toBe(true);
    expect(isEscalation("warn_95", "watch_90")).toBe(false);
    expect(isResolution("warn_95", "safe")).toBe(true);
    expect(isResolution("safe", "safe")).toBe(false);
    expect(bandRank("breach_100")).toBe(3);
    expect(safeBandFor("inpatient")).toBe("inpatient_safe");
  });
});
