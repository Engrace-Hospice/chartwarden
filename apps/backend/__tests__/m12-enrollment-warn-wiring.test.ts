/**
 * A claim that cannot be released after a definitive vendor refusal ages out of its window; the only thing that says so is the
 * enrolment service's `warn` sink. It was optional and the composition root never passed it, so in production the failure was
 * swallowed. The sink is now a REQUIRED dependency (the root fails to typecheck without it); this pins the root's call site too, so
 * a refactor that drops or stubs it fails a test and not just a review.
 */
import { describe, expect, it } from "vitest";
import { COMPOSITION_ROOT, callArgument } from "./_composition-root";

describe("the composition root wires the enrolment service's warn sink", () => {
  const call = callArgument(COMPOSITION_ROOT, "createPrescriberEnrollmentService");

  it("passes a warn that reaches the application log (not a no-op)", () => {
    expect(call).toMatch(
      /\bwarn:\s*\(\s*fields\s*,\s*message\s*\)\s*=>\s*app\.log\.warn\(fields,\s*message\)/,
    );
  });
});
