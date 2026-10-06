// apps/backend/src/modules/23-billing-medicare/routes/read-service.ts — the M23 READ route-service
// CONTRACT (§4.1 GET surface) + the deliberately-narrowed read DTOs the route plugins return.
//
// Mirrors the M27 read-service.ts precedent: one interface the route handlers compose over, plus the view
// types it projects to. The Drizzle backend (./read-service-drizzle) implements this; the route/worker
// agents match these signatures exactly. M23 carries NO PHI and NEVER the MBI digit (D13 / §3.6 / §8.7);
// money is INTEGER CENTS (D8). Enum case is mapped at the repository boundary — every DTO here speaks the
// lowercase domain alphabet (`ClaimState` / `NoticeState` / `LevelOfCare` / `EligibilityOutcome`).
//
// DTO discipline: the cipher column (`mac_submitter_credential.client_secret_cipher`) is NEVER projected —
// the MAC-credential view carries only the safe identifiers + a `hasSecret` flag. The HETS `parsed_payload`
// carries coverage flags only (the service guarantees it holds no MBI digit). The MBI is never a field.
import type {
  ArAgingDto,
  ClaimState,
  EligibilityOutcome,
  LevelOfCare,
  MetricsBucket,
  NoticeState,
  TypeOfBill,
} from "@wardenx/billing";
import type { ClaimAttentionFlag, ClaimAttentionView } from "../services/claim-attention";
import {
  type StoredRhcCarryOverContext,
  normalizeStoredRhcCarryOver,
} from "../services/rhc-carry-over-stored";
import type { RhcCarryOverView } from "../services/rhc-carry-over-view";
import type { M23ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

type Json = Readonly<Record<string, unknown>>;

// ── shared value types ────────────────────────────────────────────────────────────────────────────────

export type ValidationRunTrigger =
  | "initial_assembly"
  | "pre_submission"
  | "re_validation_after_correction"
  | "re_validation_after_override"
  | "manual_re_run";
export type ValidationRunOutcome =
  | "all_pass"
  | "failures_present"
  | "overrides_required"
  | "ready_for_submission";
export type ValidationResultOutcome = "pass" | "fail" | "warn" | "info";
export type ValidationSeverity = "error" | "warn" | "info";
export type OverrideRole =
  | "billing_manager"
  | "compliance_officer"
  | "medical_director"
  | "org_admin";
export type ClaimSubmissionKind = "claim_837i" | "noe" | "notr" | "transfer_notice";
export type ClaimSubmissionOutcome =
  | "queued"
  | "generated"
  | "submitted"
  | "failed_worker"
  | "failed_portal";
export type ClaimAcknowledgmentKind = "ack_999" | "ack_277ca" | "ack_835";
export type NotrTriggerKind = "revocation" | "transfer_out" | "discharge";

// ── claim view DTOs ───────────────────────────────────────────────────────────────────────────────────

export interface ClaimSummaryView {
  readonly claimId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly tob: TypeOfBill;
  readonly state: ClaimState;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly claimControlNumber: string;
  readonly payerClaimControlNumber: string | null;
  readonly macJurisdiction: string;
  readonly totalChargeCents: number;
  readonly totalExpectedPaymentCents: number;
  readonly version: number;
  /**
   * What the biller must do because of how the stay ended (missing place of death / receiving care setting, a
   * Type of Bill the resolver now derives differently), from M6's CURRENT facts. Present on the list and detail
   * reads when the stay-end facts port is bound; absent/`null` otherwise.
   */
  readonly attention?: ClaimAttentionView | null;
}

export interface ClaimPricingView {
  readonly hipps: {
    readonly hippsCode: string;
    readonly hippsRateCents: number;
    readonly wageIndexCcn: string;
    readonly wageIndexFiscalYear: number;
    readonly wageIndexFactor: string;
    readonly segments: unknown;
    readonly calculatedAt: string;
    /** ADR-0001 two-tier RHC day counts on this claim (days 1–60 high / 61+ low, cumulative across stays). */
    readonly rhcDays1to60: number;
    readonly rhcDays61Plus: number;
    /** The prior hospice days carried into the count, their source chain + basis; null on rows priced
     *  before migration 0376. */
    readonly rhcCarryOver: RhcCarryOverView | null;
  } | null;
  readonly sia: {
    readonly windowStart: string;
    readonly totalQualifyingMinutes: number;
    readonly siaAddOnCents: number;
    readonly calculatedAt: string;
  } | null;
}

/**
 * The claim's discharge-driven codes: UB-04 FL 17 patient status (837I CL103; `null` = could not be derived,
 * the discharge rule blocks the claim), FL 18-28 condition codes (HI*BG) and FL 31-34 occurrence codes with
 * dates (HI*BH).
 */
export interface ClaimDischargeCodesView {
  readonly patientStatusCode: string | null;
  readonly conditionCodes: readonly string[];
  readonly occurrenceCodes: readonly { readonly code: string; readonly date: string }[];
}

/** Project a persisted `hipps_calculation` row onto the claim detail's `pricing.hipps` (read + write paths). The
 *  stored carry-over is an append-only snapshot: older span labels are mapped to today's at read time
 *  (`normalizeStoredRhcCarryOver`), never rewritten. */
export function hippsPricingView(
  row: {
    readonly hippsCode: string;
    readonly hippsRateCents: number;
    readonly wageIndexCcn: string;
    readonly wageIndexFiscalYear: number;
    readonly wageIndexFactor: string;
    readonly segments: unknown;
    readonly calculatedAt: Date;
    readonly rhcDays1to60: number;
    readonly rhcDays61Plus: number;
    readonly rhcCarryOver?: unknown;
  },
  claim: StoredRhcCarryOverContext,
): NonNullable<ClaimPricingView["hipps"]> {
  return {
    hippsCode: row.hippsCode,
    hippsRateCents: row.hippsRateCents,
    wageIndexCcn: row.wageIndexCcn,
    wageIndexFiscalYear: row.wageIndexFiscalYear,
    wageIndexFactor: row.wageIndexFactor,
    segments: row.segments,
    calculatedAt: row.calculatedAt.toISOString(),
    rhcDays1to60: row.rhcDays1to60,
    rhcDays61Plus: row.rhcDays61Plus,
    rhcCarryOver: normalizeStoredRhcCarryOver(row.rhcCarryOver, claim),
  };
}

/** Project the persisted `claim` code columns (jsonb, defensively narrowed) onto the view. */
export function claimDischargeCodesView(row: {
  readonly patientStatusCode: string | null;
  readonly conditionCodes: unknown;
  readonly occurrenceCodes: unknown;
}): ClaimDischargeCodesView {
  const conditionCodes = Array.isArray(row.conditionCodes)
    ? row.conditionCodes.filter((c): c is string => typeof c === "string")
    : [];
  const occurrenceCodes = Array.isArray(row.occurrenceCodes)
    ? row.occurrenceCodes.flatMap((o: unknown) =>
        o !== null &&
        typeof o === "object" &&
        typeof (o as { code?: unknown }).code === "string" &&
        typeof (o as { date?: unknown }).date === "string"
          ? [{ code: (o as { code: string }).code, date: (o as { date: string }).date }]
          : [],
      )
    : [];
  return { patientStatusCode: row.patientStatusCode ?? null, conditionCodes, occurrenceCodes };
}

export interface ClaimDetailView extends ClaimSummaryView {
  readonly electionPeriodIdFrom: string;
  readonly electionPeriodIdTo: string;
  readonly patientPayerId: string;
  readonly sequestrationAppliedPct: string;
  readonly sequestrationPolicyId: string;
  readonly replacesClaimId: string | null;
  readonly replacedByClaimId: string | null;
  readonly replacementReason: string | null;
  readonly latestValidationRunId: string | null;
  readonly latestSubmissionId: string | null;
  readonly acknowledgmentDocumentId: string | null;
  /** The discharge claim codes (CMS Pub. 100-04 Ch. 11 §30.3) as persisted at assembly / re-validation. */
  readonly dischargeCodes: ClaimDischargeCodesView;
  readonly latestValidation: ValidationRunView | null;
  readonly pricing: ClaimPricingView;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimLineView {
  readonly claimLineId: string;
  readonly claimId: string;
  readonly lineNumber: number;
  readonly revenueCode: string;
  readonly qCode: string;
  readonly levelOfCare: LevelOfCare;
  readonly hcpcsCode: string | null;
  readonly serviceDateFrom: string;
  readonly serviceDateTo: string;
  readonly unitCount: number;
  readonly unitRateCents: number;
  readonly lineChargeCents: number;
  readonly levelOfCarePeriodId: string;
  readonly modifiers: readonly string[];
  readonly icdPointerPositions: readonly number[];
  readonly backingEncounterIds: readonly string[];
}

export interface ClaimStateHistoryView {
  readonly historyId: string;
  readonly claimId: string;
  readonly fromState: ClaimState | null;
  readonly toState: ClaimState;
  readonly at: string;
  readonly actorMembershipId: string | null;
  readonly actorKind: string;
  readonly reason: string | null;
  readonly validationRunId: string | null;
  readonly submissionId: string | null;
  readonly acknowledgmentId: string | null;
  readonly remittanceAdviceId: string | null;
}

export interface ClaimSubmissionView {
  readonly submissionId: string;
  readonly providerEntityId: string;
  readonly kind: ClaimSubmissionKind;
  readonly claimId: string | null;
  readonly noeId: string | null;
  readonly notrId: string | null;
  readonly transferNoticeId: string | null;
  readonly claimControlNumber: string;
  readonly attemptIndex: number;
  readonly outcome: ClaimSubmissionOutcome;
  readonly outcomeReason: string | null;
  readonly generatedFileUri: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}

export interface ClaimAcknowledgmentView {
  readonly acknowledgmentId: string;
  readonly submissionId: string;
  readonly claimId: string | null;
  readonly kind: ClaimAcknowledgmentKind;
  readonly macJurisdiction: string;
  readonly ackReceivedAt: string;
  readonly parsedAt: string;
  readonly outcomeStatus: string;
  /** X12 status/reason codes only — never PHI/MBI (§8.7). */
  readonly parsedPayload: Json;
  readonly createdAt: string;
}

// ── validation view DTOs ──────────────────────────────────────────────────────────────────────────────

export interface ValidationRunView {
  readonly validationRunId: string;
  readonly claimId: string;
  readonly trigger: ValidationRunTrigger;
  readonly outcome: ValidationRunOutcome;
  readonly rulesExecuted: number;
  readonly rulesPassed: number;
  readonly rulesFailed: number;
  readonly rulesWarn: number;
  readonly rulesInfo: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly initiatedByMembershipId: string | null;
}

export interface ValidationResultView {
  readonly resultId: string;
  readonly validationRunId: string;
  readonly ruleKey: string;
  readonly ruleVersion: number;
  readonly severity: ValidationSeverity;
  readonly outcome: ValidationResultOutcome;
  readonly remediation: Json;
  readonly overridden: boolean;
  readonly override: ValidationOverrideView | null;
  readonly recordedAt: string;
}

export interface ValidationRunDetailView extends ValidationRunView {
  readonly results: readonly ValidationResultView[];
}

export interface ValidationOverrideView {
  readonly overrideId: string;
  readonly resultId: string;
  readonly overrideMembershipId: string;
  readonly overrideRoleApplied: OverrideRole;
  readonly reason: string;
  readonly appliedAt: string;
}

// ── NOE / NOTR view DTOs ──────────────────────────────────────────────────────────────────────────────

/** The MAC's answer on a NOE / NOTR (migration 0377). Reason codes are PHI-free X12 codes. */
export interface NoticeAckOutcomeView {
  /** When the 277CA accepted the notice (the NOE timeliness / occurrence-span-77 acceptance date). */
  readonly acceptedAt: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionStage: "999" | "277ca" | null;
  readonly rejectionCodes: readonly string[];
}

export interface NoeView extends NoticeAckOutcomeView {
  readonly noeId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly electionPeriodId: string;
  readonly state: NoticeState;
  readonly electionEffectiveDate: string;
  readonly windowTargetAt: string;
  readonly windowBreachedAt: string | null;
  readonly noeControlNumber: string;
  readonly payerNoeControlNumber: string | null;
  readonly latestSubmissionId: string | null;
  readonly latestAcknowledgmentId: string | null;
  readonly confirmationDocumentId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotrView extends NoticeAckOutcomeView {
  readonly notrId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly triggerKind: NotrTriggerKind;
  readonly revocationEventId: string | null;
  readonly transferEventId: string | null;
  readonly dischargeEventId: string | null;
  readonly effectiveEndDate: string;
  readonly windowTargetAt: string;
  readonly windowBreachedAt: string | null;
  readonly state: NoticeState;
  readonly notrControlNumber: string;
  readonly payerNotrControlNumber: string | null;
  readonly latestSubmissionId: string | null;
  readonly latestAcknowledgmentId: string | null;
  readonly confirmationDocumentId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── eligibility / rule-config / reference-data view DTOs ──────────────────────────────────────────────

export interface EligibilityCheckView {
  readonly checkId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly asOfServiceDate: string;
  readonly outcome: EligibilityOutcome;
  /** Coverage flags only — guaranteed by the service to hold no MBI digit (§3.6 / §8.7). */
  readonly parsedPayload: Json;
  readonly checkedAt: string;
  readonly staleAt: string;
}

/** One hospice election (NOE) or billed benefit period from the latest HETS 271 (CG §7.16). No MBI. */
export interface HospicePeriodView {
  readonly kind: "election" | "benefit_period";
  /** Lifetime benefit-period ordinal (oldest = 1); null for NOE rows or when HETS history is not complete. */
  readonly periodNumber: number | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly hospiceNpi: string | null;
  readonly revocationOrDischargeDate: string | null;
  /** HETS revocation code: 0 open spell, 1 NOTR, 2 NOTR + occurrence 42, 3 claim occurrence 23. */
  readonly revocationCode: "0" | "1" | "2" | "3" | null;
  readonly daysUsed: number | null;
}

/** Why `nextPeriodNumber` is (or is not) known — see `deriveHospiceHistory` in `@wardenx/x12-837-client`. */
export type NextPeriodBasis =
  | "computed"
  | "election_open"
  | "election_status_uncertain"
  | "unbilled_election"
  | "history_truncated";

/**
 * `GET /billing/eligibility/hospice-periods` — the beneficiary's cross-hospice hospice history from the latest
 * RESOLVED HETS check (the readmission screen's benefit-period confirmation). `status`:
 *   - `available`           a resolved (Part A active/inactive) check is on file — the fields below are its;
 *   - `no_check_on_file`    HETS is configured but no resolved check exists yet (see `lastAttempt`);
 *   - `hets_not_configured` no resolved check AND this deployment has no HETS transport bound.
 */
export interface HospicePeriodsView {
  readonly status: "available" | "no_check_on_file" | "hets_not_configured";
  readonly hetsConfigured: boolean;
  readonly patientId: string;
  readonly checkId: string | null;
  readonly asOfServiceDate: string | null;
  readonly outcome: EligibilityOutcome | null;
  readonly checkedAt: string | null;
  readonly staleAt: string | null;
  /** `staleAt` has passed (the 30-day freshness window lapsed). null when no check. */
  readonly stale: boolean | null;
  /** The check came from the dev/test SANDBOX transport — synthetic, never real CMS data. */
  readonly synthetic: boolean;
  /** HETS returned a hospice section on the check (false for checks recorded before hospice parsing). */
  readonly hospiceHistoryReturned: boolean;
  /** true = an open election (Medicare rejects a new NOE); false = none open; null = not determinable. */
  readonly hospiceElectionOpen: boolean | null;
  readonly hospiceHistoryTruncated: boolean | null;
  readonly hospicePeriods: readonly HospicePeriodView[];
  /** The benefit period a new election on the check's as-of date would start, or null (see `nextPeriodBasis`). */
  readonly nextPeriodNumber: number | null;
  readonly nextPeriodBasis: NextPeriodBasis | null;
  /** The most recent attempt when it is newer than the resolved check (e.g. a later HETS error). */
  readonly lastAttempt: {
    readonly checkId: string;
    readonly outcome: EligibilityOutcome;
    readonly checkedAt: string;
    readonly reason: string | null;
  } | null;
  /**
   * The two-tier RHC carry-over a new election on the requested `electionDate` would start with: this patient's
   * earlier stays with us merged with the HETS history above (`computeRhcCarryOver`). null when no
   * `electionDate` was asked for.
   */
  readonly rhcCarryOver: RhcCarryOverView | null;
}

export interface RuleConfigView {
  readonly ruleConfigId: string;
  readonly organizationId: string;
  readonly ruleKey: string;
  readonly ruleVersion: number;
  readonly isCustom: boolean;
  readonly enabled: boolean;
  readonly severity: ValidationSeverity;
  readonly overrideRoleRequired: OverrideRole | null;
  readonly parameters: Json;
  readonly regulatoryRequiredSnapshot: boolean;
  readonly predicateDsl: unknown;
  readonly setByMembershipId: string;
  readonly setReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MacCredentialView {
  readonly credentialId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly macJurisdiction: string;
  readonly submitterId: string;
  readonly tradingPartnerId: string;
  readonly clientId: string;
  /** The cipher is NEVER projected — only its presence is signaled (§3.6). */
  readonly hasSecret: boolean;
  readonly baaRecordRef: string | null;
  readonly credentialExpiresAt: string | null;
  readonly lastSandboxTestAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────

export interface ClaimListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly state?: ClaimState;
  /**
   * Only claims carrying this attention flag (`missing_discharge_details` / `tob_changed`). Computed from M6's
   * live stay-end facts, so the read SCANS pages (bounded) rather than filtering in SQL — see the Drizzle read.
   */
  readonly attention?: ClaimAttentionFlag;
  /**
   * SERVER-DERIVED provider-entity restriction (authorization, never a query param). `undefined` =
   * unrestricted (org-wide billing role / system principal); `[]` = the actor has no provider scope and
   * therefore sees no claims. See {@link resolveClaimProviderScope} in claims.routes.ts.
   */
  readonly providerEntityScope?: readonly string[];
}
export interface NoeListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly state?: NoticeState;
}
export interface NotrListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly triggerKind?: NotrTriggerKind;
  readonly state?: NoticeState;
}
export interface RuleConfigListFilter {
  readonly enabled?: boolean;
  readonly isCustom?: boolean;
}
export interface MetricsFilter {
  readonly providerEntityId?: string;
}

// ── the read service ──────────────────────────────────────────────────────────────────────────────────

/**
 * The M23 READ route-service contract — every GET in §4.1. Each method takes the server-assembled
 * {@link M23ReadActor}; the Drizzle backend opens one `withOrgContext` tx per call so Postgres RLS scopes
 * every statement to `app.org_id`. The route plugins gate each method on the §4.6 permission + §4.7 ABAC
 * predicate BEFORE the call reaches here — this layer assumes an authorized, org-bound actor and never
 * re-derives the org from anything but `actor.organizationId`.
 */
export interface M23ReadRouteService {
  // ── claims ──
  listClaims(
    actor: M23ReadActor,
    filter: ClaimListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ClaimSummaryView>>;
  getClaim(actor: M23ReadActor, claimId: string): Promise<ClaimDetailView>;
  listClaimLines(actor: M23ReadActor, claimId: string): Promise<readonly ClaimLineView[]>;
  listClaimStateHistory(
    actor: M23ReadActor,
    claimId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ClaimStateHistoryView>>;
  listClaimSubmissions(
    actor: M23ReadActor,
    claimId: string,
  ): Promise<readonly ClaimSubmissionView[]>;
  listClaimAcknowledgments(
    actor: M23ReadActor,
    claimId: string,
  ): Promise<readonly ClaimAcknowledgmentView[]>;

  // ── validations ──
  listValidationRuns(actor: M23ReadActor, claimId: string): Promise<readonly ValidationRunView[]>;
  getValidationRun(
    actor: M23ReadActor,
    claimId: string,
    validationRunId: string,
  ): Promise<ValidationRunDetailView>;

  // ── NOE / NOTR ──
  listNoes(
    actor: M23ReadActor,
    filter: NoeListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<NoeView>>;
  getNoe(actor: M23ReadActor, noeId: string): Promise<NoeView>;
  listNotrs(
    actor: M23ReadActor,
    filter: NotrListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<NotrView>>;
  getNotr(actor: M23ReadActor, notrId: string): Promise<NotrView>;

  // ── eligibility ──
  listEligibilityChecks(
    actor: M23ReadActor,
    patientId: string,
  ): Promise<readonly EligibilityCheckView[]>;
  getLatestEligibility(
    actor: M23ReadActor,
    patientId: string,
  ): Promise<EligibilityCheckView | null>;
  getHospicePeriods(
    actor: M23ReadActor,
    patientId: string,
    /** When given, the view carries the RHC carry-over for a new election on this date. */
    electionDate?: string,
  ): Promise<HospicePeriodsView>;

  // ── rule-config library ──
  listRuleConfigs(
    actor: M23ReadActor,
    filter: RuleConfigListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<RuleConfigView>>;
  getRuleConfig(actor: M23ReadActor, ruleConfigId: string): Promise<RuleConfigView>;

  // (sequestration policy reads moved to `SequestrationPolicyRouteService`, F-212)

  // ── MAC credentials (cipher never projected) ──
  listMacCredentials(
    actor: M23ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<MacCredentialView>>;
  getMacCredential(
    actor: M23ReadActor,
    providerEntityId: string,
  ): Promise<MacCredentialView | null>;

  // ── AR / metrics ──
  getClaimMetrics(actor: M23ReadActor, filter: MetricsFilter): Promise<readonly MetricsBucket[]>;
  getArAging(actor: M23ReadActor, filter: MetricsFilter): Promise<ArAgingDto>;
}
