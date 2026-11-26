import { describe, expect, it } from "vitest";
import {
  type ChcEligibilityMethodEvidence,
  type ChcLocEligibilityFact,
  qualifyChcClinicalQuantity,
} from "./chc-clinical-qualification";
import {
  type SignedChcEncounterFact,
  resolveSignedChcClinicalQuantity,
} from "./chc-clinical-quantity";

const serviceDate = "2026-11-01";
const assessmentTime = "2026-11-04T00:00:00.000Z";
const interval = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  providerEntityId: "22222222-2222-4222-8222-222222222222",
  patientId: "33333333-3333-4333-8333-333333333333",
  admissionId: "44444444-4444-4444-8444-444444444444",
  encounterId: "55555555-5555-4555-8555-555555555555",
  serviceDate,
  status: "signed",
  signedAt: "2026-11-02T03:00:00.000Z",
  startedAt: "2026-11-01T17:00:00.000Z",
  endedAt: "2026-11-02T02:00:00.000Z",
  timeSource: "clinician" as const,
  sourceVersion: 3,
  discipline: "rn",
  locationId: "77777777-7777-4777-8777-777777777777",
};
const locPeriod: ChcLocEligibilityFact = {
  id: "88888888-8888-4888-8888-888888888888",
  version: 4,
  levelOfCare: "continuous_home_care",
  status: "ended",
  effectiveAt: new Date("2026-11-01T07:00:00.000Z"),
  endedAt: new Date("2026-11-02T08:00:00.000Z"),
  reason: "symptom_crisis",
  assignedBy: "synthetic-m6-assignment-source",
};
const method: ChcEligibilityMethodEvidence = {
  method: "m6_symptom_crisis_plus_signed_m8_rn_intervals_v1",
  sourceReference: "doc:synthetic-chc/qualification-method",
  version: 1,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  verificationStatus: "verified",
  minimumClinicalMinutes: 1,
  maximumClinicalMinutes: 600,
};

function observed(encounters: readonly SignedChcEncounterFact[] = [interval]) {
  return resolveSignedChcClinicalQuantity({
    organizationId: interval.organizationId,
    providerEntityId: interval.providerEntityId,
    patientId: interval.patientId,
    admissionId: interval.admissionId,
    serviceFrom: serviceDate,
    serviceTo: serviceDate,
    serviceTimeZone: "America/Los_Angeles",
    assessedAt: assessmentTime,
    chcServiceDates: [serviceDate],
    encounters,
  });
}

function qualify(overrides: {
  observation?: ReturnType<typeof observed>;
  locPeriods?: readonly ChcLocEligibilityFact[];
  method?: ChcEligibilityMethodEvidence;
  assessedAt?: string;
}) {
  return qualifyChcClinicalQuantity({
    observation: overrides.observation ?? observed(),
    locPeriods: overrides.locPeriods ?? [locPeriod],
    method: overrides.method ?? method,
    assessedAt: overrides.assessedAt ?? assessmentTime,
  });
}

describe("CHC clinical eligibility is separate from observed signed intervals", () => {
  it("qualifies actual signed RN minutes only with the source-backed synthetic managed-care method and M6 crisis LOC", () => {
    const observation = observed();
    expect(observation).toMatchObject({
      status: "observed",
      payerEligibility: "unresolved",
      institutionalUnits: "unqualified",
      days: [{ actualClinicalMinutes: 540 }],
    });
    expect(
      qualifyChcClinicalQuantity({
        observation,
        locPeriods: [locPeriod],
        method,
        assessedAt: assessmentTime,
      }),
    ).toMatchObject({
      status: "qualified",
      days: [
        {
          observedMinutes: 540,
          qualifiedMinutes: 540,
          eligibilityEvidence: { locPeriodVersion: 4, methodVersion: 1 },
        },
      ],
      institutionalUnits: "unqualified",
    });
  });

  it("does not promote an unsigned policy or a non-crisis LOC into CHC eligibility", () => {
    expect(
      qualifyChcClinicalQuantity({
        observation: observed(),
        locPeriods: [locPeriod],
        method: { ...method, verificationStatus: "pending" },
        assessedAt: assessmentTime,
      }),
    ).toMatchObject({ status: "unresolved", reasonCode: "CHC_ELIGIBILITY_METHOD_UNQUALIFIED" });
    expect(
      qualifyChcClinicalQuantity({
        observation: observed(),
        locPeriods: [{ ...locPeriod, reason: "routine_care" }],
        method,
        assessedAt: assessmentTime,
      }),
    ).toMatchObject({ status: "unsupported", reasonCode: "CHC_CLINICAL_INDICATION_UNQUALIFIED" });
  });
});

