import { describe, expect, it } from "vitest";
import { qualifyChcClinicalQuantity } from "./chc-clinical-qualification";
import { resolveSignedChcClinicalQuantity } from "./chc-clinical-quantity";

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
const locPeriod = {
  id: "88888888-8888-4888-8888-888888888888",
  version: 4,
  levelOfCare: "continuous_home_care",
  status: "ended",
  effectiveAt: new Date("2026-11-01T07:00:00.000Z"),
  endedAt: new Date("2026-11-02T08:00:00.000Z"),
  reason: "symptom_crisis",
  assignedBy: "synthetic-m6-assignment-source",
};
const method = {
  method: "m6_symptom_crisis_plus_signed_m8_rn_intervals_v1",
  sourceReference: "doc:synthetic-chc/qualification-method",
  version: 1,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  verificationStatus: "verified",
  minimumClinicalMinutes: 1,
  maximumClinicalMinutes: 600,
};

function observed() {
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
    encounters: [interval],
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
