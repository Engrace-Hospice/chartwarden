// apps/backend/__tests__/cost-report-inject.test.ts — M27 (Cost Report) HTTP-layer smoke suite
// (TASK-050A / TEST-001).
//
// M27 had ZERO Fastify `.inject()` coverage before this file: `27-cost-report/__tests__/cap-context.test.ts`
// exercises the pure D13 cap-context resolver directly and `m26-cost-report-cap-seam.live.test.ts` exercises
// the narrow M26 cap-seam bind — neither drives a single route through the real Fastify host, so a mis-wired
// guard, a typo'd permission key, or a schema that never reaches the handler is invisible to both. This file
// is that pass, cloned from `orders-routes.test.ts` (the reference implementation for this effort) and
// `discipline-plans-inject.test.ts` (the worked example for a module that ships no `createInMemory*Backend`):
// `buildServer()` mounts the host, `mountM27Routes()` mounts the §4.1 forty-five-route inventory over a
// hand-rolled in-memory `{ readService, writeService }` pair (M27 ships no in-memory backend the way M11
// does, so this file is that backend, scoped to this file only), the REAL Authorization Contract gates every
// route on the §4.6 permission keys, and the three §4.7 ABAC predicates M27 owns are built with
// `buildM27AbacPredicates` over a resolver closed on this same in-memory cost-report store — the
// `buildOrderAbacPredicates`-over-`createInMemoryOrderBackend` pattern M11's test established. A permissive
// `step_up_recent` stub is registered alongside them (this file's own fresh predicate registry, never the
// shared boot one) so the approve/submit/reopen/override routes' `requireStepUp` gate is exercised as
// PASSING at least once.
//
// The business RULES (the CMS-1984-14 worksheet lifecycle, the §2.5 version-conflict checks, the M23/M26
// forward-seam cap calc) are covered elsewhere (or remain deny-stubbed pending the M23/M26 live bind — see
// the module banner in `apps/backend/src/modules/27-cost-report/index.ts`); this file does not re-derive
// them. Its in-memory service intentionally skips the lifecycle-state-machine + optimistic-concurrency logic
// (note `PERIOD_ACTIVE`/`cost_report_period_active` is exported by `routes/guards.ts` but composed into NO
// route today — verified by grep — so this file does not need to seed distinct lifecycle states to reach a
// route's edit surface) so it can focus on what only `inject()` can prove: every one of the forty-five
// routes reaches its handler with the RIGHT permission key, the RIGHT ABAC composition, and a body that
// TypeBox actually validates — a 401 with no session, a 403 with no grant, a 422 on a malformed body, and
// one legitimately-authorized 2xx call per route.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M27_PERMISSION_KEY_LIST,
  buildM27AbacPredicates,
  mountM27Routes,
  type ReadingM27AbacResolver,
} from "../src/modules/27-cost-report/index";
import type {
  BadDebtRecordView,
  ComplianceWindowView,
  CostCenterMappingView,
  CostReportDetailView,
  CostReportState,
  CostReportSummaryView,
  EcrSubmissionView,
  M27ReadRouteService,
  SnapshotDetailView,
  SnapshotSummaryView,
  StatisticDataView,
  TrialBalanceImportView,
  ValidationOverrideView,
  ValidationRuleView,
  ValidationRunDetailView,
  ValidationRunSummaryView,
  WageDataImportView,
  WorksheetView,
} from "../src/modules/27-cost-report/routes/read-service";
import type { M27WriteRouteService } from "../src/modules/27-cost-report/routes/write-service";

// ── the header-auth shim (the M11/M15 precedent), extended with the `request.context.providerEntityIds`
// M27's §4.7 `cost_report_editor_for_provider` / `cost_report_approver_for_provider` predicates read FIRST
// (before falling back to the RLS-backed membership-scope lookup — see `membershipInProviderScope` in
// `abac-predicates.ts`), plus `attributes.membershipId` the write actor (`writeActorOf`) requires.
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  request.context.attributes.stepUpRecent = true;
  const providerEntity = request.headers["x-test-provider-entity"];
  if (typeof providerEntity === "string" && providerEntity.length > 0) {
    request.context.providerEntityIds = [providerEntity];
  }
}

// ── fixed ids (the M11/M15 style — distinct, valid-`uuid`-format constants) ────────────────────────────
const ORG = "org_a";
const PROVIDER_ENTITY = "10101010-1010-4101-8101-101010101010";
const COST_REPORT = "11111111-1111-4111-8111-111111111111";
const VALIDATION_ID = "22222222-2222-4222-8222-222222222222";
const VALIDATION_RESULT_ID = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_ID = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT_ID = "55555555-5555-4555-8555-555555555555";
const BAD_DEBT_RECORD = "66666666-6666-4666-8666-666666666666";
const RULE_ID = "77777777-7777-4777-8777-777777777777";
const RN_MEMBERSHIP = "88888888-8888-4888-8888-888888888888";
const NOW = "2026-08-04T12:00:00.000Z";
const WORKSHEET_CODE = "S";

