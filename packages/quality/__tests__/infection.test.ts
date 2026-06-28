// @wardenx/quality — M30 §7.8 / D11 (WF-18) infection outbreak-detector unit tests (PURE; no DB).
//
// Proves the ≥3-events-in-14-days cluster algorithm: a cluster OPENS exactly at the threshold (the third
// qualifying event within the rolling window) and NOT below it, the 14-day window is INCLUSIVE on its
// boundary, distinct (provider, pathogen, body-site) triples never merge, casing/whitespace code variants
// collapse into one cluster (normalization), and at most ONE case is emitted per cluster (detection fires
// on the third event; further growth is the worker's concern). PURE: a deterministic function over an
// event list — no clock, no DB.
import { describe, expect, it } from "vitest";
import { WardenXError } from "@wardenx/types";
import {
  OUTBREAK_MIN_EVENTS,
  OUTBREAK_WINDOW_DAYS,
  type NormalizedSurveillanceEvent,
  type RawSurveillanceObservation,
  detectOutbreakClusters,
  normalizeSurveillanceEvent,
  toNewOutbreakCase,
} from "@wardenx/quality";

const ORG = "org-1";
const PE = "pe-1";
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.parse("2025-03-01T00:00:00Z");

/** A surveillance event `dayOffset` days after the base instant, normalized into the detector's shape. */
function event(
  dayOffset: number,
  overrides: Partial<RawSurveillanceObservation> = {},
): NormalizedSurveillanceEvent {
  return normalizeSurveillanceEvent({
    id: `evt-${dayOffset}-${overrides.pathogen ?? "mrsa"}-${overrides.bodySite ?? "blood"}`,
    organizationId: ORG,
    providerEntityId: PE,
    pathogen: "mrsa",
    bodySite: "blood",
    observedAt: new Date(BASE + dayOffset * DAY_MS),
    ...overrides,
  });
}

describe("infection outbreak detector — the ≥3-events / 14-day cluster rule (§7.8 / WF-18)", () => {
  it("exports the D11 window + threshold constants the algorithm is keyed on", () => {
    expect(OUTBREAK_WINDOW_DAYS).toBe(14);
    expect(OUTBREAK_MIN_EVENTS).toBe(3);
  });

  it("does NOT open a cluster below the threshold (two events in-window ⇒ no detection)", () => {
    const detected = detectOutbreakClusters([event(0), event(1)]);
    expect(detected).toEqual([]);
  });

  it("opens a cluster AT the threshold: the third in-window event fires one 'open' case", () => {
    const detected = detectOutbreakClusters([event(0), event(5), event(10)]);
    expect(detected).toHaveLength(1);
    const cluster = detected[0];
    expect(cluster?.status).toBe("open");
    expect(cluster?.triggeringEventCount).toBe(OUTBREAK_MIN_EVENTS);
    expect(cluster?.providerEntityId).toBe(PE);
    expect(cluster?.pathogen).toBe("mrsa");
    expect(cluster?.bodySite).toBe("blood");
    // detection fires on the THIRD event: windowStart = earliest, windowEnd = the triggering (3rd) event.
    expect(cluster?.windowStart.getTime()).toBe(BASE);
    expect(cluster?.windowEnd.getTime()).toBe(BASE + 10 * DAY_MS);
  });

  it("the 14-day window is INCLUSIVE: events 0/7/14 days apart still cluster", () => {
    const detected = detectOutbreakClusters([event(0), event(7), event(14)]);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.windowEnd.getTime()).toBe(BASE + 14 * DAY_MS);
  });

  it("three events spanning MORE than 14 days do NOT cluster (window slides past the early event)", () => {
    // 0, 7, 15: at the 15-day event the window has slid to drop day 0 ⇒ only 2 in-window ⇒ no detection.
    const detected = detectOutbreakClusters([event(0), event(7), event(15)]);
    expect(detected).toEqual([]);
  });

  it("emits at most ONE case per cluster — extra in-window events do not open new cases", () => {
    const detected = detectOutbreakClusters([event(0), event(1), event(2), event(3), event(4)]);
    expect(detected).toHaveLength(1);
    // the case opens on the 3rd event (day 2), not on the later ones.
    expect(detected[0]?.windowEnd.getTime()).toBe(BASE + 2 * DAY_MS);
    expect(detected[0]?.triggeringEventCount).toBe(3);
  });

  it("handles unsorted input — the detector sorts each cluster by observation instant", () => {
    const detected = detectOutbreakClusters([event(10), event(0), event(5)]);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.windowStart.getTime()).toBe(BASE);
    expect(detected[0]?.windowEnd.getTime()).toBe(BASE + 10 * DAY_MS);
  });

  it("distinct (pathogen / body-site) triples never merge — 2+2 of two organisms ⇒ no cluster", () => {
    const detected = detectOutbreakClusters([
      event(0, { pathogen: "mrsa" }),
      event(1, { pathogen: "mrsa" }),
      event(2, { pathogen: "cdiff" }),
      event(3, { pathogen: "cdiff" }),
    ]);
    expect(detected).toEqual([]);
  });

  it("a different body-site is a different cluster key (same pathogen, split site ⇒ no cluster)", () => {
    const detected = detectOutbreakClusters([
      event(0, { bodySite: "blood" }),
      event(1, { bodySite: "blood" }),
      event(2, { bodySite: "urine" }),
    ]);
    expect(detected).toEqual([]);
  });

  it("normalization collapses casing/whitespace code variants into ONE cluster", () => {
    // "MRSA", "mrsa ", "  Mrsa  " all normalize to the same cluster key ⇒ a real 3-event cluster.
    const detected = detectOutbreakClusters([
      event(0, { pathogen: "MRSA" }),
      event(1, { pathogen: "mrsa " }),
      event(2, { pathogen: "  Mrsa  " }),
    ]);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.pathogen).toBe("mrsa");
  });

  it("orders multiple detected clusters by windowEnd ascending (detection order)", () => {
    const detected = detectOutbreakClusters([
      // cluster A (blood) reaches 3 at day 4; cluster B (urine) reaches 3 at day 2.
      event(0, { bodySite: "blood" }),
      event(2, { bodySite: "blood" }),
      event(4, { bodySite: "blood" }),
      event(0, { bodySite: "urine" }),
      event(1, { bodySite: "urine" }),
      event(2, { bodySite: "urine" }),
    ]);
    expect(detected).toHaveLength(2);
    expect(detected[0]?.bodySite).toBe("urine"); // windowEnd day 2 < day 4
    expect(detected[1]?.bodySite).toBe("blood");
    expect(detected[0]!.windowEnd.getTime()).toBeLessThanOrEqual(detected[1]!.windowEnd.getTime());
  });

  it("toNewOutbreakCase shapes a detected cluster into the frozen insert opening at 'open'", () => {
    const [cluster] = detectOutbreakClusters([event(0), event(1), event(2)]);
    expect(cluster).toBeDefined();
    const row = toNewOutbreakCase(cluster!);
    expect(row).toMatchObject({
      organizationId: ORG,
      providerEntityId: PE,
      pathogen: "mrsa",
      bodySite: "blood",
      triggeringEventCount: 3,
      status: "open",
    });
    expect(row.windowStart).toEqual(cluster!.windowStart);
    expect(row.windowEnd).toEqual(cluster!.windowEnd);
  });

  it("rejects a blank surveillance code at normalization (V-17 — a real observation always carries codes)", () => {
    expect(() => event(0, { pathogen: "   " })).toThrowError(WardenXError);
    expect(() => event(0, { bodySite: "" })).toThrowError(/non-empty code/);
  });
});
