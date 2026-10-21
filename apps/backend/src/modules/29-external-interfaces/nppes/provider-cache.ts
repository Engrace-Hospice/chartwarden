// apps/backend/src/modules/29-external-interfaces/nppes — NPPES provider-cache diff (M29-T07, §3, §4.7.1).
// PURE. Decides how a freshly-fetched provider applies to the currently-cached row: `inserted` (no prior
// row), `unchanged` (no M40-syncable field differs — touch `fetched_at` only, emit nothing), or `updated`
// (with the field-level `changedFields` diff in M40's vocabulary). The real Drizzle upsert (M29-T08) calls
// `decideCacheUpsert` then materialises `buildProviderRow` under `withPlatformContext` (platform-shared, D11).
//
// `nppes_provider` has no `profile_hash`/`last_processed_npi` column (schema is fixed at 11 tables) — the
// diff is a direct field comparison over the M40-syncable projection, not a stored hash.
import type { NewNppesProviderRow } from "@chartwarden/db/schema";
import type { NppesProviderStatus } from "@chartwarden/types";
import { type NppesIndividualProvider, primaryTaxonomyCode } from "./response-projection";
import type { NppesProviderSnapshot } from "./sync-events";

/** The minimal view of a cached row the diff reads (the Drizzle adapter maps a row → this). */
export interface CachedProviderView {
  readonly status: NppesProviderStatus;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly specialtyTaxonomy: string | null;
  readonly deactivationDate: string | null;
  readonly deactivationReason: string | null;
}

/** The pure upsert decision. `changedFields` uses M40's syncable vocabulary so its consumer can react. */
export interface CacheUpsertDecision {
  readonly action: "inserted" | "updated" | "unchanged";
  readonly changedFields: readonly string[];
  readonly priorStatus: NppesProviderStatus | null;
  readonly newStatus: NppesProviderStatus;
}

/** The port the orchestrator upserts through (the real impl runs `decideCacheUpsert` + `buildProviderRow`). */
export interface ProviderCachePort {
  upsert(provider: NppesIndividualProvider, fetchedAt: Date): Promise<CacheUpsertDecision>;
}

/** M40's four syncable fields plus `status` — the diff surface (§4.7.1). */
export function decideCacheUpsert(
  existing: CachedProviderView | null,
  fresh: NppesIndividualProvider,
): CacheUpsertDecision {
  if (existing === null) {
    return { action: "inserted", changedFields: [], priorStatus: null, newStatus: fresh.status };
  }

  const changed: string[] = [];
  if (existing.status !== fresh.status) changed.push("status");
  if (existing.firstName !== fresh.basic.firstName) changed.push("firstName");
  if (existing.lastName !== fresh.basic.lastName) changed.push("lastName");
  if (existing.credential !== fresh.basic.credential) changed.push("credentials");
  if (existing.specialtyTaxonomy !== primaryTaxonomyCode(fresh)) changed.push("specialtyTaxonomy");
  if (existing.deactivationDate !== fresh.deactivationDate) changed.push("deactivationDate");
  if (existing.deactivationReason !== fresh.deactivationReason) changed.push("deactivationReason");

  if (changed.length === 0) {
    return {
      action: "unchanged",
      changedFields: [],
      priorStatus: existing.status,
      newStatus: fresh.status,
    };
  }
  return {
    action: "updated",
    changedFields: changed,
    priorStatus: existing.status,
    newStatus: fresh.status,
  };
}

/** The M40-facing snapshot carried on `m29.nppes.provider_synced` (ADR-0011 D1 — never a table read). */
export function toSnapshot(provider: NppesIndividualProvider): NppesProviderSnapshot {
  return {
    firstName: provider.basic.firstName,
    lastName: provider.basic.lastName,
    credentials: provider.basic.credential,
    specialtyTaxonomy: primaryTaxonomyCode(provider),
  };
}

/** Materialise the full `nppes_provider` insert/update row from a fresh projection (§3.3). */
export function buildProviderRow(
  provider: NppesIndividualProvider,
  fetchedAt: Date,
): NewNppesProviderRow {
  return {
    npi: provider.npi,
    enumerationType: provider.enumerationType,
    status: provider.status,
    deactivationDate: provider.deactivationDate,
    deactivationReason: provider.deactivationReason,
    reactivationDate: provider.reactivationDate,
    basic: provider.basic,
    addresses: provider.addresses,
    taxonomies: provider.taxonomies,
    identifiers: provider.identifiers,
    endpoints: [],
    lastUpdatedInNppes: provider.lastUpdated,
    fetchedAt,
  };
}
