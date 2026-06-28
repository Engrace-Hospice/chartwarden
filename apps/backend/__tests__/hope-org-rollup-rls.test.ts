// #107 item 4a — the Drizzle HOPE org-rollup store self-scopes: every method runs inside its own
// withOrgContext envelope (opens a transaction + sets app.org_id) so the rollup reads are RLS-scoped on the
// rollup connection, not reliant on the (different) M30 worker connection's context.
import { describe, expect, it, vi } from "vitest";
import { createDrizzleHopeOrgRollupStore } from "../src/modules/10-hope/seams/org-rollup-store";

/** A fake DbClient whose `transaction` (the withOrgContext entry) runs the body against a tx returning `rows`. */
function fakeScopedDb(rows: unknown[]) {
  const execute = vi.fn(async () => {}); // the set_config('app.org_id' / 'app.user_id', …) GUC writes
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve(rows),
  };
  const tx = { execute, select: () => chain };
  const transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return { execute, transaction, db: { transaction } as never };
}

const ORG = "org-1";
const PERIOD = { from: "2026-01-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" };

describe("createDrizzleHopeOrgRollupStore — per-method withOrgContext envelope (#107 item 4a)", () => {
  it("opens a withOrgContext transaction + sets the GUCs before reading (openSfvObligationCount)", async () => {
    const { db, transaction, execute } = fakeScopedDb([{ n: 4 }]);
    const store = createDrizzleHopeOrgRollupStore(db);

    const n = await store.openSfvObligationCount(ORG);

    expect(n).toBe(4);
    expect(transaction).toHaveBeenCalledTimes(1); // the only thing that opens a tx here is withOrgContext
    expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2); // app.org_id + app.user_id set_config
  });

  it("scopes the j2051Triggers read and projects entries (the pain/non-pain input)", async () => {
    const { db, transaction } = fakeScopedDb([
      { data: { J: { J2051: { entries: [{ symptomCode: "pain", severity: "severe" }] } } }, sfvDueAt: null, sfvCompletedAt: null },
    ]);
    const store = createDrizzleHopeOrgRollupStore(db);

    const rows = await store.j2051Triggers(ORG, PERIOD);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ entries: [{ symptomCode: "pain", severity: "severe" }], sfvDueAt: null, sfvCompletedAt: null }]);
  });

  it("scopes every period method (each opens its own envelope)", async () => {
    const { db, transaction } = fakeScopedDb([]);
    const store = createDrizzleHopeOrgRollupStore(db);
    await store.completedTimepoints(ORG, PERIOD);
    await store.submissionBatches(ORG, PERIOD);
    await store.terminalSfvs(ORG, PERIOD);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
