// apps/backend/src/modules/27-cost-report/routes/read-service.ts — the M27 READ route-service CONTRACT
// (§4.1 GET surface) + the deliberately-narrowed read DTOs the route plugins return.
//
// Mirrors the M30 read-service.ts precedent: one interface the route handlers compose over, plus the view
// types it projects to. The Drizzle backend (./read-service-drizzle) implements this; a route/worker
// agent matches these signatures exactly. M27 carries NO PHI (D18); money is INTEGER CENTS (D8).
//
// DTO discipline: audit-denylisted / cipher columns (`raw_payload_cipher`, `materialized_inputs`,
// `worksheet_snapshot`) are NEVER projected onto a list view. The snapshot full-detail read
// (`getSnapshot`) is the one audit-read-logged route that surfaces the materialized payloads.
import type { M27ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

// ── shared value types ────────────────────────────────────────────────────────────────────────────────

export type CostReportState =
  | "draft"
  | "populating"
  | "validating"
  | "ready_for_review"
  | "approved_for_submit"
  | "submitted"
  | "accepted"
  | "rejected"
  | "reopened"
  | "closed";

export type WorksheetCode =
  | "S"
  | "S-1"
  | "S-2"
  | "A"
  | "A-1"
  | "A-2"
  | "A-3"
  | "A-4"
  | "A-6"
  | "A-8"
  | "A-8-1"
  | "B"
  | "B-1"
  | "C"
  | "F"
  | "F-1"
  | "F-2";

export type ValidationOutcome = "pass" | "fail" | "warn" | "skip";
export type ValidationRunStatus = "in_progress" | "complete" | "failed_to_run";
export type RuleSeverity = "block" | "warn" | "info";
export type RuleStatus = "active" | "deprecated" | "draft_suggestion";
export type EcrSubmissionStatus = "generating" | "generated" | "uploaded" | "accepted" | "rejected";
export type ImportStatus = "pending" | "complete" | "failed";
export type ImportSource = "xero" | "manual_csv" | "gusto";
export type BadDebtKind = "deductible" | "coinsurance";
export type AlertTier = "none" | "t4_months" | "t4_5_months" | "t4_75_months" | "past_deadline";

type Json = Readonly<Record<string, unknown>>;

// ── view DTOs ─────────────────────────────────────────────────────────────────────────────────────────

export interface CostReportSummaryView {
  readonly costReportId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly fiscalYearStartDate: string;
  readonly fiscalYearEndDate: string;
  readonly state: CostReportState;
  readonly reopenCount: number;
  readonly badDebtClaimed: boolean;
  readonly wageSource: "gusto" | "manual";
  readonly version: number;
}

export interface CostReportDetailView extends CostReportSummaryView {
  readonly latestSnapshotId: string | null;
  readonly latestValidation: ValidationRunSummaryView | null;
  readonly latestSubmission: EcrSubmissionView | null;
  readonly complianceWindow: ComplianceWindowView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface WorksheetView {
  /** `null` on a lazy read of a worksheet code that has no persisted row yet (TypeBox default returned). */
  readonly worksheetId: string | null;
  readonly costReportId: string;
  readonly worksheetCode: WorksheetCode;
  readonly data: unknown;
  readonly computedAt: string | null;
  readonly version: number;
}

export interface CostCenterMappingView {
  readonly mappingId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly fiscalYearInt: number;
  readonly xeroAccountCode: string;
  readonly xeroAccountName: string;
  readonly cmsCostCenterCode: string;
  readonly mappingSource: "platform_default" | "tenant_override" | "tenant_extended";
  readonly version: number;
}

/** The §4.1 mapping-preview (no write): which GL accounts move + the projected cost-center deltas. */
export interface MappingPreviewView {
  readonly costReportId: string;
  readonly changedAccounts: ReadonlyArray<{
    readonly xeroAccountCode: string;
    readonly fromCmsCostCenterCode: string | null;
    readonly toCmsCostCenterCode: string;
  }>;
  readonly unmappedAccounts: readonly string[];
}

export interface BadDebtRecordView {
  readonly recordId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly periodLabel: string;
  readonly debtKind: BadDebtKind;
  readonly amountCents: number;
  readonly collectionEffortsDocumented: boolean;
  readonly supportingDocumentIds: readonly string[];
  readonly addedByMembershipId: string;
  readonly addedAt: string;
  readonly deletedAt: string | null;
}

export interface StatisticDataView {
  readonly statisticId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly monthlyBreakdown: unknown;
  readonly visitCountsByDiscipline: unknown;
  readonly fteCalculations: unknown;
  readonly bereavementCensus: unknown;
  readonly refreshedAt: string;
  readonly refreshedByMembershipId: string | null;
  readonly version: number;
}

export interface TrialBalanceImportView {
  readonly importId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly source: ImportSource;
  readonly status: ImportStatus;
  readonly accountCount: number;
  readonly failureReason: string | null;
  readonly pulledAt: string;
}

export interface WageDataImportView {
  readonly importId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly source: ImportSource;
  readonly status: ImportStatus;
  readonly rowCount: number;
  readonly failureReason: string | null;
  readonly pulledAt: string;
}

export interface ValidationRunSummaryView {
  readonly validationId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly status: ValidationRunStatus;
  readonly ruleSetVersion: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly warningCount: number;
  readonly overriddenCount: number;
  readonly skippedCount: number;
  readonly runStartedAt: string;
  readonly runCompletedAt: string | null;
}

export interface ValidationResultView {
  readonly resultId: string;
  readonly validationId: string;
  readonly ruleId: string;
  readonly outcome: ValidationOutcome;
  readonly details: Json;
  readonly overridden: boolean;
  readonly override: ValidationOverrideView | null;
  readonly recordedAt: string;
}

export interface ValidationRunDetailView extends ValidationRunSummaryView {
  readonly results: readonly ValidationResultView[];
}

export interface ValidationOverrideView {
  readonly overrideId: string;
  readonly organizationId: string;
  readonly validationResultId: string;
  readonly overriddenByMembershipId: string;
  readonly reason: string;
  readonly overriddenAt: string;
}

export interface EcrSubmissionView {
  readonly submissionId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly snapshotId: string;
  readonly status: EcrSubmissionStatus;
  readonly ecrFileDocumentId: string | null;
  readonly piFileDocumentId: string | null;
  readonly supportingDocumentsDocumentIds: readonly string[];
  readonly mcrefAcknowledgmentNumber: string | null;
  readonly mcrefRejectionCode: string | null;
  readonly mcrefRejectionDetail: string | null;
  readonly generatedAt: string;
  readonly uploadedAt: string | null;
  readonly acknowledgedAt: string | null;
}

export interface SnapshotSummaryView {
  readonly snapshotId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly priorSnapshotId: string | null;
  readonly contentHashSha256: string;
  readonly reason: "submit" | "reopen" | "mac_revision_request" | "admin_audit";
  readonly createdByMembershipId: string;
  readonly createdAt: string;
}

export interface SnapshotDetailView extends SnapshotSummaryView {
  /** The full materialized inputs (audit-read-logged at the route). */
  readonly materializedInputs: unknown;
  readonly worksheetSnapshot: unknown;
}

export interface ComplianceWindowView {
  readonly windowId: string;
  readonly organizationId: string;
  readonly costReportId: string;
  readonly deadlineDate: string;
  readonly currentEffectiveDeadlineDate: string;
  readonly lastAlertTier: AlertTier;
  readonly lastAlertTierEmittedAt: string | null;
  readonly closedAt: string | null;
}

export interface ValidationRuleView {
  readonly ruleId: string;
  /** `null` for a platform-default rule (org-NULL); the org id for a tenant rule. */
  readonly organizationId: string | null;
  readonly ruleCode: string;
  readonly category: string;
  readonly description: string;
  readonly ruleSetVersion: number;
  readonly regulatoryRequired: boolean;
  readonly severity: RuleSeverity;
  readonly status: RuleStatus;
  readonly macJurisdictionScope: string;
  readonly publishedAt: string;
  readonly deprecatedAt: string | null;
}

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────

export interface CostReportListFilter {
  readonly providerEntityId?: string;
  readonly fiscalYear?: number;
  readonly state?: CostReportState;
}

// ── the read service ──────────────────────────────────────────────────────────────────────────────────

/**
 * The M27 READ route-service contract — every GET in §4.1. Each method takes the server-assembled
 * {@link M27ReadActor}; the Drizzle backend opens one `withOrgContext` tx per call so Postgres RLS scopes
 * every statement to `app.org_id`.
 */
export interface M27ReadRouteService {
  // ── cost reports ──
  listCostReports(
    actor: M27ReadActor,
    filter: CostReportListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<CostReportSummaryView>>;
  getCostReport(actor: M27ReadActor, costReportId: string): Promise<CostReportDetailView>;

  // ── worksheets ──
  getWorksheet(
    actor: M27ReadActor,
    costReportId: string,
    worksheetCode: WorksheetCode,
  ): Promise<WorksheetView>;

  // ── cost-center mappings ──
  listCostCenterMappings(
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<readonly CostCenterMappingView[]>;

  // ── bad debt ──
  listBadDebt(actor: M27ReadActor, costReportId: string): Promise<readonly BadDebtRecordView[]>;

  // ── statistics ──
  getStatistics(actor: M27ReadActor, costReportId: string): Promise<StatisticDataView | null>;

  // ── imports ──
  listTrialBalanceImports(
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<readonly TrialBalanceImportView[]>;
  listWageDataImports(
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<readonly WageDataImportView[]>;

  // ── validations ──
  listValidations(
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<readonly ValidationRunSummaryView[]>;
  getValidation(
    actor: M27ReadActor,
    costReportId: string,
    validationId: string,
  ): Promise<ValidationRunDetailView>;

  // ── ecr submissions ──
  listEcrSubmissions(
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<readonly EcrSubmissionView[]>;
  getEcrSubmission(
    actor: M27ReadActor,
    costReportId: string,
    submissionId: string,
  ): Promise<EcrSubmissionView>;

  // ── snapshots ──
  listSnapshots(actor: M27ReadActor, costReportId: string): Promise<readonly SnapshotSummaryView[]>;
  getSnapshot(
    actor: M27ReadActor,
    costReportId: string,
    snapshotId: string,
  ): Promise<SnapshotDetailView>;

  // ── compliance window ──
  getComplianceWindow(
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<ComplianceWindowView | null>;

  // ── rule library ──
  listValidationRules(actor: M27ReadActor): Promise<readonly ValidationRuleView[]>;
}
