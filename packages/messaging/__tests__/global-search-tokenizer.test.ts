// WP 2.7b / ADR-0058 - the global-search tokenizer: golden clinical cases, ID-like filtering, bounds, determinism.
import { describe, expect, it } from "vitest";
import {
  STOP_WORDS,
  indexTagStrings,
  isIdLikeChunk,
  tokenizeForSearch,
} from "../src/search/global";

describe("global search tokenizer (ADR-0058 decision 3)", () => {
  it("has the 101-word stop list and keeps negations and clinical words indexable", () => {
    expect(STOP_WORDS.size).toBe(101);
    for (const kept of ["not", "none", "never", "without", "pain", "off", "above", "below"]) {
      expect(STOP_WORDS.has(kept)).toBe(false);
    }
  });

  // [input, tokens, n = whole + prefix tags before padding]
  const GOLDEN: ReadonlyArray<readonly [string, readonly string[], number]> = [
    ["morphine", ["morphine"], 7],
    ["5 mg", [], 0],
    ["5mg", [], 0],
    ["MS Contin 15", ["contin"], 5],
    ["MRN 12345678", ["mrn"], 2],
    ["Café", ["cafe"], 3],
    ["cafe", ["cafe"], 3],
    ["hba1c", [], 0],
    ["not eating", ["not", "eating"], 7],
  ];
  it.each(GOLDEN)("golden: %j", (input, tokens, n) => {
    expect(tokenizeForSearch(input)).toEqual(tokens);
    expect(indexTagStrings(tokens)).toHaveLength(n);
  });

  it("indexes a long letter-only word", () => {
    expect(tokenizeForSearch("esophagogastroduodenoscopy")).toEqual(["esophagogastroduodenoscopy"]);
    expect(tokenizeForSearch("Esophagogastroduodenoscopy")).toEqual(["esophagogastroduodenoscopy"]);
  });

  it("drops 20+ char hex with a digit, mixed-case base64, symbol base64 and a UUID", () => {
    expect(tokenizeForSearch("deadbeef0123456789abcdef")).toEqual([]);
    expect(tokenizeForSearch("aGVsbG9Xb3JsZGhlbGxvd29ybGQ")).toEqual([]);
    expect(tokenizeForSearch("abcdefghijklmnopqrstuvwxyz-abc")).toEqual([]);
    expect(tokenizeForSearch("123e4567-e89b-12d3-a456-426614174000")).toEqual([]);
  });

  it("drops a word longer than 40 letters instead of truncating it", () => {
    expect(tokenizeForSearch("a".repeat(41))).toEqual([]);
    expect(tokenizeForSearch("a".repeat(40))).toEqual(["a".repeat(40)]);
  });

  it("drops emails, URLs, phone shapes and MRN-like shapes but keeps their neighbours", () => {
    expect(tokenizeForSearch("mail jane.doe@example.org today")).toEqual(["mail", "today"]);
    expect(tokenizeForSearch("see https://example.org/x now")).toEqual(["see", "now"]);
    expect(tokenizeForSearch("call 555-123-4567 please")).toEqual(["call", "please"]);
    expect(tokenizeForSearch("AB12345 admitted")).toEqual(["admitted"]);
  });

  it("keeps words with at most one letter/digit transition and fewer than 6 digits", () => {
    expect(tokenizeForSearch("covid19 b12 15mg")).toEqual(["covid"]);
    expect(isIdLikeChunk("abc123def")).toBe(true);
    expect(isIdLikeChunk("covid19")).toBe(false);
  });

  it("folds diacritics and compatibility forms, lowercases without locale", () => {
    expect(tokenizeForSearch("Crème Brûlée")).toEqual(["creme", "brulee"]);
    expect(tokenizeForSearch("ﬁnal ＷＯＲＤ")).toEqual(["final", "word"]);
    expect(tokenizeForSearch("ILLNESS")).toEqual(["illness"]);
  });

  it("drops stop words and tokens under 3 characters, splits on punctuation, de-duplicates", () => {
    expect(tokenizeForSearch("the pain, and no relief; pain again")).toEqual(["pain", "relief"]);
    expect(tokenizeForSearch("mg ms ml iv no")).toEqual([]);
  });

  it("is deterministic", () => {
    const text = "Patient is not eating; MS Contin 15 mg given — café au lait";
    expect(tokenizeForSearch(text)).toEqual(tokenizeForSearch(text));
  });

  it("has distinct, stable tag strings: whole-word then prefix 3..min(len,12)", () => {
    const tags = indexTagStrings(["morphine"]);
    expect(tags[0]).toBe("w\0morphine");
    expect(tags).toContain("p\u00003\u0000mor");
    expect(tags).toContain("p\u00008\u0000morphine");
    // shared prefixes across tokens are one tag, not two
    expect(indexTagStrings(["morphine", "morning"])).toHaveLength(7 + 1 + 4);
  });

  it("caps prefix tags at 12 characters", () => {
    const tags = indexTagStrings(["esophagogastroduodenoscopy"]);
    expect(tags).toHaveLength(1 + 10); // lengths 3..12
    expect(tags.some((t) => t.startsWith("p\u000013\u0000"))).toBe(false);
  });
});
