import { describe, expect, it, vi } from "vitest";
import { createHopeAssessmentAnswerService } from "../src/modules/10-hope/hope-answer-service";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { createHopeValidationService } from "../src/modules/10-hope/hope-validation-service";
import { scriptedDb } from "./_hope-g3-fake-db";

// A GET that a read-only caller (no `hope.timepoint.write`) makes must not write: the workspace open used to upsert the derived
// workflow-control answers, and the final-mode validation read used to reconcile the stored findings, both under no actor. Each
// case compares a writer's run, which does write (so the case is not vacuous), with a read-only run, which writes nothing.
// No Postgres: the database is scripted, and the spec registries are stubbed.
const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock("../src/modules/10-hope/spec/validation-registry", () => ({
  createHopeValidationEngine: () => ({ evaluate: mocks.evaluate }),
}));
vi.mock("../src/modules/10-hope/spec/applicability-registry", () => ({
  createHopeApplicabilityEngine: () => ({ evaluate: () => ({}) }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT = "22222222-2222-4222-8222-222222222222";

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
  scheduleId: null,
  data: {},
};
const writes = (fake: ReturnType<typeof scriptedDb>) =>
  fake.statements.filter((s) => s.kind === "update" || s.kind === "insert");

describe("GET workspace: the derived control answers are written only for a caller who may write", () => {
  // The workspace read: the assessment, its active items (A0050 is a workflow control), the stored answers (none, so the control
  // is out of date), then for a writer the row lock, the answers again and the upsert.
  const control = { item: { id: "item-a0050", itemCode: "A0050", kind: "assessment" } };
  const script = () => [[{ assessment, specCode: "1.00.1" }], [control], [], [assessment], [], []];
  const open = async (mayWrite: boolean) => {
    const fake = scriptedDb(script());
    await createHopeAssessmentAnswerService(fake.db)
      .getWorkspace(ORG, ASSESSMENT, { mayWrite })
      .catch(() => undefined); // the script ends after the statements under test
    return fake;
  };

  it("a writer's open upserts the out-of-date control answer", async () => {
    expect(writes(await open(true)).map((s) => s.kind)).toEqual(["insert"]);
  });

  it("a read-only caller's open writes nothing and takes no row lock", async () => {
    const fake = await open(false);

    expect(writes(fake)).toEqual([]);
    // No control reconcile: the lock select and the second answers read are never sent.
    expect(fake.statements.filter((s) => s.kind === "select").length).toBeLessThan(
      (await open(true)).statements.filter((s) => s.kind === "select").length,
    );
  });
});

describe("GET validation: a final run is stored only for a caller who may write", () => {
  const finding = {
    ruleId: "r",
    severity: "error",
    findingKind: null,
    section: "A",
    message: "m",
    fingerprint: "fp",
  };
  const stored = { id: "f-1", fingerprint: "fp", resolved: false };
  // assessment + spec code, active items (none), then for a persisting run the open findings, the update, the insert, the re-read.
  const script = () => [[{ assessment, specCode: "1.00.1" }], [], [stored], [], [], []];
  const run = async (persist?: boolean) => {
    mocks.evaluate.mockReturnValue([finding]);
    const fake = scriptedDb(script());
    const out = await createHopeValidationService(fake.db)
      .validateAssessment({ organizationId: ORG, assessmentId: ASSESSMENT, mode: "final", persist })
      .catch((error: unknown) => error);
    return { fake, out };
  };

  it("persists by default (the write paths)", async () => {
    const { fake } = await run();

    expect(writes(fake).length).toBeGreaterThan(0);
  });

  it("persist: false returns the computed findings as a final run and writes nothing", async () => {
    const { fake, out } = await run(false);

    expect(writes(fake)).toEqual([]);
    expect(out).toMatchObject({
      assessmentId: ASSESSMENT,
      mode: "final",
      findings: [expect.objectContaining({ ruleId: "r", fingerprint: "fp", resolved: false })],
    });
  });

  it("the service read passes the caller's write permission down: read-only stores nothing", async () => {
    mocks.evaluate.mockReturnValue([finding]);
    const readOnly = scriptedDb(script());
    const writer = scriptedDb(script());

    await createDbHopeBackend(readOnly.db).getValidation(ORG, ASSESSMENT, { mayWrite: false });
    await createDbHopeBackend(writer.db)
      .getValidation(ORG, ASSESSMENT, { mayWrite: true })
      .catch(() => undefined);

    expect(writes(readOnly)).toEqual([]);
    expect(writes(writer).length).toBeGreaterThan(0);
  });
});
