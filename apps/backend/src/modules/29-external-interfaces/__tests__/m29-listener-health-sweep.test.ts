// GAP-043 — the §4.11.5 listener-down detector is actually driven: a silent feed whose listener is not serving
// trips OPEN, persists health, and dispatches the critical M36 `external_feed.listener_down` alert.
import { describe, expect, it, vi } from "vitest";

import { LISTENER_DOWN_THRESHOLD_FLOOR_MS } from "../listener/circuit-breaker";
import {
  type FeedHealthRecord,
  type FeedHealthSnapshot,
  hourBucketOf,
  runFeedHealthTick,
} from "../listener/health-sweep";
import type { SupervisorAlert, SupervisorFeedDescriptor } from "../listener/supervisor";

const NOW = new Date("2026-10-08T12:20:00.000Z");
const FEED: SupervisorFeedDescriptor = {
  id: "feed-1",
  organizationId: "org-1",
  kind: "adt_inbound",
  displayName: "Mercy ADT",
  port: 6000,
  protocol: "mllp_tls",
  status: "active",
  baaContractRef: "baa-1",
  sendingFacilityAllowlist: [],
};

function harness(opts: {
  snapshot: FeedHealthSnapshot;
  bound: boolean;
  watcherOwnsListenerDown?: boolean;
}) {
  const records: FeedHealthRecord[] = [];
  const heartbeats: { bound: boolean; at: Date }[] = [];
  const alerts: SupervisorAlert[] = [];
  const log = vi.fn();
  const deps = {
    feeds: async () => [FEED],
    isBound: () => opts.bound,
    store: {
      snapshot: async () => opts.snapshot,
      record: async (_f: SupervisorFeedDescriptor, r: FeedHealthRecord) => {
        records.push(r);
      },
      heartbeat: async (
        _f: SupervisorFeedDescriptor,
        fact: { readonly bound: boolean; readonly at: Date },
      ) => {
        heartbeats.push({ bound: fact.bound, at: fact.at });
      },
    },
    ...(opts.watcherOwnsListenerDown === undefined
      ? {}
      : { watcherOwnsListenerDown: opts.watcherOwnsListenerDown }),
    dispatchAlert: async (a: SupervisorAlert) => {
      alerts.push(a);
    },
    now: () => NOW,
    log,
  };
  return { deps, records, alerts, log, heartbeats };
}

const SILENT_MS = NOW.getTime() - LISTENER_DOWN_THRESHOLD_FLOOR_MS - 60_000;

describe("runFeedHealthTick", () => {
  it("trips OPEN, records down seconds and dispatches listener_down for a silent unbound feed", async () => {
    const h = harness({ snapshot: { state: "closed", lastFrameAtMs: SILENT_MS }, bound: false });
    const out = await runFeedHealthTick(h.deps, 30);
    expect(out.wentDown).toEqual(["feed-1"]);
    expect(h.records[0]).toMatchObject({
      state: "open",
      downSecondsDelta: 30,
      upSecondsDelta: 0,
      hourBucket: hourBucketOf(NOW),
    });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      kind: "external_feed.listener_down",
      severity: "critical",
      feedId: "feed-1",
      organizationId: "org-1",
    });
  });

  it("does not re-alert while the breaker stays OPEN", async () => {
    const h = harness({ snapshot: { state: "open", lastFrameAtMs: SILENT_MS }, bound: false });
    await runFeedHealthTick(h.deps, 30);
    expect(h.alerts).toHaveLength(0);
    expect(h.records[0]?.downSecondsDelta).toBe(30);
  });

  it("holds HALF_OPEN (no alert) for a silent feed whose listener is serving", async () => {
    const h = harness({ snapshot: { state: "closed", lastFrameAtMs: SILENT_MS }, bound: true });
    await runFeedHealthTick(h.deps, 30);
    expect(h.alerts).toHaveLength(0);
    expect(h.records[0]).toMatchObject({ state: "half_open", upSecondsDelta: 30 });
  });

  it("recovers (closed, up seconds, no alert) when a recent frame arrives after OPEN", async () => {
    const h = harness({
      snapshot: { state: "open", lastFrameAtMs: NOW.getTime() - 1_000 },
      bound: true,
    });
    const out = await runFeedHealthTick(h.deps, 30);
    expect(out.recovered).toEqual(["feed-1"]);
    expect(h.records[0]).toMatchObject({ state: "closed", upSecondsDelta: 30 });
    expect(h.alerts).toHaveLength(0);
  });

  it("leaves a heartbeat fact (bound or not) every tick - the watcher decides from it", async () => {
    const bound = harness({ snapshot: { state: "closed", lastFrameAtMs: SILENT_MS }, bound: true });
    await runFeedHealthTick(bound.deps, 30);
    expect(bound.heartbeats).toEqual([{ bound: true, at: NOW }]);
    const unbound = harness({
      snapshot: { state: "closed", lastFrameAtMs: SILENT_MS },
      bound: false,
    });
    await runFeedHealthTick(unbound.deps, 30);
    expect(unbound.heartbeats).toEqual([{ bound: false, at: NOW }]);
  });

  it("hands the page and the breaker state to the watcher when it owns listener_down", async () => {
    const h = harness({
      snapshot: { state: "closed", lastFrameAtMs: SILENT_MS },
      bound: false,
      watcherOwnsListenerDown: true,
    });
    const out = await runFeedHealthTick(h.deps, 30);
    expect(out.wentDown).toEqual(["feed-1"]); // still observed and reported in the summary
    expect(h.alerts).toHaveLength(0); // ... but NOT paged from here
    expect(h.records[0]).not.toHaveProperty("state"); // ... and the rollup state is left to the watcher
    expect(h.records[0]).toMatchObject({ downSecondsDelta: 30, upSecondsDelta: 0 });
    expect(h.heartbeats).toHaveLength(1); // the fact is still left behind
  });

  it("isolates a per-feed store failure and reports it", async () => {
    const h = harness({ snapshot: { state: "closed", lastFrameAtMs: null }, bound: false });
    h.deps.store.snapshot = async () => {
      throw new Error("db down");
    };
    const out = await runFeedHealthTick(h.deps, 30);
    expect(out.failed).toEqual(["feed-1"]);
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      "hl7.listener.health_tick_failed",
      expect.anything(),
    );
  });
});
