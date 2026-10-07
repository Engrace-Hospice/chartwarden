// apps/backend/__tests__/idg-caseload-scope.test.ts — GAP-127 / GAP-128 (M14).
//
// GAP-128: the packet reads and the patient idg-history carry a per-patient caseload scope on top of the
// meeting's location scope. GAP-127: an action item may be moved only by its assignee or a coordinator, and an
// adjourned meeting's action items cannot be removed. Pure guard + in-memory service, no HTTP in front.
import { describe, expect, it } from "vitest";
import { createInMemoryIdgBackend } from "../src/modules/14-idg/index";
import {
  assertIdgPatientInScope,
  filterIdgPatientsInScope,
} from "../src/modules/14-idg/routes/caseload-scope";

const ORG = "org_a";
const P_ON = "11111111-1111-4111-8111-111111111111";
const P_OFF = "22222222-2222-4222-8222-222222222222";
const facts = (over: Partial<Parameters<typeof assertIdgPatientInScope>[0]> = {}) => ({
  userId: "user_rn",
  roles: ["rn_case_manager"],
  sessionPatientId: null,
  ...over,
});
const caseload = async () => [P_ON];

describe("per-patient caseload scope (GAP-128)", () => {
  it("admits an on-caseload patient and 404s an off-caseload one", async () => {
    await expect(assertIdgPatientInScope(facts(), ORG, P_ON, caseload)).resolves.toBeUndefined();
    await expect(assertIdgPatientInScope(facts(), ORG, P_OFF, caseload)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("admits an org-wide role and the session-pinned patient without a caseload lookup", async () => {
    const boom = async () => {
      throw new Error("must not be called");
    };
    await expect(
      assertIdgPatientInScope(facts({ roles: ["medical_director"] }), ORG, P_OFF, boom),
    ).resolves.toBeUndefined();
    await expect(
      assertIdgPatientInScope(facts({ sessionPatientId: P_OFF }), ORG, P_OFF, boom),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the caseload cannot be resolved", async () => {
    const down = async () => {
      throw new Error("seam unbound");
    };
    await expect(assertIdgPatientInScope(facts(), ORG, P_ON, down)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await filterIdgPatientsInScope(facts(), ORG, [{ patientId: P_ON }], down)).toEqual([]);
  });

  it("filters a packet list down to the caseload", async () => {
    const rows = [{ patientId: P_ON }, { patientId: P_OFF }];
    expect(await filterIdgPatientsInScope(facts(), ORG, rows, caseload)).toEqual([
      { patientId: P_ON },
    ]);
  });
});

describe("action-item assignee and adjourn guards (GAP-127)", () => {
  const MEETING = "33333333-3333-4333-8333-333333333333";
  const ASSIGNEE = "m_assignee";
  const seed = (status: "live" | "adjourned") =>
    createInMemoryIdgBackend({
      meetings: [
        {
          id: MEETING,
          organizationId: ORG,
          locationId: "loc_1",
          status,
          scheduledStart: "2026-06-08T12:00:00.000Z",
          scheduledEnd: "2026-06-08T13:00:00.000Z",
        },
      ],
    });
  const newItem = (svc: ReturnType<typeof seed>) =>
    svc.createActionItem(ORG, "m_coord", MEETING, {
      patientId: P_ON,
      assignedToMembershipId: ASSIGNEE,
      dueDate: "2026-06-29T00:00:00.000Z",
    });

  it("refuses a non-assignee non-coordinator with 403, admits the assignee and a coordinator", async () => {
    const svc = seed("live");
    const item = await newItem(svc);
    await expect(
      svc.updateActionItem(ORG, "m_other", item.id, "in_progress", false),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await svc.updateActionItem(ORG, ASSIGNEE, item.id, "in_progress", false)).status).toBe(
      "in_progress",
    );
    expect((await svc.updateActionItem(ORG, "m_coord", item.id, "completed", true)).status).toBe(
      "completed",
    );
  });

  it("refuses to remove an action item once the meeting is adjourned (409)", async () => {
    const svc = seed("adjourned");
    const item = await newItem(svc);
    await expect(svc.removeActionItem(ORG, "m_coord", item.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("removes an action item while the meeting is still live", async () => {
    const svc = seed("live");
    const item = await newItem(svc);
    await expect(svc.removeActionItem(ORG, "m_coord", item.id)).resolves.toEqual({
      id: item.id,
      removed: true,
    });
  });
});
