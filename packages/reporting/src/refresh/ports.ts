// @wardenx/reporting · refresh — the injected PORT interfaces the three-tier MV-refresh subsystem composes
// over (M33 §2.4–§2.6 / §4.5 / §4.8). EVERY fact + effect a refresh worker touches is one of these tiny
// ports; the handlers (`dispatcher` / `outbox-subscriber` / `refresh-worker` / `lag-probe` / `nightly-cron`)
// are PURE orchestration over them — no clock, no RNG, no Drizzle, no BullMQ, no `getSeam`, no cross-module
// import. The composition root (P2C, the M34 `saas-jobs.ts` precedent) binds the real adapters: the
// `ReportCatalogRepository` / `ReportRunRepository` / `DashboardTileCacheRepository` data ports, the
// `withReportSession`-on-PRIMARY `REFRESH MATERIALIZED VIEW CONCURRENTLY` executor, the live outbox
// dispatcher, the `pg_stat_replication` lag probe, and the BullMQ `report.mv_refresh` queue. Any port whose
// infra is not yet available is bound to a LAZY fail-closed thunk via {@link unboundRefreshPort} — it throws
// only when a job RUNS, never at construction (the M34 eager-bind gotcha: the host must boot with the queue
// connection enabled even when an adapter is missing).
//
// Persisted-row types are reused from the central Drizzle schema (`schema.MaterializedViewMetadata` etc.) so
// the ports never drift from the tables; pure inputs use narrow local types so the deciders stay unit-testable
// against in-memory doubles.
import type { schema } from "@wardenx/db";

// ── tier + trigger vocabulary (mirrors `materialized_view_metadata.refresh_strategy` + `report_run`) ──────

/** The three refresh tiers declared per MV in `materialized_view_metadata.refresh_strategy` (§3.3, D2). */
export type RefreshStrategy = schema.MaterializedViewMetadata["refreshStrategy"];

/** The `report_run.trigger_kind` discriminator (§3.3): which path demanded this refresh. */
export type ReportRunTriggerKind = schema.ReportRun["triggerKind"];

// ── the `report.mv_refresh` job payload (§4.8) ────────────────────────────────────────────────────────────

/**
 * One `report.mv_refresh` job: refresh a single MV. Idempotent on `(mvKey, requestedAtFloor)` — the
 * `requestedAtFloor` is the most-recent debounce-window tick (§2.6), so a redelivered outbox event collapses
 * onto the same job within the window rather than re-refreshing. `organizationId` is null for the platform-
 * global MVs (one `report_mv.*` view holds every org's RLS-filtered rows; a refresh is org-agnostic).
 */
export interface MvRefreshJob {
  readonly mvKey: string;
  readonly triggerKind: ReportRunTriggerKind;
  /** Null for the platform-global MV refresh (the common case); set only for a rare per-org refresh. */
  readonly organizationId: string | null;
  /** ISO-8601 instant — the debounce-tick floor the job dedups on (§2.6 idempotency key component). */
  readonly requestedAtFloor: string;
  /** Populated when `triggerKind='incremental_outbox'` (the originating event → `report_run`). */
  readonly triggerOutboxEventId?: string;
  /** The 0-based BullMQ attempt index of THIS run (drives the W-R-06 exhaustion alert gate). */
  readonly retryAttempt?: number;
}

// ── catalog (materialized_view_metadata) ports ────────────────────────────────────────────────────────────

/** Read port over `materialized_view_metadata` (the platform-global MV registry, §3.3). */
export interface MvMetadataReadPort {
  /** Fetch MV metadata by `mv_key`, or `null` when unregistered. */
  findByKey(mvKey: string): Promise<schema.MaterializedViewMetadata | null>;
  /** List the ACTIVE MVs declaring a given refresh tier (the nightly orchestrator's work-set). */
  listActiveByStrategy(strategy: RefreshStrategy): Promise<readonly schema.MaterializedViewMetadata[]>;
}

/** The telemetry patch the refresh worker stamps after a refresh (§2.4 — success resets the failure counter
 *  to 0; failure raises it; an exhausted MV is transitioned to `suspended`). */
export interface MvTelemetryPatch {
  readonly lastRefreshedAt?: Date;
  readonly lastRefreshDurationMs?: number;
  readonly refreshFailureCount?: number;
  readonly status?: schema.MaterializedViewMetadata["status"];
}

