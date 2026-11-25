import {
  type PayerRatePolicyFact,
  type PayerRatePolicyLookup,
  resolvePayerRatePolicySegments,
} from "./payer-rate-policy";
import {
  type EffectiveHospiceFact,
  type HospiceQuantityEvidence,
  segmentHospiceServiceWindow,
} from "./service-segmentation";

export type HospicePricingQuantity =
  | { readonly unitBasis: "per_day"; readonly units: number }
  | { readonly unitBasis: "per_hour"; readonly clinicalMinutes: number };

export interface VerifiedQuantityEvidence {
  readonly serviceDate: string;
  readonly providerEntityId: string;
  readonly serviceCategory: PayerRatePolicyFact["serviceCategory"];
  readonly unitBasis: PayerRatePolicyFact["unitBasis"];
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
}

export interface VerifiedLocalityEvidence {
  readonly localityCode: string;
  readonly serviceState: string;
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface VerifiedElectionDayEvidence {
  readonly electionDayNumber: number;
  readonly serviceDate: string;
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
}

export interface VerifiedInpatientRespiteDayEvidence {
  readonly consecutiveDayNumber: number;
  readonly serviceDate: string;
  readonly episodeReference: string;
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
}

export interface VerifiedChargeEvidence {
  /** Provider usual charge for this service date; this is never a claim billed charge. */
  readonly amountCents: number;
  readonly serviceDate: string;
  readonly providerEntityId: string;
  readonly serviceCategory: PayerRatePolicyFact["serviceCategory"];
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
}

/** One authoritative service-date fact. `quantity` is null when the owning clinical source has not supplied it. */
export interface HospicePricingDayInput {
  readonly serviceDate: string;
  readonly serviceCategory: PayerRatePolicyFact["serviceCategory"];
  readonly unitBasis: PayerRatePolicyFact["unitBasis"];
  readonly localityCode: string | null;
  readonly localityEvidence: VerifiedLocalityEvidence | null;
  readonly electionDayEvidence: VerifiedElectionDayEvidence | null;
  readonly inpatientRespiteDayEvidence: VerifiedInpatientRespiteDayEvidence | null;
  readonly quantity: HospicePricingQuantity | null;
  readonly quantityEvidence: VerifiedQuantityEvidence | null;
  readonly providerUsualCharge: VerifiedChargeEvidence | null;
  readonly payerContext: Omit<
    PayerRatePolicyLookup,
    | "serviceFrom"
    | "serviceTo"
    | "localityCode"
    | "serviceCategory"
    | "unitBasis"
    | "electionDayNumber"
  >;
}

export interface HospicePricingSegment {
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly serviceCategory: PayerRatePolicyFact["serviceCategory"] | null;
  readonly status: "resolved" | "partial" | "unresolved" | "ambiguous" | "unsupported";
  readonly reasonCodes: readonly string[];
  readonly rateEvidence: null | {
    readonly id: string;
    readonly version: number;
    readonly canonicalPayerId: string;
    readonly programKind: PayerRatePolicyFact["programKind"];
    readonly providerEntityId: string;
    readonly localityCode: string;
    readonly unitBasis: PayerRatePolicyFact["unitBasis"];
    readonly rateCents: number;
    readonly sourceKind: PayerRatePolicyFact["sourceKind"];
    readonly sourceDocumentRef: string;
    readonly verifiedAt: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly methodologyVersion: number;
    readonly pricingMethod: PayerRatePolicyFact["pricingMethod"];
    readonly quantityConversionMethod: PayerRatePolicyFact["quantityConversionMethod"];
    readonly minimumDurationMethod: PayerRatePolicyFact["minimumDurationMethod"];
    readonly minimumClinicalMinutes: number | null;
    readonly maximumClinicalMinutes?: number | null;
    readonly roundingMode: PayerRatePolicyFact["roundingMode"];
    readonly roundingBoundary: PayerRatePolicyFact["roundingBoundary"];
    readonly chargeCeilingMethod: PayerRatePolicyFact["chargeCeilingMethod"];
    readonly chargeCeilingBoundary: PayerRatePolicyFact["chargeCeilingBoundary"];
    readonly chargeCeilingCents: number | null;
    readonly qualityReportingApplicability: PayerRatePolicyFact["qualityReportingApplicability"];
    readonly qualityReportingStatus: PayerRatePolicyFact["qualityReportingStatus"];
    readonly qualityReportingEvidenceReference: string;
    readonly qualityReportingEvidenceVersion: number;
    readonly qualityReportingVerifiedAt: string;
    readonly localityEvidenceReference: string;
    readonly localityEvidenceVersion: number;
    readonly localityVerifiedAt: string;
    readonly electionDayEvidenceReference: string | null;
    readonly electionDayEvidenceVersion: number | null;
    readonly electionDayVerifiedAt: string | null;
    readonly electionDayNumber: number | null;
    readonly inpatientRespiteEvidenceReference: string | null;
    readonly inpatientRespiteEvidenceVersion: number | null;
    readonly inpatientRespiteVerifiedAt: string | null;
    readonly inpatientRespiteEpisodeReference: string | null;
    readonly inpatientRespiteConsecutiveDayNumber: number | null;
  };
  readonly quantity: HospicePricingQuantity | null;
  readonly quantityEvidence: readonly VerifiedQuantityEvidence[];
  readonly baseReimbursementCents: number | null;
  readonly reimbursementEstimateCents: number | null;
  /** Not populated by a rate estimate. */
  readonly actualBilledChargeCents: null;
  readonly payerAllowedAmountCents: null;
  readonly actualPaymentCents: null;
  readonly appliedCeilings: readonly {
    readonly method: "lower_of_rate_and_usual_charge" | "contract_maximum";
    readonly amountCents: number;
    readonly boundary: "service_day" | "segment";
    readonly evidenceReference: string | null;
    readonly evidenceVersion: number | null;
    readonly evidenceVerifiedAt: string | null;
  }[];
}

export interface HospicePricingAssessment {
  readonly status:
    | "fully_resolved"
    | "partially_resolved"
    | "unresolved"
    | "ambiguous"
    | "unsupported";
  readonly assessedAt: string;
  readonly coversRequestedPeriod: boolean;
  readonly segments: readonly HospicePricingSegment[];
  /** Present only when every day, rate, quantity, and applicable constraint is resolved. */
  readonly reimbursementEstimateTotalCents: number | null;
  /** L8A.1 never derives or stores a provider's billed charge. */
  readonly actualBilledChargeTotalCents: null;
  readonly payerAllowedAmountCents: null;
  readonly actualPaymentCents: null;
  readonly submissionAvailable: false;
}

const DAY_MS = 86_400_000;
const isoTime = (date: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date
    ? value
    : null;
};
const dateString = (value: number): string => new Date(value).toISOString().slice(0, 10);
const nextDate = (date: string): string => dateString(isoTime(date)! + DAY_MS);

function safeCents(value: bigint): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function roundedRatio(
  numerator: bigint,
  denominator: bigint,
  mode: PayerRatePolicyFact["roundingMode"],
): bigint | null {
  if (denominator <= 0n || numerator < 0n) return null;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  switch (mode) {
    case "exact_only":
      return null;
    case "floor":
      return quotient;
    case "ceiling":
      return quotient + 1n;
    case "half_up":
      return remainder * 2n >= denominator ? quotient + 1n : quotient;
    case "half_even": {
      const doubled = remainder * 2n;
      if (doubled > denominator) return quotient + 1n;
      if (doubled < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + 1n;
    }
    default:
      return null;
  }
}

function amountFor(
  rate: PayerRatePolicyFact,
  quantity: HospicePricingQuantity,
): { readonly amount: number | null; readonly reasonCode: string | null } {
  if (quantity.unitBasis !== rate.unitBasis) {
    return { amount: null, reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED" };
  }
  if (quantity.unitBasis === "per_day") {
    if (!Number.isSafeInteger(quantity.units) || quantity.units <= 0) {
      return { amount: null, reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED" };
    }
    const amount = safeCents(BigInt(rate.rateCents) * BigInt(quantity.units));
    return amount === null
      ? { amount: null, reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED" }
      : { amount, reasonCode: null };
  }
  if (!Number.isSafeInteger(quantity.clinicalMinutes) || quantity.clinicalMinutes <= 0) {
    return { amount: null, reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED" };
  }
  if (
    rate.maximumClinicalMinutes != null &&
    quantity.clinicalMinutes > rate.maximumClinicalMinutes
  ) {
    return { amount: null, reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED" };
  }
  if (rate.quantityConversionMethod === "hourly_each_hour_or_part") {
    const billableHours = BigInt(Math.floor((quantity.clinicalMinutes + 59) / 60));
    const amount = safeCents(BigInt(rate.rateCents) * billableHours);
    return amount === null
      ? { amount: null, reasonCode: "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED" }
      : { amount, reasonCode: null };
  }
  if (rate.quantityConversionMethod !== "hourly_prorated_minutes") {
    return { amount: null, reasonCode: "RATE_UNIT_CONVERSION_UNQUALIFIED" };
  }
  const amount = roundedRatio(
    BigInt(rate.rateCents) * BigInt(quantity.clinicalMinutes),
    60n,
    rate.roundingMode,
  );
  const cents = amount === null ? null : safeCents(amount);
  return cents === null
    ? { amount: null, reasonCode: "RATE_UNIT_CONVERSION_UNQUALIFIED" }
    : { amount: cents, reasonCode: null };
}

/** A service day cannot carry more than 24 hours of clinical care. */
const MAX_CLINICAL_MINUTES_PER_SERVICE_DAY = 1440;

/**
 * The amount must be a number the pricing arithmetic and the service-window segmenter both accept. Without
 * this the segmenter throws a RangeError (units 0, -1, NaN; minutes above a day or fractional) before the
 * fail-closed branches in `amountFor` can run.
 */
function quantityAmountValid(quantity: HospicePricingQuantity): boolean {
  return quantity.unitBasis === "per_day"
    ? Number.isSafeInteger(quantity.units) && quantity.units > 0
    : Number.isSafeInteger(quantity.clinicalMinutes) &&
        quantity.clinicalMinutes > 0 &&
        quantity.clinicalMinutes <= MAX_CLINICAL_MINUTES_PER_SERVICE_DAY;
}

function quantityValid(day: HospicePricingDayInput): boolean {
  if (!day.quantity || !day.quantityEvidence) return false;
  const verified = Date.parse(day.quantityEvidence.verifiedAt);
  return (
    quantityAmountValid(day.quantity) &&
    !!day.quantityEvidence.sourceReference &&
    day.quantityEvidence.serviceDate === day.serviceDate &&
    day.quantityEvidence.providerEntityId === day.payerContext.providerEntityId &&
    day.quantityEvidence.serviceCategory === day.serviceCategory &&
    day.quantityEvidence.unitBasis === day.unitBasis &&
    Number.isSafeInteger(day.quantityEvidence.version) &&
    // M6 LOC rows begin at version 0; that is the authoritative initial revision, not missing evidence.
    day.quantityEvidence.version >= 0 &&
    Number.isFinite(verified) &&
    verified <= Date.parse(day.payerContext.assessedAt) &&
    day.quantity.unitBasis === day.unitBasis
  );
}

function effectiveEvidenceValid(input: {
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
  readonly assessedAt: string;
}): boolean {
  const verified = Date.parse(input.verifiedAt);
  const assessed = Date.parse(input.assessedAt);
  return (
    input.sourceReference.trim().length > 0 &&
    Number.isSafeInteger(input.version) &&
    input.version > 0 &&
    Number.isFinite(verified) &&
    Number.isFinite(assessed) &&
    verified <= assessed
  );
}

function localityForDay(day: HospicePricingDayInput): string | null {
  const evidence = day.localityEvidence;
  if (
    !evidence ||
    day.localityCode === null ||
    day.localityCode !== evidence.localityCode ||
    evidence.serviceState !== day.payerContext.serviceState ||
    !effectiveEvidenceValid({ ...evidence, assessedAt: day.payerContext.assessedAt }) ||
    isoTime(evidence.effectiveFrom) === null ||
    (evidence.effectiveTo !== null && isoTime(evidence.effectiveTo) === null) ||
    evidence.effectiveFrom > day.serviceDate ||
    (evidence.effectiveTo !== null && evidence.effectiveTo < day.serviceDate)
  ) {
    return null;
  }
  return evidence.localityCode;
}

function electionDayForDay(day: HospicePricingDayInput): number | null {
  const evidence = day.electionDayEvidence;
  if (
    !evidence ||
    evidence.serviceDate !== day.serviceDate ||
    !Number.isSafeInteger(evidence.electionDayNumber) ||
    evidence.electionDayNumber < 1 ||
    !effectiveEvidenceValid({ ...evidence, assessedAt: day.payerContext.assessedAt })
  ) {
    return null;
  }
  return evidence.electionDayNumber;
}

function inpatientRespiteDayForDay(day: HospicePricingDayInput): number | null {
  const evidence = day.inpatientRespiteDayEvidence;
  if (
    !evidence ||
    evidence.serviceDate !== day.serviceDate ||
    !evidence.episodeReference.trim() ||
    !Number.isSafeInteger(evidence.consecutiveDayNumber) ||
    evidence.consecutiveDayNumber < 1 ||
    !effectiveEvidenceValid({ ...evidence, assessedAt: day.payerContext.assessedAt })
  ) {
    return null;
  }
  return evidence.consecutiveDayNumber;
}

function chargeEvidenceValid(day: HospicePricingDayInput): boolean {
  const evidence = day.providerUsualCharge;
  if (!evidence) return false;
  return (
    Number.isSafeInteger(evidence.amountCents) &&
    evidence.amountCents > 0 &&
    evidence.serviceDate === day.serviceDate &&
    evidence.providerEntityId === day.payerContext.providerEntityId &&
    evidence.serviceCategory === day.serviceCategory &&
    effectiveEvidenceValid({ ...evidence, assessedAt: day.payerContext.assessedAt })
  );
}

function unresolvedSegment(
  from: string,
  to: string,
  serviceCategory: HospicePricingSegment["serviceCategory"],
  status: HospicePricingSegment["status"],
  reasonCode: string,
): HospicePricingSegment {
  return {
    serviceFrom: from,
    serviceTo: to,
    serviceCategory,
    status,
    reasonCodes: [reasonCode],
    rateEvidence: null,
    quantity: null,
    quantityEvidence: [],
    baseReimbursementCents: null,
    reimbursementEstimateCents: null,
    actualBilledChargeCents: null,
    payerAllowedAmountCents: null,
    actualPaymentCents: null,
    appliedCeilings: [],
  };
}

function priceOneDay(
  day: HospicePricingDayInput,
  rates: readonly PayerRatePolicyFact[],
): HospicePricingSegment {
  const serviceDateTime = isoTime(day.serviceDate);
  if (serviceDateTime === null) {
    return unresolvedSegment(
      day.serviceDate,
      day.serviceDate,
      day.serviceCategory,
      "unsupported",
      "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
    );
  }
  const lookup: PayerRatePolicyLookup = {
    ...day.payerContext,
    localityCode: localityForDay(day),
    serviceCategory: day.serviceCategory,
    unitBasis: day.unitBasis,
    electionDayNumber: electionDayForDay(day),
    serviceFrom: day.serviceDate,
    serviceTo: day.serviceDate,
  };
  if (lookup.localityCode === null) {
    return unresolvedSegment(
      day.serviceDate,
      day.serviceDate,
      day.serviceCategory,
      "unresolved",
      "RATE_LOCALITY_UNRESOLVED",
    );
  }
  if (
    lookup.programKind === "oregon_ffs" &&
    day.serviceCategory === "RHC" &&
    lookup.electionDayNumber === null
  ) {
    return unresolvedSegment(
      day.serviceDate,
      day.serviceDate,
      day.serviceCategory,
      "unresolved",
      "RATE_ELECTION_DAY_UNRESOLVED",
    );
  }
  const [selection] = resolvePayerRatePolicySegments(lookup, rates);
  if (!selection || selection.status !== "qualified" || !selection.rate) {
    const status = selection?.status ?? "missing";
    const resultStatus =
      status === "ambiguous"
        ? "ambiguous"
        : status === "unsupported"
          ? "unsupported"
          : "unresolved";
    return unresolvedSegment(
      day.serviceDate,
      day.serviceDate,
      day.serviceCategory,
      resultStatus,
      selection?.reasonCode ?? "MEDICAID_RATE_POLICY_UNRESOLVED",
    );
  }
  const rate = selection.rate;
  const rateEvidence = {
    id: rate.id,
    version: rate.version,
    canonicalPayerId: rate.canonicalPayerId,
    programKind: rate.programKind,
    providerEntityId: rate.providerEntityId,
    localityCode: rate.localityCode,
    unitBasis: rate.unitBasis,
    rateCents: rate.rateCents,
    sourceKind: rate.sourceKind,
    sourceDocumentRef: rate.sourceDocumentRef!,
    verifiedAt: rate.verifiedAt!,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
    methodologyVersion: rate.methodologyVersion,
    pricingMethod: rate.pricingMethod,
    quantityConversionMethod: rate.quantityConversionMethod,
    minimumDurationMethod: rate.minimumDurationMethod,
    minimumClinicalMinutes: rate.minimumClinicalMinutes,
    maximumClinicalMinutes: rate.maximumClinicalMinutes ?? null,
    roundingMode: rate.roundingMode,
    roundingBoundary: rate.roundingBoundary,
    chargeCeilingMethod: rate.chargeCeilingMethod,
    chargeCeilingBoundary: rate.chargeCeilingBoundary,
    chargeCeilingCents: rate.chargeCeilingCents,
    qualityReportingApplicability: rate.qualityReportingApplicability,
    qualityReportingStatus: rate.qualityReportingStatus,
    qualityReportingEvidenceReference: day.payerContext.qualityReporting.evidenceReference!,
    qualityReportingEvidenceVersion: day.payerContext.qualityReporting.evidenceVersion!,
    qualityReportingVerifiedAt: day.payerContext.qualityReporting.verifiedAt!,
    localityEvidenceReference: day.localityEvidence!.sourceReference,
    localityEvidenceVersion: day.localityEvidence!.version,
    localityVerifiedAt: day.localityEvidence!.verifiedAt,
    electionDayEvidenceReference: day.electionDayEvidence?.sourceReference ?? null,
    electionDayEvidenceVersion: day.electionDayEvidence?.version ?? null,
    electionDayVerifiedAt: day.electionDayEvidence?.verifiedAt ?? null,
    electionDayNumber: electionDayForDay(day),
    inpatientRespiteEvidenceReference: day.inpatientRespiteDayEvidence?.sourceReference ?? null,
    inpatientRespiteEvidenceVersion: day.inpatientRespiteDayEvidence?.version ?? null,
    inpatientRespiteVerifiedAt: day.inpatientRespiteDayEvidence?.verifiedAt ?? null,
    inpatientRespiteEpisodeReference: day.inpatientRespiteDayEvidence?.episodeReference ?? null,
    inpatientRespiteConsecutiveDayNumber: inpatientRespiteDayForDay(day),
  };
  if (day.payerContext.serviceState === "OR" && day.serviceCategory === "IRC") {
    const respiteDay = inpatientRespiteDayForDay(day);
    if (respiteDay === null) {
      return {
        ...unresolvedSegment(
          day.serviceDate,
          day.serviceDate,
          day.serviceCategory,
          "partial",
          "INPATIENT_RESPITE_SEQUENCE_UNRESOLVED",
        ),
        rateEvidence,
      };
    }
    if (respiteDay > 5) {
      return {
        ...unresolvedSegment(
          day.serviceDate,
          day.serviceDate,
          day.serviceCategory,
          "unsupported",
          "INPATIENT_RESPITE_LIMIT_EXCEEDED",
        ),
        rateEvidence,
      };
    }
  }
  if (!quantityValid(day)) {
    return {
      ...unresolvedSegment(
        day.serviceDate,
        day.serviceDate,
        day.serviceCategory,
        "partial",
        "CLINICAL_QUANTITY_UNRESOLVED",
      ),
      rateEvidence,
    };
  }
  if (
    rate.minimumDurationMethod === "minimum_minutes" &&
    day.quantity?.unitBasis === "per_hour" &&
    day.quantity.clinicalMinutes < (rate.minimumClinicalMinutes ?? Number.POSITIVE_INFINITY)
  ) {
    return {
      ...unresolvedSegment(
        day.serviceDate,
        day.serviceDate,
        day.serviceCategory,
        "unsupported",
        "PRICING_MINIMUM_DURATION_NOT_MET",
      ),
      rateEvidence,
      quantity: day.quantity,
      quantityEvidence: [day.quantityEvidence!],
    };
  }
  if (
    rate.unitBasis === "per_hour" &&
    rate.quantityConversionMethod === "hourly_prorated_minutes" &&
    rate.roundingBoundary === "segment"
  ) {
    return {
      ...unresolvedSegment(
        day.serviceDate,
        day.serviceDate,
        day.serviceCategory,
        "partial",
        "RATE_UNIT_CONVERSION_UNQUALIFIED",
      ),
      reasonCodes: [],
      rateEvidence,
      quantity: day.quantity,
      quantityEvidence: [day.quantityEvidence!],
    };
  }
  const calculated = amountFor(rate, day.quantity!);
  if (calculated.amount === null) {
    return {
      ...unresolvedSegment(
        day.serviceDate,
        day.serviceDate,
        day.serviceCategory,
        "unsupported",
        calculated.reasonCode ?? "PRICING_METHOD_UNSUPPORTED",
      ),
      rateEvidence,
      quantity: day.quantity,
      quantityEvidence: [day.quantityEvidence!],
    };
  }
  let estimate: number | null = calculated.amount;
  const appliedCeilings: HospicePricingSegment["appliedCeilings"][number][] = [];
  const reasonCodes: string[] = [];
  if (rate.chargeCeilingMethod === "contract_maximum") {
    const cap = rate.chargeCeilingCents;
    if (cap === null) {
      estimate = null;
      reasonCodes.push("RATE_CHARGE_CEILING_UNRESOLVED");
    } else if (rate.chargeCeilingBoundary === "segment") {
      // The source-backed segment ceiling is applied after contiguous identical rate facts are grouped.
    } else {
      estimate = Math.min(calculated.amount, cap);
      appliedCeilings.push({
        method: "contract_maximum",
        amountCents: cap,
        boundary: "service_day",
        evidenceReference: rate.sourceDocumentRef,
        evidenceVersion: rate.version,
        evidenceVerifiedAt: rate.verifiedAt,
      });
    }
  } else if (rate.chargeCeilingMethod === "lower_of_rate_and_usual_charge") {
    if (!chargeEvidenceValid(day)) {
      estimate = null;
      reasonCodes.push("RATE_CHARGE_CEILING_UNRESOLVED");
    } else {
      const charge = day.providerUsualCharge!.amountCents;
      estimate = Math.min(calculated.amount, charge);
      appliedCeilings.push({
        method: "lower_of_rate_and_usual_charge",
        amountCents: charge,
        boundary: "service_day",
        evidenceReference: day.providerUsualCharge!.sourceReference,
        evidenceVersion: day.providerUsualCharge!.version,
        evidenceVerifiedAt: day.providerUsualCharge!.verifiedAt,
      });
    }
  } else if (rate.chargeCeilingMethod !== "none") {
    estimate = null;
    reasonCodes.push("RATE_CHARGE_CEILING_UNRESOLVED");
  }
  return {
    serviceFrom: day.serviceDate,
    serviceTo: day.serviceDate,
    serviceCategory: day.serviceCategory,
    status: estimate === null ? "partial" : "resolved",
    reasonCodes,
    rateEvidence,
    quantity: day.quantity,
    quantityEvidence: [day.quantityEvidence!],
    baseReimbursementCents: calculated.amount,
    reimbursementEstimateCents: estimate,
    actualBilledChargeCents: null,
    payerAllowedAmountCents: null,
    actualPaymentCents: null,
    appliedCeilings,
  };
}

function addSafeCents(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return safeCents(BigInt(left) + BigInt(right));
}

function combineQuantity(
  left: HospicePricingQuantity | null,
  right: HospicePricingQuantity | null,
): HospicePricingQuantity | null | undefined {
  if (left === null || right === null) return left === right ? null : undefined;
  if (left.unitBasis !== right.unitBasis) return undefined;
  if (left.unitBasis === "per_day" && right.unitBasis === "per_day") {
    const units = left.units + right.units;
    return Number.isSafeInteger(units) ? { unitBasis: "per_day", units } : undefined;
  }
  if (left.unitBasis === "per_hour" && right.unitBasis === "per_hour") {
    const clinicalMinutes = left.clinicalMinutes + right.clinicalMinutes;
    return Number.isSafeInteger(clinicalMinutes)
      ? { unitBasis: "per_hour", clinicalMinutes }
      : undefined;
  }
  return undefined;
}

function finalizeGroupedSegment(segment: HospicePricingSegment): HospicePricingSegment {
  const evidence = segment.rateEvidence;
  if (!evidence || !segment.quantity || segment.reasonCodes.length > 0) return segment;
  let base = segment.baseReimbursementCents;
  if (
    base === null &&
    !(evidence.roundingBoundary === "segment" && evidence.unitBasis === "per_hour")
  ) {
    return {
      ...segment,
      status: "unsupported",
      reasonCodes: ["MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED"],
      reimbursementEstimateCents: null,
    };
  }
  if (
    evidence.roundingBoundary === "segment" &&
    evidence.unitBasis === "per_hour" &&
    evidence.quantityConversionMethod === "hourly_prorated_minutes"
  ) {
    if (segment.quantity.unitBasis !== "per_hour") {
      return {
        ...segment,
        status: "unsupported",
        reasonCodes: ["RATE_UNIT_CONVERSION_UNQUALIFIED"],
        baseReimbursementCents: null,
        reimbursementEstimateCents: null,
      };
    }
    const rounded = roundedRatio(
      BigInt(evidence.rateCents) * BigInt(segment.quantity.clinicalMinutes),
      60n,
      evidence.roundingMode,
    );
    base = rounded === null ? null : safeCents(rounded);
    if (base === null) {
      return {
        ...segment,
        status: "unsupported",
        reasonCodes: ["RATE_UNIT_CONVERSION_UNQUALIFIED"],
        baseReimbursementCents: null,
        reimbursementEstimateCents: null,
      };
    }
  }
  let estimate =
    evidence.roundingBoundary === "segment" &&
    evidence.unitBasis === "per_hour" &&
    evidence.quantityConversionMethod === "hourly_prorated_minutes"
      ? base
      : segment.reimbursementEstimateCents;
  const appliedCeilings = [...segment.appliedCeilings];
  if (
    evidence.chargeCeilingMethod === "contract_maximum" &&
    evidence.chargeCeilingBoundary === "segment"
  ) {
    if (evidence.chargeCeilingCents === null || estimate === null) {
      return {
        ...segment,
        status: "partial",
        reasonCodes: ["RATE_CHARGE_CEILING_UNRESOLVED"],
        baseReimbursementCents: base,
        reimbursementEstimateCents: null,
      };
    }
    estimate = Math.min(estimate, evidence.chargeCeilingCents);
    appliedCeilings.push({
      method: "contract_maximum",
      amountCents: evidence.chargeCeilingCents,
      boundary: "segment",
      evidenceReference: evidence.sourceDocumentRef,
      evidenceVersion: evidence.version,
      evidenceVerifiedAt: evidence.verifiedAt,
    });
  }
  return {
    ...segment,
    status: estimate === null ? "partial" : "resolved",
    reasonCodes: [],
    baseReimbursementCents: base,
    reimbursementEstimateCents: estimate,
    appliedCeilings,
  };
}

function coalesce(segments: readonly HospicePricingSegment[]): HospicePricingSegment[] {
  const result: HospicePricingSegment[] = [];
  for (const next of segments) {
    const prior = result.at(-1);
    const quantity = prior ? combineQuantity(prior.quantity, next.quantity) : undefined;
    if (
      prior &&
      next.serviceFrom === nextDate(prior.serviceTo) &&
      prior.status === next.status &&
      prior.serviceCategory === next.serviceCategory &&
      prior.reasonCodes.join("|") === next.reasonCodes.join("|") &&
      prior.rateEvidence?.id === next.rateEvidence?.id &&
      prior.rateEvidence?.version === next.rateEvidence?.version &&
      prior.rateEvidence?.pricingMethod === next.rateEvidence?.pricingMethod &&
      quantity !== undefined &&
      prior.actualBilledChargeCents === null
    ) {
      const evidenceByIdentity = new Map<string, VerifiedQuantityEvidence>();
      for (const item of [...prior.quantityEvidence, ...next.quantityEvidence]) {
        evidenceByIdentity.set(
          `${item.sourceReference}\u0000${item.version}\u0000${item.verifiedAt}`,
          item,
        );
      }
      result[result.length - 1] = {
        ...prior,
        serviceTo: next.serviceTo,
        quantity,
        quantityEvidence: [...evidenceByIdentity.values()],
        baseReimbursementCents: addSafeCents(
          prior.baseReimbursementCents,
          next.baseReimbursementCents,
        ),
        reimbursementEstimateCents: addSafeCents(
          prior.reimbursementEstimateCents,
          next.reimbursementEstimateCents,
        ),
        appliedCeilings: [...prior.appliedCeilings, ...next.appliedCeilings],
      };
    } else {
      result.push(next);
    }
  }
  return result.map(finalizeGroupedSegment);
}

/**
 * Pure, deterministic pricing assessment. Inputs are owner-resolved facts; unknown locality, quantity,
 * election-day or ceiling evidence stays explicit. It never returns a billed charge, payer allowed amount,
 * payment, posting instruction, or submission authorization.
 */
export function assessHospicePricing(input: {
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly assessedAt: string;
  readonly days: readonly HospicePricingDayInput[];
  readonly rates: readonly PayerRatePolicyFact[];
}): HospicePricingAssessment {
  const start = isoTime(input.serviceFrom);
  const end = isoTime(input.serviceTo);
  const assessedAt = Date.parse(input.assessedAt);
  if (start === null || end === null || start > end || !Number.isFinite(assessedAt)) {
    return {
      status: "unsupported",
      assessedAt: input.assessedAt,
      coversRequestedPeriod: false,
      segments: [
        unresolvedSegment(
          input.serviceFrom,
          input.serviceTo,
          null,
          "unsupported",
          "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
        ),
      ],
      reimbursementEstimateTotalCents: null,
      actualBilledChargeTotalCents: null,
      payerAllowedAmountCents: null,
      actualPaymentCents: null,
      submissionAvailable: false,
    };
  }
  const byDate = new Map<string, HospicePricingDayInput[]>();
  for (const day of input.days) {
    if (
      isoTime(day.serviceDate) === null ||
      day.serviceDate < input.serviceFrom ||
      day.serviceDate > input.serviceTo
    ) {
      return {
        status: "unsupported",
        assessedAt: input.assessedAt,
        coversRequestedPeriod: false,
        segments: [
          unresolvedSegment(
            input.serviceFrom,
            input.serviceTo,
            null,
            "unsupported",
            "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
          ),
        ],
        reimbursementEstimateTotalCents: null,
        actualBilledChargeTotalCents: null,
        payerAllowedAmountCents: null,
        actualPaymentCents: null,
        submissionAvailable: false,
      };
    }
    if (Date.parse(day.payerContext.assessedAt) !== assessedAt) {
      return {
        status: "unsupported",
        assessedAt: input.assessedAt,
        coversRequestedPeriod: false,
        segments: [
          unresolvedSegment(
            input.serviceFrom,
            input.serviceTo,
            null,
            "unsupported",
            "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
          ),
        ],
        reimbursementEstimateTotalCents: null,
        actualBilledChargeTotalCents: null,
        payerAllowedAmountCents: null,
        actualPaymentCents: null,
        submissionAvailable: false,
      };
    }
    const dateRows = byDate.get(day.serviceDate) ?? [];
    dateRows.push(day);
    byDate.set(day.serviceDate, dateRows);
  }
  const dailyResults: HospicePricingSegment[] = [];
  let hasDuplicateDate = false;
  let cursor = start;
  const observedDates = [...byDate.keys()].sort();
  for (const date of observedDates) {
    const time = isoTime(date)!;
    if (time > cursor) {
      dailyResults.push(
        unresolvedSegment(
          dateString(cursor),
          dateString(time - DAY_MS),
          null,
          "unresolved",
          "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
        ),
      );
    }
    const days = byDate.get(date)!;
    if (days.length > 1) {
      hasDuplicateDate = true;
      dailyResults.push(
        unresolvedSegment(date, date, null, "ambiguous", "MEDICAID_RATE_POLICY_AMBIGUOUS"),
      );
    } else {
      dailyResults.push(priceOneDay(days[0]!, input.rates));
    }
    cursor = time + DAY_MS;
  }
  if (cursor <= end) {
    dailyResults.push(
      unresolvedSegment(
        dateString(cursor),
        dateString(end),
        null,
        "unresolved",
        "MEDICAID_RATE_POLICY_INPUTS_UNRESOLVED",
      ),
    );
  }
  const localityFactsByIdentity = new Map<string, EffectiveHospiceFact>();
  for (const day of input.days) {
    const localityCode = localityForDay(day);
    const evidence = day.localityEvidence;
    if (!localityCode || !evidence) continue;
    const fact: EffectiveHospiceFact = {
      dimension: "loc",
      from: evidence.effectiveFrom,
      to: evidence.effectiveTo ?? input.serviceTo,
      identity: `${evidence.serviceState}:${localityCode}`,
      status: "verified",
      sourceRecordId: evidence.sourceReference,
    };
    localityFactsByIdentity.set(
      `${fact.sourceRecordId}:${fact.from}:${fact.to}:${fact.identity}`,
      fact,
    );
  }
  const rateFacts: EffectiveHospiceFact[] = [];
  for (const segment of dailyResults) {
    const evidence = segment.rateEvidence;
    if (!evidence) continue;
    const identity = `${evidence.id}:${evidence.version}:${evidence.methodologyVersion}`;
    const prior = rateFacts.at(-1);
    if (
      prior?.identity === identity &&
      nextDate(prior.to) === segment.serviceFrom &&
      prior.sourceRecordId === evidence.sourceDocumentRef
    ) {
      rateFacts[rateFacts.length - 1] = { ...prior, to: segment.serviceTo };
    } else {
      rateFacts.push({
        dimension: "rate",
        from: segment.serviceFrom,
        to: segment.serviceTo,
        identity,
        status: "verified",
        sourceRecordId: evidence.sourceDocumentRef,
      });
    }
  }
  const quantityByDate = new Map<string, HospiceQuantityEvidence>();
  for (const day of input.days) {
    if (!quantityValid(day) || !day.quantity || !day.quantityEvidence) continue;
    quantityByDate.set(day.serviceDate, {
      kind: day.quantity.unitBasis === "per_day" ? "daily" : "hourly",
      ...(day.quantity.unitBasis === "per_day"
        ? { units: day.quantity.units }
        : { minutes: day.quantity.clinicalMinutes }),
      sourceRecordId: day.quantityEvidence.sourceReference,
      verified: true,
    } as HospiceQuantityEvidence);
  }
  // Use the established service-window segmenter to preserve locality/rate boundaries; price assembly
  // then coalesces only identical rate and policy evidence inside those authoritative spans.
  const serviceWindows = segmentHospiceServiceWindow({
    from: input.serviceFrom,
    to: input.serviceTo,
    facts: [...localityFactsByIdentity.values(), ...rateFacts],
    quantityByDate,
    requiredDimensions: ["loc", "rate"],
  });
  const segments = coalesceWithinServiceWindows(dailyResults, serviceWindows);
  const fullyResolved =
    !hasDuplicateDate &&
    segments.every(
      (segment) => segment.status === "resolved" && segment.reimbursementEstimateCents !== null,
    );
  const hasAmbiguity = segments.some((segment) => segment.status === "ambiguous");
  const hasUnsupported = segments.some((segment) => segment.status === "unsupported");
  const hasAnyResolved = segments.some((segment) => segment.rateEvidence !== null);
  const total = fullyResolved
    ? safeCents(
        segments.reduce((sum, segment) => sum + BigInt(segment.reimbursementEstimateCents!), 0n),
      )
    : null;
  const status =
    fullyResolved && total !== null
      ? "fully_resolved"
      : hasAmbiguity
        ? "ambiguous"
        : hasUnsupported
          ? "unsupported"
          : fullyResolved
            ? "unsupported"
            : hasAnyResolved
              ? "partially_resolved"
              : "unresolved";
  return {
    status,
    assessedAt: input.assessedAt,
    coversRequestedPeriod:
      segments.length > 0 &&
      segments[0]?.serviceFrom === input.serviceFrom &&
      segments.at(-1)?.serviceTo === input.serviceTo,
    segments,
    reimbursementEstimateTotalCents: status === "fully_resolved" ? total : null,
    actualBilledChargeTotalCents: null,
    payerAllowedAmountCents: null,
    actualPaymentCents: null,
    submissionAvailable: false,
  };
}

function coalesceWithinServiceWindows(
  dailyResults: readonly HospicePricingSegment[],
  serviceWindows: readonly { readonly from: string; readonly to: string }[],
): HospicePricingSegment[] {
  const output: HospicePricingSegment[] = [];
  for (const window of serviceWindows) {
    const rows = dailyResults.flatMap((segment) => {
      const from = segment.serviceFrom < window.from ? window.from : segment.serviceFrom;
      const to = segment.serviceTo > window.to ? window.to : segment.serviceTo;
      return from <= to ? [{ ...segment, serviceFrom: from, serviceTo: to }] : [];
    });
    if (rows.length === 0) continue;
    output.push(...coalesce(rows));
  }
  return output;
}
