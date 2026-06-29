// @wardenx/cost-report — boot-time seam registration + consumed-seam binding (§4.3 / §4.4).
//
// Mirrors M30/M33's M1-bootstrap posture: the SEVEN published-seam contracts are registered into the M1
// SeamRegistry; consumed seams are resolved through it. M27 takes NO `apps/backend` edge here — the
// registry `registerSeam` / `getSeam` surfaces are injected as PORTS, and the composition root binds them
// to the real M1 registry at boot (P3). This file is the single wiring site; it does not touch the
// apps/backend boot graph.
//
// Two halves:
//  1. PUBLISH — `registerM27PublishedSeams` registers M27's seven seams. The live Drizzle/adapter-backed
//     providers are supplied by the caller once the §3 services + adapters are wired (P3).
//  2. CONSUME — the §4.4 consumed-seam names. M26's `CapAccrualReader` is now LIVE (D13): M26 registers
//     `aggregateForCostReport` into the M1 registry and M27 reads it via the cap-context resolver
//     (apps/backend/.../routes/cap-context.ts), fail-closed when M26 is db-unbound. The statistics/settlement
//     binds are now LIVE too: `PatientDaysProvider` (M23 billed-and-accepted census) + `ClaimSettlementProvider`
//     (M25 actual interim payments, 835 CLP04) register into the M1 registry at boot and M27 reads them via the
//     ValidationContextBuilder (degrading to the deny-stub → rule `skip` when db-unbound). `DrugCostBillingReader`
//     (M12 drug-cost basis) stays a FORWARD-SEAM RESERVATION: registered but fail-closed until M12 materializes
//     med-order cost (no cost column today). (`CapPeriodReader` was a forward-declared guess M26 never published.)
import {
  M27_PUBLISHED_SEAM_NAMES,
  type CostReportFilingStatusReader,
  type CostReportMetricsProvider,
  type CostReportProvider,
  type EcrArtifactReader,
  type GustoClientFactory,
  type ValidationResultProvider,
  type XeroClientFactory,
} from "./seams";

/** The M1 SeamRegistry `registerSeam` surface, injected as a port (no apps/backend edge). */
export interface M27SeamRegistrar {
  registerSeam(name: string, impl: unknown): void;
}

/** The live published-seam implementations the composition root supplies once P3 services land. */
export interface M27PublishedSeamImpls {
  costReportProvider: CostReportProvider;
  costReportFilingStatusReader: CostReportFilingStatusReader;
  ecrArtifactReader: EcrArtifactReader;
  validationResultProvider: ValidationResultProvider;
  xeroClientFactory: XeroClientFactory;
  gustoClientFactory: GustoClientFactory;
  costReportMetricsProvider: CostReportMetricsProvider;
}

/** Registers M27's seven published seams into the M1 registry (idempotent at the registry layer). */
export function registerM27PublishedSeams(
  registrar: M27SeamRegistrar,
  impls: M27PublishedSeamImpls,
): void {
  registrar.registerSeam("CostReportProvider", impls.costReportProvider);
  registrar.registerSeam("CostReportFilingStatusReader", impls.costReportFilingStatusReader);
  registrar.registerSeam("EcrArtifactReader", impls.ecrArtifactReader);
  registrar.registerSeam("ValidationResultProvider", impls.validationResultProvider);
  registrar.registerSeam("XeroClientFactory", impls.xeroClientFactory);
  registrar.registerSeam("GustoClientFactory", impls.gustoClientFactory);
  registrar.registerSeam("CostReportMetricsProvider", impls.costReportMetricsProvider);
}

/** Sanity: the publish set matches the §4.3 published-name tuple (asserted in test). */
export const M27_PUBLISHED_SEAMS = M27_PUBLISHED_SEAM_NAMES;

/**
 * The §4.4 consumed-seam names (REQUIRED_SEAMS contract). LIVE producers: M40 / M6 / M8 / M12 / M13 /
 * M38 / M36. FORWARD-SEAM DENY-STUBS today (wire at producer lock): M23 + M26.
 */
export const M27_REQUIRED_SEAMS = [
  // M40 — provider entity + related-party
  "ProviderEntityReader",
  "ExternalPhysicianReader",
  // M6 — service census
  "AdmissionCensusReader",
  "LevelOfCarePeriodReader",
  // M8 — encounter statistics
  "EncounterStatisticsProvider",
  // M12 / M13 — drug-cost basis
  "MedicationOrderProvider",
  "MedicationAdministrationProvider",
  // M23 — billed-and-accepted census patient-days (LIVE: M23 registers PatientDaysProvider into M1)
  "PatientDaysProvider",
  // M25 — actual interim Medicare payments / 835 CLP04 (LIVE: M25 registers ClaimSettlementProvider into M1)
  "ClaimSettlementProvider",
  // M12 — drug-cost basis (RESERVATION deny-stub until M12 materializes med-order cost)
  "DrugCostBillingReader",
  // M26 — cap-period aggregate for the cost-report Worksheet-E cap calc (LIVE: M26 registers
  // `CapAccrualReader.aggregateForCostReport` into the M1 registry; M27 reads it via the cap-context resolver,
  // D13). `CapPeriodReader` was a forward-declared guess and is DROPPED — period resolution folds into the
  // aggregate read (keyed by cap year).
  "CapAccrualReader",
  // M36 — alert delivery
  "AlertDispatcher",
] as const;

/** The forward-seam (deny-stub) consumed names — skipped validation rules surface these as `skip` while the
 *  producer is db-unbound. M26's `CapAccrualReader` + M23's `PatientDaysProvider` + M25's `ClaimSettlementProvider`
 *  are NO LONGER here (they are live producers, registered into the M1 registry at boot); only `DrugCostBillingReader`
 *  (M12) remains forward-declared — a reservation until M12 materializes med-order cost. */
export const M27_FORWARD_SEAM_NAMES = ["DrugCostBillingReader"] as const;

/** Thrown by every forward-seam deny-stub method until the producing module (M23/M26) locks. */
export const SEAM_NOT_BOUND = "SEAM_NOT_BOUND" as const;

/**
 * Builds a fail-closed deny-stub whose every accessed method rejects with `SEAM_NOT_BOUND`. Registered
 * for each forward seam so `validateSeams()` passes (the binding EXISTS) while reads fail-closed. NEVER
 * fails open. Replaced in place when the producing module binds its live provider.
 */
export function makeDenyStub(seamName: string): Record<string, (...args: unknown[]) => never> {
  return new Proxy(
    {},
    {
      get(_t, _prop) {
        return () => {
          throw new Error(`${SEAM_NOT_BOUND}: ${seamName}`);
        };
      },
    },
  ) as Record<string, (...args: unknown[]) => never>;
}
