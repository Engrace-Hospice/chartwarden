// apps/backend/src/modules/12-dosespot/seams — M12's published §2.10 D17 owned seams (M12-T07). M12 publishes
// TWO leaf-typed READ surfaces forward consumers attach to instead of importing M12's schema (architecture
// §25.15 blocks the schema import): `MedicationOrderProvider` — the medication-order read path M13 (eMAR
// administration context), M14 (IDG packet), M19/M30/M33 (derived signals + cost + quality), M28 (FHIR
// `MedicationRequest`), M31 (portal lay-language summary) consume — and `RefillInboxProvider` — the
// refill-request inbox read path the prescriber UI, M19 (on-call), and M33 (SLA dashboards) consume.
// `registerDoseSpotSeams` registers both real impls over their boot deny-stubs (before validateSeams()),
// driven from the composition root's wireModuleSeams(). Both share ONE injected DoseSpotSeamStore (in-memory
// slice here; Drizzle in prod, reads under the consumer's RLS) — mirrors the M9/M10/M11 seams/index.ts
// precedents. Neither seam is a mutate path: M12 owns the medication-order lifecycle internally.
import type { MedicationOrderProvider, RefillInboxProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createMedicationOrderProvider, createRefillInboxProvider } from "./providers";
import { type DoseSpotSeamStore, createInMemoryDoseSpotSeamStore } from "./store";

export {
  type ComfortKitTimeline,
  type CostBasisRow,
  type DoseSpotSeamSeed,
  type DoseSpotSeamStore,
  createInMemoryDoseSpotSeamStore,
} from "./store";
export { createMedicationOrderProvider, createRefillInboxProvider } from "./providers";

/** Deps for M12's owned-seam registration (slice defaults to the in-memory store). */
export interface DoseSpotSeamDeps {
  /** The §2.10 data port (Drizzle over M12's tables in prod; in-memory slice in tests). */
  store?: DoseSpotSeamStore;
}

/**
 * Register M12's two §2.10 D17 owned seams into the M1 registry over their boot deny-stubs (M12-T07; before
 * validateSeams()). Both share one {@link DoseSpotSeamStore} so a single Drizzle adapter backs the whole
 * medication-order/refill read surface. Called by the composition root's wireModuleSeams().
 */
export function registerDoseSpotSeams(deps: DoseSpotSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryDoseSpotSeamStore().store;
  registerSeam("MedicationOrderProvider", createMedicationOrderProvider(store));
  registerSeam("RefillInboxProvider", createRefillInboxProvider(store));
}

/** Typed resolver for M12's MedicationOrderProvider (M13/M14/M19/M28/M30/M31/M33 consume the read seam). */
export function getMedicationOrderProvider(): MedicationOrderProvider {
  return getSeam("MedicationOrderProvider");
}

/** Typed resolver for M12's RefillInboxProvider (the prescriber inbox UI + M19/M33 consume the read seam). */
export function getRefillInboxProvider(): RefillInboxProvider {
  return getSeam("RefillInboxProvider");
}
