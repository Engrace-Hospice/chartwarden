// apps/backend/src/modules/29-external-interfaces/nppes — the NPPES sync orchestrator (M29-T07, §4.4, W-XI-11/12).
// The nightly (and manual) platform-role job: collect the distinct NPIs every tenant references, fetch each
// from the public CMS registry, diff against the cache, persist, and emit the per-provider + per-run outbox
// events. Every IO edge is an INJECTED port (mirroring the T03 listener supervisor), so the orchestration is
// unit-testable with fakes; the M29-T08 worker wires the M40 NPI source, the Drizzle cache/sync-run stores,
// the M1 D8 outbox, and the `NppesClient` into these ports.
//
// D11 / W-XI-12 — NPPES is PLATFORM-SHARED public data. The whole run executes in platform context (the
// stores use `withPlatformContext` in the real wiring) and a TENANT-scoped trigger is REFUSED: a manual sync
// may only be initiated by a platform actor (`platform_admin`), never from within an org context.
import type { Npi, NppesSyncKind, NppesSyncRunId, NppesSyncTrigger } from "@wardenx/types";
import type { NppesFetchPort } from "./nppes-client";
import { type ProviderCachePort, toSnapshot } from "./provider-cache";
import type { NppesFetchResult } from "./response-projection";
import type { NppesOutboxSink } from "./sync-events";

/** §2.3 — consecutive per-NPI failures that trip the circuit breaker and fail the run (mirrors the listener). */
export const NPPES_CIRCUIT_BREAKER_CONSECUTIVE_FAILURES = 50;
/** Flush the `nppes_sync_run` progress counters to the store every this-many NPIs. */
export const NPPES_CHECKPOINT_EVERY = 50;

/** A tenant/org actor attempted to trigger the platform NPPES sync (W-XI-12). Refused, never runs. */
export class NppesTenantTriggerRefusedError extends Error {
  constructor() {
    super("nppes_sync_is_platform_only");
    this.name = "NppesTenantTriggerRefusedError";
  }
}

/** The scope the trigger was initiated in — only `platform` may run the sync (W-XI-12). */
export type NppesTriggerScope = "platform" | "tenant";

export interface NppesSyncRequest {
  readonly kind: NppesSyncKind;
  readonly triggeredBy: NppesSyncTrigger;
  readonly triggerScope: NppesTriggerScope;
  /** The platform actor for a manual (`platform_admin`) run; null for a cron run. */
  readonly triggeredByMembershipId: string | null;
}

/** The NPI source (§7 — distinct NPIs across every tenant's M40 `external_physician`, resolved at T08). */
export interface NppesNpiSourcePort {
  collectDistinctNpis(): Promise<readonly Npi[]>;
}

export interface SyncRunCounts {
  readonly providersFetchedCount: number;
  readonly providersUpdatedCount: number;
  readonly providersDeactivatedCount: number;
  readonly errorsCount: number;
}

/** The `nppes_sync_run` store — the orchestration log (§3.3). Platform-scoped in the real wiring. */
export interface NppesSyncRunStorePort {
  open(run: {
    readonly id: NppesSyncRunId;
    readonly kind: NppesSyncKind;
    readonly triggeredBy: NppesSyncTrigger;
    readonly triggeredByMembershipId: string | null;
    readonly startedAt: Date;
  }): Promise<void>;
  updateCounts(id: NppesSyncRunId, counts: SyncRunCounts): Promise<void>;
  markComplete(id: NppesSyncRunId, counts: SyncRunCounts, completedAt: Date): Promise<void>;
  markFailed(
    id: NppesSyncRunId,
    error: string,
    counts: SyncRunCounts,
    completedAt: Date,
  ): Promise<void>;
}

