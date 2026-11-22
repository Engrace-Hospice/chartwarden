// apps/backend/src/modules/08-encounters/drafting/transaction-lease.ts — a database client that dies with the unit of work that was lent it.
//
// `guarded` (unavailable.ts) abandons a draft read at its time bound; it cannot cancel it. A store read that is several queries in turn
// (`loadSelection`) would then go on to start its next query after the request's transaction had rolled back and its connection had returned to
// the pool, on a connection that by then belongs to another request, where a query run with no tenant setting aborts that request's transaction
// (25P02, a 500 for an unrelated caller). `settleAll` closes the fast-failure path; the lease closes this one: every call on the leased client
// throws once the unit of work is over, so the leftover read ends at its next step instead of running.
//
// A query already sent when the lease closes is not touched (the transaction's own commit or rollback queues behind it on the connection). Only
// calls through the lease are cut off: a query builder made before the close and run after it is the caller's own, and none of the draft's
// reads does that (each builds its query and awaits it in one expression).
import type { DbClient } from "@chartwarden/db";

/** What a lease hands back: the client to give the draft's store, and the call that ends its life. */
export interface TransactionLease {
  /** The client to hand to the draft's reads and writes: the transaction's own while the lease is open. */
  readonly db: DbClient;
  /** End the lease when the unit of work is over (idempotent). After it, every call on `db` throws. */
  close(): void;
}

/** The reason a late draft read is given: the cause only, no record content. */
export const LEASE_CLOSED_MESSAGE = "a draft read after its transaction closed";

export function leaseTransaction(tx: DbClient): TransactionLease {
  let closed = false;
  const db = new Proxy(tx, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (closed) throw new Error(LEASE_CLOSED_MESSAGE);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return {
    db,
    close: () => {
      closed = true;
    },
  };
}
