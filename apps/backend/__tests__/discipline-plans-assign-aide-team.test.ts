// apps/backend/__tests__/discipline-plans-assign-aide-team.test.ts — M15 §2.3: an Aide POC names the aide it directs and
// the RN who supervises that aide (`aide_membership_id` / `supervising_rn_membership_id`). Nothing wrote them before, so no
// plan could be finalized (`AIDE_ASSIGNMENT_REQUIRED`) and no supervisory visit could be recorded. `assignAideTeam` is the
// write: an author of the Aide POC (discipline_scope), on a writable plan the caller may touch, picks two members the plan
// location's roster lists with the right role. Drives the Drizzle write service over a fake tx and a fake roster port.
import { NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { DisciplinePlanStateError } from "../src/modules/15-discipline-care-plans/lifecycle/index";
import {
  type AideRosterPort,
  type AideRosterStaffRow,
  type M15WriteActor,
  buildDrizzleM15WriteService,
  systemM15Actor,
} from "../src/modules/15-discipline-care-plans/routes/index";

const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const LOCATION = "33333333-3333-4333-8333-333333333333";
const AIDE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNLISTED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLAN_ROW = {
  id: PLAN,
  organizationId: ORG,
  patientId: "p1",
  locationId: LOCATION,
  status: "active",
  kind: "aide_poc",
  version: 4,
  aideMembershipId: null,
  supervisingRnMembershipId: null,
};

const ROSTER: readonly AideRosterStaffRow[] = [
  { membershipId: AIDE, displayName: "Ada Aide", roleKey: "chha" },
  { membershipId: RN, displayName: "Rae Nurse", roleKey: "rn" },
  { membershipId: OTHER, displayName: "Olive Other", roleKey: "msw" },
];

let updates: Record<string, unknown>[] = [];
let rosterQueries: { organizationId: string; locationId: string; roleKeys: readonly string[] }[] =
  [];

function rosterPort(rows: readonly AideRosterStaffRow[] = ROSTER): AideRosterPort {
  return {
    async listStaffAtLocation(query) {
      rosterQueries.push(query);
      return rows.filter((row) => query.roleKeys.includes(row.roleKey));
    },
  };
}

/** select() answers in call order: the plan row, then the plan's versions. The guarded UPDATE returns the merged row
 *  (or nothing when `staleUpdate`). */
function fakeDb(
  plan: Record<string, unknown> = PLAN_ROW,
  staleUpdate = false,
  versions: readonly Record<string, unknown>[] = [],
) {
  updates = [];
  rosterQueries = [];
  const results: unknown[][] = [[plan], [...versions]];
  const tx = {
    execute: async () => [],
    select: () => {
      const rows = results.shift() ?? [];
      const chain: Promise<unknown[]> = Object.assign(Promise.resolve(rows), {
        from: (): unknown => chain,
        where: (): unknown => chain,
        orderBy: (): unknown => chain,
        limit: async () => rows,
      });
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => ({
            returning: async () =>
              staleUpdate ? [] : [{ ...plan, ...(versions[0] ?? {}), ...values }],
          }),
        };
      },
    }),
  };
  return { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never;
}

interface ServiceOptions {
  readonly plan?: Record<string, unknown>;
  readonly aideRoster?: AideRosterPort | null;
  readonly staleUpdate?: boolean;
  readonly inCaseload?: boolean;
  readonly versions?: readonly Record<string, unknown>[];
}

const service = ({
  plan,
  aideRoster = rosterPort(),
  staleUpdate = false,
  inCaseload = true,
  versions = [],
}: ServiceOptions = {}) =>
  buildDrizzleM15WriteService(fakeDb(plan, staleUpdate, versions), {
    isInCaseload: async () => inCaseload,
    ...(aideRoster === null ? {} : { aideRoster }),
  });

const actor = (roles: readonly string[]): M15WriteActor => ({
  organizationId: ORG,
  userId: "u_rn",
  membershipId: "m_rn",
  roles,
  sessionClass: "staff",
  actorKind: "user",
  locationIds: [],
  stepUpRecent: true,
});

const input = (over: Record<string, unknown> = {}) =>
  ({ expectedVersion: 4, aideMembershipId: AIDE, supervisingRnMembershipId: RN, ...over }) as never;

const rejection = async (promise: Promise<unknown>) =>
  (await promise.catch((e: unknown) => e)) as DisciplinePlanStateError;

