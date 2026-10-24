// apps/backend/src/modules/36-messaging/death-board/death-board-store.ts - WP 6.9 (ADR-0098): the death_board / death_board_item /
// death_board_item_event rows (migration 1201). Writes take the caller's `tx` (the service or the consumer owns the transaction); every
// statement names the organization on top of RLS. chartwarden_app has no DELETE: nothing here removes a row. Instants that matter
// (due_at at creation) come from the database clock; completed_at is set by the guard trigger.
import { schema } from "@chartwarden/db";
import type {
  DeathBoardEventType,
  DeathBoardItemKey,
  DeathBoardReasonCode,
} from "@chartwarden/types";
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const B = schema.deathBoards;
const I = schema.deathBoardItems;
const E = schema.deathBoardItemEvents;

export type DeathBoardRow = typeof B.$inferSelect;
export type DeathBoardItemRow = typeof I.$inferSelect;
export type DeathBoardEventRow = typeof E.$inferSelect;

export interface NewBoardItem {
  readonly key: DeathBoardItemKey;
  readonly ownerUserId: string;
  readonly dueMinutes: number;
}

export interface EventInput {
  readonly orgId: string;
  readonly itemId: string;
  readonly eventType: DeathBoardEventType;
  readonly actorUserId: string | null;
  readonly fromOwnerUserId: string | null;
  readonly toOwnerUserId: string | null;
  readonly reasonCode: DeathBoardReasonCode;
}

export interface DeathBoardStore {
  /** Idempotent: a board for this patient already there => `{created:false}` and nothing else is written. */
  createBoard(
    tx: Tx,
    a: {
      orgId: string;
      patientId: string;
      templateVersion: number;
      items: readonly NewBoardItem[];
    },
  ): Promise<{ created: boolean; boardId: string }>;
  listBoards(tx: Tx, orgId: string, limit: number): Promise<DeathBoardRow[]>;
  getBoard(tx: Tx, orgId: string, boardId: string): Promise<DeathBoardRow | null>;
  itemsForBoards(tx: Tx, orgId: string, boardIds: readonly string[]): Promise<DeathBoardItemRow[]>;
  getItem(tx: Tx, orgId: string, itemId: string): Promise<DeathBoardItemRow | null>;
  getItemForUpdate(tx: Tx, orgId: string, itemId: string): Promise<DeathBoardItemRow | null>;
  /** True when the user owns, once owned, or acted on any item of the board. */
  isInvolved(tx: Tx, orgId: string, boardId: string, userId: string): Promise<boolean>;
  complete(
    tx: Tx,
    a: { orgId: string; itemId: string; userId: string },
  ): Promise<DeathBoardItemRow | null>;
  reassign(
    tx: Tx,
    a: { orgId: string; itemId: string; fromUserId: string; toUserId: string },
  ): Promise<DeathBoardItemRow | null>;
  flagNeedsOwner(tx: Tx, a: { orgId: string; itemId: string }): Promise<boolean>;
  addEvent(tx: Tx, e: EventInput): Promise<void>;
  /** Open, unflagged items owned by the leaver, oldest first, skipping `exclude` (items that already failed this run). */
  leaverItemIds(
    tx: Tx,
    orgId: string,
    leaverUserId: string,
    limit: number,
    exclude: readonly string[],
  ): Promise<string[]>;
  eventsForItems(tx: Tx, orgId: string, itemIds: readonly string[]): Promise<DeathBoardEventRow[]>;
}

