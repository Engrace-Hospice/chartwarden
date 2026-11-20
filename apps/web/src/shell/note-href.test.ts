// ADR-0113 — where an open note is worked on: a draft in the composer, a finalized note on the read screen where it is signed.
import { describe, expect, it } from "vitest";
import { canAuthorEncounters, encounterEntryHref, noteHref, openNoteLabel } from "./note-href";

describe("encounterEntryHref (Workflow 09, WP1)", () => {
  const encounter = { id: "e-1", patientId: "p-1" };

  it("opens a draft in the composer for someone who may author", () => {
    expect(encounterEntryHref({ ...encounter, status: "draft" }, { canAuthor: true })).toBe(
      "/patients/p-1/encounters/e-1/compose",
    );
  });

  it("opens a draft on its record for someone who may only read (the composer would be denied)", () => {
    expect(encounterEntryHref({ ...encounter, status: "draft" }, { canAuthor: false })).toBe(
      "/patients/p-1/encounters/e-1",
    );
  });

  it.each(["finalized", "signed", "cosign_pending", "cosigned", "void", "voided"])(
    "opens a %s encounter on its record, never in the composer",
    (status) => {
      for (const canAuthor of [true, false]) {
        expect(encounterEntryHref({ ...encounter, status }, { canAuthor })).toBe(
          "/patients/p-1/encounters/e-1",
        );
      }
    },
  );
});

describe("canAuthorEncounters", () => {
  it("is true only when the session carries encounter.author", () => {
    expect(canAuthorEncounters(["encounter.read", "encounter.author"])).toBe(true);
    expect(canAuthorEncounters(["encounter.read"])).toBe(false);
    expect(canAuthorEncounters(undefined)).toBe(false);
  });
});

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
