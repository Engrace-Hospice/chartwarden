import type { MedicaidEraDuplicateDecision } from "./medicaid-era-duplicate-scan";
import type { MedicaidEraObservation } from "./medicaid-era-observation";

/** Server-owned source account facts. This must be loaded from authenticated account configuration. */
export interface MedicaidEraAccountEvidence {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly vendor: "claimmd" | "stedi";
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly canonicalPayerId: string;
  readonly programId: string;
  readonly acceptedPayerIdentifiers: readonly {
    readonly qualifier: string;
    readonly identifier: string;
  }[];
  readonly billingNpi: string;
  readonly billingTin: string | null;
  readonly enrollment: "verified_active" | "pending" | "expired" | "revoked" | "missing";
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly evidenceReference: string;
  readonly verifiedAt: string;
  readonly evidenceFreshUntil: string;
}

export interface AuthenticatedMedicaidEraSource {
  /** Supplied by the authenticated staging adapter, never by the ERA payload or a public request body. */
  readonly vendor: "claimmd" | "stedi";
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly artifactReference: string;
  readonly artifactDigest: string;
  readonly receivedAt: string;
}

export type MedicaidEraAttribution =
  | {
      readonly status: "verified";
      readonly organizationId: string;
      readonly providerEntityId: string;
      readonly vendor: "claimmd" | "stedi";
      readonly accountReference: string;
      readonly usage: "test" | "production";
      readonly canonicalPayerId: string;
      readonly programId: string;
      readonly evidenceReference: string;
      readonly artifactReference: string;
      readonly artifactDigest: string;
    }
  | { readonly status: "held"; readonly reason: HeldAttributionReason };

type HeldAttributionReason =
  | "SOURCE_ACCOUNT_UNREGISTERED"
  | "SOURCE_ACCOUNT_AMBIGUOUS"
  | "SOURCE_ACCOUNT_CONFLICT"
  | "PAYER_IDENTITY_UNVERIFIED"
  | "PAYEE_IDENTITY_CONFLICT"
  | "ENROLLMENT_NOT_ACTIVE"
  | "SOURCE_EVIDENCE_STALE";

const digits = (value: string | null | undefined): string => (value ?? "").replace(/\D/g, "");

/** The payee NPI the ERA names (qualifier XX), digits only; empty when the payee is identified another way. */
const payeeNpiOf = (observation: MedicaidEraObservation): string =>
  observation.source.payee.identifierQualifier === "XX"
    ? digits(observation.source.payee.identifier)
    : "";

/**
 * True when the ERA names a payee NPI that is the billing NPI of some `hidden` account (one the caller may not see) and
 * of none of the `visible` ones. Such an ERA is addressed to someone else, so the caller must not be told anything about
 * it, not even a hold reason: a payee conflict for a sibling entity's ERA would confirm that the sibling exists.
 */
export function payeeOnlyMatchesHiddenAccounts(
  observation: MedicaidEraObservation,
  visible: readonly MedicaidEraAccountEvidence[],
  hidden: readonly MedicaidEraAccountEvidence[],
): boolean {
  const payeeNpi = payeeNpiOf(observation);
  const matches = (accounts: readonly MedicaidEraAccountEvidence[]) =>
    accounts.some((account) => digits(account.billingNpi) === payeeNpi);
  return payeeNpi !== "" && !matches(visible) && matches(hidden);
}

/** True only when the row's effective window demonstrably contains the date; a malformed window covers nothing. */
const windowCovers = (account: MedicaidEraAccountEvidence, date: string): boolean =>
  isIsoCalendarDate(date) &&
  isIsoCalendarDate(account.effectiveFrom) &&
  (account.effectiveTo === null || isIsoCalendarDate(account.effectiveTo)) &&
  account.effectiveFrom <= date &&
  (account.effectiveTo === null || account.effectiveTo >= date);

/**
 * One vendor account can serve several provider entities. The payee NPI the ERA names (against each entity's billing
 * NPI) is the only X12 fact that tells them apart. Several rows with that NPI are either different entities or one
 * entity's re-enrollment history; the row whose effective window covers the receipt date is the one that speaks for the
 * artifact, and the account stays ambiguous unless exactly one does.
 */
