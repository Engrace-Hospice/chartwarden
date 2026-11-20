// S1 fix wave 2 - the workspace of `getEncounter` applies ONE visibility decision to every field (ADR-0114 VN-D13, VN-D30): the current view, the
// history and the addenda come from the same withheld set, the Part 2 verdict is asked once, and an addendum whose named sections are all withheld
// reads as a free addendum (its cosignature status too). Over a fake cipher and a fake verdict; the database half is proven live.
import { describe, expect, it, vi } from "vitest";
import {
  type WorkspaceRows,
  createWorkspaceReader,
} from "../src/modules/08-encounters/drafting/workspace-read";
import { ENCOUNTER_ID, ORG_ID, PATIENT_ID, fakePorts, viewer } from "./_encounter-draft-fixtures";

const AUTHOR = "00000000-0000-4000-8000-0000000000aa";
const SIGNED_AT = "2026-11-18T20:00:00.000Z";
const section = (sectionId: string, part2Derived: boolean) => ({
  sectionId,
  textCipher: `cipher-${sectionId}`,
  part2Derived,
});
const addendum = (
  id: string,
  amendsSectionIds: readonly string[],
  cosignStatus: "not_required" | "pending",
) => ({
  id,
  status: "signed" as const,
  reason: "a correction",
  authoredByUserId: AUTHOR,
  createdAt: SIGNED_AT,
  signedAt: SIGNED_AT,
  version: 1,
  amendsSectionIds,
  cosignStatus,
});

const rows = {
  selections: null,
  noteRows: {
    note: {
      finalCipher: "cipher-final",
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    },
    // `interventions` was Part 2 in the original and its amendment is not: it is withheld whole all the same
    amendments: [
      {
        sectionId: "interventions",
        textCipher: "cipher-interventions-a1",
        part2Derived: false,
        addendumId: "a1",
        authoredByMembershipId: AUTHOR,
        signedAt: new Date("2026-11-19T10:00:00.000Z"),
        cosignStatus: "pending" as const,
      },
    ],
  },
  vitals: null,
  mileage: null,
  carePlanLinks: [],
  addenda: [
    addendum("a1", ["interventions"], "pending"),
    addendum("a2", ["interventions", "plan"], "pending"),
    addendum("free", [], "not_required"),
  ],
} as unknown as WorkspaceRows;

const encounter = {
  id: ENCOUNTER_ID,
  patientId: PATIENT_ID,
  authoredByMembershipId: AUTHOR,
  signedAt: SIGNED_AT,
};

function reader(entitled: boolean) {
  const seams = fakePorts({ part2DisclosureAllowed: vi.fn(async () => entitled) });
  const workspace = createWorkspaceReader({
    narrativeCipher: { seal: async (_o, t) => t, open: async (_o, c) => `open(${c})` },
    withTenantDek: (_what, run) => run(),
    draftSeams: () => seams,
  });
  return { workspace, seams };
}

describe("workspace.render", () => {
  it("withholds the Part 2 section whole, drops its id from the addenda and frees the addendum that named only it, for a viewer without disclosure", async () => {
    const { workspace, seams } = reader(false);
    const rendered = await workspace.render(ORG_ID, encounter, viewer(), rows);
    expect(rendered.finalDocumentationView?.sections.map((s) => [s.sectionId, s.withheld])).toEqual(
      [
        ["chief_concern", false],
        [null, true],
        ["plan", false],
      ],
    );
    expect(rendered.noteHistory).toBeNull();
    expect(rendered.addenda.map((a) => [a.id, a.amendsSectionIds, a.cosignStatus])).toEqual([
      ["a1", [], "not_required"],
      ["a2", ["plan"], "pending"],
      ["free", [], "not_required"],
    ]);
    expect(JSON.stringify(rendered)).not.toContain("cipher-interventions");
    expect(seams.part2DisclosureAllowed).toHaveBeenCalledTimes(1);
  });

  it("shows a viewer with disclosure everything: ids, history and every cosignature status", async () => {
    const { workspace, seams } = reader(true);
    const rendered = await workspace.render(ORG_ID, encounter, viewer(), rows);
    expect(rendered.finalDocumentationView?.sections.every((s) => !s.withheld)).toBe(true);
    expect(rendered.noteHistory?.sections.map((s) => s.sectionId)).toEqual(["interventions"]);
    expect(rendered.addenda.map((a) => [a.id, a.amendsSectionIds, a.cosignStatus])).toEqual([
      ["a1", ["interventions"], "pending"],
      ["a2", ["interventions", "plan"], "pending"],
      ["free", [], "not_required"],
    ]);
    expect(seams.part2DisclosureAllowed).toHaveBeenCalledTimes(1);
  });

  it("with no note rows it renders no note and leaves the addenda as they are", async () => {
    const { workspace } = reader(false);
    const rendered = await workspace.render(ORG_ID, encounter, viewer(), {
      ...rows,
      noteRows: null,
    } as WorkspaceRows);
    expect(rendered.finalDocumentation).toBeNull();
    expect(rendered.addenda.map((a) => a.amendsSectionIds)).toEqual([
      ["interventions"],
      ["interventions", "plan"],
      [],
    ]);
  });
});
