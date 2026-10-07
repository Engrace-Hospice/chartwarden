// FY2027 SSVI panel reduction — points per metric, the total or its honest range, and the outlier verdict.
import { describe, expect, it } from "vitest";
import { type SsviMeasureRow, summarizeSsvi } from "./ssvi-summary";

type V = NonNullable<SsviMeasureRow["latestValue"]>;
const val = (v: Partial<V>): V => ({
  numerator: 1,
  denominator: 10,
  rate: 0.1,
  thresholdMet: true,
  bandColor: "green",
  unavailableReason: null,
  ...v,
});
const row = (code: string, v: V | null): SsviMeasureRow => ({
  measureId: code,
  displayName: code,
  latestValue: v,
});
const POINT = val({ thresholdMet: false, bandColor: "red" });
const NONE = val({});
const UNAVAILABLE = val({
  numerator: 0,
  denominator: 0,
  rate: null,
  thresholdMet: null,
  bandColor: "insufficient_n",
  unavailableReason: "Needs other providers' claims",
});
const binary = (points: readonly (0 | 1)[]) =>
  points.map((p, i) => row(`ssvi_metric_0${i + 1}`, p ? POINT : NONE));

describe("summarizeSsvi", () => {
  it("is absent before FY2027 (no ssvi rows)", () => {
    expect(summarizeSsvi([row("hci_composite", NONE)]).present).toBe(false);
  });

  it("scores the binary metrics and shows a RANGE while metric 9 is not computable", () => {
    const s = summarizeSsvi([
      ...binary([1, 1, 0, 1, 0, 0, 0, 0]),
      row("ssvi_metric_09", UNAVAILABLE),
      row("ssvi_composite", UNAVAILABLE),
    ]);
    expect(s.flagged).toBe(3);
    expect(s.score).toBeNull();
    expect(s.lowerBound).toBe(3);
    expect(s.upperBound).toBe(11);
    expect(s.outlier).toBe(false); // even 8 spending points cannot reach 13
    expect(s.metrics[8]?.state).toBe("not_computable");
  });

  it("an outlier is decided once the lower bound alone reaches 13 — impossible without metric 9, so undetermined", () => {
    const s = summarizeSsvi([
      ...binary([1, 1, 1, 1, 1, 1, 1, 1]),
      row("ssvi_metric_09", UNAVAILABLE),
    ]);
    expect(s.lowerBound).toBe(8);
    expect(s.upperBound).toBe(16);
    expect(s.outlier).toBeNull();
  });

  it("uses the persisted composite when all nine contributed; 13 is an outlier", () => {
    const s = summarizeSsvi([
      ...binary([1, 1, 1, 1, 1, 0, 0, 0]),
      row("ssvi_metric_09", val({ numerator: 8, denominator: 8, thresholdMet: null })),
      row("ssvi_composite", val({ numerator: 13, denominator: 16, thresholdMet: false })),
    ]);
    expect(s.score).toBe(13);
    expect(s.outlier).toBe(true);
    expect(s.metrics[8]?.points).toBe(8);
  });

  it("a metric with no population earns no point; one not yet computed is unknown", () => {
    const s = summarizeSsvi([
      row("ssvi_metric_01", val({ denominator: 0, bandColor: "insufficient_n", rate: null })),
    ]);
    expect(s.metrics[0]?.state).toBe("low_n");
    expect(s.metrics[0]?.points).toBe(0);
    expect(s.metrics[1]?.state).toBe("not_computed");
    expect(s.metrics[1]?.points).toBeNull();
  });
});
