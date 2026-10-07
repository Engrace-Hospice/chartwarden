// FY2027 SSVI panel — the internal-estimate label, the range while metric 9 is not computable, and the badge.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SsviPanel } from "./ssvi-panel";
import type { SsviMeasureRow } from "./ssvi-summary";

type V = NonNullable<SsviMeasureRow["latestValue"]>;
const v = (over: Partial<V>): V => ({
  numerator: 5,
  denominator: 10,
  rate: 0.5,
  thresholdMet: true,
  bandColor: "green",
  unavailableReason: null,
  ...over,
});
const rows = (m9: V, composite: V | null): SsviMeasureRow[] => [
  ...Array.from({ length: 8 }, (_, i) => ({
    measureId: `ssvi_metric_0${i + 1}`,
    displayName: "",
    latestValue: i < 5 ? v({ thresholdMet: false, bandColor: "red" }) : v({}),
  })),
  { measureId: "ssvi_metric_09", displayName: "", latestValue: m9 },
  { measureId: "ssvi_composite", displayName: "", latestValue: composite },
];

afterEach(() => cleanup());

describe("SsviPanel", () => {
  it("renders nothing before the family has any rows", () => {
    const { container } = render(<SsviPanel rows={[]} />);
    expect(container.textContent).toBe("");
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
});