function selectSourceAccount(
  candidates: readonly MedicaidEraAccountEvidence[],
  payeeNpi: string,
  receivedDate: string,
): { readonly account: MedicaidEraAccountEvidence } | { readonly reason: HeldAttributionReason } {
  if (candidates.length === 1) return { account: candidates[0]! };
  if (!payeeNpi) return { reason: "SOURCE_ACCOUNT_AMBIGUOUS" };
  const byPayee = candidates.filter((candidate) => digits(candidate.billingNpi) === payeeNpi);
  if (byPayee.length === 0) return { reason: "PAYEE_IDENTITY_CONFLICT" };
  if (byPayee.length === 1) return { account: byPayee[0]! };
  const covering = byPayee.filter((candidate) => windowCovers(candidate, receivedDate));
  return covering.length === 1 ? { account: covering[0]! } : { reason: "SOURCE_ACCOUNT_AMBIGUOUS" };
}

/**
 * Resolve attribution from authenticated account context plus effective, verified enrollment evidence.
 *
 * Attribution is point-in-time: every date and freshness test compares against the artifact's authenticated `receivedAt`,
 * not against now. Evidence that merely LAPSED after receipt (`effectiveTo` or `evidenceFreshUntil` passed since) still
 * attributes the artifact, so a late recoupment stays reviewable.
 *
 * The guard against an account that was re-pointed afterwards is `verifiedAt <= receivedAt`, and it is coarser than that
 * intent: `verifiedAt` is one instant per row, with no first-verified instant beside it. A row that is re-verified IN PLACE
 * (its `verifiedAt` rewritten to the latest check) therefore holds EVERY artifact received before that re-verification as
 * SOURCE_EVIDENCE_STALE; fail-closed, and the cost of a routine re-verification is that older artifacts stop attributing.
 * They attribute again only against an evidence row that was verified at or before their receipt, i.e. history kept as
 * appended rows (picked by effective window, see `selectSourceAccount`). `enrollment` is the row's current status, so a
 * since-revoked enrollment still holds.
 */
export function resolveMedicaidEraAttribution(input: {
  readonly source: AuthenticatedMedicaidEraSource;
  readonly observation: MedicaidEraObservation;
  readonly accounts: readonly MedicaidEraAccountEvidence[];
}): MedicaidEraAttribution {
  const candidates = input.accounts.filter(
    (account) =>
      account.vendor === input.source.vendor &&
      account.accountReference === input.source.accountReference &&
      account.usage === input.source.usage,
  );
  if (candidates.length === 0) return { status: "held", reason: "SOURCE_ACCOUNT_UNREGISTERED" };
  const payeeNpi = payeeNpiOf(input.observation);
  const date = input.source.receivedAt.slice(0, 10);
  const selected = selectSourceAccount(candidates, payeeNpi, date);
  if ("reason" in selected) return { status: "held", reason: selected.reason };
  const account = selected.account;
  if (!Number.isFinite(Date.parse(input.source.receivedAt)))
    return { status: "held", reason: "SOURCE_EVIDENCE_STALE" };
  if (
    !isIsoCalendarDate(date) ||
    !isIsoCalendarDate(account.effectiveFrom) ||
    (account.effectiveTo !== null && !isIsoCalendarDate(account.effectiveTo))
  )
    return { status: "held", reason: "SOURCE_EVIDENCE_STALE" };
  if (
    account.enrollment !== "verified_active" ||
    account.effectiveFrom > date ||
    (account.effectiveTo !== null && account.effectiveTo < date)
  )
    return { status: "held", reason: "ENROLLMENT_NOT_ACTIVE" };
  if (
    !Number.isFinite(Date.parse(account.verifiedAt)) ||
    !Number.isFinite(Date.parse(account.evidenceFreshUntil)) ||
    Date.parse(account.verifiedAt) > Date.parse(input.source.receivedAt) ||
    Date.parse(account.evidenceFreshUntil) < Date.parse(input.source.receivedAt)
  )
    return { status: "held", reason: "SOURCE_EVIDENCE_STALE" };
  if (
    !account.acceptedPayerIdentifiers.some(
      (accepted) =>
        accepted.qualifier === input.observation.source.payer.identifierQualifier &&
        accepted.identifier === input.observation.source.payer.identifier,
    )
  )
    return { status: "held", reason: "PAYER_IDENTITY_UNVERIFIED" };
  if (!/^[0-9a-f]{64}$/i.test(input.source.artifactDigest))
    return { status: "held", reason: "SOURCE_EVIDENCE_STALE" };
  const payeeTin =
    input.observation.source.payee.identifierQualifier === "FI"
      ? digits(input.observation.source.payee.identifier)
      : digits(input.observation.source.payee.taxIdentifier);
  if (!payeeNpi || payeeNpi !== digits(account.billingNpi))
    return { status: "held", reason: "PAYEE_IDENTITY_CONFLICT" };
  if (
    (payeeTin && (!account.billingTin || payeeTin !== digits(account.billingTin))) ||
    (account.billingTin && !payeeTin)
  )
    return { status: "held", reason: "PAYEE_IDENTITY_CONFLICT" };
  return {
    status: "verified",
    organizationId: account.organizationId,
    providerEntityId: account.providerEntityId,
    vendor: account.vendor,
    accountReference: account.accountReference,
    usage: account.usage,
    canonicalPayerId: account.canonicalPayerId,
    programId: account.programId,
    evidenceReference: account.evidenceReference,
    artifactReference: input.source.artifactReference,
    artifactDigest: input.source.artifactDigest,
  };
}

