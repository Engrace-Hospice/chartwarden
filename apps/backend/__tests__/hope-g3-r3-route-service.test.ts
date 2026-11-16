import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import type { HopeWriteOutboxPort } from "../src/modules/10-hope/outbox-port";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3, round 3, with the database scripted (no Postgres): the schedule skip re-judges the row it waits for, event
// payloads and outbox aggregate ids carry the id the DATABASE holds (never the caller's spelling of it), and a timepoint
// of RFA kind 04_sfv is refused with a typed 4xx before anything is read.
const ORG = "11111111-1111-4111-8111-111111111111";
// The acting membership a skip / regenerate hands the service for its audit event (no HTTP request in these tests).
const OPERATOR = { membershipId: "88888888-8888-4888-8888-888888888888" };
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const ADMISSION = "FEDCBA98-7654-4321-8FED-CBA987654321";
/** The record's id as the database writes it, and the same id as a URL may spell it (upper case; braces work too). */
const CANONICAL = "abcdef01-2345-4678-89ab-cdef01234567";
const SPELLED = CANONICAL.toUpperCase();

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

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const publish = vi.fn(async () => undefined);
  const outbox: HopeWriteOutboxPort = { publish };
  return { ...fake, publish, svc: createDbHopeBackend(fake.db, outbox) };
}

describe("skipSchedule — the UPDATE re-judges the row it waited for", () => {
  const scheduleRow = (status: string) => ({
    id: CANONICAL,
    patientId: PATIENT,
    admissionId: ADMISSION.toLowerCase(),
    rfaKind: "02_huv1",
    status,
    windowOpensAt: new Date("2026-06-01T00:00:00.000Z"),
    windowClosesAt: new Date("2026-06-05T00:00:00.000Z"),
    lateDeadlineAt: new Date("2026-06-10T00:00:00.000Z"),
    generatedBy: "system",
    completedByAssessmentId: null,
  });

  it("skips an OPEN schedule, and the UPDATE names the status it needs", async () => {
    // The second outcome is the `hope.schedule_skipped` audit insert on the same transaction.
    const { svc, statements } = backend([[scheduleRow("skipped")], []]);

    const skipped = await svc.skipSchedule(ORG, SPELLED, "other", OPERATOR);

    expect(skipped.status).toBe("skipped");
    const update = statements.find((s) => s.kind === "update");
    expect(update?.rendered?.sql).toContain('"status"');
    expect(update?.rendered?.params).toContain("open");
  });

  it("a schedule completed (or expired) since the request began is a 409 and is never rewritten to 'skipped'", async () => {
    // The UPDATE matched no row (its status is no longer open); the re-read says why.
    const { svc, statements } = backend([[], [{ status: "completed" }]]);

    const failure = await outcome(svc.skipSchedule(ORG, SPELLED, "other", OPERATOR));

    expect(failure).toMatchObject({ statusCode: 409 });
    expect(String(failure?.message)).toContain("completed");
    expect(statements.filter((s) => s.kind === "update")).toHaveLength(1);
  });

  it("a schedule that does not exist (or is hidden by RLS) is still a 404", async () => {
    const { svc } = backend([[], []]);

    const failure = await outcome(svc.skipSchedule(ORG, SPELLED, "other", OPERATOR));

    expect(failure).toMatchObject({ statusCode: 404 });
  });
});

