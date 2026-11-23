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
  | {
      readonly status: "held";
      readonly reason:
        | "SOURCE_ACCOUNT_UNREGISTERED"
        | "SOURCE_ACCOUNT_AMBIGUOUS"
        | "SOURCE_ACCOUNT_CONFLICT"
        | "PAYER_IDENTITY_UNVERIFIED"
        | "PAYEE_IDENTITY_CONFLICT"
        | "ENROLLMENT_NOT_ACTIVE"
        | "SOURCE_EVIDENCE_STALE";
    };

const digits = (value: string | null | undefined): string => (value ?? "").replace(/\D/g, "");

/** Resolve attribution from authenticated account context plus effective, verified enrollment evidence. */
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
  if (candidates.length !== 1) return { status: "held", reason: "SOURCE_ACCOUNT_AMBIGUOUS" };
  const account = candidates[0]!;
  if (!Number.isFinite(Date.parse(input.source.receivedAt)))
    return { status: "held", reason: "SOURCE_EVIDENCE_STALE" };
  const date = input.source.receivedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(account.effectiveFrom))
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
  const payeeNpi =
    input.observation.source.payee.identifierQualifier === "XX"
      ? digits(input.observation.source.payee.identifier)
      : "";
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
  const result = (
    status: MedicaidEraMatchStatus,
    reasonCode: string,
  ): MedicaidEraMatchDecision => ({
    status,
    reasonCode,
    claimId: candidate.claimId,
    submissionId: candidate.submission.submissionId,
    claimVersion: candidate.claimVersion,
  });
  if (candidate.replacementLineage === "unresolved")
    return result("CORRECTION_LINEAGE_UNRESOLVED", "CLAIM_REPLACEMENT_LINEAGE_UNRESOLVED");
  if (
    candidate.replacementLineage === "void" ||
    candidate.claimState === "VOIDED" ||
    candidate.claimState === "REPLACED"
  )
    return result("CLAIM_VERSION_CONFLICT", "CLAIM_VERSION_NOT_ACTIVE");
  if (
    !new Set([
      "SUBMITTED",
      "POLLING",
      "ACK_PENDING",
      "ACK_TIMEOUT",
      "ACK_ACCEPTED",
      "ACK_REJECTED",
      "ACK_PARTIAL",
    ]).has(candidate.claimState)
  )
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
  if (
    !validServiceDate(input.serviceFrom) ||
    !validServiceDate(input.serviceTo) ||
    !validServiceDate(candidate.serviceFrom) ||
    !validServiceDate(candidate.serviceTo) ||
    input.serviceFrom > input.serviceTo ||
    candidate.serviceFrom > candidate.serviceTo ||
    input.serviceFrom < candidate.serviceFrom ||
    input.serviceTo > candidate.serviceTo
  )
    return result("SERVICE_RANGE_CONFLICT", "CLAIM_SERVICE_RANGE_MISMATCH");
  return result("MATCHED", "EXACT_SCOPED_SUBMISSION_EVIDENCE");
}

function validServiceDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
  readonly duplicate: "none" | "exact" | "possible" | "conflict";
  readonly claimIndex?: number;
}): MedicaidEraReviewAssessment {
  const claim = input.observation.claims[input.claimIndex ?? 0];
  const attributed = input.attribution.status === "verified";
  const unmatched = input.match.status !== "MATCHED";
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
  } else if (unmatched) {
    decision = "unmatched_or_ambiguous";
    reasonCode = input.match.reasonCode;
  } else if (claim && claim.statusCode === 22) {
    decision = "reversal_or_recoupment_review";
    reasonCode = "PAYER_REPORTED_REVERSAL_STATUS";
  } else if (input.observation.providerAdjustments.length > 0) {
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
    unresolvedRequirements: [
      ...(unmatched ? [input.match.reasonCode] : []),
      ...(input.observation.claims.length > 1 ? ["MULTI_CLAIM_REVIEW_REQUIRED"] : []),
      ...(input.observation.providerAdjustments.length ? ["PLB_ALLOCATION_POLICY_REQUIRED"] : []),
      ...(claim?.serviceLines.length ? ["PAYER_LINE_OUTCOME_POLICY_UNQUALIFIED"] : []),
      "PAYER_SPECIFIC_ADJUDICATION_POLICY_UNQUALIFIED",
    ],
    evidenceReferences:
      input.attribution.status === "verified" ? [input.attribution.evidenceReference] : [],
    postingAuthorized: false,
  };
}
