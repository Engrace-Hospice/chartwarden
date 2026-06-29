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
  type RawBillingBinds,
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

/** M23 `PatientDaysProvider` consumer view (opaque rich-seam; cast from getSeam). Billed-and-accepted census. */
export interface PatientDaysSeam {
  billedDaysForFiscalYear(
    orgId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<{ totalPatientDays: number }>;
}

/** M25 `ClaimSettlementProvider` consumer view (opaque rich-seam). Actual interim Medicare payments (835). */
export interface ClaimSettlementSeam {
  interimPaymentsForFiscalYear(
    orgId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<{ interimPaymentsCents: number }>;
}

/** M12 `DrugCostBillingReader` consumer view (opaque rich-seam). RESERVATION: deny-stub until M12 materializes
 *  med-order cost, so every call degrades and the drug-reconcile rule SKIPS. */
export interface DrugCostSeam {
  drugCostForFiscalYear(
    orgId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<{ totalCostCents: number }>;
}

export interface M27ValidationContextDeps {
  /** Resolves M26's `CapAccrualReader` (production: `m27CapSeamResolver`). */
  readonly capResolver: CapSeamResolver;
  /** Resolves M40's provider-entity directory (production: `() => getSeam("MdmEntityProvider")`). */
  readonly providerEntity: () => ProviderEntityResolver;
  /** Resolves M23's `PatientDaysProvider` (production: `() => getSeam("PatientDaysProvider")`). */
  readonly patientDays: () => PatientDaysSeam;
  /** Resolves M25's `ClaimSettlementProvider` (production: `() => getSeam("ClaimSettlementProvider")`). */
  readonly settlement: () => ClaimSettlementSeam;
  /** Resolves M12's `DrugCostBillingReader` (production: `() => getSeam("DrugCostBillingReader")`). */
  readonly drugCost: () => DrugCostSeam;
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

      // M23/M25/M12 cost-report binds (§4.4). Each resolves the live aggregate via getSeam; a deny-stub throw
      // (producer unbound) degrades that bind to null/false so the dependent rule SKIPS — never fabricated.
      const fyStartIso = String(report.fiscalYearStartDate);
      const fyEndIso = String(report.fiscalYearEndDate);
      const billing = await resolveBillingBinds(deps, organizationId, fyStartIso, fyEndIso);

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
        billing,
        now: now(),
      };
      return assembleValidationContext(raw);
    },
  };
}

/** Resolve the M23/M25/M12 cost-report binds, degrading each unbound (deny-stub throw) producer to null/false
 *  so the dependent rule SKIPS. The three reads are independent — one unbound producer never blocks the others
 *  (each is its own try/catch); nothing is fabricated. */
async function resolveBillingBinds(
  deps: M27ValidationContextDeps,
  orgId: string,
  fyStartIso: string,
  fyEndIso: string,
): Promise<RawBillingBinds> {
  const binds = {
    billedCensusPatientDays: null as number | null,
    patientDaysProviderBound: false,
    interimPaymentsActualCents: null as number | null,
    claimSettlementProviderBound: false,
    billedDrugChargesCents: null as number | null,
    drugCostBillingReaderBound: false,
  };

  // M23 — billed-and-accepted census patient-days.
  try {
    const r = await deps.patientDays().billedDaysForFiscalYear(orgId, fyStartIso, fyEndIso);
    binds.billedCensusPatientDays = r.totalPatientDays;
    binds.patientDaysProviderBound = true;
  } catch {
    /* M23 unbound → reconcile rule SKIPS */
  }
  // M25 — actual interim Medicare payments (835 CLP04).
  try {
    const r = await deps.settlement().interimPaymentsForFiscalYear(orgId, fyStartIso, fyEndIso);
    binds.interimPaymentsActualCents = r.interimPaymentsCents;
    binds.claimSettlementProviderBound = true;
  } catch {
    /* M25 unbound → E-1↔D tie rule SKIPS */
  }
  // M12 — drug-cost basis (RESERVATION: deny-stub until M12 materializes med-order cost).
  try {
    const r = await deps.drugCost().drugCostForFiscalYear(orgId, fyStartIso, fyEndIso);
    binds.billedDrugChargesCents = r.totalCostCents;
    binds.drugCostBillingReaderBound = true;
  } catch {
    /* M12 cost unmaterialized → drug-reconcile rule SKIPS */
  }
  return binds;
}
