import type { DbClient } from "@chartwarden/db";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildHopeAbacPredicates } from "../src/modules/10-hope/abac-predicates";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { resolveSfvAdmissionPatient } from "../src/modules/10-hope/hope-sfv-completion-guards";
import { HopeSpecNotFoundForTargetDateError } from "../src/modules/10-hope/hope-spec-registry";
import type { HopeWriteOutboxPort } from "../src/modules/10-hope/outbox-port";
import { regenerateSchedulesForAdmission } from "../src/modules/10-hope/scheduling/schedule-writer";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g1, round 4. Three things, none needing Postgres:
//  - the 422 messages the idempotency layer replays say the same thing wherever they are raised, and say it only to the
//    callers it is true for (a GET carries no Idempotency-Key);
//  - hope.scope's provider-entity branch reads an id the way the database does, not on the caller's spelling;
//  - the list and dashboard reads put their predicates in SQL on the canonical id (never read the whole organisation and
//    filter in JavaScript) and the retry / dashboard statements do not drag the package ZIP through the connection.
const ORG = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const CANONICAL = "abcdef01-2345-4678-89ab-cdef01234567";
const SPELLED = CANONICAL.toUpperCase();
const SUBMISSION = "55555555-5555-4555-8555-555555555555";

// The regenerate path refuses on the admission projection BEFORE it touches either: neither is ever called.
const NO_DB = {} as DbClient;
const NO_OUTBOX: HopeWriteOutboxPort = { publish: async () => undefined };

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number; message?: string }) => e,
  );

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});

describe("the replayed 422 messages", () => {
  it("M10_SPEC_NOT_IN_FORCE tells POST/PUT/PATCH to use a NEW Idempotency-Key and says a GET has no key", () => {
    const error = new HopeSpecNotFoundForTargetDateError("2031-07-04");

    expect(error.message).toContain(
      "On POST, PUT and PATCH the idempotency layer replays this 422",
    );
    expect(error.message).toContain("24 h on the same Idempotency-Key");
    expect(error.message).toContain("use a NEW Idempotency-Key; a GET has no key.");
    expect(error.message).not.toContain("2031");
  });

  it("M10_ADMISSION_PROJECTION_GAP from the regenerate path (no projection) carries the same sentence as the SFV route", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => undefined,
    } as never);
    const sfv = (await outcome(resolveSfvAdmissionPatient(ORG, ADMISSION))) as { message: string };

    const regenerate = await outcome(
      regenerateSchedulesForAdmission(NO_DB, NO_OUTBOX, {
        organizationId: ORG,
        admissionId: ADMISSION,
        resolveSiting: async () => null,
      }),
    );

    expect(regenerate).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    const tail = sfv.message.slice(sfv.message.indexOf("Once the admission is repaired"));
    expect(tail).toContain("NEW Idempotency-Key");
    expect(regenerate?.message?.endsWith(tail)).toBe(true);
  });

  it("an admission that is not sited (the second gap message) carries it too", async () => {
    const unsited = await outcome(
      regenerateSchedulesForAdmission(NO_DB, NO_OUTBOX, {
        organizationId: ORG,
        admissionId: ADMISSION,
        resolveSiting: async () => ({
          patientId: PATIENT,
          providerEntityId: null,
          locationId: null,
          admissionAt: null,
          activatedAt: null,
          dischargedAt: null,
        }),
      }),
    );

    expect(unsited).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    expect(unsited?.message).toContain("is not sited");
    expect(unsited?.message).toContain("send the request again with a NEW Idempotency-Key");
  });
});

