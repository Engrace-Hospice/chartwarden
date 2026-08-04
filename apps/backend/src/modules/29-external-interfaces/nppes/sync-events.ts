// apps/backend/src/modules/29-external-interfaces/nppes — NPPES sync outbox payloads (M29-T07, §4.7 / §4.10).
// PURE type declarations returned by the orchestrator and published by the composition-root worker (the
// cores never touch the outbox — they describe intent, per the M29 T06 outbound-events precedent).
//
// CONTRACT ALIGNMENT. `provider_synced` / `provider_deactivated` are consumed by M40 —
// `packages/mdm/src/nppes-consumers/apply.ts` (`M29ProviderSyncedPayload` / `M29ProviderDeactivatedPayload`).
// These interfaces MUST stay structurally identical to M40's; ADR-0011 D1 forbids M40 reading M29's
// `nppes_provider` table, so the synced snapshot travels ON the event (`provider`). The four M40-syncable
// fields are `firstName` / `lastName` / `credentials` / `specialtyTaxonomy` (minimum-update, §4.7.1).
import type { Npi, NppesSyncRunId } from "@wardenx/types";

/** The source-of-truth snapshot M40 applies from (never read from M29's table — ADR-0011 D1). */
export interface NppesProviderSnapshot {
  readonly firstName: string;
  readonly lastName: string;
  readonly credentials: string | null;
  readonly specialtyTaxonomy: string | null;
}

/** `m29.nppes.provider_synced` — an inserted/updated cache row (§4.7.1). M40 + M33 consume. */
export interface ProviderSyncedPayload {
  readonly npi: Npi;
  readonly action: "inserted" | "updated";
  /** The per-upsert field-level diff, in M40's syncable vocabulary (empty for `inserted`). */
  readonly changedFields: readonly string[];
  readonly syncedAt: string;
  readonly syncRunId: NppesSyncRunId;
  readonly provider: NppesProviderSnapshot;
}

/** `m29.nppes.provider_deactivated` — an A→D status flip (§4.7.2). M40 flags overlays + M36 alerts. */
export interface ProviderDeactivatedPayload {
  readonly npi: Npi;
  readonly deactivationDate: string;
  readonly deactivationReason: string;
  readonly detectedAt: string;
}

/** `m29.nppes.sync_run.started` — the run opened (§4.10). */
export interface SyncRunStartedPayload {
  readonly syncRunId: NppesSyncRunId;
  readonly kind: string;
  readonly triggeredBy: string;
  readonly startedAt: string;
}

/** `m29.nppes.sync_run.completed` — the run finished walking every NPI (§4.10). */
export interface SyncRunCompletedPayload {
  readonly syncRunId: NppesSyncRunId;
  readonly completedAt: string;
  readonly providersFetched: number;
  readonly providersUpdated: number;
  readonly deactivations: number;
  readonly errors: number;
}

/** `m29.nppes.sync_run.failed` — the run aborted (circuit breaker / fatal, §4.10). */
export interface SyncRunFailedPayload {
  readonly syncRunId: NppesSyncRunId;
  readonly failedAt: string;
  readonly error: string;
  readonly providersFetched: number;
  readonly providersUpdated: number;
  readonly errors: number;
}

/** The M29 NPPES-sync outbox events (§4.10). The worker publishes each `{ name, payload }` verbatim. */
export type NppesOutboxEvent =
  | { readonly name: "m29.nppes.provider_synced"; readonly payload: ProviderSyncedPayload }
  | {
      readonly name: "m29.nppes.provider_deactivated";
      readonly payload: ProviderDeactivatedPayload;
    }
  | { readonly name: "m29.nppes.sync_run.started"; readonly payload: SyncRunStartedPayload }
  | { readonly name: "m29.nppes.sync_run.completed"; readonly payload: SyncRunCompletedPayload }
  | { readonly name: "m29.nppes.sync_run.failed"; readonly payload: SyncRunFailedPayload };

/** The outbox sink the orchestrator publishes through (the real worker binds the M1 D8 transactional outbox). */
export interface NppesOutboxSink {
  publish(event: NppesOutboxEvent): Promise<void>;
}
