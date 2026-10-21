// apps/backend/src/modules/27-cost-report/routes/write-service.ts — the M27 WRITE route-service CONTRACT
// (§4.1 mutating surface) + the command args + the injected ports (transactional outbox, recompute/enqueue,
// provider-entity resolver).
//
// Mirrors the M30 write-service.ts precedent: one interface the route handlers compose over, the per-
// command arg shapes, and the cross-boundary PORTS the composition root binds at boot. The Drizzle backend
// (./write-service-drizzle) implements this. M27 carries NO PHI (D18); money is INTEGER CENTS (D8). Every
// mutation emits its matching `m27.*` outbox event (apps/backend/.../events-by-m27.ts) in the SAME tx.
import type { M27WriteActor } from "./actor";
import type {
  BadDebtKind,
  BadDebtRecordView,
  ComplianceWindowView,
  CostCenterMappingView,
  CostReportDetailView,
  EcrSubmissionView,
  MappingPreviewView,
  StatisticDataView,
  TrialBalanceImportView,
  ValidationOverrideView,
  ValidationRuleView,
  WageDataImportView,
  WorksheetCode,
  WorksheetView,
} from "./read-service";

// ── injected ports (bound by the composition root at boot) ──────────────────────────────────────────────

/**
 * The §4.10 `m27.*` transactional-outbox emitter. `publish` writes the `outbox_event` row on the CALLER'S
 * tx so it commits in the same unit of work as the mutation; the dispatcher Value.Check's the payload
 * against the registered catalog schema (refuse-on-failure). Optional — best-effort until the dispatcher
 * binds (the M30 WriteOutboxPort precedent).
 */
