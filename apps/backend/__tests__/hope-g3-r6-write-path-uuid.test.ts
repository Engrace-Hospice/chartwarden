import { ConflictError, NotFoundError } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { lockAssessmentRow } from "../src/modules/10-hope/hope-assessment-lock";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { cancelHopeSubmission } from "../src/modules/10-hope/hope-submission-cancel-db";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3, round 6 (no Postgres): the claim "a non-uuid URL id never reaches a uuid comparison" holds for EVERY id-taking
// route-service method, not only the by-id reads. A route id is only length-checked; `hope.scope` answers 404 for it
// today, but the service is also called directly and a route added or reordered without that gate would otherwise answer
// a 22P02 (a 500) from `= 'not-a-uuid'`. Each method below is called with an id that is no uuid, over a database that
// rejects every statement ("script exhausted"): the call must answer the 404 an absent record answers, and no statement
// may carry the bad id.
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const NOT_A_UUID = "not-a-uuid";
const ID = "abcdef01-2345-4678-89ab-cdef01234567";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetSeamsForTest();
});

type Svc = ReturnType<typeof backend>["svc"];
function backend(outcomes: Parameters<typeof scriptedDb>[0] = []) {
  const fake = scriptedDb(outcomes);
  return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
}

/** Every statement the fake recorded that carried `value` as a bound value. */
const carrying = (statements: ReturnType<typeof scriptedDb>["statements"], value: string) =>
  statements.filter((s) => s.rendered?.params.includes(value));

type ErrorClass = new (...args: never[]) => Error;
const writePaths = (
  id: string,
): readonly [string, (svc: Svc) => Promise<unknown>, ErrorClass?][] => [
  ["updateDraft", (svc) => svc.updateDraft(ORG, id, { a: 1 })],
  ["getAssessmentWorkspace", (svc) => svc.getAssessmentWorkspace(ORG, id)],
  ["getAssessmentReview", (svc) => svc.getAssessmentReview(ORG, id)],
  [
    "setHuvCompletionDate",
    (svc) => svc.setHuvCompletionDate(ORG, USER, id, { ifVersion: 1, z0350: "2026-06-01" }),
  ],
  [
    "signTimepoint",
    (svc) =>
      svc.signTimepoint(ORG, USER, id, {
        attestationConfirmed: true,
        attestationVersion: undefined,
      }),
  ],
  [
    "correctTimepoint",
    (svc) =>
      svc.correctTimepoint(ORG, USER, id, {
        correctionReason: "r",
        targetDate: "2026-06-01",
        authorDiscipline: "RN",
        data: {},
      }),
  ],
  [
    "inactivateTimepoint",
    (svc) => svc.inactivateTimepoint(ORG, USER, id, { reason: "r", authorDiscipline: "RN" }),
  ],
  ["requestSummaryPdf", (svc) => svc.requestSummaryPdf(ORG, USER, id)],
  ["listAssessmentSubmissions", (svc) => svc.listAssessmentSubmissions(ORG, id)],
  ["retrySubmission", (svc) => svc.retrySubmission(ORG, id)],
  ["downloadSubmissionPackage", (svc) => svc.downloadSubmissionPackage(ORG, id)],
  [
    "cancelSubmission",
    (svc) => svc.cancelSubmission(ORG, USER, id, { reasonCode: "generated_in_error" }),
  ],
  ["markSubmissionUploaded", (svc) => svc.markSubmissionUploaded(ORG, USER, id, {})],
  ["importSubmissionResult", (svc) => svc.importSubmissionResult(ORG, USER, id, { results: [] })],
  ["getWorkflowState", (svc) => svc.getWorkflowState(ORG, id)],
  ["regenerateSchedules", (svc) => svc.regenerateSchedules(ORG, id)],
  [
    "recordTimepoint",
    (svc) =>
      svc.recordTimepoint(ORG, USER, id, {
        rfaKind: "02_huv1",
        targetDate: "2026-06-01T00:00:00.000Z",
        authorDiscipline: "RN",
        data: {},
      } as unknown as Parameters<Svc["recordTimepoint"]>[3]),
  ],
  [
    "recordSfv",
    (svc) =>
      svc.recordSfv(ORG, USER, id, {
        triggeringAssessmentId: ID,
        targetDate: "2026-06-01T00:00:00.000Z",
        authorDiscipline: "RN",
        attestationConfirmed: true,
        data: {},
      }),
  ],
  [
    "patchAssessmentAnswers",
    (svc) =>
      svc.patchAssessmentAnswers(ORG, USER, id, {
        ifVersion: 1,
        changes: [{ itemCode: "A0050", action: "set", value: "1" }],
      }),
  ],
  ["getValidation", (svc) => svc.getValidation(ORG, id)],
  // An entity id that is no uuid names no entity: nothing eligible (the 409 an entity with no signed records answers).
  ["assembleSubmission", (svc) => svc.assembleSubmission(ORG, id), ConflictError],
];

describe("an id that is no uuid, on every id-taking route-service method", () => {
  it.each(writePaths(NOT_A_UUID))(
    "%s refuses with the answer of an absent record, and sends no statement carrying the id",
    async (_name, call, expected = NotFoundError) => {
      const { svc, statements } = backend();

      const failure = await call(svc).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(expected);
      expect(carrying(statements, NOT_A_UUID)).toEqual([]);
    },
  );
});

