export type RateUnitBasis = "per_day" | "per_hour";
export type RateVerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "rejected"
  | "expired"
  | "revoked"
  | "superseded";
export type RatePricingMethod = "per_day" | "per_hour" | "fixed_contract_unit" | "unqualified";
export type RateQuantityConversionMethod =
  | "unqualified"
  | "daily_units"
  | "hourly_prorated_minutes"
  | "hourly_each_hour_or_part";
export type MinimumDurationMethod =
  | "unqualified"
  | "not_applicable"
  | "not_required"
  | "minimum_minutes";
export type RateRoundingMode =
  | "unqualified"
  | "not_applicable"
  | "exact_only"
  | "half_up"
  | "half_even"
  | "floor"
  | "ceiling";
export type RateRoundingBoundary =
  | "unqualified"
  | "not_applicable"
  | "service_day"
  | "segment"
  | "line"
  | "claim";
export type RateChargeCeilingMethod =
  | "unqualified"
  | "none"
  | "lower_of_rate_and_usual_charge"
  | "contract_maximum";
export type RateChargeCeilingBoundary =
  | "unqualified"
  | "not_applicable"
  | "service_day"
  | "segment"
  | "line"
  | "claim";
export type QualityReportingApplicability = "unqualified" | "required" | "not_required";
export type QualityReportingStatus = "unknown" | "not_applicable" | "meets" | "does_not_meet";

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
  /** Null with a non-null bucketFrom is an open-ended upper bucket. */
  readonly bucketTo: number | null;
  readonly electionDayBasis?: "unqualified" | "current_signed_election_calendar_days_v1";
  readonly rateCents: number;
  /** Meaning is determined by chargeCeilingMethod; it is not inherently a usual charge. */
  readonly chargeCeilingCents: number | null;
  readonly pricingMethod: RatePricingMethod;
  readonly quantityConversionMethod: RateQuantityConversionMethod;
  readonly minimumDurationMethod: MinimumDurationMethod;
  readonly minimumClinicalMinutes: number | null;
  /** Explicit payer policy ceiling for one service day; required by M24's supported CHC persistence profile. */
  readonly maximumClinicalMinutes?: number | null;
  readonly methodologyVersion: number;
  readonly roundingMode: RateRoundingMode;
  readonly roundingBoundary: RateRoundingBoundary;
  readonly chargeCeilingMethod: RateChargeCeilingMethod;
  readonly chargeCeilingBoundary: RateChargeCeilingBoundary;
  readonly qualityReportingApplicability: QualityReportingApplicability;
  readonly qualityReportingStatus: QualityReportingStatus;
  readonly sourceKind: "oha_ffs_schedule" | "cco_contract" | "other_payer_contract";
  readonly verificationStatus: RateVerificationStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly sourceDocumentRef: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByMembershipId: string | null;
  readonly recordedByMembershipId: string;
  readonly createdAt: string;
  readonly supersedesId: string | null;
  readonly version: number;
}

