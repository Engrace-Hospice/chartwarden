// apps/backend/__tests__/m30-hope-resolveinput.test.ts — M30 measure-recompute HOPE-family input binding.
//
// Item 4 (#107): the `m30.measure_recompute` worker reaches ONE seam — `measureRecompute.data.resolveInput`
// — to shape each measure's calculator input. This test locks the four HOPE-family bindings the backend
// resolver `resolveHopeMeasureInput` (apps/backend/src/modules/30-quality/jobs/m30-jobs.ts) produces from the
// LIVE M10 `HopeOrgRollupProvider` org-rollup COUNTS (the one consumed seam, §4.4 / D6 aggregate-only):
//   • tfp_pi   ← j2051FollowUpRollup.painTriggers / painFollowUpsInWindow
//   • tfp_npsi ← j2051FollowUpRollup.nonPainTriggers / nonPainFollowUpsInWindow
//   • hope_sfv_on_time_rate           ← sfvTimelinessRollup.sfvDue / sfvOnTime
//   • hope_submission_acceptance_rate ← submissionPostureRollup.submissions / acceptedSubmissions
// Each shaped input is then fed through the REAL registered calculator (via buildMeasureRegistry) to assert a
// sane rate/band. A non-HOPE measure (hvldl) still FAILS CLOSED — the non-HOPE families consume the M5–M18
// read seams the integrator has not bound here yet.
import { buildMeasureRegistry } from "@wardenx/quality";
import type {
  HopeOrgRollupProvider,
  HopeRollupPeriod,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { resolveHopeMeasureInput } from "../src/modules/30-quality/jobs/m30-jobs";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PROVIDER = "a0000000-0000-4000-8000-000000000001";
const PERIOD_START = "2027-10-01T00:00:00.000Z";
const PERIOD_END = "2028-01-01T00:00:00.000Z";

const REGISTRY = buildMeasureRegistry();

function registrationFor(code: string) {
  const registration = REGISTRY.get(code);
  if (registration === undefined) throw new Error(`no registration for '${code}'`);
  return registration;
}

/** A recording fake M10 org-rollup consumer: returns seeded COUNTS and captures the call args. */
function fakeHope(
  rollups: {
    readonly j2051?: Awaited<ReturnType<HopeOrgRollupProvider["j2051FollowUpRollup"]>>;
    readonly sfv?: Awaited<ReturnType<HopeOrgRollupProvider["sfvTimelinessRollup"]>>;
    readonly submission?: Awaited<ReturnType<HopeOrgRollupProvider["submissionPostureRollup"]>>;
  },
): { hope: HopeOrgRollupProvider; calls: { org?: string; period?: HopeRollupPeriod } } {
  const calls: { org?: string; period?: HopeRollupPeriod } = {};
  const hope: HopeOrgRollupProvider = {
    async timepointCompletionRollup() {
      return { onTime: 0, late: 0 };
    },
    async submissionPostureRollup(org, period) {
      calls.org = org;
      calls.period = period;
      return rollups.submission ?? { submissions: 0, acceptedSubmissions: 0 };
    },
    async sfvTimelinessRollup(org, period) {
      calls.org = org;
      calls.period = period;
      return rollups.sfv ?? { sfvDue: 0, sfvOnTime: 0 };
    },
    async j2051FollowUpRollup(org, period) {
      calls.org = org;
      calls.period = period;
      return (
        rollups.j2051 ?? {
          painTriggers: 0,
          painFollowUpsInWindow: 0,
          nonPainTriggers: 0,
          nonPainFollowUpsInWindow: 0,
        }
      );
    },
    async openSfvObligationCount() {
      return 0;
    },
  };
  return { hope, calls };
}

function request(code: string) {
  return {
    registration: registrationFor(code),
    organizationId: ORG,
    providerEntityId: PROVIDER,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  };
}

describe("resolveHopeMeasureInput — HOPE-family measure-input binding (#107)", () => {
  it("tfp_pi: shapes the j2051 PAIN counts and the real calculator bands green at-or-above threshold", async () => {
    const { hope, calls } = fakeHope({
      j2051: {
        painTriggers: 10,
        painFollowUpsInWindow: 9,
        nonPainTriggers: 8,
        nonPainFollowUpsInWindow: 4,
      },
    });
    const input = (await resolveHopeMeasureInput(request("tfp_pi"), { hope })) as {
      organizationId: string;
      providerEntityId: string;
      periodStart: string;
      periodEnd: string;
      qualifyingPainImpactTriggers: number;
      followUpVisitsWithinWindow: number;
      threshold: { value: number; direction: string };
    };

    // The aggregate-only COUNTS map onto the PAIN denominator/numerator (never the non-pain ones).
    expect(input.qualifyingPainImpactTriggers).toBe(10);
    expect(input.followUpVisitsWithinWindow).toBe(9);
    expect(input.threshold).toEqual({
      value: 0.9,
      direction: "gte",
      label: "timely SFV follow-up for pain impact (platform default)",
    });
    // The base ComputeMeasureInput rides through unchanged + the window maps onto HopeRollupPeriod.
    expect(input.organizationId).toBe(ORG);
    expect(input.providerEntityId).toBe(PROVIDER);
    expect(calls.org).toBe(ORG);
    expect(calls.period).toEqual({ from: PERIOD_START, to: PERIOD_END });

    const result = registrationFor("tfp_pi").calculator(input as never);
    expect(result.numerator).toBe(9);
    expect(result.denominator).toBe(10);
    expect(result.rate).toBeCloseTo(0.9, 10);
    expect(result.bandColor).toBe("green");
    expect(result.thresholdMet).toBe(true);
  });

  it("tfp_npsi: shapes the j2051 NON-PAIN counts and the real calculator bands red below threshold", async () => {
    const { hope } = fakeHope({
      j2051: {
        painTriggers: 10,
        painFollowUpsInWindow: 9,
        nonPainTriggers: 8,
        nonPainFollowUpsInWindow: 4,
      },
    });
    const input = (await resolveHopeMeasureInput(request("tfp_npsi"), { hope })) as {
      qualifyingNonPainImpactTriggers: number;
      followUpVisitsWithinWindow: number;
    };
    expect(input.qualifyingNonPainImpactTriggers).toBe(8);
    expect(input.followUpVisitsWithinWindow).toBe(4);

    const result = registrationFor("tfp_npsi").calculator(input as never);
    expect(result.numerator).toBe(4);
    expect(result.denominator).toBe(8);
    expect(result.rate).toBeCloseTo(0.5, 10);
    expect(result.bandColor).toBe("red");
    expect(result.thresholdMet).toBe(false);
  });

  it("hope_sfv_on_time_rate: shapes the SFV-timeliness counts and bands green above target", async () => {
    const { hope } = fakeHope({ sfv: { sfvDue: 20, sfvOnTime: 19 } });
    const input = (await resolveHopeMeasureInput(request("hope_sfv_on_time_rate"), { hope })) as {
      sfvDue: number;
      sfvOnTime: number;
    };
    expect(input.sfvDue).toBe(20);
    expect(input.sfvOnTime).toBe(19);

    const result = registrationFor("hope_sfv_on_time_rate").calculator(input as never);
    expect(result.numerator).toBe(19);
    expect(result.denominator).toBe(20);
    expect(result.rate).toBeCloseTo(0.95, 10);
    expect(result.bandColor).toBe("green");
  });

  it("hope_submission_acceptance_rate: shapes the posture counts and bands red below the APU floor", async () => {
    const { hope } = fakeHope({ submission: { submissions: 100, acceptedSubmissions: 85 } });
    const input = (await resolveHopeMeasureInput(request("hope_submission_acceptance_rate"), { hope })) as {
      submissions: number;
      acceptedSubmissions: number;
      threshold: { value: number };
    };
    expect(input.submissions).toBe(100);
    expect(input.acceptedSubmissions).toBe(85);
    expect(input.threshold.value).toBe(0.9); // the §1.3 CMS APU floor

    const result = registrationFor("hope_submission_acceptance_rate").calculator(input as never);
    expect(result.numerator).toBe(85);
    expect(result.denominator).toBe(100);
    expect(result.rate).toBeCloseTo(0.85, 10);
    expect(result.bandColor).toBe("red");
  });

  it("insufficient_n: a zero-denominator HOPE rollup yields a null-rate insufficient_n band", async () => {
    const { hope } = fakeHope({ sfv: { sfvDue: 0, sfvOnTime: 0 } });
    const input = await resolveHopeMeasureInput(request("hope_sfv_on_time_rate"), { hope });
    const result = registrationFor("hope_sfv_on_time_rate").calculator(input as never);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("non-HOPE measure (hvldl) fails closed — the non-HOPE families are not bound here", async () => {
    const { hope } = fakeHope({});
    await expect(resolveHopeMeasureInput(request("hvldl"), { hope })).rejects.toThrow(
      /measure-input provider bound for 'hvldl'/,
    );
  });
});
