// apps/backend/src/modules/27-cost-report/routes/cost-report-typebox.ts — M27 (§4.2) request schemas.
//
// TypeBox path-param / query / body schemas for the §4.1 cost-report routes (cost reports, worksheets,
// cost-center mappings, imports, bad-debt, statistics, validations, ECR submissions, snapshots, compliance
// window, validation rules) + the `parse(...)` helper. Named `cost-report-typebox` (NOT `*schema*`) so the
// table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one (the M30
// `quality-typebox` / M33 `reporting-typebox` precedent). Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Org/actor/membership binding is ALWAYS server-side (request.context) — no
// body/query carries an org id or an authoring/approving membership id (the attestation membership ids are
// the only identities a submit body attests to; the route still stamps the acting principal from the actor).
//
// VOCAB NOTE: the string-literal unions mirror the FROZEN `@chartwarden/db` pgEnum value lists
// (packages/db/src/schema/cost-report/*) and the @chartwarden/cost-report value unions; schema wins on conflict.
// M27 carries NO PHI (D18); every money field is INTEGER CENTS (D8).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@chartwarden/types";
import type { CursorPage } from "./concurrency";
import type {
  BadDebtRecordView,
  ComplianceWindowView,
  CostCenterMappingView,
  CostReportDetailView,
  CostReportSummaryView,
  EcrSubmissionView,
  MappingPreviewView,
  SnapshotDetailView,
  SnapshotSummaryView,
  StatisticDataView,
  TrialBalanceImportView,
  ValidationOverrideView,
  ValidationResultView,
  ValidationRuleView,
  ValidationRunDetailView,
  ValidationRunSummaryView,
  WageDataImportView,
  WorksheetView,
} from "./read-service";
import type {
  AllocationAcceptedView,
  ImportJobAcceptedView,
  RefreshInputsAcceptedView,
  StatisticsRefreshAcceptedView,
  ValidationJobAcceptedView,
} from "./write-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const uuid = () => Type.String({ format: "uuid" });
const isoInstant = () => Type.String({ format: "date-time" });
const isoDate = () => Type.String({ format: "date" });

// ── §3 vocab mirrors (canonical pgEnums live in @chartwarden/db / @chartwarden/cost-report contracts) ───────────
const COST_REPORT_STATE = [
  "draft",
  "populating",
  "validating",
  "ready_for_review",
  "approved_for_submit",
  "submitted",
  "accepted",
  "rejected",
  "reopened",
  "closed",
] as const;
const WORKSHEET_CODE = [
  "S",
  "S-1",
  "S-2",
  "A",
  "A-1",
  "A-2",
  "A-3",
  "A-4",
  "A-6",
  "A-8",
  "A-8-1",
  "B",
  "B-1",
  "C",
  "F",
  "F-1",
  "F-2",
] as const;
const WAGE_SOURCE = ["gusto", "manual"] as const;
const BAD_DEBT_KIND = ["deductible", "coinsurance"] as const;
const MAPPING_SOURCE = ["tenant_override", "tenant_extended"] as const;
const RULE_SEVERITY = ["block", "warn", "info"] as const;
const REOPEN_REASON_CATEGORY = [
  "mac_revision_request",
  "internal_audit_finding",
  "cap_recalculation_received",
  "clerical_correction",
  "other_with_explanation",
] as const;

// ── cursor / keyset page query (§4.1.2 — opaque cursor + clamp-to-100 limit) ────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};

// ── path params ──────────────────────────────────────────────────────────────────────────────────────
export const CostReportIdParamsSchema = Type.Object({ id: uuid() });
export const WorksheetParamsSchema = Type.Object({ id: uuid(), code: lit(WORKSHEET_CODE) });
export const BadDebtRecordParamsSchema = Type.Object({ id: uuid(), recordId: uuid() });
export const ValidationParamsSchema = Type.Object({ id: uuid(), vid: uuid() });
export const SubmissionParamsSchema = Type.Object({ id: uuid(), sid: uuid() });
export const SnapshotParamsSchema = Type.Object({ id: uuid(), sid: uuid() });
export const RuleIdParamsSchema = Type.Object({ id: uuid() });