describe("hope.scope — a provider entity is the same entity in any spelling of its uuid", () => {
  const resolver = {
    loadAssessment: async () => null,
    loadSchedule: async () => null,
    loadSfv: async () => null,
    loadSubmission: async () => ({ providerEntityId: CANONICAL }),
  };
  const scope = () =>
    buildHopeAbacPredicates({ resolver, isInCaseload: async () => false })["hope.scope"];
  const context = (providerEntityIds: string[]) =>
    ({
      organizationId: ORG,
      userId: "u-1",
      roles: ["rn"],
      providerEntityIds,
      attributes: {},
    }) as never;

  it.each([
    ["upper case", SPELLED],
    ["braced", `{${CANONICAL}}`],
    ["as stored", CANONICAL],
  ])("a non-org-wide caller naming their own entity (%s) is allowed", async (_label, named) => {
    const allowed = await scope()?.(context([CANONICAL]), { providerEntityId: named });

    expect(allowed).toBe(true);
  });

  it("the entity the submission row stores matches the caller's grant in any spelling too", async () => {
    const allowed = await scope()?.(context([SPELLED]), { submissionId: SUBMISSION });

    expect(allowed).toBe(true);
  });

  it("another entity, or an id that is no uuid, is still refused", async () => {
    const other = "99999999-9999-4999-8999-999999999999";

    expect(await scope()?.(context([CANONICAL]), { providerEntityId: other })).toBe(false);
    expect(await scope()?.(context([CANONICAL]), { providerEntityId: "not-a-uuid" })).toBe(false);
    expect(await scope()?.(context([]), { providerEntityId: CANONICAL })).toBe(false);
  });
});

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const publish = vi.fn(async () => undefined);
  const outbox: HopeWriteOutboxPort = { publish };
  return { ...fake, publish, svc: createDbHopeBackend(fake.db, outbox) };
}
const selectsOf = (statements: ReturnType<typeof scriptedDb>["statements"]) =>
  statements.filter((s) => s.kind === "select");

describe("listSchedules — every predicate is the database's", () => {
  const row = {
    id: "66666666-6666-4666-8666-666666666666",
    patientId: PATIENT,
    admissionId: ADMISSION,
    rfaKind: "02_huv1",
    status: "open",
    windowOpensAt: new Date("2026-06-01T00:00:00.000Z"),
    windowClosesAt: new Date("2026-06-05T00:00:00.000Z"),
    lateDeadlineAt: new Date("2026-06-10T00:00:00.000Z"),
    generatedBy: "system",
    completedByAssessmentId: null,
  };

  it("a named patient (any spelling) narrows the SELECT on the canonical id, and the rows are not filtered again", async () => {
    const { svc, statements } = backend([[row]]);

    const { schedules } = await svc.listSchedules(ORG, { patientId: PATIENT.toUpperCase() });

    expect(schedules).toHaveLength(1);
    const [select] = selectsOf(statements);
    expect(select?.rendered?.sql).toContain('"patient_id"');
    expect(select?.rendered?.params).toEqual([PATIENT]);
  });

  it("status and RFA kind are in the WHERE, with the patient", async () => {
    const { svc, statements } = backend([[row]]);

    await svc.listSchedules(ORG, { patientId: PATIENT, status: "open", rfaKind: "02_huv1" });

    const [select] = selectsOf(statements);
    expect(select?.rendered?.params).toEqual([PATIENT, "open", "02_huv1"]);
  });

  it("no filter at all is no predicate (the organisation, which hope.scope allows only an org-wide role)", async () => {
    const { svc, statements } = backend([[row]]);

    await svc.listSchedules(ORG, {});

    expect(selectsOf(statements).map((s) => s.rendered)).toEqual([undefined]);
  });

  it.each([
    ["a status that is no member of the enum", { status: "nonsense" }],
    ["an RFA kind that is no member of the enum", { rfaKind: "99_nonsense" }],
    ["an empty caseload", { patientIds: [] }],
  ])(
    "%s matches nothing and sends no statement (a `=` would be a 22P02)",
    async (_label, filter) => {
      const { svc, statements } = backend([[row]]);

      const result = await svc.listSchedules(ORG, filter);

      expect(result).toEqual({ schedules: [] });
      expect(selectsOf(statements)).toHaveLength(0);
    },
  );

  it("a patient id that is no uuid matches nothing and sends no cast", async () => {
    const { svc, statements } = backend([[]]);

    const result = await svc.listSchedules(ORG, { patientId: "not-a-uuid" });

    expect(result).toEqual({ schedules: [] });
    const [select] = selectsOf(statements);
    expect(select?.rendered?.sql).toContain("false");
    expect(select?.rendered?.params).toEqual([]);
  });
});