/** Write port that stamps MV-refresh telemetry on `materialized_view_metadata` (§2.4). */
export interface MvTelemetryWritePort {
  stamp(mvKey: string, patch: MvTelemetryPatch): Promise<void>;
}

// ── run ledger (report_run) port ──────────────────────────────────────────────────────────────────────────

/** The fields the worker opens a `report_run` row with (`queued → running`, §2.2). */
export interface MvRunOpenInput {
  readonly mvKey: string;
  readonly organizationId: string | null;
  readonly triggerKind: ReportRunTriggerKind;
  readonly triggerOutboxEventId: string | null;
  readonly startedAt: Date;
  readonly retryAttempt: number;
}

/** A handle to the opened `report_run` row (composite PK: id + the `started_at` partition key). */
export interface MvRunHandle {
  readonly id: string;
  readonly startedAt: Date;
}

/** The terminal patch the worker settles a `report_run` row with (`→ succeeded | failed`, §2.2). */
export interface MvRunSettleInput {
  readonly status: "succeeded" | "failed";
  readonly finishedAt: Date;
  readonly durationMs?: number;
  readonly rowsAffected?: number | null;
  readonly failureReason?: string;
}

/** Write port over the `report_run` MV-refresh ledger (§3.3 — partitioned monthly by `started_at`). */
export interface MvRunLedgerPort {
  /** Insert a `running` run row; returns the composite-PK handle. */
  open(input: MvRunOpenInput): Promise<MvRunHandle>;
  /** Transition the run to its terminal state, stamping finish telemetry. */
  settle(handle: MvRunHandle, patch: MvRunSettleInput): Promise<void>;
}

// ── the REFRESH executor (runs on PRIMARY, not the replica) ───────────────────────────────────────────────

/**
 * Executes `REFRESH MATERIALIZED VIEW CONCURRENTLY <schemaName>.<mvKey>` against the PRIMARY (§2.4 / D3 — the
 * MV-refresh worker is the ONE M33 path that writes, so it bypasses the read-only `withReportSession` replica
 * route). CONCURRENTLY keeps the MV readable during the refresh. The composition root binds this to a
 * primary-pool `db.execute(sql\`REFRESH MATERIALIZED VIEW CONCURRENTLY ...\`)` with `statement_timeout='300s'`.
 */
export interface MvRefreshExecutionPort {
  refreshConcurrently(input: {
    readonly schemaName: string;
    readonly mvKey: string;
  }): Promise<{ readonly rowsAffected: number | null }>;
}

// ── dependent tile-cache invalidation ─────────────────────────────────────────────────────────────────────

/**
 * Invalidates the `dashboard_tile_cache` rows backed by a refreshed MV (§2.4 — "invalidate dependent
 * dashboard_tile_cache"). The composition root binds this over `DashboardTileCacheRepository` (today
 * `deleteByOrg`; a future `deleteByMvKey`). `organizationId=null` invalidates across all orgs for the
 * platform-global MV refresh.
 */
export interface MvTileCacheInvalidationPort {
  invalidateForMv(input: {
    readonly mvKey: string;
    readonly organizationId: string | null;
  }): Promise<number>;
}

// ── outbox emit ports (the §4.9 `m33.mv.*` / `m33.lag.*` events) ──────────────────────────────────────────

export interface MvRefreshSucceededPayload {
  readonly mvKey: string;
  readonly organizationId: string | null;
  readonly durationMs: number;
  readonly rowsAffected: number | null;
  readonly refreshedAt: string;
}
export interface MvRefreshFailedPayload {
  readonly mvKey: string;
  readonly organizationId: string | null;
  readonly attempts: number;
  readonly reason: string;
}
export interface MvRefreshExhaustedPayload {
  readonly mvKey: string;
  readonly organizationId: string | null;
  readonly attempts: number;
  readonly reason: string;
  readonly lastSucceededAt: string | null;
}

/** Outbox port for the MV-refresh lifecycle events (`m33.mv.refresh_succeeded|failed|exhausted`, §4.9). The
 *  emit runs in the SAME tx as the run-ledger/telemetry write so "DB updated but the event never went out"
 *  is closed (M1 §25.5/§25.6). */
export interface MvRefreshOutboxPort {
  emitRefreshSucceeded(payload: MvRefreshSucceededPayload): Promise<void>;
  emitRefreshFailed(payload: MvRefreshFailedPayload): Promise<void>;
  emitRefreshExhausted(payload: MvRefreshExhaustedPayload): Promise<void>;
}

