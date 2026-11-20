// What the recent-notes cell says of a note (ADR-0114 VN-D30): from the structured view, and only from the legacy string when there is none.
import { describe, expect, it } from "vitest";
import { summariseNote } from "./clinical-note-summary";

const section = (text: string | null, withheld = false) => ({ text, withheld });

describe("summariseNote", () => {
  it("is the legacy text, flattened and cut, only when the API sent no structured view", () => {
    expect(summariseNote({ finalDocumentation: "Line one.\n\n  Line two." })).toEqual({
      kind: "text",
      text: "Line one. Line two.",
      someWithheld: false,
    });
    const long = summariseNote({ finalDocumentation: "word ".repeat(40) });
    expect(long.kind === "text" && long.text.endsWith("…")).toBe(true);
    expect(summariseNote({ finalDocumentation: null })).toEqual({ kind: "none" });
  });

  it("ignores the legacy string whenever the structured view is there", () => {
    const legacy = "LEGACY";
    expect(
      summariseNote({
        finalDocumentation: legacy,
        finalDocumentationView: { withheld: true, sections: [] },
      }),
    ).toEqual({ kind: "withheld" });
    expect(summariseNote({ finalDocumentation: legacy, finalDocumentationView: null })).toEqual({
      kind: "none",
    });
  });

  it("joins the readable sections and notes when some are withheld", () => {
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: {
          withheld: false,
          sections: [section("A."), section(null, true), section("B.")],
        },
      }),
    ).toEqual({ kind: "text", text: "A. B.", someWithheld: true });
  });

  it("is withheld when no section is readable", () => {
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: { withheld: false, sections: [section(null, true)] },
      }),
    ).toEqual({ kind: "withheld" });
  });

  it("is nothing, not withheld, when no section holds text and none is withheld", () => {
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: {
          withheld: false,
          sections: [section(null), section("   ")],
        },
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not say a section was withheld when it was only empty", () => {
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: { withheld: false, sections: [section("A."), section(null)] },
      }),
    ).toEqual({ kind: "text", text: "A.", someWithheld: false });
  });

  it("is withheld when a section is withheld and the rest are empty", () => {
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: { withheld: false, sections: [section(null), section(null, true)] },
      }),
    ).toEqual({ kind: "withheld" });
  });

  it("reads a withheld section as the API sends it: no id, no text, no amendment, no date", () => {
    const withheld = {
      sectionId: null,
      text: null,
      withheld: true,
      amendedByAddendumId: null,
      signedAt: null,
    };
    const readable = { ...withheld, sectionId: "plan", text: "Plan unchanged.", withheld: false };
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: { withheld: false, sections: [readable, withheld] },
      }),
    ).toEqual({ kind: "text", text: "Plan unchanged.", someWithheld: true });
    expect(
      summariseNote({
        finalDocumentation: null,
        finalDocumentationView: { withheld: false, sections: [withheld, withheld] },
      }),
    ).toEqual({ kind: "withheld" });
  });

  it("is unavailable for a note whose view could not be decided", () => {
    expect(summariseNote({ finalDocumentation: null, viewUnavailable: true })).toEqual({
      kind: "unavailable",
    });
  });
});
