// WP 4.9 (ADR-0076) - the ops view of the unacknowledged queue: aggregation across organisations, the gauges (unmeasured = -1, never 0,
// no organisation/user/request label), and the threshold notice (first breach notifies, a lasting breach repeats hourly, recovery re-arms).
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import {
  type AckQueueOrgStats,
  LATENCY_NOTICE_MEAN_SECONDS,
  NOTICE_REPEAT_MS,
  ORG_CHUNK,
  OVERDUE_NOTICE_SECONDS,
  SAMPLE_TIMEOUT_MS,
  SAMPLE_TTL_MS,
  breachedKinds,
  createAckQueueNoticeEvaluator,
  registerAckQueueMetrics,
  sampleAckQueue,
} from "../ack-queue-metrics";

const calm: AckQueueOrgStats = {
  overdue: 0,
  failedUnreachable: 0,
  oldestOverdueSeconds: 0,
  ackedCount: 0,
  ackLatencySumSeconds: 0,
  ackLatencyMaxSeconds: 0,
};
const stats = (over: Partial<AckQueueOrgStats>): AckQueueOrgStats => ({ ...calm, ...over });

describe("sampleAckQueue", () => {
  it("adds counts and sums and takes the maximum of the maxima", async () => {
    const byOrg: Record<string, AckQueueOrgStats> = {
      a: stats({
        overdue: 2,
        failedUnreachable: 1,
        oldestOverdueSeconds: 60,
        ackedCount: 2,
        ackLatencySumSeconds: 100,
        ackLatencyMaxSeconds: 70,
      }),
      b: stats({
        overdue: 1,
        oldestOverdueSeconds: 600,
        ackedCount: 3,
        ackLatencySumSeconds: 50,
        ackLatencyMaxSeconds: 30,
      }),
    };
    const sample = await sampleAckQueue({
      listOrgs: async () => [{ organizationId: "a" }, { organizationId: "b" }],
      statsForOrg: async (id) => byOrg[id] as AckQueueOrgStats,
    });
    expect(sample).toEqual({
      orgsChecked: 2,
      orgsFailed: 0,
      overdue: 3,
      failedUnreachable: 1,
      oldestOverdueSeconds: 600,
      ackedCount: 5,
      ackLatencySumSeconds: 150,
      ackLatencyMaxSeconds: 70,
    });
  });

  it("is null when the org list cannot be read and counts an org that failed", async () => {
    expect(
      await sampleAckQueue({
        listOrgs: async () => {
          throw new Error("no platform pool");
        },
        statsForOrg: async () => calm,
      }),
    ).toBeNull();
    const partial = await sampleAckQueue({
      listOrgs: async () => [{ organizationId: "a" }, { organizationId: "b" }],
      statsForOrg: async (id) => {
        if (id === "b") throw new Error("boom");
        return calm;
      },
    });
    expect(partial).toMatchObject({ orgsChecked: 1, orgsFailed: 1 });
  });
});

