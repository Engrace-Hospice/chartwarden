// apps/backend/src/modules/36-messaging/ack-requests/ack-store-db.ts - WP 4.2: the Drizzle store behind the acknowledgment-request
// service. Every statement names the organization on top of RLS. `wardenx_app` may UPDATE only the transition columns and has
// no DELETE; the event table takes INSERT only. Transitions take the row FOR UPDATE and carry the expected version, so two
// racing writers serialise and the loser sees the winner's state (a repeat or a conflict), never a lost update. The database
// triggers (migration 1107) refuse any transition off the table, whatever this code does.
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { ACK_OPEN_STATUSES } from "@wardenx/types";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";
import {
  type AckEventRow,
  type AckMessageFacts,
  type AckPatch,
  type AckRow,
  AckStaleError,
  type AckStore,
  type AckTx,
  type NewAckEvent,
  type NewAckRequest,
} from "./ack-types";

const R = schema.messageAckRequests;
const E = schema.messageAckEvents;
const MSG = schema.messages;

type RequestRow = typeof R.$inferSelect;
type EventRow = typeof E.$inferSelect;

const toRow = (r: RequestRow): AckRow => ({
  id: r.id,
  organizationId: r.organizationId,
  messageId: r.messageId,
  channelId: r.channelId,
  patientId: r.patientId,
  ackClass: r.ackClass,
  status: r.status,
  requesterUserId: r.requesterUserId,
  assignedUserId: r.assignedUserId,
  requestedAt: r.requestedAt,
  windowStartedAt: r.windowStartedAt,
  deadlineAt: r.deadlineAt,
  currentTier: r.currentTier,
  acknowledgedAt: r.acknowledgedAt,
  acknowledgedByUserId: r.acknowledgedByUserId,
  resolvedAt: r.resolvedAt,
  resolvedByUserId: r.resolvedByUserId,
  cancelledAt: r.cancelledAt,
  version: r.version,
});

const toEvent = (e: EventRow): AckEventRow => ({
  id: e.id,
  eventType: e.eventType,
  actorUserId: e.actorUserId,
  actorKind: e.actorKind === "system" ? "system" : "user",
  fromStatus: e.fromStatus,
  toStatus: e.toStatus,
  assignedUserId: e.assignedUserId,
  previousAssignedUserId: e.previousAssignedUserId,
  tier: e.tier,
  createdAt: e.createdAt,
});

/** One transaction's view of the aggregate for `orgId`. */
export function ackTxOver(tx: Tx, orgId: string): AckTx {
  return {
    async findById(id, lock) {
      const q = tx
        .select()
        .from(R)
        .where(and(eq(R.organizationId, orgId), eq(R.id, id)))
        .limit(1);
      const [row] = await (lock ? q.for("update") : q);
      return row ? toRow(row) : null;
    },

    async findByMessage(messageId, lock) {
      const q = tx
        .select()
        .from(R)
        .where(and(eq(R.organizationId, orgId), eq(R.messageId, messageId)))
        .limit(1);
      const [row] = await (lock ? q.for("update") : q);
      return row ? toRow(row) : null;
    },

    async insert(n: NewAckRequest) {
      const [created] = await tx
        .insert(R)
        .values({
          organizationId: orgId,
          messageId: n.messageId,
          channelId: n.channelId,
          patientId: n.patientId,
          ackClass: n.ackClass,
          requesterUserId: n.requesterUserId,
          assignedUserId: n.assignedUserId,
          requestedAt: n.requestedAt,
          windowStartedAt: n.requestedAt,
          deadlineAt: n.deadlineAt,
        })
        .onConflictDoNothing({ target: [R.organizationId, R.messageId] })
        .returning();
      if (created) return { row: toRow(created), inserted: true };
      const [existing] = await tx
        .select()
        .from(R)
        .where(and(eq(R.organizationId, orgId), eq(R.messageId, n.messageId)))
        .limit(1);
      if (!existing) throw new AckStaleError();
      return { row: toRow(existing), inserted: false };
    },

    async update(id, expectedVersion, patch: AckPatch) {
      const [updated] = await tx
        .update(R)
        .set({ ...patch, version: expectedVersion + 1 })
        .where(and(eq(R.organizationId, orgId), eq(R.id, id), eq(R.version, expectedVersion)))
        .returning();
      if (!updated) throw new AckStaleError();
      return toRow(updated);
    },

    async insertEvent(e: NewAckEvent) {
      await tx.insert(E).values({
        organizationId: orgId,
        requestId: e.requestId,
        eventType: e.eventType,
        actorUserId: e.actorUserId,
        actorKind: e.actorUserId ? "user" : "system",
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        assignedUserId: e.assignedUserId,
        previousAssignedUserId: e.previousAssignedUserId,
        tier: e.tier,
        createdAt: e.at,
      });
    },

    async listEvents(requestId) {
      const rows = await tx
        .select()
        .from(E)
        .where(and(eq(E.organizationId, orgId), eq(E.requestId, requestId)))
        .orderBy(asc(E.createdAt), asc(E.id));
      return rows.map(toEvent);
    },

    // Every OPEN request first (an old unanswered one is the most important row and must never fall off the cap), then the
    // most recent closed ones up to what is left of the cap.
    async listForChannel(channelId, limit) {
      const open = [...ACK_OPEN_STATUSES];
      const inChannel = and(eq(R.organizationId, orgId), eq(R.channelId, channelId));
      const openRows = await tx
        .select()
        .from(R)
        .where(and(inChannel, inArray(R.status, open)))
        .orderBy(desc(R.requestedAt), desc(R.id));
      const closedRows =
        limit > openRows.length
          ? await tx
              .select()
              .from(R)
              .where(and(inChannel, notInArray(R.status, open)))
              .orderBy(desc(R.requestedAt), desc(R.id))
              .limit(limit - openRows.length)
          : [];
      return [...openRows, ...closedRows].map(toRow);
    },

    async messageFacts(messageId): Promise<AckMessageFacts | null> {
      const [m] = await tx
        .select({
          channelId: MSG.channelId,
          authorUserId: MSG.authorUserId,
          status: MSG.status,
          urgency: MSG.urgency,
          urgentRecipientUserId: MSG.urgentRecipientUserId,
        })
        .from(MSG)
        .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, messageId)))
        .limit(1);
      return m ?? null;
    },
  };
}

export function createDbAckStore(db: DbClient): AckStore {
  return {
    run: (actor, fn) =>
      withOrgContext(db, { organizationId: actor.orgId, userId: actor.userId }, (tx) =>
        fn(ackTxOver(tx as unknown as Tx, actor.orgId), tx),
      ),
    readAsSystem: (orgId, fn) =>
      withOrgContext(db, systemOrgContext(orgId), (tx) =>
        fn(ackTxOver(tx as unknown as Tx, orgId)),
      ),
    bind: (rawTx, orgId) => ackTxOver(rawTx as Tx, orgId),
  };
}
