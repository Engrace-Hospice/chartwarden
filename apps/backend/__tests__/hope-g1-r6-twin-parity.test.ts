// apps/backend/__tests__/hope-g1-r6-twin-parity.test.ts — the in-memory HOPE backend (the twin every route test runs on) answers
// what the database backend answers, for the five places the last review found them apart (classes: twin-parity,
// caller-spelling keys, identical-wording):
//   - the "send the request again with a NEW Idempotency-Key" sentence is on the request path (route 20) only: a consumer
//     delivery has no key, so the message it dead-letters does not carry it;
//   - a list filter typed in upper case (`?patientId=`, a caseload list) narrows the twin as it narrows the database;
//   - the SFV completion's M10_ADMISSION_PROJECTION_GAP carries the database backend's own message, and the timepoint one is
//     labelled as the twin-only guard it is;
//   - importSubmissionResult takes the iQIES record id from the WINNING row of an assessment (the worst outcome, the first row
//     that reached it), never from every row that names it;
//   - the dashboard's `providerEntityId` is echoed as the canonical id on both backends (pinned here against the database
//     backend); the workflow state's and regenerate's `admissionId` are the canonical id on the twin.
import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import {
  resolveSfvAdmissionPatient,
  sfvProjectionGapMessage,
} from "../src/modules/10-hope/hope-sfv-completion-guards";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/index";
import {
  M10_ADMISSION_ACTIVATED_EVENT,
  buildM10AdmissionSchedulingConsumer,
} from "../src/modules/10-hope/outbox-consumers/m6-admission-scheduling";
import type { HopeWriteOutboxPort } from "../src/modules/10-hope/outbox-port";
import {
  regenerateSchedulesForAdmission,
  schedulingSitingFor,
} from "../src/modules/10-hope/scheduling/schedule-writer";
import { scriptedDb } from "./_hope-g3-fake-db";

const ORG = "org_a";
// Hex letters on purpose: the upper-cased spelling differs from the stored text.
const PATIENT = "1111111a-1111-4111-8111-11111111111b";
const OTHER_PATIENT = "2222222a-2222-4222-8222-22222222222b";
const ADMISSION = "3333333c-3333-4333-8333-33333333333d";
const UNSEEDED_ADMISSION = "3333333c-3333-4333-8333-333333333fff";
const SCHEDULE = "5555555a-5555-4555-8555-5555555555ab";
const SFV = "7777777a-7777-4777-8777-7777777777ab";
const TRIGGER = "9000000a-bcde-4000-8000-00000000000a";
const SIGNED = "9000000b-bcde-4000-8000-00000000000b";
const PE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-06-08T12:00:00.000Z";

const upper = (id: string) => id.toUpperCase();
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number; message?: string }) => e,
  );

function twin() {
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
    sfvs: [
      {
        id: SFV,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        triggeringAssessmentId: TRIGGER,
        status: "open",
        triggeredAt: "2026-06-01T00:00:00.000Z",
        dueAt: "2026-06-03T00:00:00.000Z",
      },
    ] as never,
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

function dbBackend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const outbox: HopeWriteOutboxPort = { publish: vi.fn(async () => undefined) };
  return createDbHopeBackend(scriptedDb(outcomes).db, outbox);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetSeamsForTest();
});

describe("twin: a list filter typed in another spelling narrows as the database does", () => {
  it.each([
    ["an upper-case patientId", { patientId: upper(PATIENT) }],
    ["an upper-case caseload list", { patientIds: [upper(PATIENT)] }],
  ])("listSchedules matches on %s", async (_label, filter) => {
    expect((await twin().listSchedules(ORG, filter)).schedules.map((s) => s.id)).toEqual([
      SCHEDULE,
    ]);
  });

  it("listSchedules still excludes another patient's schedule", async () => {
    const view = await twin().listSchedules(ORG, { patientIds: [upper(OTHER_PATIENT)] });

    expect(view.schedules).toEqual([]);
  });

  it("listSfv matches an upper-case caseload list, and not another patient's", async () => {
    const svc = twin();

    const own = await svc.listSfv(ORG, undefined, [upper(PATIENT)]);
    const other = await svc.listSfv(ORG, undefined, [upper(OTHER_PATIENT)]);

    expect(own.sfvs.map((s) => s.id)).toEqual([SFV]);
    expect(other.sfvs).toEqual([]);
  });
});

