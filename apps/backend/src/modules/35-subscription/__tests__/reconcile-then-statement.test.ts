// The hourly statement sweep applies "a tenant that bills outside ChartWarden pays no billing percentage" again before it computes a
// statement (the wizard's sync is best effort), and a reconcile that fails never blocks the statement.
import { describe, expect, it } from "vitest";
import { reconcileThenStatement } from "../billing-runtime/workers";

describe("reconcileThenStatement", () => {
  it("reconciles the org first, then computes its statement", async () => {
    const calls: string[] = [];
    await reconcileThenStatement(
      async (org) => void calls.push(`reconcile:${org}`),
      undefined,
      async (org) => void calls.push(`statement:${org}`),
      "org-1",
    );
    expect(calls).toEqual(["reconcile:org-1", "statement:org-1"]);
  });

  it("logs a failed reconcile and still computes the statement (the next hourly sweep tries the reconcile again)", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const calls: string[] = [];
    let attempt = 0;
    const reconcile = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("pricing is unavailable");
    };
    const statement = async (org: string) => void calls.push(`statement:${org}`);
    const log = (message: string, detail: Record<string, unknown>) =>
      void logs.push([message, detail]);

    await reconcileThenStatement(reconcile, log, statement, "org-1");
    expect(calls).toEqual(["statement:org-1"]);
    expect(logs).toHaveLength(1);
    // the error itself goes under `err` (the logger redacts that key); a hand-built `error: message` would carry a driver error's bound values
    expect(logs[0]?.[1]).toMatchObject({
      organizationId: "org-1",
      err: expect.objectContaining({ message: "pricing is unavailable" }),
    });
    expect(logs[0]?.[1]).not.toHaveProperty("error");

    // the first call failed and a later one succeeds: the second sweep goes through, and logs nothing more
    await reconcileThenStatement(reconcile, log, statement, "org-1");
    expect(attempt).toBe(2);
    expect(logs).toHaveLength(1);
    expect(calls).toEqual(["statement:org-1", "statement:org-1"]);
  });

  it("is only the statement when no reconcile is bound", async () => {
    const calls: string[] = [];
    await reconcileThenStatement(
      undefined,
      undefined,
      async (org) => void calls.push(org),
      "org-1",
    );
    expect(calls).toEqual(["org-1"]);
  });
});
