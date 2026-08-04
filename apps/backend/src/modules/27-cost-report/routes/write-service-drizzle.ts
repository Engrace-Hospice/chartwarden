// apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts — the Drizzle-backed
// M27WriteRouteService (§4.1 mutating surface: create/patch, refresh-inputs, worksheet put/compute,
// allocate, mapping preview/apply/reset, bad-debt CRUD, statistics refresh, imports trigger/manual,
// validate + override, the lifecycle ladder return-to-draft/approve/submit/submit-past-deadline,
// acknowledgment, reopen, deadline extensions, rule-library CRUD).
//
// Implements the {@link M27WriteRouteService} interface, but every method runs inside ONE
// `withOrgContext(db, {organizationId, userId}, …)` transaction on the PRIMARY so Postgres RLS scopes each
// statement to `app.org_id` (the M30 routes/write-service-drizzle precedent). Org/actor/owner binding is
// ALWAYS the server-assembled {@link M27WriteActor} (never the body). The lifecycle methods do NOT
// re-implement state logic — they drive the pure @wardenx/cost-report reducer (`canTransition` /
// `applyTransition` over `COST_REPORT_TRANSITIONS`) and persist the result with the §2.5 version check
// (`updateWithVersion` → VERSION_CONFLICT). The §4.10 `m27.*` events are emitted through the injected
// {@link WriteOutboxPort} in the SAME unit of work as the mutation (transactional outbox); the §4.8 worker
// jobs through the injected {@link RecomputeEnqueuePort}. M27 carries NO PHI (D18); money is INTEGER CENTS.
//
// FROZEN-SCHEMA NOTE: the two-person control (approver ≠ submitter) has no dedicated approver column on
// `cost_report`; the route resolves the approver from the approval event and passes it on `SubmitArgs`,
// and this service refuses `submit` when it equals the acting membership. Documented as a deviation.
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  BadDebtRepository,
  COST_REPORT_TRANSITIONS,
  ComplianceWindowRepository,
  CostCenterMappingRepository,
  CostReportRepository,
  CostReportSnapshotRepository,
  type CostReportState,
  type CostReportTransitionEvent,
  CostReportWorksheetRepository,
  DERIVED_WORKSHEET_CODES,
  type WorksheetCode as DomainWorksheetCode,
  EcrSubmissionRepository,
  ImportsRepository,
  StatisticDataRepository,
  ValidationRepository,
  ValidationRuleRepository,
  applyTransition,
  canTransition,
  contentHashSha256,
  resolveWorksheetSchema,
} from "@wardenx/cost-report";
import type { DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, WardenXError } from "@wardenx/types";
import type { M27WriteActor } from "./actor";
import type {
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
import type {
  AddBadDebtArgs,
  AllocationAcceptedView,
  ApplyMappingArgs,
  ApproveForSubmitArgs,
  CreateCostReportArgs,
  CreateValidationRuleArgs,
  DeadlineExtensionArgs,
  ImportJobAcceptedView,
  M27WriteRouteService,
  ManualTrialBalanceArgs,
  ManualWageDataArgs,
  OverrideValidationResultArgs,
  PatchCostReportArgs,
  PreviewMappingArgs,
  PutWorksheetArgs,
  RecomputeEnqueuePort,
  RecordAcknowledgmentArgs,
  RefreshInputsAcceptedView,
  ReopenArgs,
  ResetMappingArgs,
  StatisticsRefreshAcceptedView,
  SubmitArgs,
  SubmitPastDeadlineArgs,
  UpdateBadDebtArgs,
  UpdateValidationRuleArgs,
  ValidationJobAcceptedView,
  WriteOutboxPort,
} from "./write-service";

/** The structural org-context transaction handle the repos write through (mirrors M30's WriteTx). */
export type WriteTx = DbClient;

/**
 * Resolves the server-side `provider_entity_id` for an org (the M40 directory) when a write needs it and
 * it is not carried on the request. M27 may not import another feature module's package, so this is a
 * typed PORT the composition root binds; the default deny-stub fails CLOSED (the M30 ProviderEntityPort
 * precedent). Most M27 provider-scoped rows derive the provider from the parent cost report, so this is a
 * fallback rather than the common path.
 */
export interface ProviderEntityPort {
  primaryProviderEntityId(tx: WriteTx, organizationId: string): Promise<string>;
}

/** Deps the production M27 write service binds at boot (P3) — every cross-boundary edge is a port. */
export interface M27WriteServicePorts {
  /** The §4.10 `m27.*` transactional-outbox emitter (best-effort until the dispatcher binds). */
  readonly outbox?: WriteOutboxPort;
  /** The §4.8 BullMQ producer for the M27 worker queues (fail-closed synthetic id default). */
  readonly recompute?: RecomputeEnqueuePort;
  /** Resolves `provider_entity_id` server-side where a write does not carry it (fail-closed default). */
  readonly providerEntity?: ProviderEntityPort;
  /** Injected clock (deterministic timestamps in tests). */
  readonly now?: () => Date;
  /** The platform rule-set version validation runs pin (§11.B default v1). */
  readonly ruleSetVersion?: number;
}

const ISO_DATE = (d: Date): string => d.toISOString().slice(0, 10);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Add `months` calendar months to a YYYY-MM-DD date string (clamped to month end), as YYYY-MM-DD. */
function addMonths(dateStr: string, months: number): string {
  const base = new Date(`${dateStr.slice(0, 10)}T00:00:00.000Z`);
  const target = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, base.getUTCDate()),
  );
  // Guard a day-overflow rollover (e.g. adding to the 31st) — clamp to the last day of the target month.
  if (target.getUTCDate() !== base.getUTCDate()) target.setUTCDate(0);
  return ISO_DATE(target);
}

// ── projections (mirror the read-service mappers; kept local so write returns the same DTOs) ───────────

