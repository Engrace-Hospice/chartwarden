// @wardenx/quality — boot-time seam registration + consumed-seam binding (M30 §4.3 / §4.4).
//
// Mirrors M33's M1-bootstrap-registry posture: the FIVE published-seam contracts are registered into the
// M1 SeamRegistry; the consumed seams are resolved through it (`getSeam`). M30 takes NO `apps/backend`
// edge here — the registry's `registerSeam` / `getSeam` are injected as PORTS, and the composition root
// binds them to the real M1 registry at boot (P2C). This file is the single wiring site; it does NOT
// touch the apps/backend boot graph itself (that lands in the Integrate phase).
//
// Two halves:
//  1. PUBLISH — `registerQualityPublishedSeams` registers M30's five seams (QualityMeasureProvider /
//     IncidentRegisterProvider / QapiProjectProvider / ComplianceStatusProvider /
//     SecurityRiskAssessmentReader) into the M1 registry. The live Drizzle-backed providers
//     (`seams/published/*`) are supplied by the caller once the §3 repositories are wired (P2C).
//  2. CONSUME — `bindQualityConsumedSeams` assembles the consumed-seam bundle: the PRESENT producers'
//     bindings (built by the composition root as adapters over `getSeam`, P2C) merged with the package's
//     forward-seam DENY-STUBS for every ABSENT producer (fail-closed, never fails open — D6 / D13).
import { M30_PUBLISHED_SEAM_NAMES } from "./seams";
import type {
  ComplianceStatusProvider,
  IncidentRegisterProvider,
  QapiProjectProvider,
  QualityMeasureProvider,
  SecurityRiskAssessmentReader,
} from "./seams";
import {
  denyStubQualityBereavementConsumer,
  denyStubQualityBillingConsumer,
  denyStubQualityCostReportConsumer,
  denyStubQualityDisciplineConsumer,
} from "./seams/consumed";
import type {
  QualityAdmissionConsumer,
  QualityAssessmentConsumer,
  QualityBereavementConsumer,
  QualityBillingConsumer,
  QualityCarePlanConsumer,
  QualityCostReportConsumer,
  QualityDisciplineConsumer,
  QualityEncounterConsumer,
  QualityEvvConsumer,
  QualityHopeConsumer,
  QualityIdgConsumer,
  QualityMedicationAdministrationConsumer,
  QualityMedicationOrderConsumer,
  QualityMetricsConsumer,
  QualityOrderConsumer,
  QualityPatientConsumer,
  QualitySchedulingConsumer,
} from "./seams/consumed";

// ── injected ports (the composition root binds these to the real M1 SeamRegistry at boot, P2C) ───────

/** The M1 SeamRegistry `registerSeam` surface, injected as a port so the package takes no apps/backend edge. */
export interface QualitySeamRegistrar {
  registerSeam(name: string, impl: unknown): void;
}

/** The M1 SeamRegistry `getSeam` surface, injected as a port (used by the P2C adapters over PRESENT producers). */
export interface QualitySeamResolver {
  getSeam(name: string): unknown;
}

// ── 1. PUBLISH — the FIVE seams M30 registers into the M1 SeamRegistry (§4.3) ────────────────────────

/** The canonical M1-registry seam names M30 publishes (re-exported from `./seams` — single source of truth). */
export const QUALITY_PUBLISHED_SEAM_NAMES = M30_PUBLISHED_SEAM_NAMES;

/** The live published-seam implementations the caller supplies once the §3 repositories are wired (P2C). */
export interface QualityPublishedSeams {
  readonly qualityMeasureProvider: QualityMeasureProvider;
  readonly incidentRegisterProvider: IncidentRegisterProvider;
  readonly qapiProjectProvider: QapiProjectProvider;
  readonly complianceStatusProvider: ComplianceStatusProvider;
  readonly securityRiskAssessmentReader: SecurityRiskAssessmentReader;
}

