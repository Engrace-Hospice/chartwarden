import type { DbClient } from "@chartwarden/db";
// GAP-056 — unit tests for the M18 §4.8 workers' pure pieces: the D9 spoof scorer, the retry backoff, the
// `retries_exhausted` machine edge, the aggregator-state config parser, the fail-closed ports and the consumers'
// payload validation. The DB-backed behaviour (sweep, prep, submitter, poller, spoof flag, cross-tenant) is
// `m18-evv-workers.live.test.ts`.
import { StateAggregatorRegistry, createDenySandataTransport } from "@chartwarden/evv-aggregators";
import { describe, expect, it } from "vitest";
import { transitionAggregatorSubmission } from "../src/modules/18-evv/domain/aggregator-submission";
import {
  adapterFor,
  createUnboundAggregatorCredentialStore,
  parseEvvAggregatorStateConfigs,
} from "../src/modules/18-evv/jobs/ports";
import { M18_SUBMIT_BACKOFF_BASE_MS, submitBackoffMs } from "../src/modules/18-evv/jobs/queues";
import {
  SPOOF_FLAG_THRESHOLD,
  buildM18SpoofDetectorConsumer,
  scoreSpoofSignals,
} from "../src/modules/18-evv/jobs/spoof-detector";
import { buildM18SubmissionPrepConsumer } from "../src/modules/18-evv/jobs/submission-prep";

const T0 = new Date("2026-10-05T12:00:00Z");
const minutesLater = (m: number) => new Date(T0.getTime() + m * 60_000);
const PORTLAND = { lat: 45.523, lng: -122.6789 };
const SEATTLE = { lat: 47.6062, lng: -122.3321 }; // ~233 km north

describe("scoreSpoofSignals (D9)", () => {
  it("flags an impossible jump from the previous event on speed alone", () => {
    const verdict = scoreSpoofSignals({
      event: { capturedAt: minutesLater(3), coords: SEATTLE, accuracyM: 12 },
      prior: { capturedAt: T0, coords: PORTLAND, accuracyM: 9 },
      recentAccuracies: [12, 9],
    });
    expect(verdict.signals).toEqual(["implausible_speed"]);
    expect(verdict.flagged).toBe(true);
  });

  it("does not flag a normal drive between two visits", () => {
    const verdict = scoreSpoofSignals({
      event: { capturedAt: minutesLater(40), coords: { lat: 45.56, lng: -122.65 }, accuracyM: 14 },
      prior: { capturedAt: T0, coords: PORTLAND, accuracyM: 9 },
      recentAccuracies: [14, 9, 22],
    });
    expect(verdict).toEqual({ signals: [], score: 0, flagged: false });
  });

  it("does not flag the same spot at the same instant (zero distance, zero interval)", () => {
    const verdict = scoreSpoofSignals({
      event: { capturedAt: T0, coords: PORTLAND, accuracyM: 8 },
      prior: { capturedAt: T0, coords: PORTLAND, accuracyM: 8 },
      recentAccuracies: [8, 8],
    });
    expect(verdict.flagged).toBe(false);
  });

  it("flags displacement over a zero interval", () => {
    const verdict = scoreSpoofSignals({
      event: { capturedAt: T0, coords: SEATTLE, accuracyM: 8 },
      prior: { capturedAt: T0, coords: PORTLAND, accuracyM: 9 },
      recentAccuracies: [],
    });
    expect(verdict.signals).toContain("implausible_speed");
  });

  it("needs BOTH soft signals together (precise GPS + constant accuracy) to flag", () => {
    const soft = scoreSpoofSignals({
      event: { capturedAt: T0, coords: PORTLAND, accuracyM: 0.5 },
      prior: null,
      recentAccuracies: [0.5, 12, 30],
    });
    expect(soft.signals).toEqual(["implausibly_precise_gps"]);
    expect(soft.score).toBeLessThan(SPOOF_FLAG_THRESHOLD);
    expect(soft.flagged).toBe(false);

    const both = scoreSpoofSignals({
      event: { capturedAt: T0, coords: PORTLAND, accuracyM: 0.5 },
      prior: null,
      recentAccuracies: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    });
    expect(both.signals).toEqual(["implausibly_precise_gps", "constant_accuracy_pattern"]);
    expect(both.flagged).toBe(true);
  });

  it("ignores a constant-accuracy run shorter than the minimum window", () => {
    const verdict = scoreSpoofSignals({
      event: { capturedAt: T0, coords: PORTLAND, accuracyM: 5 },
      prior: null,
      recentAccuracies: [5, 5, 5],
    });
    expect(verdict.signals).toEqual([]);
  });

  it("skips the speed signal when either coordinate is undecodable", () => {
    const verdict = scoreSpoofSignals({
      event: { capturedAt: minutesLater(1), coords: null, accuracyM: 9 },
      prior: { capturedAt: T0, coords: PORTLAND, accuracyM: 9 },
      recentAccuracies: [],
    });
    expect(verdict.signals).toEqual([]);
  });
});

