// M25 milestone 5 — the TPE program tracker's pure rules: closed sets, the program edges, the per-MAC threshold
// lookup (no threshold is ever defaulted), the advisory claim-count rate, the interval and sample-size warnings,
// and the advisory referral-risk label.
import { describe, expect, it } from "vitest";
import {
  TPE_MAX_ROUNDS,
  TPE_MIN_INTERVAL_DAYS,
  TPE_SAMPLE_MAX,
  TPE_SAMPLE_MIN,
  canTransitionTpeProgram,
  claimCountErrorRate,
  intervalWarning,
  nextRoundEarliest,
  resolveTpeThreshold,
  sampleSizeWarning,
  tpeReferralRisk,
} from "../tpe";

describe("tpe constants", () => {
  it("carry the PRD's verified-basis numbers", () => {
    expect([TPE_MAX_ROUNDS, TPE_MIN_INTERVAL_DAYS, TPE_SAMPLE_MIN, TPE_SAMPLE_MAX]).toEqual([
      3, 45, 20, 40,
    ]);
  });
});

describe("tpe program edges", () => {
  it.each([
    ["active", "compliant", true],
    ["active", "referred", true],
    ["active", "closed", true],
    ["compliant", "closed", true],
    ["referred", "closed", true],
    ["compliant", "referred", false],
    ["referred", "active", false],
    ["closed", "active", false],
    ["closed", "closed", false],
    ["active", "active", false],
  ] as const)("%s -> %s is %s", (from, to, ok) => {
    expect(canTransitionTpeProgram(from, to)).toBe(ok);
  });
});

describe("resolveTpeThreshold", () => {
  const rule = (over: Record<string, unknown>) => ({
    macName: "CGS",
    exitErrorRatePct: 20,
    verifiedOn: null,
    sourceNote: null,
    effectiveFrom: "2026-01-01",
    ...over,
  });

  it("returns no threshold, never a default, when the organization has no rule", () => {
    expect(resolveTpeThreshold([], "CGS")).toEqual({
      pct: null,
      source: "none",
      verified: false,
      sourceNote: null,
    });
  });
  it("matches the MAC case-insensitively and trims", () => {
    expect(resolveTpeThreshold([rule({})], "  cgs ").pct).toBe(20);
  });
  it("ignores another MAC's rule", () => {
    expect(resolveTpeThreshold([rule({ macName: "NGS" })], "CGS").pct).toBeNull();
  });
  it("the newest rule in force wins and a future rule is ignored", () => {
    const rules = [
      rule({ exitErrorRatePct: 25, effectiveFrom: "2026-01-01" }),
      rule({ exitErrorRatePct: 15, effectiveFrom: "2026-06-01" }),
      rule({ exitErrorRatePct: 5, effectiveFrom: "2027-01-01" }),
    ];
    expect(resolveTpeThreshold(rules, "CGS", "2026-09-01").pct).toBe(15);
  });
  it("is verified only when someone recorded a verification day", () => {
    expect(resolveTpeThreshold([rule({})], "CGS").verified).toBe(false);
    expect(resolveTpeThreshold([rule({ verifiedOn: "2026-02-02" })], "CGS").verified).toBe(true);
  });
  it("keeps a zero threshold as a real number", () => {
    expect(resolveTpeThreshold([rule({ exitErrorRatePct: 0 })], "CGS").pct).toBe(0);
  });
});

describe("claimCountErrorRate", () => {
  it("is null when nothing has been reviewed", () => {
    expect(claimCountErrorRate([])).toBeNull();
    expect(claimCountErrorRate([{ result: "pending" }])).toBeNull();
  });
  it("excludes pending claims and rounds to two decimals", () => {
    const rate = claimCountErrorRate([
      { result: "error" },
      { result: "no_error" },
      { result: "no_error" },
      { result: "pending" },
    ]);
    expect(rate).toEqual({ reviewed: 3, errors: 1, pct: 33.33 });
  });
});

describe("interval and sample-size warnings", () => {
  it("the earliest next round is the education day plus 45 days", () => {
    expect(nextRoundEarliest("2026-01-01")).toBe("2026-02-15");
    expect(nextRoundEarliest(null)).toBeNull();
  });
  it("warns on a short gap, not on a long enough one or an unknown education day", () => {
    expect(intervalWarning("2026-01-01", "2026-02-14")).toMatch(/45/);
    expect(intervalWarning("2026-01-01", "2026-02-15")).toBeNull();
    expect(intervalWarning(null, "2026-01-02")).toBeNull();
  });
  it("warns on a sample outside 20 to 40 only", () => {
    expect(sampleSizeWarning(19)).toMatch(/20/);
    expect(sampleSizeWarning(41)).toMatch(/40/);
    expect(sampleSizeWarning(20)).toBeNull();
    expect(sampleSizeWarning(40)).toBeNull();
  });
});

describe("tpeReferralRisk", () => {
  const active = { state: "active", outcomeOn: null, referralKinds: [] as string[] };
  it("is unknown with no results yet", () => {
    expect(tpeReferralRisk(active, [{ roundNumber: 1, macResult: null }])).toBe("unknown");
    expect(tpeReferralRisk(active, [])).toBe("unknown");
  });
  it("is low when the latest round was compliant", () => {
    expect(
      tpeReferralRisk(active, [
        { roundNumber: 1, macResult: "non_compliant" },
        { roundNumber: 2, macResult: "compliant" },
      ]),
    ).toBe("low");
  });
  it("is elevated after a non-compliant round 1 or 2 and high after round 3", () => {
    expect(tpeReferralRisk(active, [{ roundNumber: 1, macResult: "non_compliant" }])).toBe(
      "elevated",
    );
    expect(tpeReferralRisk(active, [{ roundNumber: 2, macResult: "non_compliant" }])).toBe(
      "elevated",
    );
    expect(tpeReferralRisk(active, [{ roundNumber: 3, macResult: "non_compliant" }])).toBe("high");
  });
  it("uses the latest round that has a result, not the highest open round", () => {
    expect(
      tpeReferralRisk(active, [
        { roundNumber: 1, macResult: "non_compliant" },
        { roundNumber: 2, macResult: null },
      ]),
    ).toBe("elevated");
  });
  it("reports a recorded outcome over the rounds", () => {
    const rounds = [{ roundNumber: 3, macResult: "non_compliant" as const }];
    expect(tpeReferralRisk({ ...active, state: "referred", referralKinds: ["rac"] }, rounds)).toBe(
      "referred",
    );
    expect(
      tpeReferralRisk({ ...active, state: "compliant", outcomeOn: "2026-05-01" }, rounds),
    ).toBe("relief");
  });
  it("keeps the outcome after a program is closed", () => {
    expect(
      tpeReferralRisk({ state: "closed", outcomeOn: "2026-05-01", referralKinds: ["rac"] }, []),
    ).toBe("referred");
    expect(
      tpeReferralRisk({ state: "closed", outcomeOn: "2026-05-01", referralKinds: [] }, []),
    ).toBe("relief");
    expect(tpeReferralRisk({ state: "closed", outcomeOn: null, referralKinds: [] }, [])).toBe(
      "unknown",
    );
  });
});
