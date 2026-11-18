/**
 * Wave 9, W9-4. The three inline long-option abbreviation readers (`git-grep-sweep.ts`, `git-exec-strings.ts`,
 * `harness-switch.ts`) now share `longName` and `spellsLong` with `optionValues`. The refactor changes no answer: the
 * existing tests pass unchanged and the corpus differ shows no transition; these pin the helpers.
 */
import { describe, expect, it } from "vitest";
import { longName, optionValues, spellsLong } from "../harness/option-values";

describe("longName", () => {
  it.each([
    ["--no-verify", "no-verify"],
    ["--no-ver=x", "no-ver"],
    ["--a=b=c", "a"],
    ["--", ""],
    ["--=x", ""],
  ])("%s is %j", (arg, name) => {
    expect(longName(arg)).toBe(name);
  });
});

describe("spellsLong", () => {
  it.each([
    ["no-index", "no-index", 5, true],
    ["no-ind", "no-index", 5, true],
    ["no-i", "no-index", 5, false],
    ["no-indexx", "no-index", 5, false],
    ["un", "untracked", 2, true],
    ["u", "untracked", 2, false],
    ["", "untracked", 0, true],
  ])("%j of %s with a minimum of %i is %s", (given, name, min, expected) => {
    expect(spellsLong(given, name, min)).toBe(expected);
  });
});

describe("optionValues reads a long option through the same helper", () => {
  it("an abbreviation, with a separate or an attached value", () => {
    const long = [["output-dir", 4]] as const;
    expect(optionValues(["--outp", "d"], "", long)).toEqual(["d"]);
    expect(optionValues(["--outp=d"], "", long)).toEqual(["d"]);
    expect(optionValues(["--output-dir", "d"], "", long)).toEqual(["d"]);
    expect(optionValues(["--out", "d"], "", long)).toEqual([]);
  });
});
