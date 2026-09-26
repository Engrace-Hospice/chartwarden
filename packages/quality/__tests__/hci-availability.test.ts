// packages/quality/__tests__/hci-availability.test.ts — F-042: the HCI indicators whose input a
// provider-side EHR structurally cannot assemble, and what the composite does about them.
//
// The behaviour under test is a DISTINCTION, not a computation: `insufficient_n` used to mean two
// unrelated things (a population under the CMS reportable floor, and an input that does not exist in a
// hospice's own record), and the second was reported as the first. Every assertion here is about keeping
// those two apart — in the result, in the persisted snapshot, and in the composite that reads them back.
import { describe, expect, it } from "vitest";
import {
  HCI_COMPOSITE_INCOMPLETE_REASON,
  HCI_THRESHOLDS_v2025,
  HCI_UNAVAILABLE_INDICATORS,
  HCI_UNAVAILABLE_MEASURE_CODES,
  type HciIndicatorKey,
  type MeasureComputationSnapshot,
  type QualityMeasureValueResult,
  computeHciIndicator05,
  computeHciIndicator06,
  computeHciIndicator07,
  computeHciScore,
  hciUnavailabilityFor,
  isDataUnavailable,
  ratioResult,
  unavailableReasonOf,
  unavailableResult,
} from "../src/index";

const BASE = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2025-07-01",
  periodEnd: "2026-07-01",
} as const;

const ALL_KEYS: readonly HciIndicatorKey[] = [
  "indicator_01",
  "indicator_02",
  "indicator_03",
  "indicator_04",
  "indicator_05",
  "indicator_06",
  "indicator_07",
  "indicator_08",
  "indicator_09",
  "indicator_10",
];

/** A met/unmet indicator result — the shape the composite reads back off the ledger. */
function met(thresholdMet: boolean): QualityMeasureValueResult {
  return ratioResult({
    numerator: thresholdMet ? 1 : 0,
    denominator: 1,
    threshold: { value: 1, direction: "gte" },
    snapshot: {},
  });
}

/** An indicator suppressed for LOW N — a real population that was too small, not an absent input. */
function lowN(): QualityMeasureValueResult {
  return ratioResult({
    numerator: 0,
    denominator: 0,
    threshold: { value: 1, direction: "gte" },
    snapshot: {},
  });
}

/** An indicator whose input the platform cannot assemble at all. */
function notComputable(): QualityMeasureValueResult {
  return unavailableResult({
    snapshot: { indicator: "hci_indicator_05" },
    unavailable: { reason: "no claims feed", requires: "a claims feed" },
  });
}

function indicators(
  build: (key: HciIndicatorKey) => QualityMeasureValueResult | null,
): Record<HciIndicatorKey, QualityMeasureValueResult | null> {
  const out = {} as Record<HciIndicatorKey, QualityMeasureValueResult | null>;
  for (const k of ALL_KEYS) out[k] = build(k);
  return out;
}

describe("the unavailable-result kernel (F-042)", () => {
  it("suppresses like insufficient_n but is distinguishable from it", () => {
    const unavailable = notComputable();
    const low = lowN();

    // Identical on the wire: both must show a blank rate rather than a fabricated zero.
    expect(unavailable.rate).toBeNull();
    expect(low.rate).toBeNull();
    expect(unavailable.bandColor).toBe("insufficient_n");
    expect(low.bandColor).toBe("insufficient_n");

    // Distinguishable in the one place that is persisted verbatim.
    expect(isDataUnavailable(unavailable)).toBe(true);
    expect(isDataUnavailable(low)).toBe(false);
  });

  it("carries the reason into the snapshot, where the value row keeps it", () => {
    const r = unavailableResult({
      snapshot: { indicator: "hci_indicator_07" },
      unavailable: { reason: "spend spans every provider", requires: "a claims feed" },
      threshold: HCI_THRESHOLDS_v2025.indicators.indicator_07,
    });
    expect(r.computationSnapshot.unavailableReason).toBe("spend spans every provider");
    expect(r.computationSnapshot.unavailableRequires).toBe("a claims feed");
    // The cut is still stated even though nothing was evaluated against it — a reader can see what the
    // measure WOULD have been judged by.
    expect(r.thresholdValue).toBe(HCI_THRESHOLDS_v2025.indicators.indicator_07.value);
    expect(r.thresholdMet).toBeNull();
  });

  it("reads the reason back off a persisted snapshot, and null off any other", () => {
    const snapshot = notComputable().computationSnapshot;
    expect(unavailableReasonOf(snapshot)).toBe("no claims feed");
    expect(unavailableReasonOf({} as MeasureComputationSnapshot)).toBeNull();
    expect(unavailableReasonOf(null)).toBeNull();
    // A snapshot that merely MENTIONS the key without the marker must not read as unavailable.
    expect(unavailableReasonOf({ unavailableReason: "spoofed" })).toBeNull();
  });
});

