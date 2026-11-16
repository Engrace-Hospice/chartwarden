// apps/backend/__tests__/hope-g2-uuid.test.ts — an id a caller typed is read the way Postgres reads a uuid (class:
// caller-spelling keys). A JS comparison that stands in for the database's must not make one record two keys.
import { describe, expect, it } from "vitest";
import { canonicalUuidOrNull, sameUuid } from "../src/modules/10-hope/hope-uuid";

const CANONICAL = "abcdef01-2345-4678-89ab-cdef01234567";

describe("canonicalUuidOrNull", () => {
  it.each([
    ["upper case", CANONICAL.toUpperCase()],
    ["braces", `{${CANONICAL}}`],
    ["no hyphens", CANONICAL.replace(/-/g, "")],
    ["braces and upper case", `{${CANONICAL.toUpperCase()}}`],
    // Postgres reads a hyphen after ANY group of four digits, not only the canonical 8-4-4-4-12 places.
    ["a hyphen after every group of four", "abcd-ef01-2345-4678-89ab-cdef-0123-4567"],
    ["a hyphen after only some groups of four", "abcdef01-2345-467889ab-cdef01234567"],
    [
      "braces around a hyphen after every group of four",
      "{abcd-ef01-2345-4678-89ab-cdef-0123-4567}",
    ],
    ["already canonical", CANONICAL],
  ])("reads %s as the canonical text", (_label, spelled) => {
    expect(canonicalUuidOrNull(spelled)).toBe(CANONICAL);
  });

  it.each([
    ["an empty string", ""],
    ["a word", "not-a-uuid"],
    ["31 digits", CANONICAL.replace(/-/g, "").slice(1)],
    ["33 digits", `${CANONICAL.replace(/-/g, "")}0`],
    ["one brace", `{${CANONICAL}`],
    ["a non-hex digit", `${CANONICAL.slice(0, -1)}g`],
    ["surrounding blanks (Postgres refuses them too)", ` ${CANONICAL} `],
    // Each of these is refused by Postgres (a hyphen only follows a group of four digits, and never leads, trails or doubles), so
    // an id read here must not be served while the read-audit's uuid column refuses the same text and the read leaves no trail.
    ["a leading hyphen", `-${CANONICAL}`],
    ["a trailing hyphen", `${CANONICAL}-`],
    ["a doubled hyphen", CANONICAL.replace("-", "--")],
    ["a hyphen inside a group of four", "abcdef0123-454678-89abcdef01234567"],
    ["a hyphen after the first digit", `a-${CANONICAL.slice(1)}`],
    ["a hyphen just inside the braces", `{-${CANONICAL}}`],
    ["braces with a hyphen after the last group", `{${CANONICAL}-}`],
    ["two pairs of braces", `{{${CANONICAL}}}`],
  ])("answers null for %s instead of throwing", (_label, text) => {
    expect(canonicalUuidOrNull(text)).toBeNull();
  });
});

describe("sameUuid", () => {
  it("is true for two spellings of one id", () => {
    expect(sameUuid(CANONICAL, `{${CANONICAL.toUpperCase()}}`)).toBe(true);
  });

  it("is false for two different ids", () => {
    expect(sameUuid(CANONICAL, CANONICAL.replace(/7$/, "8"))).toBe(false);
  });

  it("is false when neither side is a uuid (two non-ids are not 'the same id')", () => {
    expect(sameUuid("pe-1", "pe-1")).toBe(false);
  });
});