describe("CHC clinical duration bounds from the verified method", () => {
  it("refuses a day below the method minimum and accepts one exactly at it", () => {
    const below = qualify({ method: { ...method, minimumClinicalMinutes: 541 } });
    const atMinimum = qualify({ method: { ...method, minimumClinicalMinutes: 540 } });

    expect(below).toEqual({
      status: "unsupported",
      reasonCode: "CHC_MINIMUM_CLINICAL_DURATION_NOT_MET",
    });
    expect(atMinimum.status).toBe("qualified");
  });

  it("refuses a day above the method maximum and accepts one exactly at it", () => {
    const above = qualify({ method: { ...method, maximumClinicalMinutes: 539 } });
    const atMaximum = qualify({ method: { ...method, maximumClinicalMinutes: 540 } });

    expect(above).toEqual({
      status: "unsupported",
      reasonCode: "CHC_POLICY_MAXIMUM_CLINICAL_DURATION_EXCEEDED",
    });
    expect(atMaximum.status).toBe("qualified");
  });
});

describe("CHC qualification requires RN source encounters", () => {
  it.each(["lpn", "aide", "social_worker", null])(
    "refuses a day whose only source discipline is %s",
    (discipline) => {
      const result = qualify({ observation: observed([{ ...interval, discipline }]) });

      expect(result).toEqual({
        status: "unsupported",
        reasonCode: "CHC_QUALIFYING_DISCIPLINE_UNSUPPORTED",
      });
    },
  );

  it("refuses a day when any one of its source encounters is not an RN", () => {
    const rnVisit = { ...interval, endedAt: "2026-11-01T20:00:00.000Z" };
    const lpnVisit = {
      ...interval,
      encounterId: "66666666-6666-4666-8666-666666666666",
      startedAt: "2026-11-01T20:00:00.000Z",
      endedAt: "2026-11-01T22:00:00.000Z",
      discipline: "lpn",
    };

    const result = qualify({ observation: observed([rnVisit, lpnVisit]) });

    expect(result).toEqual({
      status: "unsupported",
      reasonCode: "CHC_QUALIFYING_DISCIPLINE_UNSUPPORTED",
    });
  });
});

describe("CHC qualification needs exactly one covering M6 level-of-care period", () => {
  it("is unresolved with no LOC period at all", () => {
    expect(qualify({ locPeriods: [] })).toEqual({
      status: "unresolved",
      reasonCode: "CHC_LOC_ASSIGNMENT_MISSING",
    });
  });

  it("is unresolved when the only LOC period starts after the local day began", () => {
    const lateStart = { ...locPeriod, effectiveAt: new Date("2026-11-01T12:00:00.000Z") };

    expect(qualify({ locPeriods: [lateStart] })).toEqual({
      status: "unresolved",
      reasonCode: "CHC_LOC_ASSIGNMENT_MISSING",
    });
  });

  it("is unresolved when the only LOC period ends before the local day ended", () => {
    const earlyEnd = { ...locPeriod, endedAt: new Date("2026-11-02T00:00:00.000Z") };

    expect(qualify({ locPeriods: [earlyEnd] })).toEqual({
      status: "unresolved",
      reasonCode: "CHC_LOC_ASSIGNMENT_MISSING",
    });
  });

  it("is ambiguous when two LOC periods both cover the local day", () => {
    const duplicate = { ...locPeriod, id: "99999999-9999-4999-8999-999999999999", version: 5 };

    expect(qualify({ locPeriods: [locPeriod, duplicate] })).toEqual({
      status: "ambiguous",
      reasonCode: "CHC_LOC_ASSIGNMENT_AMBIGUOUS",
    });
  });

  it("qualifies against a still-active, open-ended CHC period and cites its id and version", () => {
    const open = { ...locPeriod, status: "active", endedAt: null };

    expect(qualify({ locPeriods: [open] })).toMatchObject({
      status: "qualified",
      days: [{ eligibilityEvidence: { locPeriodId: locPeriod.id, locPeriodVersion: 4 } }],
    });
  });
});

