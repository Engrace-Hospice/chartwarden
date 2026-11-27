import type { PayerRatePolicyFact } from "@chartwarden/medicaid-adapters";
import { describe, expect, it } from "vitest";
import type { IrcPricingEpisodeFacts } from "./rhc-pricing-snapshot";
import { resolveIrcDailyPricingPlan } from "./rhc-pricing-snapshot";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  providerEntityId: "00000000-0000-4000-8000-000000000002",
  patientId: "00000000-0000-4000-8000-000000000003",
  admissionId: "00000000-0000-4000-8000-000000000004",
  admissionVersion: 2,
  canonicalPayerId: "00000000-0000-4000-8000-000000000005",
  programKind: "managed_care" as const,
  serviceState: "OR",
  serviceFrom: "2025-12-01",
  serviceTo: "2025-12-03",
  assessedAt: "2026-11-26T12:00:00.000Z",
};

const episode: IrcPricingEpisodeFacts = {
  organizationId: scope.organizationId,
  providerEntityId: scope.providerEntityId,
  patientId: scope.patientId,
  admissionId: scope.admissionId,
  locPeriodId: "00000000-0000-4000-8000-000000000006",
  ipuAdmissionId: "00000000-0000-4000-8000-000000000007",
  ipuAdmissionVersion: 1,
  ipuAdmissionUpdatedAt: new Date("2026-11-26T11:00:00.000Z"),
  ipuAdmissionKind: "arranged",
  ipuAdmissionState: "discharged",
  ipuAdmissionClosedAt: new Date("2025-12-04T05:00:00.000Z"),
  ipuAdmissionClosedLocalDate: "2025-12-04",
  episodeId: "00000000-0000-4000-8000-000000000008",
  episodeVersion: 1,
  episodeState: "closed",
  episodeStartedAt: new Date("2025-11-29T05:00:00.000Z"),
  episodeUpdatedAt: new Date("2026-11-26T11:00:00.000Z"),
  episodeStartedLocalDate: "2025-11-29",
  episodeExpectedEndAt: new Date("2025-12-04T05:00:00.000Z"),
  episodeExpectedEndLocalDate: "2025-12-04",
  episodeClosedAt: new Date("2025-12-04T05:00:00.000Z"),
  episodeClosedLocalDate: "2025-12-04",
  consecutiveDayCount: 5,
  carriedOverDays: 0,
  capOverrideInvoked: false,
  remoteStayId: "00000000-0000-4000-8000-000000000009",
  remoteStayVersion: 1,
  facilityId: "00000000-0000-4000-8000-00000000000a",
  remoteStayStartedAt: new Date("2025-11-29T05:00:00.000Z"),
  remoteStayUpdatedAt: new Date("2026-11-26T11:00:00.000Z"),
  remoteStayStartedLocalDate: "2025-11-29",
  remoteStayEndedAt: new Date("2025-12-04T05:00:00.000Z"),
  remoteStayEndLocalDate: "2025-12-04",
  agreementDocumentId: "00000000-0000-4000-8000-00000000000b",
  arrangementBillingBasis: "bundled",
  serviceTimeZone: "America/New_York",
  transitionBeforeServiceEnd: false,
};

const evidence = {
  id: "00000000-0000-4000-8000-00000000000c",
  organizationId: scope.organizationId,
  providerEntityId: scope.providerEntityId,
  patientId: scope.patientId,
  admissionId: scope.admissionId,
  admissionVersion: 2,
  canonicalPayerId: scope.canonicalPayerId,
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  localityEvidenceReference: "evidence:synthetic-irc/locality",
  localityEvidenceVersion: 1,
  qualityReportingApplicability: "not_required",
  qualityReportingStatus: "not_applicable",
  qualityEvidenceReference: "evidence:synthetic-irc/quality",
  qualityEvidenceVersion: 1,
  serviceCategory: "IRC",
  quantityPolicy: "m37_irc_episode_daily_v1",
  quantityEvidenceOwner: "m37_irc_episode_and_remote_stay",
  billingUnit: "daily",
  revenueCode: "0655",
  hcpcsCode: "Q5005",
  codingProfile: "local_draft_only",
  codingEvidenceReference: "evidence:synthetic-irc/local-code",
  codingEvidenceVersion: 1,
  billedChargeCentsPerUnit: 22_000,
  chargeEvidenceReference: "evidence:synthetic-irc/provider-charge",
  chargeEvidenceVersion: 1,
  verificationStatus: "verified",
  effectiveFrom: "2025-12-01",
  effectiveTo: "2025-12-03",
  sourceDocumentReference: "doc:synthetic-irc/billing-evidence",
  verifiedAt: new Date("2026-11-26T11:00:00.000Z"),
  version: 1,
} as Parameters<typeof resolveIrcDailyPricingPlan>[0]["evidence"];

