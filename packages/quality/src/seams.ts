// @wardenx/quality — M30 HQRP & Quality: the FIVE published seam interfaces (§4.3).
//
// M30 publishes five read-only seams; each is consumed by at least one downstream module (M22 PDF,
// M28 FHIR, M33 dashboards, M34 tenant gate). All seams are READ-ONLY — M30's mutating surfaces are
// reserved for in-module operators and the recompute worker.
//
// P2a scope: this file EXPORTS only the seam INTERFACES (plus the published-name tuple used by the
// later boot assert). The spec proposes registering each seam against a standalone seam-registry
// package at declaration time — that package does NOT exist in this codebase; the actual registration
// into the M1 SeamRegistry is port-injected at the backend composition root in a LATER phase. Do NOT
// add registration calls here (mirrors how `@wardenx/reporting`'s `seams/published/*` declares pure
// interfaces with no registration).
import type {
  ComplianceStatus,
  Incident,
  IncidentKind,
  IncidentSeverity,
  IncidentState,
  MeasureId,
  MeasurePeriod,
  MeasureValue,
  MeasureValueSnapshot,
  QapiProject,
  QapiProjectPhase,
  SraCycle,
} from "./contracts";

// -----------------------------------------------------------------------------
// Seam 1: QualityMeasureProvider
//   Consumers: M22 (quality report rendering), M28 (FHIR MeasureReport),
//              M33 (executive dashboards), M34 (tenant gate at FY rollover).
//   Read scope: aggregate-only — never returns patient-level rows.
// -----------------------------------------------------------------------------
export interface QualityMeasureProvider {
  /** Latest value(s) for a measure within a period; returns latest non-superseded row. */
  getLatestValue(
    orgId: string,
    measureId: MeasureId,
    period: MeasurePeriod,
  ): Promise<MeasureValue | null>;

  /** Series of latest-per-period values across a window (e.g., 4 quarters). */
  getValueSeries(
    orgId: string,
    measureId: MeasureId,
    windowStart: string,
    windowEnd: string,
  ): Promise<MeasureValue[]>;

  /** Snapshot for reproducibility audit; throws if value_id is not from this org. */
  getSnapshot(orgId: string, valueId: string): Promise<MeasureValueSnapshot>;

  /** All measure IDs the platform currently computes for a given fiscal year. */
  listMeasureCatalog(fiscalYear: number): Promise<MeasureId[]>;
}

// -----------------------------------------------------------------------------
// Seam 2: IncidentRegisterProvider
//   Consumers: M22 (incident reports), M28 (FHIR AdverseEvent),
//              M33 (incident dashboards).
//   Read scope: PHI — caller must hold patient-level permission for patient rows.
// -----------------------------------------------------------------------------
export interface IncidentRegisterProvider {
  /** List incidents for an org, filtered. Patient-scoped rows require caller patient access. */
  listIncidents(
    orgId: string,
    filter: {
      kinds?: IncidentKind[];
      states?: IncidentState[];
      severities?: IncidentSeverity[];
      occurredAfter?: string;
      occurredBefore?: string;
      patientId?: string;
    },
    actorContext: { actorId: string; permissions: string[] },
  ): Promise<Incident[]>;

  /** Single incident by id; throws if actor lacks tenant or patient scope. */
  getIncident(
    incidentId: string,
    actorContext: { actorId: string; permissions: string[] },
  ): Promise<Incident>;

  /** Counts by kind/severity for a period (aggregate-only, no patient leak). */
  countIncidents(
    orgId: string,
    period: { start: string; end: string },
  ): Promise<{ kind: IncidentKind; severity: IncidentSeverity; n: number }[]>;
}

// -----------------------------------------------------------------------------
// Seam 3: QapiProjectProvider
//   Consumers: M22 (QAPI minutes/charter rendering), M33 (QAPI status widgets).
//   Read scope: aggregate-only.
// -----------------------------------------------------------------------------
export interface QapiProjectProvider {
  listActivePrograms(orgId: string): Promise<
    {
      programId: string;
      year: number;
      charterAdoptedAt: string;
    }[]
  >;

  listProjects(
    orgId: string,
    filter: { phases?: QapiProjectPhase[]; programId?: string },
  ): Promise<QapiProject[]>;

  getProject(orgId: string, projectId: string): Promise<QapiProject>;

  /** Indicator-to-project linkage for trace from quality_measure_value to PI activity. */
  findProjectsForIndicator(orgId: string, indicatorId: string): Promise<QapiProject[]>;
}

// -----------------------------------------------------------------------------
// Seam 4: ComplianceStatusProvider
//   Consumers: M34 (tenant compliance gate at fiscal-year rollover), M33 (compliance widgets).
//   Read scope: aggregate-only — returns categorical status, not underlying PHI.
// -----------------------------------------------------------------------------
export interface ComplianceStatusProvider {
  /** Per-citation status for the org against the 23 CoP rows. */
  getCopStatusByOrg(orgId: string): Promise<ComplianceStatus[]>;

  /** True iff every required citation is `compliant` AND last review ≤6 months old. */
  isOrgCopReadyForFy(
    orgId: string,
    fiscalYear: number,
  ): Promise<{
    ready: boolean;
    blockers: { citationId: string; reason: string }[];
  }>;

  /** Annual SRA freshness check (most-recent cycle is closed AND ≤365 days old). */
  isSraFresh(orgId: string): Promise<{
    fresh: boolean;
    lastCycleClosedAt: string | null;
    daysSinceClose: number | null;
  }>;
}

// -----------------------------------------------------------------------------
// Seam 5: SecurityRiskAssessmentReader
//   Consumers: M33 (security dashboards), M34 (tenant gate).
//   Read scope: aggregate-only — exposes counts/status, not finding details.
// -----------------------------------------------------------------------------
export interface SecurityRiskAssessmentReader {
  listCycles(orgId: string): Promise<SraCycle[]>;

  getCurrentCycle(orgId: string): Promise<SraCycle | null>;

  /** Risk-band breakdown of open findings for the current cycle. */
  getOpenFindingsBands(orgId: string): Promise<{
    critical: number;
    high: number;
    medium: number;
    low: number;
  }>;
}

/**
 * The five seam NAMES M30 owns, in §4.3 publication order. The backend boot path (a later phase) calls
 * `seamRegistry.assertOwned(30, M30_PUBLISHED_SEAM_NAMES)` so boot fails if any seam is missing,
 * mis-typed, or claims a different owner module. Kept as the single source of truth for that assert.
 */
export const M30_PUBLISHED_SEAM_NAMES = [
  "QualityMeasureProvider",
  "IncidentRegisterProvider",
  "QapiProjectProvider",
  "ComplianceStatusProvider",
  "SecurityRiskAssessmentReader",
] as const;

/** Union of the M30 published seam names. */
export type M30PublishedSeamName = (typeof M30_PUBLISHED_SEAM_NAMES)[number];
