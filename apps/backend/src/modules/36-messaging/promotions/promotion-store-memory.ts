// apps/backend/src/modules/36-messaging/promotions/promotion-store-memory.ts - WP 3.7: an in-memory PromotionStore that
// applies the same rules as the database store (one proposed request per message and target, accepted and rejected are
// final, a withdrawn or superseded request may only become accepted). It exists for unit tests of the service and the
// source reader; the database behaviour itself is proven by the live suites.
import {
  type PromotionKey,
  type PromotionListState,
  type PromotionRow,
  type PromotionStore,
  clampPromotionLimit,
} from "./promotion-store-db";

export interface MemoryPromotionStore extends PromotionStore {
  readonly rows: Map<string, PromotionRow>;
}

const FROM_ACCEPT = ["proposed", "withdrawn", "superseded"];

export function createMemoryPromotionStore(): MemoryPromotionStore {
  const rows = new Map<string, PromotionRow>();
  let seq = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const all = () => [...rows.values()];
  const sameKey = (r: PromotionRow, orgId: string, k: PromotionKey) =>
    r.organizationId === orgId &&
    r.messageId === k.messageId &&
    r.targetModule === k.targetModule &&
    r.targetKind === k.targetKind;
  const newest = (a: PromotionRow, b: PromotionRow) =>
    b.requestedAt.getTime() - a.requestedAt.getTime() || a.id.localeCompare(b.id);
  const patch = (row: PromotionRow, change: Partial<PromotionRow>): PromotionRow => {
    const next = { ...row, ...change, version: row.version + 1 };
    rows.set(row.id, next);
    return next;
  };
  const owned = (orgId: string, id: string): PromotionRow | undefined => {
    const r = rows.get(id);
    return r && r.organizationId === orgId ? r : undefined;
  };

  return {
    rows,
    async lockKey(_tx, orgId, key) {
      return all()
        .filter((r) => sameKey(r, orgId, key))
        .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
    },
    async insertProposed(_tx, a) {
      const taken = all().some((r) => sameKey(r, a.orgId, a) && r.status === "proposed");
      if (taken) return null;
      const now = new Date();
      const row: PromotionRow = {
        id: nextId(),
        organizationId: a.orgId,
        messageId: a.messageId,
        channelId: a.channelId,
        patientId: a.patientId,
        targetModule: a.targetModule,
        targetKind: a.targetKind,
        suggestedTargetRef: a.suggestedTargetRef,
        status: "proposed",
        requestedByUserId: a.requestedByUserId,
        requestedAt: now,
        sourceAuthorUserId: a.sourceAuthorUserId,
        sourceSentAt: a.sourceSentAt,
        sourceBodySha256: a.sourceBodySha256,
        resultRef: null,
        decidedByUserId: null,
        decidedAt: null,
        reasonCode: null,
        closedAt: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async lockById(_tx, orgId, id) {
      return owned(orgId, id) ?? null;
    },
    async supersede(_tx, orgId, id) {
      const r = owned(orgId, id);
      if (!r || r.status !== "proposed") return null;
      const now = new Date();
      return patch(r, {
        status: "superseded",
        reasonCode: "superseded",
        closedAt: now,
        updatedAt: now,
      });
    },
    async supersedeSiblings(_tx, orgId, accepted) {
      const now = new Date();
      const siblings = all().filter(
        (r) => sameKey(r, orgId, accepted) && r.id !== accepted.id && r.status === "proposed",
      );
      for (const r of siblings) {
        patch(r, { status: "superseded", reasonCode: "superseded", closedAt: now, updatedAt: now });
      }
      return siblings.length;
    },
    async withdraw(_tx, orgId, id) {
      const r = owned(orgId, id);
      if (!r || r.status !== "proposed") return null;
      const now = new Date();
      return patch(r, {
        status: "withdrawn",
        reasonCode: "requester",
        closedAt: now,
        updatedAt: now,
      });
    },
    async markAccepted(_tx, orgId, id, a) {
      const r = owned(orgId, id);
      if (!r || !FROM_ACCEPT.includes(r.status)) return null;
      return patch(r, {
        status: "accepted",
        resultRef: a.resultRef,
        decidedByUserId: a.decidedByUserId,
        decidedAt: a.at,
        reasonCode: null,
        closedAt: r.closedAt ?? a.at,
        updatedAt: a.at,
      });
    },
    async markRejected(_tx, orgId, id, a) {
      const r = owned(orgId, id);
      if (!r || r.status !== "proposed") return null;
      return patch(r, {
        status: "rejected",
        reasonCode: a.reasonCode,
        decidedByUserId: a.decidedByUserId,
        decidedAt: a.at,
        closedAt: a.at,
        updatedAt: a.at,
      });
    },
    async get(orgId, id) {
      return owned(orgId, id) ?? null;
    },
    async listForMessage(orgId, messageId) {
      return all()
        .filter((r) => r.organizationId === orgId && r.messageId === messageId)
        .sort(newest);
    },
    async listForRequester(orgId, userId, state: PromotionListState, limit) {
      const active = (r: PromotionRow) => r.status === "proposed";
      return all()
        .filter((r) => r.organizationId === orgId && r.requestedByUserId === userId)
        .filter((r) => (state === "all" ? true : state === "active" ? active(r) : !active(r)))
        .sort(newest)
        .slice(0, clampPromotionLimit(limit));
    },
    async pendingForPatients(orgId, targetModule, patientIds, limit) {
      return all()
        .filter(
          (r) =>
            r.organizationId === orgId &&
            r.targetModule === targetModule &&
            r.status === "proposed" &&
            patientIds.includes(r.patientId),
        )
        .sort(newest)
        .slice(0, clampPromotionLimit(limit));
    },
  };
}
