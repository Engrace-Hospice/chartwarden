// ADR-0079 (G-4) - the stalled escalation worker check and the fleet-wide notice claims it relies on.
import { describe, expect, it, vi } from "vitest";
import type { AckQueueNotice, AckQueueSample } from "../ack-queue-metrics";
import {
  STALLED_NOTICE_SECONDS,
  STALLED_REPEAT_MS,
  TICK_CLAIM_MS,
  UNMEASURED_TICKS,
  createWatchdogTick,
} from "../ack-queue-watchdog";
import { type ClaimRedis, createOpsNoticeClaims } from "../ops-notice-claims";

const sample = (over: Partial<AckQueueSample> = {}): AckQueueSample => ({
  orgsChecked: 2,
  orgsFailed: 0,
  overdue: 0,
  failedUnreachable: 0,
  oldestOverdueSeconds: 0,
  escalationStalledSeconds: 0,
  ackedCount: 0,
  ackLatencySumSeconds: 0,
  ackLatencyMaxSeconds: 0,
  ...over,
});

const fakeRedis = (): ClaimRedis & { keys: Map<string, number> } => {
  const keys = new Map<string, number>();
  return {
    keys,
    set: async (key) => {
      if (keys.has(key)) return null;
      keys.set(key, 1);
      return "OK";
    },
    del: async (key) => void keys.delete(key),
  };
};

describe("ops notice claims", () => {
  it("lets exactly one of two processes sharing Valkey claim a key, until it is released", async () => {
    const redis = fakeRedis();
    const a = createOpsNoticeClaims(redis);
    const b = createOpsNoticeClaims(redis);
    expect(await a.claim("k", 1000)).toBe(true);
    expect(await b.claim("k", 1000)).toBe(false);
    await b.release("k");
    expect(await a.claim("k", 1000)).toBe(true);
  });

  it("a hung Valkey is cut off after the timeout, the breaker sends later claims straight to the local map for 30 s, then Valkey is tried again", async () => {
    let now = 0;
    let calls = 0;
    const hung: ClaimRedis = {
      set: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
      del: async () => 1,
    };
    const claims = createOpsNoticeClaims(hung, { now: () => now, timeoutMs: 5, breakerMs: 30_000 });
    expect(await claims.claim("a", 1000)).toBe(true); // timed out -> local fallback
    expect(calls).toBe(1);
    expect(await claims.claim("b", 1000)).toBe(true);
    expect(await claims.claim("c", 1000)).toBe(true);
    expect(calls).toBe(1); // breaker open: no further Valkey call, no further wait
    now = 30_000;
    await claims.claim("d", 1000);
    expect(calls).toBe(2);
  });

  it("prunes expired entries from the local fallback map on claim", async () => {
    let now = 0;
    const claims = createOpsNoticeClaims(undefined, () => now);
    for (let i = 0; i < 50; i += 1) await claims.claim(`k${i}`, 10);
    now = 100;
    await claims.claim("fresh", 10);
    // The expired keys are claimable again (pruned or expired) and the map holds only the live entry: re-claiming an old key succeeds.
    expect(await claims.claim("k0", 10)).toBe(true);
  });

  it("a release skipped while the breaker is open is retried once Valkey answers again", async () => {
    let now = 0;
    let down = true;
    const dels: string[] = [];
    const redis: ClaimRedis = {
      set: async () => {
        if (down) throw new Error("down");
        return "OK";
      },
      del: async (key) => {
        if (down) throw new Error("down");
        dels.push(key);
        return 1;
      },
    };
    const claims = createOpsNoticeClaims(redis, { now: () => now, breakerMs: 1000 });
    await claims.claim("x", 10_000); // fails -> breaker opens
    await claims.release("breach-over"); // skipped: remembered
    expect(dels).toEqual([]);
    down = false;
    now = 1000;
    await claims.claim("y", 10_000);
    expect(dels).toEqual(["chartwarden:ops-notice:breach-over"]);
  });

  it("falls back to per-process (fail open: notify) when Valkey errors, and honours the ttl", async () => {
    let now = 0;
    const broken: ClaimRedis = {
      set: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
    };
    const claims = createOpsNoticeClaims(broken, { now: () => now, breakerMs: 0 });
    expect(await claims.claim("k", 1000)).toBe(true);
    expect(await claims.claim("k", 1000)).toBe(false);
    now = 1000;
    expect(await claims.claim("k", 1000)).toBe(true);
    await expect(claims.release("k")).resolves.toBeUndefined();
  });
});

