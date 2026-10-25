// apps/backend/src/modules/23-billing-medicare/dde-change-store.ts - #793: the durable state of the DDE daily-change
// ingest (`dde_change_cursor` + `dde_change_exception`, migration 1273). A cron tick is not a request, so every call
// opens its own org context from the key's organization id. `advanceCursor` is a compare-and-set on `version`.
import { type BillingDb, repositories } from "@chartwarden/billing";
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { DdeChangeCursorKey, DdeChangeStore } from "./jobs/dde-daily-change";

const C = schema.ddeChangeCursor;
const X = schema.ddeChangeException;
const REFUSED = "refused";
const UNMATCHED = "unmatched";
const UNMATCHED_CODE = "DDE_ITEM_UNKNOWN";

const cursorWhere = (key: DdeChangeCursorKey) =>
  and(
    eq(C.organizationId, key.organizationId),
    eq(C.providerEntityId, key.providerEntityId),
    eq(C.vendor, key.vendor),
    eq(C.usage, key.usage),
    eq(C.operatorMembershipId, key.operatorMembershipId),
  );

const exceptionWhere = (key: DdeChangeCursorKey, eventId: string) =>
  and(
    eq(X.organizationId, key.organizationId),
    eq(X.providerEntityId, key.providerEntityId),
    eq(X.vendor, key.vendor),
    eq(X.usage, key.usage),
    eq(X.eventId, eventId),
  );

export function createDrizzleDdeChangeStore(db: DbClient): DdeChangeStore {
  const inOrg = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>) =>
    withOrgContext(db, systemOrgContext(organizationId), (tx) => fn(tx as unknown as DbClient));
  return {
    readCursor(key) {
      return inOrg(key.organizationId, async (tx) => {
        const [row] = await tx
          .select({ cursor: C.cursor, version: C.version })
          .from(C)
          .where(cursorWhere(key))
          .limit(1);
        return row
          ? { cursor: row.cursor, version: Number(row.version) }
          : { cursor: null, version: 0 };
      });
    },
    advanceCursor(key, expectedVersion, next) {
      return inOrg(key.organizationId, async (tx) => {
        if (expectedVersion === 0) {
          // First move: the unique key arbitrates a race, the loser inserts nothing.
          const inserted = await tx
            .insert(C)
            .values({
              organizationId: key.organizationId,
              providerEntityId: key.providerEntityId,
              vendor: key.vendor,
              usage: key.usage,
              operatorMembershipId: key.operatorMembershipId,
              cursor: next,
            })
            .onConflictDoNothing()
            .returning({ id: C.id });
          return inserted.length === 1;
        }
        const updated = await tx
          .update(C)
          .set({ cursor: next, version: sql`${C.version} + 1`, updatedAt: sql`now()` })
          .where(and(cursorWhere(key), eq(C.version, expectedVersion)))
          .returning({ id: C.id });
        return updated.length === 1;
      });
    },
    isQuarantined(key, eventId) {
      return inOrg(key.organizationId, async (tx) => {
        const [row] = await tx
          .select({ quarantinedAt: X.quarantinedAt })
          .from(X)
          .where(exceptionWhere(key, eventId))
          .limit(1);
        return row?.quarantinedAt != null;
      });
    },
    recordRefusal(key, eventId, reasonCode, cap) {
      return inOrg(key.organizationId, async (tx) => {
        const [row] = await tx
          .insert(X)
          .values({
            organizationId: key.organizationId,
            providerEntityId: key.providerEntityId,
            vendor: key.vendor,
            usage: key.usage,
            eventId,
            kind: REFUSED,
            reasonCode,
            quarantinedAt: cap <= 1 ? sql`now()` : null,
          })
          .onConflictDoUpdate({
            target: [X.organizationId, X.providerEntityId, X.vendor, X.usage, X.eventId],
            set: {
              kind: REFUSED,
              // An event first seen as unmatched starts its refusal count from this refusal.
              seenCount: sql`CASE WHEN ${X.kind} = 'refused' THEN ${X.seenCount} + 1 ELSE 1 END`,
              reasonCode,
              quarantinedAt: sql`CASE WHEN ${X.kind} = 'refused' AND ${X.seenCount} + 1 >= ${cap} THEN COALESCE(${X.quarantinedAt}, now()) ELSE ${X.quarantinedAt} END`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ count: X.seenCount, quarantinedAt: X.quarantinedAt });
        return { count: row?.count ?? 1, quarantined: row?.quarantinedAt != null };
      });
    },
    clearRefusals(key, eventId) {
      return inOrg(key.organizationId, async (tx) => {
        await tx
          .update(X)
          .set({ seenCount: 1, updatedAt: sql`now()` })
          .where(
            and(
              exceptionWhere(key, eventId),
              eq(X.kind, REFUSED),
              sql`${X.quarantinedAt} IS NULL`,
              sql`${X.seenCount} > 1`,
            ),
          );
      });
    },
    traceUnmatched(key, eventId) {
      return inOrg(key.organizationId, async (tx) => {
        // `xmax = 0` is true only for a freshly inserted row: the first sighting of this event.
        const rows = await tx
          .insert(X)
          .values({
            organizationId: key.organizationId,
            providerEntityId: key.providerEntityId,
            vendor: key.vendor,
            usage: key.usage,
            eventId,
            kind: UNMATCHED,
            reasonCode: UNMATCHED_CODE,
          })
          .onConflictDoUpdate({
            target: [X.organizationId, X.providerEntityId, X.vendor, X.usage, X.eventId],
            // A refused/quarantined row keeps its kind: an event we once refused is not "unknown".
            set: { seenCount: sql`${X.seenCount} + 1`, updatedAt: sql`now()` },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)`, seen: X.seenCount });
        return { firstSeen: rows[0]?.inserted === true, seenCount: rows[0]?.seen ?? 1 };
      });
    },
    awaitingOperators(organizationId, limit) {
      return inOrg(organizationId, (tx) =>
        new repositories.DdeWorkItemRepository(
          tx as unknown as BillingDb,
        ).awaitingProviderOperators(limit),
      );
    },
  };
}