const rate: PayerRatePolicyFact = {
  id: "00000000-0000-4000-8000-00000000000d",
  organizationId: scope.organizationId,
  providerEntityId: scope.providerEntityId,
  canonicalPayerId: scope.canonicalPayerId,
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  serviceCategory: "IRC",
  unitBasis: "per_day",
  bucketFrom: null,
  bucketTo: null,
  electionDayBasis: "unqualified",
  rateCents: 18_000,
  chargeCeilingCents: null,
  pricingMethod: "per_day",
  quantityConversionMethod: "daily_units",
  minimumDurationMethod: "not_applicable",
  minimumClinicalMinutes: null,
  methodologyVersion: 1,
  roundingMode: "exact_only",
  roundingBoundary: "not_applicable",
  chargeCeilingMethod: "none",
  chargeCeilingBoundary: "not_applicable",
  qualityReportingApplicability: "not_required",
  qualityReportingStatus: "not_applicable",
  sourceKind: "cco_contract",
  verificationStatus: "verified",
  effectiveFrom: "2025-12-01",
  effectiveTo: "2025-12-03",
  sourceDocumentRef: "doc:synthetic-irc/rate",
  verifiedAt: "2026-11-26T11:00:00.000Z",
  verifiedByMembershipId: "00000000-0000-4000-8000-00000000000e",
  recordedByMembershipId: "00000000-0000-4000-8000-00000000000f",
  createdAt: "2026-11-26T10:00:00.000Z",
  supersedesId: null,
  version: 1,
};

const locPeriod = {
  id: episode.locPeriodId,
  version: 2,
  updatedAt: new Date("2026-11-26T10:00:00.000Z"),
  levelOfCare: "inpatient_respite_care" as const,
  effectiveAt: new Date("2025-11-29T05:00:00.000Z"),
  endedAt: new Date("2025-12-04T05:00:00.000Z"),
  facilityId: episode.facilityId,
};

describe("source-backed daily IRC pricing plan", () => {
  it("preserves episode days 3–5 across a month boundary with separate reimbursement and charges", () => {
    const result = resolveIrcDailyPricingPlan({
      scope,
      evidence,
      locPeriods: [locPeriod],
      rates: [rate],
      episode,
      facilityKinds: new Map([[episode.facilityId, "hospital"]]),
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      serviceFrom: "2025-12-01",
      serviceTo: "2025-12-03",
      units: 3,
      rateCents: 18_000,
      reimbursementEstimateCents: 54_000,
      chargesCents: 66_000,
      snapshotSchemaVersion: 4,
      integrityFacts: {
        institutionalFormatQualified: false,
        postingAuthorized: false,
        episode: { consecutiveDayFrom: 3, consecutiveDayTo: 5 },
      },
    });
  });

  it("refuses a sixth episode day, carryover, transitions and a mismatched facility", () => {
    const sixthDay = { ...episode, consecutiveDayCount: 6 };
    expect(
      resolveIrcDailyPricingPlan({
        scope,
        evidence,
        locPeriods: [locPeriod],
        rates: [rate],
        episode: sixthDay,
        facilityKinds: new Map([[episode.facilityId, "hospital"]]),
      }),
    ).toMatchObject({ status: "unsupported", reasonCode: "INPATIENT_RESPITE_LIMIT_EXCEEDED" });
    for (const changed of [
      { ...episode, carriedOverDays: 1 },
      { ...episode, transitionBeforeServiceEnd: true },
    ]) {
      expect(
        resolveIrcDailyPricingPlan({
          scope,
          evidence,
          locPeriods: [locPeriod],
          rates: [rate],
          episode: changed,
          facilityKinds: new Map([[episode.facilityId, "hospital"]]),
        }).status,
      ).toBe("unresolved");
    }
    expect(
      resolveIrcDailyPricingPlan({
        scope,
        evidence,
        locPeriods: [locPeriod],
        rates: [rate],
        episode,
        facilityKinds: new Map([[episode.facilityId, "alf"]]),
      }),
    ).toMatchObject({ status: "unresolved", reasonCode: "IRC_LOC_STAY_OR_FACILITY_MISMATCH" });
  });
});
