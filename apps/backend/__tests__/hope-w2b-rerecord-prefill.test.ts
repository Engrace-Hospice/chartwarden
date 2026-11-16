import { NotFoundError } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { scriptedDb } from "./_hope-g3-fake-db";

// M10 pre-PR review, fixer W2B (no Postgres; the fake database is scripted): re-recording a timepoint whose draft already
// exists is a re-open of that draft. The chart's answers are re-synced in `refreshOnly` mode, so a change bumps `version`
// (a signer who reviewed the older one is refused) and the view the call answers carries the post-prefill row. Only the
// FIRST fill of a brand-new record keeps `version` 1 (nobody has seen it, and a bump would 409 the first patch).
const mocks = vi.hoisted(() => ({ prefillAdmission: vi.fn(), validateAssessment: vi.fn() }));
vi.mock("../src/modules/10-hope/hope-admission-prefill-service", () => ({
  createHopeAdmissionPrefillService: () => ({ prefillAdmission: mocks.prefillAdmission }),
}));
vi.mock("../src/modules/10-hope/hope-validation-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-validation-service")>();
  return {
    ...actual,
    createHopeValidationService: () => ({ validateAssessment: mocks.validateAssessment }),
  };
});
vi.mock("../src/modules/10-hope/hope-record-initializer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-record-initializer")>();
  return {
    ...actual,
    initializeNewHopeRecord: async () => ({
      specVersionId: "spec-1",
      specVersionCode: "1.00.1",
      isc: "HA",
      controlAnswers: [],
    }),
  };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const ADMISSION = "abcdef01-2345-4678-89ab-cdef01234567";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";

const draft = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  patientId: "44444444-4444-4444-8444-444444444444",
  admissionId: ADMISSION,
  rfaKind: "01_admission",
  status: "draft",
  targetDate: new Date("2026-06-01T00:00:00.000Z"),
  authorDiscipline: "RN",
  j2051MaxSeverity: null,
  j2051TriggerFired: false,
  wasLate: false,
  signedAt: null,
  signedByMembershipId: null,
  correctsAssessmentId: null,
  supersededById: null,
  clinicalContextSnapshot: null,
  specVersionId: "spec-1",
  isc: "HA",
  providerEntityId: null,
  locationId: null,
  version: 3,
};
const args = {
  rfaKind: "01_admission",
  targetDate: "2026-06-01T00:00:00.000Z",
  authorDiscipline: "RN",
  data: {},
} as never;

beforeEach(() => {
  mocks.prefillAdmission.mockReset();
  mocks.validateAssessment.mockReset();
  registerSeam("AdmissionStatusReader", {
    getAdmissionSummary: async () => ({
      organizationId: ORG,
      patientId: draft.patientId,
      providerEntityId: null,
      locationId: null,
      admissionAt: "2026-06-01",
      dischargedAt: null,
    }),
  } as never);
});
afterEach(() => __resetSeamsForTest());

type Fake = ReturnType<typeof scriptedDb>;
const dataStatements = (fake: Fake) => fake.statements.filter((s) => s.kind !== "execute");
const namesTenant = (statement: Fake["statements"][number] | undefined): boolean =>
  /"organization_id" = \$\d+/.test(statement?.rendered?.sql ?? "") &&
  (statement?.rendered?.params ?? []).includes(ORG);

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  return { fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
}

describe("recordTimepoint on an existing draft", () => {
  // schedule lookup, existing-draft lookup, spec-initialisation read, then (only after a change) the post-prefill read.
  const reRecord = (prefilledItemCodes: readonly string[]) => {
    mocks.prefillAdmission.mockResolvedValue({ assessmentId: draft.id, prefilledItemCodes });
    return backend([[], [draft], [draft], [{ ...draft, version: 4 }]]);
  };

  it("re-syncs the chart in refreshOnly mode, so a rewritten answer bumps the version", async () => {
    const { svc } = reRecord(["A0220"]);

    await svc.recordTimepoint(ORG, USER, ADMISSION, args);

    expect(mocks.prefillAdmission).toHaveBeenCalledTimes(1);
    expect(mocks.prefillAdmission.mock.calls[0]?.[0]).toMatchObject({
      assessment: { id: draft.id },
      refreshOnly: true,
    });
  });

  it("answers the post-prefill row: the bumped version, not the one read before the prefill", async () => {
    const { fake, svc } = reRecord(["A0220"]);

    const view = await svc.recordTimepoint(ORG, USER, ADMISSION, args);

    expect(view).toMatchObject({ id: draft.id, version: 4 });
    expect(dataStatements(fake).map((s) => s.kind)).toEqual([
      "select",
      "select",
      "select",
      "select",
    ]);
    // ...and that re-read names the tenant beside the id.
    expect(namesTenant(dataStatements(fake)[3])).toBe(true);
  });

  it("an unchanged chart keeps the version and takes no second read", async () => {
    const { fake, svc } = reRecord([]);

    const view = await svc.recordTimepoint(ORG, USER, ADMISSION, args);

    expect(view).toMatchObject({ id: draft.id, version: 3 });
    expect(dataStatements(fake)).toHaveLength(3);
  });

  it("the schedule lookup and the existing-draft lookup name the tenant beside their ids", async () => {
    const { fake, svc } = reRecord([]);

    await svc.recordTimepoint(ORG, USER, ADMISSION, args);

    const [schedule, existing] = dataStatements(fake);
    expect(namesTenant(schedule)).toBe(true);
    expect(namesTenant(existing)).toBe(true);
  });

  it("a named schedule is looked up by id, admission AND tenant (a miss is a 404)", async () => {
    const { fake, svc } = backend([[]]);

    await expect(
      svc.recordTimepoint(ORG, USER, ADMISSION, {
        ...(args as object),
        scheduleId: SCHEDULE,
      } as never),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [schedule] = dataStatements(fake);
    expect(schedule?.rendered?.params).toContain(SCHEDULE);
    expect(namesTenant(schedule)).toBe(true);
  });
});

describe("recordTimepoint for a brand-new record", () => {
  it("fills it for the first time WITHOUT refreshOnly, and answers the row it inserted at version 1", async () => {
    mocks.prefillAdmission.mockResolvedValue({
      assessmentId: draft.id,
      prefilledItemCodes: ["A0220"],
    });
    // schedule lookup, existing-draft lookup (none), the insert.
    const { svc } = backend([[], [], [{ ...draft, version: 1 }]]);

    const view = await svc.recordTimepoint(ORG, USER, ADMISSION, args);

    expect(mocks.prefillAdmission).toHaveBeenCalledTimes(1);
    expect(mocks.prefillAdmission.mock.calls[0]?.[0].refreshOnly).toBeUndefined();
    expect(view).toMatchObject({ id: draft.id, version: 1 });
  });
});
