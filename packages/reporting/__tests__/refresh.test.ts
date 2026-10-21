// @chartwarden/reporting — three-tier MV-refresh WORKER + lag-probe UNIT TESTS (M33 §2.4–§2.6 / §4.8 / D2 / D14).
//
// PURE port-injected workers driven by in-memory recording fakes (the M34 `shred-worker.test.ts` template):
// a `makePorts()` factory builds the full port bundle over in-memory state + a `const calls: string[] = []`
// trail; assertions read the recorded trail. These suites NEVER touch a DB. They prove:
//   • the dispatcher resolves all three refresh tiers (nightly / incremental / on_demand) + the manual recover;
//   • the §2.6 debounce floors `now` to the window tick → an IDENTICAL idempotency jobId per
//     `(mv_key, requested_at_floor)` (a redelivered burst collapses onto one job);
//   • the refresh worker is idempotent — a redelivery the MV's `last_refreshed_at` already covers no-ops
//     (`already_fresh`) rather than re-refreshing;
//   • the singleton lag-probe crosses the 10-min freshness SLO (two-probe hysteresis) → emits `m33.lag.exceeded`
//     + flips the degraded-tile advisory.
import type { schema } from "@chartwarden/db";
import type { LagProbeState } from "@chartwarden/reporting";
import {
  INITIAL_LAG_PROBE_STATE,
  REPLICA_LAG_THRESHOLD_SECONDS,
  decideLagTransition,
  decideRefreshDispatch,
  dispatchMvRefresh,
  floorToDebounceTick,
  handleMvRefresh,
  mvRefreshJobId,
  runLagProbe,
} from "@chartwarden/reporting";
import { describe, expect, it } from "vitest";

const FIXED_NOW = new Date("2026-06-25T12:00:07.000Z");

function makeMeta(
  overrides: Partial<schema.MaterializedViewMetadata> = {},
): schema.MaterializedViewMetadata {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    mvKey: "mv_census",
    schemaName: "report_mv",
    refreshStrategy: "incremental",
    debounceWindowSeconds: 5,
    dependsOnMvKeys: [],
    outboxTopicsSubscribed: [],
    expectedFreshnessSeconds: 120,
    status: "active",
    lastRefreshedAt: null,
    lastRefreshDurationMs: null,
    refreshFailureCount: 0,
    ...overrides,
  };
}

// ── (1) the dispatcher resolves the three tiers ─────────────────────────────────────────────────────────────

function makeDispatcherPorts(meta: schema.MaterializedViewMetadata | null, now: Date) {
  const calls: string[] = [];
  const enqueued: { job: unknown; opts: { jobId: string; debounceMs: number } }[] = [];
  return {
    calls,
    enqueued,
    ports: {
      metadata: {
        findByKey: async (k: string) => {
          calls.push(`findByKey:${k}`);
          return meta;
        },
      },
      queue: {
        enqueue: async (job: unknown, opts: { jobId: string; debounceMs: number }) => {
          calls.push(`enqueue:${opts.jobId}`);
          enqueued.push({ job, opts });
          return { enqueued: true, jobId: opts.jobId };
        },
      },
      now: () => now,
    },
  };
}

