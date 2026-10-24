// M25 milestone 12a-1 - the payer appeal PATH pure rules: closed sets, level completeness, input validation, the
// resolver (a missing path is "none", never a default) and the verification rule (a second person). No test here uses a
// real payer's window: every number is a made-up fixture value for the arithmetic only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PathHeaderInput,
  type PathLevelInput,
  checkPathInput,
  checkPathVerify,
  isWindowComplete,
  levelWindow,
  resolvePayerPath,
} from "../payer-appeal-path";

const header: PathHeaderInput = {
  payerId: "p1",
  program: "commercial",
  contractLabel: null,
  effectiveFrom: "2026-01-01",
  sourceNote: "contract page 4",
};
const level = (over: Partial<PathLevelInput> = {}): PathLevelInput => ({
  levelKind: "internal",
  levelLabel: "First level",
  whoFiles: "provider",
  filingWindowDays: 10,
  anchorKind: "notice_date",
  receiptPresumptionDays: null,
  dayBasis: "calendar",
  roll: null,
  decisionDays: null,
  formLabel: null,
  channelNote: null,
  sourceNote: "contract page 4",
  ...over,
});
const noWindow = (): Partial<PathLevelInput> => ({
  filingWindowDays: null,
  anchorKind: null,
  receiptPresumptionDays: null,
  dayBasis: null,
  roll: null,
});

describe("window completeness", () => {
  it("a level with no window is incomplete and yields no LevelWindow", () => {
    expect(isWindowComplete(level(noWindow()))).toBe(false);
    expect(levelWindow(level(noWindow()))).toBeNull();
  });
  it("a complete window is returned as stored, with no presumption invented", () => {
    expect(levelWindow(level())).toEqual({
      windowDays: 10,
      anchorKind: "notice_date",
      receiptPresumptionDays: null,
      dayBasis: "calendar",
      roll: null,
    });
  });
  it("a business basis without a roll is incomplete", () => {
    expect(isWindowComplete(level({ dayBasis: "business_us_federal", roll: null }))).toBe(false);
  });
});

describe("checkPathInput", () => {
  it("accepts a header with one complete level", () => {
    expect(checkPathInput(header, [level()])).toBeNull();
  });
  it("accepts a level that records no window at all (guidance only)", () => {
    expect(checkPathInput(header, [level(noWindow())])).toBeNull();
  });
  it.each([
    ["PROGRAM_INVALID", { ...header, program: "medicare" }, [level()]],
    ["PROGRAM_INVALID", { ...header, program: "medicaid" }, [level()]],
    ["EFFECTIVE_DATE_INVALID", { ...header, effectiveFrom: "2026-02-30" }, [level()]],
    ["SOURCE_NOTE_REQUIRED", { ...header, sourceNote: "  " }, [level()]],
    ["NO_LEVELS", header, []],
    ["LEVEL_LABEL_REQUIRED", header, [level({ levelLabel: " " })]],
    ["LEVEL_KIND_INVALID", header, [level({ levelKind: "iro" as never })]],
    ["WHO_FILES_INVALID", header, [level({ whoFiles: "anyone" as never })]],
    ["LEVEL_SOURCE_NOTE_REQUIRED", header, [level({ sourceNote: "" })]],
    ["WINDOW_INCOMPLETE", header, [level({ anchorKind: null })]],
    ["WINDOW_INCOMPLETE", header, [level({ dayBasis: null })]],
    ["WINDOW_INCOMPLETE", header, [level({ ...noWindow(), receiptPresumptionDays: 2 })]],
    ["WINDOW_OUT_OF_RANGE", header, [level({ filingWindowDays: 0 })]],
    ["WINDOW_OUT_OF_RANGE", header, [level({ filingWindowDays: 1.5 })]],
    ["ANCHOR_INVALID", header, [level({ anchorKind: "whenever" as never })]],
    ["BASIS_INVALID", header, [level({ dayBasis: "lunar" as never })]],
    ["ROLL_REQUIRED", header, [level({ dayBasis: "business_us_federal", roll: null })]],
    ["ROLL_NOT_ALLOWED", header, [level({ dayBasis: "calendar", roll: "back" })]],
    [
      "ROLL_INVALID",
      header,
      [level({ dayBasis: "business_us_federal", roll: "sideways" as never })],
    ],
    ["RECEIPT_OUT_OF_RANGE", header, [level({ receiptPresumptionDays: -1 })]],
    ["DECISION_DAYS_OUT_OF_RANGE", header, [level({ decisionDays: 0 })]],
    ["TEXT_TOO_LONG", header, [level({ levelLabel: "x".repeat(501) })]],
  ] as const)("refuses %s", (code, h, levels) => {
    expect(checkPathInput(h as PathHeaderInput, levels as unknown as PathLevelInput[])).toBe(code);
  });
  it("accepts external_review as a label, with no extra fields demanded", () => {
    expect(
      checkPathInput(header, [level({ levelKind: "external_review", whoFiles: "unknown" })]),
    ).toBeNull();
  });
});

