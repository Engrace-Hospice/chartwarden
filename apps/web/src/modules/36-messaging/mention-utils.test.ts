import { describe, expect, it } from "vitest";
import { insertMention } from "./mention-utils";

describe("patient mention composition", () => {
  it("stores a neutral token and an exact patient reference", () => {
    const result = insertMention({
      draft: "Check @Ja",
      references: [],
      query: { query: "Ja", start: 6 },
      cursor: 9,
      candidate: {
        kind: "patient",
        entityId: "patient-1",
        displayName: "Jane Doe",
        detail: "Patient",
      },
    });
    expect(result.draft).toBe("Check @Patient");
    expect(result.references).toEqual([
      {
        kind: "patient",
        entityId: "patient-1",
        start: 6,
        end: 14,
        displayLabel: "Patient",
      },
    ]);
  });
});
