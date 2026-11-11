// The hourly statement sweep applies "a tenant that bills outside ChartWarden pays no billing percentage" again before it computes a
// statement (the wizard's sync is best effort), and a reconcile that fails never blocks the statement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileOutsideModes,
  reconcileThenStatement,
  runPricingStatementTick,
} from "../billing-runtime/workers";
import { listContractedOrgIds } from "../pricing/contract-select";
import { runStatementSweep } from "../pricing/statement-service";

vi.mock("../pricing/contract-select", () => ({ listContractedOrgIds: vi.fn() }));
vi.mock("../pricing/statement-service", () => ({ runStatementSweep: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

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

describe("reconcileOutsideModes", () => {
  it("visits the full current-contract population, including non-live organizations", async () => {
    const calls: string[] = [];
    await reconcileOutsideModes(
      async (organizationId) => void calls.push(organizationId),
      undefined,
      new Set(["onboarding-org", "paused-org", "live-org"]),
    );
    expect(calls).toEqual(["onboarding-org", "paused-org", "live-org"]);
  });

  it("logs one organization's failure and continues with the rest", async () => {
    const calls: string[] = [];
    const logs: Record<string, unknown>[] = [];
    await reconcileOutsideModes(
      async (organizationId) => {
        calls.push(organizationId);
        if (organizationId === "paused-org") throw new Error("temporary");
      },
      (_message, detail) => logs.push(detail),
      ["paused-org", "onboarding-org"],
    );
    expect(calls).toEqual(["paused-org", "onboarding-org"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId: "paused-org" });
  });
});

describe("runPricingStatementTick", () => {
  it("loads the current-contract population and repairs every org before the statement sweep", async () => {
    const now = new Date("2026-11-10T12:00:00.000Z");
    const platformRunner = vi.fn();
    const reconcile = vi.fn(async (_organizationId: string) => undefined);
    vi.mocked(listContractedOrgIds).mockResolvedValue(new Set(["onboarding-org", "paused-org"]));
    vi.mocked(runStatementSweep).mockResolvedValue(undefined);

    await runPricingStatementTick(
      { platformRunner, now: () => now } as never,
      {
        reconcileOutsideMode: reconcile,
        keyProvider: {},
        netCollections: {},
        goLive: {},
        census: {},
      } as never,
    );

    expect(listContractedOrgIds).toHaveBeenCalledWith(platformRunner, "current", now);
    expect(reconcile.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      "onboarding-org",
      "paused-org",
    ]);
    expect(runStatementSweep).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(runStatementSweep).mock.invocationCallOrder[0] ?? 0,
    );
  });
});
