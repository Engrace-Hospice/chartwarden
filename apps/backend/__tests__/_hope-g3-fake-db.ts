// A scripted fake database for the M10 lock / re-judging unit tests (group g3): no Postgres. Every `select` / `update` /
// `insert` chain consumes the next scripted outcome (rows, or an Error to reject with); an exhausted script rejects with
// "script exhausted" so a test stops the code under test at a known point. Every statement is recorded in order, with the
// SQL a `where` / `execute` rendered to, so a test can assert WHAT was asked and in WHICH order, not only the result.
import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

export interface RenderedSql {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export const renderSql = (statement: unknown): RenderedSql =>
  dialect.sqlToQuery(statement as Parameters<PgDialect["sqlToQuery"]>[0]);

export type Outcome = readonly unknown[] | Error;

export interface RecordedStatement {
  readonly kind: "execute" | "select" | "update" | "insert";
  /** The rendered SQL of an `execute`, or of the `where` of a chain (absent until `where` is called). */
  readonly rendered?: RenderedSql;
  /**
   * The keys of the field map a `select({...})` or `returning({...})` named; absent for the whole-row form (`select()`,
   * `returning()`), so a test can assert that a statement did NOT read or return a heavy column.
   */
  readonly columns?: readonly string[];
}

/** The point a scripted run stops at: every statement past the script. */
export const SCRIPT_EXHAUSTED = "script exhausted";

const CHAIN_METHODS = [
  "from",
  "where",
  "limit",
  "for",
  "orderBy",
  "innerJoin",
  "leftJoin",
  "set",
  "values",
  "returning",
  "groupBy",
  "onConflictDoUpdate",
  "onConflictDoNothing",
] as const;

export function scriptedDb(outcomes: readonly Outcome[]) {
  const statements: RecordedStatement[] = [];
  let call = 0;

  const fieldKeys = (fields: unknown): readonly string[] | undefined =>
    fields !== null && typeof fields === "object" ? Object.keys(fields) : undefined;

  const chain = (kind: RecordedStatement["kind"], fields?: unknown) => {
    const slot: { -readonly [K in keyof RecordedStatement]: RecordedStatement[K] } = { kind };
    const selected = fieldKeys(fields);
    if (selected) slot.columns = selected;
    statements.push(slot);
    const outcome = outcomes[call++] ?? new Error(SCRIPT_EXHAUSTED);
    const link: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a Drizzle query chain is awaited at its last link
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        outcome instanceof Error ? reject(outcome) : resolve(outcome),
    };
    for (const name of CHAIN_METHODS) {
      link[name] = (argument?: unknown) => {
        if (name === "where" && argument !== undefined) slot.rendered = renderSql(argument);
        if (name === "returning") {
          const returned = fieldKeys(argument);
          if (returned) slot.columns = returned;
        }
        return link;
      };
    }
    return link;
  };

  const tx = {
    execute: async (statement: unknown) => {
      statements.push({ kind: "execute", rendered: renderSql(statement) });
    },
    select: (fields?: unknown) => chain("select", fields),
    update: () => chain("update"),
    insert: () => chain("insert"),
    // A savepoint, and the HOPE transaction itself: run the callback on this same fake.
    transaction: async (fn: (inner: unknown) => Promise<unknown>) => fn(tx),
  };
  const db = { transaction: async (fn: (inner: unknown) => Promise<unknown>) => fn(tx) };

  return {
    db: db as unknown as DbClient,
    tx: tx as unknown as DbClient,
    statements,
    /** The index of the first statement of `kind` whose rendered SQL contains `text` (-1 when none). */
    indexOf: (kind: RecordedStatement["kind"], text?: string): number =>
      statements.findIndex(
        (statement) =>
          statement.kind === kind &&
          (text === undefined || (statement.rendered?.sql ?? "").includes(text)),
      ),
  };
}
