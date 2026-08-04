import {
  BadDebtRepository,
  ComplianceWindowRepository,
  CostCenterMappingRepository,
  type CostReportDb,
  CostReportRepository,
  CostReportSnapshotRepository,
  CostReportWorksheetRepository,
  EcrSubmissionRepository,
  ImportsRepository,
  StatisticDataRepository,
  ValidationRepository,
  ValidationRuleRepository,
  emptyWorksheetData,
} from "@wardenx/cost-report";
// apps/backend/src/modules/27-cost-report/routes/read-service-drizzle.ts — the Drizzle-backed
// M27ReadRouteService (§4.1 GET surface: cost-report list/detail, worksheets, mappings, bad-debt,
// statistics, imports, validations, ECR submissions, snapshots, compliance window, the rule library).
//
// Implements the {@link M27ReadRouteService} interface the route plugins compose over, but every read
// opens ONE `withOrgContext(db, {organizationId, userId}, tx => …)` transaction (the M1 @wardenx/tenancy
// helper) so Postgres RLS scopes every statement to `app.org_id` — keeping tenant scoping in one home.
// Inside the tx it reads through the @wardenx/cost-report data-port REPOSITORIES (each takes the `tx`
// handle) and projects rows to the deliberately-narrowed read DTOs. Mirrors the M30
// routes/read-service-drizzle.ts precedent (one `read(actor, fn)` helper, one builder returning the
// service, DTO mappers above it). M27 carries NO PHI (D18); money is INTEGER CENTS (D8).
//
// DTO discipline: the cipher / audit-denylisted columns (`raw_payload_cipher`, and on list views the
// `materialized_inputs` / `worksheet_snapshot`) are NEVER projected here — only `getSnapshot` (the one
// audit-read-logged route) surfaces the materialized payloads.
import type { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import type { M27ReadActor } from "./actor";
import { type CursorPage, paginate } from "./concurrency";
import type {
  BadDebtRecordView,
  ComplianceWindowView,
  CostCenterMappingView,
  CostReportDetailView,
  CostReportListFilter,
  CostReportSummaryView,
  EcrSubmissionView,
  M27ReadRouteService,
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
  WorksheetCode,
  WorksheetView,
} from "./read-service";

/**
 * Composition deps the Drizzle read backend binds at boot. Intentionally minimal — every read scopes
 * itself through `withOrgContext`. The clock defaults so the boot wiring can omit it in dev.
 */
export interface M27ReadServicePorts {
  readonly now?: () => Date;
}

// ── small projection helpers ───────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();
/** Integer count of a jsonb array column. */
const len = (a: readonly unknown[] | null | undefined): number => (Array.isArray(a) ? a.length : 0);

function mapCostReportSummary(row: schema.CostReport): CostReportSummaryView {
  return {
    costReportId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    fiscalYearStartDate: row.fiscalYearStartDate,
    fiscalYearEndDate: row.fiscalYearEndDate,
    state: row.state,
    reopenCount: row.reopenCount,
    badDebtClaimed: row.badDebtClaimed,
    wageSource: row.wageSource,
    version: row.version,
  };
}

function mapValidationRun(row: schema.CostReportValidation): ValidationRunSummaryView {
  return {
    validationId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    status: row.status,
    ruleSetVersion: row.ruleSetVersion,
    passedCount: row.passedCount,
    failedCount: row.failedCount,
    warningCount: row.warningCount,
    overriddenCount: row.overriddenCount,
    skippedCount: row.skippedCount,
    runStartedAt: isoReq(row.runStartedAt),
    runCompletedAt: iso(row.runCompletedAt),
  };
}

function mapOverride(row: schema.CostReportValidationOverride): ValidationOverrideView {
  return {
    overrideId: row.id,
    organizationId: row.organizationId,
    validationResultId: row.validationResultId,
    overriddenByMembershipId: row.overriddenByMembershipId,
    reason: row.reason,
    overriddenAt: isoReq(row.overriddenAt),
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
    generatedAt: isoReq(row.generatedAt),
    uploadedAt: iso(row.uploadedAt),
    acknowledgedAt: iso(row.acknowledgedAt),
  };
}

function mapComplianceWindow(row: schema.CostReportComplianceWindow): ComplianceWindowView {
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
    addedAt: isoReq(row.addedAt),
    deletedAt: iso(row.deletedAt),
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
    refreshedAt: isoReq(row.refreshedAt),
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
    accountCount: len(row.normalizedAccounts),
    failureReason: row.failureReason ?? null,
    pulledAt: isoReq(row.pulledAt),
  };
}

