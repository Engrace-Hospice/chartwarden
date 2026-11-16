// apps/backend/__tests__/hope-g3-twin-canonical-ids.test.ts — the in-memory HOPE backend (the twin every route test runs on)
// answers what the database backend answers for the same request: an id in any spelling Postgres reads as one uuid names
// one record, a report row names its assessment the same way, the provider-entity filter narrows every figure it labels,
// and `transmittedAt` (the CMS retention anchor) is the server's clock, never a date the caller sent.
// (backend-code-k4..k7, k15, k19; classes: caller-spelling keys, caller-controlled retention anchor, unscoped aggregate.)
import { describe, expect, it } from "vitest";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/index";

const ORG = "org_a";
// Hex letters on purpose: the upper-cased and braced spellings differ from the stored text.
const PATIENT = "1111111a-1111-4111-8111-11111111111b";
const ADMISSION = "3333333c-3333-4333-8333-33333333333d";
const SCHEDULE = "5555555a-5555-4555-8555-5555555555ab";
const SIGNED = "9000000a-bcde-4000-8000-00000000000a";
const PE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = "2026-06-08T12:00:00.000Z";

const upper = (id: string) => id.toUpperCase();
const braced = (id: string) => `{${id}}`;
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number }) => e,
  );

function backend() {
  return createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    admissionPatients: { [ADMISSION]: PATIENT },
    schedules: [
      {
        id: SCHEDULE,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        rfaKind: "02_huv1",
        status: "open",
        windowOpensAt: "2026-06-06T00:00:00.000Z",
        windowClosesAt: "2026-06-20T00:00:00.000Z",
        lateDeadlineAt: "2026-06-27T00:00:00.000Z",
      },
    ],
    assessments: [
      {
        id: SIGNED,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        rfaKind: "01_admission",
        status: "signed",
        providerEntityId: PE_A,
        regulatory: { specVersionId: "sv_1", isc: "HA" },
      },
    ],
  });
}

describe("twin: an id in any spelling names the same record", () => {
  it.each([
    ["upper-case", upper],
    ["braced", braced],
  ])("getSchedule and skipSchedule find a schedule named %s", async (_label, spell) => {
    const svc = backend();

    const read = await svc.getSchedule(ORG, spell(SCHEDULE));
    const skipped = await svc.skipSchedule(ORG, spell(SCHEDULE), "other");

    expect(read.id).toBe(SCHEDULE);
    expect(skipped.status).toBe("skipped");
    expect((await svc.getSchedule(ORG, SCHEDULE)).status).toBe("skipped");
  });

  it("an id that names no schedule is still a 404", async () => {
    const failure = await rejection(
      backend().getSchedule(ORG, "5555555a-5555-4555-8555-5555555555ff"),
    );

    expect(failure).toMatchObject({ statusCode: 404 });
  });

  it("records a timepoint for an upper-case admission id and stores the canonical one", async () => {
    const svc = backend();

    const draft = await svc.recordTimepoint(ORG, "rn_1", upper(ADMISSION), {
      rfaKind: "02_huv1",
      targetDate: NOW,
      authorDiscipline: "RN",
      data: {},
    });

    expect(draft.patientId).toBe(PATIENT);
    expect(draft.admissionId).toBe(ADMISSION);
    const timeline = await svc.listPatientAssessments(ORG, upper(PATIENT));
    expect(timeline.assessments.map((a) => a.id)).toContain(draft.id);
    const workflow = await svc.getWorkflowState(ORG, upper(ADMISSION));
    expect(workflow.admissionId).toBe(ADMISSION);
    expect(workflow.patientId).toBe(PATIENT); // not an empty read: the lookup ran on the canonical id
  });

  it("reads an assessment by an upper-case id and records events on the stored one", async () => {
    const svc = backend();

    const view = await svc.getAssessment(ORG, upper(SIGNED));
    await svc.requestSummaryPdf(ORG, "rn_1", upper(SIGNED));

    expect(view.id).toBe(SIGNED);
    expect(svc.drainEvents()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ assessmentId: SIGNED }) }),
    ]);
  });
});

