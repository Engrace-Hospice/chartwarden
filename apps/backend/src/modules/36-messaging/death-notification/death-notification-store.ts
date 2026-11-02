// apps/backend/src/modules/36-messaging/death-notification/death-notification-store.ts - the death_notification rows (migration 1305). Writes take
// the caller's `tx`; every statement names the organization on top of RLS. chartwarden_app has no DELETE. acked_at comes from the guard trigger.
import { schema } from "@chartwarden/db";
import type { DeathNotificationKind, DeathNotificationState } from "@chartwarden/types";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const N = schema.deathNotifications;
export type DeathNotificationRow = typeof N.$inferSelect;

export interface DeathNotificationStore {
  /** Idempotent: a row for (board, kind, ref) already there => `{created:false}` and the EXISTING row; nothing is written. */
  ensure(
    tx: Tx,
    a: {
      orgId: string;
      boardId: string;
      patientId: string;
      kind: DeathNotificationKind;
      ref: string;
    },
  ): Promise<{ created: boolean; row: DeathNotificationRow }>;
  get(tx: Tx, orgId: string, id: string): Promise<DeathNotificationRow | null>;
  listForBoard(tx: Tx, orgId: string, boardId: string): Promise<DeathNotificationRow[]>;
  /** pending|failed|blocked_no_baa -> `state`. Never touches an acked row. Returns the row, or null when nothing changed. */
  transition(
    tx: Tx,
    a: {
      orgId: string;
      id: string;
      to: Exclude<DeathNotificationState, "pending" | "acked">;
      sentOutboxEventId?: string | undefined;
    },
  ): Promise<DeathNotificationRow | null>;
  /** pending|sent -> acked by `userId` (explicit act). Null when the row is not ackable (already acked, or in another state). */
  ack(
    tx: Tx,
    a: { orgId: string; id: string; userId: string },
  ): Promise<DeathNotificationRow | null>;
  /** Internal notices still pending|sent that are older than `olderThanMinutes`, oldest first. */
  staleUnacked(
    tx: Tx,
    orgId: string,
    olderThanMinutes: number,
    limit: number,
  ): Promise<DeathNotificationRow[]>;
}

const INTERNAL_KINDS = [
  "attending",
  "medical_director",
  "bereavement_coordinator",
  "billing_lead",
  "pharmacy_liaison",
  "dme_liaison",
];

export function createDbDeathNotificationStore(): DeathNotificationStore {
  return {
    async ensure(tx, a) {
      const inserted = await tx
        .insert(N)
        .values({
          organizationId: a.orgId,
          boardId: a.boardId,
          patientId: a.patientId,
          recipientKind: a.kind,
          recipientRef: a.ref,
        })
        .onConflictDoNothing()
        .returning();
      const mine = inserted[0];
      if (mine) return { created: true, row: mine };
      const [existing] = await tx
        .select()
        .from(N)
        .where(
          and(
            eq(N.organizationId, a.orgId),
            eq(N.boardId, a.boardId),
            eq(N.recipientKind, a.kind),
            eq(N.recipientRef, a.ref),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("death notification neither inserted nor found");
      return { created: false, row: existing };
    },

    async get(tx, orgId, id) {
      const [row] = await tx
        .select()
        .from(N)
        .where(and(eq(N.organizationId, orgId), eq(N.id, id)))
        .limit(1);
      return row ?? null;
    },

    listForBoard(tx, orgId, boardId) {
      return tx
        .select()
        .from(N)
        .where(and(eq(N.organizationId, orgId), eq(N.boardId, boardId)))
        .orderBy(asc(N.createdAt), asc(N.id));
    },

    async transition(tx, a) {
      const [row] = await tx
        .update(N)
        .set({
          state: a.to,
          ...(a.to === "sent" ? { sentAt: sql`now()` } : {}),
          ...(a.sentOutboxEventId ? { sentOutboxEventId: a.sentOutboxEventId } : {}),
        })
        .where(
          and(
            eq(N.organizationId, a.orgId),
            eq(N.id, a.id),
            inArray(N.state, ["pending", "failed", "blocked_no_baa"]),
          ),
        )
        .returning();
      return row ?? null;
    },

    async ack(tx, a) {
      const [row] = await tx
        .update(N)
        .set({ state: "acked", ackedBy: a.userId })
        .where(
          and(
            eq(N.organizationId, a.orgId),
            eq(N.id, a.id),
            inArray(N.state, ["pending", "sent"]),
            inArray(N.recipientKind, INTERNAL_KINDS),
          ),
        )
        .returning();
      return row ?? null;
    },

    staleUnacked(tx, orgId, olderThanMinutes, limit) {
      return tx
        .select()
        .from(N)
        .where(
          and(
            eq(N.organizationId, orgId),
            inArray(N.state, ["pending", "sent"]),
            inArray(N.recipientKind, INTERNAL_KINDS),
            lt(N.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
          ),
        )
        .orderBy(asc(N.createdAt), asc(N.id))
        .limit(limit);
    },
  };
}
