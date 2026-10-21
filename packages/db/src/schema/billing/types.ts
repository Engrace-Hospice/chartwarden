// @chartwarden/db — M23 Billing (Medicare): shared pgEnum declarations + helper TS types for the
// module's jsonb columns (spec §3.3). The enums live here (not scattered into table files) so the
// fan-out table files import them from a single home and never redeclare a pgEnum. Filename
// intentionally avoids the substring "schema" (table-ownership/tenancy heuristic gotcha).
//
// CONVENTIONS (mirror @chartwarden/db cost-report, M27 — the proven precedent):
//   * Every DB ENUM type name is `m23_`-prefixed (matches M27 `m27_*` / M30 `m30_*`) so it can never
//     collide with another module's enum; the exported Drizzle const is camelCase `m23X`.
//   * The DEEP per-rule `predicate_dsl` and per-result `remediation` shapes are TypeBox-typed at the
//     service layer in `@chartwarden/billing` (P2). At the DB layer those columns are typed loosely here so
//     the schema package takes no `@chartwarden/billing` edge.
//   * No PHI / MBI is ever stored in these columns (D13, §3.6, §8.7) — MBI is NEVER persisted.
import { pgEnum } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Enums (spec §3.3 "billing/enums.ts" — all `m23_`-prefixed)
// ─────────────────────────────────────────────────────────────────────────────

export const m23ClaimState = pgEnum("m23_claim_state", [
  "DRAFT",
  "VALIDATING",
  "READY",
  "SUBMITTED",
  "ACK_PENDING",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "ACK_PARTIAL",
  "PAID",
  "PARTIAL_PAID", // migration 0198 (GAP-037) — the domain union + the §2.2 machine had it; the enum did not
  "DENIED",
  "REPLACED",
  "VOIDED",
]);

export const m23ClaimTob = pgEnum("m23_claim_tob", [
  "811", // admission-through-discharge
  "812", // first interim
  "813", // continuing interim
  "814", // last interim before discharge
  "817", // replacement
  "818", // void
]);

export const m23ClaimLineRevenueCode = pgEnum("m23_claim_line_revenue_code", [
  "0651", // routine home care (RHC)
  "0652", // continuous home care (CHC)
  "0655", // inpatient respite care (IRC)
  "0656", // general inpatient (GIP)
  "0657", // physician services
  "0659", // other hospice services
  // Visit lines (migration 1054; CMS Pub. 100-04 ch. 11 §30.3) — one dated line per visit, 15-minute units.
  "0421", // physical therapy (G0151)
  "0431", // occupational therapy (G0152)
  "0441", // speech-language pathology (G0153)
  "0551", // skilled nursing (G0299 RN / G0300 LPN)
  "0561", // medical social services visit (G0155)
  "0569", // medical social worker phone call (G0155)
  "0571", // hospice aide (G0156)
  "0294", // SNF R&B (hospice in SNF)
  "0942", // bereavement services
]);

// F-125 (#251): Q5005/Q5006/Q5007/Q5008 corrected against real CMS descriptions — a prior version of
// this comment (and the `qCodeForPlaceOfService`/`POS_BY_QCODE` derivations it was copied into) had
// Q5005 as the inpatient-hospice-unit code and Q5006 as "unspecified", which is backwards.
export const m23ClaimLineQCode = pgEnum("m23_claim_line_q_code", [
  "Q5001", // home/residence
  "Q5002", // assisted living facility
  "Q5003", // nursing long-term-care / non-skilled nursing facility (LTC/NF)
  "Q5004", // skilled nursing facility (SNF)
  "Q5005", // inpatient hospital
  "Q5006", // inpatient hospice facility / unit (IPU)
  "Q5007", // long-term care hospital (LTCH)
  "Q5008", // inpatient psychiatric facility
  "Q5009", // place not otherwise specified (N.O.S.)
  "Q5010", // hospice home care furnished in a hospice facility
]);

export const m23ClaimLineLevelOfCare = pgEnum("m23_claim_line_level_of_care", [
  "RHC",
  "CHC",
  "IRC",
  "GIP",
]);

// NOE and NOTR share an identical state shape (spec §3.3 `notrState = noeState.enumValues`).
// Declared once as a const so both enums stay in lockstep under strict TS.
const NOE_NOTR_STATES = [
  "DRAFT",
  "READY",
  "SUBMITTED",
  "ACK_PENDING",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "CANCELLED",
] as const;

export const m23NoeState = pgEnum("m23_noe_state", NOE_NOTR_STATES);
export const m23NotrState = pgEnum("m23_notr_state", NOE_NOTR_STATES);

export const m23NotrTriggerKind = pgEnum("m23_notr_trigger_kind", [
  "revocation",
  "transfer_out",
  "discharge",
]);

export const m23ValidationSeverity = pgEnum("m23_validation_severity", ["error", "warn", "info"]);

export const m23ValidationResultOutcome = pgEnum("m23_validation_result_outcome", [
  "pass",
  "fail",
  "warn",
  "info",
]);

export const m23ValidationRunTrigger = pgEnum("m23_validation_run_trigger", [
  "initial_assembly",
  "pre_submission",
  "re_validation_after_correction",
  "re_validation_after_override",
  "manual_re_run",
]);

