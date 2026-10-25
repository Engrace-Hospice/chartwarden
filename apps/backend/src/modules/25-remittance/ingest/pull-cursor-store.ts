// apps/backend/src/modules/25-remittance/ingest/pull-cursor-store.ts - #717: the persisted 835 poll position
// (`remittance_pull_cursor`, migration 1254). Tenant-scoped by `withOrgContext`; the cursor is an opaque vendor token.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { RemittanceCursorKey, RemittanceCursorStore } from "./clearinghouse-pull";

const C = schema.remittancePullCursor;
const R = schema.remittancePullRefusal;

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
    async isQuarantined(
      key: RemittanceCursorKey,
      remittanceId: string,
      fileSha256: string,
    ): Promise<boolean> {
      return withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        const [row] = await tx
          .select({ quarantinedAt: R.quarantinedAt })
          .from(R)
          .where(refusalWhere(key, remittanceId, fileSha256))
          .limit(1);
        return row?.quarantinedAt != null;
      });
    },
    async clearRefusals(key, remittanceId, fileSha256) {
      await withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        await tx
          .update(R)
          .set({ refusalCount: 0, updatedAt: sql`now()` })
          .where(
            and(
              refusalWhere(key, remittanceId, fileSha256),
              sql`${R.quarantinedAt} IS NULL`,
              sql`${R.refusalCount} > 0`,
            ),
          );
      });
    },
    async recordRefusal(key, remittanceId, fileSha256, reasonCode, cap) {
      return withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        const [row] = await tx
          .insert(R)
          .values({
            organizationId: key.organizationId,
            providerEntityId: key.providerEntityId,
            vendor: key.vendor,
            usage: key.usage,
            remittanceId,
            fileSha256,
            reasonCode,
            quarantinedAt: cap <= 1 ? sql`now()` : null,
          })
          .onConflictDoUpdate({
            target: [
              R.organizationId,
              R.providerEntityId,
              R.vendor,
              R.usage,
              R.remittanceId,
              R.fileSha256,
            ],
            set: {
              refusalCount: sql`${R.refusalCount} + 1`,
              reasonCode,
              quarantinedAt: sql`CASE WHEN ${R.refusalCount} + 1 >= ${cap} THEN COALESCE(${R.quarantinedAt}, now()) ELSE ${R.quarantinedAt} END`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ count: R.refusalCount, quarantinedAt: R.quarantinedAt });
        return { count: row?.count ?? 1, quarantined: row?.quarantinedAt != null };
      });
    },
  };
}

function refusalWhere(key: RemittanceCursorKey, remittanceId: string, fileSha256: string) {
  return and(
    eq(R.organizationId, key.organizationId),
    eq(R.providerEntityId, key.providerEntityId),
    eq(R.vendor, key.vendor),
    eq(R.usage, key.usage),
    eq(R.remittanceId, remittanceId),
    eq(R.fileSha256, fileSha256),
  );
}
