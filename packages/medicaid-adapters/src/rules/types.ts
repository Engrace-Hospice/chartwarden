// @wardenx/medicaid-adapters — M24 §4.6 / §11.A (M23-shared) validation RULE MODEL (D10). KEY DEVIATION
// FROM THE SPEC PROPOSAL (architecture wins — the M23 `billing/rules/types.ts` precedent): spec §4.6's
// `MedicaidValidationContext` embeds the live reader seams and `check()` is async. The WardenX pure-domain
// convention is a SYNCHRONOUS PURE `check()` over an INJECTED, already-resolved, plain-data context — the
// Phase-3 validation SERVICE walks every reader seam once, materializes this aggregate snapshot, then runs
// the rules. Deterministic, clock-free, unit-testable with a plain object; all I/O at the service boundary.
//
// The result MODEL (RuleResult + pass/fail/skip constructors + severities) is REUSED from @wardenx/billing
// so M23 (Medicare) and M24 (Medicaid) share one rule-result vocabulary (D10). M24 adds its own aggregate
// CONTEXT (Medicaid-specific facts) and the `applicableStates` gate. PURE DOMAIN: types/pure fns, no PHI,
// never the Recipient ID (D12 / §3.6).
import { fail, isSkipped, pass, skip } from "@wardenx/billing";
import type {
  RuleParameters,
  RuleRemediation,
  RuleResult,
  RuleSeverity,
  RuleSkipReason,
} from "@wardenx/billing";
import type {
  Cents,
  EvvBracketState,
  IsoDate,
  IsoDateTime,
  McoId,
  MedicaidChannel,
  MedicaidClaimId,
  MedicaidClaimKind,
  MedicaidClaimLineId,
  MedicaidEligibilityOutcome,
  MedicaidLevelOfCare,
  MedicaidTob,
  OrgId,
  PatientId,
  ProviderEntityId,
  RbArrangementId,
  RbArrangementState,
  RbDayStatus,
  StateCode,
} from "../contracts";

export { fail, isSkipped, pass, skip };
export type { RuleParameters, RuleRemediation, RuleResult, RuleSeverity, RuleSkipReason };

/** The §4.6 Medicaid rule category — the validation-worklist UI grouping. */
export type MedicaidRuleCategory =
  | "eligibility"
  | "mco"
  | "rb"
  | "cob"
  | "rate"
  | "modifiers"
  | "documentation"
  | "evv"
  | "cap";

// ── aggregate snapshot DTOs (plain data; ids + facts only; PHI-free, D12/§3.6) ─────────────────────────

export interface MedicaidClaimSnapshot {
  readonly claimId: MedicaidClaimId;
  readonly providerEntityId: ProviderEntityId;
  readonly patientId: PatientId;
  readonly serviceState: StateCode;
  readonly kind: MedicaidClaimKind;
  readonly tob: MedicaidTob;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  readonly replacesClaimId: MedicaidClaimId | null;
  /** Set on dual-eligible claims — the M23 Medicare-primary claim (COB). */
  readonly medicareClaimId: string | null;
  readonly rbArrangementId: RbArrangementId | null;
  /** Whether the patient has both Medicare Part A and Medicaid on the service-date payer period. */
  readonly isDualEligible: boolean;
}

export interface MedicaidClaimLineSnapshot {
  readonly claimLineId: MedicaidClaimLineId;
  readonly serviceDate: IsoDate;
  readonly levelOfCare: MedicaidLevelOfCare;
  readonly revenueCode: string;
  readonly qCode: string | null;
  readonly modifiers: readonly string[];
  readonly rateAtAssemblyCents: Cents;
  readonly isRb: boolean;
  readonly backingEncounterIds: readonly string[];
}

/** Most-recent eligibility check for the patient as-of service-from; `ageDays` precomputed (clock-free). */
export interface MedicaidEligibilitySnapshot {
  readonly outcome: MedicaidEligibilityOutcome;
  readonly checkedAt: IsoDateTime;
  readonly asOfDate: IsoDate;
  readonly ageDays: number;
  readonly mcoId: McoId | null;
}

/** MCO routing resolution (M40 `state_medicaid_mco` + credential availability). */
export interface McoRoutingSnapshot {
  readonly eligibilityIsMcoAssignment: boolean;
  /** Channel resolved from M40 `state_medicaid_mco.routing_channel` for the patient's MCO. */
  readonly resolvedChannel: MedicaidChannel | null;
  /** Whether an ACTIVE trading-partner credential exists for that channel on the service date. */
  readonly hasActiveCredentialForChannel: boolean;
}

/** A service date in the claim range with NF-residence + LOC-of-day facts (M5 residence + M6 LOC). */
export interface NfResidentDaySnapshot {
  readonly serviceDate: IsoDate;
  readonly isNfResident: boolean;
  readonly locOfDay: MedicaidLevelOfCare;
}

/** The R&B arrangement fact for the claim (M24 internal). */
export interface RbArrangementFactSnapshot {
  readonly arrangementId: RbArrangementId;
  readonly state: RbArrangementState;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
}