describe("twin: importSubmissionResult reads a report row's assessment id the way the database does", () => {
  async function uploadedBatch() {
    const svc = backend();
    const batch = await svc.assembleSubmission(ORG, PE_A);
    await svc.markSubmissionUploaded(ORG, "u1", batch.id, {});
    svc.drainEvents();
    return { svc, batch };
  }

  it.each([
    ["upper-case", upper(SIGNED)],
    ["braced", braced(SIGNED)],
    ["padded with spaces", ` ${SIGNED} `],
  ])(
    "a row naming its assessment %s settles the item and publishes the outcome",
    async (_label, spelled) => {
      const { svc, batch } = await uploadedBatch();

      const out = await svc.importSubmissionResult(ORG, "u1", batch.id, {
        results: [{ assessmentId: spelled, status: "accepted", iqiesRecordId: "REC-1" }],
      });

      expect(out.status).toBe("accepted");
      expect(out.items.map((i) => [i.assessmentId, i.status, i.iqiesRecordId])).toEqual([
        [SIGNED, "accepted", "REC-1"],
      ]);
      expect(svc.drainEvents().map((e) => e.eventName)).toEqual(["m10.hope.submission_accepted"]);
    },
  );

  it("the finding of a matched row names the stored assessment id, not the spelling in the report", async () => {
    const { svc, batch } = await uploadedBatch();

    const out = await svc.importSubmissionResult(ORG, "u1", batch.id, {
      results: [{ assessmentId: upper(SIGNED), status: "rejected", code: "-3001", message: "bad" }],
    });

    expect(out.findings).toEqual([
      expect.objectContaining({ assessmentId: SIGNED, code: "-3001" }),
    ]);
  });

  it("a row that names no assessment of the batch is still refused, and the batch is left as it was", async () => {
    const { svc, batch } = await uploadedBatch();

    const failure = await rejection(
      svc.importSubmissionResult(ORG, "u1", batch.id, {
        results: [{ assessmentId: "9000000a-bcde-4000-8000-0000000000ff", status: "accepted" }],
      }),
    );

    expect(failure).toMatchObject({ code: "M10_SUBMISSION_RESULT_NO_MATCH" });
    expect((await svc.getSubmission(ORG, batch.id)).status).toBe("submitted_pending_result");
    expect(svc.drainEvents()).toEqual([]);
  });
});

describe("twin: assembleSubmission packages only the provider entity it is asked for", () => {
  it("an entity with no signed assessment is the ordinary 409, not a batch of another entity's records", async () => {
    const failure = await rejection(backend().assembleSubmission(ORG, PE_B));

    expect(failure).toMatchObject({ statusCode: 409 });
  });

  it("names the entity in any spelling", async () => {
    const batch = await backend().assembleSubmission(ORG, upper(PE_A));

    expect(batch.providerEntityId).toBe(PE_A);
    expect(batch.itemCount).toBe(1);
  });
});

describe("twin: markSubmissionUploaded keeps the retention anchor on the server's clock", () => {
  async function packaged() {
    const svc = backend();
    const batch = await svc.assembleSubmission(ORG, PE_A);
    return { svc, batch };
  }

  it.each([
    ["back-dated", "2020-01-01T00:00:00.000Z"],
    ["far-future", "2099-01-01T00:00:00.000Z"],
  ])(
    "a %s submittedAt moves submittedAt, never transmittedAt (view and event)",
    async (_label, callerDate) => {
      const { svc, batch } = await packaged();

      const view = await svc.markSubmissionUploaded(ORG, "u1", batch.id, {
        submittedAt: callerDate,
      });

      expect(view.transmittedAt).toBe(NOW);
      expect(view.submittedAt).toBe(callerDate);
      const event = svc
        .drainEvents()
        .find((e) => e.eventName === "m10.hope.submission_transmitted");
      expect(event?.payload).toMatchObject({ transmittedAt: NOW, submittedAt: callerDate });
    },
  );

  it("an offset submittedAt is stored as the instant it names, as the database view writes it", async () => {
    const { svc, batch } = await packaged();

    const view = await svc.markSubmissionUploaded(ORG, "u1", batch.id, {
      submittedAt: "2026-06-08T08:00:00-04:00",
    });

    expect(view.submittedAt).toBe("2026-06-08T12:00:00.000Z");
  });

  it("with no submittedAt both are the server's instant", async () => {
    const { svc, batch } = await packaged();

    const view = await svc.markSubmissionUploaded(ORG, "u1", batch.id, {});

    expect(view.transmittedAt).toBe(NOW);
    expect(view.submittedAt).toBe(NOW);
  });
});

