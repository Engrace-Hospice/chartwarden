// apps/backend/__tests__/discipline-plans-write-service-caseload.test.ts — GAP-046 follow-up: the M15 WRITE
// SERVICE itself enforces the §4.1 `caseload_or_scope` column. The route guard is an early-404 convenience;
// any other caller of the service (a worker, another module, a future route) must not bypass the gate. These
// tests call the Drizzle write service DIRECTLY over a fake transactional db (no live infra) with an
// off-caseload actor and expect the same non-leaking NotFound a missing plan gives.
import { NotFoundError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { DisciplinePlanStateError } from "../src/modules/15-discipline-care-plans/lifecycle/index";
import {
  type M15ReadActor,
  type M15WriteActor,
  buildDrizzleM15WriteService,
  systemM15Actor,
} from "../src/modules/15-discipline-care-plans/routes/index";

const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const OTHER_PATIENT = "44444444-4444-4444-8444-444444444444";

/** A discharged plan: a caller that PASSES the caseload gate then trips `PLAN_DISCHARGED` (proof it got through). */
const PLAN_ROW = {
  id: PLAN,
  organizationId: ORG,
  patientId: PATIENT,
  status: "discharged",
  kind: "ipoc",
};

function fakeDb() {
  const tx = {
    execute: async () => [],
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [PLAN_ROW] }) }) }),
  };
  return { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never;
}

const caseload: Record<string, readonly string[]> = { rn_1: [PATIENT], rn_2: [OTHER_PATIENT] };
const isInCaseload = async (q: { userId: string; patientId: string }) =>
  (caseload[q.userId] ?? []).includes(q.patientId);

const service = () => buildDrizzleM15WriteService(fakeDb(), { isInCaseload });

const actor = (userId: string, roles: readonly string[] = ["rn_case_manager"]): M15WriteActor => ({
  organizationId: ORG,
  userId,
  membershipId: userId,
  roles,
  sessionClass: "staff",
  locationIds: [],
  stepUpRecent: true,
});

type AnyCall = (s: ReturnType<typeof service>, a: M15WriteActor) => Promise<unknown>;
const ANY = {} as never;
const PLAN_BEARING: ReadonlyArray<readonly [string, AnyCall]> = [
  ["finalizeVersion", (s, a) => s.finalizeVersion(a, PLAN, "v", ANY)],
  ["signVersion", (s, a) => s.signVersion(a, PLAN, "v", ANY)],
  ["createGoal", (s, a) => s.createGoal(a, PLAN, ANY)],
  ["updateGoal", (s, a) => s.updateGoal(a, PLAN, "g", ANY)],
  ["createIntervention", (s, a) => s.createIntervention(a, PLAN, ANY)],
  ["updateIntervention", (s, a) => s.updateIntervention(a, PLAN, "i", ANY)],
  ["createAssessment", (s, a) => s.createAssessment(a, PLAN, ANY)],
  ["signAssessment", (s, a) => s.signAssessment(a, PLAN, "a", ANY)],
  ["amendAssessment", (s, a) => s.amendAssessment(a, PLAN, "a", ANY)],
  ["createSupervisoryVisit", (s, a) => s.createSupervisoryVisit(a, PLAN, ANY)],
  ["signSupervisoryVisit", (s, a) => s.signSupervisoryVisit(a, PLAN, "sv", ANY)],
  ["createVolunteerAssignment", (s, a) => s.createVolunteerAssignment(a, PLAN, ANY)],
  ["updateVolunteerAssignment", (s, a) => s.updateVolunteerAssignment(a, PLAN, "va", ANY)],
];

describe("M15 write service — caseload enforced inside the service", () => {
  it.each(PLAN_BEARING)("%s: an off-caseload actor gets NotFound", async (_name, call) => {
    await expect(call(service(), actor("rn_2"))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an actor with an empty caseload gets NotFound", async () => {
    await expect(service().createGoal(actor("nobody"), PLAN, ANY)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("fails closed when the caseload seam errors", async () => {
    const s = buildDrizzleM15WriteService(fakeDb(), {
      isInCaseload: async () => {
        throw new Error("seam unavailable");
      },
    });
    await expect(s.createGoal(actor("rn_1"), PLAN, ANY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an on-caseload actor passes the gate (reaches the plan-state check)", async () => {
    await expect(service().createGoal(actor("rn_1"), PLAN, ANY)).rejects.toBeInstanceOf(
      DisciplinePlanStateError,
    );
  });

  it("an org-wide scope role passes the gate without a caseload row", async () => {
    await expect(
      service().createGoal(actor("dir_1", ["medical_director"]), PLAN, ANY),
    ).rejects.toBeInstanceOf(DisciplinePlanStateError);
  });

  it("the explicit system actor passes the gate (workers / consumers)", async () => {
    const sys = systemM15Actor(ORG, { userId: "svc", membershipId: "svc" });
    await expect(service().createGoal(sys, PLAN, ANY)).rejects.toBeInstanceOf(
      DisciplinePlanStateError,
    );
  });

  it("a user actor cannot self-declare system via roles or a look-alike field", async () => {
    const spoof = { ...actor("rn_2", ["system"]), kind: "user" } as unknown as M15WriteActor;
    await expect(service().createGoal(spoof, PLAN, ANY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("planPatientId stays a bare lookup for the route guard (no caseload recursion)", async () => {
    const reader: M15ReadActor = actor("rn_2");
    await expect(service().planPatientId(reader, PLAN)).resolves.toBe(PATIENT);
  });
});
