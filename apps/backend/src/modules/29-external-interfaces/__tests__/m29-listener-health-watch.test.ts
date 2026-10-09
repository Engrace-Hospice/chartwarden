// GAP-043 - the worker-role listener-health watcher: the decision matrix over the REAL pure transition table
// (`evaluateListenerCircuit`), the event rules on top of it, the run loop, the env switch, and the M36 consumer that turns
// the events into pages (that consumer is tested in the M36 module). No DB; the Drizzle store is proven live (gap-043-m29-listener-watch.live.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LISTENER_DOWN_THRESHOLD_FLOOR_MS } from "../listener/circuit-breaker";
import {
  type FeedWatchStore,
  HEARTBEAT_STALE_MS,
  type WatchTransition,
  type WatchedFeed,
  decideFeedWatch,
  needsTcpProbe,
  runFeedHealthWatch,
} from "../listener/health-watch";
import { resolveFeedHealthWatchConfig } from "../listener/health-watch-job";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SILENT = LISTENER_DOWN_THRESHOLD_FLOOR_MS + 60_000; // past the 5 minute default
const MINUTE = 60_000;

const feed = (over: Partial<WatchedFeed> = {}): WatchedFeed => ({
  feedId: "feed-1",
  organizationId: "org-1",
  port: 6000,
  activatedAt: ago(24 * 3_600_000),
  thresholdSeconds: null,
  expectedQuietWindows: null,
  heartbeatAt: ago(10_000),
  listenerBound: true,
  circuitState: "closed",
  outageOpenedAt: null,
  lastFrameAt: ago(SILENT),
  ...over,
});

const evaluated = (d: ReturnType<typeof decideFeedWatch>) => {
  if (d.kind !== "evaluated") throw new Error("expected an evaluated decision");
  return d;
};

describe("decideFeedWatch - the matrix (heartbeat x tcp x frame)", () => {
  it("a listener that DIED (heartbeat stale) with a silent feed trips OPEN and publishes listener_down", () => {
    const d = evaluated(
      decideFeedWatch(feed({ heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) }), false, NOW),
    );
    expect(d.state).toBe("open");
    expect(d.changed).toBe(true);
    expect(d.event?.name).toBe("m29.external_feed.listener_down");
    expect(d.event?.payload).toMatchObject({
      feedId: "feed-1",
      organizationId: "org-1",
      state: "open",
      heartbeatStale: true,
      tcpOk: false,
      outageOpenedAt: NOW.toISOString(),
    });
    expect(d.outageOpenedAt).toEqual(NOW);
  });

  it("a feed that never heartbeated is down once past its grace, not before", () => {
    const never = feed({
      heartbeatAt: null,
      listenerBound: false,
      activatedAt: ago(2 * LISTENER_DOWN_THRESHOLD_FLOOR_MS - 1),
    });
    expect(decideFeedWatch(never, false, NOW).kind).toBe("grace");
    const past = feed({
      heartbeatAt: null,
      listenerBound: false,
      activatedAt: ago(2 * LISTENER_DOWN_THRESHOLD_FLOOR_MS),
    });
    expect(evaluated(decideFeedWatch(past, false, NOW)).event?.name).toBe(
      "m29.external_feed.listener_down",
    );
  });

  it("a fresh heartbeat + bound + TCP up + silent partner stays HALF_OPEN with NO page", () => {
    const d = evaluated(decideFeedWatch(feed(), true, NOW));
    expect(d.state).toBe("half_open");
    expect(d.event).toBeNull();
    expect(d.outageOpenedAt).toBeNull();
  });

  it("a fresh heartbeat and bound but the TCP probe FAILS (wrong host / firewall) reads as down - loud, not silent", () => {
    const d = evaluated(decideFeedWatch(feed(), false, NOW));
    expect(d.state).toBe("open");
    expect(d.event?.name).toBe("m29.external_feed.listener_down");
    expect(d.event?.payload.tcpOk).toBe(false);
  });

  it("a fresh heartbeat but the listener reports the feed UNBOUND (BAA refusal, bind failure) with a reachable port is down", () => {
    // the port is reachable (another feed's server), but THIS feed is not bound: per-feed `bound` is authoritative
    const d = evaluated(decideFeedWatch(feed({ listenerBound: false }), true, NOW));
    expect(d.state).toBe("open");
  });

  it("a recent frame closes the breaker whatever the other facts say (frames flowing => serving)", () => {
    const d = evaluated(
      decideFeedWatch(
        feed({
          lastFrameAt: ago(10_000),
          heartbeatAt: null,
          circuitState: "closed",
          activatedAt: ago(10 * 86_400_000),
        }),
        false,
        NOW,
      ),
    );
    expect(d.state).toBe("closed");
    expect(d.event).toBeNull();
    expect(d.changed).toBe(false);
  });

  it("an expected quiet window suppresses the page", () => {
    const quiet = feed({
      heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000),
      expectedQuietWindows: [{ days: [4], start: "11:00", end: "13:00", tz: "UTC" }], // 2026-10-08 is a Thursday
    });
    expect(needsTcpProbe(quiet, NOW)).toBe(false);
    const d = evaluated(decideFeedWatch(quiet, null, NOW));
    expect(d.state).toBe("closed");
    expect(d.event).toBeNull();
  });

  it("a tenant can tighten the threshold to 60s: a 2 minute silence trips down only with the tighter threshold", () => {
    const base = { heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000), lastFrameAt: ago(2 * MINUTE) };
    expect(evaluated(decideFeedWatch(feed({ ...base }), false, NOW)).event).toBeNull();
    const tight = evaluated(decideFeedWatch(feed({ ...base, thresholdSeconds: 60 }), false, NOW));
    expect(tight.event?.name).toBe("m29.external_feed.listener_down");
  });
});

