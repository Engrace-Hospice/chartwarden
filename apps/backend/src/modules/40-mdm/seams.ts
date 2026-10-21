import type { DbClient } from "@chartwarden/db";
// apps/backend/src/modules/40-mdm/seams.ts — M40-T05 seam registration (spec §4.5).
//
// M40 publishes the `MdmEntityProvider` seam — the master-data read surface every clinical/
// billing/interop module consumes (a patient's attending physician, a claim's payer, an order's
// facility). This module-owned init registers its REAL implementation into the M1 seam registry,
// overwriting the Phase-0 deny-stub; the composition root (apps/backend/src/index.ts
// `wireModuleSeams`) invokes it inside the boot gate, after M1's wireSeams() and before
// validateSeams().
//
// The seam's rich interface lives in @chartwarden/mdm (per-kind `CanonicalFields<K>`/`OverlayFields<K>`
// generics + the merge-redirect shape) — not the leaf @chartwarden/types (`leaves-stay-leaves`). So the
// M1 registry holds the instance opaquely (`SeamContracts["MdmEntityProvider"] = unknown`); this
// file is the typed boundary: `registerMdmSeams` registers the typed impl and `getMdmEntityProvider`
// hands consumers a typed handle. Consumers import the `MdmEntityProvider` TYPE from @chartwarden/mdm
// (they already list 40 in dependsOn) and resolve the runtime instance through here.
//
// SLICE NOTE: the provider is wired over an injected slice-safe in-memory store by default (no live
// DB). Production passes the Drizzle-backed `MdmStore` (T07) via `deps.store`. The §7.2 merge
// redirect is honored either way — it lives in the provider (T04 engine), not the store.
import {
  type BaaStatusProvider,
  type BaaStore,
  type MdmEntityProvider,
  type MdmStore,
  createBaaStatusProvider,
  createInMemoryBaaStore,
  createInMemoryMdmStore,
  createMdmEntityProvider,
} from "@chartwarden/mdm";
import { getSeam, registerSeam } from "../../bootstrap/index";
import { buildGriefResourceReader } from "./grief-resources";
import { buildEmergencyServiceJurisdictionReader } from "./psap-jurisdictions";

/** Injected production adapters for M40's published seams (slice defaults to in-memory). */
export interface MdmSeamDeps {
  /** GAP-158 - with a DB, the `ExternalGriefResourceReader` seam binds the real tenant-curated catalog (M31's
   *  bereaved-portal resources list); without one the deny-stub stands and the portal answers 501. */
  db?: DbClient;
  /** The data port the omnibus `MdmEntityProvider` composes over (Drizzle-backed in production, T07). */
  store?: MdmStore;
  /** The data port the focused `BaaStatusProvider` composes over (Drizzle/Valkey-backed, T07). */
  baaStore?: BaaStore;
}

/**
 * Register M40's published seams into the M1 registry (M40-T05/T06; before validateSeams()). M40
 * publishes TWO boot-validated seams, registered SEPARATELY (§4.6.1): the omnibus
 * `MdmEntityProvider` (chart-load read surface) and the focused `BaaStatusProvider` (the §7.7 as-of
 * disclosure gate M22/M28/M29 consume).
 */
export function registerMdmSeams(deps: MdmSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryMdmStore().store;
  registerSeam("MdmEntityProvider", createMdmEntityProvider(store));

  const baaStore = deps.baaStore ?? createInMemoryBaaStore().store;
  registerSeam("BaaStatusProvider", createBaaStatusProvider(baaStore));

  if (deps.db) registerSeam("ExternalGriefResourceReader", buildGriefResourceReader(deps.db));
  // GAP-032 - M20's SOS terminus resolves the tenant-curated PSAP through this seam; unbound it stays the
  // deny-stub, which the terminus reads as `unavailable` (never `none`).
  if (deps.db) {
    registerSeam(
      "EmergencyServiceJurisdictionReader",
      buildEmergencyServiceJurisdictionReader(deps.db),
    );
  }
}

/**
 * Typed resolver for consumers. The M1 registry stores `MdmEntityProvider` opaquely; this re-applies
 * the type at the M40 boundary (the cast is sound — `registerMdmSeams` registered a real
 * `MdmEntityProvider`, and `validateSeams()` guarantees an instance is present, fail-closed, before
 * any consumer runs).
 */
export function getMdmEntityProvider(): MdmEntityProvider {
  return getSeam("MdmEntityProvider") as MdmEntityProvider;
}

/** Typed resolver for M40's focused `BaaStatusProvider` (M40-T06). Same soundness argument as
 *  {@link getMdmEntityProvider}: `registerMdmSeams` registered a real impl and `validateSeams()`
 *  guarantees an instance (fail-closed) before any consumer runs. M22/M28/M29 resolve through here. */
export function getBaaStatusProvider(): BaaStatusProvider {
  return getSeam("BaaStatusProvider") as BaaStatusProvider;
}
