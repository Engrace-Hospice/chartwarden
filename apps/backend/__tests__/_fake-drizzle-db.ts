// A scripted stand-in for the Drizzle `db` handle, for unit tests of services that only run
// `withOrgContext(db, actor, tx => ...)` and chain builders (`select().from().where()...`, `insert().values()`,
// `update().set().where()`). Every builder call returns the same thenable chain; awaiting it consumes the next
// scripted result for that statement kind, and `values` / `set` / `from` arguments are recorded so a test can
// assert exactly what the service wrote. It proves service logic, not SQL: RLS and constraints need a live suite.
import type { DbClient } from "@chartwarden/db";

export type StatementKind = "select" | "insert" | "update" | "delete";

export interface RecordedStatement {
  readonly kind: StatementKind;
  table: unknown;
  values?: unknown;
  set?: unknown;
}

/** A scripted result: rows, or a function of the recorded statement (so an insert can echo its values). */
export type ScriptedResult = unknown | ((statement: RecordedStatement) => unknown);

export interface FakeDb {
  readonly db: DbClient;
  readonly statements: readonly RecordedStatement[];
  /** Statements of `kind` that targeted `table`, in order. */
  of(kind: StatementKind, table: unknown): RecordedStatement[];
}

export function createFakeDb(
  script: Partial<Record<StatementKind, readonly ScriptedResult[]>> = {},
): FakeDb {
  const statements: RecordedStatement[] = [];
  const queues: Record<StatementKind, ScriptedResult[]> = {
    select: [...(script.select ?? [])],
    insert: [...(script.insert ?? [])],
    update: [...(script.update ?? [])],
    delete: [...(script.delete ?? [])],
  };

  const settle = (statement: RecordedStatement): unknown => {
    const next = queues[statement.kind].shift();
    if (next === undefined) return [];
    return typeof next === "function"
      ? (next as (s: RecordedStatement) => unknown)(statement)
      : next;
  };

  const chain = (statement: RecordedStatement): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => settle(statement))
              .then(resolve, reject);
        }
        if (prop === "values") {
          return (v: unknown) => {
            statement.values = v;
            return proxy;
          };
        }
        if (prop === "from") {
          return (t: unknown) => {
            statement.table = t;
            return proxy;
          };
        }
        if (prop === "set") {
          return (v: unknown) => {
            statement.set = v;
            return proxy;
          };
        }
        return () => proxy;
      },
    };
    const proxy: object = new Proxy({}, handler);
    return proxy;
  };

  const begin = (kind: StatementKind) => (table?: unknown) => {
    const statement: RecordedStatement = { kind, table };
    statements.push(statement);
    return chain(statement);
  };

  const tx = {
    execute: async () => [],
    select: begin("select"),
    insert: begin("insert"),
    update: begin("update"),
    delete: begin("delete"),
  };

  return {
    db: {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as DbClient,
    statements,
    of: (kind, table) => statements.filter((s) => s.kind === kind && s.table === table),
  };
}
