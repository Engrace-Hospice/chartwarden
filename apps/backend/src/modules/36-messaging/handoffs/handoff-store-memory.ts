// apps/backend/src/modules/36-messaging/handoffs/handoff-store-memory.ts - WP 3.5: an in-memory HandoffStore that applies
// the same rules as the database store (one open handoff per pair, one pending handoff per work item, a resolved item and
// a closed handoff are final, an accepted item belongs to the recipient). It exists for unit tests of the service, the
// expiry tick and the offboarding job; the database behaviour itself is proven by the live suites.
import type { HandoffEventType, HandoffState } from "@chartwarden/types";
import {
  type ActiveTaskRow,
  type HandoffEventRow,
  HandoffItemConflict,
  type HandoffItemRow,
  type HandoffRow,
  HandoffStateConflict,
  type HandoffStore,
} from "./handoff-store-db";

export interface MemoryHandoffStore extends HandoffStore {
  readonly handoffs: Map<string, HandoffRow>;
  readonly items: Map<string, HandoffItemRow>;
  readonly eventLog: HandoffEventRow[];
  /** Test seam: the ACTIVE tasks `activeTasksAssignedTo` reports. */
  tasks: ActiveTaskRow[];
  /** Test seam: task statuses `taskStatuses` reports, by id. */
  taskStatusById: Map<string, string>;
}

const STATE_OF = {
  accept: "accepted",
  decline: "declined",
  cancel: "cancelled",
  expire: "expired",
} as const;

