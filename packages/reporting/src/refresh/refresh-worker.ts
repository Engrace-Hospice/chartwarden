// @wardenx/reporting · refresh — the `report.mv_refresh` WORKER (M33 §2.2–§2.6 / §4.8 W-R-06).
//
// The handler the `report.mv_refresh` BullMQ worker runs per dequeued job: open a `report_run` ledger row
// (queued → running), execute `REFRESH MATERIALIZED VIEW CONCURRENTLY <schema>.<mv_key>` on the PRIMARY (NOT
// the read replica — D3; CONCURRENTLY keeps the MV readable during the refresh), then settle the run + stamp
// telemetry + invalidate the dependent tile cache + emit the §4.9 lifecycle event. On success the consecutive-
// failure counter resets; on failure it increments and the W-R-06 alert gate fires (warn at 3 consecutive
// failures OR a critical-tier failure; a retry-exhausted MV emits `m33.mv.refresh_exhausted` and is suspended).
// A stale MV degrades dashboards to an amber/red freshness chip — it NEVER blocks reads (§4.8).
//
// IDEMPOTENT on `(mvKey, requestedAtFloor)` (§2.6): a redelivery whose debounce-tick floor is already covered
// by the MV's `last_refreshed_at` no-ops (`already_fresh`) rather than re-refreshing within the window.
//
// PURE port-injected orchestration: every fact/effect is an injected port (no clock/RNG/Drizzle/BullMQ/cross-
// module import). The pure {@link decideRefreshAlert} core is unit-asserted independently of the I/O.
import type {
  MvMetadataReadPort,
  MvRefreshExecutionPort,
  MvRefreshJob,
  MvRefreshOutboxPort,
  MvRunLedgerPort,
  MvTelemetryWritePort,
  MvTileCacheInvalidationPort,
} from "./ports";

/** §4.8: the `report.mv_refresh` queue exhausts retries at 5 attempts (30s/2m/10m/30m/2h backoff). */
export const MV_REFRESH_MAX_ATTEMPTS = 5 as const;

/** The ports the refresh worker composes over (§2.4 effects + the PRIMARY refresh executor + a clock). */
export interface MvRefreshWorkerPorts {
  readonly metadataRead: Pick<MvMetadataReadPort, "findByKey">;
  readonly metadataWrite: MvTelemetryWritePort;
  readonly runs: MvRunLedgerPort;
  readonly exec: MvRefreshExecutionPort;
  readonly tileCache: MvTileCacheInvalidationPort;
  readonly outbox: MvRefreshOutboxPort;
  /** The critical-tier MV keys (W-R-06 — a single failure on one of these warns immediately). Default empty. */
  readonly criticalTierMvKeys?: ReadonlySet<string>;
  /** Override the §4.8 retry budget (default {@link MV_REFRESH_MAX_ATTEMPTS}). */
  readonly maxAttempts?: number;
  now(): Date;
}

/** What a refresh run reported. `refreshed` ran the REFRESH; `already_fresh` was an idempotent redelivery the
 *  MV's `last_refreshed_at` already covered; `skipped` was a retired MV (never refreshed). */
export type MvRefreshResult =
  | {
      readonly outcome: "refreshed";
      readonly mvKey: string;
      readonly durationMs: number;
      readonly rowsAffected: number | null;
    }
  | { readonly outcome: "already_fresh"; readonly mvKey: string; readonly refreshedAt: string }
  | { readonly outcome: "skipped"; readonly mvKey: string; readonly reason: "mv_retired" };

/** Raised when the refresh job names an MV with no `materialized_view_metadata` row (a config drift — loud). */
export class MvRefreshMetadataMissing extends Error {
  constructor(mvKey: string) {
    super(`materialized_view_metadata '${mvKey}' not found — cannot refresh an unregistered MV`);
    this.name = "MvRefreshMetadataMissing";
  }
}

/** Raised when `REFRESH MATERIALIZED VIEW CONCURRENTLY` fails — rethrown so BullMQ retries per §4.8 backoff
 *  (or moves the exhausted job to the DLQ). The W-R-06 alerts are already emitted before this throws. */
export class MvRefreshExecutionError extends Error {
  constructor(
    public readonly mvKey: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`REFRESH MATERIALIZED VIEW CONCURRENTLY for '${mvKey}' failed: ${reason}`, options);
    this.name = "MvRefreshExecutionError";
  }
}

// ── the pure W-R-06 alert gate ────────────────────────────────────────────────────────────────────────────

export interface RefreshAlertInput {
  /** Consecutive failures INCLUDING this one (the post-increment `refresh_failure_count`). */
  readonly failureCount: number;
  /** The 0-based BullMQ attempt index of THIS run. */
  readonly attempt: number;
  /** The §4.8 retry budget (5 for `report.mv_refresh`). */
  readonly maxAttempts: number;
  /** Whether this MV is a critical-tier surface (a single failure warns immediately). */
  readonly isCriticalTier: boolean;
}

/** The alert decision: emit the warn event (`m33.mv.refresh_failed`) and/or the critical exhaustion event
 *  (`m33.mv.refresh_exhausted`). Exhaustion supersedes warn — at the final attempt only the critical fires. */
