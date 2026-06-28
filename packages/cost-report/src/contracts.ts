// @wardenx/cost-report — M27 canonical shared DOMAIN VALUE TYPES (§2.1 / §4.3). The id aliases and the
// pgEnum-mirroring string unions the seams and every subtree reference. Kept local to the package (the
// M30 `contracts.ts` precedent) so M27 takes no `@wardenx/types` edge for ids that `@wardenx/types` does
// not yet declare. No PHI (D18).

// ── branded-ish id aliases (string at runtime; documentary at the type layer) ────────────────────────
export type OrganizationId = string;
export type ProviderEntityId = string;
export type CostReportId = string;
export type CostReportSnapshotId = string;
export type EcrSubmissionId = string;
export type ValidationId = string;
export type ValidationResultId = string;
export type MembershipId = string;

// ── lifecycle / enum string unions (mirror the frozen `packages/db` pgEnums) ─────────────────────────
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
  | "S-3"
  | "S-4"
  | "A"
  | "A-1"
  | "A-6"
  | "A-7"
  | "A-8"
  | "B"
  | "B-1"
  | "C"
  | "D"
  | "E-1"
  | "F"
  | "G"
  | "G-1"
  | "G-2"
  | "G-3"
  | "H";

/** The 21 CMS-1984-14 worksheet codes, ordered as they appear in the workbench navigation tree (§5.1). */
export const WORKSHEET_CODES: readonly WorksheetCode[] = [
  "S",
  "S-1",
  "S-2",
  "S-3",
  "S-4",
  "A",
  "A-1",
  "A-6",
  "A-7",
  "A-8",
  "B",
  "B-1",
  "C",
  "D",
  "E-1",
  "F",
  "G",
  "G-1",
  "G-2",
  "G-3",
  "H",
] as const;

/** Derived worksheets (computed from upstream via the allocation/apportionment pure functions, D8). */
export const DERIVED_WORKSHEET_CODES: readonly WorksheetCode[] = ["B", "C", "D", "E-1"] as const;

export type ValidationOutcome = "pass" | "fail" | "warn" | "skip";
export type RuleSeverity = "block" | "warn" | "info";
export type RuleStatus = "active" | "deprecated" | "draft_suggestion";
export type SnapshotReason = "submit" | "reopen" | "mac_revision_request" | "admin_audit";
export type WageSource = "gusto" | "manual";
export type ImportSource = "xero" | "manual_csv" | "gusto";
export type BadDebtKind = "deductible" | "coinsurance";
export type EcrSubmissionStatus =
  | "generating"
  | "generated"
  | "uploaded"
  | "accepted"
  | "rejected";
export type AlertTier = "none" | "t4_months" | "t4_5_months" | "t4_75_months" | "past_deadline";

export type RuleCategory =
  | "demographics_ownership"
  | "statistical_data"
  | "trial_balance"
  | "reclassifications"
  | "adjustments"
  | "cost_allocation"
  | "ancillary_apportionment"
  | "apportionment_programs"
  | "settlement"
  | "balance_sheet"
  | "cap"
  | "bad_debt"
  | "cross_worksheet"
  | "mac_specific"
  | "supporting_docs"
  | "filing_deadline";