/** One R&B day backing an R&B line (status + LOC-of-day + arrangement-effective fact). */
export interface RbDayFactSnapshot {
  readonly serviceDate: IsoDate;
  readonly locOfDay: MedicaidLevelOfCare;
  readonly status: RbDayStatus;
  /** Whether the rb_arrangement is ACTIVE and effective on this service date. */
  readonly arrangementEffectiveOnDate: boolean;
}

/** Per-line rate-schedule lookup result (M40 `state_rate_schedule`). */
export interface RateLookupSnapshot {
  readonly serviceDate: IsoDate;
  readonly loc: MedicaidLevelOfCare;
  readonly rateFound: boolean;
  readonly rateCents: Cents | null;
}

export interface EvvBracketSnapshot {
  readonly encounterId: string;
  readonly bracketState: EvvBracketState;
}

/** Medicare-primary COB read-back (M23 ClaimReader.medicareSecondaryContext). */
export interface MedicareSecondarySnapshot {
  /** The M23 claim state (e.g. 'ack_accepted', 'paid') — null when the claim is not yet resolvable. */
  readonly medicareClaimState: string | null;
  readonly eobContextPresent: boolean;
}

export interface MedicaidCapProjectionSnapshot {
  readonly patientWithinCap: boolean;
}

/** The resolved adapter's declarative metadata (gates EVV + combined-claim behavior, §4.5). */
export interface AdapterMetadataSnapshot {
  readonly acceptsDocumentedMissingEvv: boolean;
  readonly combinesHospiceAndRb: boolean;
  readonly supportedTobs: readonly string[];
}

/** Which forward seams are bound; an unbound seam makes its dependent rule SKIP `seam_not_bound`. */
export interface MedicaidSeamFlags {
  readonly eligibilityBound: boolean;
  readonly rbBound: boolean;
  readonly rateScheduleBound: boolean;
  readonly medicareClaimBound: boolean;
  readonly capProjectionBound: boolean;
  readonly mdmBound: boolean;
  readonly adapterBound: boolean;
}

/**
 * The injected, aggregate, plain-data, PHI-free snapshot every Medicaid rule evaluates against. Built by
 * the Phase-3 validation service walking each reader seam once; rules are pure functions of this value.
 */
export interface MedicaidValidationContext {
  readonly orgId: OrgId;
  readonly asOfDate: IsoDate;
  readonly serviceState: StateCode;

  readonly claim: MedicaidClaimSnapshot;
  readonly lines: readonly MedicaidClaimLineSnapshot[];

  readonly eligibility: MedicaidEligibilitySnapshot | null;
  /** Adapter-driven recipient-ID format validity (computed at service layer); null when unknown/unbound. */
  readonly recipientIdFormatValid: boolean | null;
  readonly mcoRouting: McoRoutingSnapshot | null;
  readonly nfResidentDays: readonly NfResidentDaySnapshot[];
  readonly rbArrangement: RbArrangementFactSnapshot | null;
  readonly rbDays: readonly RbDayFactSnapshot[];
  readonly rateLookups: readonly RateLookupSnapshot[];
  readonly medicareSecondary: MedicareSecondarySnapshot | null;
  readonly evvBrackets: readonly EvvBracketSnapshot[];
  readonly capProjection: MedicaidCapProjectionSnapshot | null;
  /** Adapter-driven state-specific modifier satisfaction; null when not applicable/unbound. */
  readonly modifiersSatisfied: boolean | null;
  /** Adapter-driven state-specific documentation satisfaction; null when not applicable/unbound. */
  readonly documentationSatisfied: boolean | null;

  readonly adapterMetadata: AdapterMetadataSnapshot;
  readonly seams: MedicaidSeamFlags;
}

// ── the rule definition ────────────────────────────────────────────────────────────────────────────────

/** The override role a regulatory-required rule's blocking failure needs (M23-shared vocabulary). */
export type MedicaidOverrideRole = "billing_manager" | "compliance_officer" | "medical_director" | "org_admin";

/**
 * A single Medicaid validation rule (D10). `check` is a DETERMINISTIC SYNCHRONOUS pure predicate over the
 * injected context + resolved params. `applicableStates` empty ⇒ all states; otherwise the executor SKIPs
 * `not_applicable` when `claim.serviceState ∉ applicableStates`.
 */
export interface MedicaidRule {
  readonly key: string;
  readonly version: number;
  readonly category: MedicaidRuleCategory;
  readonly title: string;
  readonly description: string;
  readonly severity: RuleSeverity;
  readonly regulatoryRequired: boolean;
  readonly overrideRoleRequired?: MedicaidOverrideRole;
  readonly defaultParameters?: RuleParameters;
  /** Empty array = applicable to all states. */
  readonly applicableStates: readonly StateCode[];
  readonly check: (ctx: MedicaidValidationContext, params: RuleParameters) => RuleResult;
}
