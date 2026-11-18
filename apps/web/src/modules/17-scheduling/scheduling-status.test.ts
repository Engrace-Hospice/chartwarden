import { describe, expect, it } from "vitest";
import { PURPOSES, purposeLabel } from "./scheduling-status";

describe("visit purpose display table", () => {
  it("shows recert and loc_change as RN visits, matching the M17 purpose table", () => {
    expect(PURPOSES.recert?.discipline).toBe("rn");
    expect(PURPOSES.loc_change?.discipline).toBe("rn");
  });

  it("keeps the physician or NP encounter on face-to-face", () => {
    expect(PURPOSES.f2f?.discipline).toBe("md");
  });

  it("labels the recertification kickoff so it is not mistaken for the face-to-face", () => {
    expect(purposeLabel("recert")).toBe("Recert Kickoff (RN)");
    expect(purposeLabel("f2f")).toBe("Face-to-Face");
  });

  it("falls back to a title-cased label for a purpose the table does not know", () => {
    expect(purposeLabel("future_purpose")).toBe("Future Purpose");
  });
});