export interface WriteOutboxPort {
  publish(
    tx: unknown,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/**
 * The §4.8 BullMQ producer for the M27 worker queues (`trial-balance-pull`, `wage-data-pull`,
 * `statistics-refresh`, `validation-run`, `allocation-recompute`, `ecr-generation`). `enqueue` is
 * idempotency-keyed by `dedupeKey`. The default deny-stub mints a synthetic job id so a dev boot without a
 * queue still returns a well-formed accepted-view (the M30 RecomputeEnqueuePort precedent).
 */
export interface RecomputeEnqueuePort {
  enqueue(
    queueName: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly jobId: string }>;
}

// ── accepted-view return shapes (async enqueue endpoints) ───────────────────────────────────────────────

export interface RefreshInputsAcceptedView {
  readonly trialBalanceJobId: string;
  readonly wageDataJobId: string | null;
  readonly statisticsJobId: string;
}
export interface ImportJobAcceptedView {
  readonly jobId: string;
}
export interface StatisticsRefreshAcceptedView {
  readonly jobId: string;
}
export interface AllocationAcceptedView {
  readonly jobId: string;
  readonly worksheetsToRecompute: readonly WorksheetCode[];
}
export interface ValidationJobAcceptedView {
  readonly validationId: string;
  readonly jobId: string;
  readonly ruleSetVersion: number;
}

// ── command args ───────────────────────────────────────────────────────────────────────────────────────

export interface CreateCostReportArgs {
  readonly providerEntityId: string;
  /** YYYY-MM-DD. */
  readonly fiscalYearStartDate: string;
  /** YYYY-MM-DD; the (provider, FYE) uniqueness key (D1). */
  readonly fiscalYearEndDate: string;
  readonly wageSource?: "gusto" | "manual";
}

export interface PatchCostReportArgs {
  readonly expectedVersion: number;
  readonly badDebtClaimed?: boolean;
  readonly wageSource?: "gusto" | "manual";
}

export interface PutWorksheetArgs {
  readonly expectedVersion: number;
  readonly data: unknown;
}

export interface MappingChange {
  readonly xeroAccountCode: string;
  readonly xeroAccountName: string;
  readonly cmsCostCenterCode: string;
}
export interface PreviewMappingArgs {
  readonly changes: readonly MappingChange[];
}
export interface ApplyMappingArgs {
  readonly changes: readonly MappingChange[];
  readonly mappingSource?: "tenant_override" | "tenant_extended";
}
export interface ResetMappingArgs {
  readonly keepTenantOverrides: boolean;
}

export interface AddBadDebtArgs {
  readonly periodLabel: string;
  readonly debtKind: BadDebtKind;
  readonly amountCents: number;
  readonly collectionEffortsDocumented?: boolean;
  readonly supportingDocumentIds?: readonly string[];
}
export interface UpdateBadDebtArgs {
  readonly periodLabel?: string;
  readonly debtKind?: BadDebtKind;
  readonly amountCents?: number;
  readonly collectionEffortsDocumented?: boolean;
  readonly supportingDocumentIds?: readonly string[];
}

export interface ManualTrialBalanceArgs {
  /** The post-normalization GL rows (parsed from the uploaded CSV at the route). */
  readonly normalizedAccounts: readonly unknown[];
}
export interface ManualWageDataArgs {
  readonly normalizedWageRows: readonly unknown[];
}

export interface OverrideValidationResultArgs {
  readonly validationResultId: string;
  readonly reason: string;
}

export interface ApproveForSubmitArgs {
  /** The validation run whose zero-unresolved-blocking-failures gate authorizes approval (§2.3). */
  readonly validationId?: string;
}
/**
 * Submit takes NO identity from the client: the attester is the authenticated actor and the approver is the
 * one stored server-side at `approveForSubmit` (GAP-081). Legacy body fields are ignored at the route.
 */
export type SubmitArgs = Record<string, never>;
export interface SubmitPastDeadlineArgs {
  readonly reason: string;
}

export interface RecordAcknowledgmentArgs {
  /** Exactly one of acknowledgment-number (acceptance) or rejection-code (rejection) per the DB CHECK. */
  readonly mcrefAcknowledgmentNumber?: string;
  readonly mcrefRejectionCode?: string;
  readonly mcrefRejectionDetail?: string;
}

export interface ReopenArgs {
  readonly reason: string;
  readonly reasonCategory: string;
}

export interface DeadlineExtensionArgs {
  /** YYYY-MM-DD — the MAC-granted new effective deadline. */
  readonly newEffectiveDeadlineDate: string;
}

export interface CreateValidationRuleArgs {
  readonly ruleCode: string;
  readonly category: string;
  readonly description: string;
  readonly severity: "block" | "warn" | "info";
  readonly macJurisdictionScope?: string;
  readonly predicateSpec: unknown;
}
export interface UpdateValidationRuleArgs {
  readonly description?: string;
  readonly severity?: "block" | "warn" | "info";
  readonly macJurisdictionScope?: string;
  readonly predicateSpec?: unknown;
}

// ── the write service ─────────────────────────────────────────────────────────────────────────────────

/**
 * The M27 WRITE route-service contract — every mutating route in §4.1. Each method takes the server-
 * assembled {@link M27WriteActor}; the Drizzle backend opens one `withOrgContext` tx per call (RLS-scoped
 * to `app.org_id`), drives the pure @chartwarden/cost-report lifecycle reducer for state transitions, enforces
 * §2.5 version checks (VERSION_CONFLICT), and emits the matching `m27.*` outbox event in the same tx.
 */
export interface M27WriteRouteService {
  // ── cost-report lifecycle root ──
  createCostReport(actor: M27WriteActor, args: CreateCostReportArgs): Promise<CostReportDetailView>;
  patchCostReport(
    actor: M27WriteActor,
    costReportId: string,
    args: PatchCostReportArgs,
  ): Promise<CostReportDetailView>;
  refreshInputs(actor: M27WriteActor, costReportId: string): Promise<RefreshInputsAcceptedView>;

  // ── worksheets ──
  putWorksheet(
    actor: M27WriteActor,
    costReportId: string,
    worksheetCode: WorksheetCode,
    args: PutWorksheetArgs,
  ): Promise<WorksheetView>;
  computeWorksheet(
    actor: M27WriteActor,
    costReportId: string,
    worksheetCode: WorksheetCode,
  ): Promise<AllocationAcceptedView>;
  allocate(actor: M27WriteActor, costReportId: string): Promise<AllocationAcceptedView>;

  // ── cost-center mappings ──
  previewCostCenterMapping(
    actor: M27WriteActor,
    costReportId: string,
    args: PreviewMappingArgs,
  ): Promise<MappingPreviewView>;
  applyCostCenterMapping(
    actor: M27WriteActor,
    costReportId: string,
    args: ApplyMappingArgs,
  ): Promise<readonly CostCenterMappingView[]>;
  resetCostCenterMapping(
    actor: M27WriteActor,
    costReportId: string,
    args: ResetMappingArgs,
  ): Promise<readonly CostCenterMappingView[]>;

  // ── bad debt ──
  addBadDebt(
    actor: M27WriteActor,
    costReportId: string,
    args: AddBadDebtArgs,
  ): Promise<BadDebtRecordView>;
  updateBadDebt(
    actor: M27WriteActor,
    costReportId: string,
    recordId: string,
    args: UpdateBadDebtArgs,
  ): Promise<BadDebtRecordView>;
  deleteBadDebt(
    actor: M27WriteActor,
    costReportId: string,
    recordId: string,
  ): Promise<BadDebtRecordView>;

  // ── statistics ──
  refreshStatistics(
    actor: M27WriteActor,
    costReportId: string,
  ): Promise<StatisticsRefreshAcceptedView>;

  // ── imports ──
  triggerTrialBalancePull(
    actor: M27WriteActor,
    costReportId: string,
  ): Promise<ImportJobAcceptedView>;
  manualTrialBalance(
    actor: M27WriteActor,
    costReportId: string,
    args: ManualTrialBalanceArgs,
  ): Promise<TrialBalanceImportView>;
  triggerWageDataPull(actor: M27WriteActor, costReportId: string): Promise<ImportJobAcceptedView>;
  manualWageData(
    actor: M27WriteActor,
    costReportId: string,
    args: ManualWageDataArgs,
  ): Promise<WageDataImportView>;

  // ── validation ──
  enqueueValidation(actor: M27WriteActor, costReportId: string): Promise<ValidationJobAcceptedView>;
  overrideValidationResult(
    actor: M27WriteActor,
    costReportId: string,
    validationId: string,
    args: OverrideValidationResultArgs,
  ): Promise<ValidationOverrideView>;

  // ── lifecycle transitions ──
  returnToDraft(actor: M27WriteActor, costReportId: string): Promise<CostReportDetailView>;
  approveForSubmit(
    actor: M27WriteActor,
    costReportId: string,
    args: ApproveForSubmitArgs,
  ): Promise<CostReportDetailView>;
  submit(actor: M27WriteActor, costReportId: string): Promise<CostReportDetailView>;
  submitPastDeadline(
    actor: M27WriteActor,
    costReportId: string,
    args: SubmitPastDeadlineArgs,
  ): Promise<CostReportDetailView>;

  // ── acknowledgment + reopen ──
  recordAcknowledgment(
    actor: M27WriteActor,
    costReportId: string,
    submissionId: string,
    args: RecordAcknowledgmentArgs,
  ): Promise<EcrSubmissionView>;
  reopen(
    actor: M27WriteActor,
    costReportId: string,
    args: ReopenArgs,
  ): Promise<CostReportDetailView>;

  // ── compliance window ──
  recordDeadlineExtension(
    actor: M27WriteActor,
    costReportId: string,
    args: DeadlineExtensionArgs,
  ): Promise<ComplianceWindowView>;

  // ── rule library ──
  createValidationRule(
    actor: M27WriteActor,
    args: CreateValidationRuleArgs,
  ): Promise<ValidationRuleView>;
  updateValidationRule(
    actor: M27WriteActor,
    ruleId: string,
    args: UpdateValidationRuleArgs,
  ): Promise<ValidationRuleView>;
  disableValidationRule(actor: M27WriteActor, ruleId: string): Promise<ValidationRuleView>;
}
