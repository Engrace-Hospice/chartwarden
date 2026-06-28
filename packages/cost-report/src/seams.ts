// @wardenx/cost-report — the SEVEN published seam interfaces (§4.3) + the published-name tuple the boot
// assert validates against. M27 publishes read-only reader/factory contracts; consumers import only the
// interface type, never an M27 schema/table. Registration into the M1 SeamRegistry is port-injected at
// the backend composition root (see ./seam-registration) — NOT here (the M30 `seams.ts` precedent). All
// reader projections are AGGREGATE-ONLY (D18) — never patient-identifiable.
import type {
  CostReportId,
  EcrSubmissionId,
  OrganizationId,
  ProviderEntityId,
  ValidationOutcome,
} from "./contracts";
import type { XeroClient } from "@wardenx/xero-client";
import type { GustoClient } from "@wardenx/gusto-client";

// -----------------------------------------------------------------------------
// Seam 1: CostReportProvider — per-day drug cost / per-diem / IPU cap / bad-debt rollups.
//   Consumers: M30 (HQRP financial-context measures), M33 (financial dashboards), M37 (IPU cap view).
// -----------------------------------------------------------------------------
export interface CostReportProvider {
  /** Per-day drug cost feeding M30 HQRP / M33 financial dashboards. */
  getDrugCostPerHospiceDay(input: {
    providerEntityId: ProviderEntityId;
    capYear: number;
  }): Promise<{ amountCents: number; computedFromCostReportId: CostReportId | null }>;

  /** Per-diem allowable cost feeding M30 / M33. */
  getRoutineCarePerDiemCost(input: {
    providerEntityId: ProviderEntityId;
    fiscalYear: number;
  }): Promise<{ amountCents: number; computedFromCostReportId: CostReportId | null }>;

  /** IPU cap position at a fiscal date; consumed by M37. */
  getInpatientCapPositionAtFiscalDate(input: {
    providerEntityId: ProviderEntityId;
    asOfDate: string;
  }): Promise<{
    totalDaysGip: number;
    totalDaysIrc: number;
    totalMedicareDays: number;
    inpatientPctOfTotal: number;
    remainingInpatientCapDays: number | null;
  }>;

  /** Cost-report-derived bad-debt total feeding M33. */
  getBadDebtTotal(input: {
    providerEntityId: ProviderEntityId;
    fiscalYear: number;
  }): Promise<{ totalCents: number; entriesCount: number }>;
}

// -----------------------------------------------------------------------------
// Seam 2: CostReportFilingStatusReader — open-report + most-recent-submission status.
//   Consumers: M34 (offboarding gate, tenant compliance-posture summary).
// -----------------------------------------------------------------------------
export interface CostReportFilingStatusReader {
  getOpenReportsForProvider(input: {
    providerEntityId: ProviderEntityId;
  }): Promise<
    Array<{
      costReportId: CostReportId;
      fiscalYearEndDate: string;
      state: string;
      deadlineDate: string;
      daysToDeadline: number;
    }>
  >;

  getMostRecentSubmissionFor(input: {
    providerEntityId: ProviderEntityId;
  }): Promise<{
    costReportId: CostReportId;
    fiscalYearEndDate: string;
    submittedAt: string | null;
    acceptedAt: string | null;
    mcrefAcknowledgmentNumber: string | null;
  } | null>;
}

// -----------------------------------------------------------------------------
// Seam 3: EcrArtifactReader — M22 document ids for a submission's artifacts.
//   Consumers: M28 (FHIR DocumentReference projection).
// -----------------------------------------------------------------------------
export interface EcrArtifactReader {
  getArtifactsForSubmission(input: {
    submissionId: EcrSubmissionId;
  }): Promise<{
    ecrFileDocumentId: string | null;
    piFileDocumentId: string | null;
    supportingDocumentsDocumentIds: string[];
  }>;
}

// -----------------------------------------------------------------------------
// Seam 4: ValidationResultProvider — latest validation run + per-rule results.
//   Consumers: M33 (worklist views), the auto-rule-suggestion pipeline.
// -----------------------------------------------------------------------------
export interface ValidationResultProvider {
  getLatestValidationFor(input: {
    costReportId: CostReportId;
  }): Promise<{
    validationId: string;
    passedCount: number;
    failedCount: number;
    warningCount: number;
    overriddenCount: number;
    perRuleResults: Array<{ ruleCode: string; outcome: ValidationOutcome; details: unknown }>;
  } | null>;
}

// -----------------------------------------------------------------------------
// Seam 5 + 6: XeroClientFactory / GustoClientFactory — typed per-tenant adapter clients (D6).
//   Consumers: M27 internally + M29 (non-cost-report Xero/Gusto uses at M29 lock).
// -----------------------------------------------------------------------------
export interface XeroClientFactory {
  forTenant(input: { organizationId: OrganizationId; xeroTenantId?: string }): Promise<XeroClient>;
}

export interface GustoClientFactory {
  forTenant(input: {
    organizationId: OrganizationId;
    gustoCompanyId?: string;
  }): Promise<GustoClient>;
}

// -----------------------------------------------------------------------------
// Seam 7: CostReportMetricsProvider — rule-failure-frequency + anonymized platform rule-effectiveness.
//   Consumers: M33 (per-tenant rule-failure aggregation + the platform-team review rollup).
// -----------------------------------------------------------------------------
export interface CostReportMetricsProvider {
  getRuleFailureFrequency(input: {
    organizationId: OrganizationId;
    sinceDate: string;
  }): Promise<
    Array<{
      ruleCode: string;
      failureCount: number;
      overrideCount: number;
      topProviderEntityIds: string[];
    }>
  >;

  getPlatformRuleEffectivenessAnonymized(input: {
    sinceDate: string;
  }): Promise<
    Array<{
      ruleCode: string;
      ruleSetVersion: number;
      totalRunsApplied: number;
      failureRate: number;
      overrideRate: number;
      macJurisdictionScope: string;
    }>
  >;
}

/** The §4.3 published-seam names — the boot registration + `validateSeams()` assert key on this tuple. */
export const M27_PUBLISHED_SEAM_NAMES = [
  "CostReportProvider",
  "CostReportFilingStatusReader",
  "EcrArtifactReader",
  "ValidationResultProvider",
  "XeroClientFactory",
  "GustoClientFactory",
  "CostReportMetricsProvider",
] as const;

export type M27PublishedSeamName = (typeof M27_PUBLISHED_SEAM_NAMES)[number];