export interface SyncOrchestratorDeps {
  readonly npiSource: NppesNpiSourcePort;
  readonly fetcher: NppesFetchPort;
  readonly cache: ProviderCachePort;
  readonly runStore: NppesSyncRunStorePort;
  readonly outbox: NppesOutboxSink;
  readonly now: () => Date;
  readonly newSyncRunId: () => NppesSyncRunId;
  readonly log?: (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}

export interface SyncResult {
  readonly syncRunId: NppesSyncRunId;
  readonly status: "completed" | "failed";
  readonly providersFetched: number;
  readonly providersUpdated: number;
  readonly providersUnchanged: number;
  readonly providersNotFound: number;
  readonly providersOrganization: number;
  readonly providersInvalid: number;
  readonly deactivations: number;
  readonly errors: number;
}

interface Accumulator {
  fetched: number;
  updated: number;
  unchanged: number;
  notFound: number;
  organization: number;
  invalid: number;
  deactivations: number;
  errors: number;
}

export class NppesSyncOrchestrator {
  constructor(private readonly deps: SyncOrchestratorDeps) {}

  /** Run one NPPES sync. Refuses a tenant-scoped trigger (W-XI-12) before touching any store. */
  async run(request: NppesSyncRequest): Promise<SyncResult> {
    if (request.triggerScope !== "platform") {
      // Fail CLOSED before opening a sync_run row — a tenant actor never reaches the API.
      throw new NppesTenantTriggerRefusedError();
    }

    const syncRunId = this.deps.newSyncRunId();
    const startedAt = this.deps.now();
    const agg: Accumulator = {
      fetched: 0,
      updated: 0,
      unchanged: 0,
      notFound: 0,
      organization: 0,
      invalid: 0,
      deactivations: 0,
      errors: 0,
    };

    await this.deps.runStore.open({
      id: syncRunId,
      kind: request.kind,
      triggeredBy: request.triggeredBy,
      triggeredByMembershipId: request.triggeredByMembershipId,
      startedAt,
    });
    await this.deps.outbox.publish({
      name: "m29.nppes.sync_run.started",
      payload: {
        syncRunId,
        kind: request.kind,
        triggeredBy: request.triggeredBy,
        startedAt: startedAt.toISOString(),
      },
    });

    try {
      const npis = await this.deps.npiSource.collectDistinctNpis();
      this.log("info", "nppes.sync.collected_npis", { syncRunId, npiCount: npis.length });

      let consecutiveFailures = 0;
      let sinceCheckpoint = 0;

      for (const npi of npis) {
        try {
          const result = await this.deps.fetcher.fetchByNpi(npi);
          consecutiveFailures = 0;
          await this.handleResult(syncRunId, npi, result, agg);
        } catch (err) {
          agg.errors += 1;
          consecutiveFailures += 1;
          this.log("warn", "nppes.sync.npi_error", { npi, error: (err as Error).message });
          if (consecutiveFailures >= NPPES_CIRCUIT_BREAKER_CONSECUTIVE_FAILURES) {
            return await this.fail(
              syncRunId,
              `circuit_breaker_${consecutiveFailures}_consecutive_failures`,
              agg,
            );
          }
        }

        if (++sinceCheckpoint >= NPPES_CHECKPOINT_EVERY) {
          await this.deps.runStore.updateCounts(syncRunId, this.counts(agg));
          sinceCheckpoint = 0;
        }
      }

      // TOTAL-OUTAGE FLOOR (GAP-045). The §2.3 breaker only trips at
      // NPPES_CIRCUIT_BREAKER_CONSECUTIVE_FAILURES consecutive errors, so on a platform referencing fewer
      // NPIs than that a CMS outage that failed EVERY single fetch would otherwise have walked out of the
      // loop and reported `completed` — green status, zero providers touched, the failure visible only to
      // whoever thought to read `errors_count`. A run in which nothing succeeded did not complete.
      if (npis.length > 0 && agg.errors === npis.length) {
        return await this.fail(syncRunId, `every_npi_failed_${agg.errors}_of_${npis.length}`, agg);
      }
      return await this.complete(syncRunId, agg);
    } catch (err) {
      this.log("error", "nppes.sync.fatal", { syncRunId, error: (err as Error).message });
      return await this.fail(syncRunId, (err as Error).message, agg);
    }
  }

