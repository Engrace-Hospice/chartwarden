import { describe, expect, it } from "vitest";
import { createHopeAssessmentAnswerService } from "../src/modules/10-hope/hope-answer-service";
import { scriptedDb } from "./_hope-g3-fake-db";

// A read-only caller opens the workspace of a draft that no writer has opened yet: its workflow-control items (A0050, A0250) have
// no stored answer, and a writer's open would store them. The reader must be SHOWN the same workspace (item states, applicability,
// progress, HUV state) with NOTHING written: it used to see both controls `unanswered` and progress 0 while a writer saw them
// `answered`. No Postgres: the database is scripted, the real v1.00.1 applicability engine runs.
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT = "22222222-2222-4222-8222-222222222222";
const SPEC = "33333333-3333-4333-8333-333333333333";
const A0050 = "44444444-4444-4444-8444-444444444441";
const A0250 = "44444444-4444-4444-8444-444444444442";
const A0100 = "44444444-4444-4444-8444-444444444443";
const STORED_AT = new Date("2026-06-01T08:00:00.000Z");

const item = (id: string, itemCode: string) => ({
  item: {
    id,
    itemCode,
    shortLabel: itemCode,
    sectionLabel: "A",
    cmsItemTypeCode: "text",
    fixedRecordLength: 1,
    kind: "assessment",
  },
});
const assessmentOf = (isc: string, rfaKind: string) => ({
  id: ASSESSMENT,
  organizationId: ORG,
  providerEntityId: "pe-1",
  locationId: "loc-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  specVersionId: SPEC,
  isc,
  rfaKind,
  status: "draft",
  version: 1,
  targetDate: new Date("2026-06-01T00:00:00.000Z"),
  correctsAssessmentId: null,
  scheduleId: null,
});
const stored = (specItemId: string, value: string) => ({
  specItemId,
  hopeAssessmentId: ASSESSMENT,
  state: "answered",
  value,
  source: "derived",
  answeredAt: STORED_AT,
  answeredByMembershipId: null,
});

/** The control values for an admission and for a HUV1 (`deriveHopeWorkflowControlAnswers`: A0050 "1", A0250 "1"/"2"). */
const CONTROLS = {
  "01_admission": { A0050: "1", A0250: "1" },
  "02_huv1": { A0050: "1", A0250: "2" },
};

type Kind = keyof typeof CONTROLS;
const isc = { "01_admission": "HA", "02_huv1": "HUV" } as const;

/** What the response shows of an item, without the timestamps a writer's stored row and a derived one cannot share. */
const shown = (workspace: Awaited<ReturnType<ReturnType<typeof service>["getWorkspace"]>>) => ({
  assessment: workspace.assessment,
  items: workspace.sections.flatMap((section) =>
    section.items.map((i) => ({
      itemCode: i.itemCode,
      state: i.state,
      value: i.value,
      source: i.source,
      applicability: i.applicability,
      skipReason: i.skipReason,
    })),
  ),
  progress: workspace.progress,
  huv: workspace.huv,
});

const service = (fake: ReturnType<typeof scriptedDb>) => createHopeAssessmentAnswerService(fake.db);
const writes = (fake: ReturnType<typeof scriptedDb>) =>
  fake.statements.filter((s) => s.kind === "update" || s.kind === "insert");

describe.each([["01_admission" as Kind], ["02_huv1" as Kind]])(
  "GET workspace of an unreconciled %s draft: a reader sees what a writer sees",
  (kind) => {
    const row = assessmentOf(isc[kind], kind);
    const items = [item(A0050, "A0050"), item(A0250, "A0250"), item(A0100, "A0100")];
    const huvSchedule = kind === "02_huv1" ? [[]] : []; // the HUV state reads the window's schedule row (none here)
    const controls = CONTROLS[kind];

    /** A writer's open: reconcile (lock, re-read, two upserts), then the stored controls are what the display reads. */
    const writerOpen = async () => {
      const fake = scriptedDb([
        [{ assessment: row, specCode: "1.00.1" }],
        items,
        [], // outOfDateControls: nothing stored
        [row], // the row lock
        [], // outOfDateControls again, on the locked row
        [],
        [], // the two upserts
        [], // options
        [stored(A0050, controls.A0050), stored(A0250, controls.A0250)], // answers as the reconcile wrote them
        ...huvSchedule,
      ]);
      return {
        fake,
        workspace: await service(fake).getWorkspace(ORG, ASSESSMENT, { mayWrite: true }),
      };
    };

    /** A reader's open: no reconcile; nothing is stored. */
    const readerOpen = async () => {
      const fake = scriptedDb([
        [{ assessment: row, specCode: "1.00.1" }],
        items,
        [], // options
        [], // answers: none stored
        ...huvSchedule,
      ]);
      return {
        fake,
        workspace: await service(fake).getWorkspace(ORG, ASSESSMENT, { mayWrite: false }),
      };
    };

    it("shows the same item states, applicability, progress and HUV state, and writes nothing", async () => {
      const writer = await writerOpen();
      const reader = await readerOpen();

      expect(writes(writer.fake).map((s) => s.kind)).toEqual(["insert", "insert"]); // not vacuous: a writer stores them
      expect(writes(reader.fake)).toEqual([]);
      expect(shown(reader.workspace)).toEqual(shown(writer.workspace));
      // ...and what they share is the derived controls, not an empty workspace.
      const controlStates = shown(reader.workspace)
        .items.filter((i) => i.itemCode !== "A0100")
        .map((i) => [i.itemCode, i.state, i.value, i.source]);
      expect(controlStates).toEqual([
        ["A0050", "answered", controls.A0050, "derived"],
        ["A0250", "answered", controls.A0250, "derived"],
      ]);
      expect(reader.workspace.progress.answered).toBe(2);
    });

    it("a control already stored in place keeps its stored row (its own timestamp) in a reader's view", async () => {
      const fake = scriptedDb([
        [{ assessment: row, specCode: "1.00.1" }],
        items,
        [],
        [stored(A0050, controls.A0050), stored(A0250, "9")], // A0050 in place, A0250 stale
        ...huvSchedule,
      ]);

      const workspace = await service(fake).getWorkspace(ORG, ASSESSMENT, { mayWrite: false });

      const byCode = new Map(
        workspace.sections.flatMap((s) => s.items).map((i) => [i.itemCode, i]),
      );
      expect(byCode.get("A0050")?.answeredAt).toBe(STORED_AT.toISOString());
      expect(byCode.get("A0250")?.value).toBe(controls.A0250); // the stale stored value is not shown
      expect(writes(fake)).toEqual([]);
    });
  },
);

describe("a signed record is shown as stored to a reader, as it is to a writer", () => {
  it("does not overlay derived controls on a record that is no longer a draft", async () => {
    const signed = { ...assessmentOf("HA", "01_admission"), status: "signed" };
    const fake = scriptedDb([
      [{ assessment: signed, specCode: "1.00.1" }],
      [item(A0050, "A0050"), item(A0250, "A0250")],
      [],
      [], // nothing stored
    ]);

    const workspace = await service(fake).getWorkspace(ORG, ASSESSMENT, { mayWrite: false });

    const states = workspace.sections.flatMap((s) => s.items).map((i) => i.state);
    expect(states).toEqual(["unanswered", "unanswered"]);
  });
});
