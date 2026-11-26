import type { ChcClinicalQuantityResult, ChcDailyObservedQuantity } from "./chc-clinical-quantity";

export const CHC_SYNTHETIC_MANAGED_CARE_METHOD =
  "m6_symptom_crisis_plus_signed_m8_rn_intervals_v1" as const;

export interface ChcLocEligibilityFact {
  readonly id: string;
  readonly version: number;
  readonly levelOfCare: string;
  readonly status: string;
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
  readonly reason: string | null;
  readonly assignedBy: string | null;
}

export interface ChcEligibilityMethodEvidence {
  readonly method: string;
  readonly sourceReference: string;
  readonly version: number;
  readonly verifiedAt: string;
  readonly verificationStatus: string;
  readonly maximumClinicalMinutes: number;
  readonly minimumClinicalMinutes: number;
}

export type ChcClinicalQualificationResult =
  | {
      readonly status: "qualified";
      readonly days: readonly {
        readonly serviceDate: string;
        readonly observedMinutes: number;
        readonly qualifiedMinutes: number;
        readonly sourceEncounters: ChcDailyObservedQuantity["sourceEncounters"];
        readonly eligibilityEvidence: {
          readonly locPeriodId: string;
          readonly locPeriodVersion: number;
          readonly methodReference: string;
          readonly methodVersion: number;
        };
      }[];
      readonly institutionalUnits: "unqualified";
    }
  | { readonly status: "unresolved" | "ambiguous" | "unsupported"; readonly reasonCode: string };

/**
 * Convert M8's observation into a qualified local CHC quantity only when the M6 clinical assignment and
 * verified payer-method evidence agree. This method is intentionally limited to a synthetic managed-care
 * contract profile; it is not an Oregon FFS or EOCCO rule.
 */
export function qualifyChcClinicalQuantity(input: {
  readonly observation: ChcClinicalQuantityResult;
  readonly locPeriods: readonly ChcLocEligibilityFact[];
  readonly method: ChcEligibilityMethodEvidence;
  readonly assessedAt: string;
}): ChcClinicalQualificationResult {
  if (input.observation.status !== "observed") {
    return {
      status: input.observation.status,
      reasonCode: input.observation.reasonCode,
    };
  }
  const assessedAt = Date.parse(input.assessedAt);
  const verifiedAt = Date.parse(input.method.verifiedAt);
  if (
    !Number.isFinite(assessedAt) ||
    input.method.verificationStatus !== "verified" ||
    input.method.method !== CHC_SYNTHETIC_MANAGED_CARE_METHOD ||
    !input.method.sourceReference ||
    !Number.isSafeInteger(input.method.version) ||
    input.method.version < 1 ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > assessedAt ||
    !Number.isSafeInteger(input.method.maximumClinicalMinutes) ||
    input.method.maximumClinicalMinutes < 1 ||
    !Number.isSafeInteger(input.method.minimumClinicalMinutes) ||
    input.method.minimumClinicalMinutes < 1
  ) {
    return { status: "unresolved", reasonCode: "CHC_ELIGIBILITY_METHOD_UNQUALIFIED" };
  }

  const days: readonly Extract<
    ChcClinicalQuantityResult,
    { status: "observed" }
  >["days"][number][] = input.observation.days;
  const qualified = [];
  for (const day of days) {
    const dayStart = Date.parse(day.serviceDayStart);
    const dayEnd = Date.parse(day.serviceDayEnd);
    if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd) || dayEnd <= dayStart) {
      return { status: "unresolved", reasonCode: "CHC_LOCAL_DAY_BOUNDARY_UNRESOLVED" };
    }
    const candidates = input.locPeriods.filter((period) => {
      const periodStart = period.effectiveAt.getTime();
      const periodEnd = period.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return periodStart <= dayStart && periodEnd >= dayEnd;
    });
    if (candidates.length !== 1) {
      return {
        status: candidates.length > 1 ? "ambiguous" : "unresolved",
        reasonCode:
          candidates.length > 1 ? "CHC_LOC_ASSIGNMENT_AMBIGUOUS" : "CHC_LOC_ASSIGNMENT_MISSING",
      };
    }
    const loc = candidates[0]!;
    if (
      loc.levelOfCare !== "continuous_home_care" ||
      (loc.status !== "active" && loc.status !== "ended") ||
      loc.reason !== "symptom_crisis" ||
      !loc.assignedBy ||
      !Number.isSafeInteger(loc.version) ||
      loc.version < 0
    ) {
      return { status: "unsupported", reasonCode: "CHC_CLINICAL_INDICATION_UNQUALIFIED" };
    }
    if (day.actualClinicalMinutes < input.method.minimumClinicalMinutes) {
      return { status: "unsupported", reasonCode: "CHC_MINIMUM_CLINICAL_DURATION_NOT_MET" };
    }
    if (day.actualClinicalMinutes > input.method.maximumClinicalMinutes) {
      return { status: "unsupported", reasonCode: "CHC_POLICY_MAXIMUM_CLINICAL_DURATION_EXCEEDED" };
    }
    if (
      day.sourceEncounters.length === 0 ||
      day.sourceEncounters.some((source) => source.discipline !== "rn")
    ) {
      return { status: "unsupported", reasonCode: "CHC_QUALIFYING_DISCIPLINE_UNSUPPORTED" };
    }
    qualified.push({
      serviceDate: day.serviceDate,
      observedMinutes: day.actualClinicalMinutes,
      qualifiedMinutes: day.actualClinicalMinutes,
      sourceEncounters: day.sourceEncounters,
      eligibilityEvidence: {
        locPeriodId: loc.id,
        locPeriodVersion: loc.version,
        methodReference: input.method.sourceReference,
        methodVersion: input.method.version,
      },
    });
  }
  return { status: "qualified", days: qualified, institutionalUnits: "unqualified" };
}
