import { describe, expect, it } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { scriptedDb } from "./_hope-g3-fake-db";

// GET review for a caller without `hope.timepoint.write` (a reader) on a draft that no writer has opened: is it the review a writer
// gets? The readiness service derives the workflow controls (A0050, A0250) in memory for EVERY caller (`workflowControlAnswers` ->
// `candidateAnswers`), so a reader is not shown them as missing and the review needs no fix, unlike the workspace. This pins that
// claim: the reader's review equals a writer's review of the same unreconciled draft, equals a writer's review after the controls were
// stored, lists no A0050/A0250 blocker, and the reader's open writes nothing. No Postgres: the database is scripted and the real
// v1.00.1 engines run.
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT = "22222222-2222-4222-8222-222222222222";
const SPEC = "33333333-3333-4333-8333-333333333333";
const A0050 = "44444444-4444-4444-8444-444444444441";
const A0250 = "44444444-4444-4444-8444-444444444442";
const A0100 = "44444444-4444-4444-8444-444444444443";

const assessment = {
  id: ASSESSMENT,
  organizationId: ORG,
  providerEntityId: "pe-1",
  locationId: "loc-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  specVersionId: SPEC,
  isc: "HA",
  rfaKind: "01_admission",
  status: "draft",
  version: 1,
  data: {},
  targetDate: new Date("2026-06-01T00:00:00.000Z"),
  correctsAssessmentId: null,
  scheduleId: null,
  signedAt: null,
  signedByMembershipId: null,
};
const item = (id: string, itemCode: string) => ({
  item: { id, itemCode, kind: "assessment", sectionLabel: "A", shortLabel: itemCode },
});
const items = [item(A0050, "A0050"), item(A0250, "A0250"), item(A0100, "A0100")];
const stored = (specItemId: string, value: string) => ({
  specItemId,
  hopeAssessmentId: ASSESSMENT,
  state: "answered",
  value,
  source: "derived",
});
const writes = (fake: ReturnType<typeof scriptedDb>) =>
  fake.statements.filter((s) => s.kind === "update" || s.kind === "insert");

/** The statements of the review path. A writer also runs the SFV self-heal (one peek, no SFV on this draft); a reader does not. */
const review = async (mayWrite: boolean, storedAnswers: unknown[]) => {
  const fake = scriptedDb([
    [assessment], // ensureDraftSpecInitialized: the draft already has its spec
    ...(mayWrite ? [[]] : []), // the self-heal's SFV peek: nothing to heal
    [{ assessment, specCode: "1.00.1" }], // the readiness read
    items,
    storedAnswers,
    [], // the operational SFV of the draft: none
  ]);
  const backend = createDbHopeBackend(fake.db, { publish: async () => undefined });
  const out = await backend.getAssessmentReview(ORG, ASSESSMENT, { mayWrite });
  return { fake, out };
};

describe("GET review of an unreconciled draft: a reader sees what a writer sees", () => {
  it("the reader's review equals a writer's, before and after the controls are stored", async () => {
    const reader = await review(false, []);
    const writer = await review(true, []);
    const writerAfterWorkspace = await review(true, [stored(A0050, "1"), stored(A0250, "1")]);

    expect(reader.out).toEqual(writer.out);
    expect(reader.out).toEqual(writerAfterWorkspace.out);
  });

  it("does not list the workflow controls as missing, and counts them answered", async () => {
    const { out } = await review(false, []);

    const controlBlockers = out.readiness.blockers.filter(
      (blocker) => blocker.itemCode === "A0050" || blocker.itemCode === "A0250",
    );
    expect(controlBlockers).toEqual([]);
    // Not vacuous: the ordinary unanswered item IS a blocker, so the review is judging answers at all.
    expect(out.readiness.blockers.map((blocker) => blocker.itemCode)).toContain("A0100");
    expect(out.progress.answered).toBeGreaterThanOrEqual(2);
  });

  it("the reader's open writes nothing", async () => {
    const { fake } = await review(false, []);

    expect(writes(fake)).toEqual([]);
  });
});