export function createDbDeathBoardStore(): DeathBoardStore {
  return {
    async createBoard(tx, a) {
      const inserted = await tx
        .insert(B)
        .values({
          organizationId: a.orgId,
          patientId: a.patientId,
          templateVersion: a.templateVersion,
        })
        .onConflictDoNothing()
        .returning({ id: B.id });
      const mine = inserted[0];
      if (!mine) {
        const [existing] = await tx
          .select({ id: B.id })
          .from(B)
          .where(and(eq(B.organizationId, a.orgId), eq(B.patientId, a.patientId)))
          .limit(1);
        if (!existing) throw new Error("death board neither inserted nor found");
        return { created: false, boardId: existing.id };
      }
      const rows = await tx
        .insert(I)
        .values(
          a.items.map((i) => ({
            organizationId: a.orgId,
            boardId: mine.id,
            patientId: a.patientId,
            itemKey: i.key,
            ownerUserId: i.ownerUserId,
            dueAt: sql`now() + make_interval(mins => ${i.dueMinutes})`,
          })),
        )
        .returning({ id: I.id, ownerUserId: I.ownerUserId });
      await tx.insert(E).values(
        rows.map((r) => ({
          organizationId: a.orgId,
          itemId: r.id,
          eventType: "created",
          actorKind: "system",
          actorUserId: null,
          fromOwnerUserId: null,
          toOwnerUserId: r.ownerUserId,
          reasonCode: "creation",
        })),
      );
      return { created: true, boardId: mine.id };
    },

    async listBoards(tx, orgId, limit) {
      return tx
        .select()
        .from(B)
        .where(eq(B.organizationId, orgId))
        .orderBy(desc(B.createdAt), asc(B.id))
        .limit(limit);
    },

    async getBoard(tx, orgId, boardId) {
      const [row] = await tx
        .select()
        .from(B)
        .where(and(eq(B.organizationId, orgId), eq(B.id, boardId)))
        .limit(1);
      return row ?? null;
    },

    async itemsForBoards(tx, orgId, boardIds) {
      if (boardIds.length === 0) return [];
      return tx
        .select()
        .from(I)
        .where(and(eq(I.organizationId, orgId), inArray(I.boardId, [...boardIds])))
        .orderBy(asc(I.dueAt), asc(I.itemKey));
    },

    async getItem(tx, orgId, itemId) {
      const [row] = await tx
        .select()
        .from(I)
        .where(and(eq(I.organizationId, orgId), eq(I.id, itemId)))
        .limit(1);
      return row ?? null;
    },

    async getItemForUpdate(tx, orgId, itemId) {
      const [row] = await tx
        .select()
        .from(I)
        .where(and(eq(I.organizationId, orgId), eq(I.id, itemId)))
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async isInvolved(tx, orgId, boardId, userId) {
      const [owned] = await tx
        .select({ id: I.id })
        .from(I)
        .where(and(eq(I.organizationId, orgId), eq(I.boardId, boardId), eq(I.ownerUserId, userId)))
        .limit(1);
      if (owned) return true;
      const [touched] = await tx
        .select({ id: E.id })
        .from(E)
        .innerJoin(I, and(eq(I.organizationId, E.organizationId), eq(I.id, E.itemId)))
        .where(
          and(
            eq(E.organizationId, orgId),
            eq(I.boardId, boardId),
            or(
              eq(E.actorUserId, userId),
              eq(E.fromOwnerUserId, userId),
              eq(E.toOwnerUserId, userId),
            ),
          ),
        )
        .limit(1);
      return !!touched;
    },

    async complete(tx, a) {
      const [row] = await tx
        .update(I)
        .set({
          status: "done",
          completedByUserId: a.userId,
          // The guard trigger overwrites this with now(); the value is only here so the CHECK shape holds in the statement.
          completedAt: sql`now()`,
          version: sql`${I.version} + 1`,
        })
        .where(
          and(
            eq(I.organizationId, a.orgId),
            eq(I.id, a.itemId),
            eq(I.status, "open"),
            eq(I.ownerUserId, a.userId),
            eq(I.needsOwner, false),
          ),
        )
        .returning();
      return row ?? null;
    },

    async reassign(tx, a) {
      const [row] = await tx
        .update(I)
        .set({ ownerUserId: a.toUserId, needsOwner: false, version: sql`${I.version} + 1` })
        .where(
          and(
            eq(I.organizationId, a.orgId),
            eq(I.id, a.itemId),
            eq(I.status, "open"),
            eq(I.ownerUserId, a.fromUserId),
          ),
        )
        .returning();
      return row ?? null;
    },

    async flagNeedsOwner(tx, a) {
      const rows = await tx
        .update(I)
        .set({ needsOwner: true, version: sql`${I.version} + 1` })
        .where(
          and(
            eq(I.organizationId, a.orgId),
            eq(I.id, a.itemId),
            eq(I.status, "open"),
            eq(I.needsOwner, false),
          ),
        )
        .returning({ id: I.id });
      return rows.length > 0;
    },

    async addEvent(tx, e) {
      await tx.insert(E).values({
        organizationId: e.orgId,
        itemId: e.itemId,
        eventType: e.eventType,
        actorKind: e.actorUserId ? "user" : "system",
        actorUserId: e.actorUserId,
        fromOwnerUserId: e.fromOwnerUserId,
        toOwnerUserId: e.toOwnerUserId,
        reasonCode: e.reasonCode,
      });
    },

    async leaverItemIds(tx, orgId, leaverUserId, limit, exclude) {
      const rows = await tx
        .select({ id: I.id })
        .from(I)
        .where(
          and(
            eq(I.organizationId, orgId),
            eq(I.ownerUserId, leaverUserId),
            eq(I.status, "open"),
            eq(I.needsOwner, false),
            exclude.length > 0 ? notInArray(I.id, [...exclude]) : undefined,
          ),
        )
        .orderBy(asc(I.createdAt), asc(I.id))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async eventsForItems(tx, orgId, itemIds) {
      if (itemIds.length === 0) return [];
      return tx
        .select()
        .from(E)
        .where(and(eq(E.organizationId, orgId), inArray(E.itemId, [...itemIds])))
        .orderBy(asc(E.createdAt));
    },
  };
}