// ── list queries ─────────────────────────────────────────────────────────────────────────────────────
export const CostReportListQuerySchema = Type.Object({
  ...PageQuery,
  providerEntityId: Type.Optional(uuid()),
  fiscalYear: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
  state: Type.Optional(lit(COST_REPORT_STATE)),
});

// ── cost-report lifecycle bodies ─────────────────────────────────────────────────────────────────────
export const CreateCostReportBodySchema = Type.Object({
  providerEntityId: uuid(),
  fiscalYearStartDate: isoDate(),
  fiscalYearEndDate: isoDate(),
  wageSource: Type.Optional(lit(WAGE_SOURCE)),
});

export const PatchCostReportBodySchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  badDebtClaimed: Type.Optional(Type.Boolean()),
  wageSource: Type.Optional(lit(WAGE_SOURCE)),
});

export const ApproveForSubmitBodySchema = Type.Object({
  validationId: Type.Optional(uuid()),
});

export const SubmitBodySchema = Type.Object({
  // Legacy client fields (GAP-081): accepted for back-compat, IGNORED. The attester is the authenticated
  // actor, the attestation time is server time, the approver is stored server-side at approve-for-submit.
  attestedByMembershipId: Type.Optional(uuid()),
  attestedAt: Type.Optional(isoInstant()),
  approvedByMembershipId: Type.Optional(uuid()),
});

export const SubmitPastDeadlineBodySchema = Type.Object({
  // Legacy client fields (GAP-081): accepted for back-compat, IGNORED. The attester is the authenticated
  // actor, the attestation time is server time, the approver is stored server-side at approve-for-submit.
  attestedByMembershipId: Type.Optional(uuid()),
  attestedAt: Type.Optional(isoInstant()),
  approvedByMembershipId: Type.Optional(uuid()),
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
});

export const ReopenBodySchema = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
  reasonCategory: lit(REOPEN_REASON_CATEGORY),
});

// ── worksheet bodies ─────────────────────────────────────────────────────────────────────────────────
export const PutWorksheetBodySchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  // The per-worksheet TypeBox schema (WORKSHEET_SCHEMAS/resolveWorksheetSchema) is resolved + checked
  // inside the write service against the `:code`; the route only enforces the envelope. Unknown by design.
  data: Type.Unknown(),
});

// ── cost-center-mapping bodies ───────────────────────────────────────────────────────────────────────
const MappingChangeSchema = Type.Object({
  xeroAccountCode: Type.String({ minLength: 1, maxLength: 50 }),
  xeroAccountName: Type.String({ minLength: 1, maxLength: 200 }),
  cmsCostCenterCode: Type.String({ minLength: 1, maxLength: 50 }),
});
export const PreviewMappingBodySchema = Type.Object({
  changes: Type.Array(MappingChangeSchema, { minItems: 1, maxItems: 500 }),
});
export const ApplyMappingBodySchema = Type.Object({
  changes: Type.Array(MappingChangeSchema, { minItems: 1, maxItems: 500 }),
  mappingSource: Type.Optional(lit(MAPPING_SOURCE)),
});
export const ResetMappingBodySchema = Type.Object({
  keepTenantOverrides: Type.Boolean(),
});

// ── bad-debt bodies ──────────────────────────────────────────────────────────────────────────────────
export const AddBadDebtBodySchema = Type.Object({
  periodLabel: Type.String({ minLength: 1, maxLength: 50 }),
  debtKind: lit(BAD_DEBT_KIND),
  amountCents: Type.Integer({ minimum: 0 }),
  collectionEffortsDocumented: Type.Optional(Type.Boolean()),
  supportingDocumentIds: Type.Optional(Type.Array(uuid(), { maxItems: 100 })),
});
export const UpdateBadDebtBodySchema = Type.Object({
  periodLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  debtKind: Type.Optional(lit(BAD_DEBT_KIND)),
  amountCents: Type.Optional(Type.Integer({ minimum: 0 })),
  collectionEffortsDocumented: Type.Optional(Type.Boolean()),
  supportingDocumentIds: Type.Optional(Type.Array(uuid(), { maxItems: 100 })),
});