// ── the in-memory M27 backend (this file's own — M27 ships no `createInMemory*Backend`) ────────────────
function createM27Backend(): {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
  readonly abacResolver: ReadingM27AbacResolver;
} {
  const costReports = new Map<string, CostReportDetailView>();
  const worksheets = new Map<string, WorksheetView>();
  const costCenterMappings = new Map<string, CostCenterMappingView[]>();
  const badDebt = new Map<string, BadDebtRecordView>();
  const statistics = new Map<string, StatisticDataView | null>();
  const trialBalanceImports = new Map<string, TrialBalanceImportView[]>();
  const wageDataImports = new Map<string, WageDataImportView[]>();
  const validations = new Map<string, ValidationRunDetailView>();
  const ecrSubmissions = new Map<string, EcrSubmissionView>();
  const snapshots = new Map<string, SnapshotDetailView>();
  const complianceWindows = new Map<string, ComplianceWindowView>();
  const validationRules = new Map<string, ValidationRuleView>();
  let seq = 0;

  // ── seed one of every row the read/2xx-write surface can be exercised over ──────────────────────────
  costReports.set(COST_REPORT, {
    costReportId: COST_REPORT,
    organizationId: ORG,
    providerEntityId: PROVIDER_ENTITY,
    fiscalYearStartDate: "2025-10-01",
    fiscalYearEndDate: "2026-09-30",
    state: "populating",
    reopenCount: 0,
    badDebtClaimed: false,
    wageSource: "manual",
    version: 1,
    latestSnapshotId: SNAPSHOT_ID,
    latestValidation: null,
    latestSubmission: null,
    complianceWindow: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
  });

  worksheets.set(`${COST_REPORT}::${WORKSHEET_CODE}`, {
    worksheetId: "worksheet-1",
    costReportId: COST_REPORT,
    worksheetCode: WORKSHEET_CODE,
    data: { line1: 100 },
    computedAt: null,
    version: 1,
  });

  costCenterMappings.set(COST_REPORT, [
    {
      mappingId: "mapping-1",
      organizationId: ORG,
      providerEntityId: PROVIDER_ENTITY,
      fiscalYearInt: 2026,
      xeroAccountCode: "600",
      xeroAccountName: "Wages",
      cmsCostCenterCode: "6100",
      mappingSource: "platform_default",
      version: 1,
    },
  ]);

  badDebt.set(BAD_DEBT_RECORD, {
    recordId: BAD_DEBT_RECORD,
    organizationId: ORG,
    costReportId: COST_REPORT,
    periodLabel: "FY2025-Q4",
    debtKind: "deductible",
    amountCents: 1000,
    collectionEffortsDocumented: true,
    supportingDocumentIds: [],
    addedByMembershipId: RN_MEMBERSHIP,
    addedAt: NOW,
    deletedAt: null,
  });

  trialBalanceImports.set(COST_REPORT, [
    {
      importId: "tb-import-1",
      organizationId: ORG,
      costReportId: COST_REPORT,
      source: "xero",
      status: "complete",
      accountCount: 120,
      failureReason: null,
      pulledAt: NOW,
    },
  ]);

  wageDataImports.set(COST_REPORT, [
    {
      importId: "wd-import-1",
      organizationId: ORG,
      costReportId: COST_REPORT,
      source: "gusto",
      status: "complete",
      rowCount: 40,
      failureReason: null,
      pulledAt: NOW,
    },
  ]);

  validations.set(VALIDATION_ID, {
    validationId: VALIDATION_ID,
    organizationId: ORG,
    costReportId: COST_REPORT,
    status: "complete",
    ruleSetVersion: 1,
    passedCount: 5,
    failedCount: 1,
    warningCount: 0,
    overriddenCount: 0,
    skippedCount: 0,
    runStartedAt: NOW,
    runCompletedAt: NOW,
    results: [
      {
        resultId: VALIDATION_RESULT_ID,
        validationId: VALIDATION_ID,
        ruleId: RULE_ID,
        outcome: "fail",
        details: {},
        overridden: false,
        override: null,
        recordedAt: NOW,
      },
    ],
  });

  ecrSubmissions.set(SUBMISSION_ID, {
    submissionId: SUBMISSION_ID,
    organizationId: ORG,
    costReportId: COST_REPORT,
    snapshotId: SNAPSHOT_ID,
    status: "generated",
    ecrFileDocumentId: null,
    piFileDocumentId: null,
    supportingDocumentsDocumentIds: [],
    mcrefAcknowledgmentNumber: null,
    mcrefRejectionCode: null,
    mcrefRejectionDetail: null,
    generatedAt: NOW,
    uploadedAt: null,
    acknowledgedAt: null,
  });

  snapshots.set(SNAPSHOT_ID, {
    snapshotId: SNAPSHOT_ID,
    organizationId: ORG,
    costReportId: COST_REPORT,
    priorSnapshotId: null,
    contentHashSha256: "abc123",
    reason: "submit",
    createdByMembershipId: RN_MEMBERSHIP,
    createdAt: NOW,
    materializedInputs: {},
    worksheetSnapshot: {},
  });

  complianceWindows.set(COST_REPORT, {
    windowId: "window-1",
    organizationId: ORG,
    costReportId: COST_REPORT,
    deadlineDate: "2026-12-31",
    currentEffectiveDeadlineDate: "2026-12-31",
    lastAlertTier: "none",
    lastAlertTierEmittedAt: null,
    closedAt: null,
  });

  validationRules.set(RULE_ID, {
    ruleId: RULE_ID,
    organizationId: ORG,
    ruleCode: "TENANT-001",
    category: "wage_index",
    description: "Seed tenant rule",
    ruleSetVersion: 1,
    regulatoryRequired: false,
    severity: "warn",
    status: "active",
    macJurisdictionScope: "national",
    publishedAt: NOW,
    deprecatedAt: null,
  });

  function toSummary(row: CostReportDetailView): CostReportSummaryView {
    const {
      costReportId,
      organizationId,
      providerEntityId,
      fiscalYearStartDate,
      fiscalYearEndDate,
      state,
      reopenCount,
      badDebtClaimed,
      wageSource,
      version,
    } = row;
    return {
      costReportId,
      organizationId,
      providerEntityId,
      fiscalYearStartDate,
      fiscalYearEndDate,
      state,
      reopenCount,
      badDebtClaimed,
      wageSource,
      version,
    };
  }
  function toValidationSummary(row: ValidationRunDetailView): ValidationRunSummaryView {
    const { results: _results, ...summary } = row;
    return summary;
  }
  function toSnapshotSummary(row: SnapshotDetailView): SnapshotSummaryView {
    const { materializedInputs: _mi, worksheetSnapshot: _ws, ...summary } = row;
    return summary;
  }
  function mustGetCostReport(costReportId: string): CostReportDetailView {
    const row = costReports.get(costReportId);
    if (!row) throw new NotFoundError("cost report not found");
    return row;
  }
  function transitionState(costReportId: string, state: CostReportState): CostReportDetailView {
    const row = mustGetCostReport(costReportId);
    const updated: CostReportDetailView = { ...row, state, version: row.version + 1, updatedAt: NOW };
    costReports.set(costReportId, updated);
    return updated;
  }

  const readService: M27ReadRouteService = {
    async listCostReports(actor) {
      const items = [...costReports.values()]
        .filter((r) => r.organizationId === actor.organizationId)
        .map(toSummary);
      return { items, nextCursor: null, hasMore: false };
    },
    async getCostReport(_actor, costReportId) {
      return mustGetCostReport(costReportId);
    },
    async getWorksheet(_actor, costReportId, worksheetCode) {
      const row = worksheets.get(`${costReportId}::${worksheetCode}`);
      if (row) return row;
      return { worksheetId: null, costReportId, worksheetCode, data: null, computedAt: null, version: 0 };
    },
    async listCostCenterMappings(_actor, costReportId) {
      return costCenterMappings.get(costReportId) ?? [];
    },
    async listBadDebt(_actor, costReportId) {
      return [...badDebt.values()].filter((b) => b.costReportId === costReportId);
    },
    async getStatistics(_actor, costReportId) {
      return statistics.get(costReportId) ?? null;
    },
    async listTrialBalanceImports(_actor, costReportId) {
      return trialBalanceImports.get(costReportId) ?? [];
    },
    async listWageDataImports(_actor, costReportId) {
      return wageDataImports.get(costReportId) ?? [];
    },
    async listValidations(_actor, costReportId) {
      return [...validations.values()]
        .filter((v) => v.costReportId === costReportId)
        .map(toValidationSummary);
    },
    async getValidation(_actor, costReportId, validationId) {
      const row = validations.get(validationId);
      if (!row || row.costReportId !== costReportId) throw new NotFoundError("validation run not found");
      return row;
    },
    async listEcrSubmissions(_actor, costReportId) {
      return [...ecrSubmissions.values()].filter((s) => s.costReportId === costReportId);
    },
    async getEcrSubmission(_actor, costReportId, submissionId) {
      const row = ecrSubmissions.get(submissionId);
      if (!row || row.costReportId !== costReportId) throw new NotFoundError("ecr submission not found");
      return row;
    },
    async listSnapshots(_actor, costReportId) {
      return [...snapshots.values()].filter((s) => s.costReportId === costReportId).map(toSnapshotSummary);
    },
    async getSnapshot(_actor, costReportId, snapshotId) {
      const row = snapshots.get(snapshotId);
      if (!row || row.costReportId !== costReportId) throw new NotFoundError("snapshot not found");
      return row;
    },
    async getComplianceWindow(_actor, costReportId) {
      return complianceWindows.get(costReportId) ?? null;
    },
    async listValidationRules(_actor) {
      return [...validationRules.values()];
    },
  };

  const writeService: M27WriteRouteService = {
    async createCostReport(actor, args) {
      seq += 1;
      const id = `cost-report-created-${seq}`;
      const row: CostReportDetailView = {
        costReportId: id,
        organizationId: actor.organizationId,
        providerEntityId: args.providerEntityId,
        fiscalYearStartDate: args.fiscalYearStartDate,
        fiscalYearEndDate: args.fiscalYearEndDate,
        state: "draft",
        reopenCount: 0,
        badDebtClaimed: false,
        wageSource: args.wageSource ?? "manual",
        version: 1,
        latestSnapshotId: null,
        latestValidation: null,
        latestSubmission: null,
        complianceWindow: null,
        createdAt: NOW,
        updatedAt: NOW,
        closedAt: null,
      };
      costReports.set(id, row);
      return row;
    },
    async patchCostReport(_actor, costReportId, args) {
      const row = mustGetCostReport(costReportId);
      const updated: CostReportDetailView = {
        ...row,
        badDebtClaimed: args.badDebtClaimed ?? row.badDebtClaimed,
        wageSource: args.wageSource ?? row.wageSource,
        version: row.version + 1,
        updatedAt: NOW,
      };
      costReports.set(costReportId, updated);
      return updated;
    },
    async refreshInputs() {
      return { trialBalanceJobId: "job-tb-1", wageDataJobId: "job-wd-1", statisticsJobId: "job-stats-1" };
    },
    async putWorksheet(_actor, costReportId, worksheetCode, args) {
      const key = `${costReportId}::${worksheetCode}`;
      const prior = worksheets.get(key);
      const row: WorksheetView = {
        worksheetId: prior?.worksheetId ?? `worksheet-${key}`,
        costReportId,
        worksheetCode,
        data: args.data,
        computedAt: null,
        version: (prior?.version ?? 0) + 1,
      };
      worksheets.set(key, row);
      return row;
    },
    async computeWorksheet(_actor, _costReportId, worksheetCode) {
      return { jobId: "job-compute-1", worksheetsToRecompute: [worksheetCode] };
    },
    async allocate() {
      return { jobId: "job-allocate-1", worksheetsToRecompute: ["B", "C"] };
    },
    async previewCostCenterMapping(_actor, costReportId, args) {
      return {
        costReportId,
        changedAccounts: args.changes.map((c) => ({
          xeroAccountCode: c.xeroAccountCode,
          fromCmsCostCenterCode: null,
          toCmsCostCenterCode: c.cmsCostCenterCode,
        })),
        unmappedAccounts: [],
      };
    },
    async applyCostCenterMapping(_actor, costReportId, args) {
      const rows: CostCenterMappingView[] = args.changes.map((c, i) => ({
        mappingId: `mapping-${costReportId}-${i}`,
        organizationId: ORG,
        providerEntityId: PROVIDER_ENTITY,
        fiscalYearInt: 2026,
        xeroAccountCode: c.xeroAccountCode,
        xeroAccountName: c.xeroAccountName,
        cmsCostCenterCode: c.cmsCostCenterCode,
        mappingSource: args.mappingSource ?? "tenant_override",
        version: 1,
      }));
      costCenterMappings.set(costReportId, rows);
      return rows;
    },
    async resetCostCenterMapping(_actor, costReportId) {
      return costCenterMappings.get(costReportId) ?? [];
    },
    async addBadDebt(actor, costReportId, args) {
      const recordId = `bad-debt-${badDebt.size + 1}`;
      const row: BadDebtRecordView = {
        recordId,
        organizationId: actor.organizationId,
        costReportId,
        periodLabel: args.periodLabel,
        debtKind: args.debtKind,
        amountCents: args.amountCents,
        collectionEffortsDocumented: args.collectionEffortsDocumented ?? false,
        supportingDocumentIds: args.supportingDocumentIds ?? [],
        addedByMembershipId: actor.membershipId,
        addedAt: NOW,
        deletedAt: null,
      };
      badDebt.set(recordId, row);
      return row;
    },
    async updateBadDebt(_actor, _costReportId, recordId, args) {
      const row = badDebt.get(recordId);
      if (!row) throw new NotFoundError("bad debt record not found");
      const updated: BadDebtRecordView = {
        ...row,
        periodLabel: args.periodLabel ?? row.periodLabel,
        debtKind: args.debtKind ?? row.debtKind,
        amountCents: args.amountCents ?? row.amountCents,
        collectionEffortsDocumented: args.collectionEffortsDocumented ?? row.collectionEffortsDocumented,
        supportingDocumentIds: args.supportingDocumentIds ?? row.supportingDocumentIds,
      };
      badDebt.set(recordId, updated);
      return updated;
    },
    async deleteBadDebt(_actor, _costReportId, recordId) {
      const row = badDebt.get(recordId);
      if (!row) throw new NotFoundError("bad debt record not found");
      const updated: BadDebtRecordView = { ...row, deletedAt: NOW };
      badDebt.set(recordId, updated);
      return updated;
    },
    async refreshStatistics() {
      return { jobId: "job-stats-refresh-1" };
    },
    async triggerTrialBalancePull() {
      return { jobId: "job-tb-pull-1" };
    },
    async manualTrialBalance(_actor, costReportId, args) {
      const row: TrialBalanceImportView = {
        importId: `tb-import-manual-${(trialBalanceImports.get(costReportId)?.length ?? 0) + 1}`,
        organizationId: ORG,
        costReportId,
        source: "manual_csv",
        status: "complete",
        accountCount: args.normalizedAccounts.length,
        failureReason: null,
        pulledAt: NOW,
      };
      trialBalanceImports.set(costReportId, [...(trialBalanceImports.get(costReportId) ?? []), row]);
      return row;
    },
    async triggerWageDataPull() {
      return { jobId: "job-wd-pull-1" };
    },
    async manualWageData(_actor, costReportId, args) {
      const row: WageDataImportView = {
        importId: `wd-import-manual-${(wageDataImports.get(costReportId)?.length ?? 0) + 1}`,
        organizationId: ORG,
        costReportId,
        source: "manual_csv",
        status: "complete",
        rowCount: args.normalizedWageRows.length,
        failureReason: null,
        pulledAt: NOW,
      };
      wageDataImports.set(costReportId, [...(wageDataImports.get(costReportId) ?? []), row]);
      return row;
    },
    async enqueueValidation() {
      return { validationId: VALIDATION_ID, jobId: "job-validate-1", ruleSetVersion: 1 };
    },
    async overrideValidationResult(actor, costReportId, validationId, args) {
      const run = validations.get(validationId);
      if (!run || run.costReportId !== costReportId) throw new NotFoundError("validation run not found");
      const override: ValidationOverrideView = {
        overrideId: `override-${validationId}`,
        organizationId: actor.organizationId,
        validationResultId: args.validationResultId,
        overriddenByMembershipId: actor.membershipId,
        reason: args.reason,
        overriddenAt: NOW,
      };
      const updated: ValidationRunDetailView = {
        ...run,
        results: run.results.map((r) =>
          r.resultId === args.validationResultId ? { ...r, overridden: true, override } : r,
        ),
      };
      validations.set(validationId, updated);
      return override;
    },
    async returnToDraft(_actor, costReportId) {
      return transitionState(costReportId, "populating");
    },
    async approveForSubmit(_actor, costReportId) {
      return transitionState(costReportId, "approved_for_submit");
    },
    async submit(_actor, costReportId) {
      return transitionState(costReportId, "submitted");
    },
    async submitPastDeadline(_actor, costReportId) {
      return transitionState(costReportId, "submitted");
    },
    async recordAcknowledgment(_actor, costReportId, submissionId, args) {
      const row = ecrSubmissions.get(submissionId);
      if (!row || row.costReportId !== costReportId) throw new NotFoundError("ecr submission not found");
      const updated: EcrSubmissionView = {
        ...row,
        status: args.mcrefAcknowledgmentNumber ? "accepted" : "rejected",
        mcrefAcknowledgmentNumber: args.mcrefAcknowledgmentNumber ?? null,
        mcrefRejectionCode: args.mcrefRejectionCode ?? null,
        mcrefRejectionDetail: args.mcrefRejectionDetail ?? null,
        acknowledgedAt: NOW,
      };
      ecrSubmissions.set(submissionId, updated);
      return updated;
    },
    async reopen(_actor, costReportId) {
      const row = mustGetCostReport(costReportId);
      const updated: CostReportDetailView = {
        ...row,
        state: "reopened",
        reopenCount: row.reopenCount + 1,
        version: row.version + 1,
        updatedAt: NOW,
      };
      costReports.set(costReportId, updated);
      return updated;
    },
    async recordDeadlineExtension(_actor, costReportId, args) {
      const prior = complianceWindows.get(costReportId);
      const updated: ComplianceWindowView = prior
        ? { ...prior, currentEffectiveDeadlineDate: args.newEffectiveDeadlineDate }
        : {
            windowId: `window-${costReportId}`,
            organizationId: ORG,
            costReportId,
            deadlineDate: args.newEffectiveDeadlineDate,
            currentEffectiveDeadlineDate: args.newEffectiveDeadlineDate,
            lastAlertTier: "none",
            lastAlertTierEmittedAt: null,
            closedAt: null,
          };
      complianceWindows.set(costReportId, updated);
      return updated;
    },
    async createValidationRule(_actor, args) {
      const ruleId = `rule-${validationRules.size + 1}`;
      const row: ValidationRuleView = {
        ruleId,
        organizationId: ORG,
        ruleCode: args.ruleCode,
        category: args.category,
        description: args.description,
        ruleSetVersion: 1,
        regulatoryRequired: false,
        severity: args.severity,
        status: "active",
        macJurisdictionScope: args.macJurisdictionScope ?? "national",
        publishedAt: NOW,
        deprecatedAt: null,
      };
      validationRules.set(ruleId, row);
      return row;
    },
    async updateValidationRule(_actor, ruleId, args) {
      const row = validationRules.get(ruleId);
      if (!row) throw new NotFoundError("validation rule not found");
      const updated: ValidationRuleView = {
        ...row,
        description: args.description ?? row.description,
        severity: args.severity ?? row.severity,
        macJurisdictionScope: args.macJurisdictionScope ?? row.macJurisdictionScope,
      };
      validationRules.set(ruleId, updated);
      return updated;
    },
    async disableValidationRule(_actor, ruleId) {
      const row = validationRules.get(ruleId);
      if (!row) throw new NotFoundError("validation rule not found");
      const updated: ValidationRuleView = { ...row, status: "deprecated", deprecatedAt: NOW };
      validationRules.set(ruleId, updated);
      return updated;
    },
  };

  // The §4.7 resolver: `loadCostReport` is a real (in-memory) lookup so `cost_report_editor_for_provider`
  // and `cost_report_approver_for_provider` can resolve a `costReportId`-only target (the PATCH/PUT/POST
  // routes keyed on `:id`, per `targetCostReportId` in guards.ts) to the seeded report's real
  // `providerEntityId`; `loadMembershipProviderScope` + `hasElevatedApproval` are permissive stubs — this
  // file's `x-test-provider-entity` header already puts the direct-match branch of
  // `membershipInProviderScope` (context.providerEntityIds.includes(providerEntityId)) in scope for every
  // ABAC-gated route, so the membership-scope RLS fallback is never actually exercised, and a permissive
  // `hasElevatedApproval` is this file's `step_up_recent`-stub precedent applied to the approver predicate.
  const abacResolver: ReadingM27AbacResolver = {
    async loadCostReport(ctx, costReportId) {
      const row = costReports.get(costReportId);
      if (!row || row.organizationId !== ctx.organizationId) return null;
      return {
        costReportId: row.costReportId,
        organizationId: row.organizationId,
        providerEntityId: row.providerEntityId,
        state: row.state,
      };
    },
    async loadMembershipProviderScope(ctx, membershipId) {
      return { membershipId, organizationId: ctx.organizationId, providerEntityIds: [PROVIDER_ENTITY] };
    },
    async hasElevatedApproval() {
      return true;
    },
  };

  return { readService, writeService, abacResolver };
}

