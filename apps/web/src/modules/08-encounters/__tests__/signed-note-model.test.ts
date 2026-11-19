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
  it("offers the sealed sections whose text the viewer may read", () => {
    const rows = amendableSections(
      view([
        section("pain"),
        section("plan", { amendedByAddendumId: "add-1" }),
        section("sud", { text: null, withheld: true }),
      ]),
    );
    expect(rows).toEqual([
      { sectionId: "pain", selectable: true },
      { sectionId: "plan", selectable: true },
      { sectionId: "sud", selectable: false },
    ]);
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
          },
          {
            kind: "amendment",
            addendumId: "add-1",
            authoredByMembershipId: "mem-2",
            signedAt: "2026-10-02T10:00:00Z",
            text: "After.",
            withheld: false,
            current: true,
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
});
