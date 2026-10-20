// apps/backend/src/modules/02-identity — the M2-owned `session` reads and the one delete behind the M36 device and session manager (WP 5.5,
// ADR-0083). The `session` table is M2's, so M36 reaches it only through this store; the caller supplies the transaction, which lets M36 expire
// its own linked endpoints and write its audit row in the SAME transaction as the delete.
//
// Staff-class sessions only: portal, auditor and external sessions belong to other modules' lifecycles and have no realtime channel. The select
// lists columns by name, so the token, the IP address and the scope can never be returned by accident. `session` is not org-RLS'd (a Better
// Auth table), so the organisation bound is an explicit predicate here, never an assumption.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, gt, isNotNull } from "drizzle-orm";

const S = schema.sessions;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface StaffSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastActivityAt: Date | null;
}

export interface StaffSessionStore {
  listStaff(
    tx: Tx,
    query: { userId: string; organizationId: string | null; now: Date },
  ): Promise<readonly StaffSessionRow[]>;
  findStaffOwner(
    tx: Tx,
    query: { sessionId: string; organizationId: string },
  ): Promise<string | null>;
  deleteStaff(
    tx: Tx,
    query: { sessionId: string; userId: string; organizationId: string | null },
  ): Promise<boolean>;
}

export function createStaffSessionStore(): StaffSessionStore {
  return {
    async listStaff(tx, { userId, organizationId, now }) {
      return tx
        .select({
          id: S.id,
          userId: S.userId,
          userAgent: S.userAgent,
          createdAt: S.createdAt,
          lastActivityAt: S.lastActivityAt,
        })
        .from(S)
        .where(
          and(
            eq(S.userId, userId),
            eq(S.sessionClass, "staff"),
            gt(S.expiresAt, now),
            organizationId === null ? undefined : eq(S.activeOrganizationId, organizationId),
          ),
        );
    },

    async findStaffOwner(tx, { sessionId, organizationId }) {
      const [row] = await tx
        .select({ userId: S.userId })
        .from(S)
        .where(
          and(
            eq(S.id, sessionId),
            eq(S.sessionClass, "staff"),
            isNotNull(S.activeOrganizationId),
            eq(S.activeOrganizationId, organizationId),
          ),
        )
        .limit(1);
      return row?.userId ?? null;
    },

    async deleteStaff(tx, { sessionId, userId, organizationId }) {
      const deleted = await tx
        .delete(S)
        .where(
          and(
            eq(S.id, sessionId),
            eq(S.userId, userId),
            eq(S.sessionClass, "staff"),
            organizationId === null ? undefined : eq(S.activeOrganizationId, organizationId),
          ),
        )
        .returning({ id: S.id });
      return deleted.length > 0;
    },
  };
}
