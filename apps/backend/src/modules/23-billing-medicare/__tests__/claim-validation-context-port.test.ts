import { BillingRuleRegistry, noeTimeliness5d, type repositories } from "@wardenx/billing";
// apps/backend/src/modules/23-billing-medicare/__tests__/claim-validation-context-port.test.ts — the production
// ValidationContextPort reads the admission's EFFECTIVE NOE. Before the fix it used
// `NoeRepository.findActiveByAdmission`, which excludes `ack_accepted` (that read means "still in flight"), so a
// claim whose NOE Medicare had ACCEPTED validated as "No Notice of Election".
//
// PARTIAL-mocks `@wardenx/billing`'s data ports (the claim lines, the patient's claims, the NOE rows) with an
// in-memory NOE table that mirrors both repository reads' documented state filters; every pure derivation
// (facts, HIPPS, the rule) stays real. The SQL itself is proven live (`test:m23:noe-draft:live`).
import { describe, expect, it, vi } from "vitest";
import type { ClaimAssemblySeams } from "../services/claim-assembly";
import { buildClaimValidationContextPort } from "../services/claim-validation-context-port";

interface FakeNoe {
  readonly id: string;
  readonly admissionId: string;
  readonly state: string;
  readonly createdAt: Date;
  readonly windowBreachedAt: Date | null;
}
const NOES: FakeNoe[] = [];

vi.mock("@wardenx/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wardenx/billing")>();
  const latest = (rows: FakeNoe[]) =>
    [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  class NoeRepository {
    async findActiveByAdmission(admissionId: string) {
      return latest(
        NOES.filter(
          (n) =>
            n.admissionId === admissionId &&
            !["ack_accepted", "cancelled", "ack_rejected"].includes(n.state),
        ),
      );
    }
    async findEffectiveByAdmission(admissionId: string) {
      return latest(
        NOES.filter(
          (n) => n.admissionId === admissionId && !["cancelled", "ack_rejected"].includes(n.state),
        ),
      );
    }
  }
  class ClaimLineRepository {
    async listForClaim() {
      return [];
    }
  }
  class ClaimRepository {
    async listByOrgPage() {
      return { items: [], nextCursor: null };
    }
  }
  return {
    ...actual,
    repositories: { ...actual.repositories, NoeRepository, ClaimLineRepository, ClaimRepository },
  };
});

const ADMISSION = "adm-1";

function seams(): ClaimAssemblySeams {
  return {
    patientPayer: {
      medicarePrimaryForRange: async () => ({ patientPayerId: "pp-1", medicarePrimary: true }),
    },
    admission: {
      resolveForRange: async () => ({
        admissionId: ADMISSION,
        hospiceAdmissionDate: "2025-11-01",
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
    },
    ruleRegistry: new BillingRuleRegistry(),
    outbox: { publish: async () => undefined },
    now: () => new Date("2025-11-20T00:00:00.000Z"),
  } as ClaimAssemblySeams;
}

const CLAIM = {
  id: "claim-1",
  providerEntityId: "pe-1",
  patientId: "pat-1",
  admissionId: ADMISSION,
  tob: "812",
  serviceFrom: "2025-11-01",
  serviceTo: "2025-11-15",
  replacesClaimId: null,
  totalChargeCents: 0,
} as unknown as repositories.ClaimRecord;

async function noeRuleFor(rows: FakeNoe[]) {
  NOES.splice(0, NOES.length, ...rows);
  const port = buildClaimValidationContextPort({
    seams: seams(),
    eligibilityBound: false,
    now: () => new Date("2025-11-20T00:00:00.000Z"),
  });
  const { context } = await port.build(
    {} as never,
    { organizationId: "org-1", userId: "u", membershipId: "m", actorKind: "user" } as never,
    CLAIM,
  );
  return {
    context,
    result: noeTimeliness5d.check(context, noeTimeliness5d.defaultParameters ?? {}),
  };
}

const noe = (state: string, createdAt: string, id = state): FakeNoe => ({
  id,
  admissionId: ADMISSION,
  state,
  createdAt: new Date(createdAt),
  windowBreachedAt: null,
});

describe("ValidationContextPort — the admission's effective NOE", () => {
  it("an ACCEPTED NOE is the NOE (it validated as 'No Notice of Election' before)", async () => {
    const { context, result } = await noeRuleFor([noe("ack_accepted", "2025-11-02T00:00:00Z")]);
    expect(context.noe?.state).toBe("ack_accepted");
    expect(result.passed).toBe(true);
  });

  it("a rejected then re-filed and accepted NOE reads the accepted one", async () => {
    const { context } = await noeRuleFor([
      noe("ack_rejected", "2025-11-02T00:00:00Z"),
      noe("ack_accepted", "2025-11-03T00:00:00Z"),
    ]);
    expect(context.noe?.state).toBe("ack_accepted");
  });

  it("an in-flight NOE is still read (submitted, past the window → block)", async () => {
    const { context, result } = await noeRuleFor([noe("submitted", "2025-11-02T00:00:00Z")]);
    expect(context.noe?.state).toBe("submitted");
    expect(result.passed).toBe(false);
  });

  it("only cancelled / rejected NOEs → no NOE", async () => {
    const { context, result } = await noeRuleFor([
      noe("cancelled", "2025-11-02T00:00:00Z"),
      noe("ack_rejected", "2025-11-03T00:00:00Z"),
    ]);
    expect(context.noe).toBeNull();
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/No Notice of Election/);
  });
});
