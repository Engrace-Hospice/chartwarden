// apps/backend/__tests__/hope-g1-twin-parity.test.ts — the in-memory HOPE backend (the twin the route tests run on) answers what
// the database backend answers, so a route test cannot pass on the twin where production answers 409 / 422 (or the other way round).
// Mirrors hope-g3-r3-route-service.test.ts, which scripts the database backend:
//   - skipSchedule: only an OPEN schedule can be skipped (409 otherwise, 404 when absent), never rewritten to 'skipped';
//   - recordTimepoint: rfaKind 04_sfv is refused with the typed 422 before anything is recorded;
//   - an id in another spelling of the same uuid names the same record (a uuid column compares case-insensitively), while an id
//     that names nothing is still refused (hope-g3-twin-canonical-ids.test.ts covers the spellings more widely).
import { describe, expect, it } from "vitest";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333abc";
const NOW = "2026-06-08T12:00:00.000Z";
const SCHEDULE_IDS = {
  open: "55555555-5555-4555-8555-5555555555a1",
  completed: "55555555-5555-4555-8555-5555555555a2",
  expired: "55555555-5555-4555-8555-5555555555a3",
  skipped: "55555555-5555-4555-8555-5555555555a4",
} as const;

function backend() {
  return createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    admissionPatients: { [ADMISSION]: PATIENT },
    schedules: (Object.keys(SCHEDULE_IDS) as Array<keyof typeof SCHEDULE_IDS>).map((status) => ({
      id: SCHEDULE_IDS[status],
      organizationId: ORG,
      patientId: PATIENT,
      admissionId: ADMISSION,
      rfaKind: "02_huv1" as const,
      status,
      windowOpensAt: "2026-06-06T00:00:00.000Z",
      windowClosesAt: "2026-06-20T00:00:00.000Z",
      lateDeadlineAt: "2026-06-27T00:00:00.000Z",
    })),
  });
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: {
      code?: string;
      statusCode?: number;
      message?: string;
      details?: Array<{ code?: string }>;
    }) => e,
  );

describe("in-memory skipSchedule — only an open schedule can be skipped", () => {
  it("skips an open schedule", async () => {
    const skipped = await backend().skipSchedule(ORG, SCHEDULE_IDS.open, "patient_declined");

    expect(skipped.status).toBe("skipped");
  });

  it.each(["completed", "expired", "skipped"] as const)(
    "a %s schedule is a 409 that names its status, and is left as it was",
    async (status) => {
      const svc = backend();

      const failure = await outcome(
        svc.skipSchedule(ORG, SCHEDULE_IDS[status], "patient_declined"),
      );

      expect(failure).toMatchObject({ statusCode: 409 });
      expect(String(failure?.message)).toContain(`is ${status}`);
      expect((await svc.getSchedule(ORG, SCHEDULE_IDS[status])).status).toBe(status);
    },
  );

  it("skipping twice is a 409 the second time (a double click must not read as a success)", async () => {
    const svc = backend();
    await svc.skipSchedule(ORG, SCHEDULE_IDS.open, "patient_declined");

    const failure = await outcome(svc.skipSchedule(ORG, SCHEDULE_IDS.open, "patient_declined"));

    expect(failure).toMatchObject({ statusCode: 409 });
  });

  it("a schedule that does not exist is a 404", async () => {
    const svc = backend();

    const unknown = await outcome(
      svc.skipSchedule(ORG, "55555555-5555-4555-8555-5555555555ff", "patient_declined"),
    );

    expect(unknown).toMatchObject({ statusCode: 404 });
    expect((await svc.getSchedule(ORG, SCHEDULE_IDS.open)).status).toBe("open");
  });

  it("an id in another spelling names the same schedule, as the uuid column does in the database", async () => {
    const svc = backend();

    const skipped = await svc.skipSchedule(
      ORG,
      SCHEDULE_IDS.open.toUpperCase(),
      "patient_declined",
    );

    expect(skipped.status).toBe("skipped");
    expect((await svc.getSchedule(ORG, SCHEDULE_IDS.open)).status).toBe("skipped");
  });
});

describe("in-memory recordTimepoint — an RFA-04 SFV is not a timepoint", () => {
  const args = (rfaKind: "04_sfv" | "02_huv1") => ({
    rfaKind,
    targetDate: NOW,
    authorDiscipline: "RN" as const,
    data: {},
  });

  it("is refused with the typed 422 and nothing is recorded or emitted", async () => {
    const svc = backend();

    const failure = await outcome(svc.recordTimepoint(ORG, "rn_1", ADMISSION, args("04_sfv")));

    expect(failure).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(String(failure?.message)).toContain("/hope/sfv");
    expect(failure?.details?.[0]?.code).toBe("M10_RFA_KIND_NOT_A_TIMEPOINT");
    expect((await svc.listPatientAssessments(ORG, PATIENT)).assessments).toEqual([]);
    expect(svc.drainEvents()).toEqual([]);
  });

  it("still records an ordinary timepoint on the same admission", async () => {
    const draft = await backend().recordTimepoint(ORG, "rn_1", ADMISSION, args("02_huv1"));

    expect(draft.status).toBe("draft");
  });

  it("an admission id in another spelling names the same admission and is recorded against its patient", async () => {
    const svc = backend();

    const draft = await svc.recordTimepoint(ORG, "rn_1", ADMISSION.toUpperCase(), args("02_huv1"));

    expect(draft.patientId).toBe(PATIENT);
    expect((await svc.listPatientAssessments(ORG, PATIENT)).assessments).toHaveLength(1);
  });

  it("an admission the M6 seam could not project is refused (M10_ADMISSION_PROJECTION_GAP), never recorded as an unscheduled timepoint", async () => {
    const svc = backend();

    const failure = await outcome(
      svc.recordTimepoint(ORG, "rn_1", "33333333-3333-4333-8333-333333333fff", args("02_huv1")),
    );

    expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP" });
    expect((await svc.listPatientAssessments(ORG, PATIENT)).assessments).toEqual([]);
  });
});
