// WP 6.9 test support: an in-memory DeathBoardStore that mirrors the database rules the service relies on (one board per patient, an item is
// born open, only the owner completes, a done item is final, a reassignment clears the flag). Not used in production.
import { randomUUID } from "node:crypto";
import type {
  DeathBoardEventRow,
  DeathBoardItemRow,
  DeathBoardRow,
  DeathBoardStore,
} from "./death-board-store";

export interface MemoryDeathBoardStore extends DeathBoardStore {
  readonly boards: Map<string, DeathBoardRow>;
  readonly items: Map<string, DeathBoardItemRow>;
  readonly events: DeathBoardEventRow[];
}

export function createMemoryDeathBoardStore(now: () => Date): MemoryDeathBoardStore {
  const boards = new Map<string, DeathBoardRow>();
  const items = new Map<string, DeathBoardItemRow>();
  const events: DeathBoardEventRow[] = [];
  const bump = (row: DeathBoardItemRow, patch: Partial<DeathBoardItemRow>): DeathBoardItemRow => {
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: now() };
    items.set(row.id, next);
    return next;
  };
  return {
    boards,
    items,
    events,
    async createBoard(_tx, a) {
      const existing = [...boards.values()].find(
        (b) => b.organizationId === a.orgId && b.patientId === a.patientId,
      );
      if (existing) return { created: false, boardId: existing.id };
      const board: DeathBoardRow = {
        id: randomUUID(),
        organizationId: a.orgId,
        patientId: a.patientId,
        templateVersion: a.templateVersion,
        createdAt: now(),
      };
      boards.set(board.id, board);
      for (const i of a.items) {
        const row: DeathBoardItemRow = {
          id: randomUUID(),
          organizationId: a.orgId,
          boardId: board.id,
          patientId: a.patientId,
          itemKey: i.key,
          ownerUserId: i.ownerUserId,
          status: "open",
          needsOwner: false,
          dueAt: new Date(now().getTime() + i.dueMinutes * 60_000),
          completedAt: null,
          completedByUserId: null,
          version: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        items.set(row.id, row);
        events.push({
          id: randomUUID(),
          organizationId: a.orgId,
          itemId: row.id,
          eventType: "created",
          actorKind: "system",
          actorUserId: null,
          fromOwnerUserId: null,
          toOwnerUserId: i.ownerUserId,
          reasonCode: "creation",
          createdAt: now(),
        });
      }
      return { created: true, boardId: board.id };
    },
    async listBoards(_tx, orgId, limit) {
      return [...boards.values()]
        .filter((b) => b.organizationId === orgId)
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
        .slice(0, limit);
    },
    async getBoard(_tx, orgId, boardId) {
      const b = boards.get(boardId);
      return b && b.organizationId === orgId ? b : null;
    },
    async itemsForBoards(_tx, orgId, boardIds) {
      return [...items.values()].filter(
        (i) => i.organizationId === orgId && boardIds.includes(i.boardId),
      );
    },
    async getItem(_tx, orgId, itemId) {
      const i = items.get(itemId);
      return i && i.organizationId === orgId ? i : null;
    },
    async getItemForUpdate(_tx, orgId, itemId) {
      const i = items.get(itemId);
      return i && i.organizationId === orgId ? i : null;
    },
    async isInvolved(_tx, _orgId, boardId, userId) {
      const mine = [...items.values()].filter((i) => i.boardId === boardId);
      if (mine.some((i) => i.ownerUserId === userId)) return true;
      const ids = new Set(mine.map((i) => i.id));
      return events.some(
        (e) =>
          ids.has(e.itemId) &&
          (e.actorUserId === userId || e.fromOwnerUserId === userId || e.toOwnerUserId === userId),
      );
    },
    async complete(_tx, a) {
      const row = items.get(a.itemId);
      if (!row || row.status !== "open" || row.ownerUserId !== a.userId || row.needsOwner) {
        return null;
      }
      return bump(row, { status: "done", completedAt: now(), completedByUserId: a.userId });
    },
    async reassign(_tx, a) {
      const row = items.get(a.itemId);
      if (!row || row.status !== "open" || row.ownerUserId !== a.fromUserId) return null;
      return bump(row, { ownerUserId: a.toUserId, needsOwner: false });
    },
    async flagNeedsOwner(_tx, a) {
      const row = items.get(a.itemId);
      if (!row || row.status !== "open" || row.needsOwner) return false;
      bump(row, { needsOwner: true });
      return true;
    },
    async addEvent(_tx, e) {
      events.push({
        id: randomUUID(),
        organizationId: e.orgId,
        itemId: e.itemId,
        eventType: e.eventType,
        actorKind: e.actorUserId ? "user" : "system",
        actorUserId: e.actorUserId,
        fromOwnerUserId: e.fromOwnerUserId,
        toOwnerUserId: e.toOwnerUserId,
        reasonCode: e.reasonCode,
        createdAt: now(),
      });
    },
    async leaverItemIds(_tx, orgId, leaver, limit, exclude) {
      return [...items.values()]
        .filter(
          (i) =>
            i.organizationId === orgId &&
            i.ownerUserId === leaver &&
            i.status === "open" &&
            !i.needsOwner &&
            !exclude.includes(i.id),
        )
        .slice(0, limit)
        .map((i) => i.id);
    },
    async eventsForItems(_tx, _orgId, itemIds) {
      return events.filter((e) => itemIds.includes(e.itemId));
    },
  };
}
