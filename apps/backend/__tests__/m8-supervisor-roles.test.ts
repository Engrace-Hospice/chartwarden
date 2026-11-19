// M8 supervisor role keys — one shared set (supervisor-roles.ts) used by the route `isSupervisor`
// guard, the `is_author_or_supervisor` ABAC predicate and the cosignature-SLA cron lookup. The
// canonical DON key is `director_of_nursing` (packages/auth/src/roles/templates.ts); M8 used to
// recognise only `clinical_supervisor | don`, so a DON did not resolve as a supervisor.
import { describe, expect, it } from "vitest";
import { buildEncounterAbacPredicates } from "../src/modules/08-encounters/abac-predicates";
import {
  SUPERVISOR_ROLE_KEYS,
  hasSupervisorRole,
} from "../src/modules/08-encounters/supervisor-roles";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ENCOUNTER = "00000000-0000-4000-8000-0000000000e1";
const AUTHOR_MEMBERSHIP = "00000000-0000-4000-8000-0000000000b1";
const CALLER_MEMBERSHIP = "00000000-0000-4000-8000-0000000000b2";

describe("SUPERVISOR_ROLE_KEYS", () => {
  it("is the four-key supervisor set (migration 1103 precedent)", () => {
    expect([...SUPERVISOR_ROLE_KEYS].sort()).toEqual(
      ["clinical_lead", "clinical_supervisor", "director_of_nursing", "don"].sort(),
    );
  });
});

describe("hasSupervisorRole (route isSupervisor guard)", () => {
  it.each(["director_of_nursing", "clinical_supervisor", "don", "clinical_lead"])(
    "is true for %s",
    (key) => {
      expect(hasSupervisorRole(["rn", key])).toBe(true);
    },
  );

  it.each([["rn"], ["aide"], ["org_admin"], []])("is false for %j", (...roles) => {
    expect(hasSupervisorRole(roles.flat() as string[])).toBe(false);
  });
});

describe("is_author_or_supervisor ABAC predicate", () => {
  const predicates = buildEncounterAbacPredicates({
    resolver: {
      loadEncounter: async (_org: string, id: string) =>
        id === ENCOUNTER
          ? { patientId: "p1", authoredByUserId: AUTHOR_MEMBERSHIP, discipline: "rn" }
          : null,
      loadAddendumAuthor: async () => null,
    } as never,
    isInCaseload: async () => false,
  });
  const contextFor = (roles: string[]) =>
    ({
      organizationId: ORG,
      userId: "user_caller",
      roles,
      attributes: { membershipId: CALLER_MEMBERSHIP },
    }) as never;

  it.each(["director_of_nursing", "clinical_supervisor", "don", "clinical_lead"])(
    "lets a non-author %s through for a real in-org encounter",
    async (key) => {
      const ok = await predicates.is_author_or_supervisor?.(contextFor([key]), {
        encounterId: ENCOUNTER,
      });
      expect(ok).toBe(true);
    },
  );

  it("denies a non-author RN", async () => {
    const ok = await predicates.is_author_or_supervisor?.(contextFor(["rn"]), {
      encounterId: ENCOUNTER,
    });
    expect(ok).toBe(false);
  });

  it("still fails closed for a supervisor naming an unknown encounter", async () => {
    const ok = await predicates.is_author_or_supervisor?.(contextFor(["director_of_nursing"]), {
      encounterId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(ok).toBe(false);
  });
});