function mapWageData(row: schema.WageDataImport): WageDataImportView {
  return {
    importId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    source: row.source,
    status: row.status,
    rowCount: len(row.normalizedWageRows),
    failureReason: row.failureReason ?? null,
    pulledAt: isoReq(row.pulledAt),
  };
}

function mapSnapshotSummary(row: schema.CostReportSnapshot): SnapshotSummaryView {
  return {
    snapshotId: row.id,
    organizationId: row.organizationId,
    costReportId: row.costReportId,
    priorSnapshotId: row.priorSnapshotId ?? null,
    contentHashSha256: row.contentHashSha256,
    reason: row.reason,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: isoReq(row.createdAt),
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
    publishedAt: isoReq(row.publishedAt),
    deprecatedAt: iso(row.deprecatedAt),
  };
}

// ── the builder ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the Drizzle-backed {@link M27ReadRouteService}. Every method opens one `withOrgContext`
 * transaction (RLS-scoped to the actor's org) and reads through the @wardenx/cost-report repositories on
 * the tx handle. The route plugins gate each method on the §4.6 permission BEFORE the call reaches here —
 * this layer assumes an authorized, org-bound actor and never re-derives the org from anything but
 * `actor.organizationId`.
 */
export function buildDrizzleM27ReadService(
  db: CostReportDb,
  _ports: M27ReadServicePorts = {},
): M27ReadRouteService {
  const read = <T>(actor: M27ReadActor, fn: (tx: CostReportDb) => Promise<T>): Promise<T> =>
    withOrgContext<CostReportDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  /** Resolve a cost report by id under RLS, enforcing the org match (404 otherwise). */
  const loadReport = async (
    tx: CostReportDb,
    actor: M27ReadActor,
    costReportId: string,
  ): Promise<schema.CostReport> => {
    const row = await new CostReportRepository(tx).findById(costReportId);
    if (!row || row.organizationId !== actor.organizationId) throw new NotFoundError("cost report");
    return row;
  };

  return {
    async listCostReports(actor, filter: CostReportListFilter, cursor, limit) {
      return read(actor, async (tx) => {
        const rows = await new CostReportRepository(tx).listByOrg(actor.organizationId, {
          state: filter.state,
          limit: 500,
        });
        const mapped = rows
          .filter((r) => {
            if (filter.providerEntityId && r.providerEntityId !== filter.providerEntityId)
              return false;
            if (
              filter.fiscalYear !== undefined &&
              new Date(`${r.fiscalYearEndDate}T00:00:00.000Z`).getUTCFullYear() !==
                filter.fiscalYear
            ) {
              return false;
            }
            return true;
          })
          .map((r) => ({
            ...mapCostReportSummary(r),
            // Keyset on the fiscal-year-end (DESC) — the deterministic list sort anchor.
            createdAt: r.fiscalYearEndDate,
            id: r.id,
          }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...v }) => v),
        } satisfies CursorPage<CostReportSummaryView>;
      });
    },

    async getCostReport(actor, costReportId) {
      return read(actor, async (tx) => {
        const row = await loadReport(tx, actor, costReportId);
        const latestValidation = await new ValidationRepository(tx).findLatestRunForReport(
          actor.organizationId,
          costReportId,
        );
        const latestSubmission = await new EcrSubmissionRepository(tx).findLatestForReport(
          actor.organizationId,
          costReportId,
        );
        const window = await new ComplianceWindowRepository(tx).findByReport(
          actor.organizationId,
          costReportId,
        );
        return {
          ...mapCostReportSummary(row),
          latestSnapshotId: row.latestSnapshotId ?? null,
          latestValidation: latestValidation ? mapValidationRun(latestValidation) : null,
          latestSubmission: latestSubmission ? mapEcr(latestSubmission) : null,
          complianceWindow: window ? mapComplianceWindow(window) : null,
          createdAt: isoReq(row.createdAt),
          updatedAt: isoReq(row.updatedAt),
          closedAt: iso(row.closedAt),
        } satisfies CostReportDetailView;
      });
    },

    async getWorksheet(actor, costReportId, worksheetCode: WorksheetCode) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const row = await new CostReportWorksheetRepository(tx).findByReportAndCode(
          costReportId,
          worksheetCode,
        );
        if (!row) {
          // Lazy read: no persisted row → return the schema-valid empty default (§2.2), not a write.
          return {
            worksheetId: null,
            costReportId,
            worksheetCode,
            data: emptyWorksheetData(worksheetCode),
            computedAt: null,
            version: 0,
          } satisfies WorksheetView;
        }
        return {
          worksheetId: row.id,
          costReportId: row.costReportId,
          worksheetCode: row.worksheetCode,
          data: row.data,
          computedAt: iso(row.computedAt),
          version: row.version,
        } satisfies WorksheetView;
      });
    },

    async listCostCenterMappings(actor, costReportId) {
      return read(actor, async (tx) => {
        const report = await loadReport(tx, actor, costReportId);
        const fyInt = new Date(`${report.fiscalYearEndDate}T00:00:00.000Z`).getUTCFullYear();
        const rows = await new CostCenterMappingRepository(tx).listForProviderFy(
          actor.organizationId,
          report.providerEntityId,
          fyInt,
        );
        return rows.map(mapMapping);
      });
    },

    async listBadDebt(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const rows = await new BadDebtRepository(tx).listForReport(
          actor.organizationId,
          costReportId,
        );
        return rows.map(mapBadDebt);
      });
    },

    async getStatistics(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const row = await new StatisticDataRepository(tx).findByReport(
          actor.organizationId,
          costReportId,
        );
        return row ? mapStatistic(row) : null;
      });
    },

    async listTrialBalanceImports(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const rows = await new ImportsRepository(tx).listTrialBalanceForReport(
          actor.organizationId,
          costReportId,
        );
        return rows.map(mapTrialBalance);
      });
    },

    async listWageDataImports(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const rows = await new ImportsRepository(tx).listWageDataForReport(
          actor.organizationId,
          costReportId,
        );
        return rows.map(mapWageData);
      });
    },

    async listValidations(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const rows = await new ValidationRepository(tx).listRunsForReport(
          actor.organizationId,
          costReportId,
        );
        return rows.map(mapValidationRun);
      });
    },

    async getValidation(actor, costReportId, validationId) {
      return read(actor, async (tx) => {
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
        const results = await repo.listResults(validationId);
        const mappedResults: ValidationResultView[] = [];
        for (const r of results) {
          const override = await repo.findOverrideForResult(r.id);
          mappedResults.push({
            resultId: r.id,
            validationId: r.validationId,
            ruleId: r.ruleId,
            outcome: r.outcome,
            details: r.details as Readonly<Record<string, unknown>>,
            overridden: override !== null,
            override: override ? mapOverride(override) : null,
            recordedAt: isoReq(r.recordedAt),
          });
        }
        return {
          ...mapValidationRun(run),
          results: mappedResults,
        } satisfies ValidationRunDetailView;
      });
    },

    async listEcrSubmissions(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const rows = await new EcrSubmissionRepository(tx).listForReport(
          actor.organizationId,
          costReportId,
        );
        return rows.map(mapEcr);
      });
    },

    async getEcrSubmission(actor, costReportId, submissionId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const row = await new EcrSubmissionRepository(tx).findById(submissionId);
        if (
          !row ||
          row.organizationId !== actor.organizationId ||
          row.costReportId !== costReportId
        ) {
          throw new NotFoundError("ecr submission");
        }
        return mapEcr(row);
      });
    },

    async listSnapshots(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const rows = await new CostReportSnapshotRepository(tx).listForReport(
          actor.organizationId,
          costReportId,
        );
        return rows.map(mapSnapshotSummary);
      });
    },

    async getSnapshot(actor, costReportId, snapshotId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const row = await new CostReportSnapshotRepository(tx).findById(snapshotId);
        if (
          !row ||
          row.organizationId !== actor.organizationId ||
          row.costReportId !== costReportId
        ) {
          throw new NotFoundError("snapshot");
        }
        return {
          ...mapSnapshotSummary(row),
          materializedInputs: row.materializedInputs,
          worksheetSnapshot: row.worksheetSnapshot,
        } satisfies SnapshotDetailView;
      });
    },

    async getComplianceWindow(actor, costReportId) {
      return read(actor, async (tx) => {
        await loadReport(tx, actor, costReportId);
        const row = await new ComplianceWindowRepository(tx).findByReport(
          actor.organizationId,
          costReportId,
        );
        return row ? mapComplianceWindow(row) : null;
      });
    },

    async listValidationRules(actor) {
      return read(actor, async (tx) => {
        // The effective set = platform defaults (org-NULL) UNION the tenant's own rows, at the current
        // rule-set version (the engine pins per-run; the library view shows the active default version).
        const repo = new ValidationRuleRepository(tx);
        const platform = await repo.listPlatformDefaults(DEFAULT_RULE_SET_VERSION);
        const effective = await repo.listEffective(actor.organizationId, DEFAULT_RULE_SET_VERSION);
        const byId = new Map<string, schema.CostReportValidationRule>();
        for (const r of [...platform, ...effective]) byId.set(r.id, r);
        return [...byId.values()].map(mapRule);
      });
    },
  };
}

/** The platform rule-set version the rule-library read projects (the §11.B default ships at v1). */
const DEFAULT_RULE_SET_VERSION = 1;
