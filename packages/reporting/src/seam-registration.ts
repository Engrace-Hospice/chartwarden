// @wardenx/reporting — boot-time seam registration + consumed-seam binding (M33 §4.3 / §4.4).
//
// Mirrors M34's seam-registration shape, adapted to M33's M1-bootstrap-registry posture (the M22-style
// path: the published-seam contracts are registered into the M1 SeamRegistry, the consumed seams are
// resolved through it). M33 takes NO `apps/backend` edge, so the registry's `registerSeam` / `getSeam`
// are injected as PORTS — the composition root binds them to the real M1 registry at boot (P2C). This
// file is the single wiring site; it does NOT touch the apps/backend boot graph itself (that lands in P2C).
//
// Two halves:
//  1. PUBLISH — `registerReportingPublishedSeams` registers the three M33 seams (MetricsProvider /
//     DashboardCatalogProvider / ScheduledReportProvider) into the M1 registry. The real Drizzle-backed
//     providers are supplied by the caller once the §3 repositories land (later M33 phase).
//  2. CONSUME — `bindReportingConsumedSeams` assembles the consumed-seam bundle: PRESENT producers'
//     bindings (built by the composition root as adapters over `getSeam`, P2C) merged with the package's
//     forward-seam DENY-STUBS for every ABSENT producer (fail-closed, never fails open — D6/D13).
import type {
  DashboardCatalogProvider,
  MetricsProvider,
  ScheduledReportProvider,
} from "./seams/published";
import {
  denyStubReportingBereavementConsumer,
  denyStubReportingBillingConsumer,
  denyStubReportingCapConsumer,
  denyStubReportingCostReportConsumer,
  denyStubReportingDisciplineConsumer,
  denyStubReportingFhirConsumer,
  denyStubReportingFieldSafetyConsumer,
  denyStubReportingHqrpConsumer,
  denyStubReportingMedicaidConsumer,
  denyStubReportingRemittanceConsumer,
  denyStubReportingSupplyConsumer,
  denyStubReportingTriageConsumer,
} from "./seams/consumed";
import type {
  ReportingAdmissionConsumer,
  ReportingAssessmentConsumer,
  ReportingBereavementConsumer,
  ReportingBillingConsumer,
  ReportingCapConsumer,
  ReportingCarePlanConsumer,
  ReportingConsentConsumer,
  ReportingCostReportConsumer,
  ReportingDisciplineConsumer,
  ReportingDocumentConsumer,
  ReportingEmarConsumer,
  ReportingEncounterConsumer,
  ReportingEvvConsumer,
  ReportingFhirConsumer,
  ReportingFieldSafetyConsumer,
  ReportingHopeConsumer,
  ReportingHqrpConsumer,
  ReportingIdgConsumer,
  ReportingMdmConsumer,
  ReportingMedicaidConsumer,
  ReportingMedicationOrderConsumer,
  ReportingOrderConsumer,
  ReportingPatientConsumer,
  ReportingRemittanceConsumer,
  ReportingSchedulingConsumer,
  ReportingSupplyConsumer,
  ReportingTriageConsumer,
} from "./seams/consumed";

// ── injected ports (the composition root binds these to the real M1 SeamRegistry at boot, P2C) ───────

/** The M1 SeamRegistry `registerSeam` surface, injected as a port so the package takes no apps/backend edge. */
export interface ReportingSeamRegistrar {
  registerSeam(name: string, impl: unknown): void;
}

/** The M1 SeamRegistry `getSeam` surface, injected as a port (used by the P2C adapters over PRESENT producers). */
export interface ReportingSeamResolver {
  getSeam(name: string): unknown;
}

// ── 1. PUBLISH — the three seams M33 registers into the M1 SeamRegistry (§4.3) ───────────────────────

/** The canonical M1-registry seam names M33 publishes (the keys added to the SeamName union in P2C). */
export const REPORTING_PUBLISHED_SEAM_NAMES = [
  "MetricsProvider",
  "DashboardCatalogProvider",
  "ScheduledReportProvider",
] as const;

/** The live published-seam implementations the caller supplies once the §3 repositories land. */
export interface ReportingPublishedSeams {
  readonly metricsProvider: MetricsProvider;
  readonly dashboardCatalogProvider: DashboardCatalogProvider;
  readonly scheduledReportProvider: ScheduledReportProvider;
}

/**
 * Register M33's three published seams into the M1 SeamRegistry through the injected registrar (P2C).
 * Boot-hook stub today: the composition root calls this with the real providers once they are built;
 * `validateSeams()` (the M1 boot gate) then applies fail-closed deny-stubs for any not yet registered (D13).
 */
