// Shared fake transaction for the visit-note closure unit tests (ADR-0113). Every query chain resolves to the next queued
// result (thenable at any depth, like encounter-store-ops.test.ts), and every method call on a chain is logged so a test can
// assert what was inserted, set or filtered. Real RLS, the partial index and the audit trigger are NOT exercised here: those
// belong to the live suite.
import { vi } from "vitest";

export interface RecordedCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

export interface FakeTx {
  /** Pass this where the service takes a `DbClient` transaction. */
  readonly tx: never;
  /** Every chained method call, in order (`select`, `from`, `where`, `insert`, `values`, `update`, `set`, …). */
  readonly calls: readonly RecordedCall[];
  /** The `values(...)` payloads of every insert, in order (the audit insert included). */
  insertedValues(): readonly unknown[];
  /** The `set(...)` payloads of every update, in order. */
  updatedSets(): readonly unknown[];
  /** How many queries ran (each awaited chain consumes one queued result). */
  queriesRun(): number;
}

export function fakeTx(results: readonly (readonly unknown[])[]): FakeTx {
  const queue = [...results];
  const calls: RecordedCall[] = [];
  let queries = 0;
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const rows = queue.shift() ?? [];
            queries += 1;
            return (resolve: (value: unknown) => unknown) => resolve(rows);
          }
          return (...args: unknown[]) => {
            calls.push({ op: String(prop), args });
            return chain();
          };
        },
      },
    );
  const tx = {
    execute: vi.fn(async () => {}),
    select: (...args: unknown[]) => {
      calls.push({ op: "select", args });
      return chain();
    },
    insert: (...args: unknown[]) => {
      calls.push({ op: "insert", args });
      return chain();
    },
    update: (...args: unknown[]) => {
      calls.push({ op: "update", args });
      return chain();
    },
  };
  const argsOf = (op: string): readonly unknown[] =>
    calls.filter((c) => c.op === op).map((c) => c.args[0]);
  return {
    tx: tx as never,
    calls,
    insertedValues: () => argsOf("values"),
    updatedSets: () => argsOf("set"),
    queriesRun: () => queries,
  };
}