describe("twin: the provider-entity filter narrows every figure and list it labels", () => {
  const sched = (id: string, status: "completed" | "expired", providerEntityId: string | null) => ({
    id,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    rfaKind: "02_huv1" as const,
    status,
    providerEntityId,
    windowOpensAt: "2026-06-06T00:00:00.000Z",
    windowClosesAt: "2026-06-20T00:00:00.000Z",
    lateDeadlineAt: "2026-06-27T00:00:00.000Z",
  });
  const sfv = (id: string, status: "completed" | "missed", providerEntityId: string) => ({
    id,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    triggeringAssessmentId: SIGNED,
    status,
    providerEntityId,
    dueAt: "2026-06-10T00:00:00.000Z",
  });
  const sub = (id: string, status: "accepted" | "rejected", providerEntityId: string) => ({
    id,
    organizationId: ORG,
    providerEntityId,
    status,
  });
  function seeded() {
    return createInMemoryHopeBackend({
      now: () => NOW,
      schedules: [
        sched("5555555a-0000-4000-8000-0000000000a1", "completed", PE_A),
        sched("5555555a-0000-4000-8000-0000000000a2", "completed", PE_A),
        sched("5555555a-0000-4000-8000-0000000000b1", "expired", PE_B),
        sched("5555555a-0000-4000-8000-0000000000c1", "expired", null),
      ],
      sfvs: [
        sfv("6666666a-0000-4000-8000-0000000000a1", "completed", PE_A),
        sfv("6666666a-0000-4000-8000-0000000000b1", "missed", PE_B),
      ],
      submissions: [
        sub("7777777a-0000-4000-8000-0000000000a1", "accepted", PE_A),
        sub("7777777a-0000-4000-8000-0000000000b1", "rejected", PE_B),
      ],
    });
  }

  it("the dashboard of one provider entity counts only that entity's schedules, SFVs and submissions", async () => {
    const view = await seeded().complianceDashboard(ORG, PE_A);

    expect(view.providerEntityId).toBe(PE_A);
    expect(view.hopeOnTimeCounts).toEqual({ onTime: 2, total: 2 });
    expect(view.sfvOnTimeCounts).toEqual({ onTime: 1, total: 1 });
    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 1, total: 1 });
  });

  it("names the same entity in any spelling", async () => {
    const view = await seeded().complianceDashboard(ORG, upper(PE_A));

    expect(view.hopeOnTimeCounts).toEqual({ onTime: 2, total: 2 });
    expect(view.sfvOnTimeCounts).toEqual({ onTime: 1, total: 1 });
    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 1, total: 1 });
  });

  it("with no provider entity named it reads the whole organisation (no predicate)", async () => {
    const view = await seeded().complianceDashboard(ORG, undefined);

    expect(view.hopeOnTimeCounts).toEqual({ onTime: 2, total: 4 });
    expect(view.sfvOnTimeCounts).toEqual({ onTime: 1, total: 2 });
    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 1, total: 2 });
  });

  it("an entity no record carries matches nothing: no data, never a perfect score", async () => {
    const view = await seeded().complianceDashboard(ORG, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

    expect(view.hopeOnTimeRate).toBeNull();
    expect(view.sfvOnTimeRate).toBeNull();
    expect(view.submissionAcceptanceRate).toBeNull();
  });

  it("listSubmissions narrows on the same canonical comparison", async () => {
    const svc = seeded();

    const named = await svc.listSubmissions(ORG, braced(PE_B));
    const all = await svc.listSubmissions(ORG, undefined);

    expect(named.submissions.map((s) => s.providerEntityId)).toEqual([PE_B]);
    expect(all.submissions).toHaveLength(2);
  });

  it("the provider entity of a schedule is a filter fact, not part of the schedule view", async () => {
    const view = await seeded().getSchedule(ORG, "5555555a-0000-4000-8000-0000000000a1");

    expect(view).not.toHaveProperty("providerEntityId");
  });
});
