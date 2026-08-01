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
// ATOMICITY is the whole contract: `putPending` must be set-if-absent so two concurrent duplicates
// serialize. That is delegated to Postgres via the `idempotency_org_key_idx` UNIQUE index and
// `ON CONFLICT DO NOTHING` — the loser inserts zero rows, re-reads, and sees the winner's `pending`
// row, which `runIdempotent` turns into an in-flight 409. A read-then-write would let both through.
//
// RLS: every statement is org-scoped through `withOrgContext`, so a tenant can only ever see or claim
// its own keys — the `idempotency_key_org` policy (0001) is a plain `app.org_id` match.
//
// ONE BEHAVIOURAL DIFFERENCE FROM THE IN-MEMORY STORE, verified live: a replayed body is SEMANTICALLY
// identical but not BYTE-identical. `response_body` is `jsonb`, which normalizes object key order, so
// `{"invitationId":…,"expiresAt":…}` can replay as `{"expiresAt":…,"invitationId":…}`. The in-memory
// store hands back the original object and preserves insertion order. Same values, same status, same
// ids — but a client that hashes or signs the raw response bytes would see a difference on replay.
// Left as-is rather than switching the column to `json`: HTTP idempotency guarantees the same
// RESPONSE, not the same serialization, and `jsonb` is what the table has shipped with.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  IdempotencyRecord,
  IdempotencyStore,
  IdempotentResponse,
} from "@wardenx/shared";
import { and, eq } from "drizzle-orm";

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
            body: row.responseBody ?? null,
          },
        };
      });
    },

    async putPending(organizationId, key, requestHash): Promise<void> {
      await scoped(organizationId, async (tx) => {
        // SET-IF-ABSENT. The unique index on (organization_id, key) makes this the serialization
        // point for concurrent duplicates; DO NOTHING means the loser simply inserts nothing and the
        // caller's next `load` observes the winner's pending row.
        await tx
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
          .onConflictDoNothing({ target: [T.organizationId, T.key] });
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
            responseBody: response.body as never,
          })
          .where(
            and(
              eq(T.organizationId, organizationId),
              eq(T.key, key),
              eq(T.state, "pending"),
            ),
          );
      });
    },
  };
}