describe("M33 §2.5 dispatcher — the three refresh tiers resolve to the right route", () => {
  it("nightly tier: a `nightly` MV under the nightly cron enqueues; an incremental event is `covered_by_nightly`", () => {
    const nightly = makeMeta({ refreshStrategy: "nightly", mvKey: "mv_nightly" });
    const enq = decideRefreshDispatch(
      nightly,
      { mvKey: "mv_nightly", triggerKind: "nightly_cron", organizationId: null },
      FIXED_NOW,
    );
    expect(enq.kind).toBe("enqueue");

    const covered = decideRefreshDispatch(
      nightly,
      { mvKey: "mv_nightly", triggerKind: "incremental_outbox", organizationId: null },
      FIXED_NOW,
    );
    expect(covered).toEqual({ kind: "skip", reason: "covered_by_nightly" });
  });

  it("incremental tier: an `incremental` MV under an outbox event enqueues; the nightly cron is a `strategy_mismatch`", () => {
    const inc = makeMeta({ refreshStrategy: "incremental" });
    const enq = decideRefreshDispatch(
      inc,
      { mvKey: "mv_census", triggerKind: "incremental_outbox", organizationId: null },
      FIXED_NOW,
    );
    expect(enq.kind).toBe("enqueue");

    const mismatch = decideRefreshDispatch(
      inc,
      { mvKey: "mv_census", triggerKind: "nightly_cron", organizationId: null },
      FIXED_NOW,
    );
    expect(mismatch).toEqual({ kind: "skip", reason: "strategy_mismatch" });
  });

  it("on_demand tier: NEVER queued — the read path populates the Valkey-cached tile (§2.5)", () => {
    const od = makeMeta({ refreshStrategy: "on_demand" });
    const fromTrigger = decideRefreshDispatch(
      od,
      { mvKey: "mv_census", triggerKind: "on_demand", organizationId: null },
      FIXED_NOW,
    );
    expect(fromTrigger).toEqual({ kind: "skip", reason: "on_demand_read_path" });

    const fromOutbox = decideRefreshDispatch(
      od,
      { mvKey: "mv_census", triggerKind: "incremental_outbox", organizationId: null },
      FIXED_NOW,
    );
    expect(fromOutbox).toEqual({ kind: "skip", reason: "on_demand_read_path" });
  });

  it("manual tier: `Refresh now` recovers even a SUSPENDED MV; an auto-trigger leaves it stale", () => {
    const suspended = makeMeta({ status: "suspended" });
    const manual = decideRefreshDispatch(
      suspended,
      { mvKey: "mv_census", triggerKind: "manual", organizationId: null },
      FIXED_NOW,
    );
    expect(manual.kind).toBe("enqueue");

    const auto = decideRefreshDispatch(
      suspended,
      { mvKey: "mv_census", triggerKind: "incremental_outbox", organizationId: null },
      FIXED_NOW,
    );
    expect(auto).toEqual({ kind: "skip", reason: "mv_suspended" });
  });

  it("a retired / unregistered MV is tolerated as a typed skip (never refreshed)", () => {
    expect(
      decideRefreshDispatch(
        null,
        { mvKey: "gone", triggerKind: "incremental_outbox", organizationId: null },
        FIXED_NOW,
      ),
    ).toEqual({ kind: "skip", reason: "mv_unregistered" });
    expect(
      decideRefreshDispatch(
        makeMeta({ status: "retired" }),
        { mvKey: "mv_census", triggerKind: "manual", organizationId: null },
        FIXED_NOW,
      ),
    ).toEqual({ kind: "skip", reason: "mv_retired" });
  });

  it("the port-injected `dispatchMvRefresh` reads metadata, enqueues, and returns the queue outcome", async () => {
    const { ports, calls } = makeDispatcherPorts(makeMeta(), FIXED_NOW);
    const result = await dispatchMvRefresh(
      { mvKey: "mv_census", triggerKind: "incremental_outbox", organizationId: null },
      ports,
    );
    expect(result.kind).toBe("enqueued");
    expect(calls.indexOf("findByKey:mv_census")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("enqueue:")),
    );
  });

  it("a SKIP never touches the queue", async () => {
    const { ports, calls } = makeDispatcherPorts(makeMeta({ status: "retired" }), FIXED_NOW);
    const result = await dispatchMvRefresh(
      { mvKey: "mv_census", triggerKind: "manual", organizationId: null },
      ports,
    );
    expect(result).toEqual({ kind: "skip", reason: "mv_retired" });
    expect(calls.some((c) => c.startsWith("enqueue:"))).toBe(false);
  });
});

// ── (2) §2.6 debounce floors to the window tick → idempotent jobId ───────────────────────────────────────────