// ── server assembly (the M11/M15 `makeServer()` precedent) ──────────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "billing_cost_report_admin",
  "x-test-membership": RN_MEMBERSHIP,
  "x-test-provider-entity": PROVIDER_ENTITY,
};
const NONE_HEADERS = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "" };

function makeServer() {
  const backend = createM27Backend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...M27_PERMISSION_KEY_LIST] }],
    },
    { orgId: ORG, userId: "none_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }] },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent): the three §4.7 predicates M27 owns, built
  // over THIS backend's resolver, plus a permissive `step_up_recent` stub so the approve/submit/reopen/
  // override routes' `requireStepUp` gate has a real PASSING path in this file (see the file banner).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM27AbacPredicates({ resolver: backend.abacResolver }))) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM27Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── §4.1 401 / 403 / 422 boundary cases ──────────────────────────────────────────────────────────────────
describe("M27 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/cost-reports" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M27 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/cost-reports", headers: NONE_HEADERS });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/cost-reports/${COST_REPORT}`,
      headers: { ...SUPER_HEADERS, "idempotency-key": "k-422" },
      payload: {}, // missing the required `expectedVersion`
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── one legitimately-authorized 2xx call per route (the bulk of the file) ──────────────────────────────
interface RouteCase {
  readonly label: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: Record<string, unknown>;
  readonly expectStatus: number;
}

const IDEMP = (key: string) => ({ "idempotency-key": key });

const ROUTE_CASES: readonly RouteCase[] = [
  // 1–11 — the cost-report lifecycle root.
  {
    label: "1 POST /cost-reports",
    method: "POST",
    url: "/api/v1/cost-reports",
    headers: { ...SUPER_HEADERS, ...IDEMP("k1") },
    payload: { providerEntityId: PROVIDER_ENTITY, fiscalYearStartDate: "2025-10-01", fiscalYearEndDate: "2026-09-30" },
    expectStatus: 201,
  },
  { label: "2 GET /cost-reports", method: "GET", url: "/api/v1/cost-reports", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "3 GET /cost-reports/:id",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "4 PATCH /cost-reports/:id",
    method: "PATCH",
    url: `/api/v1/cost-reports/${COST_REPORT}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k4") },
    payload: { expectedVersion: 1, badDebtClaimed: true },
    expectStatus: 200,
  },
  {
    label: "5 POST /cost-reports/:id/refresh-inputs",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/refresh-inputs`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k5") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "6 POST /cost-reports/:id/allocate",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/allocate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k6") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "7 POST /cost-reports/:id/return-to-draft",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/return-to-draft`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k7") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "8 POST /cost-reports/:id/approve-for-submit",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/approve-for-submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k8") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "9 POST /cost-reports/:id/submit",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k9") },
    payload: { attestedByMembershipId: RN_MEMBERSHIP, attestedAt: NOW },
    expectStatus: 200,
  },
  {
    label: "10 POST /cost-reports/:id/submit-past-deadline",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/submit-past-deadline`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k10") },
    payload: {
      attestedByMembershipId: RN_MEMBERSHIP,
      attestedAt: NOW,
      reason: "MAC-granted extension recorded after the filing deadline had already passed.",
    },
    expectStatus: 200,
  },
  {
    label: "11 POST /cost-reports/:id/reopen",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/reopen`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k11") },
    payload: { reason: "MAC requested a revision after the original submission was filed.", reasonCategory: "mac_revision_request" },
    expectStatus: 200,
  },

  // 12–14 — worksheets.
  {
    label: "12 GET /cost-reports/:id/worksheets/:code",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/worksheets/${WORKSHEET_CODE}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "13 PUT /cost-reports/:id/worksheets/:code",
    method: "PUT",
    url: `/api/v1/cost-reports/${COST_REPORT}/worksheets/${WORKSHEET_CODE}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k13") },
    payload: { expectedVersion: 1, data: { line1: 200 } },
    expectStatus: 200,
  },
  {
    label: "14 POST /cost-reports/:id/worksheets/:code/compute",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/worksheets/${WORKSHEET_CODE}/compute`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k14") },
    payload: {},
    expectStatus: 202,
  },

  // 15–18 — cost-center mappings.
  {
    label: "15 GET /cost-reports/:id/cost-center-mappings",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/cost-center-mappings`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "16 POST /cost-reports/:id/cost-center-mappings/preview",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/cost-center-mappings/preview`,
    headers: SUPER_HEADERS, // no Idempotency-Key on the no-write preview route
    payload: { changes: [{ xeroAccountCode: "600", xeroAccountName: "Wages", cmsCostCenterCode: "6100" }] },
    expectStatus: 200,
  },
  {
    label: "17 POST /cost-reports/:id/cost-center-mappings/apply",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/cost-center-mappings/apply`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k17") },
    payload: { changes: [{ xeroAccountCode: "600", xeroAccountName: "Wages", cmsCostCenterCode: "6100" }] },
    expectStatus: 200,
  },
  {
    label: "18 POST /cost-reports/:id/cost-center-mappings/reset-to-platform-default",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/cost-center-mappings/reset-to-platform-default`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k18") },
    payload: { keepTenantOverrides: true },
    expectStatus: 200,
  },

  // 19–22 — bad debt.
  {
    label: "19 GET /cost-reports/:id/bad-debt",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/bad-debt`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "20 POST /cost-reports/:id/bad-debt",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/bad-debt`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k20") },
    payload: { periodLabel: "FY2026-Q1", debtKind: "deductible", amountCents: 5000 },
    expectStatus: 201,
  },
  {
    label: "21 PATCH /cost-reports/:id/bad-debt/:recordId",
    method: "PATCH",
    url: `/api/v1/cost-reports/${COST_REPORT}/bad-debt/${BAD_DEBT_RECORD}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k21") },
    payload: { amountCents: 6000 },
    expectStatus: 200,
  },
  {
    label: "22 DELETE /cost-reports/:id/bad-debt/:recordId",
    method: "DELETE",
    url: `/api/v1/cost-reports/${COST_REPORT}/bad-debt/${BAD_DEBT_RECORD}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k22") },
    expectStatus: 200,
  },

  // 23–24 — statistics.
  {
    label: "23 GET /cost-reports/:id/statistics",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/statistics`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "24 POST /cost-reports/:id/statistics/refresh",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/statistics/refresh`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k24") },
    payload: {},
    expectStatus: 202,
  },

  // 25–30 — imports (trial balance + wage data).
  {
    label: "25 GET /cost-reports/:id/imports/trial-balance",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/imports/trial-balance`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "26 POST /cost-reports/:id/imports/trial-balance",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/imports/trial-balance`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k26") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "27 POST /cost-reports/:id/imports/trial-balance/manual",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/imports/trial-balance/manual`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k27") },
    payload: { normalizedAccounts: [{ account: "600", amountCents: 10000 }] },
    expectStatus: 201,
  },
  {
    label: "28 GET /cost-reports/:id/imports/wage-data",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/imports/wage-data`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "29 POST /cost-reports/:id/imports/wage-data",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/imports/wage-data`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k29") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "30 POST /cost-reports/:id/imports/wage-data/manual",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/imports/wage-data/manual`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k30") },
    payload: { normalizedWageRows: [{ employee: "e-1", hours: 40 }] },
    expectStatus: 201,
  },

  // 31–34 — validations.
  {
    label: "31 GET /cost-reports/:id/validations",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/validations`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "32 GET /cost-reports/:id/validations/:vid",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/validations/${VALIDATION_ID}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "33 POST /cost-reports/:id/validate",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/validate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k33") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "34 POST /cost-reports/:id/validations/:vid/overrides",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/validations/${VALIDATION_ID}/overrides`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k34") },
    payload: { validationResultId: VALIDATION_RESULT_ID, reason: "Reviewed supporting documentation and confirmed the amount is correct." },
    expectStatus: 201,
  },

  // 35–37 — ECR submissions.
  {
    label: "35 GET /cost-reports/:id/ecr-submissions",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/ecr-submissions`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "36 GET /cost-reports/:id/ecr-submissions/:sid",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/ecr-submissions/${SUBMISSION_ID}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "37 POST /cost-reports/:id/ecr-submissions/:sid/acknowledgments",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/ecr-submissions/${SUBMISSION_ID}/acknowledgments`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k37") },
    payload: { mcrefAcknowledgmentNumber: "ACK-0001" },
    expectStatus: 200,
  },

  // 38–39 — snapshots.
  {
    label: "38 GET /cost-reports/:id/snapshots",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/snapshots`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "39 GET /cost-reports/:id/snapshots/:sid",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/snapshots/${SNAPSHOT_ID}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // 40–41 — compliance window.
  {
    label: "40 GET /cost-reports/:id/compliance-window",
    method: "GET",
    url: `/api/v1/cost-reports/${COST_REPORT}/compliance-window`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "41 POST /cost-reports/:id/deadline-extensions",
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/deadline-extensions`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k41") },
    payload: { newEffectiveDeadlineDate: "2027-01-31" },
    expectStatus: 201,
  },

  // 42–45 — the tenant validation-rule library.
  {
    label: "42 GET /cost-report-validation-rules",
    method: "GET",
    url: "/api/v1/cost-report-validation-rules",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "43 POST /cost-report-validation-rules",
    method: "POST",
    url: "/api/v1/cost-report-validation-rules",
    headers: { ...SUPER_HEADERS, ...IDEMP("k43") },
    payload: {
      ruleCode: "TENANT-002",
      category: "wage_index",
      description: "A new tenant validation rule",
      severity: "warn",
      predicateSpec: { kind: "always_pass" },
    },
    expectStatus: 201,
  },
  {
    label: "44 PATCH /cost-report-validation-rules/:id",
    method: "PATCH",
    url: `/api/v1/cost-report-validation-rules/${RULE_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k44") },
    payload: { description: "An updated tenant validation rule description" },
    expectStatus: 200,
  },
  {
    label: "45 POST /cost-report-validation-rules/:id/disable",
    method: "POST",
    url: `/api/v1/cost-report-validation-rules/${RULE_ID}/disable`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k45") },
    payload: {},
    expectStatus: 200,
  },
];

describe.each(ROUTE_CASES)("M27 route smoke — $label", (c) => {
  it(`reaches its handler and returns ${c.expectStatus}`, async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: c.method, url: c.url, headers: c.headers, payload: c.payload });
    expect(res.statusCode).toBe(c.expectStatus);
    await app.close();
  });
});