export interface QualityReportingPricingContext {
  readonly applicability: "required" | "not_required" | "unknown";
  readonly providerStatus: QualityReportingStatus;
  readonly evidenceReference: string | null;
  readonly evidenceVersion: number | null;
  readonly verifiedAt: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

export interface PayerRatePolicyLookup {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly canonicalPayerId: string;
  readonly programKind: "oregon_ffs" | "managed_care";
  readonly serviceState: string;
  readonly localityCode: string | null;
  readonly serviceCategory: PayerRatePolicyFact["serviceCategory"];
  readonly unitBasis: RateUnitBasis;
  readonly electionDayNumber: number | null;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  /** Caller-supplied as-of instant is explicit; it is never replaced with the current clock. */
  readonly assessedAt: string;
  /** Owner-derived evidence. Unknown or unverified context can never select a quality variant. */
  readonly qualityReporting: QualityReportingPricingContext;
}

export type PayerRatePolicyStatus =
  | "qualified"
  | "missing"
  | "ambiguous"
  | "unverified"
  | "unsupported"
  | "partial";

export interface PayerRatePolicySegment {
  readonly from: string;
  readonly to: string;
  readonly status: Exclude<PayerRatePolicyStatus, "partial">;
  readonly reasonCode: string | null;
  readonly rate: PayerRatePolicyFact | null;
}

export type PayerRatePolicyResult =
  | {
      readonly status: "qualified";
      readonly reasonCode: null;
      readonly rate: PayerRatePolicyFact;
      readonly segments: readonly PayerRatePolicySegment[];
    }
  | {
      readonly status: Exclude<PayerRatePolicyStatus, "qualified">;
      readonly reasonCode: string;
      readonly rate: null;
      readonly segments: readonly PayerRatePolicySegment[];
    };

const TERMINAL_STATUSES: readonly RateVerificationStatus[] = [
  "rejected",
  "expired",
  "revoked",
  "superseded",
];
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function isoDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function instantValue(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function overlaps(rate: PayerRatePolicyFact, from: string, to: string): boolean {
  return rate.effectiveFrom <= to && (rate.effectiveTo === null || rate.effectiveTo >= from);
}

function exactIdentity(lookup: PayerRatePolicyLookup, rate: PayerRatePolicyFact): boolean {
  return (
    rate.organizationId === lookup.organizationId &&
    rate.providerEntityId === lookup.providerEntityId &&
    rate.canonicalPayerId === lookup.canonicalPayerId &&
    rate.programKind === lookup.programKind &&
    rate.serviceState === lookup.serviceState &&
    rate.localityCode === lookup.localityCode &&
    rate.serviceCategory === lookup.serviceCategory &&
    rate.unitBasis === lookup.unitBasis
  );
}

function bucketMatches(lookup: PayerRatePolicyLookup, rate: PayerRatePolicyFact): boolean {
  if (lookup.programKind === "oregon_ffs" && lookup.serviceCategory === "RHC") {
    return (
      lookup.electionDayNumber !== null &&
      rate.bucketFrom !== null &&
      lookup.electionDayNumber >= rate.bucketFrom &&
      (rate.bucketTo === null || lookup.electionDayNumber <= rate.bucketTo)
    );
  }
  // An unknown election day must not hide bucketed rows: filtering them out here would let a flat row
  // resolve next to a verified 1-60 bucket for the same identity. They stay candidates, and the segment
  // resolver refuses with RATE_ELECTION_DAY_UNRESOLVED when a verified bucketed head covers the interval.
  if (lookup.electionDayNumber === null) return true;
  if (rate.bucketFrom === null) return rate.bucketTo === null;
  return (
    lookup.electionDayNumber >= rate.bucketFrom &&
    (rate.bucketTo === null || lookup.electionDayNumber <= rate.bucketTo)
  );
}

function qualityMatches(lookup: PayerRatePolicyLookup, rate: PayerRatePolicyFact): boolean {
  const context = lookup.qualityReporting;
  const qualityFrom = context.effectiveFrom === null ? null : dateValue(context.effectiveFrom);
  const qualityTo = context.effectiveTo === null ? null : dateValue(context.effectiveTo);
  const serviceFrom = dateValue(lookup.serviceFrom);
  const serviceTo = dateValue(lookup.serviceTo);
  if (
    !context.evidenceReference ||
    context.evidenceVersion === null ||
    !context.verifiedAt ||
    instantValue(context.verifiedAt) === null ||
    !Number.isSafeInteger(context.evidenceVersion) ||
    (context.evidenceVersion ?? 0) <= 0 ||
    instantValue(context.verifiedAt)! > instantValue(lookup.assessedAt)! ||
    qualityFrom === null ||
    serviceFrom === null ||
    qualityFrom > serviceFrom ||
    (context.effectiveTo !== null &&
      (qualityTo === null || serviceTo === null || qualityTo < serviceTo))
  ) {
    return false;
  }
  if (context.applicability === "unknown" || context.providerStatus === "unknown") return false;
  if (context.applicability === "not_required") {
    return (
      context.providerStatus === "not_applicable" &&
      rate.qualityReportingApplicability === "not_required" &&
      rate.qualityReportingStatus === "not_applicable"
    );
  }
  return (
    context.applicability === "required" &&
    rate.qualityReportingApplicability === "required" &&
    (context.providerStatus === "meets" || context.providerStatus === "does_not_meet") &&
    rate.qualityReportingStatus === context.providerStatus
  );
}

function sourceMatchesProgram(rate: PayerRatePolicyFact): boolean {
  return rate.programKind === "oregon_ffs"
    ? rate.sourceKind === "oha_ffs_schedule"
    : rate.sourceKind === "cco_contract" || rate.sourceKind === "other_payer_contract";
}

function methodologyQualified(rate: PayerRatePolicyFact): boolean {
  // M6 has no authoritative in-home respite service type/quantity contract yet. A rate row alone
  // cannot qualify that service for pricing.
  if (rate.serviceCategory === "IN_HOME_RESPITE") return false;
  if (
    rate.maximumClinicalMinutes != null &&
    (!Number.isSafeInteger(rate.maximumClinicalMinutes) || rate.maximumClinicalMinutes < 1)
  ) {
    return false;
  }
  const methodMatchesUnit =
    (rate.pricingMethod === "per_day" &&
      rate.unitBasis === "per_day" &&
      rate.quantityConversionMethod === "daily_units" &&
      rate.minimumDurationMethod === "not_applicable" &&
      rate.minimumClinicalMinutes === null) ||
    (rate.pricingMethod === "fixed_contract_unit" &&
      rate.unitBasis === "per_day" &&
      rate.quantityConversionMethod === "daily_units" &&
      rate.minimumDurationMethod === "not_applicable" &&
      rate.minimumClinicalMinutes === null) ||
    (rate.pricingMethod === "per_hour" &&
      rate.unitBasis === "per_hour" &&
      ["hourly_prorated_minutes", "hourly_each_hour_or_part"].includes(
        rate.quantityConversionMethod,
      ) &&
      ((rate.minimumDurationMethod === "not_required" && rate.minimumClinicalMinutes === null) ||
        (rate.minimumDurationMethod === "minimum_minutes" &&
          Number.isSafeInteger(rate.minimumClinicalMinutes) &&
          (rate.minimumClinicalMinutes ?? 0) > 0))) ||
    (rate.pricingMethod === "fixed_contract_unit" &&
      rate.unitBasis === "per_hour" &&
      ["hourly_prorated_minutes", "hourly_each_hour_or_part"].includes(
        rate.quantityConversionMethod,
      ) &&
      ((rate.minimumDurationMethod === "not_required" && rate.minimumClinicalMinutes === null) ||
        (rate.minimumDurationMethod === "minimum_minutes" &&
          Number.isSafeInteger(rate.minimumClinicalMinutes) &&
          (rate.minimumClinicalMinutes ?? 0) > 0)));
  const roundingMatches =
    (rate.unitBasis === "per_day" &&
      (rate.roundingMode === "not_applicable" || rate.roundingMode === "exact_only") &&
      (rate.roundingBoundary === "not_applicable" || rate.roundingBoundary === "service_day")) ||
    (rate.unitBasis === "per_hour" &&
      rate.quantityConversionMethod === "hourly_prorated_minutes" &&
      rate.roundingMode !== "unqualified" &&
      rate.roundingMode !== "not_applicable" &&
      ["service_day", "segment"].includes(rate.roundingBoundary)) ||
    (rate.unitBasis === "per_hour" &&
      rate.quantityConversionMethod === "hourly_each_hour_or_part" &&
      rate.roundingMode === "not_applicable" &&
      rate.roundingBoundary === "not_applicable");
  const ceilingMatches =
    (rate.chargeCeilingMethod === "none" && rate.chargeCeilingBoundary === "not_applicable") ||
    (rate.chargeCeilingMethod === "lower_of_rate_and_usual_charge" &&
      rate.chargeCeilingBoundary === "service_day") ||
    (rate.chargeCeilingMethod === "contract_maximum" &&
      rate.chargeCeilingCents !== null &&
      ["service_day", "segment"].includes(rate.chargeCeilingBoundary));
  const hourlyCeilingCompatible =
    rate.unitBasis !== "per_hour" ||
    rate.roundingBoundary !== "segment" ||
    rate.chargeCeilingBoundary !== "service_day";
  const sourceMethodCompatible =
    rate.sourceKind !== "oha_ffs_schedule" ||
    (rate.programKind === "oregon_ffs" &&
      rate.chargeCeilingMethod === "lower_of_rate_and_usual_charge" &&
      rate.chargeCeilingBoundary === "service_day" &&
      rate.qualityReportingApplicability === "required" &&
      (rate.serviceCategory !== "CHC" ||
        (rate.pricingMethod === "per_hour" &&
          rate.quantityConversionMethod === "hourly_each_hour_or_part" &&
          rate.minimumDurationMethod === "minimum_minutes" &&
          rate.minimumClinicalMinutes === 480)) &&
      (rate.serviceCategory === "CHC"
        ? rate.pricingMethod === "per_hour"
        : rate.pricingMethod === "per_day"));
  return (
    methodMatchesUnit &&
    roundingMatches &&
    ceilingMatches &&
    hourlyCeilingCompatible &&
    sourceMethodCompatible &&
    Number.isSafeInteger(rate.methodologyVersion) &&
    rate.methodologyVersion > 0
  );
}

function verifiedAtAssessment(rate: PayerRatePolicyFact, assessedAt: number): boolean {
  const createdAt = instantValue(rate.createdAt);
  const verifiedAt = rate.verifiedAt === null ? null : instantValue(rate.verifiedAt);
  return (
    createdAt !== null &&
    createdAt <= assessedAt &&
    (verifiedAt === null || verifiedAt <= assessedAt)
  );
}

function verifyRate(
  lookup: PayerRatePolicyLookup,
  rate: PayerRatePolicyFact,
  assessedAt: number,
): PayerRatePolicySegment["status"] {
  if (
    rate.verificationStatus !== "verified" ||
    !rate.sourceDocumentRef ||
    !rate.verifiedAt ||
    !rate.verifiedByMembershipId ||
    rate.verifiedByMembershipId === rate.recordedByMembershipId ||
    !verifiedAtAssessment(rate, assessedAt)
  ) {
    return "unverified";
  }
  if (!sourceMatchesProgram(rate)) return "unsupported";
  if (
    !qualityMatches(lookup, rate) ||
    !Number.isSafeInteger(lookup.qualityReporting.evidenceVersion) ||
    instantValue(lookup.qualityReporting.verifiedAt ?? "")! > assessedAt
  ) {
    return "unsupported";
  }
  if (
    !methodologyQualified(rate) ||
    !Number.isSafeInteger(rate.rateCents) ||
    rate.rateCents <= 0 ||
    (rate.chargeCeilingCents !== null &&
      (!Number.isSafeInteger(rate.chargeCeilingCents) || rate.chargeCeilingCents <= 0))
  ) {
    return "unsupported";
  }
  return "qualified";
}

function qualityReason(lookup: PayerRatePolicyLookup): string | null {
  const q = lookup.qualityReporting;
  const serviceFrom = dateValue(lookup.serviceFrom);
  const serviceTo = dateValue(lookup.serviceTo);
  const effectiveFrom = q.effectiveFrom ? dateValue(q.effectiveFrom) : null;
  const effectiveTo = q.effectiveTo === null ? null : dateValue(q.effectiveTo);
  if (
    q.applicability === "unknown" ||
    q.providerStatus === "unknown" ||
    !q.evidenceReference ||
    !Number.isSafeInteger(q.evidenceVersion) ||
    (q.evidenceVersion ?? 0) <= 0 ||
    !q.verifiedAt ||
    instantValue(q.verifiedAt) === null ||
    instantValue(q.verifiedAt)! > instantValue(lookup.assessedAt)! ||
    !q.effectiveFrom ||
    dateValue(q.effectiveFrom) === null ||
    (q.effectiveTo !== null && dateValue(q.effectiveTo) === null) ||
    serviceFrom === null ||
    serviceTo === null ||
    effectiveFrom === null ||
    effectiveFrom > serviceFrom ||
    (q.effectiveTo !== null && (effectiveTo === null || effectiveTo < serviceTo))
  ) {
    return "RATE_QUALITY_STATUS_UNVERIFIED";
  }
  return null;
}

function failedSegment(
  from: string,
  to: string,
  status: PayerRatePolicySegment["status"],
  reasonCode: string,
): PayerRatePolicySegment {
  return { from, to, status, reasonCode, rate: null };
}

/**
 * Split an inclusive service period at every candidate rate boundary, then resolve each interval. Partial
 * overlaps therefore remain visible as ambiguous intervals instead of being hidden by a longer rate row.
 * Assessment time is explicit and filters out evidence recorded or verified later than that instant.
 */
export function resolvePayerRatePolicySegments(
  lookup: PayerRatePolicyLookup,
  candidates: readonly PayerRatePolicyFact[],
): readonly PayerRatePolicySegment[] {
  const start = dateValue(lookup.serviceFrom);
  const end = dateValue(lookup.serviceTo);
  const assessedAt = instantValue(lookup.assessedAt);
  if (start === null || end === null || start > end || assessedAt === null) {
    return [
      failedSegment(
        lookup.serviceFrom,
        lookup.serviceTo,
        "unsupported",
        "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
      ),
    ];
  }
  if (!lookup.localityCode?.trim()) {
    return [
      failedSegment(lookup.serviceFrom, lookup.serviceTo, "missing", "RATE_LOCALITY_UNRESOLVED"),
    ];
  }
  if (qualityReason(lookup)) {
    return [
      failedSegment(
        lookup.serviceFrom,
        lookup.serviceTo,
        "unsupported",
        "RATE_QUALITY_STATUS_UNVERIFIED",
      ),
    ];
  }
  if (
    lookup.programKind === "oregon_ffs" &&
    lookup.serviceCategory === "RHC" &&
    (!Number.isInteger(lookup.electionDayNumber) || (lookup.electionDayNumber ?? 0) < 1)
  ) {
    return [
      failedSegment(
        lookup.serviceFrom,
        lookup.serviceTo,
        "missing",
        "RATE_ELECTION_DAY_UNRESOLVED",
      ),
    ];
  }

  const identityRows = candidates.filter(
    (rate) =>
      exactIdentity(lookup, rate) &&
      bucketMatches(lookup, rate) &&
      qualityMatches(lookup, rate) &&
      verifiedAtAssessment(rate, assessedAt),
  );
  const inScope = identityRows.filter((rate) =>
    overlaps(rate, lookup.serviceFrom, lookup.serviceTo),
  );
  for (const rate of identityRows) {
    if (
      dateValue(rate.effectiveFrom) === null ||
      (rate.effectiveTo !== null && dateValue(rate.effectiveTo) === null) ||
      (rate.effectiveTo !== null && rate.effectiveFrom > rate.effectiveTo)
    ) {
      return [
        failedSegment(
          lookup.serviceFrom,
          lookup.serviceTo,
          "unsupported",
          "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
        ),
      ];
    }
  }
  const qualityVariants = candidates.filter(
    (rate) =>
      rate.organizationId === lookup.organizationId &&
      rate.providerEntityId === lookup.providerEntityId &&
      rate.canonicalPayerId === lookup.canonicalPayerId &&
      rate.programKind === lookup.programKind &&
      rate.serviceState === lookup.serviceState &&
      rate.localityCode === lookup.localityCode &&
      rate.serviceCategory === lookup.serviceCategory &&
      rate.unitBasis === lookup.unitBasis &&
      bucketMatches(lookup, rate) &&
      overlaps(rate, lookup.serviceFrom, lookup.serviceTo) &&
      verifiedAtAssessment(rate, assessedAt),
  );
  // A terminal correction/revocation still closes its predecessor chain. Filtering terminal rows
  // before building lineage would silently revive a previously verified rate after its replacement
  // was revoked. Rejected drafts are the exception: they never supersede the active head.
  // Build lineage before service-window filtering. A correction can narrow or end a predecessor's
  // effective range; filtering first would make the old, broader row visible again outside the
  // correction's range even though that whole evidence version was superseded.
  const lineageRows = identityRows.filter((rate) => rate.verificationStatus !== "rejected");
  const supersededIds = new Set(
    lineageRows.flatMap((rate) => (rate.supersedesId ? [rate.supersedesId] : [])),
  );
  const heads = lineageRows.filter((rate) => !supersededIds.has(rate.id));

  const points = new Set<number>([start, end + DAY_MS]);
  for (const rate of inScope) {
    const from = dateValue(rate.effectiveFrom)!;
    const afterTo =
      rate.effectiveTo === null ? end + DAY_MS : dateValue(rate.effectiveTo)! + DAY_MS;
    if (from > start && from <= end) points.add(from);
    if (afterTo > start && afterTo <= end) points.add(afterTo);
  }
  const ordered = [...points].sort((a, b) => a - b);
  const segments: PayerRatePolicySegment[] = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const from = isoDate(ordered[i]!);
    const to = isoDate(ordered[i + 1]! - DAY_MS);
    const matchingHeads = heads.filter(
      (rate) => rate.effectiveFrom <= from && (rate.effectiveTo === null || rate.effectiveTo >= to),
    );
    if (
      lookup.electionDayNumber === null &&
      matchingHeads.some(
        (rate) => rate.bucketFrom !== null && rate.verificationStatus === "verified",
      )
    ) {
      segments.push(failedSegment(from, to, "missing", "RATE_ELECTION_DAY_UNRESOLVED"));
      continue;
    }
    if (matchingHeads.length > 1) {
      segments.push(failedSegment(from, to, "ambiguous", "MEDICAID_RATE_POLICY_AMBIGUOUS"));
      continue;
    }
    const rate = matchingHeads[0];
    if (!rate) {
      const terminal = inScope.some(
        (candidate) =>
          TERMINAL_STATUSES.includes(candidate.verificationStatus) && overlaps(candidate, from, to),
      );
      const matchingQualityRows = qualityVariants.filter(
        (candidate) =>
          candidate.effectiveFrom <= from &&
          (candidate.effectiveTo === null || candidate.effectiveTo >= to),
      );
      const terminalVariant = matchingQualityRows.some((candidate) =>
        TERMINAL_STATUSES.includes(candidate.verificationStatus),
      );
      const otherQualityVariant = matchingQualityRows.some(
        (candidate) => !qualityMatches(lookup, candidate),
      );
      const terminalEvidence = terminal || terminalVariant;
      segments.push(
        failedSegment(
          from,
          to,
          terminalEvidence ? "unverified" : "missing",
          terminalEvidence
            ? "RATE_SOURCE_UNVERIFIED"
            : otherQualityVariant
              ? "RATE_QUALITY_VARIANT_UNAVAILABLE"
              : "RATE_EFFECTIVE_PERIOD_GAP",
        ),
      );
      continue;
    }
    const status = verifyRate(lookup, rate, assessedAt);
    segments.push(
      status === "qualified"
        ? { from, to, status, reasonCode: null, rate }
        : failedSegment(
            from,
            to,
            status,
            status === "unverified"
              ? "RATE_SOURCE_UNVERIFIED"
              : rate.chargeCeilingMethod === "unqualified"
                ? "RATE_CHARGE_CEILING_UNRESOLVED"
                : "PRICING_METHOD_UNSUPPORTED",
          ),
    );
  }
  return segments;
}

/** Exact payer/provider/locality selection. A single rate must cover the whole requested interval. */
export function resolvePayerRatePolicy(
  lookup: PayerRatePolicyLookup,
  candidates: readonly PayerRatePolicyFact[],
): PayerRatePolicyResult {
  const segments = resolvePayerRatePolicySegments(lookup, candidates);
  if (segments.length === 1 && segments[0]?.status === "qualified" && segments[0].rate) {
    return { status: "qualified", reasonCode: null, rate: segments[0].rate, segments };
  }
  const failure = segments.find((segment) => segment.status !== "qualified");
  if (!failure && segments.length > 1) {
    return {
      status: "partial",
      reasonCode: "MEDICAID_RATE_POLICY_PARTIAL_PERIOD",
      rate: null,
      segments,
    };
  }
  const status: Exclude<PayerRatePolicyStatus, "qualified"> =
    !failure || failure.status === "qualified" ? "missing" : failure.status;
  return {
    status,
    reasonCode: failure?.reasonCode ?? "MEDICAID_RATE_POLICY_UNRESOLVED",
    rate: null,
    segments,
  };
}