export interface MedicaidEraClaimCandidate {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly claimId: string;
  readonly canonicalPayerId: string | null;
  readonly programId: string | null;
  readonly claimControlNumber: string;
  readonly serviceFrom: string;
  readonly serviceTo: string | null;
  readonly claimVersion: number;
  readonly claimState: string;
  readonly replacementLineage: "original" | "replacement" | "void" | "unresolved";
  readonly submission: {
    readonly status: "verified_submitted" | "unverified" | "missing";
    readonly submissionId: string | null;
    readonly claimId: string | null;
    readonly claimVersion: number | null;
    readonly claimControlNumber: string | null;
    readonly payerClaimControlNumber: string | null;
    readonly vendor: string | null;
    readonly accountReference: string | null;
    readonly transactionReference: string | null;
  };
}

export type MedicaidEraMatchStatus =
  | "MATCHED"
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "PAYER_MISMATCH"
  | "PROVIDER_MISMATCH"
  | "SOURCE_ACCOUNT_MISMATCH"
  | "SUBMISSION_UNVERIFIED"
  | "CLAIM_VERSION_CONFLICT"
  | "CORRECTION_LINEAGE_UNRESOLVED"
  | "SERVICE_RANGE_CONFLICT"
  | "NEEDS_REVIEW";

export interface MedicaidEraMatchDecision {
  readonly status: MedicaidEraMatchStatus;
  readonly reasonCode: string;
  readonly claimId: string | null;
  readonly submissionId: string | null;
  readonly claimVersion: number | null;
}

/**
 * M24 claim states (`m24_claim_state`) in which an ERA can legitimately refer to the claim: it was sent (SUBMITTED, POLLING,
 * ACK_*) or the first remittance already moved it (PAID, DENIED). A reversal, recoupment or second ERA only ever arrives
 * after PAID/DENIED, so excluding them would make `reversal_or_recoupment_review` unreachable for its main scenario.
 * The read seam (`submissionEvidenceForLine`) is looser by design: it calls every state but REPLACED/VOIDED/ABANDONED
 * active; this layer additionally refuses the states below as "never submitted".
 */
const SUBMITTED_CLAIM_STATES: ReadonlySet<string> = new Set([
  "SUBMITTED",
  "POLLING",
  "ACK_PENDING",
  "ACK_TIMEOUT",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "ACK_PARTIAL",
  "PAID",
  "DENIED",
]);

/** Claim versions that are no longer the live one (the seam's `activeClaim` excludes the same three). */
const INACTIVE_CLAIM_STATES: ReadonlySet<string> = new Set(["VOIDED", "REPLACED", "ABANDONED"]);

/** Reason code for a REPLACED or VOIDED claim version (or a void lineage): superseded, not abandoned. */
const CLAIM_VERSION_NOT_ACTIVE = "CLAIM_VERSION_NOT_ACTIVE";

