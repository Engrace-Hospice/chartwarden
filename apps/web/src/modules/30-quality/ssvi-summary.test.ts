// FY2027 SSVI panel reduction — points per metric, the total or its honest range, and the outlier verdict.
import { describe, expect, it } from "vitest";
import { SSVI_METRICS, type SsviMeasureRow, summarizeSsvi } from "./ssvi-summary";

type V = NonNullable<SsviMeasureRow["latestValue"]>;
const CURRENT_VERSION = new Map(SSVI_METRICS.map((m) => [m.code, m.version]));
// An empty `computeVersion` means "the version the panel expects for this metric" (stamped by `row`).
const val = (v: Partial<V>): V => ({
  numerator: 1,
  denominator: 10,
  rate: 0.1,
  thresholdMet: true,
  bandColor: "green",
  unavailableReason: null,
  computeVersion: "",
  ...v,
});
const row = (code: string, v: V | null): SsviMeasureRow => ({
  measureId: code,
  displayName: code,
  latestValue: v && { ...v, computeVersion: v.computeVersion || (CURRENT_VERSION.get(code) ?? "") },
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
  it("a row from an older calculator version is not scored under the old rule", () => {
    const rows = binary([1, 1, 1, 1, 1, 1, 1, 1]);
    const stale = row("ssvi_metric_03", { ...POINT, computeVersion: "0.1.0" });
    const s = summarizeSsvi([...rows.filter((r) => r.measureId !== "ssvi_metric_03"), stale]);
    expect(s.metrics[2]?.state).toBe("not_computed");
    expect(s.metrics[2]?.points).toBeNull();
    expect(s.flagged).toBe(7);
    expect(s.lowerBound).toBe(7);
  });

  it("a stored composite is not the headline while a metric beside it is stale", () => {
    const rows = binary([1, 1, 1, 1, 1, 1, 1, 1]).map((r) =>
      r.measureId === "ssvi_metric_03"
        ? row(r.measureId, { ...POINT, computeVersion: "0.1.0" })
        : r,
    );
    const composite = row("ssvi_composite", val({ numerator: 14, denominator: 16 }));
    const s = summarizeSsvi([...rows, row("ssvi_metric_09", val({ numerator: 5 })), composite]);
    expect(s.score).toBeNull(); // not the stored 14 (summed under the old cut)
    expect(s.lowerBound).toBe(12); // 7 current binary points + 5 spending
    expect(s.upperBound).toBe(13);
    expect(s.outlier).toBeNull(); // 12-13 straddles the cut: undetermined, not a stored "outlier"
  });

  it("with every metric known the stored composite is the headline", () => {
    const rows = [
      ...binary([1, 1, 1, 1, 1, 1, 1, 1]),
      row("ssvi_metric_09", val({ numerator: 6 })),
      row("ssvi_composite", val({ numerator: 14, denominator: 16 })),
    ];
    const s = summarizeSsvi(rows);
    expect(s.score).toBe(14);
    expect(s.outlier).toBe(true);
  });

  it("stale rows add nothing to the lower bound, so a verdict never rests on an old cut", () => {
    const rows = binary([1, 1, 1, 1, 0, 0, 0, 0]).map((r) =>
      r.measureId === "ssvi_metric_03" || r.measureId === "ssvi_metric_04"
        ? row(r.measureId, { ...POINT, computeVersion: "0.1.0" })
        : r,
    );
    const s = summarizeSsvi(rows);
    expect(s.lowerBound).toBe(2);
    expect(s.metrics[2]?.state).toBe("not_computed");
    expect(s.metrics[3]?.state).toBe("not_computed");
  });
});
