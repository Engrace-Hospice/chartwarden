import { describe, expect, it } from "vitest";
import {
  collectQueueDeclarations,
  findQueueCollisions,
  ownerOf,
  queueNamesIn,
} from "../check-queue-names";

describe("check-queue-names", () => {
  it("reads catalog entries, single constants and dlq names, ignoring params and references", () => {
    const src = `
      export const FOO_QUEUES = {
        a: "foo.a", // comment
        b: "foo.b",
      } as const;
      export const FOO_QUEUE_PARAMS = { a: { concurrency: 4, backoffType: "exponential" } };
      const BAR_QUEUE = "bar.q";
      export const OLD_QUEUE = "legacy-name"; // queue-names:reference
      const P = { dlq: "foo.a.dlq" };
    `;
    expect(queueNamesIn(src).sort()).toEqual(["bar.q", "foo.a", "foo.a.dlq", "foo.b"]);
  });

  it("flags a name declared by two owners and allows repeats inside one owner", () => {
    const d = (name: string, owner: string) => ({ name, owner, file: `${owner}/x.ts` });
    expect(
      findQueueCollisions([
        d("validation-run", "module:23-billing-medicare"),
        d("validation-run", "module:27-cost-report"),
        d("same.owner", "module:1"),
        d("same.owner", "module:1"),
      ]).map((c) => c.name),
    ).toEqual(["validation-run"]);
  });

  it("derives owners from module and package paths", () => {
    expect(ownerOf("apps/backend/src/modules/23-billing-medicare/jobs/queues.ts")).toBe(
      "module:23-billing-medicare",
    );
    expect(ownerOf("packages/audit/src/jobs/queues.ts")).toBe("package:audit");
  });

  it("finds no cross-owner collision in the real tree (and the scanner still sees the catalogs)", () => {
    const declarations = collectQueueDeclarations();
    expect(new Set(declarations.map((x) => x.name)).size).toBeGreaterThan(80);
    expect(findQueueCollisions(declarations)).toEqual([]);
    const names = new Set(declarations.map((x) => x.name));
    expect(names.has("m23.validation-run")).toBe(true);
    expect(names.has("validation-run")).toBe(true);
  });
});