describe("M15 assignAideTeam", () => {
  it("binds the picked aide and supervising RN to the plan and bumps the plan version", async () => {
    const view = await service().assignAideTeam(actor(["rn"]), PLAN, input());
    expect(updates[0]).toMatchObject({
      aideMembershipId: AIDE,
      supervisingRnMembershipId: RN,
      version: 5,
    });
    expect(view).toEqual({
      planId: PLAN,
      aideMembershipId: AIDE,
      supervisingRnMembershipId: RN,
      version: 5,
    });
  });

  it("asks the roster for the plan's own location and the right role keys, in the caller's org", async () => {
    await service().assignAideTeam(actor(["rn_case_manager"]), PLAN, input());
    expect(rosterQueries.length).toBeGreaterThan(0);
    for (const query of rosterQueries) {
      expect(query).toMatchObject({ organizationId: ORG, locationId: LOCATION });
    }
    const keys = new Set(rosterQueries.flatMap((q) => q.roleKeys));
    expect([...keys].sort()).toEqual(["chha", "rn", "rn_case_manager"]);
  });

  it("lets a plan be re-pointed: a new aide replaces the old one", async () => {
    const bound = { ...PLAN_ROW, aideMembershipId: OTHER, supervisingRnMembershipId: RN };
    await service({ plan: bound }).assignAideTeam(actor(["rn"]), PLAN, input());
    expect(updates[0]).toMatchObject({ aideMembershipId: AIDE });
  });

  it("refuses a member the roster does not list as an aide with 422 AIDE_NOT_ELIGIBLE", async () => {
    for (const aideMembershipId of [OTHER, RN, UNLISTED]) {
      const err = await rejection(
        service().assignAideTeam(actor(["rn"]), PLAN, input({ aideMembershipId })),
      );
      expect(err).toBeInstanceOf(DisciplinePlanStateError);
      expect(err.code).toBe("AIDE_NOT_ELIGIBLE");
      expect(err.statusCode).toBe(422);
    }
    expect(updates).toHaveLength(0);
  });

  it("refuses a member the roster does not list as an RN with 422 SUPERVISING_RN_NOT_ELIGIBLE", async () => {
    for (const supervisingRnMembershipId of [AIDE, OTHER, UNLISTED]) {
      const err = await rejection(
        service().assignAideTeam(actor(["rn"]), PLAN, input({ supervisingRnMembershipId })),
      );
      expect(err.code).toBe("SUPERVISING_RN_NOT_ELIGIBLE");
      expect(err.statusCode).toBe(422);
    }
    expect(updates).toHaveLength(0);
  });

  it("fails closed when no roster is bound: nobody is assignable", async () => {
    const err = await rejection(
      service({ aideRoster: null }).assignAideTeam(actor(["rn"]), PLAN, input()),
    );
    expect(err.code).toBe("AIDE_NOT_ELIGIBLE");
    expect(updates).toHaveLength(0);
  });

  it("is only for an Aide POC (422 NOT_AN_AIDE_POC)", async () => {
    const err = await rejection(
      service({ plan: { ...PLAN_ROW, kind: "msw_plan" } }).assignAideTeam(
        actor(["rn"]),
        PLAN,
        input(),
      ),
    );
    expect(err.code).toBe("NOT_AN_AIDE_POC");
    expect(err.statusCode).toBe(422);
  });

  it("refuses a caller whose roles cannot author an Aide POC (403 DISCIPLINE_SCOPE_VIOLATION)", async () => {
    for (const roles of [["msw"], ["chha"], ["lpn"], []]) {
      const err = await rejection(service().assignAideTeam(actor(roles), PLAN, input()));
      expect(err.code, roles.join(",")).toBe("DISCIPLINE_SCOPE_VIOLATION");
      expect(err.statusCode).toBe(403);
    }
    expect(updates).toHaveLength(0);
  });

  it("is refused on a discharged plan (409 PLAN_DISCHARGED)", async () => {
    const err = await rejection(
      service({ plan: { ...PLAN_ROW, status: "discharged" } }).assignAideTeam(
        actor(["rn"]),
        PLAN,
        input(),
      ),
    );
    expect(err.code).toBe("PLAN_DISCHARGED");
  });

  it("refuses a stale plan version (409 STALE_VERSION), before it reads the roster", async () => {
    const err = await rejection(
      service().assignAideTeam(actor(["rn"]), PLAN, input({ expectedVersion: 3 })),
    );
    expect(err.code).toBe("STALE_VERSION");
    expect(rosterQueries).toHaveLength(0);
  });

  it("reports a concurrent change that beats the guarded UPDATE as 409 STALE_VERSION", async () => {
    const err = await rejection(
      service({ staleUpdate: true }).assignAideTeam(actor(["rn"]), PLAN, input()),
    );
    expect(err.code).toBe("STALE_VERSION");
  });

  it("answers an off-caseload plan with the same not-found as a missing one", async () => {
    const err = await rejection(
      service({ inCaseload: false }).assignAideTeam(actor(["rn"]), PLAN, input()),
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(updates).toHaveLength(0);
  });

  it("lets the explicit system actor assign (internal callers hold no roles)", async () => {
    await service().assignAideTeam(
      systemM15Actor(ORG, { userId: "sys", membershipId: "sysm" }),
      PLAN,
      input(),
    );
    expect(updates[0]).toMatchObject({ aideMembershipId: AIDE });
  });
  it("refuses the same member as both aide and supervising RN (nobody supervises themself)", async () => {
    const both = [...ROSTER, { membershipId: OTHER, displayName: "Dual Role", roleKey: "chha" }];
    const dual = [...both, { membershipId: OTHER, displayName: "Dual Role", roleKey: "rn" }];
    const err = await rejection(
      service({ aideRoster: rosterPort(dual) }).assignAideTeam(
        actor(["rn"]),
        PLAN,
        input({ aideMembershipId: OTHER, supervisingRnMembershipId: OTHER }),
      ),
    );
    expect(err.code).toBe("SUPERVISING_RN_NOT_ELIGIBLE");
    expect(updates).toHaveLength(0);
  });

  it("is locked once the plan has versions but none is an open draft: open a revision to change the care team", async () => {
    for (const versions of [
      [{ status: "signed" }],
      [{ status: "signed" }, { status: "superseded" }],
      [{ status: "in_review" }],
    ]) {
      const err = await rejection(
        service({ versions }).assignAideTeam(actor(["rn"]), PLAN, input()),
      );
      expect(err.code, JSON.stringify(versions)).toBe("ASSIGNMENT_LOCKED");
      expect(err.statusCode).toBe(409);
    }
    expect(updates).toHaveLength(0);
  });

  it("is open while the plan has no version yet or an open draft", async () => {
    for (const versions of [
      [],
      [{ status: "draft" }],
      [{ status: "signed" }, { status: "draft" }],
    ]) {
      await service({ versions }).assignAideTeam(actor(["rn"]), PLAN, input());
      expect(updates[0], JSON.stringify(versions)).toMatchObject({ aideMembershipId: AIDE });
    }
  });
});

describe("M15 signSupervisoryVisit — re-pointing the supervising RN does not hand over a visit already recorded", () => {
  const VISIT = "44444444-4444-4444-8444-444444444444";
  const visitRow = {
    id: VISIT,
    planId: PLAN,
    supervisingRnMembershipId: RN,
    aideMembershipId: AIDE,
    sourceEncounterId: null,
    supervisoryAt: new Date("2026-01-01T00:00:00Z"),
    attestationMode: "aide_present",
    aidePerformanceSatisfactory: true,
    correctiveActions: null,
    supervisoryNarrative: "Synthetic narrative of the supervised visit, long enough to be valid.",
    nextDueAt: new Date("2026-01-15T00:00:00Z"),
    cadenceDaysAtInsert: 14,
    signedAt: null,
    version: 1,
  };
  const signAs = (membershipId: string, roles: readonly string[]) =>
    service({ versions: [visitRow] }).signSupervisoryVisit(
      { ...actor(roles), membershipId },
      PLAN,
      VISIT,
      { expectedVersion: null } as never,
    );

  it("lets the RN the visit names sign it", async () => {
    await signAs(RN, ["rn"]);
    expect(updates[0]).toHaveProperty("signedAt");
  });

  it("refuses another RN, even one the plan now names as supervising RN (403 NOT_AIDE_SUPERVISOR)", async () => {
    const err = await rejection(signAs("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ["rn"]));
    expect(err.code).toBe("NOT_AIDE_SUPERVISOR");
    expect(err.statusCode).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it("lets a covering clinical supervisor or director of nursing sign (the ABAC override)", async () => {
    for (const role of ["clinical_supervisor", "director_of_nursing"]) {
      await signAs("ffffffff-ffff-4fff-8fff-ffffffffffff", [role]);
      expect(updates[0], role).toHaveProperty("signedAt");
    }
  });
});
