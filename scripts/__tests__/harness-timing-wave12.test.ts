/**
 * Wave 12, G-1 (R9-COMP-9): the helper the timing tests of the shell classifier stand on (`helpers/work-counters.ts`).
 * Their wall-clock bounds had been widened 2.5x to 30x (5 s for a classifier whose hard deadline is 6.5 s), so a 10x
 * slowdown passed; they now assert COUNTS (what a command spent of its per-command budget: the same on every machine and
 * every run) and keep the clock only as a safety net. These tests pin the counts themselves, so a change to the
 * budget, or a helper that reads the wrong command's spending, is seen here and not as a mystery in four other files.
 */
import { describe, expect, it } from "vitest";
import {
  FULL_BUDGET,
  MACHINE_FACTOR,
  type Measured,
  NET_FLOOR_MS,
  measure,
  netMs,
} from "./helpers/work-counters";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const MAX_COMMAND_CHARS = 64 * 1024;
const NOTHING_SPENT = { chars: 0, braces: 0, braceChars: 0, resolutions: 0, resolutionChars: 0 };
const repeat = (unit: string, chars: number): string =>
  unit.repeat(Math.floor(chars / unit.length));

describe("the per-command budget the counts are measured against", () => {
  // A change to a cap is a decision: it changes how much work one command may cost, and every count assertion in the
  // timing tests is measured against it.
  it("is 256 KB of judged text, 4,096 brace alternatives (8 MB of them) and 16,384 path resolutions (8 MB)", () => {
    expect(FULL_BUDGET).toEqual({
      chars: 256 * 1024,
      braces: 4096,
      braceChars: 8 * 1024 * 1024,
      resolutions: 16_384,
      resolutionChars: 8 * 1024 * 1024,
    });
  });
});