describe("HCI_UNAVAILABLE_INDICATORS — the declared absences", () => {
  it("declares exactly the three claims-file indicators", () => {
    expect([...HCI_UNAVAILABLE_MEASURE_CODES].sort()).toEqual([
      "hci_indicator_05",
      "hci_indicator_06",
      "hci_indicator_07",
    ]);
  });

  it("gives every entry a reason AND what would make it computable", () => {
    for (const [code, entry] of Object.entries(HCI_UNAVAILABLE_INDICATORS)) {
      expect(code).toBe(`hci_${entry.indicator}`);
      expect(ALL_KEYS).toContain(entry.indicator);
      // A declared absence with no stated remedy is the "TODO" this pattern exists to forbid.
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.requires.length).toBeGreaterThan(20);
    }
  });

  it("resolves by measure code, and answers null for a computable one", () => {
    expect(hciUnavailabilityFor("hci_indicator_06")?.indicator).toBe("indicator_06");
    expect(hciUnavailabilityFor("hci_indicator_08")).toBeNull();
    expect(hciUnavailabilityFor("hvldl")).toBeNull();
  });
});

describe("indicators 5/6/7 suppress with their reason rather than scoring 0/0", () => {
  const unavailable = {
    reason: "the hospital stay is another provider's",
    requires: "a claims feed",
  };

  it("indicator 5 — a 0/0 with no `unavailable` still reads as low N, not as un-computable", () => {
    const scored = computeHciIndicator05({
      ...BASE,
      totalDecedents: 0,
      type1BurdensomeTransitions: 0,
      threshold: HCI_THRESHOLDS_v2025.indicators.indicator_05,
    });
    expect(scored.bandColor).toBe("insufficient_n");
    expect(isDataUnavailable(scored)).toBe(false);
  });

  it.each([
    ["05", computeHciIndicator05, "hci_indicator_05"],
    ["06", computeHciIndicator06, "hci_indicator_06"],
    ["07", computeHciIndicator07, "hci_indicator_07"],
  ] as const)(
    "indicator %s suppresses with the reason when told it is unavailable",
    (_n, fn, code) => {
      const r = (fn as (i: never) => QualityMeasureValueResult)({
        ...BASE,
        totalDecedents: 0,
        type1BurdensomeTransitions: 0,
        type2BurdensomeTransitions: 0,
        totalMedicareSpend: 0,
        benchmarkSpend: 0,
        unavailable,
        threshold: HCI_THRESHOLDS_v2025.indicators.indicator_05,
      } as never);
      expect(isDataUnavailable(r)).toBe(true);
      expect(r.computationSnapshot.indicator).toBe(code);
      expect(r.computationSnapshot.unavailableReason).toBe(unavailable.reason);
      expect(r.rate).toBeNull();
      expect(r.thresholdMet).toBeNull();
    },
  );

  it("does not invent a numerator for an unavailable indicator", () => {
    // Even handed a non-zero population, an unavailable indicator reports nothing: the counts it was
    // given cannot be the CMS population, or the indicator would not be unavailable.
    const r = computeHciIndicator07({
      ...BASE,
      totalMedicareSpend: 900_000,
      benchmarkSpend: 1_000_000,
      unavailable,
      threshold: HCI_THRESHOLDS_v2025.indicators.indicator_07,
    });
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(0);
    expect(r.rate).toBeNull();
  });
});

