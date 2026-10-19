// ADR-0079 (G-4) - the stalled escalation worker check and the fleet-wide notice claims it relies on.
import { describe, expect, it, vi } from "vitest";
import type { AckQueueNotice, AckQueueSample } from "../ack-queue-metrics";
import {
  STALLED_NOTICE_SECONDS,
  STALLED_REPEAT_MS,
  checkEscalationStalled,
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
    const claims = createOpsNoticeClaims(broken, () => now);
    expect(await claims.claim("k", 1000)).toBe(true);
    expect(await claims.claim("k", 1000)).toBe(false);
    now = 1000;
    expect(await claims.claim("k", 1000)).toBe(true);
    await expect(claims.release("k")).resolves.toBeUndefined();
  });
});

describe("checkEscalationStalled", () => {
  const run = async (s: AckQueueSample | null, claims = createOpsNoticeClaims(undefined)) => {
    const notices: AckQueueNotice[] = [];
    await checkEscalationStalled({
      sample: async () => s,
      claims,
      notify: (n) => notices.push(n),
    });
    return notices;
  };

  it("notifies when the oldest unprocessed request is at the threshold, with counts only", async () => {
    const [n, ...rest] = await run(sample({ escalationStalledSeconds: STALLED_NOTICE_SECONDS }));
    expect(rest).toHaveLength(0);
    expect(n?.kind).toBe("m36.ack.escalation_stalled");
    expect(Object.keys(n?.details ?? {}).sort()).toEqual([
      "oldestUnprocessedSeconds",
      "orgsChecked",
    ]);
  });

  it("stays quiet below the threshold, when the sample is missing or partial", async () => {
    expect(await run(sample({ escalationStalledSeconds: STALLED_NOTICE_SECONDS - 1 }))).toEqual([]);
    expect(await run(null)).toEqual([]);
    expect(await run(sample({ orgsFailed: 1, escalationStalledSeconds: 9999 }))).toEqual([]);
  });

  it("notifies once per window across processes and re-arms after recovery", async () => {
    const redis = fakeRedis();
    const stalled = sample({ escalationStalledSeconds: 3600 });
    expect(await run(stalled, createOpsNoticeClaims(redis))).toHaveLength(1);
    expect(await run(stalled, createOpsNoticeClaims(redis))).toHaveLength(0);
    expect(await run(sample(), createOpsNoticeClaims(redis))).toHaveLength(0);
    expect(await run(stalled, createOpsNoticeClaims(redis))).toHaveLength(1);
    expect(STALLED_REPEAT_MS).toBeGreaterThan(0);
  });

  it("never throws when the sampler does", async () => {
    await expect(
      checkEscalationStalled({
        sample: vi.fn().mockRejectedValue(new Error("db")),
        claims: createOpsNoticeClaims(undefined),
        notify: () => undefined,
      }),
    ).resolves.toBeUndefined();
  });
});
