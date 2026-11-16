import { NotFoundError } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { reconcileCompletedSfvRegulatoryAnswers } from "../src/modules/10-hope/hope-sfv-completion-answers";
import { createHopeValidationService } from "../src/modules/10-hope/hope-validation-service";
import { scriptedDb } from "./_hope-g3-fake-db";

// M10 pre-PR review, fixer W2B (no Postgres; the fake database is scripted): the id-keyed reads and writes that were
// left with RLS as their only tenant guard now name `organization_id` beside the id. RLS cannot show it: a connection
// that bypasses RLS (the owner, a misconfigured role) is stopped only by the statement's own predicate, so each case
// fails when one is dropped. The live counterpart (an owner connection) is in m10-hope-write.live.test.ts.
vi.mock("../src/modules/10-hope/hope-sfv-completion-content", () => ({
  loadSfvRegulatoryItems: async () =>
    new Map(
      [
        "J2052A",
        "J2052B",
        "J2053A",
        "J2053B",
        "J2053C",
        "J2053D",
        "J2053E",
        "J2053F",
        "J2053G",
        "J2053H",
      ].map((code) => [code, { item: { id: `item-${code}`, itemCode: code }, options: [] }]),
    ),
  invalidSfvRegulatoryItemCodes: () => [],
}));
const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock("../src/modules/10-hope/spec/validation-registry", () => ({
  createHopeValidationEngine: () => ({ evaluate: mocks.evaluate }),
}));
vi.mock("../src/modules/10-hope/spec/applicability-registry", () => ({
  createHopeApplicabilityEngine: () => ({ evaluate: () => ({}) }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const ASSESSMENT = "22222222-2222-4222-8222-222222222222";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";
const SFV = "66666666-6666-4666-8666-666666666666";
const SUBMISSION = "77777777-7777-4777-8777-777777777777";
const ADMISSION = "abcdef01-2345-4678-89ab-cdef01234567";

type Fake = ReturnType<typeof scriptedDb>;
type Statement = Fake["statements"][number];
const dataStatements = (fake: Fake): Statement[] =>
  fake.statements.filter((s) => s.kind !== "execute");
const namesTenant = (s: Statement | undefined): boolean =>
  /"organization_id" = \$\d+/.test(s?.rendered?.sql ?? "") &&
  (s?.rendered?.params ?? []).includes(ORG);
const expectAllNameTenant = (fake: Fake, expected: readonly Statement["kind"][]): void => {
  const data = dataStatements(fake);
  expect(data.map((s) => s.kind)).toEqual(expected);
  data.forEach((statement, index) => {
    expect(namesTenant(statement), `statement ${index} (${statement.kind})`).toBe(true);
  });
};

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  return { fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
}

afterEach(() => __resetSeamsForTest());

describe("the id-keyed reads name the tenant beside the id", () => {
  it("getSchedule", async () => {
    const { fake, svc } = backend([[]]);
    await expect(svc.getSchedule(ORG, SCHEDULE)).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select"]);
  });

  it("getAssessment", async () => {
    const { fake, svc } = backend([[]]);
    await expect(svc.getAssessment(ORG, ASSESSMENT)).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select"]);
  });

  it("getSfv", async () => {
    const { fake, svc } = backend([[]]);
    await expect(svc.getSfv(ORG, SFV)).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select"]);
  });

  it("getSubmission", async () => {
    const { fake, svc } = backend([[]]);
    await expect(svc.getSubmission(ORG, SUBMISSION)).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select"]);
  });

  it("listPatientAssessments", async () => {
    const { fake, svc } = backend([[]]);
    await svc.listPatientAssessments(ORG, "44444444-4444-4444-8444-444444444444");
    expectAllNameTenant(fake, ["select"]);
  });

  it("listAssessmentSubmissions: the assessment it first loads", async () => {
    const { fake, svc } = backend([[]]);
    await expect(svc.listAssessmentSubmissions(ORG, ASSESSMENT)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expectAllNameTenant(fake, ["select"]);
  });

  it("getWorkflowState: the schedules, the assessments and the SFVs of the admission", async () => {
    registerSeam("AdmissionStatusReader", { getAdmissionSummary: async () => null } as never);
    const { fake, svc } = backend([[], [], []]);
    await svc.getWorkflowState(ORG, ADMISSION);
    expectAllNameTenant(fake, ["select", "select", "select"]);
  });
});

describe("the assessment loader behind the draft, correction and summary writes names the tenant", () => {
  it("requestSummaryPdf", async () => {
    const { fake, svc } = backend([[]]);
    await expect(svc.requestSummaryPdf(ORG, USER, ASSESSMENT)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expectAllNameTenant(fake, ["select"]);
  });

  it("setHuvCompletionDate", async () => {
    const { fake, svc } = backend([[]]);
    await expect(
      svc.setHuvCompletionDate(ORG, USER, ASSESSMENT, {
        ifVersion: 1,
        z0350: "2026-06-03",
      } as never),
    ).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select"]);
  });

  it("correctTimepoint: the pending-correction check and the source read", async () => {
    const { fake, svc } = backend([[], []]);
    await expect(
      svc.correctTimepoint(ORG, USER, ASSESSMENT, { correctionReason: "x" } as never),
    ).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select", "select"]);
  });

  it("inactivateTimepoint: the pending-correction check and the source read", async () => {
    const { fake, svc } = backend([[], []]);
    await expect(
      svc.inactivateTimepoint(ORG, USER, ASSESSMENT, { reason: "x" } as never),
    ).rejects.toBeInstanceOf(NotFoundError);
    expectAllNameTenant(fake, ["select", "select"]);
  });
});

describe("the SFV self-heal locks the SFV row by id AND tenant", () => {
  const completedSfv = {
    id: SFV,
    organizationId: ORG,
    status: "completed",
    completedAt: new Date("2026-06-02T00:00:00.000Z"),
    completingAssessmentId: "99999999-9999-4999-8999-999999999999",
    triggeringAssessmentId: ASSESSMENT,
  };
  const completion = {
    rfaKind: "04_sfv",
    status: "signed",
    targetDate: new Date("2026-06-02T00:00:00.000Z"),
    data: {
      J: { J2053: Object.fromEntries([..."ABCDEFGH"].map((letter) => [`J2053${letter}`, "1"])) },
    },
  };
  const draft = {
    id: ASSESSMENT,
    organizationId: ORG,
    status: "draft",
    specVersionId: "spec-1",
    isc: "HA",
    providerEntityId: null,
    locationId: null,
  };

  it("the FOR UPDATE select of the SFV carries organization_id", async () => {
    // SFV peek, completion, unlocked draft, its stored answers (none: something differs), then the SFV row lock.
    const fake = scriptedDb([[completedSfv], [completion], [draft], [], [completedSfv]]);

    await reconcileCompletedSfvRegulatoryAnswers(fake.tx, ORG, ASSESSMENT).catch(() => undefined);

    const rowLock = dataStatements(fake).find((s) => s.rendered?.params.includes(SFV));
    expect(rowLock?.kind).toBe("select");
    expect(namesTenant(rowLock)).toBe(true);
  });
});

describe("the validation findings are read and written by id AND tenant", () => {
  const assessment = {
    id: ASSESSMENT,
    organizationId: ORG,
    providerEntityId: "pe-1",
    locationId: "loc-1",
    specVersionId: "spec-1",
    isc: "HA",
    rfaKind: "01_admission",
    status: "draft",
    targetDate: new Date("2026-06-01T00:00:00.000Z"),
    correctsAssessmentId: null,
    data: {},
  };
  const stored = (id: string, fingerprint: string) => ({ id, fingerprint, resolved: false });
  const finding = (fingerprint: string) => ({
    ruleId: "r",
    severity: "error",
    findingKind: null,
    section: "A",
    message: "m",
    fingerprint,
  });

  it("reads the open findings, resolves the gone one, updates the kept one, and re-reads - all with organization_id", async () => {
    mocks.evaluate.mockReturnValue([finding("keep"), finding("new")]);
    // assessment + spec code, active items (none), open findings, resolve "gone", update "keep", insert "new", re-read.
    const fake = scriptedDb([
      [{ assessment, specCode: "1.00.1" }],
      [],
      [stored("f-gone", "gone"), stored("f-keep", "keep")],
      [],
      [],
      [],
      [],
    ]);

    await createHopeValidationService(fake.db).validateAssessment({
      organizationId: ORG,
      assessmentId: ASSESSMENT,
      mode: "final",
    });

    const data = dataStatements(fake);
    expect(data.map((s) => s.kind)).toEqual([
      "select",
      "select",
      "select",
      "update",
      "update",
      "insert",
      "select",
    ]);
    // Every statement that has a WHERE: the findings' own ones included (the insert has none, it sets the column itself).
    for (const index of [0, 2, 3, 4, 6]) {
      expect(namesTenant(data[index]), `statement ${index} (${data[index]?.kind})`).toBe(true);
    }
  });
});
