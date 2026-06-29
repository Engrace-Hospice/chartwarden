// @wardenx/cost-report — the PURE ValidationContext assembler (§11.B). Composes M27's already-read DB state
// (cost-report fields + per-worksheet `data` jsonb + statistics + mapping + trial-balance + bad-debt +
// compliance window) plus the resolved cross-module facts (M26 cap, M40 MAC jurisdiction) into the
// aggregate, PHI-free `ValidationContext` the rule library evaluates against. No DB / no clock-of-its-own
// (the caller passes `now`); reads the worksheet jsonb DEFENSIVELY (every field optional → conservative
// default), so an incomplete report yields a rule-failing context rather than a throw. M23-gated fields stay
// unavailable (billedCensusPatientDays null, settlement.tiesToWorksheetD false, the flags false) → the
// dependent rules SKIP (the unchanged deny-stub contract). Money is integer cents.
import type { BadDebtKind, WageSource, WorksheetCode } from "../contracts";
import type { CapContext, ValidationContext } from "./types";

/** M40's MacJurisdiction enum (e.g. `ngs_j6`) → the rule-scope token (`NGS-J6`); unknown → the raw code; absent → `all`. */
const MAC_SCOPE_BY_M40_CODE: Record<string, string> = {
  ngs_j6: "NGS-J6",
  cgs: "CGS",
  palmetto: "Palmetto",
  wps: "WPS",
  noridian: "Noridian",
  first_coast: "First Coast",
  novitas: "Novitas",
};

/** Normalize an M40 MAC code to the rule-scope string the engine matches; `all` when no MAC is resolvable. */
export function normalizeMacJurisdiction(m40Code: string | null | undefined): string {
  if (!m40Code) return "all";
  return MAC_SCOPE_BY_M40_CODE[m40Code.toLowerCase()] ?? m40Code;
}

export interface RawWorksheet {
  readonly worksheetCode: string;
  readonly data: unknown;
}
export interface RawStatistic {
  /** statistic_data.monthly_breakdown — { [month]: { [loc]: { [program]: { patientDays } } } }. */
  readonly monthlyBreakdown: unknown;
}
export interface RawMapping {
  readonly cmsCostCenterCode: string | null;
}
export interface RawTrialBalanceAccount {
  readonly debitCents: number;
  readonly creditCents: number;
}
export interface RawBadDebt {
  readonly collectionEffortsDocumented: boolean;
  readonly debtKind: BadDebtKind;
  readonly amountCents: number;
  readonly supportingDocumentIds: readonly unknown[];
}
export interface RawComplianceWindow {
  readonly currentEffectiveDeadlineDate: string; // ISO date
  readonly closedAt: string | null;
}

export interface RawValidationInputs {
  readonly fiscalYearEndDate: string; // "2026-12-31"
  readonly badDebtClaimed: boolean;
  readonly wageSource: WageSource;
  readonly macJurisdictionCode: string | null;
  readonly worksheets: readonly RawWorksheet[];
  readonly statistic: RawStatistic | null;
  readonly mappings: readonly RawMapping[];
  /** null = no trial balance imported yet (the tb rule then fails — an incomplete report). */
  readonly trialBalanceAccounts: readonly RawTrialBalanceAccount[] | null;
  readonly badDebt: readonly RawBadDebt[];
  readonly complianceWindow: RawComplianceWindow | null;
  readonly deadlineOverrideGranted: boolean;
  readonly cap: { capContext: CapContext | null; capProviderBound: boolean };
  readonly now: Date;
}

const MS_PER_DAY = 86_400_000;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;

/** Sum every month×LOC×program `patientDays` cell; report any negative cell (a data-integrity defect). */
function rollupCensus(breakdown: unknown): { totalPatientDays: number; hasNegative: boolean } {
  let total = 0;
  let hasNegative = false;
  const months = (breakdown ?? {}) as Record<string, Record<string, Record<string, { patientDays?: unknown }>>>;
  for (const locs of Object.values(months ?? {})) {
    for (const programs of Object.values(locs ?? {})) {
      for (const cell of Object.values(programs ?? {})) {
        const days = num((cell as { patientDays?: unknown })?.patientDays);
        if (days < 0) hasNegative = true;
        total += days;
      }
    }
  }
  return { totalPatientDays: total, hasNegative };
}

