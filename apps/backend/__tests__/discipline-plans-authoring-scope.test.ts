// apps/backend/__tests__/discipline-plans-authoring-scope.test.ts — M15: every authoring method of the write service binds
// the AUTHENTICATED actor's roles to the plan kind (`checkPlanKindAuthoringScope`), not only `openVersion`. `addedByDiscipline`
// is a body field; before this an RN on the caseload could author goals/interventions on an MSW, spiritual or volunteer plan
// by sending the other discipline's name, edit another discipline's elements and finalize their versions. The system actor
// (internal callers hold no roles) stays exempt.
import { describe, expect, it } from "vitest";
import {
  type M15WriteActor,
  buildDrizzleM15WriteService,
  systemM15Actor,
} from "../src/modules/15-discipline-care-plans/routes/index";

const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";

/** A plan row of `kind`; everything past the plan lookup is a no-op, so a call that gets past the scope check fails elsewhere. */
function fakeDb(kind: string) {
  const plan = {
    id: PLAN,
    organizationId: ORG,
    patientId: "p1",
    status: "active",
    kind,
    version: 1,
  };
  const tx = {
    execute: async () => [],
    select: () => {
      const chain: Promise<unknown[]> = Object.assign(Promise.resolve([plan]), {
        from: (): unknown => chain,
        where: (): unknown => chain,
        orderBy: (): unknown => chain,
        limit: async () => [plan],
      });
      return chain;
    },
  };
  return { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never;
}

const service = (kind: string) =>
  buildDrizzleM15WriteService(fakeDb(kind), { isInCaseload: async () => true });

const actor = (roles: readonly string[]): M15WriteActor => ({
  organizationId: ORG,
  userId: "u1",
  membershipId: "m1",
  roles,
  sessionClass: "staff",
  actorKind: "user",
  locationIds: [],
  stepUpRecent: true,
});

type Call = (s: ReturnType<typeof service>, a: M15WriteActor) => Promise<unknown>;
const CALLS: ReadonlyArray<readonly [string, Call]> = [
  ["finalizeVersion", (s, a) => s.finalizeVersion(a, PLAN, ID, { expectedVersion: null } as never)],
  [
    "createGoal",
    (s, a) =>
      s.createGoal(a, PLAN, {
        parentProblemId: ID,
        source: "clinical",
        originalText: "x",
        addedByDiscipline: "msw",
      } as never),
  ],
  [
    "createIntervention",
    (s, a) =>
      s.createIntervention(a, PLAN, {
        scopeText: "x",
        frequencyText: "daily",
        frequencyValue: "1:visit:day",
        discipline: "msw",
        addedByDiscipline: "msw",
      } as never),
  ],
  ["updateGoal", (s, a) => s.updateGoal(a, PLAN, ID, { expectedVersion: null } as never)],
  [
    "updateIntervention",
    (s, a) => s.updateIntervention(a, PLAN, ID, { expectedVersion: null } as never),
  ],
];

describe("M15 write service — the actor's roles are bound to the plan kind on every authoring method", () => {
  for (const [name, call] of CALLS) {
    it(`${name}: an RN is refused on an MSW plan with 403 DISCIPLINE_SCOPE_VIOLATION`, async () => {
      await expect(call(service("msw_plan"), actor(["rn"]))).rejects.toMatchObject({
        code: "DISCIPLINE_SCOPE_VIOLATION",
        statusCode: 403,
      });
    });

    it(`${name}: the MSW passes the scope check on an MSW plan (a later step may still refuse)`, async () => {
      const err = await call(service("msw_plan"), actor(["msw"])).catch((e: unknown) => e);
      expect((err as { code?: string } | undefined)?.code).not.toBe("DISCIPLINE_SCOPE_VIOLATION");
    });

    it(`${name}: the system actor is exempt`, async () => {
      const err = await call(
        service("msw_plan"),
        systemM15Actor(ORG, { userId: "sys", membershipId: "sysm" }),
      ).catch((e: unknown) => e);
      expect((err as { code?: string } | undefined)?.code).not.toBe("DISCIPLINE_SCOPE_VIOLATION");
    });
  }

  it("an RN or the RN case manager still authors on an Aide POC", async () => {
    for (const roles of [["rn"], ["rn_case_manager"]]) {
      const err = await service("aide_poc")
        .updateGoal(actor(roles), PLAN, ID, { expectedVersion: null } as never)
        .catch((e: unknown) => e);
      expect((err as { code?: string } | undefined)?.code, roles.join()).not.toBe(
        "DISCIPLINE_SCOPE_VIOLATION",
      );
    }
  });
});
