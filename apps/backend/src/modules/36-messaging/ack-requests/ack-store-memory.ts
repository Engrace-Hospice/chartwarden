// apps/backend/src/modules/36-messaging/ack-requests/ack-store-memory.ts - WP 4.2: an in-memory twin of the store for the service's
// unit tests. It mirrors the unique-per-message arbiter and the optimistic version; the state machine itself is the service's
// (and, in production, the database trigger's) - the live suite proves that one.
import { unroutedRetryDue } from "@chartwarden/messaging";
import { ACK_OPEN_STATUSES } from "@chartwarden/types";
import {
  type AckEscalation,
  type AckEventRow,
  type AckMessageFacts,
  type AckPatch,
  type AckRow,
  AckStaleError,
  type AckStore,
  type AckTx,
  type NewAckEvent,
  type NewAckRequest,
  type UnroutedSummary,
} from "./ack-types";

export interface MemoryAckStore extends AckStore {
  /** Test seam (WP 4.4): the clock the memory store uses for the window an escalation starts (the DB's now() in production). */
  now: () => Date;
  /** Test seam: the messages the service can see. */
  readonly messages: Map<string, AckMessageFacts>;
  readonly requests: Map<string, AckRow>;
  readonly events: Array<NewAckEvent & { readonly id: string }>;
}

export function createMemoryAckStore(): MemoryAckStore {
  const messages = new Map<string, AckMessageFacts>();
  const requests = new Map<string, AckRow>();
  const events: Array<NewAckEvent & { readonly id: string }> = [];
  let seq = 0;
  const clock = { now: () => new Date() };
  const nextId = (): string => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  };

  const txFor = (orgId: string): AckTx => ({
    async findById(id) {
      const r = requests.get(id);
      return r && r.organizationId === orgId ? r : null;
    },
    async findByMessage(messageId) {
      for (const r of requests.values()) {
        if (r.organizationId === orgId && r.messageId === messageId) return r;
      }
      return null;
    },
    async insert(n: NewAckRequest) {
      for (const r of requests.values()) {
        if (r.organizationId === orgId && r.messageId === n.messageId) {
          return { row: r, inserted: false };
        }
      }
      const row: AckRow = {
        id: nextId(),
        organizationId: orgId,
        messageId: n.messageId,
        channelId: n.channelId,
        patientId: n.patientId,
        ackClass: n.ackClass,
        addressedRole: n.addressedRole ?? null,
        status: "pending",
        requesterUserId: n.requesterUserId,
        assignedUserId: n.assignedUserId,
        requestedAt: n.requestedAt,
        windowStartedAt: n.requestedAt,
        deadlineAt: n.deadlineAt,
        currentTier: 0,
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        resolvedAt: null,
        resolvedByUserId: null,
        cancelledAt: null,
        version: 0,
      };
      requests.set(row.id, row);
      return { row, inserted: true };
    },
    async update(id, expectedVersion, patch: AckPatch) {
      const cur = requests.get(id);
      if (!cur || cur.organizationId !== orgId || cur.version !== expectedVersion) {
        throw new AckStaleError();
      }
      const next: AckRow = { ...cur, ...patch, version: expectedVersion + 1 };
      requests.set(id, next);
      return next;
    },
    async allowSupervisorReassign() {},
    async insertEvent(e) {
      events.push({ ...e, id: nextId() });
    },
    async escalate(id, expectedVersion, e: AckEscalation) {
      const cur = requests.get(id);
      if (!cur || cur.organizationId !== orgId || cur.version !== expectedVersion) {
        throw new AckStaleError();
      }
      const start = clock.now();
      const next: AckRow = {
        ...cur,
        status: "escalated",
        assignedUserId: e.assignedUserId,
        currentTier: e.tier,
        windowStartedAt: start,
        deadlineAt: new Date(start.getTime() + e.windowMinutes * 60_000),
        version: expectedVersion + 1,
      };
      requests.set(id, next);
      return next;
    },
    async unroutedSummary(reqs) {
      const out = new Map<string, UnroutedSummary>();
      for (const r of reqs) {
        const own = events
          .filter(
            (e) =>
              e.organizationId === orgId &&
              e.requestId === r.id &&
              (e.eventType === "route_unavailable" || e.eventType === "ladder_exhausted") &&
              e.at.getTime() >= r.windowStartedAt.getTime(),
          )
          .sort((x, y) => y.at.getTime() - x.at.getTime());
        const newest = own[0];
        if (newest) {
          out.set(r.id, {
            count: own.length,
            ladderCount: own.filter((e) => e.eventType === "ladder_exhausted").length,
            lastAt: newest.at,
            lastType: newest.eventType as UnroutedSummary["lastType"],
          });
        }
      }
      return out;
    },
    async listDue(asOf, limit) {
      const waiting = [...requests.values()].filter(
        (r) =>
          r.organizationId === orgId &&
          (r.status === "pending" || r.status === "escalated") &&
          r.deadlineAt.getTime() <= asOf.getTime(),
      );
      const summary = await this.unroutedSummary(waiting);
      return waiting
        .filter((r) => {
          const u = summary.get(r.id);
          return !u || unroutedRetryDue(u.count, u.lastAt.getTime(), asOf.getTime());
        })
        .sort((a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async listUnreachableOverdue(asOf, limit, since) {
      return [...requests.values()]
        .filter(
          (r) =>
            r.organizationId === orgId &&
            r.status === "failed_unreachable" &&
            r.deadlineAt.getTime() <= asOf.getTime() &&
            Math.max(r.deadlineAt.getTime(), r.updatedAt?.getTime() ?? 0) > since.getTime(),
        )
        .sort((a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async listEvents(requestId) {
      return events
        .filter((e) => e.requestId === requestId && e.organizationId === orgId)
        .map(
          (e): AckEventRow => ({
            id: e.id,
            eventType: e.eventType,
            actorUserId: e.actorUserId,
            actorKind: e.actorUserId ? "user" : "system",
            fromStatus: e.fromStatus,
            toStatus: e.toStatus,
            assignedUserId: e.assignedUserId,
            previousAssignedUserId: e.previousAssignedUserId,
            tier: e.tier,
            createdAt: e.at,
            reasonCode: e.reasonCode ?? null,
          }),
        );
    },
    async listForChannel(channelId, limit) {
      const inChannel = [...requests.values()]
        .filter((r) => r.organizationId === orgId && r.channelId === channelId)
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
      const isOpen = (r: { status: string }) =>
        (ACK_OPEN_STATUSES as readonly string[]).includes(r.status);
      const open = inChannel.filter(isOpen);
      return [
        ...open,
        ...inChannel.filter((r) => !isOpen(r)).slice(0, Math.max(0, limit - open.length)),
      ];
    },
    async messageFacts(messageId) {
      return messages.get(messageId) ?? null;
    },
  });

  return {
    messages,
    requests,
    events,
    get now() {
      return clock.now;
    },
    set now(fn: () => Date) {
      clock.now = fn;
    },
    runAsSystem: (orgId, fn) => fn(txFor(orgId), {}),
    run: (actor, fn) => fn(txFor(actor.orgId), {}),
    readAsSystem: (orgId, fn) => fn(txFor(orgId)),
    bind: (_raw, orgId) => txFor(orgId),
  };
}
