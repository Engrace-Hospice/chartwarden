import type { schema } from "@wardenx/db";
// @wardenx/reporting · refresh — the NIGHTLY tier orchestrator (M33 §2.5 / §4.8 / D2).
//
// The cron-fired orchestrator for slow-changing aggregates: at 02:00 tenant-local (the boot scheduler owns
// the tenant-TZ cron tick via M2; this handler owns the work) it enqueues a `report.mv_refresh` job
// (`trigger_kind='nightly_cron'`) for every ACTIVE `materialized_view_metadata` row whose
// `refresh_strategy='nightly'`. The `report_mv.*` views are platform-global (one MV holds every org's RLS-
// filtered rows), so a nightly refresh is org-agnostic (`organizationId=null`) — one REFRESH covers all
// tenants. Each enqueue flows through the shared {@link decideRefreshDispatch} so the strategy guard +
// §2.6 debounce/idempotency apply uniformly with the incremental tier.
//
// PURE: {@link selectNightlyTargets} is the pure work-set filter; {@link runNightlyRefresh} is the thin
// port-injected orchestrator. No clock-derived scheduling here — the cron cadence is the boot scheduler's job.
import { type RefreshDispatchResult, decideRefreshDispatch } from "./dispatcher";
import type { MvMetadataReadPort, MvRefreshQueuePort } from "./ports";

/** §4.8: the nightly orchestrator fires at 02:00 tenant-local (the boot scheduler registers this cron). */
export const NIGHTLY_REFRESH_CRON = "0 2 * * *" as const;

/**
 * The nightly work-set (PURE): the `mv_key`s of the ACTIVE, `nightly`-strategy MVs. A `suspended`/`retired`
 * MV is excluded (a suspended MV recovers only via a manual refresh, §4.8). Defensive — the metadata read
 * port already filters by strategy, but a belt-and-braces filter keeps the selection total + unit-testable.
 */
export function selectNightlyTargets(
  mvs: readonly schema.MaterializedViewMetadata[],
): readonly string[] {
  return mvs
    .filter((mv) => mv.refreshStrategy === "nightly" && mv.status === "active")
    .map((mv) => mv.mvKey);
}

/** The ports the nightly orchestrator composes over: list the nightly MVs + enqueue + a clock. */
export interface NightlyRefreshPorts {
  readonly metadata: Pick<MvMetadataReadPort, "listActiveByStrategy">;
  readonly queue: MvRefreshQueuePort;
  now(): Date;
}

/** What the nightly pass enqueued: the dispatch result per nightly MV (the cron tick's telemetry). */
export interface NightlyRefreshReport {
  readonly targets: readonly string[];
  readonly dispatches: readonly RefreshDispatchResult[];
}

/**
 * Run one nightly refresh pass (§2.5): list the active `nightly`-strategy MVs and enqueue a `nightly_cron`
 * refresh per MV through the shared dispatcher decision (so the debounce floor + §2.6 idempotency jobId apply
 * — a double cron fire collapses onto the same job). `organizationId=null`: the platform-global MV refresh
 * covers every tenant in one REFRESH. Thin — the dispatch decision + the enqueue are the only effects.
 */
export async function runNightlyRefresh(ports: NightlyRefreshPorts): Promise<NightlyRefreshReport> {
  const mvs = await ports.metadata.listActiveByStrategy("nightly");
  const targets = selectNightlyTargets(mvs);
  const now = ports.now();
  const dispatches: RefreshDispatchResult[] = [];

  for (const mv of mvs) {
    if (mv.refreshStrategy !== "nightly" || mv.status !== "active") continue;
    const decision = decideRefreshDispatch(
      mv,
      { mvKey: mv.mvKey, triggerKind: "nightly_cron", organizationId: null },
      now,
    );
    if (decision.kind === "skip") {
      dispatches.push(decision);
      continue;
    }
    const outcome = await ports.queue.enqueue(decision.job, {
      jobId: decision.jobId,
      debounceMs: decision.debounceMs,
    });
    dispatches.push({ kind: "enqueued", job: decision.job, jobId: decision.jobId, outcome });
  }

  return { targets, dispatches };
}
