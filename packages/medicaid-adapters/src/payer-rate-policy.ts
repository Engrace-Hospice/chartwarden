export type RateUnitBasis = "per_day" | "per_hour";
export type RateVerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "rejected"
  | "expired"
  | "revoked"
  | "superseded";

export interface PayerRatePolicyFact {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly canonicalPayerId: string;
  readonly programKind: "oregon_ffs" | "managed_care";
  readonly serviceState: string;
  readonly localityCode: string;
  readonly serviceCategory: "RHC" | "CHC" | "IRC" | "GIP" | "IN_HOME_RESPITE";
  readonly unitBasis: RateUnitBasis;
  readonly bucketFrom: number | null;
  readonly bucketTo: number | null;
  readonly rateCents: number;
  readonly chargeCeilingCents: number | null;
  readonly qualityReportingStatus: "unknown" | "not_applicable" | "meets" | "does_not_meet";
  readonly sourceKind: "oha_ffs_schedule" | "cco_contract" | "other_payer_contract";
  readonly verificationStatus: RateVerificationStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly sourceDocumentRef: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByMembershipId: string | null;
  readonly recordedByMembershipId: string;
}

export interface PayerRatePolicyLookup {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly canonicalPayerId: string;
  readonly programKind: "oregon_ffs" | "managed_care";
  readonly serviceState: string;
  readonly localityCode: string;
  readonly serviceCategory: PayerRatePolicyFact["serviceCategory"];
  readonly unitBasis: RateUnitBasis;
  readonly bucketFrom: number | null;
  readonly bucketTo: number | null;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly qualityReportingRequired: boolean;
  readonly providerQualityReportingStatus: "not_applicable" | "meets" | "does_not_meet" | null;
  readonly providerQualityReportingVerified: boolean;
  readonly chargeCeilingRequired: boolean;
}

export type PayerRatePolicyResult =
  | { readonly status: "qualified"; readonly reasonCode: null; readonly rate: PayerRatePolicyFact }
  | {
      readonly status: "missing" | "ambiguous" | "unverified" | "unsupported";
      readonly reasonCode: string;
      readonly rate: null;
    };

/** A rate row in one of these states can never become the rate in force; it does not compete with a live row. */
const TERMINAL_STATUSES: readonly RateVerificationStatus[] = [
  "rejected",
  "expired",
  "revoked",
  "superseded",
];

/**
 * Exact payer/provider/unit/locality/window lookup. It never falls back across a policy dimension. Terminal-status
 * rows (rejected, expired, revoked, superseded) are dropped before counting, so a dead row beside a verified one is
 * not "ambiguous"; if only dead rows match, the result is `unverified`, never `missing`.
 */
export function resolvePayerRatePolicy(
  lookup: PayerRatePolicyLookup,
  candidates: readonly PayerRatePolicyFact[],
): PayerRatePolicyResult {
  if (!lookup.localityCode.trim()) {
    return { status: "missing", reasonCode: "MEDICAID_RATE_POLICY_UNRESOLVED", rate: null };
  }
  const exact = candidates.filter(
    (rate) =>
      rate.organizationId === lookup.organizationId &&
      rate.providerEntityId === lookup.providerEntityId &&
      rate.canonicalPayerId === lookup.canonicalPayerId &&
      rate.programKind === lookup.programKind &&
      rate.serviceState === lookup.serviceState &&
      rate.localityCode === lookup.localityCode &&
      rate.localityCode.trim().length > 0 &&
      rate.serviceCategory === lookup.serviceCategory &&
      rate.unitBasis === lookup.unitBasis &&
      rate.bucketFrom === lookup.bucketFrom &&
      rate.bucketTo === lookup.bucketTo &&
      rate.effectiveFrom <= lookup.serviceFrom &&
      (rate.effectiveTo === null || rate.effectiveTo >= lookup.serviceTo),
  );
  const live = exact.filter((rate) => !TERMINAL_STATUSES.includes(rate.verificationStatus));
  if (live.length > 1) {
    return { status: "ambiguous", reasonCode: "MEDICAID_RATE_POLICY_AMBIGUOUS", rate: null };
  }
  const rate = live[0];
  if (!rate) {
    return {
      status: exact.length > 0 ? "unverified" : "missing",
      reasonCode: "MEDICAID_RATE_POLICY_UNRESOLVED",
      rate: null,
    };
  }
  if (
    rate.verificationStatus !== "verified" ||
    !rate.sourceDocumentRef ||
    !rate.verifiedAt ||
    !rate.verifiedByMembershipId ||
    rate.verifiedByMembershipId === rate.recordedByMembershipId
  ) {
    return { status: "unverified", reasonCode: "MEDICAID_RATE_POLICY_UNRESOLVED", rate: null };
  }
  if (
    (rate.sourceKind === "oha_ffs_schedule" && lookup.programKind !== "oregon_ffs") ||
    (rate.sourceKind !== "oha_ffs_schedule" && lookup.programKind !== "managed_care") ||
    (lookup.qualityReportingRequired &&
      (!lookup.providerQualityReportingVerified ||
        lookup.providerQualityReportingStatus === null ||
        rate.qualityReportingStatus !== lookup.providerQualityReportingStatus)) ||
    (lookup.chargeCeilingRequired && rate.chargeCeilingCents === null)
  ) {
    return {
      status: "unsupported",
      reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
      rate: null,
    };
  }
  if (!Number.isSafeInteger(rate.rateCents) || rate.rateCents <= 0) {
    return {
      status: "unsupported",
      reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
      rate: null,
    };
  }
  return { status: "qualified", reasonCode: null, rate };
}
