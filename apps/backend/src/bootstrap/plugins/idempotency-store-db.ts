// apps/backend/src/bootstrap — the Postgres-backed IdempotencyStore (M1 §3.10).
//
// Replaces `createInMemoryIdempotencyStore()` on the production mount. That default was never
// overridden by the composition root, so every `Idempotency-Key` lived in a process-local Map:
//   * a client retry that landed on a DIFFERENT replica re-ran the mutation, because replica B had
//     never heard of the key — which is the precise failure an Idempotency-Key exists to prevent;
//   * a restart erased every record, so a retry after a deploy re-ran too;
//   * the `idempotency_key` table stayed empty while looking like the system of record.
// The write surfaces that REQUIRE the header (M23 claim submit, M26 settlement finalize, M30) are the
// ones where a duplicate is a duplicated claim or a duplicated settlement, not a cosmetic repeat.
//
// ATOMICITY is the whole contract: `putPending` is the claim and RETURNS whether it won, so two
// concurrent duplicates serialize. That is delegated to Postgres via the `idempotency_org_key_idx`
// UNIQUE index and `ON CONFLICT DO UPDATE ... WHERE expires_at <= now() RETURNING id` — the loser gets
// zero rows back (GAP-007), reloads, and sees the winner's `pending` row (in-flight 409) or its
// completed response (replay); an EXPIRED row is reclaimed in the same statement. A read-then-write
// would let both through.
//
// RLS: every statement is org-scoped through `withOrgContext`, so a tenant can only ever see or claim
// its own keys — the `idempotency_key_org` policy (0001) is a plain `app.org_id` match.
//
// A BODILESS RESPONSE IS A REAL RESPONSE (F-073, #182). 24 routes answer `code(204)`, and the web
// client attaches an `Idempotency-Key` to every mutating request, so all 24 reached `complete` with
// `body: undefined`. Drizzle OMITS undefined keys from a `.set()`, so `response_body` was never named
// in the UPDATE, stayed SQL NULL, and tripped `idempotency_key_complete_has_response` — after the
// handler had committed, so the client got a 500 for a write that had already happened and the key was
// left `pending`, answering 409 to every retry for its 24h TTL. Migration 0232 relaxes the constraint
// (a complete row must carry its STATUS; a 204 genuinely has no body); this file stops relying on
// Drizzle's undefined handling either way, and `load` returns `undefined` rather than `null` for an
// absent body so a bodiless response REPLAYS as bodiless instead of as the JSON value `null`.
//
// ONE BEHAVIOURAL DIFFERENCE FROM THE IN-MEMORY STORE, verified live: a replayed body is SEMANTICALLY
// identical but not BYTE-identical. `response_body` is `jsonb`, which normalizes object key order, so
// `{"invitationId":…,"expiresAt":…}` can replay as `{"expiresAt":…,"invitationId":…}`. The in-memory
// store hands back the original object and preserves insertion order. Same values, same status, same
// ids — but a client that hashes or signs the raw response bytes would see a difference on replay.
// Left as-is rather than switching the column to `json`: HTTP idempotency guarantees the same
// RESPONSE, not the same serialization, and `jsonb` is what the table has shipped with.
import { type DbClient, schema } from "@wardenx/db";
import type { IdempotencyRecord, IdempotencyStore, IdempotentResponse } from "@wardenx/shared";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, sql } from "drizzle-orm";

/** How long a cached response stays replayable (§3.10). */
const TTL_MS = 24 * 60 * 60 * 1000;

export function createDbIdempotencyStore(db: DbClient): IdempotencyStore {
  const T = schema.idempotencyKeys;
  // The store is called from the request path, where the org is already bound; `userId` is only used
  // for the RLS session variables, not written to the row.
  const scoped = <T2>(organizationId: string, fn: (tx: DbClient) => Promise<T2>): Promise<T2> =>
    withOrgContext<DbClient, T2>(db, { organizationId, userId: "" }, fn);

  return {
    async load(organizationId, key): Promise<IdempotencyRecord | null> {
      return scoped(organizationId, async (tx) => {
        const rows = await tx
          .select({
            state: T.state,
            requestHash: T.requestHash,
            responseStatus: T.responseStatus,
            responseBody: T.responseBody,
            expiresAt: T.expiresAt,
          })
          .from(T)
          .where(and(eq(T.organizationId, organizationId), eq(T.key, key)))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        // An expired record is ABSENT, not replayable — treating it as present would let a key
        // resurrect a response long after the client stopped expecting one. The row is left for the
        // §3.10 sweeper rather than deleted here (a read must not mutate).
        if (row.expiresAt.getTime() <= Date.now()) return null;
        if (row.state === "pending") return { state: "pending", requestHash: row.requestHash };
        return {
          state: "complete",
          requestHash: row.requestHash,
          response: {
            status: row.responseStatus ?? "",
            // `undefined`, NOT `null`: a NULL column means the response had no body, and replaying it
            // as `null` would send the four bytes `null` where the original sent nothing.
            body: row.responseBody === null ? undefined : row.responseBody,
          },
        };
      });
    },

    async putPending(organizationId, key, requestHash): Promise<boolean> {
      return scoped(organizationId, async (tx) => {
        // THE CLAIM (GAP-007). The unique index on (organization_id, key) is the serialization point:
        //   * no row            -> INSERT wins, RETURNING yields the id           -> claimed.
        //   * live row          -> conflict, the WHERE is false, no row returned  -> claim LOST.
        //   * EXPIRED row       -> conflict, the WHERE holds, the row is reset to a fresh `pending`
        //     claim (new hash and TTL, response cleared) and RETURNING yields the id -> claimed.
        // Without the DO UPDATE an expired row stayed in place until a sweeper that does not exist,
        // so every retry of an expired key looked "absent" and re-executed the handler.
        // Postgres row-locks the conflicting row, so two racers on an expired key serialize: the
        // second re-evaluates the WHERE against the first's fresh row and loses.
        const claimed = await tx
          .insert(T)
          .values({
            organizationId,
            key,
            requestHash,
            state: "pending",
            responseStatus: null,
            responseBody: null,
            expiresAt: new Date(Date.now() + TTL_MS),
          })
          .onConflictDoUpdate({
            target: [T.organizationId, T.key],
            set: {
              requestHash,
              state: "pending",
              responseStatus: null,
              responseBody: null,
              createdAt: sql`now()`,
              expiresAt: new Date(Date.now() + TTL_MS),
            },
            setWhere: sql`${T.expiresAt} <= now()`,
          })
          .returning({ id: T.id });
        return claimed.length > 0;
      });
    },

    async complete(organizationId, key, response: IdempotentResponse): Promise<void> {
      await scoped(organizationId, async (tx) => {
        // Narrowed to `state = 'pending'`: only the request that HOLDS the claim may complete it. A
        // late or duplicated completion updates zero rows rather than overwriting a cached response
        // someone is already replaying.
        await tx
          .update(T)
          .set({
            state: "complete",
            responseStatus: response.status,
            // `?? null` is load-bearing: Drizzle drops `undefined` keys, so a bodiless response would
            // otherwise leave the column unmentioned by the UPDATE (F-073).
            responseBody: (response.body ?? null) as never,
          })
          .where(and(eq(T.organizationId, organizationId), eq(T.key, key), eq(T.state, "pending")));
      });
    },
  };
}