// Postgres reads a hyphen after ANY group of four hex digits, not only at the canonical 8-4-4-4-12 places. An id the loaders accept in
// such a spelling must reach every statement as the CANONICAL text, never as the caller's spelling (the same record, one key).
const STRAY_HYPHEN = "abcd-ef01-2345-4678-89ab-cdef-0123-4567";
// A hyphen Postgres refuses (inside a group of four) is not a uuid: the loaders no longer accept it, so it names no record, and the
// read-audit hook cannot be handed an id its uuid column rejects.
const REFUSED_HYPHEN = "abcdef0123-454678-89abcdef01234567";
const SENDS_A_STATEMENT = new Set([
  "updateDraft",
  "getAssessmentWorkspace",
  "getAssessmentReview",
  "setHuvCompletionDate",
  "signTimepoint",
  "correctTimepoint",
  "inactivateTimepoint",
  "requestSummaryPdf",
  "listAssessmentSubmissions",
  "retrySubmission",
  "downloadSubmissionPackage",
  "cancelSubmission",
  "markSubmissionUploaded",
  "importSubmissionResult",
  "getWorkflowState",
  "patchAssessmentAnswers",
  "getValidation",
]);

describe("an id with a hyphen Postgres refuses", () => {
  it.each(writePaths(REFUSED_HYPHEN).filter(([name]) => SENDS_A_STATEMENT.has(name)))(
    "%s answers 'not found' and sends no statement that carries it",
    async (_name, call) => {
      const { svc, statements } = backend();

      const failure = await call(svc).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(NotFoundError);
      expect(carrying(statements, REFUSED_HYPHEN)).toEqual([]);
    },
  );
});

describe("an id the loaders accept in a spelling that is not the canonical one", () => {
  it.each(writePaths(STRAY_HYPHEN).filter(([name]) => SENDS_A_STATEMENT.has(name)))(
    "%s queries the canonical id, never the caller's spelling",
    async (_name, call) => {
      const { svc, statements } = backend();

      await call(svc).then(
        () => null,
        () => null, // the empty script stops the call at its first statement
      );

      expect(carrying(statements, STRAY_HYPHEN)).toEqual([]);
      expect(carrying(statements, ID).length).toBeGreaterThan(0);
    },
  );
});

describe("the shared lock helpers", () => {
  it("lockAssessmentRow answers 'no such row' for an id that is no uuid, with no statement at all", async () => {
    const { tx, statements } = backend();

    const row = await lockAssessmentRow(tx, ORG, NOT_A_UUID);

    expect(row).toBeUndefined();
    expect(statements).toEqual([]);
  });

  it("lockAssessmentRow locks on the canonical id when the URL spelled it in upper case", async () => {
    const { tx, statements } = backend([[{ id: ID }]]);

    const row = await lockAssessmentRow(tx, ORG, ID.toUpperCase());

    expect(row).toEqual({ id: ID });
    const lock = statements.find((s) => s.kind === "select");
    expect(lock?.rendered?.params).toContain(ID);
    expect(lock?.rendered?.params).not.toContain(ID.toUpperCase());
  });

  it("cancelHopeSubmission (called on its own) is a 404 for an id that is no uuid, with no statement", async () => {
    const { tx, statements } = backend();

    await expect(
      cancelHopeSubmission(tx, {
        id: NOT_A_UUID,
        organizationId: ORG,
        actorMembershipId: USER,
        reasonCode: "generated_in_error",
        now: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(statements).toEqual([]);
  });
});

describe("getWorkflowState echoes and queries the canonical admission id", () => {
  it("an upper-case admission id is looked up, and answered, as the lower-case id Postgres writes", async () => {
    // An unregistered M6 seam is logged and the state answered without the admission (the warn spy keeps that quiet).
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw new Error("unavailable");
      },
    } as never);
    const { svc, statements } = backend([[], [], []]);

    const state = await svc.getWorkflowState(ORG, ID.toUpperCase());

    expect(state.admissionId).toBe(ID);
    const selects = statements.filter((s) => s.kind === "select");
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      expect(select.rendered?.params).toContain(ID);
      expect(select.rendered?.params).not.toContain(ID.toUpperCase());
    }
  });
});

describe("recordTimepoint never guesses the record's subject", () => {
  const args = {
    rfaKind: "01_admission" as const,
    targetDate: "2026-06-01T00:00:00.000Z",
    authorDiscipline: "RN",
    data: {},
  };

  it("refuses with M10_ADMISSION_PROJECTION_GAP when neither the M6 summary nor a schedule row names a patient, and inserts nothing", async () => {
    // The summary carries no patient (a projection gap); the admission id must not stand in for one.
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({
        organizationId: ORG,
        admissionId: ID,
        patientId: undefined,
        providerEntityId: null,
        locationId: null,
        admissionAt: "2026-06-01T00:00:00.000Z",
        dischargedAt: null,
      }),
    } as never);
    const { svc, statements } = backend([
      [{ id: "spec-1", code: "v1" }],
      [{ id: "item-a0050" }],
      [{ id: "opt-1" }],
      [{ id: "item-a0250" }],
      [{ id: "opt-2" }],
      [], // the schedule lookup: none
      [], // the existing-draft read: none
    ]);

    const failure = await svc.recordTimepoint(ORG, USER, ID.toUpperCase(), args).then(
      () => null,
      (error: { code?: string; statusCode?: number; message?: string }) => error,
    );

    expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    expect(String(failure?.message)).toContain(`Admission ${ID} `);
    expect(String(failure?.message)).toContain("NEW Idempotency-Key");
    expect(statements.some((s) => s.kind === "insert")).toBe(false);
  });
});
