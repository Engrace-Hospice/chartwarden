// ADR-0113 — where an open note is worked on: a draft in the composer, a finalized note on the read screen where it is signed.
import { describe, expect, it } from "vitest";
import { noteHref, openNoteLabel } from "./note-href";

describe("noteHref", () => {
  const note = { id: "e-1", patientId: "p-1" };

  it("a draft opens the composer; a finalized note opens the read screen where it is signed", () => {
    expect(noteHref({ ...note, status: "draft" })).toBe("/patients/p-1/encounters/e-1/compose");
    expect(noteHref({ ...note, status: "finalized" })).toBe("/patients/p-1/encounters/e-1");
  });

  it("labels the action by what the author does there", () => {
    expect(openNoteLabel("draft")).toBe("Continue Documentation");
    expect(openNoteLabel("finalized")).toBe("Review and Sign");
  });
});
