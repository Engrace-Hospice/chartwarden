// TASK-040C (OPS-005/006) — the Prometheus metrics module. Every registration function takes a
// minimal structural dependency (QueueLike, a pendingDepth thunk) rather than a live BullMQ/Redis
// connection, so this suite runs entirely without infra — a plain Fastify() instance + fake queues.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  type QueueLike,
  buildMetricsRegistry,
  mountMetricsRoute,
  registerBullMQQueueMetrics,
  registerHttpMetrics,
  registerOutboxMetrics,
} from "../metrics";

describe("buildMetricsRegistry", () => {
  it("collects the default Node process metrics", async () => {
    const registry = buildMetricsRegistry();
    const text = await registry.metrics();
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(text).toContain("nodejs_heap_size_total_bytes");
  });
});

describe("registerHttpMetrics", () => {
  it("records a request-duration observation and increments the request counter, labeled by the ROUTE PATTERN not the raw URL", async () => {
    const registry = buildMetricsRegistry();
    const app = Fastify();
    registerHttpMetrics(app, registry);
    app.get("/widgets/:id", async () => ({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/widgets/abc-123" });
    expect(res.statusCode).toBe(200);

    const text = await registry.metrics();
    expect(text).toContain(
      'chartwarden_http_requests_total{method="GET",route="/widgets/:id",status_code="200"} 1',
    );
    expect(text).toContain("chartwarden_http_request_duration_seconds_bucket");
    // The raw URL (with the actual id) must NOT appear as a label value — cardinality guard.
    expect(text).not.toContain('route="/widgets/abc-123"');
  });

  it("labels an unmatched route as 'unmatched' rather than the raw 404 path", async () => {
    const registry = buildMetricsRegistry();
    const app = Fastify();
    registerHttpMetrics(app, registry);

    const res = await app.inject({ method: "GET", url: "/does/not/exist" });
    expect(res.statusCode).toBe(404);

    const text = await registry.metrics();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('route="/does/not/exist"');
  });
});

describe("registerBullMQQueueMetrics", () => {
  function fakeQueue(name: string, counts: Record<string, number>): QueueLike {
    return {
      name,
      getJobCounts: async (...types) => {
        const result: Record<string, number> = {};
        for (const t of types) result[t] = counts[t] ?? 0;
        return result;
      },
    };
  }

  it("reports per-(queue,state) job counts, read lazily on scrape", async () => {
    const registry = buildMetricsRegistry();
    const queues = [
      fakeQueue("care-plan.gates", { waiting: 3, active: 1, completed: 10, failed: 0, delayed: 0 }),
      fakeQueue("assessment.license", {
        waiting: 0,
        active: 0,
        completed: 5,
        failed: 2,
        delayed: 1,
      }),
    ];
    registerBullMQQueueMetrics(registry, queues);

    const text = await registry.metrics();
    expect(text).toContain('chartwarden_bullmq_queue_jobs{queue="care-plan.gates",state="waiting"} 3');
    expect(text).toContain('chartwarden_bullmq_queue_jobs{queue="care-plan.gates",state="active"} 1');
    expect(text).toContain(
      'chartwarden_bullmq_queue_jobs{queue="assessment.license",state="failed"} 2',
    );
    expect(text).toContain(
      'chartwarden_bullmq_queue_jobs{queue="assessment.license",state="delayed"} 1',
    );
  });

  it("reflects an updated count on a LATER scrape (proves collect() re-reads, not a snapshot)", async () => {
    const registry = buildMetricsRegistry();
    const counts: Record<string, number> = {
      waiting: 1,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };
    const queue: QueueLike = {
      name: "hope.windows",
      getJobCounts: async (...types) => {
        const result: Record<string, number> = {};
        for (const t of types) result[t] = counts[t] ?? 0;
        return result;
      },
    };
    registerBullMQQueueMetrics(registry, [queue]);

    expect(await registry.metrics()).toContain(
      'chartwarden_bullmq_queue_jobs{queue="hope.windows",state="waiting"} 1',
    );
    counts.waiting = 7;
    expect(await registry.metrics()).toContain(
      'chartwarden_bullmq_queue_jobs{queue="hope.windows",state="waiting"} 7',
    );
  });
});

describe("registerOutboxMetrics", () => {
  it("increments the events-total counter per non-zero summary field, observes tick duration, skips zero fields", async () => {
    const registry = buildMetricsRegistry();
    const { onTick } = registerOutboxMetrics(registry);

    onTick(
      {
        delivered: 2,
        retried: 1,
        deadLettered: 0,
        deferred: 3,
        recordOnly: 0,
        reclaimed: 0,
        purged: 0,
      },
      150,
    );

    const text = await registry.metrics();
    expect(text).toContain('chartwarden_outbox_events_total{status="delivered"} 2');
    expect(text).toContain('chartwarden_outbox_events_total{status="retried"} 1');
    expect(text).toContain('chartwarden_outbox_events_total{status="deferred"} 3');
    expect(text).not.toContain('status="dead_lettered"');
    expect(text).not.toContain('status="record_only"');
    expect(text).toContain("chartwarden_outbox_tick_duration_seconds_bucket");
  });

  it("accumulates across multiple ticks", async () => {
    const registry = buildMetricsRegistry();
    const { onTick } = registerOutboxMetrics(registry);
    onTick(
      {
        delivered: 1,
        retried: 0,
        deadLettered: 0,
        deferred: 0,
        recordOnly: 0,
        reclaimed: 0,
        purged: 0,
      },
      10,
    );
    onTick(
      {
        delivered: 4,
        retried: 0,
        deadLettered: 0,
        deferred: 0,
        recordOnly: 0,
        reclaimed: 0,
        purged: 0,
      },
      10,
    );
    expect(await registry.metrics()).toContain('chartwarden_outbox_events_total{status="delivered"} 5');
  });

  it("reports pendingDepth via the injected thunk, 0 when omitted (no dispatcher running)", async () => {
    const withDepth = buildMetricsRegistry();
    registerOutboxMetrics(withDepth, { pendingDepth: async () => 42 });
    expect(await withDepth.metrics()).toContain("chartwarden_outbox_pending_depth 42");

    const withoutDepth = buildMetricsRegistry();
    registerOutboxMetrics(withoutDepth);
    expect(await withoutDepth.metrics()).toContain("chartwarden_outbox_pending_depth 0");
  });
});

describe("mountMetricsRoute", () => {
  it("serves the registry's Prometheus text exposition with the correct content type", async () => {
    const registry = buildMetricsRegistry();
    const app = Fastify();
    mountMetricsRoute(app, registry);

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("process_cpu_user_seconds_total");
  });
});