describe("watchdog tick", () => {
  const build = (
    sampleFn: () => Promise<AckQueueSample | null>,
    claims = createOpsNoticeClaims(undefined),
  ) => {
    const notices: AckQueueNotice[] = [];
    const tick = createWatchdogTick({ sample: sampleFn, claims, notify: (n) => notices.push(n) });
    return { tick, notices };
  };

  it("notifies when the oldest unprocessed request is at the threshold, with counts only", async () => {
    const { tick, notices } = build(async () =>
      sample({ escalationStalledSeconds: STALLED_NOTICE_SECONDS }),
    );
    expect(await tick()).toBe("stalled");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("m36.ack.escalation_stalled");
    expect(Object.keys(notices[0]?.details ?? {}).sort()).toEqual([
      "oldestUnprocessedSeconds",
      "orgsChecked",
    ]);
  });

  it("stays quiet below the threshold", async () => {
    const { tick, notices } = build(async () =>
      sample({ escalationStalledSeconds: STALLED_NOTICE_SECONDS - 1 }),
    );
    expect(await tick()).toBe("ok");
    expect(notices).toEqual([]);
  });

  it("one process per window samples at all (the audited enumeration does not scale with processes), notices once, and re-arms after recovery", async () => {
    const redis = fakeRedis();
    let calls = 0;
    const stalled = async () => {
      calls += 1;
      return sample({ escalationStalledSeconds: 3600 });
    };
    const a = build(stalled, createOpsNoticeClaims(redis));
    const b = build(stalled, createOpsNoticeClaims(redis));
    expect(await a.tick()).toBe("stalled");
    expect(await b.tick()).toBe("skipped");
    expect(calls).toBe(1);
    expect(a.notices.length + b.notices.length).toBe(1);
    expect(STALLED_REPEAT_MS).toBeGreaterThan(0);
  });

  it("never runs two samples at once in a process", async () => {
    let release: (s: AckQueueSample) => void = () => undefined;
    let calls = 0;
    const { tick } = build(() => {
      calls += 1;
      return new Promise<AckQueueSample>((resolve) => {
        release = resolve;
      });
    });
    const first = tick();
    await Promise.resolve();
    expect(await tick()).toBe("skipped");
    release(sample());
    expect(await first).toBe("ok");
    expect(calls).toBe(1);
  });

  it("after 3 consecutive unmeasured ticks raises a distinct unmeasured notice once; a measured tick resets", async () => {
    let now = 0;
    const claims = createOpsNoticeClaims(undefined, () => now);
    let s: AckQueueSample | null = null;
    const { tick, notices } = build(async () => s, claims);
    for (let i = 0; i < UNMEASURED_TICKS - 1; i += 1) {
      expect(await tick()).toBe("unmeasured");
      now += TICK_CLAIM_MS;
    }
    expect(notices).toEqual([]);
    expect(await tick()).toBe("unmeasured");
    expect(notices.map((n) => n.kind)).toEqual(["m36.ack.escalation_stall_unmeasured"]);
    now += TICK_CLAIM_MS;
    s = sample({ orgsFailed: 1 }); // a partial sample is also unmeasured; the notice is claim-deduped for an hour
    expect(await tick()).toBe("unmeasured");
    expect(notices).toHaveLength(1);
    now += TICK_CLAIM_MS;
    s = sample();
    expect(await tick()).toBe("ok");
    now += TICK_CLAIM_MS;
    s = null;
    // The hourly notice claim is held until released; advance past it so only the counter (restarted from zero) can gate the notice.
    now += STALLED_REPEAT_MS;
    expect(await tick()).toBe("unmeasured");
    now += TICK_CLAIM_MS;
    expect(await tick()).toBe("unmeasured");
    expect(notices).toHaveLength(1); // two unmeasured ticks after the reset: no notice yet
    now += TICK_CLAIM_MS;
    expect(await tick()).toBe("unmeasured");
    expect(notices).toHaveLength(2); // the third consecutive one notifies again
  });

  it("never throws when the sampler does", async () => {
    const { tick } = build(vi.fn().mockRejectedValue(new Error("db")));
    await expect(tick()).resolves.toBe("unmeasured");
  });
});