export function registerReportingPublishedSeams(
  registrar: ReportingSeamRegistrar,
  seams: ReportingPublishedSeams,
): void {
  registrar.registerSeam("MetricsProvider", seams.metricsProvider);
  registrar.registerSeam("DashboardCatalogProvider", seams.dashboardCatalogProvider);
  registrar.registerSeam("ScheduledReportProvider", seams.scheduledReportProvider);
}

// ── 2. CONSUME — the consumed-seam bundle (PRESENT live bindings ⊕ ABSENT forward-seam deny-stubs) ───

/**
 * The PRESENT-producer bindings the composition root supplies at boot (P2C) — each an adapter that
 * resolves the live seam through the injected `getSeam` and projects it to M33's consumer interface.
 * Supplied by the caller (not built here) so the package adds no `getSeam`/apps-backend edge in scaffold.
 */
export interface ReportingPresentSeamBindings {
  readonly patient: ReportingPatientConsumer; // M5
  readonly admission: ReportingAdmissionConsumer; // M6
  readonly carePlan: ReportingCarePlanConsumer; // M7
  readonly encounter: ReportingEncounterConsumer; // M8
  readonly assessment: ReportingAssessmentConsumer; // M9
  readonly hope: ReportingHopeConsumer; // M10
  readonly order: ReportingOrderConsumer; // M11
  readonly medicationOrder: ReportingMedicationOrderConsumer; // M12
  readonly emar: ReportingEmarConsumer; // M13
  readonly idg: ReportingIdgConsumer; // M14
  readonly scheduling: ReportingSchedulingConsumer; // M17
  readonly evv: ReportingEvvConsumer; // M18
  readonly document: ReportingDocumentConsumer; // M22
  readonly consent: ReportingConsentConsumer; // M39
  readonly mdm: ReportingMdmConsumer; // M40
}

/** The full consumed-seam bundle M33's translator/services read through (PRESENT live ⊕ ABSENT deny-stub). */
export interface ReportingConsumedSeams extends ReportingPresentSeamBindings {
  readonly discipline: ReportingDisciplineConsumer; // M15 (forward seam)
  readonly bereavement: ReportingBereavementConsumer; // M16 (forward seam)
  readonly triage: ReportingTriageConsumer; // M19 (forward seam)
  readonly fieldSafety: ReportingFieldSafetyConsumer; // M20 (forward seam)
  readonly supply: ReportingSupplyConsumer; // M21 (forward seam)
  readonly billing: ReportingBillingConsumer; // M23 (forward seam)
  readonly medicaid: ReportingMedicaidConsumer; // M24 (forward seam)
  readonly remittance: ReportingRemittanceConsumer; // M25 (forward seam)
  readonly cap: ReportingCapConsumer; // M26 (forward seam)
  readonly costReport: ReportingCostReportConsumer; // M27 (forward seam)
  readonly fhir: ReportingFhirConsumer; // M28 (forward seam)
  readonly hqrp: ReportingHqrpConsumer; // M30 (forward seam — the spec's only explicit one)
}

/** The package's forward-seam deny-stubs for every ABSENT producer (the fail-closed defaults, §4.4). */
export const REPORTING_FORWARD_SEAM_DENY_STUBS = {
  discipline: denyStubReportingDisciplineConsumer,
  bereavement: denyStubReportingBereavementConsumer,
  triage: denyStubReportingTriageConsumer,
  fieldSafety: denyStubReportingFieldSafetyConsumer,
  supply: denyStubReportingSupplyConsumer,
  billing: denyStubReportingBillingConsumer,
  medicaid: denyStubReportingMedicaidConsumer,
  remittance: denyStubReportingRemittanceConsumer,
  cap: denyStubReportingCapConsumer,
  costReport: denyStubReportingCostReportConsumer,
  fhir: denyStubReportingFhirConsumer,
  hqrp: denyStubReportingHqrpConsumer,
} as const;

/**
 * Assemble the consumed-seam bundle: merge the PRESENT-producer live bindings the composition root
 * supplies (P2C adapters over `getSeam`) with the package's forward-seam DENY-STUBS for every ABSENT
 * producer. A tile bound to a forward seam resolves `{ value: null, isForwardSeamDenyStub: true }` and
 * renders "Not yet available — M<n> required" — never throws, never fails open (D6/D13). When an absent
 * module lands it is moved into `present` and registers its real seam; nothing else here changes.
 */
export function bindReportingConsumedSeams(
  present: ReportingPresentSeamBindings,
): ReportingConsumedSeams {
  return {
    ...present,
    ...REPORTING_FORWARD_SEAM_DENY_STUBS,
  };
}
