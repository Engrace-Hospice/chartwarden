// Slice 2 (tenant pricing) - the hourly statement SWEEP spends platform transactions deliberately. Every `platformRunner` call is an
// audited cross-tenant bypass (a CRITICAL `platform.bypass_invoked` row), so the sweep makes ONE call to read every org's facts and opens
// a write transaction only for an org that has something to compute. No database: the facts loader is replaced, the runner counts calls,
// and the write transaction is a sentinel that fails on its first statement (the per-org advisory lock).
import type { PseudonymKeyProvider } from "@chartwarden/subscription-billing";
import type { NetCollectionsReader } from "@chartwarden/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeDailyCensus, recordDailyCensusBatch } from "../pricing/census-daily";
import type { GoLiveReader, WriteTx } from "../pricing/ports";
import { loadContractFacts, loadContractFactsByOrg } from "../pricing/statement-inputs";
import { liveWindowsOf } from "../pricing/statement-period";
import type { ContractFacts, ExistingStatement } from "../pricing/statement-plan";
import {
  type StatementDeps,
  runStatementSweep,
  runStatementsForOrg,
} from "../pricing/statement-service";

vi.mock("../pricing/statement-inputs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pricing/statement-inputs")>()),
  loadContractFactsByOrg: vi.fn(),
  loadContractFacts: vi.fn(),
}));

const d = (iso: string) => new Date(iso);
const NOW = d("2026-11-20T12:00:00Z");
const WRITE_TX_REFUSED = new Error("sentinel: the write transaction was opened");

const settled = (organizationId: string, periodYearMonth: string): ExistingStatement => ({
  id: `${organizationId}-${periodYearMonth}`,
  periodYearMonth,
  status: "final",
  netCollectionsCents: 0,
  netCollectionsRemittanceCount: 0,
  billingServiceMode: "billing_software",
  billingBps: 100,
  priorPeriodLines: [],
  figures: "",
});

/** A subscription canceled on 2026-03-10 whose March statement is final: November is only a settlement candidate with nothing to carry. */
const canceledAndSettled = (organizationId: string): ContractFacts => ({
  organizationId,
  subscriptionId: `${organizationId}-sub`,
  contractId: `${organizationId}-contract`,
  planId: "plan-1",
  currencyCode: "USD",
  implementationFeeCents: 0,
  pricing: {
    perUserPriceCents: 10_000,
    bands: [{ minAdc: 0, monthlyFeeCents: 100_000 }],
    billingSoftwareBps: 100,
    managedBillingBps: 400,
    minimumMonthlyCents: null,
  },
  modeHistory: [
    {
      id: "mode-initial",
      billingServiceMode: "billing_software",
      effectiveFrom: "2026-01-01",
      createdAt: d("2026-01-01T00:00:00Z"),
    },
  ],
  liveFrom: d("2026-01-01T00:00:00Z"),
  windows: liveWindowsOf({
    liveFrom: d("2026-01-01T00:00:00Z"),
    endedAt: d("2026-03-10T00:00:00Z"),
    pauses: [],
  }),
  statements: ["2026-01", "2026-02", "2026-03"].map((m) => settled(organizationId, m)),
});

/** A live subscription: November is a regular month, so a write transaction is warranted. */
const liveOrg = (organizationId: string): ContractFacts => ({
  ...canceledAndSettled(organizationId),
  windows: liveWindowsOf({ liveFrom: d("2026-01-01T00:00:00Z"), endedAt: null, pauses: [] }),
  statements: [],
});

function harness() {
  let runnerCalls = 0;
  const netReads: string[] = [];
  const log = vi.fn<(message: string, detail: Record<string, unknown>) => void>();
  const deps: StatementDeps = {
    platformRunner: async (fn) => {
      runnerCalls += 1;
      return fn({
        execute: () => {
          throw WRITE_TX_REFUSED;
        },
      } as unknown as WriteTx);
    },
    keyProvider: {} as PseudonymKeyProvider,
    netCollections: {
      netCollectionsByMonth: async (organizationId: string) => {
        netReads.push(organizationId);
        return [];
      },
    } as unknown as NetCollectionsReader,
    goLive: { goLiveAt: async () => null } satisfies GoLiveReader,
    now: () => NOW,
    log,
  };
  return { deps, log, runnerCalls: () => runnerCalls, netReads };
}