export const m23ValidationRunOutcome = pgEnum("m23_validation_run_outcome", [
  "all_pass",
  "failures_present",
  "overrides_required",
  "ready_for_submission",
]);

export const m23OverrideRoleRequired = pgEnum("m23_override_role_required", [
  "billing_manager",
  "compliance_officer",
  "medical_director",
  "org_admin",
]);

export const m23MacJurisdiction = pgEnum("m23_mac_jurisdiction", [
  "ngs_j6", // National Government Services — Jurisdiction 6 (incl. Engrace OR)
  "ngs_jk", // NGS — Jurisdiction K
  "cgs_j15", // CGS — Jurisdiction 15
  "palmetto_jj", // Palmetto — Jurisdiction J
  "palmetto_jm", // Palmetto — Jurisdiction M
  "noridian_jf", // Noridian — Jurisdiction F
  "noridian_je", // Noridian — Jurisdiction E
]);

export const m23ClaimSubmissionKind = pgEnum("m23_claim_submission_kind", [
  "claim_837i",
  "noe",
  "notr",
  // Migration 0375 — the 8xC transfer notice / 8xD void (CMS Pub. 100-04 ch. 11 §20.1.3–§20.1.4).
  "transfer_notice",
]);

export const m23ClaimSubmissionOutcome = pgEnum("m23_claim_submission_outcome", [
  "queued",
  "generated",
  "submitted",
  "failed_worker",
  "failed_portal",
]);

export const m23ClaimAcknowledgmentKind = pgEnum("m23_claim_acknowledgment_kind", [
  "ack_999",
  "ack_277ca",
  "ack_835",
]);

export const m23EligibilityOutcome = pgEnum("m23_eligibility_outcome", [
  "active_part_a",
  "inactive_part_a",
  "mbi_invalid",
  "unknown_response",
  "hets_error",
]);

// ─────────────────────────────────────────────────────────────────────────────
// jsonb payload helper types (back the Drizzle `.$type<...>()` generics — no `any`)
// ─────────────────────────────────────────────────────────────────────────────

// claim_line.backing_encounter_ids — M8 encounter UUIDs backing this line (default []).
export type ClaimLineBackingEncounterIds = string[];

// claim_line.icd_pointer_positions — int[] referencing the parent claim's ICD list 1..12 (default []).
export type ClaimLineIcdPointerPositions = number[];

// claim_line.modifiers — string[] up to 4 per X12 (M38 value set cms_hospice_modifiers; default []).
export type ClaimLineModifiers = string[];

// validation_rule_config.parameters — tenant parameter overlay, typed by rule kind at the service
// layer (P2). Opaque at the DB layer.
export interface ValidationRuleParameters {
  [key: string]: unknown;
}

// validation_rule_config.predicate_dsl — custom-rule predicate (JSON-DSL or TypeScript ref id),
// populated only when is_custom=true. Opaque at the DB layer.
export interface ValidationRulePredicateDsl {
  [key: string]: unknown;
}

// per_diem_rate_calculation.segments — per-period level-of-care breakdown (NOT NULL, no default).
export interface PerDiemRateCalculationSegment {
  levelOfCare: "RHC" | "CHC" | "IRC" | "GIP";
  dateFrom: string; // ISO date
  dateTo: string; // ISO date
  ratePerDiemCents: number;
  perDiemClassCharPosition: number;
  /** The fiscal year (starting calendar year) and the wage-index factor this segment was priced with - one claim can
   *  span two fiscal years, so the per-claim `wage_index_*` columns alone cannot reproduce the second year's math.
   *  Optional: rows written before this field carry neither. */
  wageIndexFiscalYear?: number;
  wageIndexFactor?: string;
}
export type PerDiemRateCalculationSegments = PerDiemRateCalculationSegment[];

// per_diem_rate_calculation.rhc_carry_over — the two-tier RHC carry-over the claim was priced with (migration 0376;
// nullable: rows priced before it carry NULL). Shape owned by `@chartwarden/billing` `computeRhcCarryOver` +
// M23's `RhcCarryOverView`; kept structural here (db does not import billing). Dates, counts, NPIs, codes —
// no PHI / MBI.
export interface PerDiemRateCalculationRhcCarryOver {
  electionDate: string;
  priorDays: number;
  chainDays: number;
  basis: "internal_only" | "hets_merged" | "hets_stale";
  startsAtDay: number;
  highRateDaysRemaining: number;
  daysSinceLastCare: number | null;
  chain: readonly {
    source: "internal" | "hets";
    kind: "stay" | "sending_hospice" | "election" | "benefit_period";
    start: string;
    end: string;
    endAssumed: boolean;
    countedDays: number;
    hospiceNpi: string | null;
    ref: string | null;
  }[];
  warnings: readonly { code: string; message: string }[];
  hetsCheck: { checkId: string; checkedAt: string; ageDays: number; stale: boolean } | null;
}

// sia_calculation.qualifying_visits — last-7-days-of-life qualifying RN/MSW visits (NOT NULL, no default).
export interface SiaQualifyingVisit {
  encounterId: string; // M8 logical FK
  visitDate: string; // ISO date
  discipline: string; // e.g. RN | MSW
  durationMinutes: number;
}
export type SiaCalculationQualifyingVisits = SiaQualifyingVisit[];
