// apps/backend/__tests__/hope-org-rollup.test.ts — M10 ORG-LEVEL HopeOrgRollupProvider (#107). The seam is
// pure reduction over an injected HopeOrgRollupStore; these cover the four HOPE-family rollups + the
// point-in-time open-SFV count, the correctness-critical PAIN vs NON-PAIN J2051 split (an assessment with a
// qualifying pain entry only / a qualifying non-pain entry only / BOTH), the moderate-or-severe qualifying
// threshold (a `mild` entry never counts), the in/out-of-window SFV follow-up split, and the boot wiring
// (registerHopeSeams registers the real impl over the deny-stub when a store is present; without one the
// deny-stub denies loudly).
import { afterEach, describe, expect, it } from "vitest";
import type { HopeRollupPeriod, J2051Severity } from "@wardenx/types";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type J2051TriggerRow,
  createHopeOrgRollupProvider,
  createInMemoryHopeOrgRollupStore,
  registerHopeSeams,
} from "../src/modules/10-hope/index";

const ORG = "org-1";
const PERIOD: HopeRollupPeriod = { from: "2026-04-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" };

/** A J2051 trigger row with explicit entries + SFV due/completion timing. */
function trigger(
  entries: ReadonlyArray<{ readonly symptomCode: string; readonly severity: J2051Severity }>,
  sfv: { readonly dueAt: string | null; readonly completedAt: string | null },
): J2051TriggerRow {
  return { entries, sfvDueAt: sfv.dueAt, sfvCompletedAt: sfv.completedAt };
}

const IN_WINDOW = { dueAt: "2026-05-10T00:00:00.000Z", completedAt: "2026-05-09T00:00:00.000Z" };
const OUT_OF_WINDOW = { dueAt: "2026-05-10T00:00:00.000Z", completedAt: "2026-05-12T00:00:00.000Z" };
const NO_SFV = { dueAt: null, completedAt: null };

describe("HopeOrgRollupProvider — timepointCompletionRollup", () => {
  it("splits completed windows into on-time (signed ≤ deadline) and late", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({
      completedTimepoints: [
        { lateDeadlineAt: "2026-05-12T00:00:00.000Z", completingSignedAt: "2026-05-10T00:00:00.000Z" }, // on-time
        { lateDeadlineAt: "2026-05-12T00:00:00.000Z", completingSignedAt: "2026-05-12T00:00:00.000Z" }, // on-time (== boundary)
        { lateDeadlineAt: "2026-05-12T00:00:00.000Z", completingSignedAt: "2026-05-13T00:00:00.000Z" }, // late
        { lateDeadlineAt: "2026-05-12T00:00:00.000Z", completingSignedAt: null }, // late (no evidence)
      ],
    });
    const provider = createHopeOrgRollupProvider(store);
    expect(await provider.timepointCompletionRollup(ORG, PERIOD)).toEqual({ onTime: 2, late: 2 });
  });
});

describe("HopeOrgRollupProvider — submissionPostureRollup", () => {
  it("sums item + accepted counts across the period's batches", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({
      submissionBatches: [
        { itemCount: 10, acceptedCount: 9 },
        { itemCount: 5, acceptedCount: 5 },
      ],
    });
    const provider = createHopeOrgRollupProvider(store);
    expect(await provider.submissionPostureRollup(ORG, PERIOD)).toEqual({
      submissions: 15,
      acceptedSubmissions: 14,
    });
  });
});

describe("HopeOrgRollupProvider — sfvTimelinessRollup", () => {
  it("counts due SFVs and the subset completed within the window", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({
      terminalSfvs: [
        { dueAt: "2026-05-10T00:00:00.000Z", completedAt: "2026-05-09T00:00:00.000Z" }, // on-time
        { dueAt: "2026-05-10T00:00:00.000Z", completedAt: "2026-05-12T00:00:00.000Z" }, // late
        { dueAt: "2026-05-10T00:00:00.000Z", completedAt: null }, // missed
      ],
    });
    const provider = createHopeOrgRollupProvider(store);
    expect(await provider.sfvTimelinessRollup(ORG, PERIOD)).toEqual({ sfvDue: 3, sfvOnTime: 1 });
  });
});

describe("HopeOrgRollupProvider — j2051FollowUpRollup (pain/non-pain split)", () => {
  it("classifies pain-only, non-pain-only, both, and respects the moderate threshold + window", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({
      j2051Triggers: [
        // pain severe + anxiety MILD (anxiety does not qualify) → pain only; SFV in window.
        trigger(
          [
            { symptomCode: "pain", severity: "severe" },
            { symptomCode: "anxiety", severity: "mild" },
          ],
          IN_WINDOW,
        ),
        // pain MILD (does not qualify) + anxiety moderate → non-pain only; SFV out of window.
        trigger(
          [
            { symptomCode: "pain", severity: "mild" },
            { symptomCode: "anxiety", severity: "moderate" },
          ],
          OUT_OF_WINDOW,
        ),
        // pain moderate + nausea severe → BOTH; SFV in window (counts toward both numerators).
        trigger(
          [
            { symptomCode: "pain", severity: "moderate" },
            { symptomCode: "nausea_vomiting", severity: "severe" },
          ],
          IN_WINDOW,
        ),
        // pain severe, no SFV completed → pain trigger, not in window.
        trigger([{ symptomCode: "pain", severity: "severe" }], NO_SFV),
      ],
    });
    const provider = createHopeOrgRollupProvider(store);
    // pain triggers: rows 1,3,4 = 3 (row 2 pain is only mild). in-window pain: rows 1,3 = 2 (row 4 no SFV).
    // non-pain triggers: rows 2,3 = 2 (row 1 anxiety only mild; row 4 has no non-pain entry).
    // in-window non-pain: row 3 only = 1 (row 2 out of window).
    expect(await provider.j2051FollowUpRollup(ORG, PERIOD)).toEqual({
      painTriggers: 3,
      painFollowUpsInWindow: 2,
      nonPainTriggers: 2,
      nonPainFollowUpsInWindow: 1,
    });
  });

  it("treats a trigger row with no qualifying entry as neither pain nor non-pain", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({
      j2051Triggers: [trigger([{ symptomCode: "pain", severity: "mild" }], IN_WINDOW)],
    });
    const provider = createHopeOrgRollupProvider(store);
    expect(await provider.j2051FollowUpRollup(ORG, PERIOD)).toEqual({
      painTriggers: 0,
      painFollowUpsInWindow: 0,
      nonPainTriggers: 0,
      nonPainFollowUpsInWindow: 0,
    });
  });
});

describe("HopeOrgRollupProvider — openSfvObligationCount", () => {
  it("returns the seeded point-in-time open-obligation count", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({ openSfvObligations: 4 });
    const provider = createHopeOrgRollupProvider(store);
    expect(await provider.openSfvObligationCount(ORG)).toBe(4);
  });
});

describe("HopeOrgRollupProvider — boot wiring", () => {
  afterEach(() => __resetSeamsForTest());

  it("registerHopeSeams registers the real impl over the deny-stub when a store is present", async () => {
    const { store } = createInMemoryHopeOrgRollupStore({ openSfvObligations: 7 });
    registerHopeSeams({ orgRollupStore: store });
    validateSeams();
    expect(await getSeam("HopeOrgRollupProvider").openSfvObligationCount(ORG)).toBe(7);
  });

  it("falls through to the fail-closed deny-stub when no db/store is supplied", () => {
    registerHopeSeams({});
    validateSeams();
    expect(() => getSeam("HopeOrgRollupProvider").openSfvObligationCount(ORG)).toThrow();
  });
});
