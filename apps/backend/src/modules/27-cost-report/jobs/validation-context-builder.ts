// apps/backend/src/modules/27-cost-report/jobs/validation-context-builder.ts — the LIVE M27
// ValidationContextBuilder (§11.B). Reads M27's materialized state through the @wardenx/cost-report repos
// on the worker's org-scoped `tx` (the worker wraps the run in withOrgContext), resolves the live
// cross-module facts — M26 cap (via resolveCapContext) + M40 MAC jurisdiction (via the injected provider-
// entity resolver) — and hands the raw facts to the PURE `assembleValidationContext`. The M23 seams stay
// unbound (their fields null/false → the dependent rules SKIP). Fail-soft on the MAC lookup (→ `all`).
//
// The cross-module resolvers are injected as PORTS so this unit-tests without the M1 registry; the
// composition root binds the live ones (`m27CapSeamResolver` / `getSeam("MdmEntityProvider")`).
import {
  type RawValidationInputs,
  assembleValidationContext,
  BadDebtRepository,
  ComplianceWindowRepository,
  CostCenterMappingRepository,
  CostReportRepository,
  CostReportWorksheetRepository,
  ImportsRepository,
  StatisticDataRepository,
} from "@wardenx/cost-report";
import type { DbClient } from "@wardenx/db";
import { NotFoundError } from "@wardenx/types";
import type { CapSeamResolver } from "../routes/cap-context";
import { resolveCapContext } from "../routes/cap-context";
import type { ValidationContextBuilder } from "./m27-jobs";

/** The minimal M40 ProviderEntity surface M27 reads for the report's MAC jurisdiction (opaque rich-seam). */
export interface ProviderEntityResolver {
  resolveProviderEntity(
    orgId: string,
    providerEntityId: string,
  ): Promise<{ macJurisdiction: string } | null>;
}

export interface M27ValidationContextDeps {
  /** Resolves M26's `CapAccrualReader` (production: `m27CapSeamResolver`). */
  readonly capResolver: CapSeamResolver;
  /** Resolves M40's provider-entity directory (production: `() => getSeam("MdmEntityProvider")`). */
  readonly providerEntity: () => ProviderEntityResolver;
  now?: () => Date;
}

/** Build the live ValidationContextBuilder. `build({ organizationId, costReportId, tx })` materializes the
 *  full §11.B context from M27's DB state + the live cap/MAC facts; M23-gated fields stay unavailable. */
export function buildM27ValidationContext(deps: M27ValidationContextDeps): ValidationContextBuilder {
  const now = deps.now ?? (() => new Date());
  return {
    async build({ organizationId, costReportId, tx }) {
      const db = tx as DbClient;
      const report = await new CostReportRepository(db).findById(costReportId);
      if (!report) throw new NotFoundError("cost report not found");
      const fiscalYearInt = Number(String(report.fiscalYearEndDate).slice(0, 4));

      const [worksheets, statistic, mappings, trialBalance, badDebt, window] = await Promise.all([
        new CostReportWorksheetRepository(db).listByReport(organizationId, costReportId),
        new StatisticDataRepository(db).findByReport(organizationId, costReportId),
        new CostCenterMappingRepository(db).listForProviderFy(organizationId, report.providerEntityId, fiscalYearInt),
        new ImportsRepository(db).findLatestCompleteTrialBalance(organizationId, costReportId),
        new BadDebtRepository(db).listForReport(organizationId, costReportId),
        new ComplianceWindowRepository(db).findByReport(organizationId, costReportId),
      ]);

      // M26 cap (live): the cost-report cap year is the federal FY of the FYE year (the cap calc's window).
      const cap = await resolveCapContext(deps.capResolver, organizationId, `FY${fiscalYearInt}`);

      // M40 MAC jurisdiction (fail-soft → null → `all`, so only platform-default rules apply).
      let macJurisdictionCode: string | null = null;
      try {
        const pe = await deps.providerEntity().resolveProviderEntity(organizationId, report.providerEntityId);
        macJurisdictionCode = pe?.macJurisdiction ?? null;
      } catch {
        macJurisdictionCode = null;
      }

      const raw: RawValidationInputs = {
        fiscalYearEndDate: String(report.fiscalYearEndDate),
        badDebtClaimed: report.badDebtClaimed,
        wageSource: report.wageSource,
        macJurisdictionCode,
        worksheets: worksheets.map((w) => ({ worksheetCode: w.worksheetCode, data: w.data })),
        statistic: statistic ? { monthlyBreakdown: statistic.monthlyBreakdown } : null,
        mappings: mappings.map((m) => ({ cmsCostCenterCode: m.cmsCostCenterCode })),
        trialBalanceAccounts: trialBalance
          ? trialBalance.normalizedAccounts.map((acc) => ({ debitCents: acc.debitCents, creditCents: acc.creditCents }))
          : null,
        badDebt: badDebt.map((bd) => ({
          collectionEffortsDocumented: bd.collectionEffortsDocumented,
          debtKind: bd.debtKind,
          amountCents: bd.amountCents,
          supportingDocumentIds: bd.supportingDocumentIds ?? [],
        })),
        complianceWindow: window
          ? { currentEffectiveDeadlineDate: String(window.currentEffectiveDeadlineDate), closedAt: window.closedAt ? String(window.closedAt) : null }
          : null,
        // The submit-past-deadline override is granted at SUBMIT, not validation time → false here.
        deadlineOverrideGranted: false,
        cap: { capContext: cap.capContext, capProviderBound: cap.capProviderBound },
        now: now(),
      };
      return assembleValidationContext(raw);
    },
  };
}