/**
 * Register M30's five published seams into the M1 SeamRegistry through the injected registrar (P2C).
 * Boot-hook today: the composition root calls this with the real providers once they are built;
 * `validateSeams()` (the M1 boot gate) then applies fail-closed deny-stubs for any not yet registered (D13).
 */
export function registerQualityPublishedSeams(
  registrar: QualitySeamRegistrar,
  seams: QualityPublishedSeams,
): void {
  registrar.registerSeam("QualityMeasureProvider", seams.qualityMeasureProvider);
  registrar.registerSeam("IncidentRegisterProvider", seams.incidentRegisterProvider);
  registrar.registerSeam("QapiProjectProvider", seams.qapiProjectProvider);
  registrar.registerSeam("ComplianceStatusProvider", seams.complianceStatusProvider);
  registrar.registerSeam("SecurityRiskAssessmentReader", seams.securityRiskAssessmentReader);
}

// ── 2. CONSUME — the consumed-seam bundle (PRESENT live bindings ⊕ ABSENT forward-seam deny-stubs) ───

/**
 * The PRESENT-producer bindings the composition root supplies at boot (P2C) — each an adapter that
 * resolves the live seam through the injected `getSeam` and projects it to M30's consumer interface.
 * Supplied by the caller (not built here) so the package adds no `getSeam`/apps-backend edge in scaffold.
 * (M33 is present too — its PUBLISHED `MetricsProvider` is resolved via `getSeam` like any other live seam.)
 */
export interface QualityPresentSeamBindings {
  readonly patient: QualityPatientConsumer; // M5
  readonly admission: QualityAdmissionConsumer; // M6
  readonly carePlan: QualityCarePlanConsumer; // M7
  readonly encounter: QualityEncounterConsumer; // M8
  readonly assessment: QualityAssessmentConsumer; // M9
  readonly hope: QualityHopeConsumer; // M10
  readonly order: QualityOrderConsumer; // M11
  readonly medicationOrder: QualityMedicationOrderConsumer; // M12
  readonly medicationAdministration: QualityMedicationAdministrationConsumer; // M13
  readonly idg: QualityIdgConsumer; // M14
  readonly scheduling: QualitySchedulingConsumer; // M17
  readonly evv: QualityEvvConsumer; // M18
  readonly metrics: QualityMetricsConsumer; // M33 (published MetricsProvider)
}

/** The full consumed-seam bundle M30's measure calculators / services read through (PRESENT live ⊕ ABSENT stub). */
export interface QualityConsumedSeams extends QualityPresentSeamBindings {
  readonly discipline: QualityDisciplineConsumer; // M15 (forward seam)
  readonly bereavement: QualityBereavementConsumer; // M16 (forward seam)
  readonly billing: QualityBillingConsumer; // M23 (forward seam)
  readonly costReport: QualityCostReportConsumer; // M27 (forward seam)
}

/** The package's forward-seam deny-stubs for every ABSENT producer (the fail-closed defaults, §4.4). */
export const QUALITY_FORWARD_SEAM_DENY_STUBS = {
  discipline: denyStubQualityDisciplineConsumer,
  bereavement: denyStubQualityBereavementConsumer,
  billing: denyStubQualityBillingConsumer,
  costReport: denyStubQualityCostReportConsumer,
} as const;

/**
 * Assemble the consumed-seam bundle: merge the PRESENT-producer live bindings the composition root
 * supplies (P2C adapters over `getSeam`) with the package's forward-seam DENY-STUBS for every ABSENT
 * producer (M15 / M16 / M23 / M27). A calculator bound to a forward seam resolves `{ value: null,
 * isForwardSeamDenyStub: true }` and suppresses its measure — never throws, never fails open (D6 / D13).
 * When an absent module lands it moves into `present` and registers its real seam; nothing else changes.
 */
export function bindQualityConsumedSeams(
  present: QualityPresentSeamBindings,
): QualityConsumedSeams {
  return {
    ...present,
    ...QUALITY_FORWARD_SEAM_DENY_STUBS,
  };
}
