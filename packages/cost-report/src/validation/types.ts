// @wardenx/cost-report — M27 pre-submission validation RULE MODEL (§2.1 `cost_report_validation_rule`,
// architecture §11.B, D9/D16/D20/D21). The configurable rule library is the CONTENT validation framework
// (distinct from the §2.3 schema/service-layer domain invariants): every cost report runs through a set
// of `RuleDef`s before submission, each a deterministic PURE predicate over an injected
// `ValidationContext`. This file is the model only — the 28 platform-default rules live in
// `./default-rules`, the NGS-J6 additive set in `./mac-profiles/ngs-j6`, the runner in `./rule-engine`,
// and the D20 auto-suggestion stub in `./rule-suggestion`.
//
// Determinism (D8): a `RuleDef.evaluate` is a pure function of its `ValidationContext` — no clock, no
// I/O, no randomness — so the same materialized snapshot always yields the same per-rule outcome across
// re-validations. Money crosses every boundary as INTEGER CENTS (`Cents`); ratio/threshold checks here
// use EXACT integer comparison / cross-multiplication (never float, never division) so a tie test is
// penny-exact and reproducible. No PHI (D18) — the context carries aggregate financial/statistical
// figures and structural flags only; never a patient identifier.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. Types, pure
// functions, constants only.
import type {
  RuleCategory,
  RuleSeverity,
  RuleStatus,
  ValidationOutcome,
  WorksheetCode,
  WageSource,
  BadDebtKind,
} from "../contracts";
import type { Cents } from "../domain/money";

// ── rule outcome / result shape ──────────────────────────────────────────────────────────────────────

/**
 * Why a rule produced `outcome: 'skip'`. `seam_not_bound` is the D12/D13 forward-seam-deny-stub case —
 * the cap (M26) or claim/patient-days (M23) provider is not yet bound, so a rule that depends on it is
 * deferred rather than failed (it surfaces on the worklist as "pending", never blocks submission).
 * `not_applicable` is the in-scope-but-inert case (e.g. a bad-debt rule when `bad_debt_claimed=false`).
 */
export type RuleSkipReason = "seam_not_bound" | "not_applicable";

/** Aggregate, PHI-free observed values a rule may attach to its result for the remediation worklist. */
export type RuleObserved = Readonly<Record<string, number | string | boolean>>;

/**
 * The structured, PHI-free detail payload persisted into `cost_report_validation_result.details` (§3.3):
 * a human-readable message, an optional skip `reason`, optional aggregate `observed` figures, and an
 * optional remediation hint. No patient-identifiable field is representable here (D18).
 */
export interface RuleResultDetails {
  readonly message: string;
  readonly reason?: RuleSkipReason;
  readonly observed?: RuleObserved;
  readonly remediationHint?: string;
}

/** One rule's evaluation outcome over a `ValidationContext`. */
export interface RuleResult {
  readonly outcome: ValidationOutcome;
  readonly details: RuleResultDetails;
}

// ── the rule definition ──────────────────────────────────────────────────────────────────────────────

/**
 * A single platform-default, MAC-profile, or tenant-custom validation rule. `regulatoryRequired` rules
 * are the CFR-mandated floor (D21): tenants cannot disable them and a `fail` is BLOCKING — it cannot be
 * skip-and-submit'd (M27-F08). `macJurisdictionScope` is `'all'` or a comma-separated MAC list (D16);
 * the engine applies a rule only when its scope covers the report's MAC. `evaluate` is a DETERMINISTIC
 * pure predicate over the injected `ValidationContext` (D8) — never reads a clock, file, or seam.
 */
export interface RuleDef {
  readonly ruleCode: string;
  readonly category: RuleCategory;
  readonly description: string;
  readonly severity: RuleSeverity;
  readonly regulatoryRequired: boolean;
  /** `'all'` or a comma-separated MAC list (e.g. `'NGS-J6'`, `'CGS,Palmetto'`). */
  readonly macJurisdictionScope: string;
  /** Lifecycle status (§2.1). Defaults to `'active'` when omitted; `'draft_suggestion'` for D20 stubs. */
  readonly status?: RuleStatus;
  readonly evaluate: (ctx: ValidationContext) => RuleResult;
}

