// A draft read that `guarded` abandoned at its time bound is not cancelled (a seam has no cancel), so a multi-step store read (`loadSelection`: the
// selection, the fall, the ADLs, the nutrition) can still issue its NEXT query after the request's transaction has ended, on a pooled connection that
// by then belongs to another request, where it can abort that request's transaction (25P02). The transaction lease closes that: once the draft's unit
// of work is over, a query started through the leased client throws instead of running. Fake clients only; no database.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { createDbDraftStore } from "../src/modules/08-encounters/drafting/db-draft-store";
import { leaseTransaction } from "../src/modules/08-encounters/drafting/transaction-lease";
import { NOW, encounter } from "./_encounter-draft-fixtures";

/** A client whose `select` counts the queries started and whose FIRST query stays open until `release` is called. */
function stalledClient() {
  const state = { started: 0 };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = {
    marker: "kept",
    select() {
      state.started += 1;
      const first = state.started === 1;
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => {
          if (first) await gate;
          return [];
        },
      };
      return chain;
    },
  };
  return { state, release, db: db as unknown as DbClient };
}

describe("a transaction lease", () => {
  it("passes every call through while the lease is open, on the real client", () => {
    const calls: unknown[] = [];
    const real = {
      value: 7,
      select(this: unknown, ...args: unknown[]) {
        calls.push(this, ...args);
        return "a query";
      },
    };
    const lease = leaseTransaction(real as unknown as DbClient);

    expect((lease.db as unknown as typeof real).select("x")).toBe("a query");
    expect(calls).toEqual([real, "x"]);
    expect((lease.db as unknown as typeof real).value).toBe(7);
  });

  it("refuses a query started after the lease is closed, naming the cause and not the data", () => {
    const real = { select: () => "a query" };
    const lease = leaseTransaction(real as unknown as DbClient);
    lease.close();

    expect(() => (lease.db as unknown as typeof real).select()).toThrow(
      "a draft read after its transaction closed",
    );
  });

  it("closing twice is harmless and a query already started is left alone", async () => {
    const stalled = stalledClient();
    const lease = leaseTransaction(stalled.db);
    const pending = (
      lease.db.select() as unknown as { limit: (n: number) => Promise<unknown[]> }
    ).limit(1);

    lease.close();
    lease.close();
    stalled.release();

    await expect(pending).resolves.toEqual([]);
  });

  it("stops a store read abandoned at its time bound before it issues its next query", async () => {
    const stalled = stalledClient();
    const lease = leaseTransaction(stalled.db);
    const store = createDbDraftStore(lease.db, { now: NOW });

    // The first query is open (the read is stuck mid-way); the unit of work ends and the transaction goes back to the pool.
    const abandoned = store.loadSelection(
      encounter({ encounterType: "routine_visit", discipline: "rn" }),
    );
    lease.close();
    stalled.release();

    await expect(abandoned).rejects.toThrow("a draft read after its transaction closed");
    expect(stalled.state.started).toBe(1);
  });
});