describe("twin: the M10_ADMISSION_PROJECTION_GAP of an SFV completion is the database backend's", () => {
  const completion = {
    triggeringAssessmentId: TRIGGER,
    targetDate: NOW,
    authorDiscipline: "RN",
    data: {},
    attestationConfirmed: true,
  };

  it("carries the message the database backend raises for the same unprojectable admission", async () => {
    registerSeam("AdmissionStatusReader", { getAdmissionSummary: async () => undefined } as never);
    const database = await rejection(resolveSfvAdmissionPatient(ORG, UNSEEDED_ADMISSION));

    const inMemory = await rejection(
      twin().recordSfv(ORG, "rn_1", UNSEEDED_ADMISSION, completion as never),
    );

    expect(database?.message).toBe(sfvProjectionGapMessage(UNSEEDED_ADMISSION));
    expect(inMemory).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    expect(inMemory?.message).toBe(database?.message);
    expect(inMemory?.message).toContain("NEW Idempotency-Key");
  });

  it("a timepoint on that admission is refused too, with the twin's own wording (the database backend has no such refusal there)", async () => {
    const failure = await rejection(
      twin().recordTimepoint(ORG, "rn_1", UNSEEDED_ADMISSION, {
        rfaKind: "02_huv1",
        targetDate: NOW,
        authorDiscipline: "RN",
        data: {},
      }),
    );

    expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    expect(failure?.message).not.toContain("NEW Idempotency-Key");
  });
});

describe("twin: importSubmissionResult takes the iQIES record id from the winning row only", () => {
  async function uploadedBatch() {
    const svc = twin();
    const batch = await svc.assembleSubmission(ORG, PE_A);
    await svc.markSubmissionUploaded(ORG, "u1", batch.id, {});
    return { svc, batch };
  }
  const itemOf = (view: { items: readonly { status: string; iqiesRecordId: string | null }[] }) =>
    view.items.map((i) => [i.status, i.iqiesRecordId]);

  it.each([
    [
      "the accepted row first",
      [
        { assessmentId: SIGNED, status: "accepted", iqiesRecordId: "R1" },
        { assessmentId: SIGNED, status: "rejected", code: "-3001" },
      ],
    ],
    [
      "the rejected row first",
      [
        { assessmentId: SIGNED, status: "rejected", code: "-3001" },
        { assessmentId: SIGNED, status: "accepted", iqiesRecordId: "R1" },
      ],
    ],
  ])(
    "a rejected assessment never carries the record id of an accepted row of the same assessment (%s)",
    async (_label, results) => {
      const { svc, batch } = await uploadedBatch();

      const out = await svc.importSubmissionResult(ORG, "u1", batch.id, { results });

      expect(itemOf(out)).toEqual([["rejected", null]]);
    },
  );

  it("of two rows with the same outcome the first one's record id wins, as in the database backend", async () => {
    const { svc, batch } = await uploadedBatch();

    const out = await svc.importSubmissionResult(ORG, "u1", batch.id, {
      results: [
        { assessmentId: SIGNED, status: "accepted", iqiesRecordId: "R1" },
        { assessmentId: SIGNED, status: "accepted", iqiesRecordId: "R2" },
      ],
    });

    expect(itemOf(out)).toEqual([["accepted", "R1"]]);
  });

  it("the single accepted row still records its id", async () => {
    const { svc, batch } = await uploadedBatch();

    const out = await svc.importSubmissionResult(ORG, "u1", batch.id, {
      results: [{ assessmentId: upper(SIGNED), status: "accepted", iqiesRecordId: "R9" }],
    });

    expect(itemOf(out)).toEqual([["accepted", "R9"]]);
  });
});

