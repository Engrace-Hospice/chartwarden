// apps/web/src/modules/30-quality/quality-status.test.ts — the measure-rate formatter (§6.6).
//
// HCI indicator 8's CMS value is a MEAN (skilled-nursing minutes per routine-home-care day), not a
// proportion; its wire `rate` is that mean ÷ 1440 so it fits the proportion contract. Rendered as a
// percentage it would read "1.0%" — so the hub shows it in CMS's own unit, from the exact
// numerator/denominator. Every other measure keeps the percentage.
import { describe, expect, it } from "vitest";
import { measureRate } from "./quality-status";

describe("measureRate", () => {
  it("shows HCI 8 as minutes per RHC day from numerator/denominator", () => {
    expect(
      measureRate("hci_indicator_08", {
        rate: 4520 / 300 / 1440,
        bandColor: "green",
        numerator: 4520,
        denominator: 300,
      }),
    ).toBe("15.1 min/day");
  });

  it("shows a suppressed HCI 8 as an em dash, not 0 minutes", () => {
    expect(
      measureRate("hci_indicator_08", {
        rate: null,
        bandColor: "insufficient_n",
        numerator: 0,
        denominator: 0,
      }),
    ).toBe("—");
  });

  it("keeps every other measure (including HCI 9's weekend share) as a percentage", () => {
    expect(
      measureRate("hci_indicator_09", {
        rate: 0.125,
        bandColor: "green",
        numerator: 120,
        denominator: 960,
      }),
    ).toBe("12.5%");
  });
});
