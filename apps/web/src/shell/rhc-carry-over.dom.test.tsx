import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type RhcCarryOver, RhcCarryOverSummary, rhcCarryOverModel } from "./rhc-carry-over";

const fmt = (iso: string) => iso;
const carry = (over: Partial<RhcCarryOver> = {}): RhcCarryOver => ({
  electionDate: "2026-02-16",
  priorDays: 21,
  chainDays: 21,
  basis: "hets_merged",
  startsAtDay: 22,
  highRateDaysRemaining: 39,
  daysSinceLastCare: 17,
  chain: [
    {
      source: "hets",
      kind: "benefit_period",
      start: "2026-01-10",
      end: "2026-01-30",
      endAssumed: false,
      countedDays: 21,
      hospiceNpi: "1649726464",
      ref: null,
    },
  ],
  warnings: [],
  hetsCheck: { checkId: "c", checkedAt: "2026-02-10T00:00:00.000Z", ageDays: 6, stale: false },
  ...over,
});

describe("rhcCarryOverModel", () => {
  it("describes the carry, the source rows and the HETS check age", () => {
    const m = rhcCarryOverModel(carry(), fmt);
    expect(m.headline).toBe(
      "21 earlier hospice days carry over: this stay starts at RHC day 22, with 39 high-rate days left. HETS checked 2026-02-10 (6 days ago).",
    );
    expect(m.basisLabel).toBe("Our records + HETS");
    expect(m.rows).toEqual([
      {
        key: "hets-2026-01-10-0",
        source: "Other hospice (HETS, NPI 1649726464)",
        dates: "2026-01-10 – 2026-01-30",
        days: "21 days",
      },
    ]);
  });

  it("says no high-rate days are left at 60+ and labels a stale or internal-only basis", () => {
    const capped = rhcCarryOverModel(
      carry({ priorDays: 60, chainDays: 75, highRateDaysRemaining: 0, basis: "hets_stale" }),
      fmt,
    );
    expect(capped.headline).toMatch(/^75 earlier hospice days carry over: no high-rate/);
    expect(capped.basisTone).toBe("warning");
    const none = rhcCarryOverModel(
      carry({ priorDays: 0, chainDays: 0, chain: [], basis: "internal_only", hetsCheck: null }),
      fmt,
    );
    expect(none.headline).toBe(
      "No earlier hospice days carry over: the RHC day count starts at day 1.",
    );
    expect(none.basisLabel).toBe("Our records only");
  });

  it("marks an assumed end and an unbilled election", () => {
    const m = rhcCarryOverModel(
      carry({
        chain: [
          {
            source: "hets",
            kind: "election",
            start: "2026-02-01",
            end: "2026-02-15",
            endAssumed: true,
            countedDays: 15,
            hospiceNpi: null,
            ref: null,
          },
        ],
      }),
      fmt,
    );
    expect(m.rows[0]?.source).toBe("Other hospice (HETS), unbilled election");
    expect(m.rows[0]?.dates).toBe("2026-02-01 – 2026-02-15 (end assumed)");
  });

  it("labels a transfer-in's sending hospice span from our transfer record", () => {
    const m = rhcCarryOverModel(
      carry({
        chain: [
          {
            source: "internal",
            kind: "sending_hospice",
            start: "2026-01-01",
            end: "2026-03-09",
            endAssumed: false,
            countedDays: 68,
            hospiceNpi: "1234567893",
            ref: null,
          },
        ],
      }),
      fmt,
    );
    expect(m.rows[0]?.source).toBe("Sending hospice (transfer-in record, NPI 1234567893)");
  });
});

describe("rhcCarryOverModel — rows stored under the older span vocabulary", () => {
  it("labels an old internal 'stay' that carries a hospice NPI as the sending hospice (our stays never carry one)", () => {
    const m = rhcCarryOverModel(
      carry({
        chain: [
          {
            source: "internal",
            kind: "stay",
            start: "2026-01-01",
            end: "2026-02-09",
            endAssumed: false,
            countedDays: 40,
            hospiceNpi: "1234567893",
            ref: "adm-1",
          },
        ],
      }),
      fmt,
    );
    expect(m.rows[0]?.source).toBe("Sending hospice (transfer-in record, NPI 1234567893)");
  });

  it("still shows a carry-over whose basis or span kind it does not know", () => {
    const m = rhcCarryOverModel(
      carry({
        basis: "legacy_basis" as RhcCarryOver["basis"],
        chain: [
          {
            source: "internal",
            kind: "own_stay" as RhcCarryOver["chain"][number]["kind"],
            start: "2026-01-01",
            end: "2026-01-21",
            endAssumed: false,
            countedDays: 21,
            hospiceNpi: null,
            ref: "adm-1",
          },
        ],
      }),
      fmt,
    );
    expect(m.basisLabel).toBe("Basis not recorded");
    expect(m.basisTone).toBe("neutral");
    expect(m.rows[0]?.source).toBe("Our stay");
  });
});

describe("RhcCarryOverSummary", () => {
  it("renders the basis pill, the counted stays and the warnings", () => {
    render(
      <RhcCarryOverSummary
        carry={carry({ warnings: [{ code: "hets_stale", message: "The HETS check is stale." }] })}
        fmt={fmt}
      />,
    );
    expect(screen.getByText("Our records + HETS")).toBeTruthy();
    expect(
      screen.getByRole("rowheader", { name: "Other hospice (HETS, NPI 1649726464)" }),
    ).toBeTruthy();
    expect(screen.getByText("21 days")).toBeTruthy();
    expect(screen.getByText("The HETS check is stale.")).toBeTruthy();
  });
});