describe("computeHciScore refuses to publish a partial composite (F-042)", () => {
  const thresholds = HCI_THRESHOLDS_v2025;

  it("scores normally when all ten contributed", () => {
    const r = computeHciScore({ indicators: indicators(() => met(true)), thresholds });
    expect(r.numerator).toBe(10);
    expect(r.rate).toBe(1);
    expect(r.bandColor).toBe("green");
    expect(isDataUnavailable(r)).toBe(false);
  });

  it("still counts a LOW-N indicator as not-met — a small population is a real answer", () => {
    const r = computeHciScore({
      indicators: indicators((k) => (k === "indicator_02" ? lowN() : met(true))),
      thresholds,
    });
    expect(r.numerator).toBe(9);
    expect(isDataUnavailable(r)).toBe(false);
  });

  it("suppresses — rather than scoring 9/10 — when ONE indicator is un-computable", () => {
    const r = computeHciScore({
      indicators: indicators((k) => (k === "indicator_05" ? notComputable() : met(true))),
      thresholds,
    });
    expect(isDataUnavailable(r)).toBe(true);
    expect(r.rate).toBeNull();
    expect(r.thresholdMet).toBeNull();
    expect(r.computationSnapshot.unavailableIndicators).toEqual(["indicator_05"]);
    expect(r.computationSnapshot.contributingIndicators).toBe(9);
    expect(r.computationSnapshot.unavailableReason).toBe(HCI_COMPOSITE_INCOMPLETE_REASON);
  });

  it("does NOT publish 7/10 for the shipped platform, which is the whole point", () => {
    // 5, 6 and 7 are structurally unavailable here, so the best a scoring composite could ever report is
    // 7 — which is exactly `compositeAboveAverageScore`. Scoring anyway would put every tenant on the
    // "above the national average" boundary as an artefact of what the platform cannot measure.
    const r = computeHciScore({
      indicators: indicators((k) =>
        HCI_UNAVAILABLE_MEASURE_CODES.has(`hci_${k}`) ? notComputable() : met(true),
      ),
      thresholds,
    });
    expect(thresholds.compositeAboveAverageScore).toBe(7);
    expect(r.rate).toBeNull();
    expect(r.thresholdMet).toBeNull();
    expect(r.computationSnapshot.unavailableIndicators).toEqual([
      "indicator_05",
      "indicator_06",
      "indicator_07",
    ]);
  });

  it("suppresses when an indicator has no computed value yet, and says which", () => {
    const r = computeHciScore({
      indicators: indicators((k) => (k === "indicator_10" ? null : met(true))),
      thresholds,
    });
    expect(isDataUnavailable(r)).toBe(true);
    expect(r.computationSnapshot.notYetComputedIndicators).toEqual(["indicator_10"]);
    expect(r.computationSnapshot.unavailableRequires).toContain("indicator_10");
  });

  it("keeps the per-indicator verdicts in the snapshot even when it refuses to score", () => {
    const r = computeHciScore({
      indicators: indicators((k) =>
        k === "indicator_05" ? notComputable() : met(k === "indicator_01"),
      ),
      thresholds,
    });
    const perIndicator = r.computationSnapshot.perIndicatorThresholdMet as Record<
      string,
      boolean | null
    >;
    expect(perIndicator.indicator_01).toBe(true);
    expect(perIndicator.indicator_02).toBe(false);
    // An indicator that could not contribute is null, NOT false — false would say "assessed and missed".
    expect(perIndicator.indicator_05).toBeNull();
  });
});
