// @chartwarden/db — production Postgres client factory (M1 infra, AUTH-T01, ADR-0033).
//
// The ONE place a pooled `pg` client + Drizzle handle is constructed. The composition root
// (apps/backend/src/index.ts) builds it from DATABASE_URL and injects it where a real DB is needed
// (Better Auth at AUTH-T02, repositories, withOrgContext). Slice/tests inject nothing, so the host
// still boots infra-free — the unit suite never opens a connection. The pool is lazy: no connection
// is established until the first query, so constructing a client is side-effect-free.
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { instrumentPoolForCommits } from "./commit-tracker";
import * as schema from "./schema/index";

export type Schema = typeof schema;

/** Drizzle handle bound to the ChartWarden schema. */
export type DbClient = NodePgDatabase<Schema>;

export interface DbClientHandle {
  readonly db: DbClient;
  readonly pool: Pool;
  /** Close the pool (graceful shutdown / test teardown). */
  close(): Promise<void>;
}

/** The deliberately small, PHI-free connection-error shape exposed to the host logger. */
export interface DbConnectionError {
  readonly source: "pool" | "checked_out_client";
  readonly sqlState: string | null;
  readonly message: string;
}

export interface CreateDbClientOptions {
  /** Postgres connection string (DATABASE_URL). Required — fail-closed when absent. */
  connectionString: string;
  /** Max pool connections (default 10). */
  max?: number;
  /** Extra pg pool config (TLS, statement/idle timeouts) for production. */
  pool?: Omit<PoolConfig, "connectionString" | "max">;
  /** Structured connection-error sink. Sink failures are contained by the factory. */
  onConnectionError?: (error: DbConnectionError) => void;
}

function connectionError(source: DbConnectionError["source"], error: Error): DbConnectionError {
  const code = (error as Error & { readonly code?: unknown }).code;
  return {
    source,
    sqlState: typeof code === "string" && code.length > 0 ? code : null,
    message: error.message,
  };
}

/**
 * How long a caller waits for a free pool connection before failing (ms).
 *
 * `pg` defaults this to 0 = WAIT FOREVER, which is what turned a pool-exhaustion bug into an
 * unrecoverable outage: M36's `syncCareTeamChannel` needed two simultaneous connections per call
 * (its own transaction, plus the one the M5 seam opened inside it), so ten concurrent portal reads
 * held all ten connections and each waited on an eleventh that could never come. Nothing errored,
 * nothing logged, and every other request in the process queued behind it until restart.
 *
 * A bounded wait does NOT fix that class of bug — the nested call sites are being unpicked one by
 * one — but it converts a silent permanent hang into a loud, recoverable error with a stack trace
 * pointing at the caller. Ten seconds is far longer than any healthy acquisition and far shorter
 * than "forever".
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Construct the pooled production DB client. Does not connect until the first query. */
export function createDbClient(opts: CreateDbClientOptions): DbClientHandle {
  if (!opts.connectionString) {
    throw new Error("createDbClient: connectionString (DATABASE_URL) is required");
  }
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    ...opts.pool,
  });
  // Every query of every pooled client feeds the ambient per-request commit tracker (commit-tracker.ts): the idempotency
  // middleware releases a retryable failure only when this request committed nothing. A no-op outside a tracked request.
  instrumentPoolForCommits(pool as unknown as Parameters<typeof instrumentPoolForCommits>[0]);
  const report = (source: DbConnectionError["source"], error: Error): void => {
    const safe = connectionError(source, error);
    try {
      if (opts.onConnectionError) opts.onConnectionError(safe);
      else console.warn("Postgres connection error", safe);
    } catch {
      // An observability sink must never turn a recoverable connection loss back into an uncaught EventEmitter error.
      try {
        console.warn("Postgres connection error (configured sink failed)", safe);
      } catch {
        // There is deliberately no final throw: keeping the process alive is this handler's safety boundary.
      }
    }
  };

  // pg forwards errors from IDLE clients to the pool. Without this listener EventEmitter throws and terminates Node.
  pool.on("error", (error) => report("pool", error));

  // While a client is checked out pg removes its idle-error forwarder. Cover exactly that window, then remove our
  // listener on release so an idle failure is reported once through the pool rather than twice.
  const checkedOutListeners = new WeakMap<PoolClient, (error: Error) => void>();
  pool.on("acquire", (client) => {
    if (checkedOutListeners.has(client)) return;
    const listener = (error: Error): void => report("checked_out_client", error);
    checkedOutListeners.set(client, listener);
    client.on("error", listener);
  });
  pool.on("release", (_error, client) => {
    const listener = checkedOutListeners.get(client);
    if (!listener) return;
    client.off("error", listener);
    checkedOutListeners.delete(client);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
