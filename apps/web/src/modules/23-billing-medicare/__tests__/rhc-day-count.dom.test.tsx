import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RhcDayCount } from "../rhc-day-count";

describe("RhcDayCount (claim detail pricing)", () => {
  it("shows the high/low split and the earlier days carried, with their sources", () => {
    render(
      <RhcDayCount
        pricing={{
          rhcDays1to60: 3,
          rhcDays61Plus: 4,
          rhcCarryOver: {
            electionDate: "2025-11-01",
            priorDays: 57,
            chainDays: 57,
            basis: "hets_merged",
            startsAtDay: 58,
            highRateDaysRemaining: 3,
            daysSinceLastCare: 32,
            chain: [
              {
                source: "hets",
                kind: "benefit_period",
                start: "2025-08-01",
                end: "2025-09-15",
                endAssumed: false,
                countedDays: 46,
                hospiceNpi: "1649726464",
                ref: null,
              },
              {
                source: "internal",
                kind: "stay",
                start: "2025-09-20",
                end: "2025-09-30",
                endAssumed: false,
                countedDays: 11,
                hospiceNpi: null,
                ref: "adm-0",
              },
            ],
            warnings: [],
            hetsCheck: {
              checkId: "c",
              checkedAt: "2025-11-05T00:00:00.000Z",
              ageDays: 5,
              stale: false,
            },
          },
        }}
      />,
    );
    const card = screen.getByTestId("claim-rhc-day-count");
    expect(card.textContent).toMatch(/3 at the high rate \(days 1–60\), 4 at the low rate/);
    const carry = within(card).getByTestId("claim-rhc-carry-over");
    expect(within(carry).getByText("Other hospice (HETS, NPI 1649726464)")).toBeTruthy();
    expect(within(carry).getByText("46 days")).toBeTruthy();
    expect(within(carry).getByText("Our stay")).toBeTruthy();
  });

  it("says when a claim was priced before the carry-over was recorded", () => {
    render(<RhcDayCount pricing={{ rhcDays1to60: 7, rhcDays61Plus: 0, rhcCarryOver: null }} />);
    expect(screen.getByText(/priced before cross-hospice carry-over/)).toBeTruthy();
  });
});
