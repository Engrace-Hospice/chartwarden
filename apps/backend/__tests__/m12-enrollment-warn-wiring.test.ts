/**
 * A claim that cannot be released after a definitive vendor refusal ages out of its window; the only thing that says so is the
 * enrolment service's `warn` sink. It was optional and the composition root never passed it, so in production the failure was
 * swallowed. The sink is now a REQUIRED dependency (the root fails to typecheck without it); this pins the root's call site too, so
 * a refactor that drops or stubs it fails a test and not just a review.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");

/** The text of the balanced `{ ... }` argument of `createPrescriberEnrollmentService(`. */
function callArgument(source: string, callee: string): string {
  const start = source.indexOf(`${callee}({`);
  if (start < 0) throw new Error(`no call to ${callee} in the composition root`);
  let depth = 0;
  for (let i = start + callee.length + 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced call");
}

describe("the composition root wires the enrolment service's warn sink", () => {
  const call = callArgument(ROOT, "createPrescriberEnrollmentService");

  it("passes a warn that reaches the application log (not a no-op)", () => {
    expect(call).toMatch(
      /\bwarn:\s*\(\s*fields\s*,\s*message\s*\)\s*=>\s*app\.log\.warn\(fields,\s*message\)/,
    );
  });
});