describe("CHC qualification refuses an LOC period that is not a documented symptom crisis", () => {
  const unqualifiedPeriods: readonly (readonly [string, Partial<ChcLocEligibilityFact>])[] = [
    ["no recorded reason", { reason: null }],
    ["a different recorded reason", { reason: "family_request" }],
    ["a non-CHC level of care", { levelOfCare: "routine_home_care" }],
    ["a status that is neither active nor ended", { status: "scheduled" }],
    ["no assigning source", { assignedBy: null }],
    ["a negative version", { version: -1 }],
  ];

  it.each(unqualifiedPeriods)("refuses a period with %s", (_label, override) => {
    const result = qualify({ locPeriods: [{ ...locPeriod, ...override }] });

    expect(result).toEqual({
      status: "unsupported",
      reasonCode: "CHC_CLINICAL_INDICATION_UNQUALIFIED",
    });
  });
});

describe("CHC qualification method evidence must be verified before the assessment", () => {
  it("refuses a method verified after the assessment instant", () => {
    const result = qualify({ method: { ...method, verifiedAt: "2026-11-05T00:00:00.000Z" } });

    expect(result).toEqual({
      status: "unresolved",
      reasonCode: "CHC_ELIGIBILITY_METHOD_UNQUALIFIED",
    });
  });

  it("accepts a method verified exactly at the assessment instant", () => {
    const result = qualify({ method: { ...method, verifiedAt: assessmentTime } });

    expect(result.status).toBe("qualified");
  });

  const unqualifiedMethods: readonly (readonly [string, Partial<ChcEligibilityMethodEvidence>])[] =
    [
      ["an unknown method name", { method: "some_other_method_v1" }],
      ["an empty source reference", { sourceReference: "" }],
      ["a zero version", { version: 0 }],
      ["an unparseable verification time", { verifiedAt: "not-a-date" }],
      ["a zero minimum", { minimumClinicalMinutes: 0 }],
      ["a zero maximum", { maximumClinicalMinutes: 0 }],
    ];

  it.each(unqualifiedMethods)("refuses a method with %s", (_label, override) => {
    const result = qualify({ method: { ...method, ...override } });

    expect(result).toEqual({
      status: "unresolved",
      reasonCode: "CHC_ELIGIBILITY_METHOD_UNQUALIFIED",
    });
  });

  it("refuses an unparseable assessment instant", () => {
    expect(qualify({ assessedAt: "not-a-date" })).toEqual({
      status: "unresolved",
      reasonCode: "CHC_ELIGIBILITY_METHOD_UNQUALIFIED",
    });
  });
});

describe("CHC qualification passes a non-observed quantity through unchanged", () => {
  it.each([
    ["unresolved", "CHC_ACTUAL_INTERVAL_EVIDENCE_MISSING"],
    ["ambiguous", "CHC_OVERLAPPING_CARE_INTERVALS_UNQUALIFIED"],
  ] as const)("keeps a %s observation's status and reason", (status, reasonCode) => {
    const result = qualify({ observation: { status, reasonCode } });

    expect(result).toEqual({ status, reasonCode });
  });
});
