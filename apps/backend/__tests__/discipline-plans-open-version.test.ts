import { describe, expect, it } from "vitest";
import type { M15WriteActor } from "../src/modules/15-discipline-care-plans/routes/actor";
import { buildDrizzleM15WriteService } from "../src/modules/15-discipline-care-plans/routes/index";
import { fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const PROVIDER = "44444444-4444-4444-8444-444444444444";
const LOCATION = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-11-17T12:00:00.000Z";

const actor: M15WriteActor = {
  organizationId: ORG,
  userId: "msw-user",
  membershipId: "77777777-7777-4777-8777-777777777777",
  roles: ["msw"],
  sessionClass: "staff",
  actorKind: "user",
  locationIds: [LOCATION],
  stepUpRecent: false,
};

const plan = {
  id: PLAN,
  organizationId: ORG,
  patientId: PATIENT,
  admissionId: "88888888-8888-4888-8888-888888888888",
  providerEntityId: PROVIDER,
  locationId: LOCATION,
  kind: "msw_plan",
  status: "draft",
  aideMembershipId: null,
  supervisingRnMembershipId: null,
  nextSupervisoryDueAt: null,
  supervisoryCadenceDaysOverride: null,
  initialAssessmentClockStartedAt: new Date(NOW),
  initialAssessmentSignedAt: null,
  spiritualCareDeclined: null,
  spiritualCareDeclinedAt: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  dischargedAt: null,
  version: 0,
};

const opened = {
  id: VERSION,
  organizationId: ORG,
  providerEntityId: PROVIDER,
  locationId: LOCATION,
  planId: PLAN,
  sequence: 1,
  status: "draft",
  kind: "initial",
  stateSnapshot: null,
  requiredSignerSet: null,
  idgMeetingId: null,
  finalizedAt: null,
  signedAt: null,
  supersededAt: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  version: 0,
};

describe("M15 open discipline-plan version", () => {
  it("opens the initial draft atomically without an outbox event", async () => {
    const { db, rec } = fakeDb({
      discipline_care_plan: (op) => (op === "update" ? [{ ...plan, version: 1 }] : [plan]),
      discipline_care_plan_version: (op) => (op === "insert" ? [opened] : []),
    });
    const emissions: unknown[] = [];
    const service = buildDrizzleM15WriteService(db, {
      now: () => NOW as never,
      isInCaseload: async () => true,
      outbox: {
        async publish(_tx, emission) {
          emissions.push(emission);
        },
      },
    });

    await expect(
      service.openVersion(actor, PLAN, { expectedVersion: 0, kind: "initial" }),
    ).resolves.toEqual({
      versionId: VERSION,
      planId: PLAN,
      sequence: 1,
      status: "draft",
      kind: "initial",
      createdAt: NOW,
      version: 0,
    });
    expect(rec.inserts).toContainEqual({
      table: "discipline_care_plan_version",
      values: expect.objectContaining({
        planId: PLAN,
        sequence: 1,
        status: "draft",
        kind: "initial",
      }),
    });
    expect(rec.updates).toContainEqual({
      table: "discipline_care_plan",
      set: expect.objectContaining({ status: "draft", version: 1 }),
    });
    expect(emissions).toEqual([]);
  });

  it("rejects a second initial version with a typed conflict", async () => {
    const { db } = fakeDb({
      discipline_care_plan: [plan],
      discipline_care_plan_version: [opened],
    });
    const service = buildDrizzleM15WriteService(db, { isInCaseload: async () => true });

    await expect(
      service.openVersion(actor, PLAN, { expectedVersion: 0, kind: "initial" }),
    ).rejects.toMatchObject({
      code: "VERSION_ALREADY_EXISTS",
      statusCode: 409,
    });
  });

  it("opens the next sequence and moves an active root to draft_revising", async () => {
    const active = { ...plan, status: "active", version: 4 };
    const signed = { ...opened, sequence: 2, status: "signed", kind: "initial", version: 3 };
    const revision = { ...opened, sequence: 3, kind: "interim_revision" };
    const { db, rec } = fakeDb({
      discipline_care_plan: (op) =>
        op === "update" ? [{ ...active, status: "draft_revising", version: 5 }] : [active],
      discipline_care_plan_version: (op) => (op === "insert" ? [revision] : [signed]),
    });
    const service = buildDrizzleM15WriteService(db, {
      now: () => NOW as never,
      isInCaseload: async () => true,
    });

    await expect(
      service.openVersion(actor, PLAN, { expectedVersion: 4, kind: "interim_revision" }),
    ).resolves.toMatchObject({ sequence: 3, kind: "interim_revision", status: "draft" });
    expect(rec.updates).toContainEqual({
      table: "discipline_care_plan",
      set: expect.objectContaining({ status: "draft_revising", version: 5 }),
    });
  });

  it("enforces plan-kind discipline scope from server-loaded facts", async () => {
    const { db } = fakeDb({ discipline_care_plan: [plan], discipline_care_plan_version: [] });
    const service = buildDrizzleM15WriteService(db, { isInCaseload: async () => true });
    const chaplain = { ...actor, roles: ["chaplain"] };

    await expect(
      service.openVersion(chaplain, PLAN, { expectedVersion: 0, kind: "initial" }),
    ).rejects.toMatchObject({
      code: "DISCIPLINE_SCOPE_VIOLATION",
      statusCode: 403,
    });
  });

  it("does not treat a supervisor role as the documented Aide-POC override", async () => {
    const aidePlan = { ...plan, kind: "aide_poc" };
    const { db } = fakeDb({ discipline_care_plan: [aidePlan], discipline_care_plan_version: [] });
    const service = buildDrizzleM15WriteService(db, { isInCaseload: async () => true });
    const supervisor = { ...actor, roles: ["clinical_supervisor"] };

    await expect(
      service.openVersion(supervisor, PLAN, { expectedVersion: 0, kind: "initial" }),
    ).rejects.toMatchObject({
      code: "DISCIPLINE_SCOPE_VIOLATION",
      statusCode: 403,
    });
  });

  it("rejects a stale plan-root precondition before creating a version", async () => {
    const current = { ...plan, version: 2 };
    const { db, rec } = fakeDb({
      discipline_care_plan: [current],
      discipline_care_plan_version: [],
    });
    const service = buildDrizzleM15WriteService(db, { isInCaseload: async () => true });

    await expect(
      service.openVersion(actor, PLAN, { expectedVersion: 1, kind: "initial" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION", statusCode: 409 });
    expect(rec.inserts).toEqual([]);
  });
});
