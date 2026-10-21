import type { schema } from "@chartwarden/db";
// @chartwarden/reporting · refresh — the three-tier MV-refresh DISPATCHER (M33 §2.5–§2.6 / D2, D15).
//
// The single routing brain the three demand-paths (nightly cron, incremental outbox-subscriber, manual
// "Refresh now") funnel through: it resolves an MV's declared `materialized_view_metadata.refresh_strategy`
// against the trigger that asked for the refresh, computes the §2.6 debounce-tick floor + the idempotency
// `jobId`, and emits an enqueue instruction onto the `report.mv_refresh` queue (or a typed SKIP). The
// debounce floor + the BullMQ jobId together cap refresh storms: a redelivered outbox event (or a burst
// within the MV's `debounce_window_seconds`) collapses onto ONE in-flight job rather than re-refreshing
// (the §2.5 "max 1 in-flight per MV" invariant — fail-closed by collapse, never by blocking reads).
//
// PURE: the decision core {@link decideRefreshDispatch} is a total function of (metadata, request, now) with
// no I/O; {@link dispatchMvRefresh} is the thin port-injected orchestrator (read metadata → decide → enqueue).
import type {
  MvMetadataReadPort,
  MvRefreshEnqueueOutcome,
  MvRefreshJob,
  MvRefreshQueuePort,
  ReportRunTriggerKind,
} from "./ports";

// ── the §2.6 debounce floor + idempotency jobId (pure helpers) ────────────────────────────────────────────

/**
 * Floor `now` to the most-recent debounce-window tick (§2.6). All demand within one `windowSeconds` window
 * maps to the SAME floor, so the derived jobId is identical and the queue dedups the burst into one refresh.
 * `windowSeconds` is clamped to ≥1 so a misconfigured 0-window MV still floors deterministically (to the second).
 */