// ── import bodies (manual upload — pre-normalized rows parsed at the edge) ──────────────────────────────
export const ManualTrialBalanceBodySchema = Type.Object({
  normalizedAccounts: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 100000 }),
});
export const ManualWageDataBodySchema = Type.Object({
  normalizedWageRows: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 100000 }),
});

// ── validation bodies ────────────────────────────────────────────────────────────────────────────────
export const OverrideValidationResultBodySchema = Type.Object({
  validationResultId: uuid(),
  reason: Type.String({ minLength: 30, maxLength: 1000 }),
});

// ── acknowledgment body (acceptance number XOR rejection code; the DB CHECK is the source of truth) ─────
export const RecordAcknowledgmentBodySchema = Type.Object({
  mcrefAcknowledgmentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  mcrefRejectionCode: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  mcrefRejectionDetail: Type.Optional(Type.String({ maxLength: 2000 })),
});

// ── compliance-window body ───────────────────────────────────────────────────────────────────────────
export const DeadlineExtensionBodySchema = Type.Object({
  newEffectiveDeadlineDate: isoDate(),
});

// ── validation-rule library bodies ───────────────────────────────────────────────────────────────────
export const CreateValidationRuleBodySchema = Type.Object({
  ruleCode: Type.String({ minLength: 1, maxLength: 120 }),
  category: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  severity: lit(RULE_SEVERITY),
  macJurisdictionScope: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  predicateSpec: Type.Unknown(),
});
export const UpdateValidationRuleBodySchema = Type.Object({
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  severity: Type.Optional(lit(RULE_SEVERITY)),
  macJurisdictionScope: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  predicateSpec: Type.Optional(Type.Unknown()),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The §4.1 read + mutating routes returned typed view shapes (read-service.ts / write-service.ts) but
// published NO response contract, so the generated client typed every body as `never`. These DTOs mirror
// the service views 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a view
// field added or renamed breaks `bun run build` rather than silently drifting from the client. Enum fields
// are literal unions mirroring the FROZEN pgEnum value lists; opaque audit-denylisted jsonb (`data`,
// `materializedInputs`, statistic breakdowns, validation `details`) is `Type.Unknown()`/open record — the
// route only guarantees the envelope, never the internal shape (schema wins on conflict).
const nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

const MAPPING_SOURCE_ALL = ["platform_default", "tenant_override", "tenant_extended"] as const;
const SNAPSHOT_REASON = ["submit", "reopen", "mac_revision_request", "admin_audit"] as const;
const ALERT_TIER = ["none", "t4_months", "t4_5_months", "t4_75_months", "past_deadline"] as const;
const VALIDATION_OUTCOME = ["pass", "fail", "warn", "skip"] as const;
const VALIDATION_RUN_STATUS = ["in_progress", "complete", "failed_to_run"] as const;
const RULE_STATUS = ["active", "deprecated", "draft_suggestion"] as const;
const ECR_STATUS = ["generating", "generated", "uploaded", "accepted", "rejected"] as const;
const IMPORT_STATUS = ["pending", "complete", "failed"] as const;
const IMPORT_SOURCE = ["xero", "manual_csv", "gusto"] as const;

export const ValidationRunSummaryResponseSchema = Type.Object({
  validationId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  status: lit(VALIDATION_RUN_STATUS),
  ruleSetVersion: Type.Integer(),
  passedCount: Type.Integer(),
  failedCount: Type.Integer(),
  warningCount: Type.Integer(),
  overriddenCount: Type.Integer(),
  skippedCount: Type.Integer(),
  runStartedAt: Type.String(),
  runCompletedAt: nullable(Type.String()),
});

export const ValidationOverrideResponseSchema = Type.Object({
  overrideId: Type.String(),
  organizationId: Type.String(),
  validationResultId: Type.String(),
  overriddenByMembershipId: Type.String(),
  reason: Type.String(),
  overriddenAt: Type.String(),
});

export const ValidationResultResponseSchema = Type.Object({
  resultId: Type.String(),
  validationId: Type.String(),
  ruleId: Type.String(),
  outcome: lit(VALIDATION_OUTCOME),
  details: Type.Record(Type.String(), Type.Unknown()),
  overridden: Type.Boolean(),
  override: nullable(ValidationOverrideResponseSchema),
  recordedAt: Type.String(),
});

export const ValidationRunDetailResponseSchema = Type.Object({
  validationId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  status: lit(VALIDATION_RUN_STATUS),
  ruleSetVersion: Type.Integer(),
  passedCount: Type.Integer(),
  failedCount: Type.Integer(),
  warningCount: Type.Integer(),
  overriddenCount: Type.Integer(),
  skippedCount: Type.Integer(),
  runStartedAt: Type.String(),
  runCompletedAt: nullable(Type.String()),
  results: Type.Array(ValidationResultResponseSchema),
});

export const EcrSubmissionResponseSchema = Type.Object({
  submissionId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  snapshotId: Type.String(),
  status: lit(ECR_STATUS),
  ecrFileDocumentId: nullable(Type.String()),
  piFileDocumentId: nullable(Type.String()),
  supportingDocumentsDocumentIds: Type.Array(Type.String()),
  mcrefAcknowledgmentNumber: nullable(Type.String()),
  mcrefRejectionCode: nullable(Type.String()),
  mcrefRejectionDetail: nullable(Type.String()),
  generatedAt: Type.String(),
  uploadedAt: nullable(Type.String()),
  acknowledgedAt: nullable(Type.String()),
});

export const ComplianceWindowResponseSchema = Type.Object({
  windowId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  deadlineDate: Type.String(),
  currentEffectiveDeadlineDate: Type.String(),
  lastAlertTier: lit(ALERT_TIER),
  lastAlertTierEmittedAt: nullable(Type.String()),
  closedAt: nullable(Type.String()),
});

const costReportSummaryProps = {
  costReportId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  fiscalYearStartDate: Type.String(),
  fiscalYearEndDate: Type.String(),
  state: lit(COST_REPORT_STATE),
  reopenCount: Type.Integer(),
  badDebtClaimed: Type.Boolean(),
  wageSource: lit(WAGE_SOURCE),
  version: Type.Integer(),
};
export const CostReportSummaryResponseSchema = Type.Object(costReportSummaryProps);

export const CostReportDetailResponseSchema = Type.Object({
  ...costReportSummaryProps,
  latestSnapshotId: nullable(Type.String()),
  latestValidation: nullable(ValidationRunSummaryResponseSchema),
  latestSubmission: nullable(EcrSubmissionResponseSchema),
  complianceWindow: nullable(ComplianceWindowResponseSchema),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  closedAt: nullable(Type.String()),
});

export const CostReportPageResponseSchema = Type.Object({
  items: Type.Array(CostReportSummaryResponseSchema),
  nextCursor: nullable(Type.String()),
  hasMore: Type.Boolean(),
});

export const WorksheetResponseSchema = Type.Object({
  worksheetId: nullable(Type.String()),
  costReportId: Type.String(),
  worksheetCode: lit(WORKSHEET_CODE),
  data: Type.Unknown(),
  computedAt: nullable(Type.String()),
  version: Type.Integer(),
});

export const CostCenterMappingResponseSchema = Type.Object({
  mappingId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  fiscalYearInt: Type.Integer(),
  xeroAccountCode: Type.String(),
  xeroAccountName: Type.String(),
  cmsCostCenterCode: Type.String(),
  mappingSource: lit(MAPPING_SOURCE_ALL),
  version: Type.Integer(),
});
export const CostCenterMappingListResponseSchema = Type.Array(CostCenterMappingResponseSchema);

export const MappingPreviewResponseSchema = Type.Object({
  costReportId: Type.String(),
  changedAccounts: Type.Array(
    Type.Object({
      xeroAccountCode: Type.String(),
      fromCmsCostCenterCode: nullable(Type.String()),
      toCmsCostCenterCode: Type.String(),
    }),
  ),
  unmappedAccounts: Type.Array(Type.String()),
});

export const BadDebtRecordResponseSchema = Type.Object({
  recordId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  periodLabel: Type.String(),
  debtKind: lit(BAD_DEBT_KIND),
  amountCents: Type.Integer(),
  collectionEffortsDocumented: Type.Boolean(),
  supportingDocumentIds: Type.Array(Type.String()),
  addedByMembershipId: Type.String(),
  addedAt: Type.String(),
  deletedAt: nullable(Type.String()),
});
export const BadDebtRecordListResponseSchema = Type.Array(BadDebtRecordResponseSchema);

export const StatisticDataResponseSchema = Type.Object({
  statisticId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  monthlyBreakdown: Type.Unknown(),
  visitCountsByDiscipline: Type.Unknown(),
  fteCalculations: Type.Unknown(),
  bereavementCensus: Type.Unknown(),
  refreshedAt: Type.String(),
  refreshedByMembershipId: nullable(Type.String()),
  version: Type.Integer(),
});
export const StatisticDataOrNullResponseSchema = nullable(StatisticDataResponseSchema);

export const TrialBalanceImportResponseSchema = Type.Object({
  importId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  source: lit(IMPORT_SOURCE),
  status: lit(IMPORT_STATUS),
  accountCount: Type.Integer(),
  failureReason: nullable(Type.String()),
  pulledAt: Type.String(),
});
export const TrialBalanceImportListResponseSchema = Type.Array(TrialBalanceImportResponseSchema);

export const WageDataImportResponseSchema = Type.Object({
  importId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  source: lit(IMPORT_SOURCE),
  status: lit(IMPORT_STATUS),
  rowCount: Type.Integer(),
  failureReason: nullable(Type.String()),
  pulledAt: Type.String(),
});
export const WageDataImportListResponseSchema = Type.Array(WageDataImportResponseSchema);

export const ValidationRunSummaryListResponseSchema = Type.Array(
  ValidationRunSummaryResponseSchema,
);

export const EcrSubmissionListResponseSchema = Type.Array(EcrSubmissionResponseSchema);

const snapshotSummaryProps = {
  snapshotId: Type.String(),
  organizationId: Type.String(),
  costReportId: Type.String(),
  priorSnapshotId: nullable(Type.String()),
  contentHashSha256: Type.String(),
  reason: lit(SNAPSHOT_REASON),
  createdByMembershipId: Type.String(),
  createdAt: Type.String(),
};
export const SnapshotSummaryResponseSchema = Type.Object(snapshotSummaryProps);
export const SnapshotSummaryListResponseSchema = Type.Array(SnapshotSummaryResponseSchema);
export const SnapshotDetailResponseSchema = Type.Object({
  ...snapshotSummaryProps,
  materializedInputs: Type.Unknown(),
  worksheetSnapshot: Type.Unknown(),
});

export const ComplianceWindowOrNullResponseSchema = nullable(ComplianceWindowResponseSchema);

export const ValidationRuleResponseSchema = Type.Object({
  ruleId: Type.String(),
  organizationId: nullable(Type.String()),
  ruleCode: Type.String(),
  category: Type.String(),
  description: Type.String(),
  ruleSetVersion: Type.Integer(),
  regulatoryRequired: Type.Boolean(),
  severity: lit(RULE_SEVERITY),
  status: lit(RULE_STATUS),
  macJurisdictionScope: Type.String(),
  publishedAt: Type.String(),
  deprecatedAt: nullable(Type.String()),
});
export const ValidationRuleListResponseSchema = Type.Array(ValidationRuleResponseSchema);

// ── accepted-view returns (async enqueue endpoints) ───────────────────────────────────────────────────
export const RefreshInputsAcceptedResponseSchema = Type.Object({
  trialBalanceJobId: Type.String(),
  wageDataJobId: nullable(Type.String()),
  statisticsJobId: Type.String(),
});
export const ImportJobAcceptedResponseSchema = Type.Object({ jobId: Type.String() });
export const StatisticsRefreshAcceptedResponseSchema = Type.Object({ jobId: Type.String() });
export const AllocationAcceptedResponseSchema = Type.Object({
  jobId: Type.String(),
  worksheetsToRecompute: Type.Array(lit(WORKSHEET_CODE)),
});
export const ValidationJobAcceptedResponseSchema = Type.Object({
  validationId: Type.String(),
  jobId: Type.String(),
  ruleSetVersion: Type.Integer(),
});

// Compile-time pins: what each schema publishes (`T`) must be assignable to what the service returns (`V`).
type Conforms<T extends V, V> = T;
type _CostReportSummary = Conforms<
  Static<typeof CostReportSummaryResponseSchema>,
  CostReportSummaryView
>;
type _CostReportDetail = Conforms<
  Static<typeof CostReportDetailResponseSchema>,
  CostReportDetailView
>;
type _CostReportPage = Conforms<
  Static<typeof CostReportPageResponseSchema>,
  CursorPage<CostReportSummaryView>
>;
type _Worksheet = Conforms<Static<typeof WorksheetResponseSchema>, WorksheetView>;
type _CostCenterMapping = Conforms<
  Static<typeof CostCenterMappingResponseSchema>,
  CostCenterMappingView
>;
type _MappingPreview = Conforms<Static<typeof MappingPreviewResponseSchema>, MappingPreviewView>;
type _BadDebtRecord = Conforms<Static<typeof BadDebtRecordResponseSchema>, BadDebtRecordView>;
type _StatisticData = Conforms<Static<typeof StatisticDataResponseSchema>, StatisticDataView>;
type _TrialBalanceImport = Conforms<
  Static<typeof TrialBalanceImportResponseSchema>,
  TrialBalanceImportView
>;
type _WageDataImport = Conforms<Static<typeof WageDataImportResponseSchema>, WageDataImportView>;
type _ValidationRunSummary = Conforms<
  Static<typeof ValidationRunSummaryResponseSchema>,
  ValidationRunSummaryView
>;
type _ValidationResult = Conforms<
  Static<typeof ValidationResultResponseSchema>,
  ValidationResultView
>;
type _ValidationRunDetail = Conforms<
  Static<typeof ValidationRunDetailResponseSchema>,
  ValidationRunDetailView
>;
type _ValidationOverride = Conforms<
  Static<typeof ValidationOverrideResponseSchema>,
  ValidationOverrideView
>;
type _EcrSubmission = Conforms<Static<typeof EcrSubmissionResponseSchema>, EcrSubmissionView>;
type _SnapshotSummary = Conforms<Static<typeof SnapshotSummaryResponseSchema>, SnapshotSummaryView>;
type _SnapshotDetail = Conforms<Static<typeof SnapshotDetailResponseSchema>, SnapshotDetailView>;
type _ComplianceWindow = Conforms<
  Static<typeof ComplianceWindowResponseSchema>,
  ComplianceWindowView
>;
type _ValidationRule = Conforms<Static<typeof ValidationRuleResponseSchema>, ValidationRuleView>;
type _RefreshInputsAccepted = Conforms<
  Static<typeof RefreshInputsAcceptedResponseSchema>,
  RefreshInputsAcceptedView
>;
type _ImportJobAccepted = Conforms<
  Static<typeof ImportJobAcceptedResponseSchema>,
  ImportJobAcceptedView
>;
type _StatisticsRefreshAccepted = Conforms<
  Static<typeof StatisticsRefreshAcceptedResponseSchema>,
  StatisticsRefreshAcceptedView
>;
type _AllocationAccepted = Conforms<
  Static<typeof AllocationAcceptedResponseSchema>,
  AllocationAcceptedView
>;
type _ValidationJobAccepted = Conforms<
  Static<typeof ValidationJobAcceptedResponseSchema>,
  ValidationJobAcceptedView
>;

/**
 * Validate `raw` against `schema` (Convert-then-Check), throwing M1's VALIDATION_FAILED envelope on the
 * first error (the M30/M33 `parse(...)` precedent). The route handlers call this on params/query/body so a
 * malformed request is refused with the platform error shape before the service is reached.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