// ── the injected validation context (aggregate, PHI-free) ──────────────────────────────────────────────

/** Demographics / ownership structural facts (Worksheets S-2, A-8). No patient identifiers (D18). */
export interface DemographicsContext {
  readonly ccnPresent: boolean;
  readonly fiscalYearEndConfigured: boolean;
  /** Whether related-party / ownership disclosures (A-8 reclass, S-2) are present when applicable. */
  readonly relatedPartyDisclosed: boolean;
}

/** Trial-balance aggregate totals (Xero/manual import, §3.3 `trial_balance_import`). Integer cents. */
export interface TrialBalanceContext {
  readonly present: boolean;
  readonly totalDebitsCents: Cents;
  readonly totalCreditsCents: Cents;
}

/** Cost-center mapping coverage (§3.3 `cost_center_mapping`). `orphanAccountCount` drives `tb.no_orphan_accounts`. */
export interface CostCenterMappingContext {
  readonly orphanAccountCount: number;
  readonly mappedAccountCount: number;
}

/** Aggregate-by-month-by-level census (§3.3 `statistic_data`); never patient-identifiable (D18). */
export interface StatisticsContext {
  /** M6 service census patient-days. */
  readonly serviceCensusPatientDays: number;
  /** M23 billed-and-accepted census patient-days; `null` until the M23 PatientDaysProvider binds. */
  readonly billedCensusPatientDays: number | null;
  readonly totalPatientDays: number;
  /** S-3 Part I grand-total patient-days (cross-checked against the days carried into Worksheet D). */
  readonly s3GrandTotalPatientDays: number;
  /** True iff any month×LOC census cell is negative (a data-integrity defect). */
  readonly hasNegativeCensusValue: boolean;
}

/** Worksheet roll-up totals + structural tie flags computed by the Phase-2 allocation/apportionment math. */
export interface WorksheetTotalsContext {
  /** Which worksheet rows exist for the report (the §2.2 lazy-create set). */
  readonly presentCodes: readonly WorksheetCode[];
  /** Worksheet A grand-total costs (integer cents). */
  readonly aGrandTotalCostsCents: Cents;
  /** Worksheet B total allocated costs (integer cents) + whether B ties back to A. */
  readonly bTotalAllocatedCents: Cents;
  readonly bTiesToWorksheetA: boolean;
  /** Worksheet A-6 reclassifications must net to exactly zero cents. */
  readonly reclassificationsNetCents: Cents;
  /** Count of Worksheet A-8 adjustments lacking a documented basis. */
  readonly adjustmentsUnsupportedCount: number;
  /** Whether the Worksheet B-1 cost-allocation statistical basis (sq-ft, FTE, accumulated cost, …) is present. */
  readonly statisticalBasisPresent: boolean;
  /** Worksheet C per-diem cost ties to Worksheet B (Σ level-of-care cost equals the B total). */
  readonly cTiesToWorksheetB: boolean;
  /** Worksheet F balance sheet present + balances (assets = liabilities + fund balance). */
  readonly balanceSheetBalances: boolean;
}

/** Drug-cost cross-check facts. `billedCents` is the M12 drug-cost basis for the FY (the DrugCostBillingReader
 *  seam); `worksheetAPharmacyCents` is the GL pharmacy cost-center on Worksheet A. The reconcile rule compares
 *  them — it SKIPS while M12's cost is unbound (`billedCents` null) or the pharmacy center is absent. */
export interface DrugCostContext {
  readonly billedCents: number | null;
  readonly worksheetAPharmacyCents: number | null;
}

/**
 * Cap-year aggregate figures (M26 `CapAccrualReader`/`CapPeriodReader`). Present only when the cap seam
 * is bound; `null` under the D13 forward-seam-deny-stub, in which case the cap rules SKIP. Integer cents
 * for money; day counts for the inpatient-cap ratio (checked by exact cross-multiplication, no division).
 */
export interface CapContext {
  readonly aggregateCapCents: Cents;
  readonly aggregatePaymentsCents: Cents;
  readonly inpatientDays: number;
  readonly totalMedicareDays: number;
}