describe("measure reads the spending of the command it was given", () => {
  it("an oversize command spends nothing, even right after a command that spent a great deal", () => {
    const spender = measure(
      `cat ${Array.from({ length: 200 }, (_, i) => `w${i}{a,b}{c,d}`).join(" ")}`,
      ctx,
    );
    expect(spender.spent.chars).toBeGreaterThan(0);
    expect(spender.spent.braces).toBeGreaterThan(0);
    const refused = measure(repeat("cd a;", MAX_COMMAND_CHARS + 4000), ctx);
    expect(refused.verdict.decision).toBe("deny");
    expect(refused.spent).toEqual(NOTHING_SPENT);
    expect(refused.exhausted).toBe(false);
  });

  it("the same command spends the same on every run (the counts do not depend on the clock or the load)", () => {
    const cmd = `cd /tmp/a; cd /tmp/b; rm -f ${Array.from({ length: 300 }, (_, i) => `x${i}{,.orig}`).join(" ")}`;
    const first = measure(cmd, ctx);
    for (let run = 0; run < 5; run++) expect(measure(cmd, ctx).spent).toEqual(first.spent);
  });

  // What a few small commands spend, exactly: the accounting the timing tests count with. A rule that judges a text
  // twice, resolves a path it did not before or expands a brace it need not changes a number here, on purpose.
  it.each([
    ["echo hi", { chars: 7, braces: 0, braceChars: 0, resolutions: 1, resolutionChars: 5 }],
    [
      "rm -f build/a build/b",
      { chars: 21, braces: 0, braceChars: 0, resolutions: 3, resolutionChars: 19 },
    ],
    [
      "cd /tmp/a; rm -f x",
      { chars: 18, braces: 0, braceChars: 0, resolutions: 3, resolutionChars: 19 },
    ],
    ["cat {a,b}", { chars: 9, braces: 4, braceChars: 20, resolutions: 1, resolutionChars: 5 }],
    [
      "mv src/a.ts src/b.ts",
      { chars: 20, braces: 0, braceChars: 0, resolutions: 4, resolutionChars: 34 },
    ],
    [
      "echo $(echo hi)",
      { chars: 22, braces: 0, braceChars: 0, resolutions: 1, resolutionChars: 5 },
    ],
  ])("spends exactly this for %j", (cmd, expected) => {
    expect(measure(cmd, ctx).spent).toEqual(expected);
  });

  it("a command that fits spends its text once and exhausts nothing", () => {
    const cmd = `echo ${"a".repeat(1000)}`;
    const m = measure(cmd, ctx);
    expect(m.verdict.decision).toBe("allow");
    expect(m.spent.chars).toBe(cmd.length);
    expect(m.exhausted).toBe(false);
    expect(m.halted).toBe(false);
  });

  // Each nested level is judged once, whole: n levels cost the text of every level once (each level adds its own `$(` and
  // `)`), not each level from every level.
  it("a nested substitution costs one pass over the text of each level, no more", () => {
    const BODY = 5000;
    const nested = (levels: number): string =>
      `${"$(".repeat(levels)}echo ${"y".repeat(BODY)}${")".repeat(levels)}`;
    const BRACKETS_PER_LEVEL = 3; // `$(` and `)`
    const BASE = "echo ".length + BODY;
    for (let levels = 0; levels <= 5; levels++) {
      let once = 0;
      for (let level = 0; level <= levels; level++) once += BASE + BRACKETS_PER_LEVEL * level;
      expect(measure(nested(levels), ctx).spent.chars, `${levels} levels`).toBe(once);
    }
  });

  // The linearity of a cd chain, with no clock: each doubling of the chain adds twice what the last one added (a
  // constant, then so many characters per cd). Resolving each cd against every earlier one would add four times.
  it.each(["cd a;", "cd a/b/c/d/e/f/g/h/i/j;"])(
    "a chain of `%s` spends resolution characters in proportion to its length",
    (unit) => {
      const spent = (chars: number): number =>
        measure(`${repeat(unit, chars)}ls`, ctx).spent.resolutionChars;
      const [quarter, half, whole] = [spent(15_000), spent(30_000), spent(60_000)] as const;
      expect(half).toBeGreaterThan(quarter);
      expect(whole - half).toBe(2 * (half - quarter));
    },
  );

  it("brace expansion draws on the brace budget and plain targets on the resolution budget", () => {
    const braces = measure(`cat ${"{a,b}{c,d}".repeat(40)}`, ctx);
    expect(braces.spent.braces).toBeGreaterThan(0);
    const plain = measure(`rm -f ${Array.from({ length: 50 }, (_, i) => `f${i}`).join(" ")}`, ctx);
    expect(plain.spent.braces).toBe(0);
    expect(plain.spent.resolutions).toBeGreaterThan(0);
  });

  it("a command the budget cuts reports it, and the cut command asks", () => {
    const m: Measured = measure(`cat ${"{a,b}".repeat(12_000)}`, ctx);
    expect(m.exhausted).toBe(true);
    expect(m.verdict.decision).toBe("ask");
  });
});

describe("netMs: the safety net next to the counts", () => {
  it("never goes under the floor, and is twice the worst loaded run above it", () => {
    expect(netMs(0)).toBe(NET_FLOOR_MS * MACHINE_FACTOR);
    expect(netMs(NET_FLOOR_MS / 2)).toBe(NET_FLOOR_MS * MACHINE_FACTOR);
    expect(netMs(100)).toBe(200 * MACHINE_FACTOR);
  });

  it("is a bound that real work stays under and a hundredfold slowdown does not", () => {
    expect(MACHINE_FACTOR).toBeGreaterThanOrEqual(1);
    // The slowest shape of the timing tests measured 105 ms: its bound is 2x that, nowhere near the 5 s it replaced.
    expect(netMs(105.5)).toBeLessThan(211 * MACHINE_FACTOR + 1e-9);
    expect(netMs(105.5) / MACHINE_FACTOR).toBeLessThan(250);
  });
});
