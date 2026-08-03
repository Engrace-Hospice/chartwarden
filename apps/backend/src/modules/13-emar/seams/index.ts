// apps/backend/src/modules/13-emar/seams — M13's published §2.12 D16 owned seams (M13-T07). M13 publishes TWO
// leaf-typed READ surfaces forward consumers attach to instead of importing M13's schema (architecture §25.15
// blocks the schema import): `MedicationAdministrationProvider` — the administration read path M14 (IDG
// "administrations since last meeting"), M28 (FHIR `MedicationAdministration`), M30 (PRN-effectiveness /
// missed-dose / comfort-kit-timeliness measures), M31 (portal lay-language summary, SUD-redacted), M33
// (dashboards), M37 (IPU IV-pump overlay) consume — and `ReconciliationProvider` — the reconciliation-worksheet
// read path M14 (IDG packet) and M30 (reconciliation-timeliness measure) consume. `registerEmarSeams` registers
// both real impls over their boot deny-stubs (before validateSeams()), driven from the composition root's
// wireModuleSeams(). Both share ONE injected EmarSeamStore (in-memory slice here; Drizzle in prod, reads under
// the consumer's RLS) — mirrors the M9/M10/M11/M12 seams/index.ts precedents. Neither seam is a mutate path: M13
// owns the administration + reconciliation lifecycle internally.
import type {
  MedicationAdministrationProvider,
  ReconciliationProvider,
  ScaleType,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createMedicationAdministrationProvider, createReconciliationProvider } from "./providers";
import { type EmarSeamStore, createInMemoryEmarSeamStore } from "./store";

export {
  type ComfortKitAdministrationTimeline,
  type DoseScheduleRow,
  type DoseScheduleSeedRow,
  type EmarSeamSeed,
  type EmarSeamStore,
  type IvContinuousSessionRow,
  type PrnEffectivenessRow,
  type PrnEffectivenessSeedRow,
  type ReconciliationTimelinessAnchor,
  createInMemoryEmarSeamStore,
} from "./store";
export {
  createMedicationAdministrationProvider,
  createReconciliationProvider,
} from "./providers";
// TASK-002 — the FULL production Drizzle-backed store (per-consumer reads under the ambient request RLS
// context; the two org-aggregate measure reads self-scope on their explicit organizationId).
export { createDrizzleEmarSeamStore } from "./drizzle-store";
// M13-T09 — the M31 caregiver-attested-portal FORWARD seam (deny-stub; §2.9 D10). M31's authenticated portal
// session resolver is not built (later wave); M13 declares the contract + ships a fail-closed deny-stub. NOT
// wired into the M1 registry and adds NO dependsOn edge (the M12 M28-publisher deny-stub precedent).
export {
  type CaregiverPortalSessionResolution,
  type CaregiverPortalSessionResolver,
  denyStubCaregiverPortalSessionResolver,
} from "./m31-caregiver-attested-portal";

/** Deps for M13's owned-seam registration (slice defaults to the in-memory store). */
export interface EmarSeamDeps {
  /** The §2.12 data port (Drizzle over M13's tables in prod; in-memory slice in tests). */
  store?: EmarSeamStore;
}

/**
 * Register M13's two §2.12 D16 owned seams into the M1 registry over their boot deny-stubs (M13-T07; before
 * validateSeams()). Both share one {@link EmarSeamStore} so a single Drizzle adapter backs the whole
 * administration + reconciliation read surface. Called by the composition root's wireModuleSeams().
 */
export function registerEmarSeams(deps: EmarSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryEmarSeamStore().store;
  // M13 consumes M9's ScaleSeriesProvider OPAQUELY (getSeam, no schema import / no dependsOn edge) to decide
  // whether a PRN reassessment was documented — resolved LAZILY per call so seam-registration order is
  // irrelevant and an unbound M9 (boot deny-stub) throws → the prn-effectiveness measure suppresses.
  const reassessmentCoverage = {
    async wasReassessed(patientId: string, scaleType: string, fromIso: string, toIso: string) {
      // `scaleType` is one of M13's recommended reassessment scales (a ScaleType value); the obligation
      // query only surfaces rows that carry one, so the cast is sound.
      const series = await getSeam("ScaleSeriesProvider").series(
        patientId,
        scaleType as ScaleType,
        fromIso,
        toIso,
      );
      return series.points.length > 0;
    },
  };
  registerSeam(
    "MedicationAdministrationProvider",
    createMedicationAdministrationProvider(store, { reassessmentCoverage }),
  );
  registerSeam("ReconciliationProvider", createReconciliationProvider(store));
}

/** Typed resolver for M13's MedicationAdministrationProvider (M14/M28/M30/M31/M33/M37 consume the read seam). */
export function getMedicationAdministrationProvider(): MedicationAdministrationProvider {
  return getSeam("MedicationAdministrationProvider");
}

/** Typed resolver for M13's ReconciliationProvider (M14/M30 consume the read seam). */
export function getReconciliationProvider(): ReconciliationProvider {
  return getSeam("ReconciliationProvider");
}
