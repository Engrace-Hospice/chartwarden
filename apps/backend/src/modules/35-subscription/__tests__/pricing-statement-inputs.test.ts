// Slice 2 (tenant pricing) - the sweep reads EVERY contracted org's facts in one platform transaction, so one org's data must not take
// the others down with it. Each org is read in a savepoint, and whatever fails there (a database error that aborts the statement, a
// domain refusal, a JS error on odd data: anything, not only a ChartWardenError) maps THAT org to null, which the per-org path then reads
// again and fails on, where the sweep logs it with the org's id. No database: the selector and the band loader are replaced and the
// transaction is a recording double whose `transaction` is a savepoint.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectContracts } from "../pricing/contract-select";
import type { WriteTx } from "../pricing/ports";
import { loadContractFactsByOrg } from "../pricing/statement-inputs";

vi.mock("../pricing/contract-select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pricing/contract-select")>()),
  selectContracts: vi.fn(),
  loadModeHistory: vi.fn(async () => new Map()),
}));
vi.mock("../pricing/plan-service", () => ({ loadBands: vi.fn(async () => []) }));

const NOW = new Date("2026-11-20T12:00:00Z");
const GO_LIVE = new Date("2026-11-01T00:00:00Z");

const record = (organizationId: string, perUserPriceCents: number | null = 10_000) => ({
  contract: {
    id: `${organizationId}-contract`,
    organizationId,
    subscriptionId: `${organizationId}-sub`,
    planId: `${organizationId}-plan`,
    contractStartOn: "2026-10-20",
    createdAt: new Date("2026-10-20T00:00:00Z"),
  },
  sub: {
    id: `${organizationId}-sub`,
    status: "active",
    startedAt: new Date("2026-10-20T00:00:00Z"),
    canceledAt: null,
    pausedUntil: null,
    updatedAt: new Date("2026-10-20T00:00:00Z"),
  },
  plan: {
    id: `${organizationId}-plan`,
    currencyCode: "USD",
    perUserPriceCents,
    billingSoftwareBps: 100,
    managedBillingBps: 400,
    implementationFeeCents: 0,
    minimumMonthlyCents: null,
  },
});

/** A transaction whose every select answers with no rows and whose `transaction` is a savepoint that rethrows what fails inside it. */
function savepointTx() {
  let savepoints = 0;
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop) =>
        prop === "then" ? (resolve: (v: unknown[]) => void) => resolve([]) : () => proxy,
      apply: () => proxy,
    });
    return proxy;
  };
  const tx: Record<string, unknown> = { select: () => chain() };
  tx.transaction = async (fn: (t: unknown) => Promise<unknown>) => {
    savepoints += 1;
    return fn(tx);
  };
  return { tx: tx as unknown as WriteTx, savepoints: () => savepoints };
}

describe("loadContractFactsByOrg: one org's failed read does not fail the sweep's single read", () => {
  beforeEach(() => {
    vi.mocked(selectContracts).mockReset();
  });

  it("an org whose read throws a NON-ChartWardenError (a JS error on odd data) is null; the others still get their facts", async () => {
    vi.mocked(selectContracts).mockResolvedValue([
      record("org-a"),
      record("org-b"),
      record("org-c"),
    ] as never);
    const { tx, savepoints } = savepointTx();
    const goLive = {
      goLiveAt: async (_tx: WriteTx, organizationId: string) => {
        if (organizationId === "org-b") throw new TypeError("cannot read properties of undefined");
        return GO_LIVE;
      },
    };

    const facts = await loadContractFactsByOrg(tx, goLive, NOW);

    expect([...facts.keys()]).toEqual(["org-a", "org-b", "org-c"]);
    expect(facts.get("org-b")).toBeNull(); // read again on its own, where the error is raised and logged with the org's id
    expect(facts.get("org-a")).toHaveLength(1);
    expect(facts.get("org-c")).toHaveLength(1);
    expect(savepoints()).toBe(3); // each org in its own savepoint, so an aborted statement cannot poison the next org
  });

  it("a database error inside an org's savepoint is contained the same way", async () => {
    vi.mocked(selectContracts).mockResolvedValue([record("org-a"), record("org-b")] as never);
    const { tx } = savepointTx();
    const goLive = {
      goLiveAt: async (_tx: WriteTx, organizationId: string) => {
        if (organizationId === "org-a") {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return GO_LIVE;
      },
    };
    const facts = await loadContractFactsByOrg(tx, goLive, NOW);
    expect(facts.get("org-a")).toBeNull();
    expect(facts.get("org-b")).toHaveLength(1);
  });

  it("a domain refusal (a contract on a plan with no prices) is null, not a failure of the whole read", async () => {
    vi.mocked(selectContracts).mockResolvedValue([record("org-a", null), record("org-b")] as never);
    const { tx } = savepointTx();
    const facts = await loadContractFactsByOrg(tx, { goLiveAt: async () => GO_LIVE }, NOW);
    expect(facts.get("org-a")).toBeNull();
    expect(facts.get("org-b")).toHaveLength(1);
  });

  it("an org that is not live is left out, not null", async () => {
    vi.mocked(selectContracts).mockResolvedValue([record("org-a"), record("org-b")] as never);
    const { tx } = savepointTx();
    const facts = await loadContractFactsByOrg(
      tx,
      { goLiveAt: async (_tx, org) => (org === "org-a" ? null : GO_LIVE) },
      NOW,
    );
    expect([...facts.keys()]).toEqual(["org-b"]);
  });
});
