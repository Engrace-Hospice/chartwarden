// apps/backend/__tests__/bereavement-pre-death-assessor.test.ts — ADR-0109 D5: the `bereavement_pre_death_assessor` ABAC
// predicate (who may draft a risk assessment before the death) and the pure rules around the draft itself.
import type { AbacContext } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  type BereavementAbacResolver,
  type PreDeathAssessorProbe,
  buildBereavementAbacPredicates,
  denyStubBereavementAbacResolver,
} from "../src/modules/16-bereavement/abac-predicates";
import {
  BereavementStateError,
  EMPTY_DRAFT_FACTORS,
  assertDraftWritable,
  draftFactorsForReader,
  draftFactorsForStorage,
} from "../src/modules/16-bereavement/lifecycle/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

const ctx = (overrides: Partial<AbacContext> = {}): AbacContext => ({
  organizationId: ORG,
  userId: USER,
  roles: [],
  providerEntityIds: [],
  locationIds: [],
  attributes: { membershipId: "55555555-5555-4555-8555-555555555555", sessionClass: "staff" },
  ...overrides,
});

const probe = (over: Partial<PreDeathAssessorProbe> = {}): PreDeathAssessorProbe => ({
  async patientOfAdmission() {
    return PATIENT;
  },
  async isOnCareTeam() {
    return true;
  },
  ...over,
});

const predicateWith = (
  assessor: PreDeathAssessorProbe | undefined,
  resolver: BereavementAbacResolver = denyStubBereavementAbacResolver,
) => {
  const predicates = buildBereavementAbacPredicates({
    resolver,
    ...(assessor === undefined ? {} : { preDeathAssessor: assessor }),
  });
  const predicate = predicates.bereavement_pre_death_assessor;
  if (!predicate) throw new Error("bereavement_pre_death_assessor is not registered");
  return predicate;
};

describe("bereavement_pre_death_assessor", () => {
  it.each([
    ["an MSW", ["msw"]],
    ["a chaplain", ["chaplain"]],
    ["a bereavement counselor", ["bereavement_counselor"]],
  ])("admits %s who is on the patient's care team", async (_name, roles) => {
    const predicate = predicateWith(probe());
    expect(await predicate(ctx({ roles }), { admissionId: ADMISSION })).toBe(true);
  });

  it("denies one of those disciplines who is NOT on the care team", async () => {
    const predicate = predicateWith(probe({ isOnCareTeam: async () => false }));
    expect(await predicate(ctx({ roles: ["msw"] }), { admissionId: ADMISSION })).toBe(false);
  });

  it("admits an oversight role without a care-team seat", async () => {
    const predicate = predicateWith(probe({ isOnCareTeam: async () => false }));
    for (const role of [
      "clinical_supervisor",
      "director_of_nursing",
      "bereavement_coordinator",
      "compliance_officer",
    ]) {
      expect(await predicate(ctx({ roles: [role] }), { admissionId: ADMISSION })).toBe(true);
    }
  });

  it("denies a volunteer even when on the care team", async () => {
    const predicate = predicateWith(probe());
    expect(
      await predicate(ctx({ roles: ["bereavement_volunteer"] }), { admissionId: ADMISSION }),
    ).toBe(false);
    expect(await predicate(ctx({ roles: ["volunteer"] }), { admissionId: ADMISSION })).toBe(false);
  });

  it("denies a portal session whatever its roles", async () => {
    const predicate = predicateWith(probe());
    for (const sessionClass of ["patient_portal", "caregiver_portal", "bereaved_portal"]) {
      expect(
        await predicate(
          ctx({ roles: ["msw"], attributes: { sessionClass, portalAccountId: "acct-1" } }),
          { admissionId: ADMISSION },
        ),
      ).toBe(false);
    }
  });

  it("denies a discipline outside the set (an RN, a billing specialist)", async () => {
    const predicate = predicateWith(probe());
    expect(await predicate(ctx({ roles: ["rn_case_manager"] }), { admissionId: ADMISSION })).toBe(
      false,
    );
    expect(
      await predicate(ctx({ roles: ["billing_specialist"] }), { admissionId: ADMISSION }),
    ).toBe(false);
  });

  it("falls back to the resolver's discipline when the session roles evidence none", async () => {
    const resolver: BereavementAbacResolver = {
      ...denyStubBereavementAbacResolver,
      async disciplineOf() {
        return "chaplain";
      },
    };
    const predicate = predicateWith(probe(), resolver);
    expect(await predicate(ctx({ roles: ["x"] }), { admissionId: ADMISSION })).toBe(true);
  });

  describe("fails closed", () => {
    it("with no probe bound", async () => {
      const predicate = predicateWith(undefined);
      expect(await predicate(ctx({ roles: ["msw"] }), { admissionId: ADMISSION })).toBe(false);
    });

    it("when the target names no admission", async () => {
      const predicate = predicateWith(probe());
      expect(await predicate(ctx({ roles: ["msw"] }), {})).toBe(false);
    });

    it("when the admission does not resolve to a patient (absent or another tenant's)", async () => {
      const predicate = predicateWith(probe({ patientOfAdmission: async () => null }));
      expect(await predicate(ctx({ roles: ["msw"] }), { admissionId: ADMISSION })).toBe(false);
    });

    it("when the care-team read throws", async () => {
      const predicate = predicateWith(
        probe({
          isOnCareTeam: async () => {
            throw new Error("m5 unavailable");
          },
        }),
      );
      expect(await predicate(ctx({ roles: ["msw"] }), { admissionId: ADMISSION })).toBe(false);
    });

    it("when the admission read throws", async () => {
      const predicate = predicateWith(
        probe({
          patientOfAdmission: async () => {
            throw new Error("m6 unavailable");
          },
        }),
      );
      expect(await predicate(ctx({ roles: ["msw"] }), { admissionId: ADMISSION })).toBe(false);
    });

    it("when the session names no user", async () => {
      const predicate = predicateWith(probe());
      expect(await predicate(ctx({ roles: ["msw"], userId: "" }), { admissionId: ADMISSION })).toBe(
        false,
      );
    });
  });
});