describe("sampleAckQueue bounds", () => {
  it("never reads more than ORG_CHUNK organisations at once", async () => {
    let running = 0;
    let peak = 0;
    const orgs = Array.from({ length: 11 }, (_, i) => ({ organizationId: `o${i}` }));
    await sampleAckQueue({
      listOrgs: async () => orgs,
      statsForOrg: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
        return calm;
      },
    });
    expect(peak).toBeLessThanOrEqual(ORG_CHUNK);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("registerAckQueueMetrics", () => {
  it("reads -1 when the sampler hangs past the timeout instead of hanging the scrape", async () => {
    vi.useFakeTimers();
    try {
      const registry = new Registry();
      registerAckQueueMetrics(registry, () => new Promise(() => undefined));
      const pending = registry.getMetricsAsJSON();
      await vi.advanceTimersByTimeAsync(SAMPLE_TIMEOUT_MS + 1);
      const all = await pending;
      const values = all.flatMap((m) => m.values.map((v) => v.value));
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((v) => v === -1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  const values = async (registry: Registry) => {
    const out: Record<string, number> = {};
    for (const metric of await registry.getMetricsAsJSON()) {
      for (const v of metric.values) {
        const stat = (v.labels as Record<string, string>).stat;
        out[stat ? `${metric.name}:${stat}` : metric.name] = v.value;
      }
    }
    return out;
  };
  const sample = {
    orgsChecked: 1,
    orgsFailed: 0,
    overdue: 4,
    failedUnreachable: 1,
    oldestOverdueSeconds: 900,
    ackedCount: 4,
    ackLatencySumSeconds: 400,
    ackLatencyMaxSeconds: 250,
  };

  it("exposes the five gauges with only a fixed stat label", async () => {
    const registry = new Registry();
    registerAckQueueMetrics(registry, async () => sample);
    expect(await values(registry)).toEqual({
      wardenx_m36_ack_overdue_total: 4,
      wardenx_m36_ack_failed_unreachable_total: 1,
      wardenx_m36_ack_oldest_overdue_seconds: 900,
      wardenx_m36_ack_latency_samples: 4,
      "wardenx_m36_ack_latency_seconds:mean": 100,
      "wardenx_m36_ack_latency_seconds:max": 250,
    });
    const labelNames = (await registry.getMetricsAsJSON()).flatMap((m) =>
      Object.keys((m as { labelNames?: Record<string, unknown> }).labelNames ?? {}),
    );
    expect(labelNames.every((l) => l === "stat")).toBe(true);
  });

  it("reads -1 (not measured), never 0, when the sample is missing, partial or throws", async () => {
    for (const bad of [
      async () => null,
      async () => ({ ...sample, orgsFailed: 1 }),
      async () => {
        throw new Error("x");
      },
    ]) {
      const registry = new Registry();
      registerAckQueueMetrics(registry, bad as never);
      const v = await values(registry);
      expect(Object.values(v).every((n) => n === -1)).toBe(true);
    }
  });

  it("reads once per TTL, not once per gauge or per scrape", async () => {
    let reads = 0;
    let clock = 0;
    const registry = new Registry();
    registerAckQueueMetrics(
      registry,
      async () => {
        reads += 1;
        return sample;
      },
      () => clock,
    );
    await values(registry);
    await values(registry);
    expect(reads).toBe(1);
    clock = SAMPLE_TTL_MS;
    await values(registry);
    expect(reads).toBe(2);
  });

  it("reports a mean of 0, not NaN, with no acknowledgments", async () => {
    const registry = new Registry();
    registerAckQueueMetrics(registry, async () => ({
      ...sample,
      ackedCount: 0,
      ackLatencySumSeconds: 0,
      ackLatencyMaxSeconds: 0,
    }));
    expect((await values(registry))["wardenx_m36_ack_latency_seconds:mean"]).toBe(0);
  });
});

describe("threshold notice", () => {
  it("breaches on a long-overdue request and on a high mean latency with enough samples, and on nothing else", () => {
    expect(breachedKinds(calm)).toEqual([]);
    expect(
      breachedKinds(stats({ overdue: 3, oldestOverdueSeconds: OVERDUE_NOTICE_SECONDS - 1 })),
    ).toEqual([]);
    expect(
      breachedKinds(stats({ overdue: 1, oldestOverdueSeconds: OVERDUE_NOTICE_SECONDS })),
    ).toEqual(["overdue_long"]);
    expect(breachedKinds(stats({ ackedCount: 4, ackLatencySumSeconds: 4 * 10_000 }))).toEqual([]);
    expect(
      breachedKinds(
        stats({ ackedCount: 5, ackLatencySumSeconds: 5 * LATENCY_NOTICE_MEAN_SECONDS }),
      ),
    ).toEqual(["latency_high"]);
  });

  it("notifies the first breach, holds repeats for an hour, repeats after it, and re-arms on recovery", async () => {
    let now = 1_000;
    let current = stats({ overdue: 2, oldestOverdueSeconds: 3600 });
    const notices: { kind: string; details: Record<string, unknown>; correlationId: string }[] = [];
    const observe = createAckQueueNoticeEvaluator({
      statsForOrg: async () => current,
      notify: (n) => notices.push(n),
      now: () => now,
    });
    await observe("org-1");
    await observe("org-1");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("m36.ack.queue_overdue");
    now += NOTICE_REPEAT_MS;
    await observe("org-1");
    expect(notices).toHaveLength(2);
    current = calm;
    await observe("org-1");
    current = stats({ overdue: 1, oldestOverdueSeconds: 3600 });
    await observe("org-1");
    expect(notices).toHaveLength(3);
  });

  it("keeps organisations independent and puts only ids and numbers in the notice", async () => {
    const notices: { details: Record<string, unknown>; summary: string }[] = [];
    const observe = createAckQueueNoticeEvaluator({
      statsForOrg: async () => stats({ overdue: 2, oldestOverdueSeconds: 3600 }),
      notify: (n) => notices.push(n),
      now: () => 1,
    });
    await observe("org-1");
    await observe("org-2");
    expect(notices).toHaveLength(2);
    for (const n of notices) {
      expect(Object.keys(n.details).sort()).toEqual(
        ["organizationId", "oldestOverdueSeconds", "overdue"].sort(),
      );
    }
  });

  it("lets a failing stats read reach the caller (the sweep reports it and carries on)", async () => {
    const observe = createAckQueueNoticeEvaluator({
      statsForOrg: async () => {
        throw new Error("db down");
      },
      notify: () => undefined,
    });
    await expect(observe("org-1")).rejects.toThrow("db down");
  });
});
