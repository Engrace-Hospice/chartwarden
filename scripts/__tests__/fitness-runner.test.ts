/**
 * `arch:fitness` must run EVERY gate and report the complete red set.
 *
 * The gate used to be a 25-link `&&` chain, which short-circuits: a failure at link 2 meant links
 * 3-25 never ran, and the log said "one gate failed" when 23 gates were simply unknown. At
 * main@c526c79b that hid two further red gates behind `arch:boundaries` — including `arch:tenancy`,
 * which was red on a live cross-org RLS leak (#15). These cases are the regression net for #18: they
 * fail if the chain form comes back, or if a gate quietly falls out of the list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATES } from "../run-fitness-gates";

const REPO_ROOT = join(__dirname, "../..");
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("arch:fitness gate runner", () => {
  it("package.json delegates to the runner rather than chaining gates with &&", () => {
    const script = pkg.scripts["arch:fitness"];
    expect(script).toBeDefined();
    expect(script).toContain("scripts/run-fitness-gates.ts");
    // The whole point: `&&` between gates is what made a red gate invisible behind an earlier one.
    expect(
      script,
      "arch:fitness must not chain gates with && — that short-circuits and hides every gate after " +
        "the first failure (#18)",
    ).not.toContain("&&");
  });

  it("every gate it runs is a real package.json script", () => {
    // A typo'd name would still fail the run (bun exits non-zero on an unknown script), but it would
    // fail for the wrong reason and read as a broken gate rather than a broken list.
    const missing = GATES.filter((g) => !(g in pkg.scripts));
    expect(
      missing,
      `gate name(s) with no matching package.json script: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("covers every gate the fitness-gate self-test proves red-and-green", () => {
    // scripts/__tests__/fitness-gates.test.ts asserts each gate goes red on a one-violation fixture
    // and green at the repo root. A gate worth proving that way is a gate `arch:fitness` must RUN —
    // otherwise a gate can stay fully proven while quietly no longer being enforced, with nothing
    // going red to say so.
    //
    // That self-test names gates by their SCRIPT FILE (`check-tenancy.ts`), not by npm script name,
    // so the two are joined here through package.json: script file -> the script(s) that invoke it ->
    // the runner's list.
    const selfTest = readFileSync(join(__dirname, "fitness-gates.test.ts"), "utf8");
    const gateFiles = [
      ...new Set(
        [...selfTest.matchAll(/["'`](check-[a-z0-9-]+\.ts)["'`]/g)].map((m) => m[1] as string),
      ),
    ];
    expect(
      gateFiles.length,
      "self-test parse found no gate scripts — the regex has gone stale",
    ).toBeGreaterThan(5);

    const uncovered = gateFiles.filter((file) => {
      const invoking = Object.entries(pkg.scripts)
        .filter(([name, cmd]) => name !== "arch:fitness" && cmd.includes(file))
        .map(([name]) => name);
      // Proven by the self-test but no package.json script runs it at all -> also a gap.
      if (invoking.length === 0) return true;
      return !invoking.some((name) => (GATES as readonly string[]).includes(name));
    });

    expect(
      uncovered,
      `gate script(s) proven by fitness-gates.test.ts but never run by arch:fitness: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("lists each gate exactly once", () => {
    expect(new Set(GATES).size).toBe(GATES.length);
  });
});
