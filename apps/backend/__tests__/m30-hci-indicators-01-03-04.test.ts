import {
  computeHciIndicator01,
  computeHciIndicator03,
  computeHciIndicator04,
} from "@chartwarden/quality";
// apps/backend/__tests__/m30-hci-indicators-01-03-04.test.ts — the three M6-only HCI indicators (no
// cross-module join needed, unlike HVLDL/HCI-10's M6×M8 combination).
//
// indicator 1 (CHC/GIP provided) reads M6's LevelOfCarePeriodReader; indicators 3/4 (early/late live
// discharges) both read the SAME M6 DischargeReader call (one aggregate covers both codes).
import { describe, expect, it } from "vitest";
import {
  resolveHciIndicator01Input,
  resolveHciLiveDischargeTimingInput,
} from "../src/modules/30-quality/jobs/m30-jobs";

const REQUEST = (code: string) => ({
  registration: { code } as never,
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
});

describe("HCI indicator 1 — Continuous Home Care or General Inpatient provided", () => {
  it("shapes M6's election-period × CHC/GIP coverage counts into the calculator input", async () => {
    const input = await resolveHciIndicator01Input(REQUEST("hci_indicator_01"), {
      levelOfCarePeriodReader: {
        async chcOrGipCoverageCounts() {
          return { numerator: 3, denominator: 20 };
        },
        async levelOfCareDaySpans() {
          throw new Error("not exercised by this indicator");
        },
        async electionPeriodSpans() {
          throw new Error("not exercised by this indicator");
        },
      },
    });
    expect(input).toMatchObject({ totalElectionPeriods: 20, periodsWithChcOrGipDay: 3 });
    expect(computeHciIndicator01(input as never).rate).toBeCloseTo(0.15);
  });

  it("a period with no election periods SUPPRESSES rather than scoring 0%", async () => {
    const input = await resolveHciIndicator01Input(REQUEST("hci_indicator_01"), {
      levelOfCarePeriodReader: {
        async chcOrGipCoverageCounts() {
          return { numerator: 0, denominator: 0 };
        },
        async levelOfCareDaySpans() {
          throw new Error("not exercised by this indicator");
        },
        async electionPeriodSpans() {
          throw new Error("not exercised by this indicator");
        },
      },
    });
    const result = computeHciIndicator01(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });
});

describe("HCI indicators 3/4 — Early / Late Live Discharges (one M6 aggregate, two calculators)", () => {
  const seams = {
    dischargeReader: {
      async liveDischargeTimingCounts() {
        return { totalDischarges: 50, earlyLiveDischarges: 4, lateLiveDischarges: 6 };
      },
    },
  };

  it("shapes the SAME aggregate into indicator 3's (early) calculator input", async () => {
    const input = await resolveHciLiveDischargeTimingInput(REQUEST("hci_indicator_03"), seams);
    expect(input).toMatchObject({ totalDischarges: 50, earlyLiveDischarges: 4 });
    expect(input).not.toHaveProperty("lateLiveDischarges");
    expect(computeHciIndicator03(input as never).rate).toBeCloseTo(4 / 50);
  });

  it("shapes the SAME aggregate into indicator 4's (late) calculator input", async () => {
    const input = await resolveHciLiveDischargeTimingInput(REQUEST("hci_indicator_04"), seams);
    expect(input).toMatchObject({ totalDischarges: 50, lateLiveDischarges: 6 });
    expect(input).not.toHaveProperty("earlyLiveDischarges");
    expect(computeHciIndicator04(input as never).rate).toBeCloseTo(6 / 50);
  });

  it("a period with no discharges SUPPRESSES both indicators rather than scoring 0%", async () => {
    const empty = {
      dischargeReader: {
        async liveDischargeTimingCounts() {
          return { totalDischarges: 0, earlyLiveDischarges: 0, lateLiveDischarges: 0 };
        },
      },
    };
    const early = await resolveHciLiveDischargeTimingInput(REQUEST("hci_indicator_03"), empty);
    const late = await resolveHciLiveDischargeTimingInput(REQUEST("hci_indicator_04"), empty);
    expect(computeHciIndicator03(early as never).bandColor).toBe("insufficient_n");
    expect(computeHciIndicator04(late as never).bandColor).toBe("insufficient_n");
  });
});
