import { NotFoundError } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/routes/service";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g2, open pass 4 (no Postgres). The DB backend and its in-memory twin answer the same for:
//  - an id that is no uuid (a route id is only length-checked): a 404 / "absent" / an empty list, and NO statement, where
//    the `= 'not-a-uuid'` comparison was a 22P02 (a 500) out of the ABAC loaders and the by-id reads;
//  - a batch iQIES accepted with warnings: accepted, in the acceptance rate (it used to be in neither half of the ratio);
//  - the provider entity the dashboard echoes: the id as Postgres writes it, not the caller's spelling;
//  - assemble: every eligibility test is in the candidate SELECT (no read of the entity's whole signed history, no
//    query per row behind the advisory key).
const ORG = "11111111-1111-4111-8111-111111111111";
// The acting membership a skip / regenerate hands the service for its audit event (no HTTP request in these tests).
const OPERATOR = { membershipId: "88888888-8888-4888-8888-888888888888" };
const ID = "abcdef01-2345-4678-89ab-cdef01234567";
const SPELLED = ID.toUpperCase();
const NOT_A_UUID = "not-a-uuid";

// an unregistered M6 seam is logged (and the workflow state answered without the admission): keep the output clean
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
}
const selectsOf = (statements: ReturnType<typeof scriptedDb>["statements"]) =>
  statements.filter((s) => s.kind === "select");

describe("a URL id that is no uuid never reaches a uuid comparison", () => {
  it.each([
    ["getSchedule", (svc: ReturnType<typeof backend>["svc"]) => svc.getSchedule(ORG, NOT_A_UUID)],
    [
      "getAssessment",
      (svc: ReturnType<typeof backend>["svc"]) => svc.getAssessment(ORG, NOT_A_UUID),
    ],
    ["getSfv", (svc: ReturnType<typeof backend>["svc"]) => svc.getSfv(ORG, NOT_A_UUID)],
    [
      "getSubmission",
      (svc: ReturnType<typeof backend>["svc"]) => svc.getSubmission(ORG, NOT_A_UUID),
    ],
    [
      "skipSchedule",
      (svc: ReturnType<typeof backend>["svc"]) =>
        svc.skipSchedule(ORG, NOT_A_UUID, "other", OPERATOR),
    ],
  ])("%s answers the 404 an absent record answers, and sends no statement", async (_name, call) => {
    const { svc, statements } = backend([[]]);

    await expect(call(svc)).rejects.toBeInstanceOf(NotFoundError);

    expect(statements).toEqual([]);
  });

  it("the four ABAC loaders answer absent (null: hope.scope fails closed), with no statement", async () => {
    const { svc, statements } = backend([[]]);

    const answers = await Promise.all([
      svc.loadAssessment(ORG, NOT_A_UUID),
      svc.loadSchedule(ORG, NOT_A_UUID),
      svc.loadSfv(ORG, NOT_A_UUID),
      svc.loadSubmission(ORG, NOT_A_UUID),
    ]);

    expect(answers).toEqual([null, null, null, null]);
    expect(statements).toEqual([]);
  });

  it("an assessment-id write path (loadA) is the same 404", async () => {
    const { svc, statements } = backend([[]]);

    await expect(svc.requestSummaryPdf(ORG, "u-1", NOT_A_UUID)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(selectsOf(statements)).toEqual([]);
  });

  it("a patient id that is no uuid has no assessments (an empty list), with no statement", async () => {
    const { svc, statements } = backend([[]]);

    expect(await svc.listPatientAssessments(ORG, NOT_A_UUID)).toEqual({ assessments: [] });

    expect(statements).toEqual([]);
  });

  it("a triggeringAssessmentId filter that is no uuid matches nothing at the service (the route already refuses it with 422), not a cast", async () => {
    const { svc, statements } = backend([[]]);

    const { sfvs } = await svc.listSfv(ORG, undefined, undefined, NOT_A_UUID);

    expect(sfvs).toEqual([]);
    const [select] = selectsOf(statements);
    expect(select?.rendered?.sql).toContain("false");
    expect(select?.rendered?.params).toEqual([]);
  });

  it.each([
    ["getSchedule", (svc: ReturnType<typeof backend>["svc"]) => svc.getSchedule(ORG, SPELLED)],
    ["getAssessment", (svc: ReturnType<typeof backend>["svc"]) => svc.getAssessment(ORG, SPELLED)],
    ["getSfv", (svc: ReturnType<typeof backend>["svc"]) => svc.getSfv(ORG, SPELLED)],
    ["getSubmission", (svc: ReturnType<typeof backend>["svc"]) => svc.getSubmission(ORG, SPELLED)],
    [
      "listPatientAssessments",
      (svc: ReturnType<typeof backend>["svc"]) => svc.listPatientAssessments(ORG, SPELLED),
    ],
    [
      "listSfv (triggeringAssessmentId)",
      (svc: ReturnType<typeof backend>["svc"]) => svc.listSfv(ORG, undefined, undefined, SPELLED),
    ],
    [
      "loadAssessment",
      (svc: ReturnType<typeof backend>["svc"]) => svc.loadAssessment(ORG, SPELLED),
    ],
    ["loadSchedule", (svc: ReturnType<typeof backend>["svc"]) => svc.loadSchedule(ORG, SPELLED)],
    ["loadSfv", (svc: ReturnType<typeof backend>["svc"]) => svc.loadSfv(ORG, SPELLED)],
    [
      "loadSubmission",
      (svc: ReturnType<typeof backend>["svc"]) => svc.loadSubmission(ORG, SPELLED),
    ],
  ])("%s sends a uuid in any spelling as the canonical id", async (_name, call) => {
    const { svc, statements } = backend([[]]);

    await call(svc).catch(() => undefined); // an unseeded row is a 404 / null / []; what is asked is what is under test

    const [select] = selectsOf(statements);
    expect(select?.rendered?.params).toContain(ID);
    expect(select?.rendered?.params).not.toContain(SPELLED);
  });
});

describe("complianceDashboard — a batch accepted with warnings is accepted", () => {
  const sched = [{ status: "completed", n: 1 }];
  const sfv = [{ status: "completed", n: 1 }];

  it("9 batches accepted_with_warnings and 1 rejected read 9 of 10, not 0 of 1", async () => {
    const { svc } = backend([
      sched,
      sfv,
      [
        { status: "accepted_with_warnings", n: 9 },
        { status: "rejected", n: 1 },
      ],
    ]);

    const view = await svc.complianceDashboard(ORG, undefined);

    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 9, total: 10 });
    expect(view.submissionAcceptanceRate).not.toBeNull();
  });

  it("only warning batches have a rate (the denominator is not 0)", async () => {
    const { svc } = backend([sched, sfv, [{ status: "accepted_with_warnings", n: 4 }]]);

    const view = await svc.complianceDashboard(ORG, undefined);

    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 4, total: 4 });
    expect(view.submissionAcceptanceRate).not.toBeNull();
  });

  it("accepted, accepted_with_warnings, rejected and partially_accepted are answered; queued and in-flight are in neither half", async () => {
    const { svc } = backend([
      sched,
      sfv,
      [
        { status: "accepted", n: 2 },
        { status: "accepted_with_warnings", n: 1 },
        { status: "rejected", n: 1 },
        { status: "partially_accepted", n: 1 },
        { status: "queued", n: 7 },
        { status: "submitted_pending_result", n: 3 },
      ],
    ]);

    const view = await svc.complianceDashboard(ORG, undefined);

    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 3, total: 5 });
  });
});

