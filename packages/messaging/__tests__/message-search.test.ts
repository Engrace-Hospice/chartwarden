import { describe, expect, it } from "vitest";
import {
  SEARCH_MAX_TERMS,
  bodyMatchesTerms,
  normalizeSearchText,
  parseSearchQuery,
} from "../src/search/message-search";

describe("parseSearchQuery (WP 2.7a option A)", () => {
  it("splits on whitespace and normalises case, width and invisibles", () => {
    expect(parseSearchQuery("  Ｈｅllo​   WORLD ")).toEqual(["hello", "world"]);
  });
  it("rejects a query shorter than two characters", () => {
    expect(() => parseSearchQuery("a")).toThrow(/at least 2/);
    expect(() => parseSearchQuery("   ")).toThrow();
  });
  it("rejects too many terms and an over-long query", () => {
    const many = Array.from({ length: SEARCH_MAX_TERMS + 1 }, (_, i) => `ab${i}`).join(" ");
    expect(() => parseSearchQuery(many)).toThrow();
    expect(() => parseSearchQuery("x".repeat(101))).toThrow();
  });
  it("dedupes repeated terms", () => {
    expect(parseSearchQuery("pain pain PAIN")).toEqual(["pain"]);
  });
});

describe("bodyMatchesTerms", () => {
  it("requires every term as a case-insensitive substring", () => {
    const body = normalizeSearchText("Patient reports Pain in the left knee");
    expect(bodyMatchesTerms(body, ["pain", "knee"])).toBe(true);
    expect(bodyMatchesTerms(body, ["pain", "hip"])).toBe(false);
    expect(bodyMatchesTerms(body, ["kne"])).toBe(true);
  });
  it("never matches an empty body", () => {
    expect(bodyMatchesTerms("", ["ab"])).toBe(false);
  });
});