describe("aggregator submitter retry policy", () => {
  it("backs off exponentially from the base and caps at one hour", () => {
    expect(submitBackoffMs(1)).toBe(M18_SUBMIT_BACKOFF_BASE_MS);
    expect(submitBackoffMs(2)).toBe(2 * M18_SUBMIT_BACKOFF_BASE_MS);
    expect(submitBackoffMs(3)).toBe(4 * M18_SUBMIT_BACKOFF_BASE_MS);
    expect(submitBackoffMs(30)).toBe(60 * 60 * 1000);
  });

  it("lands an exhausted submission in timeout with the critical timeout effects", () => {
    const t = transitionAggregatorSubmission("submitting", { type: "retries_exhausted" });
    expect(t.status).toBe("timeout");
    expect(t.effects).toContainEqual({ kind: "outbox", event: "m18.evv.aggregator_timeout" });
    expect(t.effects).toContainEqual({ kind: "alert", alert: "aggregator_timeout" });
  });

  it("refuses retries_exhausted from any status but submitting", () => {
    expect(() => transitionAggregatorSubmission("queued", { type: "retries_exhausted" })).toThrow();
    expect(() =>
      transitionAggregatorSubmission("submitted", { type: "retries_exhausted" }),
    ).toThrow();
  });
});

describe("EVV_AGGREGATOR_STATES parser", () => {
  it("treats absent/blank as no state requiring an aggregator", () => {
    expect(parseEvvAggregatorStateConfigs(undefined)).toEqual([]);
    expect(parseEvvAggregatorStateConfigs("  ")).toEqual([]);
  });

  it("parses a valid list", () => {
    const raw = JSON.stringify([
      { stateCode: "TX", aggregatorVendor: "sandata", operatingModel: "closed_single_vendor" },
      { stateCode: "OR", aggregatorVendor: "open_model", operatingModel: "open_no_aggregator" },
    ]);
    expect(parseEvvAggregatorStateConfigs(raw)).toHaveLength(2);
  });

  it.each([
    ["not json", "must be valid JSON"],
    ['{"a":1}', "must be a JSON array"],
    [
      JSON.stringify([
        { stateCode: "texas", aggregatorVendor: "x", operatingModel: "open_alt_evv" },
      ]),
      "stateCode",
    ],
    [
      JSON.stringify([{ stateCode: "TX", aggregatorVendor: "", operatingModel: "open_alt_evv" }]),
      "aggregatorVendor",
    ],
    [
      JSON.stringify([{ stateCode: "TX", aggregatorVendor: "x", operatingModel: "bogus" }]),
      "operatingModel",
    ],
  ])("rejects a malformed value loudly (%#)", (raw, message) => {
    expect(() => parseEvvAggregatorStateConfigs(raw)).toThrow(message);
  });
});

describe("fail-closed ports", () => {
  it("the deny Sandata transport never fabricates an acceptance", async () => {
    const t = createDenySandataTransport(() => T0);
    const creds = { providerEntityId: "pe", secrets: {} };
    const post = await t.post({ body: {}, idempotencyKey: "k", credentials: creds });
    expect(post.result).toBe("transport_failure");
    expect((await t.pollStatus({ transactionId: "x", credentials: creds })).result).toBe(
      "still_pending",
    );
    expect(await t.ping()).toBe(false);
  });

  it("the unbound credential store throws rather than returning empty secrets", async () => {
    await expect(
      createUnboundAggregatorCredentialStore().resolve({
        providerEntityId: "pe",
        vendor: "sandata",
        stateCode: "TX",
      }),
    ).rejects.toThrow(/not bound/);
  });

  it("adapterFor returns null for an open-model-no-aggregator or unconfigured state", () => {
    const registry = new StateAggregatorRegistry([
      { stateCode: "OR", aggregatorVendor: "open_model", operatingModel: "open_no_aggregator" },
    ]);
    expect(adapterFor(registry, "OR")).toBeNull();
    expect(adapterFor(registry, "ZZ")).toBeNull();
  });
});

describe("consumer payload validation", () => {
  const db = {} as DbClient; // never reached: validation throws first
  it("the prep consumer rejects a payload with no visitId / eventId", async () => {
    const consumer = buildM18SubmissionPrepConsumer({
      db,
      aggregator: {} as never,
    });
    await expect(consumer.handle({ organizationId: "o", payload: {} })).rejects.toThrow(/visitId/);
    await expect(
      consumer.handle({ organizationId: "o", payload: { visitId: "v" } }),
    ).rejects.toThrow(/eventId/);
  });

  it("the spoof consumer rejects a payload with no eventId", async () => {
    const consumer = buildM18SpoofDetectorConsumer({ db, outbox: { publish: async () => {} } });
    await expect(consumer.handle({ organizationId: "o", payload: {} })).rejects.toThrow(/eventId/);
  });

  it("both consumers are M18's and subscribe to the check-in/out events", () => {
    const prep = buildM18SubmissionPrepConsumer({ db, aggregator: {} as never });
    const spoof = buildM18SpoofDetectorConsumer({ db, outbox: { publish: async () => {} } });
    expect(prep.eventTypes).toEqual(["m18.evv.check_out_recorded"]);
    expect([...spoof.eventTypes]).toEqual([
      "m18.evv.check_in_recorded",
      "m18.evv.check_out_recorded",
    ]);
    expect(prep.consumerModule).toBe("m18");
    expect(spoof.consumerModule).toBe("m18");
  });
});
