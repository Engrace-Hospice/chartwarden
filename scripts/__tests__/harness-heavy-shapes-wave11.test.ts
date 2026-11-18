/**
 * Wave 11, part D, rule 11: the readers wave 11 added loop over the words and statements of a command; a guard that runs out of time
 * refuses the call, so none of them may be super-linear on the shapes an adversary can build in 64 KB. Each shape must finish with a
 * decision (no throw) well inside the deadline; the bound is a guard against a blow-up, not a micro-benchmark (the shapes took 2 to
 * 850 ms when written, under a load of 5).
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: () => false,
  branch: "feature",
};
const K = `M34_TENANT${"_"}KEK`;
const BOUND_MS = 4000;

const chain = Array.from({ length: 400 }, (_, i) => `x${i}=$x${i === 0 ? "" : i - 1}`).join("; ");
const statements = Array.from({ length: 3000 }, (_, i) => `a${i}=$a${i + 1}`).join("; ");
const sources = Array.from({ length: 2000 }, (_, i) => `source <(echo export V${i}=1)`).join("; ");

/** shape name, command, a decision it must NOT be (null: any decision will do). */
const SHAPES: ReadonlyArray<readonly [string, string, string | null]> = [
  ["awk with 15,000 adjacent strings", `awk '${'"a" '.repeat(15000)}' f`, null],
  ["awk with an unclosed quote repeated", `awk '${'"a '.repeat(20000)}' f`, null],
  ["awk with 5,000 print pipes", `awk '${'x | "c" '.repeat(5000)}' f`, "allow"],
  ["awk with 3,000 system calls", `awk '${'system("a") '.repeat(3000)}' f`, "allow"],
  ["sed with 5,000 commands", `sed '${"s/a/b/;".repeat(5000)}' f`, null],
  ["sed with 30,000 slashes", `sed 's${"/".repeat(30000)}' f`, null],
  ["a taint chain of 400 copies", `${chain}; x0=$${K}; echo $x399`, null],
  ["3,000 chained statements", `${statements}; echo $a0`, null],
  ["2,000 indirect expansions", `K=A; ${"echo ${!K} ".repeat(2000)}`, null],
  [
    "a forced push of 5,000 unplaceable refs",
    `git push --force origin ${"b$(x) ".repeat(5000)}`,
    "allow",
  ],
  ["a push with 5,000 options", `git push ${"-o x ".repeat(5000)}origin main`, "allow"],
  ["2,000 sourced substitutions then a client", `${sources}; psql -c 1`, "allow"],
  [
    "a URI with 10,000 substitutions",
    `psql "postgres://localhost/${"$(a)".repeat(10000)}"`,
    "allow",
  ],
  [
    "a URI with 15,000 variables",
    `read P; psql "postgres://localhost:${"$P".repeat(15000)}/db"`,
    "allow",
  ],
  [
    "a connection string with 8,000 substitutions",
    `psql "host=localhost ${"x=$(a) ".repeat(8000)}"`,
    "allow",
  ],
  [
    "2,000 awk commands behind a remote host variable",
    `export PGHOST=h; ${"awk '{print}' f; ".repeat(2000)}`,
    null,
  ],
  ["8,000 ambiguous long options", `psql ${"--p x ".repeat(8000)}-c 1`, "allow"],
  ["a forced add of 15,000 pathspecs", `git add -f ${"a ".repeat(15000)}`, null],
  ["an osascript with 8,000 script files", `osascript ${"x.scpt ".repeat(8000)}`, "allow"],
];

describe("wave 11 readers stay linear on the shapes an adversary can build", () => {
  it.each(SHAPES)("%s", (_name, cmd, mustNotBe) => {
    const start = Date.now();
    const verdict = classifyBash(cmd, ctx);
    expect(Date.now() - start).toBeLessThan(BOUND_MS);
    expect(["allow", "ask", "deny"]).toContain(verdict.decision);
    if (mustNotBe !== null) expect(verdict.decision).not.toBe(mustNotBe);
  });

  it("an awk program over the size cap is not read for its commands: it asks", () => {
    const big = `awk 'BEGIN{ ${"x=1; ".repeat(5000)} }' f`;
    expect(classifyBash(big, ctx).decision).toBe("ask");
    expect(classifyBash(`export PGHOST=h; ${big}`, ctx).decision).not.toBe("allow");
  });
});
