// apps/backend/src/modules/23-billing-medicare/clearinghouse-ack-cursor-store.ts - #749: the durable ack poll position
// (`clearinghouse_ack_cursor`, migration 1267). A cron tick is not a request, so every call opens its own org context
// from the key's organization id. `advance` is a compare-and-set on `version`.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { AckCursorKey, AckCursorState, AckCursorStore } from "./jobs/clearinghouse-submission";

const C = schema.clearinghouseAckCursor;

const sameKey = (key: AckCursorKey) =>
  and(
    eq(C.organizationId, key.organizationId),
    eq(C.providerEntityId, key.providerEntityId),
    eq(C.vendor, key.vendor),
    eq(C.usage, key.usage),
    eq(C.kind, key.kind),
  );

export function createDrizzleAckCursorStore(db: DbClient): AckCursorStore {
  return {
    async read(key: AckCursorKey): Promise<AckCursorState> {
      return withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        const [row] = await tx
          .select({ cursor: C.cursor, version: C.version })
          .from(C)
          .where(sameKey(key))
          .limit(1);
        return row
          ? { cursor: row.cursor, version: Number(row.version) }
          : { cursor: null, version: 0 };
      });
    },
    async advance(key, expectedVersion, next): Promise<boolean> {
      return withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        if (expectedVersion === 0) {
          // First move: the unique key arbitrates a race, the loser inserts nothing.
          const inserted = await tx
            .insert(C)
            .values({
              organizationId: key.organizationId,
              providerEntityId: key.providerEntityId,
              vendor: key.vendor,
              usage: key.usage,
              kind: key.kind,
              cursor: next,
            })
            .onConflictDoNothing()
            .returning({ id: C.id });
          return inserted.length === 1;
        }
        const updated = await tx
          .update(C)
          .set({ cursor: next, version: sql`${C.version} + 1`, updatedAt: sql`now()` })
          .where(and(sameKey(key), eq(C.version, expectedVersion)))
          .returning({ id: C.id });
        return updated.length === 1;
      });
    },
  };
}