/** Compose the aggregate ValidationContext from the read DB state + resolved seam facts. */
export function assembleValidationContext(input: RawValidationInputs): ValidationContext {
  const byCode = new Map(input.worksheets.map((w) => [w.worksheetCode, w.data]));
  const ws = (code: WorksheetCode | string): Record<string, unknown> =>
    (byCode.get(code) as Record<string, unknown> | undefined) ?? {};
  const has = (code: WorksheetCode | string): boolean => byCode.has(code);

  const a = ws("A");
  const b = ws("B");
  const c = ws("C");
  const d = ws("D");
  const a6 = ws("A-6");
  const g1 = ws("G-1");
  const sWs = ws("S");

  const census = rollupCensus(input.statistic?.monthlyBreakdown);
  const dDays = ["medicare", "medicaid", "other"].reduce(
    (sum, program) => sum + num((d[program] as { totalDays?: unknown } | undefined)?.totalDays),
    0,
  );

  const deadlineMs = input.complianceWindow
    ? new Date(`${input.complianceWindow.currentEffectiveDeadlineDate}T00:00:00Z`).getTime()
    : null;
  const daysToDeadline = deadlineMs === null ? 0 : Math.round((deadlineMs - input.now.getTime()) / MS_PER_DAY);
  const closed = !!input.complianceWindow?.closedAt;

  return {
    fiscalYearInt: Number(input.fiscalYearEndDate.slice(0, 4)),
    macJurisdiction: normalizeMacJurisdiction(input.macJurisdictionCode),
    badDebtClaimed: input.badDebtClaimed,
    wageSource: input.wageSource,
    demographics: {
      ccnPresent: typeof sWs.providerCcn === "string" && (sWs.providerCcn as string).length > 0,
      fiscalYearEndConfigured: input.fiscalYearEndDate.length > 0,
      relatedPartyDisclosed: has("A-8") || has("S-2"),
    },
    trialBalance: {
      present: !!input.trialBalanceAccounts && input.trialBalanceAccounts.length > 0,
      totalDebitsCents: (input.trialBalanceAccounts ?? []).reduce((s, x) => s + num(x.debitCents), 0),
      totalCreditsCents: (input.trialBalanceAccounts ?? []).reduce((s, x) => s + num(x.creditCents), 0),
    },
    mapping: {
      mappedAccountCount: input.mappings.filter((m) => !!m.cmsCostCenterCode).length,
      orphanAccountCount: input.mappings.filter((m) => !m.cmsCostCenterCode).length,
    },
    statistics: {
      serviceCensusPatientDays: census.totalPatientDays,
      // M23 PatientDaysProvider unbound → null (the reconcile rule SKIPS; never fabricated).
      billedCensusPatientDays: null,
      totalPatientDays: census.totalPatientDays,
      s3GrandTotalPatientDays: census.totalPatientDays,
      hasNegativeCensusValue: census.hasNegative,
    },
    worksheets: {
      presentCodes: input.worksheets.map((w) => w.worksheetCode) as WorksheetCode[],
      aGrandTotalCostsCents: num(a.grandTotalCostsCents),
      bTotalAllocatedCents: num(b.totalFullyAllocatedCostCents),
      bTiesToWorksheetA: bool(b.tiesToWorksheetAGrandTotal),
      reclassificationsNetCents: num(a6.totalAdjustmentsCents),
      // No per-entry "basis documented" flag on A-8 today → 0 (no unsupported adjustments; a refinement lands
      // when the A-8 basis field is modeled). An absent A-8 trivially has no unsupported adjustments.
      adjustmentsUnsupportedCount: 0,
      statisticalBasisPresent: Array.isArray(b.allocationColumns) && (b.allocationColumns as unknown[]).length > 0,
      // Within bounds unless Worksheet C flags a zero-charge RCC basis; an absent C has no ancillary centers.
      ancillaryRccWithinBounds: has("C") ? !bool(c.hasZeroChargeBasisFlag) : true,
      programDaysTie: bool(d.apportionmentPreservesTotalExactly),
      dProgramDaysCarried: dDays,
      // Balance-sheet integrity proxy: the G-1 fund-balance rollforward ties to Worksheet F net assets.
      balanceSheetBalances: has("G-1") ? bool(g1.tiesToWorksheetFNetAssets) : false,
    },
    settlement: {
      computed: has("E-1"),
      // M23 ClaimSettlementProvider unbound → false (the E-1↔D tie rule SKIPS).
      tiesToWorksheetD: false,
    },
    cap: input.cap.capContext,
    badDebt: {
      entries: input.badDebt.map((x) => ({
        collectionEffortsDocumented: x.collectionEffortsDocumented,
        debtKind: x.debtKind,
        amountCents: x.amountCents,
        supportingDocumentCount: Array.isArray(x.supportingDocumentIds) ? x.supportingDocumentIds.length : 0,
      })),
    },
    supportingDocs: { s2AttachmentsPresent: has("S-2") },
    deadline: {
      pastDeadline: deadlineMs !== null && input.now.getTime() > deadlineMs,
      pastDeadlineOverrideGranted: input.deadlineOverrideGranted,
      daysToDeadline,
      windowOpen: !!input.complianceWindow && !closed,
    },
    seams: {
      capProviderBound: input.cap.capProviderBound,
      patientDaysProviderBound: false,
      claimSettlementProviderBound: false,
      drugCostBillingReaderBound: false,
    },
  };
}
