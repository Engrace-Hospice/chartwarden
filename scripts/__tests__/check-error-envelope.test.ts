import { describe, expect, it } from "vitest";
import { findFlatErrorBodies, scanRepo } from "../check-error-envelope";

describe("arch:error-envelope", () => {
  it("flags a flat { error: 'x' } body", () => {
    const hits = findFlatErrorBodies("a.ts", 'return reply.code(400).send({ error: "bad" });');
    expect(hits).toHaveLength(1);
  });
  it("flags a bare { code, message } body across lines", () => {
    const hits = findFlatErrorBodies("a.ts", 'x\nreply.code(404).send({\n code: "NOT_FOUND" });');
    expect(hits).toEqual([{ file: "a.ts", line: 2 }]);
  });
  it("does not flag the enveloped shape or success bodies", () => {
    expect(findFlatErrorBodies("a.ts", "reply.send({ error: { code: 'X' } });")).toEqual([]);
    expect(findFlatErrorBodies("a.ts", "reply.send({ received: true });")).toEqual([]);
  });
  it("finds no offender in the tree", () => {
    expect(scanRepo()).toEqual([]);
  });
});
