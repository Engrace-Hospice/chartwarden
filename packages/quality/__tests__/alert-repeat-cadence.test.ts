// GAP-049 - the M30 §4.9 repeat cadences: one table, origin-anchored bucket math, and the guard that the table and
// the human-readable `cadence` strings in alert-defs.ts cannot drift apart.
import { M30_REPEAT_CADENCES, qualityAlertCorrelationId, repeatBucket } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { M30_ALERTS, bandOf, decideThresholdBreach } from "../src";

const HOUR = 3_600_000;
const ORIGIN = new Date("2026-10-08T00:00:00Z");
const at = (ms: number) => new Date(ORIGIN.getTime() + ms);
const sentinel = M30_REPEAT_CADENCES.incident_sentinel;

describe("repeatBucket (origin-anchored)", () => {
  it("is bucket 0 - the original page - until the first interval elapses", () => {
    expect(repeatBucket(ORIGIN, at(0), sentinel)).toBe(0);
    expect(repeatBucket(ORIGIN, at(4 * HOUR - 1), sentinel)).toBe(0);
  });
  it("flips to bucket 1 exactly one interval after the ORIGIN, not at an epoch boundary", () => {
    expect(repeatBucket(ORIGIN, at(4 * HOUR), sentinel)).toBe(1);
    // an origin that is not aligned to a 4h epoch boundary still gets its repeat 4h later
    const unaligned = new Date("2026-10-08T01:13:00Z");
    expect(repeatBucket(unaligned, new Date("2026-10-08T05:12:59Z"), sentinel)).toBe(0);
    expect(repeatBucket(unaligned, new Date("2026-10-08T05:13:00Z"), sentinel)).toBe(1);
  });
  it("catches up to the CURRENT bucket after a missed run (never a burst)", () => {
    expect(repeatBucket(ORIGIN, at(4 * HOUR * 5 + 60_000), sentinel)).toBe(5);
  });
  it("is null before the origin", () => {
    expect(repeatBucket(ORIGIN, at(-1), sentinel)).toBeNull();
  });
  it("honours the ceiling: the threshold series stops after 90 days, the safety pages never do", () => {
    const threshold = M30_REPEAT_CADENCES.measure_threshold_breached;
    const day = 24 * HOUR;
    expect(repeatBucket(ORIGIN, at(90 * day), threshold)).toBe(12);
    expect(repeatBucket(ORIGIN, at(90 * day + 1), threshold)).toBeNull();
    expect(repeatBucket(ORIGIN, at(1000 * day), sentinel)).not.toBeNull();
    expect(
      repeatBucket(ORIGIN, at(1000 * day), M30_REPEAT_CADENCES.outbreak_detected),
    ).not.toBeNull();
  });
});

describe("qualityAlertCorrelationId", () => {
  it("leaves bucket 0 as the consumer's original id and suffixes the repeats", () => {
    expect(qualityAlertCorrelationId("m30.alerts.incident_sentinel", "abc")).toBe(
      "outbox:m30.alerts.incident_sentinel:abc",
    );
    expect(qualityAlertCorrelationId("m30.alerts.incident_sentinel", "abc", 3)).toBe(
      "outbox:m30.alerts.incident_sentinel:abc:r3",
    );
  });
});

describe("the cadence table matches the spec §4.9 text in alert-defs", () => {
  const defByType = (type: string) => Object.values(M30_ALERTS).find((d) => d.payloadType === type);
  const cases: [keyof typeof M30_REPEAT_CADENCES, RegExp][] = [
    ["incident_sentinel", /then 4h until triaged/],
    ["incident_abuse_allegation", /then 6h until triaged/],
    ["outbreak_detected", /then 12h until reviewed/],
    ["measure_threshold_breached", /every 7d until project chartered/],
  ];
  it.each(cases)("%s", (key, pattern) => {
    const cadence = M30_REPEAT_CADENCES[key];
    const def = defByType(cadence.alertType);
    expect(def?.cadence).toMatch(pattern);
    expect(def?.severity === "critical" ? "critical" : "warn").toBe(
      cadence.severity === "critical" ? "critical" : "warn",
    );
  });
  it("uses the spec intervals (abuse is 6h, not the sentinel's 4h)", () => {
    expect(M30_REPEAT_CADENCES.incident_sentinel.intervalMs).toBe(4 * HOUR);
    expect(M30_REPEAT_CADENCES.incident_abuse_allegation.intervalMs).toBe(6 * HOUR);
    expect(M30_REPEAT_CADENCES.outbreak_detected.intervalMs).toBe(12 * HOUR);
    expect(M30_REPEAT_CADENCES.measure_threshold_breached.intervalMs).toBe(7 * 24 * HOUR);
  });
});

describe("the persisted band (migration 1051)", () => {
  it("prefers the stored band over the lossy reconstruction", () => {
    expect(bandOf({ ratio: "0.6", thresholdMet: false, bandColor: "yellow" })).toBe("yellow");
    expect(bandOf({ ratio: "0.2", thresholdMet: false, bandColor: "red" })).toBe("red");
  });
  it("falls back to the old reading for a row that predates the column", () => {
    expect(bandOf({ ratio: null, thresholdMet: null })).toBe("insufficient_n");
    expect(bandOf({ ratio: "0.9", thresholdMet: true })).toBe("green");
    expect(bandOf({ ratio: "0.2", thresholdMet: false })).toBe("red");
  });
  it("a yellow -> red recompute IS a breach now (it read as red -> red, and was silent, before)", () => {
    const next = {
      bandColor: "red",
      thresholdValue: 0.8,
    } as Parameters<typeof decideThresholdBreach>[2];
    const priorYellow = { ratio: "0.6", thresholdMet: false, bandColor: "yellow" } as const;
    expect(decideThresholdBreach(priorYellow, bandOf(priorYellow), next)).toBe(true);
    const priorRed = { ratio: "0.2", thresholdMet: false, bandColor: "red" } as const;
    expect(decideThresholdBreach(priorRed, bandOf(priorRed), next)).toBe(false);
  });
});