export function createMemoryHandoffStore(): MemoryHandoffStore {
  const handoffs = new Map<string, HandoffRow>();
  const items = new Map<string, HandoffItemRow>();
  const eventLog: HandoffEventRow[] = [];
  let seq = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const store: MemoryHandoffStore = {
    handoffs,
    items,
    eventLog,
    tasks: [],
    taskStatusById: new Map<string, string>(),
  } as unknown as MemoryHandoffStore;

  const itemsOfHandoff = (orgId: string, id: string) =>
    [...items.values()].filter((i) => i.organizationId === orgId && i.handoffId === id);
  const log = (a: {
    orgId: string;
    handoffId: string;
    type: HandoffEventType;
    userId: string | null;
    itemCount?: number;
    reasonCode?: string | null;
  }) =>
    eventLog.push({
      id: nextId(),
      organizationId: a.orgId,
      handoffId: a.handoffId,
      eventType: a.type,
      actorUserId: a.userId,
      actorKind: a.userId ? "user" : "system",
      itemCount: a.itemCount ?? 0,
      reasonCode: a.reasonCode ?? null,
      createdAt: new Date(),
    });
  const open = (orgId: string, from: string, to: string) =>
    [...handoffs.values()].find(
      (h) =>
        h.organizationId === orgId &&
        h.fromUserId === from &&
        h.toUserId === to &&
        h.state === "offered",
    ) ?? null;

  Object.assign(store, {
    async findOpenForPair(_tx, orgId, from, to) {
      return open(orgId, from, to);
    },
    async insertOffered(_tx, a) {
      const existing = open(a.orgId, a.fromUserId, a.toUserId);
      if (existing)
        return { handoff: existing, items: itemsOfHandoff(a.orgId, existing.id), created: false };
      const pending = new Set(
        [...items.values()]
          .filter((i) => i.state === "pending")
          .map((i) => `${i.itemKind}:${i.refId}`),
      );
      if (a.items.some((i) => pending.has(`${i.kind}:${i.refId}`))) throw new HandoffItemConflict();
      const handoff: HandoffRow = {
        id: nextId(),
        organizationId: a.orgId,
        fromUserId: a.fromUserId,
        toUserId: a.toUserId,
        state: "offered",
        offeredAt: a.offeredAt,
        expiresAt: a.expiresAt,
        acceptedAt: null,
        closedAt: null,
        closedReason: null,
        version: 0,
        createdAt: a.offeredAt,
        updatedAt: a.offeredAt,
      };
      handoffs.set(handoff.id, handoff);
      const rows = a.items.map(
        (i): HandoffItemRow => ({
          id: nextId(),
          organizationId: a.orgId,
          handoffId: handoff.id,
          patientId: i.patientId,
          itemKind: i.kind,
          refId: i.refId,
          state: "pending",
          accountableUserId: a.fromUserId,
          resolvedAt: null,
          createdAt: a.offeredAt,
        }),
      );
      for (const r of rows) items.set(r.id, r);
      log({
        orgId: a.orgId,
        handoffId: handoff.id,
        type: "offered",
        userId: a.fromUserId,
        itemCount: rows.length,
      });
      return { handoff, items: rows, created: true };
    },
    async getForUpdate(_tx, orgId, id) {
      const h = handoffs.get(id);
      return h && h.organizationId === orgId ? h : null;
    },
    async itemsOf(_tx, orgId, id) {
      return itemsOfHandoff(orgId, id);
    },
    async resolveItems(_tx, a) {
      const h = handoffs.get(a.handoffId);
      if (!h || h.organizationId !== a.orgId || h.state !== "offered") return [];
      if (a.action === "accept" && a.accountableUserId !== h.toUserId)
        throw new HandoffStateConflict();
      const chosen = a.itemIds === null ? null : new Set(a.itemIds);
      const changed: HandoffItemRow[] = [];
      for (const i of itemsOfHandoff(a.orgId, a.handoffId)) {
        if (i.state !== "pending" || (chosen && !chosen.has(i.id))) continue;
        const next: HandoffItemRow = {
          ...i,
          state: STATE_OF[a.action],
          resolvedAt: a.now,
          ...(a.action === "accept" ? { accountableUserId: a.accountableUserId as string } : {}),
        };
        items.set(i.id, next);
        changed.push(next);
      }
      if (changed.length > 0)
        handoffs.set(h.id, { ...h, version: h.version + 1, updatedAt: a.now });
      return changed;
    },
    async closeHandoff(_tx, a) {
      const h = handoffs.get(a.handoffId);
      if (!h || h.organizationId !== a.orgId || h.state !== "offered")
        throw new HandoffStateConflict();
      const next: HandoffRow = {
        ...h,
        state: a.state,
        closedAt: a.now,
        closedReason: a.reason,
        updatedAt: a.now,
        version: h.version + 1,
        ...(a.state === "accepted" ? { acceptedAt: a.now } : {}),
      };
      handoffs.set(h.id, next);
      return next;
    },
    async appendEvent(_tx, a) {
      log({
        orgId: a.orgId,
        handoffId: a.handoffId,
        type: a.type,
        userId: a.actor.kind === "user" ? a.actor.userId : null,
        ...(a.itemCount !== undefined ? { itemCount: a.itemCount } : {}),
        ...(a.reasonCode !== undefined ? { reasonCode: a.reasonCode } : {}),
      });
    },
    async hasEvent(_tx, orgId, id, type) {
      return eventLog.some(
        (e) => e.organizationId === orgId && e.handoffId === id && e.eventType === type,
      );
    },
    async markNeedsAttention(_tx, orgId, id) {
      if (eventLog.some((e) => e.handoffId === id && e.eventType === "needs_attention"))
        return false;
      log({ orgId, handoffId: id, type: "needs_attention", userId: null });
      return true;
    },
    async participantGet(orgId, userId, id) {
      const h = handoffs.get(id);
      const ok =
        h && h.organizationId === orgId && (h.fromUserId === userId || h.toUserId === userId);
      return ok ? { handoff: h, items: itemsOfHandoff(orgId, id) } : null;
    },
    async participantList(orgId, userId, q) {
      return [...handoffs.values()]
        .filter((h) => h.organizationId === orgId)
        .filter((h) => (q.scope === "incoming" ? h.toUserId === userId : h.fromUserId === userId))
        .filter((h) => q.state === "all" || (h.state === "offered") === (q.state === "active"))
        .slice(0, q.limit)
        .map((handoff) => ({ handoff, items: itemsOfHandoff(orgId, handoff.id) }));
    },
    async events(orgId, id) {
      return eventLog.filter((e) => e.organizationId === orgId && e.handoffId === id);
    },
    async dueIds(orgId, minutes, now, limit, exclude) {
      return [...handoffs.values()]
        .filter(
          (h) => h.organizationId === orgId && h.state === "offered" && !exclude.includes(h.id),
        )
        .filter(
          (h) =>
            h.expiresAt.getTime() <= now.getTime() ||
            h.offeredAt.getTime() + minutes * 60_000 <= now.getTime(),
        )
        .slice(0, limit)
        .map((h) => h.id);
    },
    async leaverHandoffIds(orgId, leaver, limit, exclude) {
      return [...handoffs.values()]
        .filter(
          (h) => h.organizationId === orgId && h.state === "offered" && !exclude.includes(h.id),
        )
        .filter(
          (h) =>
            h.toUserId === leaver ||
            (h.fromUserId === leaver &&
              !eventLog.some((e) => e.handoffId === h.id && e.eventType === "sender_left")),
        )
        .slice(0, limit)
        .map((h) => h.id);
    },
    async stateOf(orgId, id) {
      const h = handoffs.get(id);
      return h && h.organizationId === orgId ? (h.state as HandoffState) : null;
    },
    async needsAttentionIds(orgId, ids) {
      return new Set(
        eventLog
          .filter(
            (e) =>
              e.organizationId === orgId &&
              e.eventType === "needs_attention" &&
              ids.includes(e.handoffId),
          )
          .map((e) => e.handoffId),
      );
    },
    async taskStatuses(_o, ids) {
      return new Map(
        ids.flatMap((id) =>
          store.taskStatusById.has(id)
            ? [[id, store.taskStatusById.get(id) as string] as const]
            : [],
        ),
      );
    },
    async activeTasksAssignedTo(_o, _u, patientIds) {
      return store.tasks.filter((t) => patientIds.includes(t.patientId));
    },
  } satisfies Omit<HandoffStore, never>);
  return store;
}