const orgIds = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
const byOrg = (facts: ContractFacts[]) =>
  new Map<string, ContractFacts[] | null>(facts.map((f) => [f.organizationId, [f]]));

describe("runStatementSweep: platform transactions are audited bypasses", () => {
  beforeEach(() => {
    vi.mocked(loadContractFactsByOrg).mockReset();
    vi.mocked(loadContractFacts).mockReset();
  });

  it("a sweep over many orgs with nothing left to compute issues ONE platform call in total", async () => {
    const h = harness();
    vi.mocked(loadContractFactsByOrg).mockResolvedValue(
      byOrg(orgIds(12, "settled").map(canceledAndSettled)),
    );

    await runStatementSweep(h.deps);

    expect(h.runnerCalls()).toBe(1); // the one read of every org's facts; no org opened a write transaction
    expect(h.netReads).toHaveLength(12); // each org's collections are still read (under its own RLS, not a bypass)
    expect(vi.mocked(loadContractFacts)).not.toHaveBeenCalled(); // and no org's facts were read a second time
    expect(h.log).not.toHaveBeenCalled();
  });

  it("an org step (the outside-mode backstop) wraps every swept org's statement and costs the sweep no platform call", async () => {
    const h = harness();
    vi.mocked(loadContractFactsByOrg).mockResolvedValue(
      byOrg(orgIds(3, "settled").map(canceledAndSettled)),
    );
    const calls: string[] = [];

    await runStatementSweep(h.deps, async (organizationId, statement) => {
      calls.push(`before:${organizationId}`);
      await statement(organizationId);
      calls.push(`after:${organizationId}`);
    });

    expect(calls).toEqual([
      "before:settled-1",
      "after:settled-1",
      "before:settled-2",
      "after:settled-2",
      "before:settled-3",
      "after:settled-3",
    ]);
    expect(h.netReads).toEqual(["settled-1", "settled-2", "settled-3"]); // each statement ran inside its step
    expect(h.runnerCalls()).toBe(1); // still the one shared read
    expect(vi.mocked(loadContractFacts)).not.toHaveBeenCalled();
  });

  it("an org with an open month costs a write transaction; the others still cost none", async () => {
    const h = harness();
    vi.mocked(loadContractFactsByOrg).mockResolvedValue(
      byOrg([...orgIds(5, "settled").map(canceledAndSettled), liveOrg("live-1")]),
    );

    await expect(runStatementSweep(h.deps)).rejects.toBeInstanceOf(AggregateError);

    expect(h.runnerCalls()).toBe(2); // the read + the ONE org with work (its write transaction fails on the sentinel)
  });

  it("each org with work gets its own write transaction and one org's failure does not stop the next", async () => {
    const h = harness();
    vi.mocked(loadContractFactsByOrg).mockResolvedValue(byOrg(orgIds(3, "live").map(liveOrg)));

    const failure = await runStatementSweep(h.deps).then(
      () => null,
      (e: unknown) => e,
    );

    expect(h.runnerCalls()).toBe(1 + 3);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    // every failing org is logged with its id and the error under `err` (the logger's PHI-safe serializer), never a message string
    expect(h.log).toHaveBeenCalledTimes(3);
    for (const [, detail] of h.log.mock.calls) {
      expect(detail).toMatchObject({ err: WRITE_TX_REFUSED });
      expect(detail).not.toHaveProperty("error");
    }
    expect(h.log.mock.calls.map(([, detail]) => detail.organizationId).sort()).toEqual([
      "live-1",
      "live-2",
      "live-3",
    ]);
  });

  it("an org whose facts could not be loaded in the shared read is read again on its own, where the error is raised", async () => {
    const h = harness();
    vi.mocked(loadContractFactsByOrg).mockResolvedValue(new Map([["broken", null]]));
    vi.mocked(loadContractFacts).mockRejectedValue(new Error("the contracted plan has no prices"));

    await expect(runStatementSweep(h.deps)).rejects.toBeInstanceOf(AggregateError);

    expect(h.runnerCalls()).toBe(2); // the shared read + this org's own read
    expect(vi.mocked(loadContractFacts)).toHaveBeenCalledTimes(1);
  });

  it("one org that could not be read does not stop the others: they are still processed, and only that org is reported", async () => {
    const h = harness();
    vi.mocked(loadContractFactsByOrg).mockResolvedValue(
      new Map<string, ContractFacts[] | null>([
        ["broken", null],
        ["settled-1", [canceledAndSettled("settled-1")]],
        ["settled-2", [canceledAndSettled("settled-2")]],
      ]),
    );
    vi.mocked(loadContractFacts).mockRejectedValue(new TypeError("odd data"));

    const failure = await runStatementSweep(h.deps).then(
      () => null,
      (e: unknown) => e,
    );

    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(h.netReads.sort()).toEqual(["settled-1", "settled-2"]); // both healthy orgs were processed
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0]?.[1]).toMatchObject({ organizationId: "broken" });
  });

  it("runStatementsForOrg given the facts opens no platform transaction when there is nothing to write", async () => {
    const h = harness();
    const outcomes = await runStatementsForOrg(h.deps, "settled-1", [
      canceledAndSettled("settled-1"),
    ]);
    expect(h.runnerCalls()).toBe(0);
    expect(outcomes).toEqual([
      { outcome: "skipped", periodYearMonth: "2026-11", reason: "no_prior_period" },
    ]);
  });
});

