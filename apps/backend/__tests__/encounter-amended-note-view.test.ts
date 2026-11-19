// ADR-0114 PR E2 (VN-D30, VN-D13, design 3.1 "Amendment" and "Per-viewer view"): a signed note with amendments, as one reader may see it. The current
// view is the latest signed text per section; the history is every version of an amended section with its author, date and (for an amendment) the
// addendum. The Part 2 rule applies to EVERY version, per viewer, as ONE decision: a section with a Part 2 derived version at any time is withheld
// whole from a viewer without disclosure, in the current view, the history and the addenda alike. Pure over the loaded rows; the database half is
// proven live (m8-visit-note-draft-routes.live.test.ts).
import { describe, expect, it, vi } from "vitest";
import {
  type AmendmentRow,
  type NoteOriginal,
  addendumVisibleTo,
  renderNoteVersions,
} from "../src/modules/08-encounters/drafting/note-versions";
import {
  PART2_WITHHELD_MARKER,
  type PinnedNoteRows,
} from "../src/modules/08-encounters/drafting/pinned-note";

const open = async (cipher: string): Promise<string> => `open(${cipher})`;

const section = (sectionId: string, part2Derived: boolean) => ({
  sectionId,
  textCipher: `cipher-${sectionId}`,
  part2Derived,
});
const amendment = (
  sectionId: string,
  addendumId: string,
  signedAt: string,
  part2Derived = false,
  cosignStatus: AmendmentRow["cosignStatus"] = "not_required",
): AmendmentRow => ({
  sectionId,
  textCipher: `cipher-${sectionId}-${addendumId}`,
  part2Derived,
  addendumId,
  authoredByMembershipId: `author-${addendumId}`,
  signedAt: new Date(signedAt),
  cosignStatus,
});

const NOTE: PinnedNoteRows = {
  finalCipher: "cipher-final",
  part2Derived: false,
  sections: [
    section("chief_concern", false),
    section("interventions", false),
    section("plan", false),
  ],
};
const ORIGINAL: NoteOriginal = {
  authoredByMembershipId: "author-note",
  signedAt: new Date("2026-11-18T20:00:00.000Z"),
};
const ENTITLED = { open, entitled: async () => true };
const NOT_ENTITLED = { open, entitled: async () => false };

const render = (note: PinnedNoteRows, amendments: readonly AmendmentRow[], readers = ENTITLED) =>
  renderNoteVersions({ note, amendments }, ORIGINAL, readers);
const view = async (...args: Parameters<typeof render>) => (await render(...args)).current;
const historyOf = async (...args: Parameters<typeof render>) => (await render(...args)).history;

const PART2_INTERVENTIONS: PinnedNoteRows = {
  ...NOTE,
  part2Derived: true,
  sections: [
    section("chief_concern", false),
    section("interventions", true),
    section("plan", false),
  ],
};
const WITHHELD_IN_PLACE = {
  sectionId: null,
  text: null,
  withheld: true,
  amendedByAddendumId: null,
  signedAt: null,
};