/** One bad-debt entry's audit-relevant facts (§3.3 `bad_debt_record`). Aggregate-to-period; no PHI (D18). */
export interface BadDebtEntrySummary {
  readonly collectionEffortsDocumented: boolean;
  readonly debtKind: BadDebtKind | null;
  readonly amountCents: Cents;
  readonly supportingDocumentCount: number;
}

export interface BadDebtContext {
  readonly entries: readonly BadDebtEntrySummary[];
}

/** Supporting-documentation presence flags (M22 doc references resolved to counts upstream). */
export interface SupportingDocsContext {
  readonly s2AttachmentsPresent: boolean;
}

/** Filing-deadline window state (§2.2 `cost_report_compliance_window`, D15). */
export interface DeadlineContext {
  readonly pastDeadline: boolean;
  /** Whether the `cost_report:submit_past_deadline` override permission + reason was granted. */
  readonly pastDeadlineOverrideGranted: boolean;
  readonly daysToDeadline: number;
  readonly windowOpen: boolean;
}

/**
 * Which forward seams are bound at evaluation time (D12/D13). When a flag is false, rules that depend on
 * that seam SKIP with `reason: 'seam_not_bound'` rather than fail — the deny-stub contract.
 */
export interface SeamAvailabilityFlags {
  /** M26 cap accrual/period readers. */
  readonly capProviderBound: boolean;
  /** M23 PatientDaysProvider. */
  readonly patientDaysProviderBound: boolean;
  /** M23 ClaimSettlementProvider. */
  readonly claimSettlementProviderBound: boolean;
  /** M23 DrugCostBillingReader. */
  readonly drugCostBillingReaderBound: boolean;
}

/**
 * The injected, aggregate, PHI-free snapshot every rule evaluates against. Built by the Phase-2 service
 * layer from the materialized worksheet/statistics/mapping/bad-debt state plus the live seam-binding
 * flags; passed by value into `runValidation`. Carries NO patient identifier and NO clock — rules are
 * pure functions of this value (D8, D18).
 */
export interface ValidationContext {
  /** Fiscal year integer (e.g. `2026` for FYE `2026-12-31`); for `rule_set_version` provenance only. */
  readonly fiscalYearInt: number;
  /** The report's MAC jurisdiction (e.g. `'NGS-J6'`); the engine scopes MAC-specific rules against it. */
  readonly macJurisdiction: string;
  readonly badDebtClaimed: boolean;
  readonly wageSource: WageSource;
  readonly demographics: DemographicsContext;
  readonly trialBalance: TrialBalanceContext;
  readonly mapping: CostCenterMappingContext;
  readonly statistics: StatisticsContext;
  readonly worksheets: WorksheetTotalsContext;
  readonly drugCost: DrugCostContext;
  /** `null` under the D13 cap-seam deny-stub. */
  readonly cap: CapContext | null;
  readonly badDebt: BadDebtContext;
  readonly supportingDocs: SupportingDocsContext;
  readonly deadline: DeadlineContext;
  readonly seams: SeamAvailabilityFlags;
}

// ── pure result constructors (shared by every rule file) ───────────────────────────────────────────────

/** A `pass` result. */
export function passResult(message: string, observed?: RuleObserved): RuleResult {
  return { outcome: "pass", details: observed ? { message, observed } : { message } };
}

/** A `fail` result with an optional remediation hint + observed aggregate figures. */
export function failResult(
  message: string,
  remediationHint?: string,
  observed?: RuleObserved,
): RuleResult {
  const details: RuleResultDetails = { message };
  return {
    outcome: "fail",
    details: {
      ...details,
      ...(remediationHint ? { remediationHint } : {}),
      ...(observed ? { observed } : {}),
    },
  };
}

/** A `warn` result (non-blocking advisory). */
export function warnResult(
  message: string,
  remediationHint?: string,
  observed?: RuleObserved,
): RuleResult {
  return {
    outcome: "warn",
    details: {
      message,
      ...(remediationHint ? { remediationHint } : {}),
      ...(observed ? { observed } : {}),
    },
  };
}

/** A `skip` result, carrying the reason it was deferred (seam-unbound or not-applicable). */
export function skipResult(message: string, reason: RuleSkipReason): RuleResult {
  return { outcome: "skip", details: { message, reason } };
}