/** Exact control identity is only a candidate. Scope, payer, period, lineage and persisted send evidence are mandatory. */
export function matchMedicaidEraClaim(input: {
  readonly attribution: MedicaidEraAttribution;
  readonly patientControlNumber: string | null;
  readonly payerClaimControlNumber: string | null;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly candidates: readonly MedicaidEraClaimCandidate[];
}): MedicaidEraMatchDecision {
  if (input.attribution.status !== "verified")
    return {
      status: "NEEDS_REVIEW",
      reasonCode: input.attribution.reason,
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  const attribution = input.attribution;
  if (attribution.usage === "test")
    return {
      status: "SUBMISSION_UNVERIFIED",
      reasonCode: "TEST_ERA_CANNOT_MATCH_PRODUCTION_CLAIM",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  if (!input.patientControlNumber)
    return {
      status: "UNMATCHED",
      reasonCode: "CLAIM_CONTROL_MISSING",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  const keyed = input.candidates.filter(
    (candidate) => candidate.claimControlNumber === input.patientControlNumber,
  );
  if (keyed.length === 0)
    return {
      status: "UNMATCHED",
      reasonCode: "CLAIM_CONTROL_NOT_FOUND",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  const inScope = keyed.filter(
    (candidate) => candidate.organizationId === attribution.organizationId,
  );
  if (inScope.length === 0)
    return {
      status: "UNMATCHED",
      reasonCode: "CLAIM_CONTROL_NOT_FOUND",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  const provider = inScope.filter(
    (candidate) => candidate.providerEntityId === attribution.providerEntityId,
  );
  if (provider.length === 0)
    return {
      status: "PROVIDER_MISMATCH",
      reasonCode: "CLAIM_PROVIDER_MISMATCH",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  const payer = provider.filter(
    (candidate) =>
      candidate.canonicalPayerId === attribution.canonicalPayerId &&
      candidate.programId === attribution.programId,
  );
  if (payer.length === 0)
    return {
      status: "PAYER_MISMATCH",
      reasonCode: "CLAIM_PAYER_PROGRAM_MISMATCH",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  if (payer.length > 1)
    return {
      status: "AMBIGUOUS",
      reasonCode: "CLAIM_CONTROL_AMBIGUOUS",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    };
  const candidate = payer[0]!;
  // Only a complete match may name the claim or submission: every refusal would otherwise confirm to the caller that a
  // claim with this control number exists in the tenant, and for which submission.
  const result = (status: MedicaidEraMatchStatus, reasonCode: string): MedicaidEraMatchDecision =>
    status === "MATCHED"
      ? {
          status,
          reasonCode,
          claimId: candidate.claimId,
          submissionId: candidate.submission.submissionId,
          claimVersion: candidate.claimVersion,
        }
      : { status, reasonCode, claimId: null, submissionId: null, claimVersion: null };
  if (candidate.replacementLineage === "unresolved")
    return result("CORRECTION_LINEAGE_UNRESOLVED", "CLAIM_REPLACEMENT_LINEAGE_UNRESOLVED");
  if (candidate.replacementLineage === "void" || INACTIVE_CLAIM_STATES.has(candidate.claimState))
    return result(
      "CLAIM_VERSION_CONFLICT",
      candidate.claimState === "ABANDONED" ? "CLAIM_ABANDONED" : CLAIM_VERSION_NOT_ACTIVE,
    );
  if (!SUBMITTED_CLAIM_STATES.has(candidate.claimState))
    return result("SUBMISSION_UNVERIFIED", "CLAIM_HAS_NO_SUBMITTED_STATE");
  if (
    candidate.submission.status !== "verified_submitted" ||
    !candidate.submission.submissionId ||
    !candidate.submission.transactionReference ||
    !candidate.submission.claimId ||
    candidate.submission.claimId !== candidate.claimId ||
    candidate.submission.claimVersion !== candidate.claimVersion ||
    candidate.submission.claimControlNumber !== candidate.claimControlNumber ||
    !input.payerClaimControlNumber ||
    candidate.submission.payerClaimControlNumber !== input.payerClaimControlNumber
  )
    return result("SUBMISSION_UNVERIFIED", "NO_CORRELATED_EXTERNAL_SUBMISSION");
  if (
    candidate.submission.vendor !== input.attribution.vendor ||
    candidate.submission.accountReference !== input.attribution.accountReference
  )
    return result("SOURCE_ACCOUNT_MISMATCH", "SUBMISSION_SOURCE_ACCOUNT_MISMATCH");
  const dateRefusal = serviceRangeRefusal(input, candidate);
  if (dateRefusal) return result("SERVICE_RANGE_CONFLICT", dateRefusal);
  return result("MATCHED", "EXACT_SCOPED_SUBMISSION_EVIDENCE");
}

function isIsoCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Why the ERA's claim-level service range cannot be contained in the claim's, or null when it can. Missing and
 * malformed dates fail closed like a mismatch does, but are reported as what they are so a reviewer knows whether to
 * look at the ERA or at the claim (a claim-level DTM*232/233 is optional in an 835; line-level dates are not read).
 */
function serviceRangeRefusal(
  era: { readonly serviceFrom: string | null; readonly serviceTo: string | null },
  claim: { readonly serviceFrom: string | null; readonly serviceTo: string | null },
): string | null {
  if (!era.serviceFrom || !era.serviceTo) return "ERA_SERVICE_DATES_MISSING";
  if (
    !isIsoCalendarDate(era.serviceFrom) ||
    !isIsoCalendarDate(era.serviceTo) ||
    !isIsoCalendarDate(claim.serviceFrom) ||
    !isIsoCalendarDate(claim.serviceTo) ||
    era.serviceFrom > era.serviceTo ||
    claim.serviceFrom > claim.serviceTo
  )
    return "SERVICE_DATES_INVALID";
  return era.serviceFrom < claim.serviceFrom || era.serviceTo > claim.serviceTo
    ? "CLAIM_SERVICE_RANGE_MISMATCH"
    : null;
}

function sumSafeCents(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isSafeInteger(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export type MedicaidEraReviewDecision =
  | "payment_reported"
  | "full_payment_indicated_review_required"
  | "partial_payment"
  | "denial"
  | "mixed_service_line_outcomes"
  | "adjustment_review"
  | "reversal_or_recoupment_review"
  | "exact_duplicate"
  | "possible_duplicate"
  | "source_identity_conflict"
  | "unmatched_or_ambiguous"
  | "inconsistent_financial_totals"
  | "provider_adjustment_review"
  | "source_unverified";

export interface MedicaidEraReviewAssessment {
  readonly decision: MedicaidEraReviewDecision;
  readonly reasonCode: string;
  readonly attributionStatus: MedicaidEraAttribution["status"];
  readonly attribution: {
    readonly organizationId: string | null;
    readonly providerEntityId: string | null;
    readonly vendor: "claimmd" | "stedi" | null;
    readonly accountReference: string | null;
    readonly usage: "test" | "production" | null;
    readonly canonicalPayerId: string | null;
    readonly programId: string | null;
  };
  readonly matchStatus: MedicaidEraMatchStatus;
  /**
   * The payer's claim status code (CLP02), exposed only for an attributed claim. The decision may be a set-level one (a
   * provider adjustment outranks a claim denial), so this keeps the claim-level outcome visible to the reviewer.
   */
  readonly claimStatusCode: number | null;
  /** Exposed only after the complete trusted submission match succeeds. */
  readonly matchedClaim: {
    readonly claimId: string;
    readonly submissionId: string;
    readonly claimVersion: number;
  } | null;
  readonly sourceReference: string | null;
  readonly amounts: {
    readonly claimChargeCents: number | null;
    readonly claimPaidCents: number | null;
    readonly patientResponsibilityCents: number | null;
    readonly providerAdjustmentCents: number | null;
    readonly reportedPaymentCents: number | null;
  };
  readonly providerAdjustments: readonly {
    readonly reason: string;
    readonly reference: string | null;
    readonly amountCents: number | null;
  }[];
  readonly claimAdjustments: readonly {
    readonly groupCode: string;
    readonly reasonCode: string;
    readonly amountCents: number | null;
    readonly quantity: number | null;
  }[];
  readonly serviceLineAdjustments: readonly {
    readonly lineIndex: number;
    readonly groupCode: string;
    readonly reasonCode: string;
    readonly amountCents: number | null;
    readonly quantity: number | null;
    readonly remarks: readonly { readonly kind: string; readonly code: string }[];
    readonly references: readonly { readonly qualifier: string; readonly value: string }[];
  }[];
  readonly remarks: readonly { readonly kind: string; readonly code: string }[];
  readonly unresolvedRequirements: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly postingAuthorized: false;
}

/** Nonposting financial review projection. It never infers allowed amounts or posts a claim. */
export function assessMedicaidEraReview(input: {
  readonly observation: MedicaidEraObservation;
  readonly attribution: MedicaidEraAttribution;
  readonly match: MedicaidEraMatchDecision;
  readonly duplicate: MedicaidEraDuplicateDecision;
  readonly claimIndex?: number;
}): MedicaidEraReviewAssessment {
  const claim = input.observation.claims[input.claimIndex ?? 0];
  const attributed = input.attribution.status === "verified";
  const unmatched = input.match.status !== "MATCHED";
  // A parseable 835 with no CLP loops (e.g. PLB-only) is assessed once at transaction-set level: there is no claim to
  // match, so a provider-level adjustment is the finding; without one the set simply has nothing to match.
  const hasProviderAdjustments = input.observation.providerAdjustments.length > 0;
  const claimlessWithAdjustments = input.observation.claims.length === 0 && hasProviderAdjustments;
  let decision: MedicaidEraReviewDecision = "payment_reported";
  let reasonCode = "PAYMENT_REPORTED_REQUIRES_REVIEW";
  if (input.attribution.status !== "verified") {
    decision = "source_unverified";
    reasonCode = input.attribution.reason;
  } else if (input.duplicate !== "none") {
    decision =
      input.duplicate === "exact"
        ? "exact_duplicate"
        : input.duplicate === "conflict"
          ? "source_identity_conflict"
          : "possible_duplicate";
    reasonCode =
      input.duplicate === "exact"
        ? "EXACT_DUPLICATE_HOLD"
        : input.duplicate === "conflict"
          ? "SOURCE_IDENTITY_CONFLICT_HOLD"
          : "POSSIBLE_DUPLICATE_HOLD";
  } else if (unmatched && !claimlessWithAdjustments) {
    // The usual replacement/void flow: the payer reverses the ORIGINAL version, which M24 no longer calls active (and for
    // which the read seam supplies no verified submission evidence), so it can never match. It is still a reversal the
    // reviewer must see, held unmatched: no claim or submission id, and the match refusal stays in unresolvedRequirements.
    const reversesSupersededVersion =
      claim?.statusCode === 22 &&
      input.match.status === "CLAIM_VERSION_CONFLICT" &&
      input.match.reasonCode === CLAIM_VERSION_NOT_ACTIVE;
    decision = reversesSupersededVersion
      ? "reversal_or_recoupment_review"
      : "unmatched_or_ambiguous";
    reasonCode = reversesSupersededVersion
      ? "REVERSAL_OF_SUPERSEDED_CLAIM_VERSION"
      : input.match.reasonCode;
  } else if (claim && claim.statusCode === 22) {
    decision = "reversal_or_recoupment_review";
    reasonCode = "PAYER_REPORTED_REVERSAL_STATUS";
  } else if (hasProviderAdjustments) {
    decision = "provider_adjustment_review";
    reasonCode = "PROVIDER_LEVEL_ADJUSTMENT_REQUIRES_ALLOCATION_REVIEW";
  } else if (claim && claim.statusCode === 4) {
    decision = "denial";
    reasonCode = "PAYER_REPORTED_DENIAL_STATUS";
  } else if (
    claim?.serviceLines.some((line) => line.paidCents !== null && line.paidCents > 0) &&
    claim.serviceLines.some((line) => line.paidCents === 0)
  ) {
    decision = "mixed_service_line_outcomes";
    reasonCode = "SERVICE_LINE_PAID_AND_ZERO_PAYMENT_MIX";
  } else if (claim && claim.paidCents !== null && claim.paidCents < 0) {
    decision = "reversal_or_recoupment_review";
    reasonCode = "NEGATIVE_PAYMENT_REQUIRES_REVIEW";
  } else if (
    claim &&
    claim.paidCents !== null &&
    claim.chargeCents !== null &&
    claim.paidCents < claim.chargeCents
  ) {
    decision = claim.paidCents === 0 ? "adjustment_review" : "partial_payment";
    reasonCode =
      claim.paidCents === 0 ? "ZERO_PAYMENT_REQUIRES_STATUS_EVIDENCE" : "PARTIAL_PAYMENT_REVIEW";
  } else if (claim && claim.chargeCents !== null && claim.paidCents === claim.chargeCents) {
    decision = "full_payment_indicated_review_required";
    reasonCode = "CHARGE_EQUALS_PAYMENT_REVIEW_REQUIRED";
  }
  const balance = input.observation.financialReview.balance;
  if (
    decision !== "source_unverified" &&
    decision !== "possible_duplicate" &&
    decision !== "exact_duplicate" &&
    decision !== "source_identity_conflict" &&
    balance.status === "discrepancy"
  ) {
    decision = "inconsistent_financial_totals";
    reasonCode = "ERA_PAYMENT_TOTALS_INCONSISTENT";
  }
  return {
    decision,
    reasonCode,
    attributionStatus: input.attribution.status,
    attribution:
      input.attribution.status === "verified"
        ? {
            organizationId: input.attribution.organizationId,
            providerEntityId: input.attribution.providerEntityId,
            vendor: input.attribution.vendor,
            accountReference: input.attribution.accountReference,
            usage: input.attribution.usage,
            canonicalPayerId: input.attribution.canonicalPayerId,
            programId: input.attribution.programId,
          }
        : {
            organizationId: null,
            providerEntityId: null,
            vendor: null,
            accountReference: null,
            usage: null,
            canonicalPayerId: null,
            programId: null,
          },
    matchStatus: input.match.status,
    claimStatusCode: attributed ? (claim?.statusCode ?? null) : null,
    matchedClaim:
      attributed &&
      input.match.status === "MATCHED" &&
      input.match.claimId &&
      input.match.submissionId &&
      input.match.claimVersion !== null
        ? {
            claimId: input.match.claimId,
            submissionId: input.match.submissionId,
            claimVersion: input.match.claimVersion,
          }
        : null,
    sourceReference:
      input.attribution.status === "verified" ? input.attribution.artifactReference : null,
    amounts: {
      claimChargeCents: attributed ? (claim?.chargeCents ?? null) : null,
      claimPaidCents: attributed ? (claim?.paidCents ?? null) : null,
      patientResponsibilityCents: attributed ? (claim?.patientResponsibilityCents ?? null) : null,
      providerAdjustmentCents: attributed
        ? sumSafeCents(input.observation.providerAdjustments.map((item) => item.amountCents))
        : null,
      reportedPaymentCents: attributed ? input.observation.source.paymentCents : null,
    },
    providerAdjustments: attributed ? input.observation.providerAdjustments : [],
    claimAdjustments: attributed ? (claim?.adjustments ?? []) : [],
    serviceLineAdjustments:
      (attributed ? claim?.serviceLines : undefined)?.flatMap((line, lineIndex) =>
        line.adjustments.map((adjustment) => ({
          lineIndex,
          groupCode: adjustment.groupCode,
          reasonCode: adjustment.reasonCode,
          amountCents: adjustment.amountCents,
          quantity: adjustment.quantity,
          remarks: line.remarks,
          references: line.references,
        })),
      ) ?? [],
    remarks: attributed ? (claim?.remarks ?? []) : [],
    // An unverified party learns only why the ERA is held, never its structure (claim count, PLB, service lines).
    unresolvedRequirements: [
      ...(unmatched ? [input.match.reasonCode] : []),
      ...(attributed && input.observation.claims.length > 1 ? ["MULTI_CLAIM_REVIEW_REQUIRED"] : []),
      ...(attributed && hasProviderAdjustments ? ["PLB_ALLOCATION_POLICY_REQUIRED"] : []),
      ...(attributed && claim?.serviceLines.length
        ? ["PAYER_LINE_OUTCOME_POLICY_UNQUALIFIED"]
        : []),
      "PAYER_SPECIFIC_ADJUDICATION_POLICY_UNQUALIFIED",
    ],
    evidenceReferences:
      input.attribution.status === "verified" ? [input.attribution.evidenceReference] : [],
    postingAuthorized: false,
  };
}
