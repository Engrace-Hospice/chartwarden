// @wardenx/billing — shared pure-domain test fixtures for the M23 validation-rule tests. Builds a fully
// PASSING `ValidationContext` (every applicable default rule passes; the cap + sia rules SKIP because
// their seams/inputs are intentionally absent — a non-blocking deny-stub skip). PURE plain-data: no DB,
// no Fastify, no clock, no PHI/MBI (D13). Each builder returns a FRESH object so tests can mutate freely.
import { CMS_HOSPICE_MODIFIER_VALUE_SET, type ValidationContext } from "@wardenx/billing";

/**
 * A fully-passing `ValidationContext` for a single routine-home-care TOB-812 first-interim claim:
 *   • eligibility = active Part A, fresh (5 days)
 *   • one open election period (seq 1) covering the whole service window, CTI signed, no recert/F2F due
 *   • one RHC line on 2026-03-15 (rev 0651, Q5001=home), matching its LOC period
 *   • HIPPS derivation structurally coherent; NOE ack-accepted; physician active+licensed; EVV compliant
 *   • sia = null (skip / not_applicable), capProjection = null + capProjectionBound=false (skip / deny-stub)
 */
export function passingContext(): ValidationContext {
  return {
    orgId: "org-1",
    asOfDate: "2026-03-01",
    macJurisdiction: "ngs_j6",
    claim: {
      claimId: "claim-1",
      providerEntityId: "pe-1",
      patientId: "pat-1",
      admissionId: "adm-1",
      tob: "812",
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
      replacesClaimId: null,
      icd10Sequence: [{ position: 1, code: "G30.9", relationship: "terminal" }],
      diagnosesWithheldForConsent: 0,
      terminalDiagnosisWithheldForConsent: false,
      totalChargeCents: 200_00,
      priorClaimTob: null,
      priorClaimServiceTo: null,
      dischargeDate: null,
      dischargeReason: null,
      dischargeClaimCodes: {
        patientStatus: "30",
        conditionCodes: [],
        occurrenceCodes: [],
        unresolved: null,
      },
    },
    lines: [
      {
        claimLineId: "line-1",
        serviceDate: "2026-03-15",
        revenueCode: "0651",
        qCode: "Q5001",
        levelOfCare: "routine_home_care",
        hcpcs: null,
        modifiers: [],
        unitCount: 1,
        unitRateCents: 200_00,
        lineChargeCents: 200_00,
        icdPointerPositions: [1],
        backingEncounterIds: ["enc-1"],
      },
    ],
    electionPeriods: [
      {
        sequence: 1,
        effectiveFrom: "2026-02-01",
        effectiveTo: null,
        revoked: false,
        revocationDate: null,
      },
    ],
    certifications: [
      {
        electionPeriodSequence: 1,
        ctiSigned: true,
        ctiSignedDate: "2026-02-01",
        attendingCosignRequired: false,
        attendingCosigned: false,
      },
    ],
    faceToFace: [],
    levelOfCarePeriods: [
      {
        levelOfCare: "routine_home_care",
        from: "2026-02-01",
        to: "2026-12-31",
        chcDocumentedHours: null,
        gipAdmissionCriteriaDocumented: null,
      },
    ],
    billableEncounters: [
      { encounterId: "enc-1", serviceDate: "2026-03-15", billability: "billable" },
    ],
    signedEncounters: [],
    evvBrackets: [{ encounterId: "enc-1", bracketState: "compliant" }],
    terminology: {
      valueSetMembership: { [CMS_HOSPICE_MODIFIER_VALUE_SET]: ["GV", "GW"] },
      icd10Billable: { "G30.9": true },
    },
    mdm: {
      attending: null,
      hospicePhysician: {
        npi: "1234567893",
        status: "active",
        licenseUnexpiredOnServiceDates: true,
      },
      placeOfService: "home",
    },
    hipps: {
      hippsCode: "HCODE",
      perDiemRateCents: 200_00,
      wageIndexFactorApplied: "0.9234",
      segments: [
        {
          levelOfCare: "routine_home_care",
          dateFrom: "2026-03-01",
          dateTo: "2026-03-31",
          ratePerDiemCents: 200_00,
          rhcDayBucket: "days_61_plus",
        },
      ],
    },
    sia: null,
    capProjection: null,
    eligibility: {
      outcome: "active_part_a",
      checkedAt: "2026-02-24T00:00:00.000Z",
      asOfDate: "2026-03-01",
      ageDays: 5,
    },
    noe: { state: "ack_accepted", admissionDay: 2, windowBreached: false },
    sequestration: { percentage: "2.0", effectiveFrom: "2026-01-01", effectiveTo: null },
    wageIndex: {
      ccn: "123456",
      fiscalYearStarting: 2026,
      factorDecimal: "0.9234",
      cbsaCode: "99999",
    },
    seams: {
      capProjectionBound: false,
      mdmResolverBound: true,
      terminologyBound: true,
      eligibilityBound: true,
    },
  };
}
