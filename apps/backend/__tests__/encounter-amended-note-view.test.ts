// ADR-0114 PR E2 (VN-D30, VN-D13, design 3.1 "Amendment" and "Per-viewer view"): a signed note with amendments, as one reader may see it. The current
// view is the latest signed text per section; the history is every version of an amended section with its author, date and (for an amendment) the
// addendum. The Part 2 rule applies to EVERY version, per viewer. Pure over the loaded rows; the database half is proven live
// (m8-visit-note-draft-routes.live.test.ts).
import { describe, expect, it, vi } from "vitest";
import {
  type AmendmentRow,
  type NoteOriginal,
  viewNote,
  viewNoteHistory,
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
): AmendmentRow => ({
  sectionId,
  textCipher: `cipher-${sectionId}-${addendumId}`,
  part2Derived,
  addendumId,
  authoredByMembershipId: `author-${addendumId}`,
  signedAt: new Date(signedAt),
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

const view = (note: PinnedNoteRows, amendments: readonly AmendmentRow[], readers = ENTITLED) =>
  viewNote(note, amendments, ORIGINAL, readers);

describe("viewNote: the current view", () => {
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
    expect(current.structured.sections.find((s) => s.sectionId === "plan")).toMatchObject({
      text: null,
      withheld: true,
      amendedByAddendumId: "a1",
    });
    expect(JSON.stringify(current.structured)).not.toContain(PART2_WITHHELD_MARKER);
    expect(opened).not.toContain("cipher-plan-a1");
  });

  it("shows the Part 2 derived amendment to a viewer with disclosure", async () => {
    const current = await view(NOTE, [amendment("plan", "a1", "2026-11-19T10:00:00.000Z", true)]);
    expect(current.withheld).toBe(false);
    expect(current.text).toContain("open(cipher-plan-a1)");
  });

  it("shows a non-Part-2 amendment of a section whose original was Part 2 (the current text holds none), and withholds nothing else", async () => {
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
      [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", false)],
      NOT_ENTITLED,
    );
    expect(current.text).toBe(
      ["open(cipher-chief_concern)", "open(cipher-interventions-a1)", "open(cipher-plan)"].join(
        "\n\n",
      ),
    );
    expect(current.withheld).toBe(false);
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
      ["interventions", true, true],
      ["plan", false, false],
    ]);
  });
});

describe("viewNoteHistory", () => {
  it("is null when nothing was amended", async () => {
    expect(await viewNoteHistory(NOTE, [], ORIGINAL, ENTITLED)).toBeNull();
  });

  it("lists every version of an amended section, oldest first, with author, date and (for an amendment) the addendum, and marks the latest as current", async () => {
    const history = await viewNoteHistory(
      NOTE,
      [
        amendment("plan", "a1", "2026-11-19T10:00:00.000Z"),
        amendment("plan", "a2", "2026-11-20T10:00:00.000Z"),
      ],
      ORIGINAL,
      ENTITLED,
    );
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
            },
            {
              kind: "amendment",
              addendumId: "a1",
              authoredByMembershipId: "author-a1",
              signedAt: "2026-11-19T10:00:00.000Z",
              text: "open(cipher-plan-a1)",
              withheld: false,
              current: false,
            },
            {
              kind: "amendment",
              addendumId: "a2",
              authoredByMembershipId: "author-a2",
              signedAt: "2026-11-20T10:00:00.000Z",
              text: "open(cipher-plan-a2)",
              withheld: false,
              current: true,
            },
          ],
        },
      ],
    });
  });

  it("lists only the amended sections", async () => {
    const history = await viewNoteHistory(
      NOTE,
      [amendment("plan", "a1", "2026-11-19T10:00:00.000Z")],
      ORIGINAL,
      ENTITLED,
    );
    expect(history?.sections.map((s) => s.sectionId)).toEqual(["plan"]);
  });

  it("withholds a Part 2 derived version from a viewer without disclosure, by its own row, and never opens it", async () => {
    const opened: string[] = [];
    const history = await viewNoteHistory(
      NOTE,
      [
        amendment("plan", "a1", "2026-11-19T10:00:00.000Z", true),
        amendment("plan", "a2", "2026-11-20T10:00:00.000Z", false),
      ],
      ORIGINAL,
      {
        open: async (cipher) => {
          opened.push(cipher);
          return `open(${cipher})`;
        },
        entitled: async () => false,
      },
    );
    const versions = history?.sections[0]?.versions ?? [];
    expect(versions.map((v) => [v.addendumId, v.withheld])).toEqual([
      [null, false],
      ["a1", true],
      ["a2", false],
    ]);
    expect(versions[1]?.text).toBeNull();
    expect(opened).not.toContain("cipher-plan-a1");
  });

  it("the history of a section whose ORIGINAL was Part 2 derived stays withheld for such a viewer, every version of it, though the current view shows the latest", async () => {
    const note: PinnedNoteRows = {
      ...NOTE,
      part2Derived: true,
      sections: [
        section("chief_concern", false),
        section("interventions", true),
        section("plan", false),
      ],
    };
    const opened: string[] = [];
    const readers = {
      open: async (cipher: string) => {
        opened.push(cipher);
        return `open(${cipher})`;
      },
      entitled: async () => false,
    };
    const amendments = [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", false)];

    const history = await viewNoteHistory(note, amendments, ORIGINAL, readers);
    const versions = history?.sections[0]?.versions ?? [];
    expect(versions.map((v) => v.withheld)).toEqual([true, true]);
    expect(versions.every((v) => v.text === null)).toBe(true);
    expect(opened).toEqual([]);

    const current = await viewNote(note, amendments, ORIGINAL, readers);
    expect(current.text).toContain("open(cipher-interventions-a1)");
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
    const history = await viewNoteHistory(
      note,
      [amendment("interventions", "a1", "2026-11-19T10:00:00.000Z", true)],
      ORIGINAL,
      { open, entitled },
    );
    expect(history?.sections[0]?.versions.map((v) => v.text)).toEqual([
      "open(cipher-interventions)",
      "open(cipher-interventions-a1)",
    ]);
    expect(entitled).toHaveBeenCalledTimes(1);
  });
});
