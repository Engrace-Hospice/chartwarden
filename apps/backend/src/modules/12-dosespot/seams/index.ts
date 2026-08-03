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
import type {
  DoseSpotConsentValidator,
  DoseSpotMdmValidator,
  DoseSpotTerminologyValidator,
} from "../routes/service";
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
// TASK-002 — the production Drizzle-backed store (reads under the CONSUMER's ambient RLS context; the
// comfort-kit / cost-basis rollups refuse with a typed DoseSpotSeamGapError until a backing schema exists).
export { DoseSpotSeamGapError, createDrizzleDoseSpotSeamStore } from "./drizzle-store";

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

// ── §4.1 cross-module bindings M12 CONSUMES (not owned) ──────────────────────────────────────────────────
// The medication-order route service "binds" the M38 terminology surface (the RxNorm/NDC code on the order),
// the M40 master-data surface (the prescribing physician + dispensing pharmacy + the prescriber's DEA roster),
// and the M39 consent surface (the §7.8 SUD-treatment-medication disclosure gate). Each is resolved from the
// M1 registry here and injected into the service (seed.terminology / seed.mdm / seed.consent). M38 / M40 are
// already in M12's `dependsOn`; M39's `ConsentEvaluator` is an OPAQUE rich seam (interface in @wardenx/consent,
// `SeamContracts["ConsentEvaluator"] = unknown`) consumed via the M1 registry with NO schema import — so these
// getters narrow to the minimal validator subsets the service uses (the M11 `getOrderMdmValidator` pattern),
// and no new manifest edge is introduced (the seam is already in REQUIRED_SEAMS, owner M39).

/** Resolve the M38 `TerminologyProvider` seam narrowed to the order service's RxNorm/NDC validator. */
export function getDoseSpotTerminologyValidator(): DoseSpotTerminologyValidator {
  return getSeam("TerminologyProvider") as DoseSpotTerminologyValidator;
}

/** Resolve the M40 `MdmEntityProvider` seam narrowed to the order service's physician/pharmacy validator. */
export function getDoseSpotMdmValidator(): DoseSpotMdmValidator {
  return getSeam("MdmEntityProvider") as DoseSpotMdmValidator;
}

/** Resolve the M39 `ConsentEvaluator` seam narrowed to the order service's SUD-medication consent gate. */
export function getDoseSpotConsentValidator(): DoseSpotConsentValidator {
  return getSeam("ConsentEvaluator") as DoseSpotConsentValidator;
}