describe("decideFeedWatch - event rules", () => {
  const open = (over: Partial<WatchedFeed> = {}) =>
    feed({
      circuitState: "open",
      outageOpenedAt: ago(20 * MINUTE),
      heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000),
      ...over,
    });

  it("does not re-page while the outage stays open", () => {
    const d = evaluated(decideFeedWatch(open(), false, NOW));
    expect(d.state).toBe("open");
    expect(d.changed).toBe(false);
    expect(d.event).toBeNull();
  });

  it("open -> half_open (probe up again) keeps the outage; half_open -> open does NOT page a second time", () => {
    const back = evaluated(decideFeedWatch(open({ heartbeatAt: ago(5_000) }), true, NOW));
    expect(back.state).toBe("half_open");
    expect(back.event).toBeNull();
    expect(back.outageOpenedAt).toEqual(open().outageOpenedAt);
    const flap = evaluated(decideFeedWatch(open({ circuitState: "half_open" }), false, NOW));
    expect(flap.state).toBe("open");
    expect(flap.event).toBeNull(); // same outage, already paged
  });

  it("a frame after a PAGED outage publishes listener_recovered naming the outage it closes", () => {
    const f = open({ lastFrameAt: ago(5_000) });
    const d = evaluated(decideFeedWatch(f, true, NOW));
    expect(d.state).toBe("closed");
    expect(d.event?.name).toBe("m29.external_feed.listener_recovered");
    expect(d.event?.payload.outageOpenedAt).toBe(f.outageOpenedAt?.toISOString());
    expect(d.outageOpenedAt).toBeNull();
  });

  it("a quiet partner going closed -> half_open -> closed never announces a recovery nobody was paged for", () => {
    const quiet = feed({
      circuitState: "half_open",
      outageOpenedAt: null,
      lastFrameAt: ago(1_000),
    });
    const d = evaluated(decideFeedWatch(quiet, null, NOW));
    expect(d.state).toBe("closed");
    expect(d.changed).toBe(true);
    expect(d.event).toBeNull();
  });

  it("silence turning into an expected quiet window closes a paged outage with a recovery notice", () => {
    const f = open({
      expectedQuietWindows: [{ days: [4], start: "11:00", end: "13:00", tz: "UTC" }],
    });
    expect(evaluated(decideFeedWatch(f, null, NOW)).event?.name).toBe(
      "m29.external_feed.listener_recovered",
    );
  });

  it("is pure: the input feed is not mutated and a rerun gives the same answer", () => {
    const f = feed({ heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) });
    const frozen = JSON.stringify(f);
    const first = decideFeedWatch(f, false, NOW);
    expect(JSON.stringify(f)).toBe(frozen);
    expect(decideFeedWatch(f, false, NOW)).toEqual(first);
  });
});

