// The signed note as the API sends it (ADR-0114 VN-D30): the structured view, the version history and the pure rules the screens read.
import { describe, expect, it } from "vitest";
import {
  type FinalDocumentationView,
  type NoteHistory,
  amendableSections,
  historyOfSection,
  shortStamp,
  versionCount,
} from "../signed-note-model";

const view = (sections: FinalDocumentationView["sections"]): FinalDocumentationView => ({
  withheld: false,
  sections,
});
const section = (
  sectionId: string | null,
  over: Partial<FinalDocumentationView["sections"][number]> = {},
): FinalDocumentationView["sections"][number] => ({
  sectionId,
  text: "Text.",
  withheld: false,
  amendedByAddendumId: null,
  signedAt: "2026-10-01T10:00:00Z",
  ...over,
});

describe("shortStamp", () => {
  it("reads the server's UTC wall time as date and minutes", () => {
    expect(shortStamp("2026-10-02T14:05:33Z")).toBe("2026-10-02 14:05");
  });
});

describe("amendableSections", () => {
  it("offers the sealed sections the API names, in order", () => {
    const rows = amendableSections(
      view([section("pain"), section("plan", { amendedByAddendumId: "add-1" })]),
    );
    expect(rows).toEqual([{ sectionId: "pain" }, { sectionId: "plan" }]);
  });

  it("offers nothing for a section withheld from the viewer: the API sends it no id, and nobody amends text they cannot see", () => {
    const withheld = section(null, { text: null, withheld: true, signedAt: null });
    expect(amendableSections(view([section("pain"), withheld, section("plan")]))).toEqual([
      { sectionId: "pain" },
      { sectionId: "plan" },
    ]);
  });

  it("does not offer a withheld section an older server still sent an id for", () => {
    expect(amendableSections(view([section("sud", { text: null, withheld: true })]))).toEqual([]);
  });

  it("offers nothing for a pin with no sealed rows, a withheld note, or no view", () => {
    expect(amendableSections(view([section(null)]))).toEqual([]);
    expect(amendableSections({ withheld: true, sections: [] })).toEqual([]);
    expect(amendableSections(null)).toEqual([]);
    expect(amendableSections(undefined)).toEqual([]);
  });
});

describe("historyOfSection", () => {
  const history: NoteHistory = {
    sections: [
      {
        sectionId: "pain",
        versions: [
          {
            kind: "original",
            addendumId: null,
            authoredByMembershipId: "mem-1",
            signedAt: "2026-10-01T10:00:00Z",
            text: "Before.",
            withheld: false,
            current: false,
            cosignStatus: null,
          },
          {
            kind: "amendment",
            addendumId: "add-1",
            authoredByMembershipId: "mem-2",
            signedAt: "2026-10-02T10:00:00Z",
            text: "After.",
            withheld: false,
            current: true,
            cosignStatus: "not_required",
          },
        ],
      },
    ],
  };

  it("finds the versions of one amended section, oldest first as sent", () => {
    expect(historyOfSection(history, "pain")?.map((v) => v.kind)).toEqual([
      "original",
      "amendment",
    ]);
    expect(versionCount(historyOfSection(history, "pain"))).toBe(2);
  });

  it("is null for a section that was not amended, or when no history came", () => {
    expect(historyOfSection(history, "plan")).toBeNull();
    expect(historyOfSection(null, "pain")).toBeNull();
    expect(historyOfSection(undefined, "pain")).toBeNull();
    expect(versionCount(null)).toBe(0);
  });

  it("is null when the API left no section in the history, or left a group with no version in it", () => {
    // A group with a withheld version is omitted whole, and the history is null when none is left: neither is a list to show.
    expect(historyOfSection({ sections: [] }, "pain")).toBeNull();
    expect(
      historyOfSection({ sections: [{ sectionId: "pain", versions: [] }] }, "pain"),
    ).toBeNull();
  });

  it("finds a section by its id in a history that lists fewer sections than were amended", () => {
    const shorter: NoteHistory = {
      sections: [{ ...history.sections[0], sectionId: "plan" }],
    } as NoteHistory;
    expect(historyOfSection(shorter, "plan")).toHaveLength(2);
    expect(historyOfSection(shorter, "pain")).toBeNull();
  });
});