export function floorToDebounceTick(now: Date, windowSeconds: number): Date {
  const win = Math.max(1, Math.floor(windowSeconds));
  const ms = win * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** The §2.6 idempotency jobId: `mv_refresh:<mvKey>:<floorEpochMs>`. Identical inputs → identical job (dedup). */
export function mvRefreshJobId(mvKey: string, requestedAtFloor: Date): string {
  return `mv_refresh:${mvKey}:${requestedAtFloor.getTime()}`;
}

// ── the dispatch request + decision types ─────────────────────────────────────────────────────────────────

/** The contextual fields a demand-path supplies alongside the MV metadata (org + originating event). */
export interface RefreshDispatchRequest {
  readonly mvKey: string;
  readonly triggerKind: ReportRunTriggerKind;
  /** Null for the platform-global MV refresh (the common case). */
  readonly organizationId: string | null;
  /** Set only for `incremental_outbox` (the originating event id → `report_run.trigger_outbox_event_id`). */
  readonly triggerOutboxEventId?: string;
  /** The 0-based BullMQ attempt index forwarded onto the job (alert gating); defaults to 0. */
  readonly retryAttempt?: number;
}

/** Why the dispatcher declined to enqueue (a SKIP is normal control-flow, never an error). */
export type RefreshSkipReason =
  /** No `materialized_view_metadata` row for the key — tolerate (an upstream topic mapped a retired MV). */
  | "mv_unregistered"
  /** The MV is retired — never refresh it. */
  | "mv_retired"
  /** The MV is `suspended` and the trigger is not a manual recovery — leave it stale until manual refresh. */
  | "mv_suspended"
  /** The trigger does not match the MV's tier (e.g. nightly_cron asked for an incremental MV). */
  | "strategy_mismatch"
  /** An incremental event hit a `nightly`-tier MV — the nightly orchestrator owns it (no incremental churn). */
  | "covered_by_nightly"
  /** An `on_demand` MV — refresh/cache populate happens at TILE READ time, never via the queue (§2.5). */
  | "on_demand_read_path";

/** The pure decision: enqueue this job (with its jobId + debounce delay) or skip with a typed reason. */
export type RefreshDispatchDecision =
  | {
      readonly kind: "enqueue";
      readonly job: MvRefreshJob;
      readonly jobId: string;
      readonly debounceMs: number;
    }
  | { readonly kind: "skip"; readonly reason: RefreshSkipReason };

const skip = (reason: RefreshSkipReason): RefreshDispatchDecision => ({ kind: "skip", reason });

/**
 * Decide how to route one refresh demand (PURE, total). Routing matrix (§2.5 / D2):
 *   - unregistered / retired MV         → skip (tolerate / never)
 *   - `nightly_cron`     → only a `nightly` MV enqueues; else `strategy_mismatch`
 *   - `incremental_outbox` → only an `incremental` MV enqueues; a `nightly` MV is `covered_by_nightly`, an
 *                            `on_demand` MV is `on_demand_read_path`
 *   - `on_demand`        → NEVER a queue job (the read path populates the Valkey-cached tile) → skip
 *   - `manual`           → the "Refresh now" button enqueues any non-retired MV (including a `suspended` one,
 *                          to recover it); rate-limiting (1/min/mvKey) is enforced at the route, not here
 * A `suspended` MV is otherwise skipped (left stale until a manual refresh recovers it). On enqueue the job's
 * `requestedAtFloor` is floored to the MV's debounce window and the jobId derived from it (the §2.6 dedup key).
 */
export function decideRefreshDispatch(
  metadata: schema.MaterializedViewMetadata | null,
  request: RefreshDispatchRequest,
  now: Date,
): RefreshDispatchDecision {
  if (metadata === null) return skip("mv_unregistered");
  if (metadata.status === "retired") return skip("mv_retired");

  const strategy = metadata.refreshStrategy;
  switch (request.triggerKind) {
    case "nightly_cron":
      if (strategy !== "nightly") return skip("strategy_mismatch");
      break;
    case "incremental_outbox":
      if (strategy === "nightly") return skip("covered_by_nightly");
      if (strategy === "on_demand") return skip("on_demand_read_path");
      break; // strategy === 'incremental' → proceed
    case "on_demand":
      return skip("on_demand_read_path"); // never queued — the tile read populates the cache (§2.5)
    case "manual":
      break; // any non-retired MV (incl. suspended, to recover it)
  }

  // A suspended MV only refreshes on an explicit manual recovery; auto-triggers leave it stale (§4.8 W-R-06).
  if (metadata.status === "suspended" && request.triggerKind !== "manual") {
    return skip("mv_suspended");
  }

  const requestedAtFloor = floorToDebounceTick(now, metadata.debounceWindowSeconds);
  const job: MvRefreshJob = {
    mvKey: metadata.mvKey,
    triggerKind: request.triggerKind,
    organizationId: request.organizationId,
    requestedAtFloor: requestedAtFloor.toISOString(),
    retryAttempt: request.retryAttempt ?? 0,
    ...(request.triggerOutboxEventId !== undefined
      ? { triggerOutboxEventId: request.triggerOutboxEventId }
      : {}),
  };
  return {
    kind: "enqueue",
    job,
    jobId: mvRefreshJobId(metadata.mvKey, requestedAtFloor),
    debounceMs: Math.max(0, Math.floor(metadata.debounceWindowSeconds) * 1000),
  };
}

// ── the port-injected orchestrator ────────────────────────────────────────────────────────────────────────

/** The ports the dispatcher composes over: read MV metadata + enqueue onto `report.mv_refresh` + a clock. */
export interface MvRefreshDispatcherPorts {
  readonly metadata: Pick<MvMetadataReadPort, "findByKey">;
  readonly queue: MvRefreshQueuePort;
  now(): Date;
}

/** The outcome of one `dispatchMvRefresh`: the enqueued job (+ its queue outcome) or the typed skip. */
export type RefreshDispatchResult =
  | {
      readonly kind: "enqueued";
      readonly job: MvRefreshJob;
      readonly jobId: string;
      readonly outcome: MvRefreshEnqueueOutcome;
    }
  | { readonly kind: "skip"; readonly reason: RefreshSkipReason };

/**
 * Route one refresh demand: read the MV metadata, {@link decideRefreshDispatch}, and (on `enqueue`) push the
 * job onto the `report.mv_refresh` queue with its §2.6 idempotency jobId + debounce delay. A SKIP returns
 * without touching the queue. Thin — all routing logic lives in the pure decider.
 */
export async function dispatchMvRefresh(
  request: RefreshDispatchRequest,
  ports: MvRefreshDispatcherPorts,
): Promise<RefreshDispatchResult> {
  const metadata = await ports.metadata.findByKey(request.mvKey);
  const decision = decideRefreshDispatch(metadata, request, ports.now());
  if (decision.kind === "skip") return decision;
  const outcome = await ports.queue.enqueue(decision.job, {
    jobId: decision.jobId,
    debounceMs: decision.debounceMs,
  });
  return { kind: "enqueued", job: decision.job, jobId: decision.jobId, outcome };
}
