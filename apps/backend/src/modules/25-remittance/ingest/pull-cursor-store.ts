// apps/backend/src/modules/25-remittance/ingest/pull-cursor-store.ts - #717: the persisted 835 poll position
// (`remittance_pull_cursor`, migration 1254). Tenant-scoped by `withOrgContext`; the cursor is an opaque vendor token.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { RemittanceCursorKey, RemittanceCursorStore } from "./clearinghouse-pull";

const C = schema.remittancePullCursor;

export function buildDrizzleRemittanceCursorStore(db: DbClient): RemittanceCursorStore {
  return {
    async get(key: RemittanceCursorKey): Promise<string | null> {
      return withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        const [row] = await tx
          .select({ cursor: C.cursor })
          .from(C)
          .where(
            and(
              eq(C.organizationId, key.organizationId),
              eq(C.providerEntityId, key.providerEntityId),
              eq(C.vendor, key.vendor),
              eq(C.usage, key.usage),
            ),
          )
          .limit(1);
        return row?.cursor ?? null;
      });
    },
    async set(key: RemittanceCursorKey, cursor: string): Promise<void> {
      await withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        await tx
          .insert(C)
          .values({
            organizationId: key.organizationId,
            providerEntityId: key.providerEntityId,
            vendor: key.vendor,
            usage: key.usage,
            cursor,
          })
          .onConflictDoUpdate({
            target: [C.organizationId, C.providerEntityId, C.vendor, C.usage],
            set: { cursor, updatedAt: sql`now()` },
          });
      });
    },
  };
}