describe("runFeedHealthWatch", () => {
  function harness(feedsByOrg: Record<string, WatchedFeed[] | Error>) {
    const applied: WatchTransition[] = [];
    const probed: [string, number][] = [];
    const log = vi.fn();
    const store: FeedWatchStore = {
      listWatchable: async (organizationId) => {
        const v = feedsByOrg[organizationId];
        if (v instanceof Error) throw v;
        return v ?? [];
      },
      applyTransition: async (t) => {
        applied.push(t);
      },
    };
    const deps = {
      activeOrgs: {
        listActiveOrgs: async () =>
          Object.keys(feedsByOrg).map((organizationId) => ({ organizationId })),
      },
      store,
      probeTcp: async (host: string, port: number) => {
        probed.push([host, port]);
        return false;
      },
      probeHost: "listener.internal",
      now: () => NOW,
      log,
    };
    return { deps, applied, probed, log };
  }

  it("probes only silent feeds, at the configured host and the feed's own port, and persists a down transition", async () => {
    const h = harness({
      "org-1": [
        feed({ feedId: "silent", port: 6001, heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) }),
        feed({ feedId: "chatty", port: 6002, lastFrameAt: ago(5_000) }),
      ],
    });
    const out = await runFeedHealthWatch(h.deps);
    expect(h.probed).toEqual([["listener.internal", 6001]]);
    expect(out.wentDown).toEqual(["silent"]);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toMatchObject({
      state: "open",
      event: { name: "m29.external_feed.listener_down" },
    });
    expect(h.applied[0]?.feed.feedId).toBe("silent");
  });

  it("writes nothing for an unchanged feed and skips a feed in its grace period", async () => {
    const h = harness({
      "org-1": [
        feed({ feedId: "steady", lastFrameAt: ago(1_000) }),
        feed({ feedId: "new", heartbeatAt: null, activatedAt: ago(1_000) }),
      ],
    });
    const out = await runFeedHealthWatch(h.deps);
    expect(h.applied).toEqual([]);
    expect(out.evaluated).toBe(1);
  });

  it("a failing org or feed is counted and never stops the rest", async () => {
    const h = harness({
      "org-bad": new Error("rls"),
      "org-1": [feed({ feedId: "silent", heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) })],
    });
    const out = await runFeedHealthWatch(h.deps);
    expect(out.failed).toEqual(["org:org-bad"]);
    expect(out.wentDown).toEqual(["silent"]);
    expect(h.log).toHaveBeenCalledWith("warn", "hl7.listener.watch_org_failed", expect.anything());
  });

  it("records a failed transition without losing the other feeds", async () => {
    const h = harness({
      "org-1": [
        feed({ feedId: "a", heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) }),
        feed({ feedId: "b", heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) }),
      ],
    });
    const apply = h.deps.store.applyTransition;
    h.deps.store.applyTransition = async (t) => {
      if (t.feed.feedId === "a") throw new Error("db down");
      return apply(t);
    };
    const out = await runFeedHealthWatch(h.deps);
    expect(out.failed).toEqual(["a"]);
    expect(out.wentDown).toEqual(["b"]);
  });
});

describe("resolveFeedHealthWatchConfig", () => {
  it("is off unless M29_LISTENER_WATCH_ENABLED=true", () => {
    expect(resolveFeedHealthWatchConfig({})).toEqual({ enabled: false });
    expect(resolveFeedHealthWatchConfig({ M29_LISTENER_WATCH_ENABLED: "false" })).toEqual({
      enabled: false,
    });
  });
  it("requires the probe host when on - a watcher that cannot probe must not boot (the flag also silences the listener)", () => {
    expect(() => resolveFeedHealthWatchConfig({ M29_LISTENER_WATCH_ENABLED: "true" })).toThrow(
      /M29_LISTENER_PROBE_HOST/,
    );
    expect(() =>
      resolveFeedHealthWatchConfig({
        M29_LISTENER_WATCH_ENABLED: "true",
        M29_LISTENER_PROBE_HOST: "  ",
      }),
    ).toThrow(/M29_LISTENER_PROBE_HOST/);
    expect(
      resolveFeedHealthWatchConfig({
        M29_LISTENER_WATCH_ENABLED: "true",
        M29_LISTENER_PROBE_HOST: " listener.internal ",
      }),
    ).toEqual({ enabled: true, probeHost: "listener.internal" });
  });
});

describe("bound is not computing: the composition root wires every part", () => {
  const index = readFileSync(join(__dirname, "../../../index.ts"), "utf8");
  it("constructs the watcher worker with the real store, schedules it, and binds the M36 consumer", () => {
    for (const needle of [
      "resolveFeedHealthWatchConfig(process.env)",
      "registerM29FeedHealthWatchWorker(",
      "createDrizzleFeedWatchStore(",
      "scheduleM29FeedHealthWatchJob(",
      "buildM36FeedHealthAlertConsumer(",
      "watcherOwnsListenerDown:",
    ]) {
      expect(index, needle).toContain(needle);
    }
  });
  it("hands the page over only when the watcher is on, so no environment is left unpaged", () => {
    expect(index).toMatch(
      /watcherOwnsListenerDown:\s*resolveFeedHealthWatchConfig\(process\.env\)\.enabled/,
    );
  });
});
