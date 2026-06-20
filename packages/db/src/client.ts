// @wardenx/db — production Postgres client factory (M1 infra, AUTH-T01, ADR-0033).
//
// The ONE place a pooled `pg` client + Drizzle handle is constructed. The composition root
// (apps/backend/src/index.ts) builds it from DATABASE_URL and injects it where a real DB is needed
// (Better Auth at AUTH-T02, repositories, withOrgContext). Slice/tests inject nothing, so the host
// still boots infra-free — the unit suite never opens a connection. The pool is lazy: no connection
// is established until the first query, so constructing a client is side-effect-free.
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema/index";

export type Schema = typeof schema;

/** Drizzle handle bound to the WardenX schema. */
export type DbClient = NodePgDatabase<Schema>;

export interface DbClientHandle {
  readonly db: DbClient;
  readonly pool: Pool;
  /** Close the pool (graceful shutdown / test teardown). */
  close(): Promise<void>;
}

export interface CreateDbClientOptions {
  /** Postgres connection string (DATABASE_URL). Required — fail-closed when absent. */
  connectionString: string;
  /** Max pool connections (default 10). */
  max?: number;
  /** Extra pg pool config (TLS, statement/idle timeouts) for production. */
  pool?: Omit<PoolConfig, "connectionString" | "max">;
}

/** Construct the pooled production DB client. Does not connect until the first query. */
export function createDbClient(opts: CreateDbClientOptions): DbClientHandle {
  if (!opts.connectionString) {
    throw new Error("createDbClient: connectionString (DATABASE_URL) is required");
  }
  const pool = new Pool({ connectionString: opts.connectionString, max: opts.max ?? 10, ...opts.pool });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
