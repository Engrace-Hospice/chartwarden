// FY2027 SSVI panel — the internal-estimate label, the range while metric 9 is not computable, and the badge.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SSVI_NOT_YET_COMPUTED, SsviPanel } from "./ssvi-panel";
import { SSVI_METRICS, type SsviMeasureRow } from "./ssvi-summary";

type V = NonNullable<SsviMeasureRow["latestValue"]>;
const v = (over: Partial<V>): V => ({
  numerator: 5,
  denominator: 10,
  rate: 0.5,
  thresholdMet: true,
  bandColor: "green",
  unavailableReason: null,
  computeVersion: "0.1.0",
  ...over,
});
const versionOf = (code: string) => SSVI_METRICS.find((m) => m.code === code)?.version ?? "0.1.0";
const rows = (m9: V, composite: V | null): SsviMeasureRow[] => [
  ...Array.from({ length: 8 }, (_, i) => {
    const measureId = `ssvi_metric_0${i + 1}`;
    const computeVersion = versionOf(measureId);
    return {
      measureId,
      displayName: "",
      latestValue:
        i < 5
          ? v({ thresholdMet: false, bandColor: "red", computeVersion })
          : v({ computeVersion }),
    };
  }),
  { measureId: "ssvi_metric_09", displayName: "", latestValue: m9 },
  { measureId: "ssvi_composite", displayName: "", latestValue: composite },
];

afterEach(() => cleanup());

describe("SsviPanel", () => {
  it("before any SSVI row exists, renders the section with a 'not yet computed' empty state", () => {
    render(<SsviPanel rows={[]} />);
    const section = screen.getByRole("region", { name: "Service and Spending Variation Index" });
    expect(within(section).getByText(SSVI_NOT_YET_COMPUTED)).toBeTruthy();
    expect(SSVI_NOT_YET_COMPUTED).toBe(
      "Not yet computed — SSVI (FY2027) appears after the quality worker's next run. Internal estimate; CMS publishes the official SSVI.",
    );
    expect(within(section).getByText("Not yet computed")).toBeTruthy();
    expect(within(section).getByText("SSVI score")).toBeTruthy();
    expect(within(section).queryByRole("table")).toBeNull();
    // Rows that are not SSVI rows do not count as SSVI data.
    cleanup();
    render(<SsviPanel rows={[{ measureId: "hvldl", displayName: "", latestValue: v({}) }]} />);
    expect(screen.getByText(SSVI_NOT_YET_COMPUTED)).toBeTruthy();
  });

  it("labels the estimate, shows a range and 'undetermined' while spending is not computable", () => {
    const unavailable = v({
      numerator: 0,
      denominator: 0,
      rate: null,
      thresholdMet: null,
      bandColor: "insufficient_n",
      unavailableReason: "Needs other providers' Medicare claims.",
    });
    render(<SsviPanel rows={rows(unavailable, unavailable)} />);
    const panel = screen.getByRole("region", { name: "Service and Spending Variation Index" });
    expect(
      within(panel).getByText(/Internal estimate — CMS publishes the official SSVI/),
    ).toBeTruthy();
    expect(within(panel).getByText("5–13")).toBeTruthy();
    expect(within(panel).getByText("5 to 13")).toBeTruthy(); // what a screen reader reads
    expect(within(panel).getByText("Outlier status undetermined")).toBeTruthy();
    expect(within(panel).getByText("5 / 8")).toBeTruthy();
    expect(within(panel).getAllByText("Not computable here").length).toBeGreaterThan(0);
  });

  it("shows the outlier badge at 13 or more", () => {
    render(
      <SsviPanel
        rows={rows(
          v({ numerator: 8, denominator: 8, thresholdMet: null }),
          v({ numerator: 13, denominator: 16, thresholdMet: false, bandColor: "red" }),
        )}
      />,
    );
    expect(screen.getByText("13 / 16")).toBeTruthy();
    expect(screen.getByText("Outlier (≥ 13)")).toBeTruthy();
  });
  it("is a level-2 heading, with each metric name as its row header and a rounding footnote", () => {
    const unavailable = v({
      numerator: 0,
      denominator: 0,
      rate: null,
      bandColor: "insufficient_n",
    });
    render(<SsviPanel rows={rows(unavailable, unavailable)} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Service and Spending Variation Index" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("rowheader", { name: /Last two RHC days of life with a skilled visit/ }),
    ).toBeTruthy();
    expect(screen.getByText(/decided on the unrounded rate/)).toBeTruthy();
  });

  it("shows a row stamped with an older calculator version as not computed", () => {
    const unavailable = v({
      numerator: 0,
      denominator: 0,
      rate: null,
      bandColor: "insufficient_n",
    });
    const all = rows(unavailable, unavailable).map((r) =>
      r.measureId === "ssvi_metric_03" && r.latestValue
        ? { ...r, latestValue: { ...r.latestValue, computeVersion: "0.1.0" } }
        : r,
    );
    render(<SsviPanel rows={all} />);
    expect(screen.getByText("Not computed")).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();
  });
});
