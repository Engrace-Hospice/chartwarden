// Test support: an in-memory DeathNotificationStore mirroring the database rules the service relies on (unique per recipient, never born acked,
// an acked row is final). Not used in production.
import { randomUUID } from "node:crypto";
import type { DeathNotificationRow, DeathNotificationStore } from "./death-notification-store";

export interface MemoryDeathNotificationStore extends DeathNotificationStore {
  readonly rows: Map<string, DeathNotificationRow>;
}

const INTERNAL = new Set([
  "attending",
  "medical_director",
  "bereavement_coordinator",
  "billing_lead",
  "pharmacy_liaison",
  "dme_liaison",
]);

export function createMemoryDeathNotificationStore(now: () => Date): MemoryDeathNotificationStore {
  const rows = new Map<string, DeathNotificationRow>();
  const patch = (row: DeathNotificationRow, p: Partial<DeathNotificationRow>) => {
    const next = { ...row, ...p, updatedAt: now() };
    rows.set(row.id, next);
    return next;
  };
  return {
    rows,
    async ensure(_tx, a) {
      const existing = [...rows.values()].find(
        (r) =>
          r.organizationId === a.orgId &&
          r.boardId === a.boardId &&
          r.recipientKind === a.kind &&
          r.recipientRef === a.ref,
      );
      if (existing) return { created: false, row: existing };
      const row: DeathNotificationRow = {
        id: randomUUID(),
        organizationId: a.orgId,
        boardId: a.boardId,
        patientId: a.patientId,
        recipientKind: a.kind,
        recipientRef: a.ref,
        state: "pending",
        sentAt: null,
        ackedAt: null,
        ackedBy: null,
        sentOutboxEventId: null,
        funeralHomeEntityId: a.funeralHomeEntityId ?? null,
        linkId: null,
        recipientEmailHash: null,
        createdAt: now(),
        updatedAt: now(),
      };
      rows.set(row.id, row);
      return { created: true, row };
    },
    async get(_tx, orgId, id) {
      const r = rows.get(id);
      return r && r.organizationId === orgId ? r : null;
    },
    async listForBoard(_tx, orgId, boardId) {
      return [...rows.values()].filter((r) => r.organizationId === orgId && r.boardId === boardId);
    },
    async claim(_tx, a) {
      const r = rows.get(a.id);
      if (!r || r.organizationId !== a.orgId) return null;
      if (!["pending", "failed", "blocked_no_baa"].includes(r.state)) return null;
      return patch(r, { state: "sending" });
    },
    async settle(_tx, a) {
      const r = rows.get(a.id);
      if (!r || r.organizationId !== a.orgId || r.state !== "sending") return null;
      return patch(r, {
        state: a.to,
        ...(a.to === "sent" ? { sentAt: now() } : {}),
        ...(a.linkId ? { linkId: a.linkId } : {}),
        ...(a.recipientEmailHash ? { recipientEmailHash: a.recipientEmailHash } : {}),
      });
    },
    async transition(_tx, a) {
      const r = rows.get(a.id);
      if (!r || r.organizationId !== a.orgId) return null;
      if (!["pending", "failed", "blocked_no_baa"].includes(r.state)) return null;
      return patch(r, {
        state: a.to,
        ...(a.to === "sent" ? { sentAt: now() } : {}),
        ...(a.sentOutboxEventId ? { sentOutboxEventId: a.sentOutboxEventId } : {}),
      });
    },
    async ack(_tx, a) {
      const r = rows.get(a.id);
      if (!r || r.organizationId !== a.orgId) return null;
      if (!["pending", "sent"].includes(r.state) || !INTERNAL.has(r.recipientKind)) return null;
      return patch(r, { state: "acked", ackedAt: now(), ackedBy: a.userId });
    },
    async staleUnacked(_tx, orgId, olderThanMinutes, limit) {
      const cutoff = now().getTime() - olderThanMinutes * 60_000;
      return [...rows.values()]
        .filter(
          (r) =>
            r.organizationId === orgId &&
            ["pending", "sent"].includes(r.state) &&
            INTERNAL.has(r.recipientKind) &&
            r.createdAt.getTime() < cutoff,
        )
        .slice(0, limit);
    },
  };
}
