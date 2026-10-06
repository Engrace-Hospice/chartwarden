import type { DischargeClaimCodes } from "../claim-codes";
// @wardenx/billing — M23 §11.A Pre-Submission Validation Framework RULE MODEL (D1, spec §4.5). The
// configurable rule library is the architectural answer to the ">99% claim acceptance" / "31-point audit
// equivalent" promise: every claim is run through a set of typed predicates before it can leave READY.
// This file is the MODEL only — the 17 platform-default rules live in `./_registry` + one file per rule
// (P2 fan-out), the runner in `./engine` (P3), the tenant DSL interpreter in `./dsl` (P3).
//
// KEY DEVIATION FROM THE SPEC PROPOSAL (architecture wins, per CLAUDE.md authority rule): spec §4.5's
// `ValidationContext` embeds the live reader SEAM interfaces and `check()` is `async` (it calls
// `electionPeriods.findActivePeriodForPatient(...)` etc.). The WardenX pure-domain convention (the M27
// `cost-report/validation/types.ts` precedent) is that a rule's `check()` is a SYNCHRONOUS PURE function
// over an INJECTED, already-resolved, plain-data `ValidationContext` — the Phase-3 validation SERVICE
// walks every reader seam ONCE, materializes the aggregate snapshot below, then runs the rules against
// it. This keeps rules deterministic + unit-testable with a plain object and keeps all I/O at the service
// boundary. The context carries ids + aggregate facts only; NO MBI and no free-text PHI (D13 / §3.6).
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`, no clock. Types,
// pure functions, constants only.
import type {
  AdmissionId,
  ClaimId,
  ClaimLineId,
  EligibilityOutcome,
  IsoDate,
  IsoDateTime,
  LevelOfCare,
  NoticeState,
  OrgId,
  OverrideRole,
  PatientId,
  ProviderEntityId,
  TypeOfBill,
  ValidationSeverity,
} from "../contracts";
import type { Cents } from "../domain/money";

// ── severity / category unions (mirror the §3.3 pgEnums) ───────────────────────────────────────────────

/** A rule's severity (mirrors `m23_validation_severity`); reused from the package contract for lockstep. */
export type RuleSeverity = ValidationSeverity;
export const RULE_SEVERITIES: readonly RuleSeverity[] = ["error", "warn", "info"] as const;

/**
 * The §4.5 rule category — the UI grouping dimension for the validation worklist. Not a DB enum (the
 * `validation_result` row records the rule `category` as text); the closed union is the registry's
 * source of truth. One default rule per category ships in P2 (plus tenant-custom rules join `evv`-style
 * categories via the DSL overlay).
 */
export type RuleCategory =
  | "eligibility"
  | "period"
  | "cert"
  | "f2f"
  | "loc"
  | "hipps"
  | "sia"
  | "icd"
  | "physician"
  | "noe"
  | "tob_dates"
  | "duplicates"
  | "pos"
  | "cap"
  | "discharge"
  | "modifiers"
  | "evv";

export const RULE_CATEGORIES: readonly RuleCategory[] = [
  "eligibility",
  "period",
  "cert",
  "f2f",
  "loc",
  "hipps",
  "sia",
  "icd",
  "physician",
  "noe",
  "tob_dates",
  "duplicates",
  "pos",
  "cap",
  "discharge",
  "modifiers",
  "evv",
] as const;

/** The target a remediation hint blames, so the worklist can deep-link to the owning module's editor. */
export type BlameTarget =
  | "claim"
  | "claim_line"
  | "patient"
  | "admission"
  | "election_period"
  | "encounter"
  | "mac_credential";

/** Why a rule SKIPPED rather than passed/failed. `seam_not_bound` is the D8/D13 forward-seam deny-stub. */
export type RuleSkipReason = "seam_not_bound" | "not_applicable";

// ── rule result ────────────────────────────────────────────────────────────────────────────────────────

/** Structured, PHI-free remediation guidance attached to a non-passing result (spec §4.5). */
export interface RuleRemediation {
  /** Human-readable remediation summary shown on the worklist. */
  readonly summary: string;
  readonly blameTarget?: BlameTarget;
  readonly blameTargetId?: string;
  /** e.g. `'edit_in_m6'`, `'cosign_in_m8'`, `'refresh_eligibility'`. */
  readonly fixAction?: string;
  /** Deep-link URL into the owning module's edit screen. */
  readonly fixDeepLink?: string;
}

/** Aggregate, PHI-free observed values a rule may attach for the worklist (e.g. `{ daysToWindow: 2 }`). */
export type RuleObserved = Readonly<Record<string, number | string | boolean>>;

/**
 * One machine-readable defect behind a failed result (e.g. `PLACE_OF_DEATH_MISSING`), with the record ids a UI
 * needs to route the fix (`admissionId`, `dischargeEventId`, `transferEventId`, ...). PHI-free: codes and ids only.
 */
export interface RuleDefect {
  readonly code: string;
  readonly message: string;
  readonly refs?: Readonly<Record<string, string>>;
}

/** Optional structured annotations carried alongside a result. */
export interface RuleAnnotations {
  readonly remediation?: RuleRemediation;
  readonly observed?: RuleObserved;
  /** Structured defects (additive — rules that do not set it are unchanged). */
  readonly defects?: readonly RuleDefect[];
  /** Present iff the rule SKIPPED (deny-stub seam or not-applicable); a skip is non-blocking. */
  readonly skipReason?: RuleSkipReason;
}

/**
 * One rule's evaluation outcome. `passed === true` ⇒ the predicate held (or the rule skipped, which is
 * non-blocking); `passed === false` ⇒ the predicate failed at this rule's `severity`. A `severity:
 * 'error'` failure on a `regulatoryRequired` rule is the BLOCKING set the §2.3 submission guard keys on
 * (unless overridden). `severity` + `passed` + `annotations.skipReason` together let the Phase-3 engine
 * roll up passed/failed/warning/skipped counts with no separate outcome enum.
 */
export interface RuleResult {
  readonly ruleKey: string;
  readonly severity: RuleSeverity;
  readonly passed: boolean;
  /** Human-readable one-line result message (PHI-free). */
  readonly message: string;
  readonly annotations?: RuleAnnotations;
}

// ── injected validation context (aggregate, plain-data, PHI-free) ──────────────────────────────────────

/** One ICD-10 position on the claim (§4.5 `icd10_sequencing`). */
export interface Icd10Pointer {
  /** 1..12 — the X12 diagnosis-pointer position. */
  readonly position: number;
  readonly code: string;
  readonly relationship: "terminal" | "related" | "unrelated";
}

/** The claim row under validation (`claim`). Carries ids + structural facts; no free-text PHI (D13). */
export interface ClaimSnapshot {
  readonly claimId: ClaimId;
  readonly providerEntityId: ProviderEntityId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly tob: TypeOfBill;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  /** Set on TOB 817/818 (D14) — the predecessor claim being replaced/voided. */
  readonly replacesClaimId: ClaimId | null;
  readonly icd10Sequence: readonly Icd10Pointer[];
  /** F-214 (#251) — how many diagnosis codes M7 WITHHELD from `icd10Sequence` because they are 42 CFR Part 2
   *  (`sud_related`) and no valid release covers disclosure for billing. A count only: NEVER the codes. Required
   *  (not optional) so a context producer cannot silently omit it and let a short sequence pass. */
  readonly diagnosesWithheldForConsent: number;
  /** True when the withheld set included the terminal (principal) diagnosis. */
  readonly terminalDiagnosisWithheldForConsent: boolean;
  readonly totalChargeCents: Cents;
  /** Prior-period claim continuity facts for the `tob_and_dates_consistency` rule (null if none). */
  readonly priorClaimTob: TypeOfBill | null;
  readonly priorClaimServiceTo: IsoDate | null;
  /** Discharge facts for the `bereavement_discharge_legitimacy` rule (null on non-discharge TOBs). */
  readonly dischargeDate: IsoDate | null;
  readonly dischargeReason: string | null;
  /** The date of death when the stay ended in death (M6 `discharge_event.death_at`); null/absent otherwise. */
  readonly deathDate?: IsoDate | null;
  /**
   * The discharge-driven claim codes (patient status / condition 52, H2 / occurrence 42, 55) derived from
   * the same facts (`deriveDischargeClaimCodes`). Required so no context producer can omit it; the
   * `bereavement_discharge_legitimacy` rule blocks a claim whose codes are unresolved or conflicting.
   */
  readonly dischargeClaimCodes: DischargeClaimCodes;
  /**
   * The M6 row the stay-ending fact came from (`discharge_event.id` for a discharge, `transfer_event.id` for a
   * transfer-out; `null`/absent for a revocation or a still-open stay). Only used to address the fix.
   */
  readonly dischargeSourceEventId?: string | null;
}

/** One assembled `claim_line` (per service-date per LOC). */
export interface ClaimLineSnapshot {
  readonly claimLineId: ClaimLineId;
  readonly serviceDate: IsoDate;
  /** Revenue code (`'0651'`…) — validated against the M38 value set resolved in `terminology`. */
  readonly revenueCode: string;
  readonly qCode: string | null;
  readonly levelOfCare: LevelOfCare;
  readonly hcpcs: string | null;
  readonly modifiers: readonly string[];
  readonly unitCount: number;
  readonly unitRateCents: Cents;
  readonly lineChargeCents: Cents;
  /** Positions (1..12) into `claim.icd10Sequence` this line points at. */
  readonly icdPointerPositions: readonly number[];
  /** M8 encounter ids backing this line (drive the EVV + billability + SIA rules). */
  readonly backingEncounterIds: readonly string[];
}

/** A resolved election period (M6 `ElectionPeriodReader`). `effectiveTo === null` ⇒ open period. */
export interface ElectionPeriodSnapshot {
  readonly sequence: number;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly revoked: boolean;
  readonly revocationDate: IsoDate | null;
  /**
   * M6 seam fact: this period is a NEW admission's first period (3+) admitted with DOCUMENTED exceptional
   * circumstances (MBPM ch. 9 §20.1(5)(d)). With it, a death within 2 days of the period start deems the F2F
   * complete. Absent/false on every other period.
   */
  readonly f2fExceptionDocumented?: boolean;
}

/** Certification (CTI) facts per election period (M6 `CertificationReader`). */
export interface CertificationSnapshot {
  readonly electionPeriodSequence: number;
  readonly ctiSigned: boolean;
  readonly ctiSignedDate: IsoDate | null;
  /** Attending co-sign is required for period 1 when the patient has an attending physician. */
  readonly attendingCosignRequired: boolean;
  readonly attendingCosigned: boolean;
}

/** Face-to-face attestation facts (M6 `FaceToFaceReader`); required for periods ≥ 3. */
export interface FaceToFaceSnapshot {
  readonly electionPeriodSequence: number;
  readonly attested: boolean;
  readonly encounterDate: IsoDate | null;
}

/** A level-of-care period within the claim range (M6 `LevelOfCareReader`). */
export interface LevelOfCarePeriodSnapshot {
  readonly levelOfCare: LevelOfCare;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** CHC requires 8+ documented hours/day; `null` when not a CHC period. */
  readonly chcDocumentedHours: number | null;
  /** GIP requires admission criteria documented; `null` when not a GIP period. */
  readonly gipAdmissionCriteriaDocumented: boolean | null;
}

/** M8 billability of a backing encounter (D10). `awaiting_cosignature` excludes the visit from assembly. */
export type BillabilityState = "billable" | "awaiting_cosignature" | "not_billable";

export interface BillableEncounterSnapshot {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
  readonly billability: BillabilityState;
}

/** A signed encounter in the last 7 days of life window (M8 `SignedEncountersReader`), for the SIA rule. */
export interface SignedEncounterSnapshot {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
  /** Discipline code (e.g. `'RN'`, `'MSW'`, `'HHA'`, `'chaplain'`). */
  readonly discipline: string;
  readonly signed: boolean;
  readonly cosignRequired: boolean;
  readonly cosigned: boolean;
  readonly durationMinutes: number;
}

/** M18 EVV bracket state for a backing encounter (D9). `unresolved_missing` BLOCKS submission. */
export type EvvBracketState =
  | "compliant"
  | "not_required"
  | "documented_missing"
  | "unresolved_missing";

export interface EvvBracketSnapshot {
  readonly encounterId: string;
  readonly bracketState: EvvBracketState;
}

/**
 * Resolved M38 terminology lookups (as-of `ctx.asOfDate` = claim.service_from). `valueSetMembership` maps
 * a value-set id to its member codes; `icd10Billable` maps an ICD-10 code to whether it is a
 * billable/non-truncated leaf with sufficient specificity. Use the `isMemberOf` helper below to read it.
 */
export interface TerminologyResolution {
  readonly valueSetMembership: Readonly<Record<string, readonly string[]>>;
  readonly icd10Billable: Readonly<Record<string, boolean>>;
}

/** NPPES/MDM status of a physician (M40 `MdmEntityProvider.resolvePhysician`). */
export type NpiStatus = "active" | "inactive" | "not_found" | "invalid";

export interface PhysicianResolution {
  readonly npi: string;
  readonly status: NpiStatus;
  /** Whether the required state license is unexpired across the claim's service dates. */
  readonly licenseUnexpiredOnServiceDates: boolean;
}

/** Resolved M40/M5 master-data facts. */
export interface MdmResolution {
  readonly attending: PhysicianResolution | null;
  readonly hospicePhysician: PhysicianResolution | null;
  /** The patient's documented place of service (home / ALF / SNF / IPU) for the POS rule. */
  readonly placeOfService: string | null;
}

/** Reproducible HIPPS derivation snapshot (D7) for the `hipps_coding_correct` rule. */
export interface HippsSegmentSnapshot {
  readonly levelOfCare: LevelOfCare;
  readonly dateFrom: IsoDate;
  readonly dateTo: IsoDate;
  readonly ratePerDiemCents: Cents;
  /** RHC payment-period bucket (first 7 days vs days 8+); `'n/a'` for non-RHC segments. */
  readonly rhcDayBucket: "days_1_60" | "days_61_plus" | "n/a";
}

export interface HippsSnapshot {
  readonly hippsCode: string;
  readonly perDiemRateCents: Cents;
  readonly wageIndexFactorApplied: string;
  readonly segments: readonly HippsSegmentSnapshot[];
}

/** SIA add-on snapshot (D6) for the `sia_calculation_correct` rule; `present` mirrors the 0..1 row. */
export interface SiaSnapshot {
  readonly present: boolean;
  readonly qualifyingVisitCount: number;
  readonly amountCents: Cents;
  /** True iff the SIA was double-counted with another adjustment (a defect the rule flags). */
  readonly doubleCounted: boolean;
}

/**
 * M26 cap projection (D8). `null` under the cap-seam DENY-STUB — the cap rules then SKIP with
 * `seam_not_bound` (warn-degraded, never a hard block) and tighten to `error` once M26 binds.
 */
export interface CapProjectionSnapshot {
  readonly patientWithinCap: boolean;
  /** Agency-wide projection as a percentage of the aggregate cap (warn when within 5% ⇒ ≥ 95). */
  readonly orgPctOfCap: number;
  readonly ipuWithinCap: boolean;
}

/**
 * The most-recent `eligibility_check` for the patient as-of the claim's service-from. `ageDays` is the
 * age of the check at SUBMISSION time, PRECOMPUTED by the service layer (the rule is clock-free) so the
 * `eligibility_check_freshness_30d` rule can compare without reading a clock. `null` when the eligibility
 * seam is unbound (rule SKIPs).
 */
export interface EligibilitySnapshot {
  readonly outcome: EligibilityOutcome;
  readonly checkedAt: IsoDateTime;
  readonly asOfDate: IsoDate;
  readonly ageDays: number;
}

/**
 * The two-tier RHC carry-over the claim was priced with (`computeRhcCarryOver`) + what the
 * `rhc_carry_over_hets_fresh` rule needs to judge it. PHI-free: dates, counts, codes.
 */
export interface RhcCarryOverSnapshot {
  readonly priorDays: number;
  readonly basis: "internal_only" | "hets_merged" | "hets_stale";
  /** True when this stay began within 60 days of the end of an earlier hospice stay (ours or HETS-known). */
  readonly readmittedWithin60Days: boolean;
  /** Age in whole days of the HETS check the carry read; null when no resolved check is on file. */
  readonly hetsCheckAgeDays: number | null;
  readonly warningCodes: readonly string[];
}

/** The admission's NOE status (D3) for the `noe_timeliness_5d` rule. */
export interface NoeStatusSnapshot {
  readonly state: NoticeState;
  /** Days elapsed since admission (precomputed; clock-free). Warn at day 3, block at day 5+1. */
  readonly admissionDay: number;
  readonly windowBreached: boolean;
}

/** The active sequestration policy snapshot (D11). `null` if none configured (a config defect). */
export interface SequestrationSnapshot {
  /** Decimal STRING (e.g. `'2.0'`) — never a float. */
  readonly percentage: string;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
}

/** The platform-shared wage-index row for the claim's CCN + FY (D12). `null` when not yet loaded. */
export interface WageIndexSnapshot {
  readonly ccn: string;
  readonly fiscalYearStarting: number;
  /** Decimal STRING (e.g. `'0.9234'`) — never a float. */
  readonly factorDecimal: string;
  readonly cbsaCode: string | null;
}

/**
 * Which forward seams are bound at evaluation time (D8/D13). When a flag is false, the rules that depend
 * on that seam SKIP with `reason: 'seam_not_bound'` rather than fail — the deny-stub contract.
 */
export interface SeamAvailabilityFlags {
  /** M26 `CapProjectionProvider`. */
  readonly capProjectionBound: boolean;
  /** M40 `MdmEntityProvider`. */
  readonly mdmResolverBound: boolean;
  /** M38 `TerminologyProvider`. */
  readonly terminologyBound: boolean;
  /** HETS eligibility refresh path. */
  readonly eligibilityBound: boolean;
}

/**
 * The injected, aggregate, plain-data, PHI-free snapshot every rule evaluates against. The Phase-3
 * validation SERVICE materializes it by walking each reader seam once; rules are pure functions of this
 * value (deterministic, clock-free, no I/O). Carries ids + structural/aggregate facts only — never the
 * MBI, never free-text PHI (D13 / §3.6).
 */
export interface ValidationContext {
  readonly orgId: OrgId;
  /** = `claim.service_from`; the as-of date for every M38 terminology lookup (§4.5). */
  readonly asOfDate: IsoDate;
  /** The report's MAC jurisdiction (e.g. `'ngs_j6'`); the engine scopes MAC-specific rules against it. */
  readonly macJurisdiction: string;

  readonly claim: ClaimSnapshot;
  readonly lines: readonly ClaimLineSnapshot[];
  readonly electionPeriods: readonly ElectionPeriodSnapshot[];
  readonly certifications: readonly CertificationSnapshot[];
  readonly faceToFace: readonly FaceToFaceSnapshot[];
  readonly levelOfCarePeriods: readonly LevelOfCarePeriodSnapshot[];
  readonly billableEncounters: readonly BillableEncounterSnapshot[];
  readonly signedEncounters: readonly SignedEncounterSnapshot[];
  readonly evvBrackets: readonly EvvBracketSnapshot[];
  readonly terminology: TerminologyResolution;
  readonly mdm: MdmResolution;

  /** `null` until the HIPPS calculator has run (always present by the time rules run in practice). */
  readonly hipps: HippsSnapshot | null;
  /** `null` when no SIA applies (patient not in last-7-days-of-life window). */
  readonly sia: SiaSnapshot | null;
  /** `null` under the M26 cap-seam deny-stub (D8). */
  readonly capProjection: CapProjectionSnapshot | null;
  /** `null` when the eligibility seam is unbound. */
  readonly eligibility: EligibilitySnapshot | null;
  /** `null` when the admission has no NOE row yet. */
  readonly noe: NoeStatusSnapshot | null;
  /** The RHC carry-over the claim was priced with; absent/null when not materialized (the rule skips). */
  readonly rhcCarryOver?: RhcCarryOverSnapshot | null;
  readonly sequestration: SequestrationSnapshot | null;
  /** `null` when the wage-index file for this CCN/FY is not loaded. */
  readonly wageIndex: WageIndexSnapshot | null;

  readonly seams: SeamAvailabilityFlags;
}

// ── the rule definition ────────────────────────────────────────────────────────────────────────────────

/** A rule's tenant parameter overlay (mirrors `validation_rule_config.parameters`); opaque to the model. */
export type RuleParameters = Readonly<Record<string, unknown>>;

/**
 * A single platform-default / MAC-profile / tenant-custom validation rule (D1). `regulatoryRequired`
 * rules are the CFR-mandated floor (D5): tenants cannot disable them and an `error` failure is BLOCKING —
 * it cannot be skip-and-submit'd; only an elevated `overrideRoleRequired` approver can record an override
 * (§2.2). `check` is a DETERMINISTIC SYNCHRONOUS pure predicate over the injected `ValidationContext` and
 * the resolved `params` (the `defaultParameters` merged with the tenant overlay) — it never reads a
 * clock, file, or seam. It returns a `RuleResult` stamped with this rule's `key` + `severity` (use the
 * `pass` / `fail` / `skip` constructors below, which take both, to guarantee the stamp is consistent).
 */
export interface Rule {
  readonly key: string;
  /** Increments on rule revision (recorded into `validation_result.rule_version` for provenance). */
  readonly version: number;
  readonly category: RuleCategory;
  /** Worklist UI title. */
  readonly title: string;
  readonly description: string;
  readonly severity: RuleSeverity;
  readonly regulatoryRequired: boolean;
  readonly overrideRoleRequired?: OverrideRole;
  readonly defaultParameters?: RuleParameters;
  readonly check: (ctx: ValidationContext, params: RuleParameters) => RuleResult;
}

// ── pure result constructors (every rule file imports these) ───────────────────────────────────────────

/** A passing result for `ruleKey` at `severity`. */
export function pass(ruleKey: string, severity: RuleSeverity, message: string): RuleResult {
  return { ruleKey, severity, passed: true, message };
}

/** A failing result for `ruleKey` at `severity`, with optional remediation + observed aggregates. */
export function fail(
  ruleKey: string,
  severity: RuleSeverity,
  message: string,
  remediation?: RuleRemediation,
  observed?: RuleObserved,
): RuleResult {
  const annotations: RuleAnnotations | undefined =
    remediation || observed
      ? {
          ...(remediation ? { remediation } : {}),
          ...(observed ? { observed } : {}),
        }
      : undefined;
  return {
    ruleKey,
    severity,
    passed: false,
    message,
    ...(annotations ? { annotations } : {}),
  };
}

/**
 * A SKIP result — the rule is non-blocking because its forward seam is unbound (`seam_not_bound`, the
 * D8/D13 deny-stub) or it does not apply to this claim (`not_applicable`). A skip carries `passed: true`
 * (it never contributes to the blocking set) and records the reason for the worklist's "pending" badge.
 */
export function skip(
  ruleKey: string,
  severity: RuleSeverity,
  reason: RuleSkipReason,
  message: string,
): RuleResult {
  return { ruleKey, severity, passed: true, message, annotations: { skipReason: reason } };
}

// ── pure context helpers (shared by the rule fan-out) ──────────────────────────────────────────────────

/** True iff `code` is a member of `valueSetId` in the resolved terminology (as-of `ctx.asOfDate`). */
export function isMemberOf(
  terminology: TerminologyResolution,
  valueSetId: string,
  code: string,
): boolean {
  const members = terminology.valueSetMembership[valueSetId];
  return members?.includes(code) ?? false;
}

/** True iff a result represents a skip (non-blocking deny-stub / not-applicable). */
export function isSkipped(result: RuleResult): boolean {
  return result.annotations?.skipReason !== undefined;
}