describe("the ids the dashboard and the workflow state echo are the canonical id, not the caller's spelling", () => {
  const empty = [[], [], []] as const;

  it("the DB backend echoes the id as Postgres writes it", async () => {
    const { svc } = backend([...empty]);

    const view = await svc.complianceDashboard(ORG, SPELLED);

    expect(view.providerEntityId).toBe(ID);
  });

  it("the in-memory twin echoes the same text (parity: a route test on the twin answers what production answers)", async () => {
    const twin = createInMemoryHopeBackend();

    expect((await twin.complianceDashboard(ORG, SPELLED)).providerEntityId).toBe(ID);
    expect((await twin.getWorkflowState(ORG, SPELLED)).admissionId).toBe(ID);
  });

  it("the workflow state echoes the admission id as Postgres writes it too (one rule, as regenerateSchedules)", async () => {
    const { svc } = backend([...empty]);

    const view = await svc.getWorkflowState(ORG, SPELLED);

    expect(view.admissionId).toBe(ID);
  });

  it("an id that is no uuid, and an unnamed entity, are echoed as before", async () => {
    const named = await backend([...empty]).svc.complianceDashboard(ORG, "pe_1");
    const unnamed = await backend([...empty]).svc.complianceDashboard(ORG, undefined);

    expect(named.providerEntityId).toBe("pe_1");
    expect(unnamed.providerEntityId).toBeNull();
  });
});

describe("assembleSubmission — eligibility is the candidate SELECT's, not a read of the whole history plus a query per row", () => {
  it("reads only signed, frozen, not-yet-recorded records without a live item, in ONE statement", async () => {
    const { svc, statements } = backend([[]]);

    await expect(svc.assembleSubmission(ORG, ID)).rejects.toMatchObject({
      message: "No signed HOPE assessments are eligible for iQIES package generation",
    });

    const selects = selectsOf(statements);
    expect(selects).toHaveLength(1);
    const where = selects[0]?.rendered;
    expect(where?.sql).toContain('"spec_version_id" is not null');
    expect(where?.sql).toContain('"isc" is not null');
    expect(where?.sql).toContain('"iqies_record_id" is null');
    expect(where?.sql).toContain("not exists (select 1 from");
    expect(where?.sql).toContain('"hope_submission_item"."hope_assessment_id" = ');
    expect(where?.params).toEqual(
      expect.arrayContaining([
        ORG,
        ID,
        "signed",
        "pending",
        "accepted",
        "accepted_with_warnings",
        "rejected",
      ]),
    );
    // a cancelled item does not hold the record back: it is packaged again
    expect(where?.params).not.toContain("cancelled");
  });
});
