// apps/backend/src/bootstrap/metrics.ts — Prometheus metrics (TASK-040C, production-readiness audit
// 2026-08-03, OPS-005/006).
//
// Until this file, the only telemetry in the repo was Pino structured logging — no `/metrics` route,
// no default Node process metrics, no HTTP latency histogram, no BullMQ queue-depth visibility, no
// outbox-dispatcher counters (repo-wide grep for `prom-client`/`opentelemetry`/`/metrics` was empty
// before this). Greenfield build over `prom-client`.
//
// Every registration function here takes a `Registry` explicitly (never a module-level singleton) and,
// where it needs a live dependency (a BullMQ queue, the outbox dispatcher), takes a MINIMAL structural
// interface rather than importing `bullmq`'s `Queue` class or `outbox-dispatcher.ts` directly — the
// same DI shape `readiness-probe.ts` / `dlq-alerts.ts` use, so this stays unit-testable with a fake
// object instead of a live Redis/Postgres connection. The composition root (`index.ts`) owns
// constructing the real `Queue` instances and the outbox dispatcher's `pendingDepth` forward-ref.
import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** Build a fresh registry with the standard Node process/runtime metrics (event loop lag, GC, heap, …). */
export function buildMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

// ── HTTP request metrics ────────────────────────────────────────────────────────────────────────────

/**
 * Register an `onResponse` hook recording a request-duration histogram + a request counter, both
 * labeled by `(method, route, status_code)`. `route` is Fastify's REGISTERED PATTERN
 * (`request.routeOptions.url`, e.g. `/api/v1/patients/:id`) — never the raw URL, which would carry a
 * different label per patient id and explode cardinality. A 404 (`routeOptions.url` is `undefined`)
 * labels as `"unmatched"` for the same reason, rather than the raw unmatched path.
 */
export function registerHttpMetrics(app: FastifyInstance, registry: Registry): void {
  const labelNames = ["method", "route", "status_code"] as const;
  const duration = new Histogram({
    name: "wardenx_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const requestsTotal = new Counter({
    name: "wardenx_http_requests_total",
    help: "Total HTTP requests",
    labelNames,
    registers: [registry],
  });
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status_code: String(reply.statusCode),
    };
    requestsTotal.inc(labels);
    duration.observe(labels, reply.elapsedTime / 1000); // Fastify's elapsedTime is milliseconds
  });
}

// ── BullMQ queue-depth gauges ───────────────────────────────────────────────────────────────────────

/** The minimal shape a queue needs for depth reporting — BullMQ's real `Queue` satisfies this exactly. */
export interface QueueLike {
  readonly name: string;
  getJobCounts(...types: readonly string[]): Promise<Record<string, number>>;
}

const JOB_COUNT_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;

/**
 * Register a `(queue, state)`-labeled job-count gauge over every passed queue, using prom-client's
 * lazy `collect()` hook — the counts are read from Redis only WHEN `/metrics` is actually scraped
 * (Prometheus's own pull model), not on a background interval no one may be watching. The caller owns
 * each `QueueLike`'s lifecycle (construction + `close()` on shutdown) — this function never constructs
 * or closes one itself, so it stays unit-testable with a fake queue and no Redis connection.
 */
export function registerBullMQQueueMetrics(registry: Registry, queues: readonly QueueLike[]): void {
  new Gauge({
    name: "wardenx_bullmq_queue_jobs",
    help: "BullMQ job count per queue and state, read on scrape",
    labelNames: ["queue", "state"] as const,
    registers: [registry],
    async collect() {
      await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts(...JOB_COUNT_STATES);
          for (const state of JOB_COUNT_STATES) this.set({ queue: queue.name, state }, counts[state] ?? 0);
        }),
      );
    },
  });
}

// ── outbox-dispatcher metrics ───────────────────────────────────────────────────────────────────────

/** The `OutboxTickSummary` shape this module needs — restated locally (not imported from
 * `outbox-dispatcher.ts`) so this file takes no dependency edge on that module; TASK-040D's own
 * `bootstrap/dlq-alerts.ts` follows the same "restate the minimal shape" convention. */
export interface OutboxTickSummaryLike {
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly deferred: number;
  readonly recordOnly: number;
  readonly reclaimed: number;
  readonly purged: number;
}

export interface OutboxMetricsDeps {
  /**
   * Lazy — the outbox dispatcher instance is constructed AFTER `buildServer()` returns (the TASK-040B
   * `outboxDispatcherRef` forward-ref precedent in `index.ts`), so this is a thunk, not a value.
   * Omitted (no dispatcher running, e.g. `DATABASE_PLATFORM_URL` unconfigured) reports depth 0.
   */
  readonly pendingDepth?: () => Promise<number>;
}

export interface OutboxMetricsHooks {
  /** Wire this straight into `OutboxDispatcherOptions.onTick` (TASK-040C's own addition to that type). */
  onTick(summary: OutboxTickSummaryLike, elapsedMs: number): void;
}

/**
 * Register the outbox dispatcher's counters (`wardenx_outbox_events_total{status}`, one label per
 * `OutboxTickSummary` field except `orgsPolled`), a per-tick duration histogram (the closest available
 * proxy for "claim latency" — the dispatcher claims+delivers+finalizes within one tick per org; no
 * existing per-row age instrumentation to build a truer claim-to-dispatch latency without touching
 * every finalize call in `outbox-dispatcher.ts`, so this is a deliberate, documented approximation),
 * and a lazy pending-depth gauge reusing the same `pendingDepth()` the TASK-040B readiness probe reads.
 */
export function registerOutboxMetrics(registry: Registry, deps: OutboxMetricsDeps = {}): OutboxMetricsHooks {
  const eventsTotal = new Counter({
    name: "wardenx_outbox_events_total",
    help: "Outbox events processed by the dispatcher, by outcome",
    labelNames: ["status"] as const,
    registers: [registry],
  });
  const tickDuration = new Histogram({
    name: "wardenx_outbox_tick_duration_seconds",
    help: "Outbox dispatcher tick duration in seconds (approximates per-event claim/dispatch latency)",
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  new Gauge({
    name: "wardenx_outbox_pending_depth",
    help: "Outbox pending-row backlog across active orgs, read on scrape",
    registers: [registry],
    async collect() {
      this.set(deps.pendingDepth ? await deps.pendingDepth() : 0);
    },
  });

  const inc = (status: string, count: number) => {
    if (count > 0) eventsTotal.inc({ status }, count);
  };

  return {
    onTick(summary, elapsedMs) {
      inc("delivered", summary.delivered);
      inc("retried", summary.retried);
      inc("dead_lettered", summary.deadLettered);
      inc("deferred", summary.deferred);
      inc("record_only", summary.recordOnly);
      inc("reclaimed", summary.reclaimed);
      inc("purged", summary.purged);
      tickDuration.observe(elapsedMs / 1000);
    },
  };
}

// ── the /metrics route ──────────────────────────────────────────────────────────────────────────────

/** Mount `GET /metrics` — Prometheus text exposition, unauthenticated (the `/health`/`/ready` posture:
 * meant for internal scraping, not a public route). */
export function mountMetricsRoute(app: FastifyInstance, registry: Registry): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