  private async handleResult(
    syncRunId: NppesSyncRunId,
    npi: Npi,
    result: NppesFetchResult,
    agg: Accumulator,
  ): Promise<void> {
    switch (result.kind) {
      case "invalid_format":
        agg.invalid += 1;
        return;
      case "organization_skipped":
        agg.organization += 1;
        return;
      case "not_found":
        agg.notFound += 1;
        this.log("info", "nppes.sync.npi_not_found", { npi });
        return;
      case "found":
      case "deactivated": {
        agg.fetched += 1;
        const now = this.deps.now();
        const decision = await this.deps.cache.upsert(result.provider, now);

        // A→D flip → the deactivation event (M40 flags overlays; M36 alerts). Only on a real transition.
        if (
          result.kind === "deactivated" &&
          decision.priorStatus !== "deactivated" &&
          decision.newStatus === "deactivated"
        ) {
          agg.deactivations += 1;
          await this.deps.outbox.publish({
            name: "m29.nppes.provider_deactivated",
            payload: {
              npi,
              deactivationDate: result.provider.deactivationDate ?? now.toISOString().slice(0, 10),
              deactivationReason: result.provider.deactivationReason ?? "UNKNOWN",
              detectedAt: now.toISOString(),
            },
          });
        }

        if (decision.action === "unchanged") {
          agg.unchanged += 1;
          return;
        }
        agg.updated += 1;
        await this.deps.outbox.publish({
          name: "m29.nppes.provider_synced",
          payload: {
            npi,
            action: decision.action,
            changedFields: decision.changedFields,
            syncedAt: now.toISOString(),
            syncRunId,
            provider: toSnapshot(result.provider),
          },
        });
        return;
      }
    }
  }

  private async complete(syncRunId: NppesSyncRunId, agg: Accumulator): Promise<SyncResult> {
    const completedAt = this.deps.now();
    await this.deps.runStore.markComplete(syncRunId, this.counts(agg), completedAt);
    await this.deps.outbox.publish({
      name: "m29.nppes.sync_run.completed",
      payload: {
        syncRunId,
        completedAt: completedAt.toISOString(),
        providersFetched: agg.fetched,
        providersUpdated: agg.updated,
        deactivations: agg.deactivations,
        errors: agg.errors,
      },
    });
    this.log("info", "nppes.sync.completed", { syncRunId, ...this.counts(agg) });
    return this.result(syncRunId, "completed", agg);
  }

  private async fail(
    syncRunId: NppesSyncRunId,
    error: string,
    agg: Accumulator,
  ): Promise<SyncResult> {
    const failedAt = this.deps.now();
    await this.deps.runStore.markFailed(syncRunId, error, this.counts(agg), failedAt);
    await this.deps.outbox.publish({
      name: "m29.nppes.sync_run.failed",
      payload: {
        syncRunId,
        failedAt: failedAt.toISOString(),
        error,
        providersFetched: agg.fetched,
        providersUpdated: agg.updated,
        errors: agg.errors,
      },
    });
    this.log("error", "nppes.sync.failed", { syncRunId, error, ...this.counts(agg) });
    return this.result(syncRunId, "failed", agg);
  }

  private counts(agg: Accumulator): SyncRunCounts {
    return {
      providersFetchedCount: agg.fetched,
      providersUpdatedCount: agg.updated,
      providersDeactivatedCount: agg.deactivations,
      errorsCount: agg.errors,
    };
  }

  private result(
    syncRunId: NppesSyncRunId,
    status: "completed" | "failed",
    agg: Accumulator,
  ): SyncResult {
    return {
      syncRunId,
      status,
      providersFetched: agg.fetched,
      providersUpdated: agg.updated,
      providersUnchanged: agg.unchanged,
      providersNotFound: agg.notFound,
      providersOrganization: agg.organization,
      providersInvalid: agg.invalid,
      deactivations: agg.deactivations,
      errors: agg.errors,
    };
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.deps.log?.(level, event, fields);
  }
}
