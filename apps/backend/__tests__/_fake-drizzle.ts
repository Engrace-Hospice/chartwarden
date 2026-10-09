// A recording fake of the Drizzle select / insert / update chains inside `withOrgContext` — enough for
// pipeline-style code that issues plain statements, without a database. `rowsByTable` programs what a select — and an insert/update `returning()` — resolves to, keyed by table name; inserts and updates are recorded.
import type { DbClient } from "@wardenx/db";

export interface Recorded {
  readonly inserts: Array<{ table: string; values: Record<string, unknown> }>;
  readonly updates: Array<{ table: string; set: Record<string, unknown> }>;
}

function tableNameOf(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) =>
    String(s).includes("drizzle:Name"),
  );
  return String((table as Record<symbol, unknown>)[sym as symbol]);
}

export type FakeRows = unknown[] | ((op: "select" | "insert" | "update") => unknown[]);

export function fakeDb(rowsByTable: Record<string, FakeRows>): { db: DbClient; rec: Recorded } {
  const rec: Recorded = { inserts: [], updates: [] };
  const rowsFor = (table: unknown, op: "select" | "insert" | "update"): unknown[] => {
    const rows = rowsByTable[tableNameOf(table)];
    return typeof rows === "function" ? rows(op) : (rows ?? []);
  };
  const thenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      where: () => chain,
      innerJoin: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      returning: () => chain,
      onConflictDoNothing: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: a deliberate thenable stand-in for an awaited Drizzle query
      then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
    };
    return chain;
  };
  const tx = {
    execute: async () => [],
    select: () => ({ from: (t: unknown) => thenable(rowsFor(t, "select")) }),
    insert: (t: unknown) => ({
      values: (v: Record<string, unknown>) => {
        rec.inserts.push({ table: tableNameOf(t), values: v });
        return thenable(rowsFor(t, "insert"));
      },
    }),
    update: (t: unknown) => ({
      set: (v: Record<string, unknown>) => {
        rec.updates.push({ table: tableNameOf(t), set: v });
        return thenable(rowsFor(t, "update"));
      },
    }),
  };
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return { db: db as unknown as DbClient, rec };
}