describe("resolvePayerPath", () => {
  const p = (over: Record<string, unknown>) => ({
    id: "x",
    payerId: "p1",
    program: "commercial",
    contractLabel: null as string | null,
    status: "active",
    effectiveFrom: "2026-01-01",
    revision: 1,
    ...over,
  });
  const q = { payerId: "p1", program: "commercial", contractLabel: null, asOf: "2026-06-01" };

  it("returns none when no path is recorded: there is no default", () => {
    expect(resolvePayerPath([], q)).toEqual({ kind: "none" });
  });
  it("returns none for a different payer, program or contract label", () => {
    expect(resolvePayerPath([p({ payerId: "p2" })], q)).toEqual({ kind: "none" });
    expect(resolvePayerPath([p({ program: "medicare_advantage" })], q)).toEqual({ kind: "none" });
    expect(resolvePayerPath([p({ contractLabel: "Gold" })], q)).toEqual({ kind: "none" });
    expect(resolvePayerPath([p({})], { ...q, contractLabel: "Gold" })).toEqual({ kind: "none" });
  });
  it("matches the contract label case-insensitively", () => {
    const r = resolvePayerPath([p({ id: "g", contractLabel: " gold " })], {
      ...q,
      contractLabel: "GOLD",
    });
    expect(r).toMatchObject({ kind: "path", verified: true, path: { id: "g" } });
  });
  it("ignores retired paths and paths not yet effective", () => {
    expect(resolvePayerPath([p({ status: "retired" })], q)).toEqual({ kind: "none" });
    expect(resolvePayerPath([p({ effectiveFrom: "2026-07-01" })], q)).toEqual({ kind: "none" });
  });
  it("takes the newest effective path", () => {
    const r = resolvePayerPath(
      [p({ id: "old" }), p({ id: "new", effectiveFrom: "2026-03-01" })],
      q,
    );
    expect(r).toMatchObject({ path: { id: "new" } });
  });
  it("prefers an active path over a newer draft", () => {
    const r = resolvePayerPath(
      [p({ id: "act" }), p({ id: "dr", status: "draft", effectiveFrom: "2026-05-01" })],
      q,
    );
    expect(r).toMatchObject({ kind: "path", verified: true, path: { id: "act" } });
  });
  it("falls back to a draft but flags it unverified", () => {
    const r = resolvePayerPath([p({ id: "dr", status: "draft" })], q);
    expect(r).toMatchObject({ kind: "path", verified: false, path: { id: "dr" } });
  });
  it("never returns a path for an empty or foreign set (no default is ever returned)", () => {
    for (const set of [[], [p({ payerId: "other" })], [p({ status: "retired" })]]) {
      expect(resolvePayerPath(set, q).kind).toBe("none");
    }
  });
});

describe("checkPathVerify", () => {
  it("refuses the author verifying their own path", () => {
    expect(
      checkPathVerify({
        status: "draft",
        authorMembershipId: "a",
        verifierMembershipId: "a",
        levelCount: 1,
      }),
    ).toBe("VERIFIER_IS_AUTHOR");
  });
  it("refuses a path that is not a draft", () => {
    expect(
      checkPathVerify({
        status: "active",
        authorMembershipId: "a",
        verifierMembershipId: "b",
        levelCount: 1,
      }),
    ).toBe("NOT_DRAFT");
  });
  it("refuses a path with no levels", () => {
    expect(
      checkPathVerify({
        status: "draft",
        authorMembershipId: "a",
        verifierMembershipId: "b",
        levelCount: 0,
      }),
    ).toBe("NO_LEVELS");
  });
  it("accepts a second person", () => {
    expect(
      checkPathVerify({
        status: "draft",
        authorMembershipId: "a",
        verifierMembershipId: "b",
        levelCount: 2,
      }),
    ).toBeNull();
  });
});

describe("the payer-appeal domain files encode no payer window", () => {
  // Every numeric literal in these files must be 0 or 1, or sit on a line marked `bound` (an input-validation bound that
  // belongs to no payer). A "helpful default window" cannot creep in without failing here.
  const files = ["payer-appeal-path.ts", "payer-appeal.ts"];
  it.each(files)("%s has no unmarked numeric literal", (file) => {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    const offenders = src
      .split("\n")
      .filter((l) => !/\bbound\b/i.test(l) && !/^\s*(\/\*|\*)/.test(l))
      .map((l) => l.replace(/\/\/.*$/, "").replace(/"[^"]*"/g, '""'))
      .flatMap((l) => l.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) ?? [])
      .filter((n) => n !== "0" && n !== "1");
    expect(offenders).toEqual([]);
  });
  it("and carries no payer, carrier or Medicare window vocabulary as a value", () => {
    for (const file of files) {
      const src = readFileSync(join(__dirname, "..", file), "utf8").replace(/\/\/.*$/gm, "");
      expect(src).not.toMatch(/\b(aetna|cigna|humana|united|anthem|blue ?cross|180|365)\b/i);
    }
  });
});