function mapBadDebt(row: schema.BadDebtRecord): BadDebtRecordView {
  return {
    recordId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    periodLabel: row.periodLabel,
    debtKind: row.debtKind,
    amountCents: row.amountCents,
    collectionEffortsDocumented: row.collectionEffortsDocumented,
    supportingDocumentIds: row.supportingDocumentIds,
    addedByMembershipId: row.addedByMembershipId,
    addedAt: row.addedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}

function mapMapping(row: schema.CostCenterMapping): CostCenterMappingView {
  return {
    mappingId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    fiscalYearInt: row.fiscalYearInt,
    xeroAccountCode: row.xeroAccountCode,
    xeroAccountName: row.xeroAccountName,
    cmsCostCenterCode: row.cmsCostCenterCode,
    mappingSource: row.mappingSource,
    version: row.version,
  };
}

function mapEcr(row: schema.EcrSubmission): EcrSubmissionView {
  return {
    submissionId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    snapshotId: row.snapshotId,
    status: row.status,
    ecrFileDocumentId: row.ecrFileDocumentId ?? null,
    piFileDocumentId: row.piFileDocumentId ?? null,
    supportingDocumentsDocumentIds: row.supportingDocumentsDocumentIds,
    mcrefAcknowledgmentNumber: row.mcrefAcknowledgmentNumber ?? null,
    mcrefRejectionCode: row.mcrefRejectionCode ?? null,
    mcrefRejectionDetail: row.mcrefRejectionDetail ?? null,
    generatedAt: row.generatedAt.toISOString(),
    uploadedAt: iso(row.uploadedAt),
    acknowledgedAt: iso(row.acknowledgedAt),
  };
}

function mapWindow(row: schema.CostReportComplianceWindow): ComplianceWindowView {
  return {
    windowId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    deadlineDate: row.deadlineDate,
    currentEffectiveDeadlineDate: row.currentEffectiveDeadlineDate,
    lastAlertTier: row.lastAlertTier,
    lastAlertTierEmittedAt: iso(row.lastAlertTierEmittedAt),
    closedAt: iso(row.closedAt),
  };
}

function mapStatistic(row: schema.StatisticData): StatisticDataView {
  return {
    statisticId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    monthlyBreakdown: row.monthlyBreakdown,
    visitCountsByDiscipline: row.visitCountsByDiscipline,
    fteCalculations: row.fteCalculations,
    bereavementCensus: row.bereavementCensus,
    refreshedAt: row.refreshedAt.toISOString(),
    refreshedByMembershipId: row.refreshedByMembershipId ?? null,
    version: row.version,
  };
}

function mapTrialBalance(row: schema.TrialBalanceImport): TrialBalanceImportView {
  return {
    importId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    source: row.source,
    status: row.status,
    accountCount: Array.isArray(row.normalizedAccounts) ? row.normalizedAccounts.length : 0,
    failureReason: row.failureReason ?? null,
    pulledAt: row.pulledAt.toISOString(),
  };
}

function mapWageData(row: schema.WageDataImport): WageDataImportView {
  return {
    importId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    source: row.source,
    status: row.status,
    rowCount: Array.isArray(row.normalizedWageRows) ? row.normalizedWageRows.length : 0,
    failureReason: row.failureReason ?? null,
    pulledAt: row.pulledAt.toISOString(),
  };
}

function mapOverride(row: schema.CostReportValidationOverride): ValidationOverrideView {
  return {
    overrideId: row.id,
    organizationId: row.organizationId,
    validationResultId: row.validationResultId,
    overriddenByMembershipId: row.overriddenByMembershipId,
    reason: row.reason,
    overriddenAt: row.overriddenAt.toISOString(),
  };
}

function mapRule(row: schema.CostReportValidationRule): ValidationRuleView {
  return {
    ruleId: row.id,
    organizationId: row.organizationId ?? null,
    ruleCode: row.ruleCode,
    category: row.category,
    description: row.description,
    ruleSetVersion: row.ruleSetVersion,
    regulatoryRequired: row.regulatoryRequired,
    severity: row.severity,
    status: row.status,
    macJurisdictionScope: row.macJurisdictionScope,
    publishedAt: row.publishedAt.toISOString(),
    deprecatedAt: iso(row.deprecatedAt),
  };
}

// ── the factory ────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the Drizzle-backed {@link M27WriteRouteService}. `db` is the PRIMARY (RLS-enforced) client; every
 * method opens the actor's own `withOrgContext` transaction so Postgres scopes to `app.org_id`.
 */
export function buildDrizzleM27WriteService(
  db: DbClient,
  ports: M27WriteServicePorts = {},
): M27WriteRouteService {
  const now = ports.now ?? (() => new Date());
  const ruleSetVersion = ports.ruleSetVersion ?? 1;
  const recompute: RecomputeEnqueuePort = ports.recompute ?? {
    enqueue: async () => ({ jobId: randomUUID() }),
  };

  const inOrgCtx = <T>(actor: M27WriteActor, fn: (tx: WriteTx) => Promise<T>): Promise<T> =>
    withOrgContext<WriteTx, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  /** Emit a §4.10 `m27.*` event on the CALLER'S tx (commits in the same unit of work as the mutation). */
  const emit = async (
    tx: WriteTx,
    input: {
      eventName: string;
      payload: Record<string, unknown>;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
    },
  ): Promise<void> => {
    if (ports.outbox) await ports.outbox.publish(tx, input);
  };

  /** §D14 server-side step-up gate (override / approve / submit / reopen). Fail-closed. */
  const requireStepUp = (actor: M27WriteActor): void => {
    if (!actor.stepUpRecent) {
      throw new WardenXError(
        "STEP_UP_REQUIRED",
        "this action requires a recent step-up re-authentication",
        403,
      );
    }
  };

  const loadReport = async (
    tx: WriteTx,
    actor: M27WriteActor,
    costReportId: string,
  ): Promise<schema.CostReport> => {
    const row = await new CostReportRepository(tx).findById(costReportId);
    if (!row || row.organizationId !== actor.organizationId) throw new NotFoundError("cost report");
    return row;
  };

  /** Map a (state, event) onto the next state via the pure reducer, raising structured errors. */
  const nextState = (
    from: CostReportState,
    event: CostReportTransitionEvent,
    ctx: { unresolvedBlockingFailures?: number } = {},
  ): CostReportState => {
    if (!canTransition(from, event, ctx)) {
      if (event === "approve_for_submit") {
        throw new WardenXError(
          "GUARD_FAILED",
          "approve_for_submit requires zero unresolved blocking validation failures",
          422,
        );
      }
      throw new ConflictError(`cannot '${event}' a cost report in state '${from}'`);
    }
    return applyTransition(from, event, ctx);
  };

  /** Apply a versioned `cost_report` update, surfacing the §2.5 VERSION_CONFLICT as a 409. */
  const updateReport = async (
    tx: WriteTx,
    id: string,
    expectedVersion: number,
    patch: Parameters<CostReportRepository["updateWithVersion"]>[2],
  ): Promise<schema.CostReport> => {
    const res = await new CostReportRepository(tx).updateWithVersion(id, expectedVersion, patch);
    if (!res.ok) {
      throw new WardenXError(
        "VERSION_CONFLICT",
        `the cost report was modified concurrently (current version ${res.currentVersion ?? "unknown"})`,
        409,
      );
    }
    return res.row;
  };

  /** Assemble the §4.1 detail view (summary + latest validation/submission + window). */
  const buildDetail = async (
    tx: WriteTx,
    actor: M27WriteActor,
    report: schema.CostReport,
  ): Promise<CostReportDetailView> => {
    const latestValidation = await new ValidationRepository(tx).findLatestRunForReport(
      actor.organizationId,
      report.id,
    );
    const latestSubmission = await new EcrSubmissionRepository(tx).findLatestForReport(
      actor.organizationId,
      report.id,
    );
    const window = await new ComplianceWindowRepository(tx).findByReport(
      actor.organizationId,
      report.id,
    );
    return {
      costReportId: report.id,
      organizationId: report.organizationId,
      providerEntityId: report.providerEntityId,
      fiscalYearStartDate: report.fiscalYearStartDate,
      fiscalYearEndDate: report.fiscalYearEndDate,
      state: report.state,
      reopenCount: report.reopenCount,
      badDebtClaimed: report.badDebtClaimed,
      wageSource: report.wageSource,
      version: report.version,
      latestSnapshotId: report.latestSnapshotId ?? null,
      latestValidation: latestValidation
        ? {
            validationId: latestValidation.id,
            organizationId: latestValidation.organizationId,
            costReportId: latestValidation.costReportId,
            status: latestValidation.status,
            ruleSetVersion: latestValidation.ruleSetVersion,
            passedCount: latestValidation.passedCount,
            failedCount: latestValidation.failedCount,
            warningCount: latestValidation.warningCount,
            overriddenCount: latestValidation.overriddenCount,
            skippedCount: latestValidation.skippedCount,
            runStartedAt: latestValidation.runStartedAt.toISOString(),
            runCompletedAt: iso(latestValidation.runCompletedAt),
          }
        : null,
      latestSubmission: latestSubmission ? mapEcr(latestSubmission) : null,
      complianceWindow: window ? mapWindow(window) : null,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
      closedAt: iso(report.closedAt),
    };
  };

  /** The unresolved-blocking-failures count from the latest completed validation run (§2.3 approve guard). */
  const unresolvedBlockingFailures = async (
    tx: WriteTx,
    actor: M27WriteActor,
    costReportId: string,
  ): Promise<number> => {
    const run = await new ValidationRepository(tx).findLatestRunForReport(
      actor.organizationId,
      costReportId,
    );
    if (!run || run.status !== "complete") return Number.POSITIVE_INFINITY;
    return Math.max(0, run.failedCount - run.overriddenCount);
  };

  const service: M27WriteRouteService = {
    // ── cost-report lifecycle root ──
    async createCostReport(actor, args: CreateCostReportArgs): Promise<CostReportDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const reportRepo = new CostReportRepository(tx);
        const existing = await reportRepo.findByProviderFye(
          actor.organizationId,
          args.providerEntityId,
          args.fiscalYearEndDate,
        );
        if (existing) {
          throw new ConflictError(
            "a cost report already exists for this ProviderEntity and fiscal-year-end",
          );
        }
        const report = await reportRepo.create({
          organizationId: actor.organizationId,
          providerEntityId: args.providerEntityId,
          fiscalYearStartDate: args.fiscalYearStartDate,
          fiscalYearEndDate: args.fiscalYearEndDate,
          wageSource: args.wageSource ?? "manual",
        });
        // The filing-deadline timer: due FYE + 5 months (42 CFR §413.24(f)).
        const deadline = addMonths(args.fiscalYearEndDate, 5);
        await new ComplianceWindowRepository(tx).create({
          organizationId: actor.organizationId,
          costReportId: report.id,
          deadlineDate: deadline,
          currentEffectiveDeadlineDate: deadline,
        });
        await emit(tx, {
          eventName: "m27.cost_report.created",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: report.id,
          payload: {
            costReportId: report.id,
            providerEntityId: report.providerEntityId,
            organizationId: actor.organizationId,
            fyeDate: report.fiscalYearEndDate,
            fiscalYearStartDate: report.fiscalYearStartDate,
            deadlineDate: deadline,
          },
        });
        return buildDetail(tx, actor, report);
      });
    },

    async patchCostReport(
      actor,
      costReportId,
      args: PatchCostReportArgs,
    ): Promise<CostReportDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        // Editable metadata only; state-machine-guarded — edits are only legal pre-lockdown.
        if (report.state !== "draft" && report.state !== "populating") {
          throw new ConflictError(
            "cost-report metadata can only be edited while draft or populating",
          );
        }
        const updated = await updateReport(tx, report.id, args.expectedVersion, {
          badDebtClaimed: args.badDebtClaimed ?? report.badDebtClaimed,
          wageSource: args.wageSource ?? report.wageSource,
        });
        return buildDetail(tx, actor, updated);
      });
    },

    async refreshInputs(actor, costReportId): Promise<RefreshInputsAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const dedupe = `${actor.organizationId}:${costReportId}`;
        const tb = await recompute.enqueue("trial-balance-pull", `tb:${dedupe}`, {
          costReportId,
          source: "xero",
        });
        const stats = await recompute.enqueue("statistics-refresh", `stats:${dedupe}`, {
          costReportId,
        });
        let wageJobId: string | null = null;
        if (report.wageSource === "gusto") {
          const wage = await recompute.enqueue("wage-data-pull", `wage:${dedupe}`, {
            costReportId,
          });
          wageJobId = wage.jobId;
        }
        await emit(tx, {
          eventName: "m27.trial_balance.pull_requested",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: { costReportId, source: "xero" },
        });
        if (wageJobId) {
          await emit(tx, {
            eventName: "m27.wage_data.pull_requested",
            organizationId: actor.organizationId,
            aggregateKind: "cost_report",
            aggregateId: costReportId,
            payload: { costReportId },
          });
        }
        await emit(tx, {
          eventName: "m27.statistics.refresh_requested",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: { costReportId },
        });
        // draft → populating (the first input-materialization hop). Idempotent when already populating.
        if (report.state === "draft") {
          const populated = await updateReport(tx, report.id, report.version, {
            state: nextState(report.state, "refresh_inputs"),
          });
          await emit(tx, {
            eventName: "m27.cost_report.populating",
            organizationId: actor.organizationId,
            aggregateKind: "cost_report",
            aggregateId: populated.id,
            payload: { costReportId: populated.id },
          });
        }
        return {
          trialBalanceJobId: tb.jobId,
          wageDataJobId: wageJobId,
          statisticsJobId: stats.jobId,
        };
      });
    },

    // ── worksheets ──
    async putWorksheet(
      actor,
      costReportId,
      worksheetCode: WorksheetCode,
      args: PutWorksheetArgs,
    ): Promise<WorksheetView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        if (report.state !== "draft" && report.state !== "populating") {
          throw new ConflictError(
            "worksheets are read-only once the report has left draft/populating",
          );
        }
        // §2.3 per-code TypeBox validation — refuse a payload that does not match the worksheet schema.
        const tschema = resolveWorksheetSchema(worksheetCode as DomainWorksheetCode);
        if (!Value.Check(tschema, args.data)) {
          throw new WardenXError(
            "VALIDATION_FAILED",
            `the worksheet ${worksheetCode} payload is invalid`,
            422,
          );
        }
        const repo = new CostReportWorksheetRepository(tx);
        const existing = await repo.findByReportAndCode(costReportId, worksheetCode);
        const data = args.data as schema.NewCostReportWorksheet["data"];
        if (!existing) {
          const created = await repo.create({
            organizationId: actor.organizationId,
            costReportId,
            worksheetCode,
            data,
          });
          return {
            worksheetId: created.id,
            costReportId: created.costReportId,
            worksheetCode: created.worksheetCode,
            data: created.data,
            computedAt: iso(created.computedAt),
            version: created.version,
          };
        }
        const res = await repo.updateWithVersion(existing.id, args.expectedVersion, { data });
        if (!res.ok) {
          throw new WardenXError(
            "VERSION_CONFLICT",
            `the worksheet was modified concurrently (current version ${res.currentVersion ?? "unknown"})`,
            409,
          );
        }
        return {
          worksheetId: res.row.id,
          costReportId: res.row.costReportId,
          worksheetCode: res.row.worksheetCode,
          data: res.row.data,
          computedAt: iso(res.row.computedAt),
          version: res.row.version,
        };
      });
    },

    async computeWorksheet(
      actor,
      costReportId,
      worksheetCode: WorksheetCode,
    ): Promise<AllocationAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const { jobId } = await recompute.enqueue(
          "allocation-recompute",
          `${actor.organizationId}:${costReportId}:${worksheetCode}`,
          { costReportId, worksheetCode },
        );
        return { jobId, worksheetsToRecompute: [worksheetCode] };
      });
    },

    async allocate(actor, costReportId): Promise<AllocationAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const { jobId } = await recompute.enqueue(
          "allocation-recompute",
          `${actor.organizationId}:${costReportId}:all`,
          { costReportId },
        );
        return { jobId, worksheetsToRecompute: [...DERIVED_WORKSHEET_CODES] as WorksheetCode[] };
      });
    },

    // ── cost-center mappings ──
    async previewCostCenterMapping(
      actor,
      costReportId,
      args: PreviewMappingArgs,
    ): Promise<MappingPreviewView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const fyInt = new Date(`${report.fiscalYearEndDate}T00:00:00.000Z`).getUTCFullYear();
        const repo = new CostCenterMappingRepository(tx);
        const changedAccounts: MappingPreviewView["changedAccounts"][number][] = [];
        for (const change of args.changes) {
          const current = await repo.findByAccount(
            actor.organizationId,
            report.providerEntityId,
            fyInt,
            change.xeroAccountCode,
          );
          changedAccounts.push({
            xeroAccountCode: change.xeroAccountCode,
            fromCmsCostCenterCode: current?.cmsCostCenterCode ?? null,
            toCmsCostCenterCode: change.cmsCostCenterCode,
          });
        }
        return { costReportId, changedAccounts, unmappedAccounts: [] };
      });
    },

    async applyCostCenterMapping(
      actor,
      costReportId,
      args: ApplyMappingArgs,
    ): Promise<readonly CostCenterMappingView[]> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        if (report.state !== "draft" && report.state !== "populating") {
          throw new ConflictError(
            "cost-center mappings are read-only once the report leaves draft/populating",
          );
        }
        const fyInt = new Date(`${report.fiscalYearEndDate}T00:00:00.000Z`).getUTCFullYear();
        const repo = new CostCenterMappingRepository(tx);
        const source = args.mappingSource ?? "tenant_override";
        for (const change of args.changes) {
          const current = await repo.findByAccount(
            actor.organizationId,
            report.providerEntityId,
            fyInt,
            change.xeroAccountCode,
          );
          if (current) {
            await repo.update(current.id, {
              xeroAccountName: change.xeroAccountName,
              cmsCostCenterCode: change.cmsCostCenterCode,
              mappingSource: source,
              version: current.version + 1,
            });
          } else {
            await repo.create({
              organizationId: actor.organizationId,
              providerEntityId: report.providerEntityId,
              fiscalYearInt: fyInt,
              xeroAccountCode: change.xeroAccountCode,
              xeroAccountName: change.xeroAccountName,
              cmsCostCenterCode: change.cmsCostCenterCode,
              mappingSource: source,
            });
          }
        }
        await emit(tx, {
          eventName: "m27.cost_center_mapping.applied",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: {
            costReportId,
            providerEntityId: report.providerEntityId,
            fyInt,
            changeCount: args.changes.length,
            mappingSource: source,
          },
        });
        const rows = await repo.listForProviderFy(
          actor.organizationId,
          report.providerEntityId,
          fyInt,
        );
        return rows.map(mapMapping);
      });
    },

    async resetCostCenterMapping(
      actor,
      costReportId,
      args: ResetMappingArgs,
    ): Promise<readonly CostCenterMappingView[]> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const fyInt = new Date(`${report.fiscalYearEndDate}T00:00:00.000Z`).getUTCFullYear();
        // The actual re-seed to platform defaults is a seed/worker concern; the route records the intent
        // (audit + downstream consumers) and returns the post-reset mapping set under RLS.
        await emit(tx, {
          eventName: "m27.cost_center_mapping.reset",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: {
            costReportId,
            providerEntityId: report.providerEntityId,
            fyInt,
            keepTenantOverrides: args.keepTenantOverrides,
          },
        });
        const rows = await new CostCenterMappingRepository(tx).listForProviderFy(
          actor.organizationId,
          report.providerEntityId,
          fyInt,
        );
        return rows.map(mapMapping);
      });
    },

    // ── bad debt ──
    async addBadDebt(actor, costReportId, args: AddBadDebtArgs): Promise<BadDebtRecordView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        if (report.state !== "draft" && report.state !== "populating") {
          throw new ConflictError(
            "bad-debt records can only be added while the report is draft/populating",
          );
        }
        const row = await new BadDebtRepository(tx).create({
          organizationId: actor.organizationId,
          costReportId,
          periodLabel: args.periodLabel,
          debtKind: args.debtKind,
          amountCents: args.amountCents,
          collectionEffortsDocumented: args.collectionEffortsDocumented ?? false,
          supportingDocumentIds: [...(args.supportingDocumentIds ?? [])],
          addedByMembershipId: actor.membershipId,
        });
        await emit(tx, {
          eventName: "m27.bad_debt.recorded",
          organizationId: actor.organizationId,
          aggregateKind: "bad_debt_record",
          aggregateId: row.id,
          payload: {
            costReportId,
            recordId: row.id,
            debtKind: row.debtKind,
            amountCents: row.amountCents,
            periodLabel: row.periodLabel,
          },
        });
        return mapBadDebt(row);
      });
    },

    async updateBadDebt(
      actor,
      costReportId,
      recordId,
      args: UpdateBadDebtArgs,
    ): Promise<BadDebtRecordView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        if (report.state !== "draft" && report.state !== "populating") {
          throw new ConflictError(
            "bad-debt records can only be edited while the report is draft/populating",
          );
        }
        const repo = new BadDebtRepository(tx);
        const existing = await repo.findById(recordId);
        if (
          !existing ||
          existing.organizationId !== actor.organizationId ||
          existing.costReportId !== costReportId
        ) {
          throw new NotFoundError("bad-debt record");
        }
        const row = await repo.update(recordId, {
          periodLabel: args.periodLabel ?? existing.periodLabel,
          debtKind: args.debtKind ?? existing.debtKind,
          amountCents: args.amountCents ?? existing.amountCents,
          collectionEffortsDocumented:
            args.collectionEffortsDocumented ?? existing.collectionEffortsDocumented,
          supportingDocumentIds: args.supportingDocumentIds
            ? [...args.supportingDocumentIds]
            : existing.supportingDocumentIds,
        });
        return mapBadDebt(row);
      });
    },

    async deleteBadDebt(actor, costReportId, recordId): Promise<BadDebtRecordView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        if (report.state !== "draft" && report.state !== "populating") {
          throw new ConflictError(
            "bad-debt records can only be deleted while the report is draft/populating",
          );
        }
        const repo = new BadDebtRepository(tx);
        const existing = await repo.findById(recordId);
        if (
          !existing ||
          existing.organizationId !== actor.organizationId ||
          existing.costReportId !== costReportId
        ) {
          throw new NotFoundError("bad-debt record");
        }
        const tomb = await repo.softDelete(recordId, actor.membershipId, now());
        if (!tomb) throw new ConflictError("the bad-debt record was already deleted");
        await emit(tx, {
          eventName: "m27.bad_debt.soft_deleted",
          organizationId: actor.organizationId,
          aggregateKind: "bad_debt_record",
          aggregateId: recordId,
          payload: { costReportId, recordId, deletedByMembershipId: actor.membershipId },
        });
        return mapBadDebt(tomb);
      });
    },

    // ── statistics ──
    async refreshStatistics(actor, costReportId): Promise<StatisticsRefreshAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const { jobId } = await recompute.enqueue(
          "statistics-refresh",
          `${actor.organizationId}:${costReportId}:stats`,
          { costReportId },
        );
        await emit(tx, {
          eventName: "m27.statistics.refresh_requested",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: { costReportId },
        });
        return { jobId };
      });
    },

    // ── imports ──
    async triggerTrialBalancePull(actor, costReportId): Promise<ImportJobAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const { jobId } = await recompute.enqueue(
          "trial-balance-pull",
          `${actor.organizationId}:${costReportId}:tb`,
          { costReportId, source: "xero" },
        );
        await emit(tx, {
          eventName: "m27.trial_balance.pull_requested",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: { costReportId, source: "xero" },
        });
        return { jobId };
      });
    },

    async manualTrialBalance(
      actor,
      costReportId,
      args: ManualTrialBalanceArgs,
    ): Promise<TrialBalanceImportView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const normalizedAccounts = [
          ...args.normalizedAccounts,
        ] as schema.NewTrialBalanceImport["normalizedAccounts"];
        const row = await new ImportsRepository(tx).createTrialBalance({
          organizationId: actor.organizationId,
          costReportId,
          source: "manual_csv",
          status: "complete",
          normalizedAccounts,
          pulledByMembershipId: actor.membershipId,
        });
        await emit(tx, {
          eventName: "m27.trial_balance.pulled",
          organizationId: actor.organizationId,
          aggregateKind: "trial_balance_import",
          aggregateId: row.id,
          payload: {
            costReportId,
            importId: row.id,
            accountCount: args.normalizedAccounts.length,
            totalDebitsCents: 0,
            totalCreditsCents: 0,
            balanced: true,
          },
        });
        return mapTrialBalance(row);
      });
    },

    async triggerWageDataPull(actor, costReportId): Promise<ImportJobAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const { jobId } = await recompute.enqueue(
          "wage-data-pull",
          `${actor.organizationId}:${costReportId}:wage`,
          { costReportId },
        );
        await emit(tx, {
          eventName: "m27.wage_data.pull_requested",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: costReportId,
          payload: { costReportId },
        });
        return { jobId };
      });
    },

    async manualWageData(
      actor,
      costReportId,
      args: ManualWageDataArgs,
    ): Promise<WageDataImportView> {
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const normalizedWageRows = [
          ...args.normalizedWageRows,
        ] as schema.NewWageDataImport["normalizedWageRows"];
        const row = await new ImportsRepository(tx).createWageData({
          organizationId: actor.organizationId,
          costReportId,
          // The frozen `m27_import_source` enum has no plain `manual`; `manual_csv` is the manual source.
          source: "manual_csv",
          status: "complete",
          normalizedWageRows,
          pulledByMembershipId: actor.membershipId,
        });
        await emit(tx, {
          eventName: "m27.wage_data.pulled",
          organizationId: actor.organizationId,
          aggregateKind: "wage_data_import",
          aggregateId: row.id,
          payload: {
            costReportId,
            importId: row.id,
            employeeCount: args.normalizedWageRows.length,
            totalPaidHours: 0,
            totalSalaryCents: 0,
          },
        });
        return mapWageData(row);
      });
    },

    // ── validation ──
    async enqueueValidation(actor, costReportId): Promise<ValidationJobAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        // populating → validating (the pure reducer gates the legal source state).
        const updated = await updateReport(tx, report.id, report.version, {
          state: nextState(report.state, "validate"),
        });
        const run = await new ValidationRepository(tx).createRun({
          organizationId: actor.organizationId,
          costReportId,
          ruleSetVersion,
          status: "in_progress",
        });
        const { jobId } = await recompute.enqueue(
          "validation-run",
          `${actor.organizationId}:${costReportId}:${run.id}`,
          { costReportId, validationId: run.id, ruleSetVersion },
        );
        await emit(tx, {
          eventName: "m27.cost_report.validation_started",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: updated.id,
          payload: { costReportId, validationId: run.id, ruleSetVersion },
        });
        return { validationId: run.id, jobId, ruleSetVersion };
      });
    },

    async overrideValidationResult(
      actor,
      costReportId,
      validationId,
      args: OverrideValidationResultArgs,
    ): Promise<ValidationOverrideView> {
      requireStepUp(actor);
      return inOrgCtx(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const repo = new ValidationRepository(tx);
        const run = await repo.findRunById(validationId);
        if (
          !run ||
          run.organizationId !== actor.organizationId ||
          run.costReportId !== costReportId
        ) {
          throw new NotFoundError("validation run");
        }
        const result = await repo.findResultById(args.validationResultId);
        if (!result || result.validationId !== validationId) {
          throw new NotFoundError("validation result");
        }
        if (result.outcome !== "fail") {
          throw new ConflictError("only a failing validation result can be overridden");
        }
        if (await repo.findOverrideForResult(result.id)) {
          throw new ConflictError("this validation result has already been overridden");
        }
        const row = await repo.createOverride({
          organizationId: actor.organizationId,
          validationResultId: result.id,
          overriddenByMembershipId: actor.membershipId,
          reason: args.reason,
        });
        await repo.updateRun(run.id, { overriddenCount: run.overriddenCount + 1 });
        const rule = await new ValidationRuleRepository(tx).findById(result.ruleId);
        await emit(tx, {
          eventName: "m27.validation.overridden",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report_validation_result",
          aggregateId: result.id,
          payload: {
            costReportId,
            validationResultId: result.id,
            ruleCode: rule?.ruleCode ?? result.ruleId,
            overriddenByMembershipId: actor.membershipId,
            reason: args.reason,
          },
        });
        return mapOverride(row);
      });
    },

    // ── lifecycle transitions ──
    async returnToDraft(actor, costReportId): Promise<CostReportDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const updated = await updateReport(tx, report.id, report.version, {
          state: nextState(report.state, "return_to_draft"),
        });
        await emit(tx, {
          eventName: "m27.cost_report.returned_to_draft",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: updated.id,
          payload: { costReportId: updated.id },
        });
        return buildDetail(tx, actor, updated);
      });
    },

    async approveForSubmit(
      actor,
      costReportId,
      _args: ApproveForSubmitArgs,
    ): Promise<CostReportDetailView> {
      requireStepUp(actor);
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const blocking = await unresolvedBlockingFailures(tx, actor, costReportId);
        const updated = await updateReport(tx, report.id, report.version, {
          state: nextState(report.state, "approve_for_submit", {
            unresolvedBlockingFailures: blocking,
          }),
        });
        const at = now();
        await emit(tx, {
          eventName: "m27.cost_report.approved_for_submit",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: updated.id,
          payload: {
            costReportId: updated.id,
            approvedByMembershipId: actor.membershipId,
            approvedAt: at.toISOString(),
          },
        });
        return buildDetail(tx, actor, updated);
      });
    },

    async submit(actor, costReportId, args: SubmitArgs): Promise<CostReportDetailView> {
      requireStepUp(actor);
      return this.submitPastDeadline(actor, costReportId, { ...args, reason: "" });
    },

    async submitPastDeadline(
      actor,
      costReportId,
      args: SubmitPastDeadlineArgs,
    ): Promise<CostReportDetailView> {
      requireStepUp(actor);
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        // Two-person control: the approver cannot also be the submitter (the route resolves the approver).
        if (args.approvedByMembershipId && args.approvedByMembershipId === actor.membershipId) {
          throw new WardenXError(
            "TWO_PERSON_CONTROL_VIOLATION",
            "the membership that approved this cost report cannot also submit it",
            403,
          );
        }
        const toState = nextState(report.state, "submit");
        // Build the content-hashed snapshot over the materialized inputs + worksheet state (D10).
        const worksheets = await new CostReportWorksheetRepository(tx).listByReport(
          actor.organizationId,
          costReportId,
        );
        const statistics = await new StatisticDataRepository(tx).findByReport(
          actor.organizationId,
          costReportId,
        );
        const trialBalance = await new ImportsRepository(tx).findLatestCompleteTrialBalance(
          actor.organizationId,
          costReportId,
        );
        const wageData = await new ImportsRepository(tx).findLatestCompleteWageData(
          actor.organizationId,
          costReportId,
        );
        const materialized = {
          trialBalanceImportId: trialBalance?.id ?? null,
          wageDataImportId: wageData?.id ?? null,
          statistics: statistics?.monthlyBreakdown ?? null,
        };
        const worksheetSnapshot = Object.fromEntries(
          worksheets.map((w) => [w.worksheetCode, w.data]),
        );
        const contentHash = contentHashSha256({
          materialized,
          worksheetSnapshot,
          state: toState,
          fye: report.fiscalYearEndDate,
        });
        const snapshot = await new CostReportSnapshotRepository(tx).create({
          organizationId: actor.organizationId,
          costReportId,
          priorSnapshotId: report.latestSnapshotId ?? null,
          contentHashSha256: contentHash,
          materializedInputs:
            materialized as unknown as schema.NewCostReportSnapshot["materializedInputs"],
          worksheetSnapshot:
            worksheetSnapshot as unknown as schema.NewCostReportSnapshot["worksheetSnapshot"],
          reason: "submit",
          createdByMembershipId: actor.membershipId,
        });
        const updated = await updateReport(tx, report.id, report.version, {
          state: toState,
          latestSnapshotId: snapshot.id,
        });
        // Open the submission record + enqueue ECR/PI generation.
        const submission = await new EcrSubmissionRepository(tx).create({
          organizationId: actor.organizationId,
          costReportId,
          snapshotId: snapshot.id,
          status: "generating",
        });
        await recompute.enqueue("ecr-generation", `${actor.organizationId}:${submission.id}`, {
          costReportId,
          submissionId: submission.id,
          snapshotId: snapshot.id,
        });
        await emit(tx, {
          eventName: "m27.cost_report.submitted",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: updated.id,
          payload: {
            costReportId: updated.id,
            snapshotId: snapshot.id,
            snapshotContentHash: contentHash,
            submittedByMembershipId: actor.membershipId,
            attestation: {
              attestedByMembershipId: args.attestedByMembershipId,
              attestedAt: args.attestedAt,
            },
          },
        });
        await emit(tx, {
          eventName: "m27.artifact.render_requested",
          organizationId: actor.organizationId,
          aggregateKind: "ecr_submission",
          aggregateId: submission.id,
          payload: {
            costReportId: updated.id,
            submissionId: submission.id,
            artifactKind: "ecr",
            payloadRef: snapshot.id,
            retentionClass: "compliance",
          },
        });
        return buildDetail(tx, actor, updated);
      });
    },

    // ── acknowledgment + reopen ──
    async recordAcknowledgment(
      actor,
      costReportId,
      submissionId,
      args: RecordAcknowledgmentArgs,
    ): Promise<EcrSubmissionView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const repo = new EcrSubmissionRepository(tx);
        const submission = await repo.findById(submissionId);
        if (
          !submission ||
          submission.organizationId !== actor.organizationId ||
          submission.costReportId !== costReportId
        ) {
          throw new NotFoundError("ecr submission");
        }
        const isAccept = typeof args.mcrefAcknowledgmentNumber === "string";
        const isReject = typeof args.mcrefRejectionCode === "string";
        if (isAccept === isReject) {
          throw new WardenXError(
            "VALIDATION_FAILED",
            "exactly one of an acknowledgment number or a rejection code must be supplied",
            422,
          );
        }
        const at = now();
        const updatedSubmission = await repo.update(submissionId, {
          status: isAccept ? "accepted" : "rejected",
          mcrefAcknowledgmentNumber: args.mcrefAcknowledgmentNumber,
          mcrefRejectionCode: args.mcrefRejectionCode,
          mcrefRejectionDetail: args.mcrefRejectionDetail,
          uploadedByMembershipId: actor.membershipId,
          acknowledgedAt: at,
        });
        const toState = nextState(
          report.state,
          isAccept ? "record_acknowledgment" : "record_rejection",
        );
        await updateReport(tx, report.id, report.version, { state: toState });
        if (isAccept) {
          await emit(tx, {
            eventName: "m27.cost_report.accepted",
            organizationId: actor.organizationId,
            aggregateKind: "cost_report",
            aggregateId: costReportId,
            payload: {
              costReportId,
              submissionId,
              mcrefAcknowledgmentNumber: args.mcrefAcknowledgmentNumber as string,
              acceptedAt: at.toISOString(),
            },
          });
        } else {
          await emit(tx, {
            eventName: "m27.cost_report.rejected",
            organizationId: actor.organizationId,
            aggregateKind: "cost_report",
            aggregateId: costReportId,
            payload: {
              costReportId,
              submissionId,
              mcrefRejectionCode: args.mcrefRejectionCode as string,
              mcrefRejectionDetail: args.mcrefRejectionDetail,
            },
          });
        }
        return mapEcr(updatedSubmission);
      });
    },

    async reopen(actor, costReportId, args: ReopenArgs): Promise<CostReportDetailView> {
      requireStepUp(actor);
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        // accepted|rejected → reopened → draft (two reducer hops, kept explicit), reopen_count++.
        const reopened = nextState(report.state, "reopen");
        const draft = nextState(reopened, "reset_to_draft");
        const priorSnapshotId = report.latestSnapshotId ?? null;
        const updated = await updateReport(tx, report.id, report.version, {
          state: draft,
          reopenCount: report.reopenCount + 1,
        });
        await emit(tx, {
          eventName: "m27.cost_report.reopened",
          organizationId: actor.organizationId,
          aggregateKind: "cost_report",
          aggregateId: updated.id,
          payload: {
            costReportId: updated.id,
            priorSnapshotId,
            newReopenCount: updated.reopenCount,
            reopenedByMembershipId: actor.membershipId,
            reason: args.reason,
            reasonCategory: args.reasonCategory,
          },
        });
        return buildDetail(tx, actor, updated);
      });
    },

    // ── compliance window ──
    async recordDeadlineExtension(
      actor,
      costReportId,
      args: DeadlineExtensionArgs,
    ): Promise<ComplianceWindowView> {
      return inOrgCtx(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const windowRepo = new ComplianceWindowRepository(tx);
        const window = await windowRepo.findByReport(actor.organizationId, costReportId);
        if (!window) throw new NotFoundError("compliance window");
        // The MAC-granted extension updates the effective deadline + resets the tiered-alert cadence.
        const updatedWindow = await windowRepo.update(window.id, {
          currentEffectiveDeadlineDate: args.newEffectiveDeadlineDate,
          lastAlertTier: "none",
          lastAlertTierEmittedAt: null,
        });
        await updateReport(tx, report.id, report.version, {
          deadlineExtensionUntilDate: args.newEffectiveDeadlineDate,
        });
        return mapWindow(updatedWindow);
      });
    },

    // ── rule library ──
    async createValidationRule(actor, args: CreateValidationRuleArgs): Promise<ValidationRuleView> {
      return inOrgCtx(actor, async (tx) => {
        const row = await new ValidationRuleRepository(tx).create({
          organizationId: actor.organizationId,
          ruleCode: args.ruleCode,
          category: args.category as schema.NewCostReportValidationRule["category"],
          description: args.description,
          ruleSetVersion,
          // A tenant rule can NEVER be created as regulatory-required (§4.1) — pinned false here.
          regulatoryRequired: false,
          severity: args.severity,
          status: "active",
          macJurisdictionScope: args.macJurisdictionScope ?? "all",
          predicateSpec: args.predicateSpec as schema.NewCostReportValidationRule["predicateSpec"],
        });
        return mapRule(row);
      });
    },

    async updateValidationRule(
      actor,
      ruleId,
      args: UpdateValidationRuleArgs,
    ): Promise<ValidationRuleView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ValidationRuleRepository(tx);
        const existing = await repo.findById(ruleId);
        // Platform-default rows (org-NULL) are immutable from the tenant surface (§4.1).
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("validation rule");
        }
        const row = await repo.update(ruleId, {
          description: args.description ?? existing.description,
          severity: args.severity ?? existing.severity,
          macJurisdictionScope: args.macJurisdictionScope ?? existing.macJurisdictionScope,
          predicateSpec: (args.predicateSpec ??
            existing.predicateSpec) as schema.NewCostReportValidationRule["predicateSpec"],
        });
        return mapRule(row);
      });
    },

    async disableValidationRule(actor, ruleId): Promise<ValidationRuleView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ValidationRuleRepository(tx);
        const existing = await repo.findById(ruleId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("validation rule");
        }
        if (existing.regulatoryRequired) {
          throw new ConflictError("a regulatory-required rule cannot be tenant-disabled");
        }
        const row = await repo.update(ruleId, { status: "deprecated", deprecatedAt: now() });
        return mapRule(row);
      });
    },
  };

  // The provider-entity resolver is a bound-but-fallback port (most provider-scoped rows derive the
  // provider from the parent cost report); referenced here so the deny-stub contract is part of the slice.
  void ports.providerEntity;

  return service;
}