describe("the current view", () => {
  it("with no amendment is the note's own sections joined (the pin's text by the sealed-row invariant), each opened once", async () => {
    const opened: string[] = [];
    const current = await view(NOTE, [], {
      open: async (cipher) => {
        opened.push(cipher);
        return `open(${cipher})`;
      },
      entitled: async () => true,
    });
    expect(current.text).toBe(
      ["open(cipher-chief_concern)", "open(cipher-interventions)", "open(cipher-plan)"].join(
        "\n\n",
      ),
    );
    expect(current.withheld).toBe(false);
    expect(opened).toEqual(["cipher-chief_concern", "cipher-interventions", "cipher-plan"]);
    expect(current.structured.sections.map((s) => [s.sectionId, s.amendedByAddendumId])).toEqual([
      ["chief_concern", null],
      ["interventions", null],
      ["plan", null],
    ]);
    expect(current.structured.sections[0]?.signedAt).toBe("2026-11-18T20:00:00.000Z");
  });

  it("a pin with no sealed rows (signed with the draft off, or finalized) is ONE block, opened from final_cipher, with no section id", async () => {
    const note: PinnedNoteRows = { finalCipher: "cipher-final", part2Derived: false, sections: [] };
    const current = await view(note, []);
    expect(current.text).toBe("open(cipher-final)");
    expect(current.structured).toEqual({
      withheld: false,
      sections: [
        {
          sectionId: null,
          text: "open(cipher-final)",
          withheld: false,
          amendedByAddendumId: null,
          signedAt: "2026-11-18T20:00:00.000Z",
        },
      ],
    });
  });

  it("a finalized pin that carries Part 2 text and has no rows is withheld WHOLE from a viewer without disclosure: the marker as text, no section, nothing opened", async () => {
    const note: PinnedNoteRows = { finalCipher: "cipher-final", part2Derived: true, sections: [] };
    const opened: string[] = [];
    const current = await view(note, [], {
      open: async (cipher) => {
        opened.push(cipher);
        return "never";
      },
      entitled: async () => false,
    });
    expect(current.text).toBe(PART2_WITHHELD_MARKER);
    expect(current.structured).toEqual({ withheld: true, sections: [] });
    expect(opened).toEqual([]);
    expect(JSON.stringify(current.structured)).not.toContain(PART2_WITHHELD_MARKER);
  });

  it("shows the latest signed text of an amended section, in the section's place, with the addendum and date of that version", async () => {
    const current = await view(NOTE, [
      amendment("plan", "a1", "2026-11-19T10:00:00.000Z"),
      amendment("plan", "a2", "2026-11-20T10:00:00.000Z"),
    ]);
    expect(current.text).toBe(
      ["open(cipher-chief_concern)", "open(cipher-interventions)", "open(cipher-plan-a2)"].join(
        "\n\n",
      ),
    );
    expect(current.structured.sections.find((s) => s.sectionId === "plan")).toEqual({
      sectionId: "plan",
      text: "open(cipher-plan-a2)",
      withheld: false,
      amendedByAddendumId: "a2",
      signedAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("never asks for entitlement when no version is Part 2 derived", async () => {
    const entitled = vi.fn(async () => false);
    await view(NOTE, [amendment("plan", "a1", "2026-11-19T10:00:00.000Z")], { open, entitled });
    expect(entitled).not.toHaveBeenCalled();
  });

  it("withholds a Part 2 derived AMENDMENT from a viewer without disclosure: the marker in the legacy text, text: null in the structured view, its text never opened", async () => {
    const opened: string[] = [];
    const current = await view(NOTE, [amendment("plan", "a1", "2026-11-19T10:00:00.000Z", true)], {
      open: async (cipher) => {
        opened.push(cipher);
        return `open(${cipher})`;
      },
      entitled: async () => false,
    });
    expect(current.withheld).toBe(true);
    expect(current.text).toBe(
      ["open(cipher-chief_concern)", "open(cipher-interventions)", PART2_WITHHELD_MARKER].join(
        "\n\n",
      ),
    );
    // S1: the withheld section keeps its place in the array and nothing else: no id, no amending addendum, no date.
    expect(current.structured.sections.map((s) => s.withheld)).toEqual([false, false, true]);
    expect(current.structured.sections[2]).toEqual({
      sectionId: null,
      text: null,
      withheld: true,
      amendedByAddendumId: null,
      signedAt: null,
    });
    const wire = JSON.stringify(current.structured);
    expect(wire).not.toContain(PART2_WITHHELD_MARKER);
    expect(wire).not.toContain("plan");
    expect(wire).not.toContain("a1");
    expect(wire).not.toContain("2026-11-19");
    expect(opened).not.toContain("cipher-plan-a1");
  });

  it("a withheld ORIGINAL section is cut the same way, and a viewer with disclosure gets the ids and dates back", async () => {
    const note: PinnedNoteRows = {
      ...NOTE,
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    };
    const withheld = await view(note, [], NOT_ENTITLED);
    expect(withheld.structured.sections[1]).toEqual({
      sectionId: null,
      text: null,
      withheld: true,
      amendedByAddendumId: null,
      signedAt: null,
    });
    expect(JSON.stringify(withheld.structured)).not.toContain("interventions");
    const shown = await view(note, [], ENTITLED);
    expect(shown.structured.sections[1]).toMatchObject({
      sectionId: "interventions",
      withheld: false,
      signedAt: "2026-11-18T20:00:00.000Z",
    });
  });

  it("shows the Part 2 derived amendment to a viewer with disclosure", async () => {
    const current = await view(NOTE, [amendment("plan", "a1", "2026-11-19T10:00:00.000Z", true)]);
    expect(current.withheld).toBe(false);
    expect(current.text).toContain("open(cipher-plan-a1)");
  });

  it("withholds a section whose ORIGINAL was Part 2 even when its latest amendment holds none: any Part 2 version withholds the section whole, nothing of it opened, no id, addendum or date", async () => {
    const opened: string[] = [];
    const current = await view(
      PART2_INTERVENTIONS,
      [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", false)],
      {
        open: async (cipher) => {
          opened.push(cipher);
          return `open(${cipher})`;
        },
        entitled: async () => false,
      },
    );
    expect(current.text).toBe(
      ["open(cipher-chief_concern)", PART2_WITHHELD_MARKER, "open(cipher-plan)"].join("\n\n"),
    );
    expect(current.withheld).toBe(true);
    expect(current.structured.sections[1]).toEqual(WITHHELD_IN_PLACE);
    const wire = JSON.stringify(current.structured);
    expect(wire).not.toContain("interventions");
    expect(wire).not.toContain("a1");
    expect(wire).not.toContain("2026-11-19");
    expect(opened).not.toContain("cipher-interventions");
    expect(opened).not.toContain("cipher-interventions-a1");
  });

  it("shows that amendment, with its addendum and date, to a viewer with disclosure", async () => {
    const current = await view(PART2_INTERVENTIONS, [
      amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", false),
    ]);
    expect(current.structured.sections[1]).toEqual({
      sectionId: "interventions",
      text: "open(cipher-interventions-a1)",
      withheld: false,
      amendedByAddendumId: "a1",
      signedAt: "2026-11-19T10:00:00.000Z",
    });
  });

  it("a Part 2 original that is still the current text stays withheld next to an amended section", async () => {
    const note: PinnedNoteRows = {
      ...NOTE,
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    };
    const current = await view(
      note,
      [amendment("plan", "a1", "2026-11-19T10:00:00.000Z")],
      NOT_ENTITLED,
    );
    expect(current.text).toBe(
      ["open(cipher-chief_concern)", PART2_WITHHELD_MARKER, "open(cipher-plan-a1)"].join("\n\n"),
    );
    expect(
      current.structured.sections.map((s) => [s.sectionId, s.withheld, s.text === null]),
    ).toEqual([
      ["chief_concern", false, false],
      [null, true, true],
      ["plan", false, false],
    ]);
  });
});

describe("the history", () => {
  it("is null when nothing was amended", async () => {
    expect(await historyOf(NOTE, [])).toBeNull();
  });

  it("lists every version of an amended section, oldest first, with author, date and (for an amendment) the addendum, and marks the latest as current", async () => {
    const history = await historyOf(NOTE, [
      amendment("plan", "a1", "2026-11-19T10:00:00.000Z", false, "cosigned"),
      amendment("plan", "a2", "2026-11-20T10:00:00.000Z", false, "pending"),
    ]);
    expect(history).toEqual({
      sections: [
        {
          sectionId: "plan",
          versions: [
            {
              kind: "original",
              addendumId: null,
              authoredByMembershipId: "author-note",
              signedAt: "2026-11-18T20:00:00.000Z",
              text: "open(cipher-plan)",
              withheld: false,
              current: false,
              cosignStatus: null,
            },
            {
              kind: "amendment",
              addendumId: "a1",
              authoredByMembershipId: "author-a1",
              signedAt: "2026-11-19T10:00:00.000Z",
              text: "open(cipher-plan-a1)",
              withheld: false,
              current: false,
              cosignStatus: "cosigned",
            },
            {
              kind: "amendment",
              addendumId: "a2",
              authoredByMembershipId: "author-a2",
              signedAt: "2026-11-20T10:00:00.000Z",
              text: "open(cipher-plan-a2)",
              withheld: false,
              current: true,
              cosignStatus: "pending",
            },
          ],
        },
      ],
    });
  });

  it("lists only the amended sections", async () => {
    const history = await historyOf(NOTE, [amendment("plan", "a1", "2026-11-19T10:00:00.000Z")]);
    expect(history?.sections.map((s) => s.sectionId)).toEqual(["plan"]);
  });

  it("omits a section that has a Part 2 derived AMENDMENT from a viewer without disclosure, whole, and never opens any version of it", async () => {
    const opened: string[] = [];
    const history = await historyOf(
      NOTE,
      [
        amendment("plan", "a1", "2026-11-19T10:00:00.000Z", true),
        amendment("plan", "a2", "2026-11-20T10:00:00.000Z", false),
        amendment("chief_concern", "a3", "2026-11-21T10:00:00.000Z", false),
      ],
      {
        open: async (cipher) => {
          opened.push(cipher);
          return `open(${cipher})`;
        },
        entitled: async () => false,
      },
    );
    // S1: no id, no author and no date of the Part 2 section reaches the viewer; the section that holds none is listed as before.
    expect(history?.sections.map((s) => s.sectionId)).toEqual(["chief_concern"]);
    const wire = JSON.stringify(history);
    expect(wire).not.toContain("plan");
    expect(wire).not.toContain("a1");
    expect(wire).not.toContain("author-a2");
    expect(opened.every((cipher) => !cipher.includes("plan"))).toBe(true);
  });

  it("omits a section whose ORIGINAL was Part 2 derived from such a viewer, every version of it, and so does the current view", async () => {
    const opened: string[] = [];
    const readers = {
      open: async (cipher: string) => {
        opened.push(cipher);
        return `open(${cipher})`;
      },
      entitled: async () => false,
    };
    const amendments = [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", false)];
    const rendered = await render(PART2_INTERVENTIONS, amendments, readers);

    // Nothing is left to list, which reads exactly as "no history" (a null, not an empty list that says something was amended).
    expect(rendered.history).toBeNull();
    expect(rendered.current.structured.sections[1]).toEqual(WITHHELD_IN_PLACE);
    expect(opened.filter((cipher) => cipher.includes("interventions"))).toEqual([]);
  });

  it("shows every version to a viewer with disclosure, Part 2 or not, and asks for entitlement once", async () => {
    const entitled = vi.fn(async () => true);
    const note: PinnedNoteRows = {
      ...NOTE,
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    };
    const history = await historyOf(
      note,
      [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", true)],
      { open, entitled },
    );
    expect(history?.sections[0]?.versions.map((v) => v.text)).toEqual([
      "open(cipher-interventions)",
      "open(cipher-interventions-a1)",
    ]);
    expect(entitled).toHaveBeenCalledTimes(1);
  });
});

describe("renderNoteVersions: one verdict per read (B4)", () => {
  const rowsWithPart2 = {
    note: {
      ...NOTE,
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    },
    amendments: [amendment("plan", "a1", "2026-11-19T10:00:00.000Z", false)],
  };

  it("asks M39 once for the current view AND the history", async () => {
    const entitled = vi.fn(async () => true);
    const rendered = await renderNoteVersions(rowsWithPart2, ORIGINAL, { open, entitled });
    expect(entitled).toHaveBeenCalledTimes(1);
    expect(rendered.current.withheld).toBe(false);
    expect(rendered.history?.sections.map((s) => s.sectionId)).toEqual(["plan"]);
  });

  it("current view and history agree: a verdict that flips between two asks cannot split them", async () => {
    const answers = [true, false];
    const entitled = vi.fn(async () => answers.shift() ?? false);
    const rendered = await renderNoteVersions(rowsWithPart2, ORIGINAL, { open, entitled });
    expect(entitled).toHaveBeenCalledTimes(1);
    expect(rendered.current.withheld).toBe(false);
    expect(rendered.history).not.toBeNull();
  });

  it("asks nobody when no version is Part 2 derived, and has no history when nothing was amended", async () => {
    const entitled = vi.fn(async () => false);
    const rendered = await renderNoteVersions({ note: NOTE, amendments: [] }, ORIGINAL, {
      open,
      entitled,
    });
    expect(entitled).not.toHaveBeenCalled();
    expect(rendered.history).toBeNull();
  });
});

describe("the section ids withheld from a reader (S1): one set for the current view, the history and the addenda", () => {
  const rows = {
    note: {
      ...NOTE,
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    },
    // `plan` was not Part 2 in the original but its amendment is; `chief_concern` holds none in any version.
    amendments: [amendment("plan", "a1", "2026-11-19T10:00:00.000Z", true)],
  };

  it("are the sections with ANY Part 2 derived version, original or amendment, for a reader without disclosure", async () => {
    const rendered = await renderNoteVersions(rows, ORIGINAL, NOT_ENTITLED);
    expect([...rendered.withheldSectionIds].sort()).toEqual(["interventions", "plan"]);
    expect(rendered.current.structured.sections.map((s) => [s.sectionId, s.withheld])).toEqual([
      ["chief_concern", false],
      [null, true],
      [null, true],
    ]);
  });

  it("are none for a reader with disclosure, and none when nothing is Part 2 derived", async () => {
    expect((await renderNoteVersions(rows, ORIGINAL, ENTITLED)).withheldSectionIds.size).toBe(0);
    const plain = await renderNoteVersions({ note: NOTE, amendments: [] }, ORIGINAL, NOT_ENTITLED);
    expect(plain.withheldSectionIds.size).toBe(0);
  });

  it("a Part 2 original amended into non-Part 2 text is in the set, so the view, the history and the addenda cannot disagree about it", async () => {
    const amended = {
      note: PART2_INTERVENTIONS,
      amendments: [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", false)],
    };
    const rendered = await renderNoteVersions(amended, ORIGINAL, NOT_ENTITLED);
    expect([...rendered.withheldSectionIds]).toEqual(["interventions"]);
    expect(rendered.current.structured.sections[1]?.withheld).toBe(true);
    expect(rendered.history).toBeNull();
    const addendum = { amendsSectionIds: ["interventions"], cosignStatus: "pending" as const };
    expect(addendumVisibleTo(addendum, rendered.withheldSectionIds).amendsSectionIds).toEqual([]);
  });
});

describe("an addendum as a reader without disclosure sees it (S1)", () => {
  const withheld = new Set(["interventions"]);
  const addendum = (ids: readonly string[], cosignStatus: AmendmentRow["cosignStatus"]) => ({
    id: "a1",
    amendsSectionIds: ids,
    cosignStatus,
  });

  it("drops the withheld ids and keeps the cosignature status while one named section is still visible", () => {
    expect(addendumVisibleTo(addendum(["interventions", "plan"], "pending"), withheld)).toEqual(
      addendum(["plan"], "pending"),
    );
  });

  it("looks like a free addendum when every section it names is withheld: no ids and cosignStatus not_required, whatever its request says", () => {
    for (const status of ["pending", "cosigned", "released", "not_required"] as const) {
      expect(addendumVisibleTo(addendum(["interventions"], status), withheld)).toEqual(
        addendum([], "not_required"),
      );
    }
  });

  it("leaves a free addendum and an addendum with nothing withheld exactly as they are", () => {
    expect(addendumVisibleTo(addendum([], "not_required"), withheld)).toEqual(
      addendum([], "not_required"),
    );
    expect(addendumVisibleTo(addendum(["plan"], "cosigned"), withheld)).toEqual(
      addendum(["plan"], "cosigned"),
    );
    expect(addendumVisibleTo(addendum(["interventions"], "pending"), new Set())).toEqual(
      addendum(["interventions"], "pending"),
    );
  });
});