describe("the echoed id is the canonical id the database stores, not the caller's spelling", () => {
  it("complianceDashboard echoes the provider entity as Postgres writes it on both backends, and null when none was sent", async () => {
    const database = dbBackend([[], [], []]);
    const inMemory = twin();

    const databaseView = await database.complianceDashboard(ORG, upper(PE_A));
    const twinView = await inMemory.complianceDashboard(ORG, upper(PE_A));

    expect(twinView.providerEntityId).toBe(PE_A);
    expect(twinView.providerEntityId).toBe(databaseView.providerEntityId);
    expect((await inMemory.complianceDashboard(ORG, undefined)).providerEntityId).toBeNull();
  });

  it("getWorkflowState and regenerateSchedules echo the canonical admission id, and still find the stored admission", async () => {
    // The database backend's getWorkflowState still echoes the spelling that was sent (hope-route-service-db.ts, the
    // `buildWorkflowState({ admissionId })` call): a parity comparison with it belongs here once it canonicalises too.
    const inMemory = twin();

    const workflow = await inMemory.getWorkflowState(ORG, upper(ADMISSION));
    const regenerated = await inMemory.regenerateSchedules(ORG, upper(ADMISSION));

    expect(workflow.admissionId).toBe(ADMISSION);
    expect(workflow.patientId).toBe(PATIENT); // not an empty read: the lookup ran on the canonical id
    expect(regenerated).toEqual({ admissionId: ADMISSION, scheduleCount: 1 });
  });
});

describe("the retry-with-a-new-key sentence belongs to the request path only", () => {
  const NEW_KEY = "NEW Idempotency-Key";
  const unsited = async () => ({
    patientId: PATIENT,
    providerEntityId: null,
    locationId: null,
    admissionAt: null,
    activatedAt: null,
    dischargedAt: null,
  });

  it.each([
    ["not visible", async () => null, "is not visible in this organization"],
    ["not sited", unsited, "is not sited"],
  ])("route 20 carries it on an admission that is %s", async (_label, resolveSiting, gap) => {
    const failure = await rejection(
      regenerateSchedulesForAdmission(
        {} as DbClient,
        { publish: async () => undefined },
        {
          organizationId: ORG,
          admissionId: ADMISSION,
          resolveSiting,
        },
      ),
    );

    expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    expect(failure?.message).toContain(gap);
    expect(failure?.message).toContain(NEW_KEY);
  });

  it.each([
    ["not visible", async () => null, "is not visible in this organization"],
    ["not sited", unsited, "is not sited"],
  ])(
    "the outbox consumer's dead-letter message does not, on an admission that is %s",
    async (_label, resolveSiting, gap) => {
      const consumer = buildM10AdmissionSchedulingConsumer({
        db: {} as DbClient,
        outbox: { publish: async () => undefined },
        resolveSiting,
      });

      const failure = await rejection(
        consumer.handle({
          organizationId: ORG,
          eventType: M10_ADMISSION_ACTIVATED_EVENT,
          payload: { admissionId: ADMISSION, activatedAt: "2026-06-01T12:00:00.000Z" },
        }),
      );

      expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
      expect(failure?.message).toContain(gap);
      expect(failure?.message).not.toContain(NEW_KEY);
      expect(failure?.message).not.toContain("Idempotency");
    },
  );

  it("schedulingSitingFor without the option (the consumer's call) leaves the message as the gap alone", async () => {
    const failure = await rejection(schedulingSitingFor(ORG, ADMISSION, async () => null));

    expect(failure?.message).toBe(`Admission ${ADMISSION} is not visible in this organization.`);
  });
});