describe("listSfv — state and the caseload are the database's", () => {
  const row = {
    id: "77777777-7777-4777-8777-777777777777",
    patientId: PATIENT,
    admissionId: ADMISSION,
    triggeringAssessmentId: "88888888-8888-4888-8888-888888888888",
    status: "open",
    triggeredAt: new Date("2026-06-01T00:00:00.000Z"),
    dueAt: new Date("2026-06-03T00:00:00.000Z"),
    completingAssessmentId: null,
  };

  it("state and the caseload ids are in the WHERE", async () => {
    const { svc, statements } = backend([[row]]);

    const { sfvs } = await svc.listSfv(ORG, "open", [PATIENT]);

    expect(sfvs).toHaveLength(1);
    const [select] = selectsOf(statements);
    expect(select?.rendered?.params).toEqual(["open", PATIENT]);
  });

  it.each([
    ["an empty caseload", undefined, []],
    ["a state that is no member of the enum", "nonsense", undefined],
  ])("%s matches nothing and sends no statement", async (_label, state, patientIds) => {
    const { svc, statements } = backend([[row]]);

    const result = await svc.listSfv(ORG, state, patientIds);

    expect(result).toEqual({ sfvs: [] });
    expect(selectsOf(statements)).toHaveLength(0);
  });

  it("an unfiltered worklist for an org-wide role has no predicate", async () => {
    const { svc, statements } = backend([[row]]);

    await svc.listSfv(ORG);

    expect(selectsOf(statements).map((s) => s.rendered)).toEqual([undefined]);
  });
});

describe("complianceDashboard — counts come from the database, grouped by status", () => {
  it("the rates are computed from the counts (terminal batches only in the acceptance denominator)", async () => {
    const { svc, statements } = backend([
      [
        { status: "completed", n: 3 },
        { status: "expired", n: 1 },
        { status: "open", n: 40 },
      ],
      [
        { status: "completed", n: 1 },
        { status: "missed", n: 1 },
        { status: "open", n: 9 },
      ],
      [
        { status: "accepted", n: 2 },
        { status: "rejected", n: 1 },
        { status: "partially_accepted", n: 1 },
        { status: "queued", n: 7 },
      ],
    ]);

    const view = await svc.complianceDashboard(ORG, undefined);

    expect(view.hopeOnTimeCounts).toEqual({ onTime: 3, total: 4 });
    expect(view.sfvOnTimeCounts).toEqual({ onTime: 1, total: 2 });
    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 2, total: 4 });
    // one statement per table, each a select of `status` and a count, never of the rows
    for (const select of selectsOf(statements)) expect(select.columns).toEqual(["status", "n"]);
  });

  it("a count the driver returns as text is still a number", async () => {
    const { svc } = backend([
      [{ status: "completed", n: "5" }],
      [{ status: "completed", n: "2" }],
      [{ status: "accepted", n: "1" }],
    ]);

    const view = await svc.complianceDashboard(ORG, undefined);

    expect(view.hopeOnTimeCounts).toEqual({ onTime: 5, total: 5 });
    expect(view.sfvOnTimeCounts).toEqual({ onTime: 2, total: 2 });
    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 1, total: 1 });
  });
});

describe("retrySubmission — the status flip does not drag the package ZIP through the connection", () => {
  const rejected = { id: SUBMISSION, status: "rejected", providerEntityId: "pe", itemCount: 2 };

  it("reads and returns the light columns only (no acceptance_report)", async () => {
    const { svc, statements } = backend([[rejected], [{ ...rejected, status: "queued" }]]);

    const view = await svc.retrySubmission(ORG, SUBMISSION);

    expect(view.status).toBe("queued");
    const [select] = selectsOf(statements);
    const update = statements.find((s) => s.kind === "update");
    for (const statement of [select, update]) {
      expect(statement?.columns).toBeDefined();
      expect(statement?.columns).not.toContain("acceptanceReport");
    }
  });
});
