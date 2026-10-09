// apps/backend/src/modules/23-billing-medicare/__tests__/_validation-seams-fixture.ts — a fixed reader-seam bundle
// for building the production ValidationContextPort without the M5/M6/M8/M40 seams: one routine-home-care
// admission (first period, no discharge), no encounters, no diagnoses, fixed reference data. Shared by the port's
// unit test and the NOE acknowledgment live suite (which runs the port's own NOE read over real Postgres).
// Not a test file (no `.test.ts`), so vitest never collects it.
import { BillingRuleRegistry } from "@wardenx/billing";
import type { ClaimAssemblySeams } from "../services/claim-assembly";

export function fixedValidationSeams(
  admission: { readonly admissionId: string; readonly hospiceAdmissionDate: string },
  now: Date,
): ClaimAssemblySeams {
  return {
    patientPayer: {
      medicarePrimaryForRange: async () => ({ patientPayerId: "pp-1", medicarePrimary: true }),
    },
    admission: {
      resolveForRange: async () => ({
        admissionId: admission.admissionId,
        hospiceAdmissionDate: admission.hospiceAdmissionDate,
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        placeOfDeath: null,
        transferOut: null,
      }),
    },
    electionPeriods: {
      coveringRange: async () => [
        {
          electionPeriodId: "ep-1",
          sequence: 1,
          effectiveFrom: "2025-11-01",
          effectiveTo: null,
          revoked: false,
          revocationDate: null,
        },
      ],
    },
    certifications: { forPatient: async () => [] },
    faceToFace: { forPatient: async () => [] },
    levelOfCare: {
      periodsInRange: async () => [
        {
          levelOfCarePeriodId: "loc-1",
          levelOfCare: "routine_home_care",
          from: "2025-11-01",
          to: "2025-11-30",
          chcDocumentedHours: null,
          gipAdmissionCriteriaDocumented: null,
        },
      ],
    },
    billableEncounters: { forRange: async () => [] },
    diagnoses: {
      forRange: async () => ({
        sequence: [],
        withheldForConsentCount: 0,
        terminalWithheldForConsent: false,
      }),
    },
    signedEncounters: { inWindow: async () => [] },
    evvCompliance: { bracketsForEncounters: async () => [] },
    mdm: {
      resolveProviderEntity: async () => ({
        ccn: "123456",
        macJurisdiction: "ngs_j6",
        cbsaCode: null,
      }),
      resolveClinicalParticipants: async () => ({
        attending: null,
        hospicePhysician: null,
        placeOfService: "home",
      }),
    },
    terminology: {
      resolveForClaim: async () => ({ valueSetMembership: {}, icd10Billable: {} }),
    },
    capProjection: {
      projectionForOrg: async () => ({
        status: "unavailable",
        aggregateProjectedCents: null,
        aggregateCapCents: null,
        pctOfCap: null,
        ipuWithinCap: null,
      }),
      projectionForPatient: async () => ({
        status: "unavailable",
        projectedCapCents: null,
        capLimitCents: null,
        withinCap: null,
      }),
    },
    referenceData: {
      hippsRateTable: async () => ({
        rhcDays1to60PerDiemCents: 20_000,
        rhcDays61PlusPerDiemCents: 16_000,
        chcHourlyRateCents: 6_250,
        ircPerDiemCents: 50_000,
        gipPerDiemCents: 100_000,
        rhcLaborShare: "0.6600",
        chcLaborShare: "0.6600",
        ircLaborShare: "0.5400",
        gipLaborShare: "0.6400",
      }),
      chcHourlyRateCents: async () => 6_000,
      wageIndexForCcn: async () => ({ factorDecimal: "1.0000", cbsaCode: null }),
      activeSequestrationPolicy: async () => ({
        sequestrationPolicyId: "seq-1",
        percentage: "2.00",
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
      }),
      visitChargeVersions: async () => [],
    },
    ruleRegistry: new BillingRuleRegistry(),
    outbox: { publish: async () => undefined },
    now: () => now,
  } as ClaimAssemblySeams;
}
