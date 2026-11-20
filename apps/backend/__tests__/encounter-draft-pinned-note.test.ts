// ADR-0114 PR E1 (VN-D13, design 3.1 "Per-viewer view"): the pinned note as one reader may see it. Pure over the loaded rows; the
// database half (the pin and its sealed rows) is proven live (m8-visit-note-draft-routes.live.test.ts).
import { describe, expect, it, vi } from "vitest";
import {
  PART2_WITHHELD_MARKER,
  type PinnedNoteRows,
  viewPinnedNote,
} from "../src/modules/08-encounters/drafting/pinned-note";

const open = async (cipher: string): Promise<string> => `open(${cipher})`;

const section = (sectionId: string, part2Derived: boolean) => ({
  sectionId,
  textCipher: `cipher-${sectionId}`,
  part2Derived,
});

const SIGNED: PinnedNoteRows = {
  finalCipher: "cipher-final",
  part2Derived: true,
  sections: [
    section("chief_concern", false),
    section("interventions", true),
    section("plan", false),
  ],
};

describe("viewPinnedNote", () => {
  it("serves final_cipher and never asks for entitlement when no section is Part 2 derived", async () => {
    const entitled = vi.fn(async () => false);
    const note: PinnedNoteRows = {
      finalCipher: "cipher-final",
      part2Derived: false,
      sections: [section("chief_concern", false), section("plan", false)],
    };

    const view = await viewPinnedNote(note, { open, entitled });

    expect(view).toEqual({ text: "open(cipher-final)", withheld: false });
    expect(entitled).not.toHaveBeenCalled();
  });

  it("serves final_cipher to a viewer with Part 2 disclosure", async () => {
    const view = await viewPinnedNote(SIGNED, { open, entitled: async () => true });

    expect(view).toEqual({ text: "open(cipher-final)", withheld: false });
  });

  it("replaces only the Part 2 derived section for any other viewer, and never opens its sealed text", async () => {
    const opened: string[] = [];
    const view = await viewPinnedNote(SIGNED, {
      open: async (cipher) => {
        opened.push(cipher);
        return `open(${cipher})`;
      },
      entitled: async () => false,
    });

    expect(view.withheld).toBe(true);
    expect(view.text).toBe(
      ["open(cipher-chief_concern)", PART2_WITHHELD_MARKER, "open(cipher-plan)"].join("\n\n"),
    );
    expect(opened).toEqual(["cipher-chief_concern", "cipher-plan"]);
  });

  it("withholds the whole note for a pin that carries Part 2 text but has no sealed rows yet (finalized, not signed)", async () => {
    const finalized: PinnedNoteRows = {
      finalCipher: "cipher-final",
      part2Derived: true,
      sections: [],
    };
    const opened: string[] = [];

    const view = await viewPinnedNote(finalized, {
      open: async (cipher) => {
        opened.push(cipher);
        return "never";
      },
      entitled: async () => false,
    });

    expect(view).toEqual({ text: PART2_WITHHELD_MARKER, withheld: true });
    expect(opened).toEqual([]);
  });

  it("serves a finalized pin with Part 2 text to a viewer with disclosure", async () => {
    const finalized: PinnedNoteRows = {
      finalCipher: "cipher-final",
      part2Derived: true,
      sections: [],
    };

    const view = await viewPinnedNote(finalized, { open, entitled: async () => true });

    expect(view).toEqual({ text: "open(cipher-final)", withheld: false });
  });

  it("names no clinical content in the marker", () => {
    expect(PART2_WITHHELD_MARKER).toMatch(/^\[Withheld: [^\]]*42 CFR Part 2[^\]]*\]$/);
  });

  it("is 503 NOTE_VIEW_UNAVAILABLE when the disclosure check fails: an outage is never a silent denial", async () => {
    const error = await viewPinnedNote(SIGNED, {
      open,
      entitled: async () => {
        throw new Error("synthetic M39 outage");
      },
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "NOTE_VIEW_UNAVAILABLE", statusCode: 503 });
    expect((error as Error).message).not.toContain("synthetic M39 outage");
  });
});