export interface LagExceededPayload {
  readonly lagSeconds: number;
  readonly threshold: number;
  readonly sampledAt: string;
}
export interface LagRecoveredPayload {
  readonly lagSeconds: number;
  readonly durationDownSeconds: number;
  readonly recoveredAt: string;
}

/** Outbox port for the replica-lag transition events (`m33.lag.exceeded|recovered`, §4.9). */
export interface LagOutboxPort {
  emitLagExceeded(payload: LagExceededPayload): Promise<void>;
  emitLagRecovered(payload: LagRecoveredPayload): Promise<void>;
}

// ── the BullMQ `report.mv_refresh` enqueue port ───────────────────────────────────────────────────────────

/** The enqueue options the dispatcher hands the queue: the §2.6 idempotency `jobId` + the debounce delay. */
export interface MvRefreshEnqueueOptions {
  /** The BullMQ jobId — `mv_refresh:<mvKey>:<floorEpochMs>` (the §2.6 dedup oracle; a redelivery collides). */
  readonly jobId: string;
  /** The debounce delay (ms) — collapses a burst within the MV's `debounce_window_seconds` into one job. */
  readonly debounceMs: number;
}

/** The result of an enqueue: whether a NEW job was admitted or it collapsed onto an in-flight/debounced one. */
export interface MvRefreshEnqueueOutcome {
  /** False when `jobId` already in-flight (BullMQ dedup) — the debounce collapsed the burst (§2.5). */
  readonly enqueued: boolean;
  readonly jobId: string;
}

/** Enqueue port over the BullMQ `report.mv_refresh` queue. Bound at boot; never constructed in the package. */
export interface MvRefreshQueuePort {
  enqueue(job: MvRefreshJob, opts: MvRefreshEnqueueOptions): Promise<MvRefreshEnqueueOutcome>;
}

// ── replica-lag probe ports (`report.lag_probe` singleton) ────────────────────────────────────────────────

/** Samples the worst current replica replay lag in seconds (`pg_stat_replication`, §2.4 / D14). Bound at boot
 *  to a primary-pool `SELECT EXTRACT(EPOCH FROM replay_lag) ...`. */
export interface ReplicationLagPort {
  sampleMaxReplayLagSeconds(): Promise<number>;
}

/** The rolling lag-probe state (two-consecutive-probe hysteresis, §2.4). Persisted between 30s ticks. */
export interface LagProbeState {
  /** Whether the lag is currently in the breached (>threshold, confirmed) state. */
  readonly breached: boolean;
  /** Consecutive probes strictly OVER threshold (resets to 0 on an under-threshold probe). */
  readonly consecutiveOver: number;
  /** Consecutive probes AT/UNDER threshold (resets to 0 on an over-threshold probe). */
  readonly consecutiveUnder: number;
  /** ISO instant the confirmed breach began (for the `recovered` event's `durationDownSeconds`), or null. */
  readonly breachStartedAt: string | null;
}

/** Load/save the {@link LagProbeState} (the boot binds this over `materialized_view_metadata.platform_metrics`
 *  / a Valkey key — the singleton probe's only mutable state). */
export interface LagProbeStatePort {
  load(): Promise<LagProbeState>;
  save(state: LagProbeState): Promise<void>;
}

/** Stamps the degraded-tile advisory (`dashboard_tile_cache.replica_lag_advisory` / a Valkey flag, D14) so
 *  served tiles flip their "Data as of HH:MM" badge to the warning state while the breach holds. */
export interface ReplicaLagAdvisoryPort {
  setAdvisory(active: boolean): Promise<void>;
}

// ── fail-closed unbound-port idiom (the M34 `M34WorkerPortUnbound` precedent) ─────────────────────────────

/** Raised when a refresh port the composition root left unbound is exercised by a running job. P2C binds each
 *  genuinely-missing port to a LAZY `() => unboundRefreshPort(...)` thunk so the throw happens at job-run time,
 *  never at construction (the host must still boot with the BullMQ connection enabled). */
export class M33RefreshPortUnbound extends Error {
  constructor(port: string, reason: string) {
    super(`M33 reporting refresh port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M33RefreshPortUnbound";
  }
}

/** Throw the unbound-port error. Use ONLY inside a thunk (`() => unboundRefreshPort("exec.refreshConcurrently",
 *  "bind the primary-pool REFRESH executor")`) so it is lazy — never call it eagerly at port-bundle construction. */
export function unboundRefreshPort(port: string, reason: string): never {
  throw new M33RefreshPortUnbound(port, reason);
}
