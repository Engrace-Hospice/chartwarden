import { describe, expect, it } from "vitest";
import { matchesAllTokens, nameText } from "./name-display";

describe("matchesAllTokens", () => {
  it("matches 'First Last' against a 'Last, First' name", () => {
    expect(matchesAllTokens(["Lovelace, Ada", "MRN-1"], "ada lovelace")).toBe(true);
    expect(matchesAllTokens(["Lovelace, Ada"], "lovelace, ada")).toBe(true);
  });
  it("requires every token, and an empty query matches", () => {
    expect(matchesAllTokens(["Lovelace, Ada"], "ada turing")).toBe(false);
    expect(matchesAllTokens([undefined, null], "   ")).toBe(true);
  });
  it("finds an MRN token alongside a name token", () => {
    expect(matchesAllTokens(["Lovelace, Ada", "MRN-77"], "ada mrn-77")).toBe(true);
  });
});

describe("nameText", () => {
  it("tells loading from unavailable", () => {
    expect(nameText(undefined)).toBe("Loading…");
    expect(nameText(null)).toBe("Name unavailable");
    expect(nameText("Dr. X")).toBe("Dr. X");
  });
});