export interface RefreshAlertDecision {
  readonly emitWarn: boolean;
  readonly emitExhausted: boolean;
}

/**
 * Decide the W-R-06 alert disposition for one failed refresh (PURE). The retries exhaust at the final attempt
 * (`attempt + 1 >= maxAttempts`) → emit the critical exhaustion event (the MV is suspended). Otherwise a warn
 * fires only at 3 consecutive failures OR a single critical-tier failure (§4.8) — transient single failures on
 * non-critical MVs stay silent (retries will likely recover them).
 */
export function decideRefreshAlert(input: RefreshAlertInput): RefreshAlertDecision {
  const exhausted = input.attempt + 1 >= input.maxAttempts;
  if (exhausted) return { emitWarn: false, emitExhausted: true };
  const warn = input.isCriticalTier || input.failureCount >= 3;
  return { emitWarn: warn, emitExhausted: false };
}

// ── the worker ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Handle one `report.mv_refresh` job (§2.4). Refreshes the MV on the PRIMARY, settles the run ledger, stamps
 * telemetry, invalidates the dependent tile cache, and emits the §4.9 lifecycle event. Idempotent on
 * `(mvKey, requestedAtFloor)`. On a refresh failure the W-R-06 alert gate fires and the error is rethrown so
 * the queue retries (or DLQs an exhausted job) — the worker never swallows a failure.
 */
export async function handleMvRefresh(
  job: MvRefreshJob,
  ports: MvRefreshWorkerPorts,
): Promise<MvRefreshResult> {
  const meta = await ports.metadataRead.findByKey(job.mvKey);
  if (meta === null) throw new MvRefreshMetadataMissing(job.mvKey);
  if (meta.status === "retired") return { outcome: "skipped", mvKey: job.mvKey, reason: "mv_retired" };

  // Idempotency (§2.6): a redelivery whose debounce tick is already covered by the last refresh no-ops.
  const requestedAtFloor = new Date(job.requestedAtFloor);
  if (meta.lastRefreshedAt !== null && meta.lastRefreshedAt >= requestedAtFloor) {
    return { outcome: "already_fresh", mvKey: job.mvKey, refreshedAt: meta.lastRefreshedAt.toISOString() };
  }

  const startedAt = ports.now();
  const handle = await ports.runs.open({
    mvKey: job.mvKey,
    organizationId: job.organizationId,
    triggerKind: job.triggerKind,
    triggerOutboxEventId: job.triggerOutboxEventId ?? null,
    startedAt,
    retryAttempt: job.retryAttempt ?? 0,
  });

  try {
    const { rowsAffected } = await ports.exec.refreshConcurrently({
      schemaName: meta.schemaName,
      mvKey: meta.mvKey,
    });
    const finishedAt = ports.now();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    await ports.runs.settle(handle, { status: "succeeded", finishedAt, durationMs, rowsAffected });
    await ports.metadataWrite.stamp(meta.mvKey, {
      lastRefreshedAt: finishedAt,
      lastRefreshDurationMs: durationMs,
      refreshFailureCount: 0, // success resets the consecutive-failure counter (§2.4)
      status: "active",
    });
    await ports.tileCache.invalidateForMv({ mvKey: meta.mvKey, organizationId: job.organizationId });
    await ports.outbox.emitRefreshSucceeded({
      mvKey: meta.mvKey,
      organizationId: job.organizationId,
      durationMs,
      rowsAffected,
      refreshedAt: finishedAt.toISOString(),
    });
    return { outcome: "refreshed", mvKey: meta.mvKey, durationMs, rowsAffected };
  } catch (cause) {
    const finishedAt = ports.now();
    const reason = cause instanceof Error ? cause.message : String(cause);
    const failureCount = meta.refreshFailureCount + 1;
    const attempt = job.retryAttempt ?? 0;
    const maxAttempts = ports.maxAttempts ?? MV_REFRESH_MAX_ATTEMPTS;
    const isCriticalTier = ports.criticalTierMvKeys?.has(meta.mvKey) ?? false;
    const alert = decideRefreshAlert({ failureCount, attempt, maxAttempts, isCriticalTier });

    await ports.runs.settle(handle, { status: "failed", finishedAt, failureReason: reason });
    await ports.metadataWrite.stamp(meta.mvKey, {
      refreshFailureCount: failureCount,
      // Exhaustion suspends the MV (it degrades to an amber/red freshness chip; reads still serve, §4.8).
      ...(alert.emitExhausted ? { status: "suspended" as const } : {}),
    });

    if (alert.emitExhausted) {
      await ports.outbox.emitRefreshExhausted({
        mvKey: meta.mvKey,
        organizationId: job.organizationId,
        attempts: attempt + 1,
        reason,
        lastSucceededAt: meta.lastRefreshedAt?.toISOString() ?? null,
      });
    } else if (alert.emitWarn) {
      await ports.outbox.emitRefreshFailed({
        mvKey: meta.mvKey,
        organizationId: job.organizationId,
        attempts: attempt + 1,
        reason,
      });
    }

    // Rethrow so BullMQ applies the §4.8 backoff / DLQ — the worker never silently swallows a failure.
    throw new MvRefreshExecutionError(meta.mvKey, reason, { cause });
  }
}
