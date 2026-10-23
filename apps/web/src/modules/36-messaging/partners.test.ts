import { describe, expect, it } from "vitest";
import { validateShareDraft } from "./partners";

const ok = {
  channelId: "11111111-1111-4111-8111-111111111111",
  partnerName: "Northside",
  partnerKind: "pharmacy" as const,
  baaReference: "BAA-1",
  days: "7",
};

describe("validateShareDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateShareDraft(ok)).toBeNull();
  });
  it("names the first problem", () => {
    expect(validateShareDraft({ ...ok, channelId: "x" })).toMatch(/UUID/);
    expect(validateShareDraft({ ...ok, partnerName: "  " })).toMatch(/name/);
    expect(validateShareDraft({ ...ok, baaReference: "" })).toMatch(/agreement/);
  });
  it("bounds the days to 1..30 whole numbers", () => {
    for (const days of ["0", "31", "1.5", "abc", ""])
      expect(validateShareDraft({ ...ok, days }), days).toMatch(/days/);
    expect(validateShareDraft({ ...ok, days: "30" })).toBeNull();
  });
});