describe("draft factor rules", () => {
  const stated = {
    ambivalentRelationship: true,
    suddenUnexpectedDeath: false,
    priorUnresolvedLoss: "unknown",
    preExistingMentalHealth: true,
    socialIsolation: false,
    financialStrain: "unknown",
    primaryCaregiverRole: true,
    activeSubstanceUse: true,
  } as const;

  it("an empty draft is all unknown", () => {
    expect(Object.values(EMPTY_DRAFT_FACTORS)).toEqual(Array(8).fill("unknown"));
  });

  it("forces the substance-use slot to unknown unless the writer is cleared for Part 2 content", () => {
    expect(draftFactorsForStorage(stated, false).activeSubstanceUse).toBe("unknown");
    expect(draftFactorsForStorage(stated, true).activeSubstanceUse).toBe(true);
    // everything else is stored as stated
    expect(draftFactorsForStorage(stated, false).ambivalentRelationship).toBe(true);
    expect(draftFactorsForStorage(stated, false).socialIsolation).toBe(false);
  });

  it("an uncleared writer keeps the stored substance-use value instead of overwriting it with unknown", () => {
    const storedByCleared = { ...stated, activeSubstanceUse: true };
    const blindRewrite = { ...stated, activeSubstanceUse: "unknown" as const };
    expect(draftFactorsForStorage(blindRewrite, false, storedByCleared).activeSubstanceUse).toBe(
      true,
    );
    expect(
      draftFactorsForStorage(blindRewrite, false, { ...stated, activeSubstanceUse: false })
        .activeSubstanceUse,
    ).toBe(false);
    // a value the uncleared writer tries to SET never lands either; nothing stored (or a malformed slot) stays unknown
    const attempt = { ...stated, activeSubstanceUse: true as const };
    expect(draftFactorsForStorage(attempt, false, undefined).activeSubstanceUse).toBe("unknown");
    expect(
      draftFactorsForStorage(attempt, false, { activeSubstanceUse: "yes" }).activeSubstanceUse,
    ).toBe("unknown");
    // a cleared writer's statement is stored as stated, whatever was there
    expect(draftFactorsForStorage(blindRewrite, true, storedByCleared).activeSubstanceUse).toBe(
      "unknown",
    );
    // the other slots are always the writer's own
    expect(
      draftFactorsForStorage(blindRewrite, false, storedByCleared).ambivalentRelationship,
    ).toBe(true);
  });

  it("an uncleared reader never sees a stored substance-use value", () => {
    expect(draftFactorsForReader(stated, false).activeSubstanceUse).toBe("unknown");
    expect(draftFactorsForReader(stated, true).activeSubstanceUse).toBe(true);
  });

  it("reads a malformed stored vector as unknowns, never as false", () => {
    expect(draftFactorsForReader({ ambivalentRelationship: "yes", bogus: true }, true)).toEqual(
      EMPTY_DRAFT_FACTORS,
    );
    expect(draftFactorsForReader(null, true)).toEqual(EMPTY_DRAFT_FACTORS);
  });

  it("is writable only while no plan exists (409 DRAFT_LOCKED)", () => {
    expect(() => assertDraftWritable(false)).not.toThrow();
    try {
      assertDraftWritable(true);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BereavementStateError);
      expect((error as BereavementStateError).code).toBe("DRAFT_LOCKED");
      expect((error as BereavementStateError).statusCode).toBe(409);
    }
  });
});