describe("event payloads and aggregate ids carry the database's id, not the URL's spelling", () => {
  const submission = {
    id: CANONICAL,
    status: "rejected",
    providerEntityId: "pe-1",
    itemCount: 2,
  };

  it("retrySubmission: submission_queued is keyed on the stored id", async () => {
    const { svc, publish } = backend([[submission], [{ ...submission, status: "queued" }]]);

    await svc.retrySubmission(ORG, SPELLED).catch(() => undefined);

    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventName: "m10.hope.submission_queued",
        aggregateId: CANONICAL,
        payload: expect.objectContaining({ submissionId: CANONICAL }),
      }),
    );
  });

  it("markSubmissionUploaded: submission_transmitted is keyed on the stored id", async () => {
    const packaged = { ...submission, status: "packaged", packageSha256: "a".repeat(64) };
    const { svc, publish } = backend([
      [packaged],
      [{ ...packaged, status: "submitted_pending_result" }],
    ]);

    await svc.markSubmissionUploaded(ORG, MEMBERSHIP, SPELLED, {}).catch(() => undefined);

    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventName: "m10.hope.submission_transmitted",
        aggregateId: CANONICAL,
        payload: expect.objectContaining({ submissionId: CANONICAL }),
      }),
    );
  });

  it("requestSummaryPdf: summary_requested, and the reply, carry the stored assessment id", async () => {
    const { svc, publish } = backend([[{ id: CANONICAL, patientId: PATIENT }]]);

    const reply = await svc.requestSummaryPdf(ORG, MEMBERSHIP, SPELLED);

    expect(reply).toEqual({ assessmentId: CANONICAL, requested: true });
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventName: "m10.hope.summary_requested",
        aggregateId: CANONICAL,
        payload: expect.objectContaining({ assessmentId: CANONICAL }),
      }),
    );
  });

  describe("correct / inactivate", () => {
    const signed = {
      id: CANONICAL,
      status: "signed",
      supersededById: null,
      version: 1,
      rfaKind: "01_admission",
      specVersionId: "spec-1",
      isc: "HA",
      patientId: PATIENT,
      admissionId: ADMISSION.toLowerCase(),
      providerEntityId: null,
      locationId: null,
      targetDate: new Date("2026-06-01T00:00:00.000Z"),
      j2051MaxSeverity: null,
      j2051TriggerFired: false,
      wasLate: false,
      clinicalContextSnapshot: null,
    };
    const created = {
      ...signed,
      id: "99999999-9999-4999-8999-999999999999",
      status: "draft",
      correctsAssessmentId: CANONICAL,
    };
    // pending-lineage check, the source, the spec version + two allowed control values, the insert, the two control
    // answers (an item read and an upsert each), then the active-item and source-answer reads of the copy.
    const script = [
      [],
      [signed],
      [{ id: "spec-1", code: "v1" }],
      [{ id: "item-a0050" }],
      [{ id: "opt-1" }],
      [{ id: "item-a0250" }],
      [{ id: "opt-2" }],
      [created],
      [{ id: "item-a0050" }],
      [],
      [{ id: "item-a0250" }],
      [],
      [],
      [],
    ] as const;

    it("correctTimepoint: correction_submitted names the stored id of the original", async () => {
      const { svc, publish } = backend(script);

      await svc.correctTimepoint(ORG, MEMBERSHIP, SPELLED, {
        data: {},
        authorDiscipline: "RN",
        correctionReason: "typo",
        targetDate: "2026-06-01T00:00:00.000Z",
      });

      expect(publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventName: "m10.hope.correction_submitted",
          payload: expect.objectContaining({ originalAssessmentId: CANONICAL }),
        }),
      );
    });

    it("inactivateTimepoint: inactivation_created names the stored id of the target", async () => {
      const { svc, publish } = backend(script);

      await svc.inactivateTimepoint(ORG, MEMBERSHIP, SPELLED, {
        reason: "entered in error",
        authorDiscipline: "RN",
      } as never);

      expect(publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventName: "m10.hope.inactivation_created",
          payload: expect.objectContaining({ targetAssessmentId: CANONICAL }),
        }),
      );
    });
  });
});

describe("recordTimepoint — an RFA-04 SFV is not a timepoint", () => {
  it("is refused with a typed 422 before the database is touched (it used to reach the initializer and answer a 500)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw new Error("the seam must not be read for an SFV");
      },
    } as never);
    const { svc, statements } = backend([]);

    const failure = await outcome(
      svc.recordTimepoint(ORG, MEMBERSHIP, ADMISSION, {
        rfaKind: "04_sfv",
        targetDate: "2026-06-01T00:00:00.000Z",
        authorDiscipline: "RN",
        data: {},
      }),
    );

    expect(failure).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(String(failure?.message)).toContain("/hope/sfv");
    expect(statements).toHaveLength(0);
  });
});