describe("M33 §2.6 debounce — the window-tick floor makes the jobId idempotent per (mv_key, requested_at_floor)", () => {
  it("floors `now` to the most-recent debounce tick (a 5s window)", () => {
    // 12:00:07 with a 5s window floors to 12:00:05.
    expect(floorToDebounceTick(FIXED_NOW, 5).toISOString()).toBe("2026-06-25T12:00:05.000Z");
  });

  it("two requests inside ONE window collapse onto the SAME jobId; the next window mints a new one", () => {
    const a = floorToDebounceTick(new Date("2026-06-25T12:00:06.000Z"), 5);
    const b = floorToDebounceTick(new Date("2026-06-25T12:00:09.000Z"), 5);
    const c = floorToDebounceTick(new Date("2026-06-25T12:00:11.000Z"), 5);
    expect(mvRefreshJobId("mv_census", a)).toBe(mvRefreshJobId("mv_census", b)); // same window → dedup
    expect(mvRefreshJobId("mv_census", a)).not.toBe(mvRefreshJobId("mv_census", c)); // next window → new job
  });

  it("a misconfigured 0-window MV still floors deterministically (clamped to ≥1s)", () => {
    expect(floorToDebounceTick(FIXED_NOW, 0).toISOString()).toBe("2026-06-25T12:00:07.000Z");
  });

  it("the dispatched job carries the floored ISO instant + the derived jobId (the §2.6 dedup oracle)", async () => {
    const { ports, enqueued } = makeDispatcherPorts(
      makeMeta({ debounceWindowSeconds: 5 }),
      FIXED_NOW,
    );
    await dispatchMvRefresh(
      { mvKey: "mv_census", triggerKind: "incremental_outbox", organizationId: null },
      ports,
    );
    expect(enqueued).toHaveLength(1);
    const job = enqueued[0]!.job as { requestedAtFloor: string };
    expect(job.requestedAtFloor).toBe("2026-06-25T12:00:05.000Z");
    expect(enqueued[0]!.opts.jobId).toBe(
      mvRefreshJobId("mv_census", floorToDebounceTick(FIXED_NOW, 5)),
    );
  });
});

// ── (3) the refresh worker is idempotent on (mvKey, requestedAtFloor) ────────────────────────────────────────

function makeWorkerPorts(meta: schema.MaterializedViewMetadata | null) {
  const calls: string[] = [];
  const stamps: unknown[] = [];
  return {
    calls,
    stamps,
    ports: {
      metadataRead: {
        findByKey: async (k: string) => {
          calls.push(`findByKey:${k}`);
          return meta;
        },
      },
      metadataWrite: {
        stamp: async (mvKey: string, patch: unknown) => {
          calls.push(`stamp:${mvKey}`);
          stamps.push(patch);
        },
      },
      runs: {
        open: async () => {
          calls.push("runs.open");
          return { id: "run_1", startedAt: FIXED_NOW };
        },
        settle: async (_h: unknown, p: { status: string }) => {
          calls.push(`runs.settle:${p.status}`);
        },
      },
      exec: {
        refreshConcurrently: async () => {
          calls.push("exec.refreshConcurrently");
          return { rowsAffected: 99 };
        },
      },
      tileCache: {
        invalidateForMv: async () => {
          calls.push("tileCache.invalidateForMv");
          return 3;
        },
      },
      outbox: {
        emitRefreshSucceeded: async () => {
          calls.push("outbox.emitRefreshSucceeded");
        },
        emitRefreshFailed: async () => {
          calls.push("outbox.emitRefreshFailed");
        },
        emitRefreshExhausted: async () => {
          calls.push("outbox.emitRefreshExhausted");
        },
      },
      now: () => FIXED_NOW,
    },
  };
}

const REFRESH_JOB = {
  mvKey: "mv_census",
  triggerKind: "incremental_outbox" as const,
  organizationId: null,
  requestedAtFloor: "2026-06-25T12:00:05.000Z",
};