describe("the daily census sweep writes its orgs' counts in ONE platform transaction", () => {
  /** A transaction whose every select answers with the given live contracts and which records each insert's values. */
  function recordingTx(liveOrgIds: readonly string[]) {
    const inserted: Record<string, unknown>[] = [];
    const chain = (rows: unknown[]): unknown => {
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, prop) =>
          prop === "then" ? (resolve: (v: unknown) => void) => resolve(rows) : () => proxy,
        apply: () => proxy,
      });
      return proxy;
    };
    const tx = {
      select: () => chain(liveOrgIds.map((organizationId) => ({ contract: { organizationId } }))),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return chain([]);
        },
      }),
    } as unknown as WriteTx;
    return { tx, inserted };
  }

  it("N observations are one runner call; an org with no live contract is reported, not recorded", async () => {
    const { tx, inserted } = recordingTx(["a", "b", "c"]);
    let runnerCalls = 0;
    const platformRunner = async <T>(fn: (t: WriteTx) => Promise<T>): Promise<T> => {
      runnerCalls += 1;
      return fn(tx);
    };
    const observe = (organizationId: string, count: number) =>
      observeDailyCensus(
        { census: { activePatientCount: async () => count }, now: () => NOW },
        organizationId,
      );

    const results = await recordDailyCensusBatch({ platformRunner, now: () => NOW }, [
      await observe("a", 11),
      await observe("b", 12),
      await observe("canceled", 13),
      await observe("c", 14),
    ]);

    expect(runnerCalls).toBe(1);
    expect(results.map((r) => r.recorded)).toEqual([true, true, false, true]);
    expect(inserted.map((v) => [v.organizationId, v.activePatientCount, v.censusDate])).toEqual([
      ["a", 11, "2026-11-20"],
      ["b", 12, "2026-11-20"],
      ["c", 14, "2026-11-20"],
    ]);
  });

  it("no observations, no platform transaction", async () => {
    let runnerCalls = 0;
    const platformRunner = async <T>(fn: (t: WriteTx) => Promise<T>): Promise<T> => {
      runnerCalls += 1;
      return fn({} as WriteTx);
    };
    expect(await recordDailyCensusBatch({ platformRunner }, [])).toEqual([]);
    expect(runnerCalls).toBe(0);
  });
});
