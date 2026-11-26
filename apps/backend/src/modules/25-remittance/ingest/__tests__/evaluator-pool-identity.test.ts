import { describe, expect, it } from "vitest";
import { assertEvaluatorPoolIdentity } from "../evaluator-pool-identity";

const executorOf = (row: Record<string, unknown> | undefined) => ({
  execute: async () => ({ rows: row ? [row] : [] }),
});
const QUERY = "synthetic identity query";

describe("evaluator pool identity", () => {
  it("accepts a plain login and the login the pool is expected to use", async () => {
    const row = { name: "synthetic_evaluator_login", rolsuper: false, rolbypassrls: false };
    await expect(
      assertEvaluatorPoolIdentity(executorOf(row), QUERY, "writer", "synthetic_evaluator_login"),
    ).resolves.toBeUndefined();
    await expect(
      assertEvaluatorPoolIdentity(executorOf(row), QUERY, "app"),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a superuser", { rolsuper: true, rolbypassrls: false }],
    ["a BYPASSRLS login", { rolsuper: false, rolbypassrls: true }],
  ])("refuses a pool connected as %s", async (_label, flags) => {
    await expect(
      assertEvaluatorPoolIdentity(executorOf({ name: "synthetic_login", ...flags }), QUERY, "app"),
    ).rejects.toThrow(/must not connect as a superuser or BYPASSRLS login/);
  });

  it("refuses a pool connected as another login than the one expected", async () => {
    const row = { name: "synthetic_other_login", rolsuper: false, rolbypassrls: false };
    await expect(
      assertEvaluatorPoolIdentity(executorOf(row), QUERY, "writer", "synthetic_evaluator_login"),
    ).rejects.toThrow(/writer pool must connect as synthetic_evaluator_login/);
  });

  it("refuses a pool whose identity cannot be read", async () => {
    await expect(
      assertEvaluatorPoolIdentity(executorOf(undefined), QUERY, "source"),
    ).rejects.toThrow(/identity could not be read/);
  });
});