describe("M33 §2.6 refresh worker — idempotent on (mvKey, requestedAtFloor)", () => {
  it("returns `already_fresh` (NO refresh) when `last_refreshed_at >= requestedAtFloor` — a redelivered tick", async () => {
    const meta = makeMeta({ lastRefreshedAt: new Date("2026-06-25T12:00:06.000Z") }); // already past the floor
    const { ports, calls } = makeWorkerPorts(meta);
    const result = await handleMvRefresh(REFRESH_JOB, ports);
    expect(result.outcome).toBe("already_fresh");
    // The redelivery NEVER opens a run, executes the REFRESH, or emits — it is a pure no-op past the lookup.
    expect(calls).not.toContain("exec.refreshConcurrently");
    expect(calls).not.toContain("runs.open");
    expect(calls).not.toContain("outbox.emitRefreshSucceeded");
  });

  it("actually refreshes when the floor is NEWER than the last refresh (the window has advanced)", async () => {
    const meta = makeMeta({ lastRefreshedAt: new Date("2026-06-25T11:00:00.000Z") }); // stale
    const { ports, calls } = makeWorkerPorts(meta);
    const result = await handleMvRefresh(REFRESH_JOB, ports);
    expect(result.outcome).toBe("refreshed");
    // §2.4 order: open run → REFRESH on primary → settle succeeded → stamp telemetry → invalidate cache → emit.
    expect(calls.indexOf("exec.refreshConcurrently")).toBeGreaterThan(calls.indexOf("runs.open"));
    expect(calls.indexOf("outbox.emitRefreshSucceeded")).toBeGreaterThan(
      calls.indexOf("tileCache.invalidateForMv"),
    );
  });

  it("a retired MV is skipped without a refresh", async () => {
    const { ports, calls } = makeWorkerPorts(makeMeta({ status: "retired" }));
    const result = await handleMvRefresh(REFRESH_JOB, ports);
    expect(result.outcome).toBe("skipped");
    expect(calls).not.toContain("exec.refreshConcurrently");
  });
});

// ── (4) the lag probe crosses the 10-min threshold → m33.lag.exceeded ────────────────────────────────────────

function makeLagPorts(samples: readonly number[], now: Date = FIXED_NOW) {
  const emitted: { type: "exceeded" | "recovered"; payload: unknown }[] = [];
  const advisories: boolean[] = [];
  let state: LagProbeState = INITIAL_LAG_PROBE_STATE;
  let i = 0;
  const ports = {
    replication: {
      sampleMaxReplayLagSeconds: async () => samples[Math.min(i++, samples.length - 1)]!,
    },
    state: {
      load: async () => state,
      save: async (s: LagProbeState) => {
        state = s;
      },
    },
    advisory: {
      setAdvisory: async (active: boolean) => {
        advisories.push(active);
      },
    },
    outbox: {
      emitLagExceeded: async (payload: unknown) => {
        emitted.push({ type: "exceeded", payload });
      },
      emitLagRecovered: async (payload: unknown) => {
        emitted.push({ type: "recovered", payload });
      },
    },
    now: () => now,
  };
  return { ports, emitted, advisories, getState: () => state };
}

describe("M33 §2.4 / D14 lag probe — crossing the 10-min freshness SLO emits m33.lag.exceeded", () => {
  it("the threshold is 600s (10 min)", () => {
    expect(REPLICA_LAG_THRESHOLD_SECONDS).toBe(600);
  });

  it("a SINGLE over-threshold probe does NOT flap the banner (two-probe hysteresis)", async () => {
    const { ports, emitted, advisories } = makeLagPorts([700]);
    const report = await runLagProbe(ports);
    expect(report.transition).toBe("none");
    expect(emitted).toHaveLength(0);
    expect(advisories).toHaveLength(0);
  });

  it("TWO consecutive over-threshold probes confirm the breach → m33.lag.exceeded + advisory ON", async () => {
    const { ports, emitted, advisories } = makeLagPorts([700, 720]);
    const first = await runLagProbe(ports);
    expect(first.transition).toBe("none"); // streak = 1, not yet confirmed
    const second = await runLagProbe(ports);
    expect(second.transition).toBe("exceeded"); // streak = 2 → confirmed breach
    expect(emitted).toEqual([
      {
        type: "exceeded",
        payload: { lagSeconds: 720, threshold: 600, sampledAt: FIXED_NOW.toISOString() },
      },
    ]);
    expect(advisories).toEqual([true]); // the degraded-tile advisory flipped on
    expect(second.freshnessSeconds).toBe(720); // the tile badge reports the lag verbatim
  });

  it("the pure hysteresis core: exactly-at-threshold counts as UNDER (the SLO is `lag ≤ 600s`)", () => {
    const atThreshold = decideLagTransition({
      lagSeconds: 600,
      thresholdSeconds: 600,
      prior: {
        breached: true,
        consecutiveOver: 5,
        consecutiveUnder: 1,
        breachStartedAt: "2026-06-25T11:50:00.000Z",
      },
      now: FIXED_NOW,
    });
    expect(atThreshold.transition).toBe("recovered"); // 600 is under → second under-probe recovers
  });
});
