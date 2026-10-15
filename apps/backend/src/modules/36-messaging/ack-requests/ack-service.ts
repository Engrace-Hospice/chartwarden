// apps/backend/src/modules/36-messaging/ack-requests/ack-service.ts - WP 4.2 (ADR-0069): the acknowledgment-request aggregate.
//
// A request asks ONE named, qualified clinician to take clinical responsibility for ONE message. The clinician does so by an
// explicit authenticated action here - never by opening, reading, reacting to or tapping a push for the message. Four
// transitions (create, acknowledge, reassign, resolve) plus cancel-on-delete; each commits a row change, an append-only event
// and an id-only outbox event in ONE transaction. This service does NOT time, route, escalate or page anyone (WP 4.3 - 4.5),
// never reads message text, and never writes an order or a chart note.
//
// Authorization is decided here on every call, from the stored request and the caller's live qualification:
//   - acknowledge / resolve: ONLY the assigned user, who must still be qualified right now. A lookup ERROR propagates (the
//     caller sees a failure and retries); only a clean "no" is a refusal. Nobody acknowledges on another person's behalf.
//   - reassign: the requester or the current assignee; the new assignee must pass the same checks as at create.
//   - create: the message's author, on a patient care-team channel, naming a qualified care-team member of the channel.
// A repeat of a transition by the same actor is an idempotent success (`changed: false`: no write, no event, no outbox row).
import {
  ackClassFor,
  ackNotAcknowledged,
  ackStateInvalid,
  defaultDeadline,
  derivePatient,
} from "@wardenx/messaging";
import {
  ACK_CHANNEL_LIST_CAP,
  type AckChannelListResponse,
  type AckRequestDetailResponse,
  type AckRequestResponse,
  ForbiddenError,
  NotFoundError,
  WardenXError,
} from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";
import { toAckEventDto, toAckRequestDto } from "./ack-dto";
import {
  type AckEventFacts,
  M36_ACK_ACKNOWLEDGED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
  M36_ACK_RESOLVED,
  publishAckEvent,
} from "./ack-events";
import { type AckRow, AckStaleError, type AckStore, type AckTx } from "./ack-types";

export interface AckActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface AckServiceDeps {
  /** The flag `messaging.ack_requests`. Gates CREATION only. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly store: AckStore;
  readonly outbox: HintOutboxPort | undefined;
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly channelFacts: (
    orgId: string,
    channelId: string,
  ) => Promise<{ readonly kind: string; readonly subjectId: string | null } | null>;
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  /** Active, messaging keys, `messaging.urgent.receive`, Part 2 gate for this patient. A throw reads as "not qualified". */
  readonly isQualified: (orgId: string, userId: string, patientId: string) => Promise<boolean>;
  /**
   * The assignee's qualification NOW (active, keys, Part 2 gate for the channel's patient). A clean `false` is a refusal; a
   * THROW propagates - an acknowledgment is never refused because a lookup failed.
   */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly now?: () => Date;
}

export interface CreateAckInput {
  readonly messageId: string;
  readonly assigneeUserId: string;
}

/** What the urgent entry hands over, inside the send transaction (the message row already exists there). */
export interface UrgentAckFacts {
  readonly orgId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly patientId: string;
  readonly requesterUserId: string;
  readonly assigneeUserId: string;
}

export interface AckService {
  /** `important` (or a late request for an urgent message) on a message the caller wrote. */
  create(
    actor: AckActorRef,
    input: CreateAckInput,
  ): Promise<AckRequestResponse & { created: boolean }>;
  /** The urgent entry's hook: inside the message's own transaction. Never refuses on the flag (the caller checked it). */
  createForUrgentSend(rawTx: unknown, facts: UrgentAckFacts): Promise<void>;
  get(actor: AckActorRef, requestId: string): Promise<AckRequestDetailResponse>;
  listForChannel(actor: AckActorRef, channelId: string): Promise<AckChannelListResponse>;
  acknowledge(actor: AckActorRef, requestId: string): Promise<AckRequestResponse>;
  reassign(
    actor: AckActorRef,
    requestId: string,
    newAssigneeUserId: string,
  ): Promise<AckRequestResponse>;
  resolve(actor: AckActorRef, requestId: string): Promise<AckRequestResponse>;
}

const requestNotFound = (): NotFoundError => new NotFoundError("escalation");
const messageNotFound = (): NotFoundError => new NotFoundError("message");
const assigneeInvalid = (): WardenXError =>
  new WardenXError("ACK_ASSIGNEE_INVALID", "Choose a colleague who can take this message.", 422);

/** A port that throws answers "no" (used where a wrong "yes" is the danger: choosing an assignee). */
async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

const WAITING = ["pending", "escalated", "failed_unreachable"] as const;
const isWaiting = (s: AckRow["status"]): boolean => (WAITING as readonly string[]).includes(s);
const isOpen = (s: AckRow["status"]): boolean => isWaiting(s) || s === "acknowledged";

export function createAckService(deps: AckServiceDeps): AckService {
  const clock = deps.now ?? (() => new Date());
  const { store } = deps;

  const factsOf = (row: AckRow, actorUserId: string, at: Date): AckEventFacts => ({
    orgId: row.organizationId,
    requestId: row.id,
    messageId: row.messageId,
    channelId: row.channelId,
    ackClass: row.ackClass,
    assignedUserId: row.assignedUserId,
    actorUserId,
    version: row.version,
    at,
  });

  /** A user other than the requester who can be named: care-team member, channel member, qualified. */
  async function assignable(
    orgId: string,
    channelId: string,
    patientId: string,
    userId: string,
  ): Promise<boolean> {
    const team = await orElse(() => deps.careTeamMembers(orgId, patientId), []);
    if (!team.includes(userId)) return false;
    return orElse(
      async () =>
        (await deps.canViewChannel(orgId, userId, channelId)) &&
        (await deps.isQualified(orgId, userId, patientId)),
      false,
    );
  }

  async function patientOf(orgId: string, channelId: string): Promise<string> {
    const facts = await deps.channelFacts(orgId, channelId);
    if (!facts) throw messageNotFound();
    const patientId =
      facts.kind === "care_team" ? derivePatient(facts.kind, facts.subjectId) : null;
    if (!patientId) {
      throw new WardenXError(
        "ACK_NOT_PATIENT_CHANNEL",
        "A response request needs a patient conversation.",
        422,
      );
    }
    return patientId;
  }

  /** Reads the request and hides it from anyone who cannot see its channel (one answer for missing and hidden). */
  async function visibleRequest(actor: AckActorRef, requestId: string): Promise<AckRow> {
    const row = await store.run(actor, (tx) => tx.findById(requestId, false));
    if (!row) throw requestNotFound();
    if (!(await deps.canViewChannel(actor.orgId, actor.userId, row.channelId))) {
      throw requestNotFound();
    }
    return row;
  }

  /** Inserts the request, its first event and the outbox row inside `tx`. Returns the row and whether it is new. */
  async function insertRequest(
    tx: AckTx,
    rawTx: unknown,
    facts: UrgentAckFacts & { readonly ackClass: AckRow["ackClass"] },
    at: Date,
  ): Promise<{ readonly row: AckRow; readonly inserted: boolean }> {
    const { row, inserted } = await tx.insert({
      organizationId: facts.orgId,
      messageId: facts.messageId,
      channelId: facts.channelId,
      patientId: facts.patientId,
      ackClass: facts.ackClass,
      requesterUserId: facts.requesterUserId,
      assignedUserId: facts.assigneeUserId,
      requestedAt: at,
      deadlineAt: defaultDeadline(facts.ackClass, at),
    });
    if (!inserted) return { row, inserted };
    await tx.insertEvent({
      organizationId: row.organizationId,
      requestId: row.id,
      eventType: "requested",
      actorUserId: facts.requesterUserId,
      fromStatus: null,
      toStatus: "pending",
      assignedUserId: row.assignedUserId,
      previousAssignedUserId: null,
      tier: 0,
      at,
    });
    await publishAckEvent(
      deps.outbox,
      rawTx,
      M36_ACK_REQUESTED,
      factsOf(row, facts.requesterUserId, at),
    );
    return { row, inserted };
  }

  /** Maps a lost optimistic race to the conflict answer. */
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof AckStaleError) throw ackStateInvalid();
      // A database guard (SQLSTATE 23514) that fires on a race (a delete, a deactivation, a newer reassign) is a conflict, not a 500.
      const code =
        (err as { code?: string; cause?: { code?: string } }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23514") throw ackStateInvalid();
      throw err;
    }
  }

  const unchanged = (row: AckRow, viewer: string): AckRequestResponse => ({
    request: toAckRequestDto(row, viewer),
    changed: false,
  });

  return {
    async create(actor, input) {
      if (!(await deps.isEnabled(actor.orgId).catch(() => false))) throw messageNotFound();
      const message = await store.run(actor, (tx) => tx.messageFacts(input.messageId));
      if (!message || message.status === "deleted") throw messageNotFound();
      if (!(await deps.canViewChannel(actor.orgId, actor.userId, message.channelId))) {
        throw messageNotFound();
      }
      if (message.authorUserId !== actor.userId) {
        throw new WardenXError(
          "ACK_NOT_REQUESTER",
          "Only the author of a message can ask for a response to it.",
          403,
        );
      }
      const patientId = await patientOf(actor.orgId, message.channelId);

      // A repeat of the same request replays BEFORE any eligibility is re-run: the original was eligible when made.
      const existing = await store.run(actor, (tx) => tx.findByMessage(input.messageId, false));
      if (existing) {
        if (
          existing.assignedUserId === input.assigneeUserId &&
          existing.requesterUserId === actor.userId
        ) {
          return { ...unchanged(existing, actor.userId), created: false };
        }
        throw new WardenXError(
          "ACK_ALREADY_REQUESTED",
          "A response has already been requested for this message.",
          409,
        );
      }

      const ackClass = ackClassFor(message.urgency);
      if (ackClass === "urgent" && input.assigneeUserId !== message.urgentRecipientUserId) {
        throw assigneeInvalid();
      }
      if (
        input.assigneeUserId === actor.userId ||
        !(await assignable(actor.orgId, message.channelId, patientId, input.assigneeUserId))
      ) {
        throw assigneeInvalid();
      }

      const at = clock();
      return guarded(() =>
        store.run(actor, async (tx, rawTx) => {
          const made = await insertRequest(
            tx,
            rawTx,
            {
              orgId: actor.orgId,
              messageId: input.messageId,
              channelId: message.channelId,
              patientId,
              requesterUserId: actor.userId,
              assigneeUserId: input.assigneeUserId,
              ackClass,
            },
            at,
          );
          if (!made.inserted) {
            // Lost a race with an identical request: that one is the answer.
            const same =
              made.row.assignedUserId === input.assigneeUserId &&
              made.row.requesterUserId === actor.userId;
            if (!same) {
              throw new WardenXError(
                "ACK_ALREADY_REQUESTED",
                "A response has already been requested for this message.",
                409,
              );
            }
          }
          return {
            request: toAckRequestDto(made.row, actor.userId),
            changed: made.inserted,
            created: made.inserted,
          };
        }),
      );
    },

    async createForUrgentSend(rawTx, facts) {
      const at = clock();
      await insertRequest(
        store.bind(rawTx, facts.orgId),
        rawTx,
        { ...facts, ackClass: "urgent" },
        at,
      );
    },

    async get(actor, requestId) {
      const row = await visibleRequest(actor, requestId);
      const events = await store.run(actor, (tx) => tx.listEvents(requestId));
      return { request: toAckRequestDto(row, actor.userId), events: events.map(toAckEventDto) };
    },

    async listForChannel(actor, channelId) {
      if (!(await deps.canViewChannel(actor.orgId, actor.userId, channelId))) {
        throw new NotFoundError("channel");
      }
      const rows = await store.run(actor, (tx) =>
        tx.listForChannel(channelId, ACK_CHANNEL_LIST_CAP),
      );
      return { requests: rows.map((r) => toAckRequestDto(r, actor.userId)) };
    },

    async acknowledge(actor, requestId) {
      const seen = await visibleRequest(actor, requestId);
      if (seen.assignedUserId !== actor.userId) {
        throw new ForbiddenError("Only the person this was sent to can respond to it.");
      }
      if (seen.status === "acknowledged" && seen.acknowledgedByUserId === actor.userId) {
        return unchanged(seen, actor.userId);
      }
      if (!isWaiting(seen.status)) throw ackStateInvalid();
      if (!(await deps.stillQualified(actor.orgId, actor.userId, seen.channelId))) {
        throw new WardenXError("ACK_NOT_QUALIFIED", "Your role cannot take this message.", 403);
      }
      const at = clock();
      return guarded(() =>
        store.run(actor, async (tx, rawTx) => {
          const row = await tx.findById(requestId, true);
          if (!row) throw requestNotFound();
          if (row.assignedUserId !== actor.userId) throw ackStateInvalid();
          if (row.status === "acknowledged" && row.acknowledgedByUserId === actor.userId) {
            return unchanged(row, actor.userId);
          }
          if (!isWaiting(row.status)) throw ackStateInvalid();
          const next = await tx.update(row.id, row.version, {
            status: "acknowledged",
            acknowledgedAt: at,
            acknowledgedByUserId: actor.userId,
            updatedAt: at,
          });
          await tx.insertEvent({
            organizationId: next.organizationId,
            requestId: next.id,
            eventType: "acknowledged",
            actorUserId: actor.userId,
            fromStatus: row.status,
            toStatus: "acknowledged",
            assignedUserId: next.assignedUserId,
            previousAssignedUserId: null,
            tier: next.currentTier,
            at,
          });
          await publishAckEvent(
            deps.outbox,
            rawTx,
            M36_ACK_ACKNOWLEDGED,
            factsOf(next, actor.userId, at),
          );
          return { request: toAckRequestDto(next, actor.userId), changed: true };
        }),
      );
    },

    async resolve(actor, requestId) {
      const seen = await visibleRequest(actor, requestId);
      if (seen.assignedUserId !== actor.userId) {
        throw new ForbiddenError("Only the person this was sent to can close it.");
      }
      if (seen.status === "resolved" && seen.resolvedByUserId === actor.userId) {
        return unchanged(seen, actor.userId);
      }
      if (seen.status !== "acknowledged") {
        throw isWaiting(seen.status) ? ackNotAcknowledged() : ackStateInvalid();
      }
      if (!(await deps.stillQualified(actor.orgId, actor.userId, seen.channelId))) {
        throw new WardenXError("ACK_NOT_QUALIFIED", "Your role cannot close this message.", 403);
      }
      const at = clock();
      return guarded(() =>
        store.run(actor, async (tx, rawTx) => {
          const row = await tx.findById(requestId, true);
          if (!row) throw requestNotFound();
          if (row.assignedUserId !== actor.userId) throw ackStateInvalid();
          if (row.status === "resolved" && row.resolvedByUserId === actor.userId) {
            return unchanged(row, actor.userId);
          }
          if (row.status !== "acknowledged") {
            throw isWaiting(row.status) ? ackNotAcknowledged() : ackStateInvalid();
          }
          const next = await tx.update(row.id, row.version, {
            status: "resolved",
            resolvedAt: at,
            resolvedByUserId: actor.userId,
            updatedAt: at,
          });
          await tx.insertEvent({
            organizationId: next.organizationId,
            requestId: next.id,
            eventType: "resolved",
            actorUserId: actor.userId,
            fromStatus: "acknowledged",
            toStatus: "resolved",
            assignedUserId: next.assignedUserId,
            previousAssignedUserId: null,
            tier: next.currentTier,
            at,
          });
          await publishAckEvent(
            deps.outbox,
            rawTx,
            M36_ACK_RESOLVED,
            factsOf(next, actor.userId, at),
          );
          return { request: toAckRequestDto(next, actor.userId), changed: true };
        }),
      );
    },

    async reassign(actor, requestId, newAssigneeUserId) {
      const seen = await visibleRequest(actor, requestId);
      const isParty = actor.userId === seen.requesterUserId || actor.userId === seen.assignedUserId;
      if (!isParty) {
        throw new WardenXError(
          "ACK_NOT_PARTY",
          "Only the sender or the current assignee can reassign.",
          403,
        );
      }
      if (!isOpen(seen.status)) throw ackStateInvalid();
      if (seen.assignedUserId === newAssigneeUserId) {
        // A repeat of the reassign this very actor just made is a success; anything else names nobody new.
        const last = await store.run(actor, async (tx) => {
          const events = await tx.listEvents(seen.id);
          return events[events.length - 1];
        });
        if (last?.eventType === "reassigned" && last.actorUserId === actor.userId) {
          return unchanged(seen, actor.userId);
        }
        throw assigneeInvalid();
      }
      if (
        newAssigneeUserId === seen.requesterUserId ||
        !(await assignable(actor.orgId, seen.channelId, seen.patientId, newAssigneeUserId))
      ) {
        throw assigneeInvalid();
      }
      return guarded(() =>
        store.run(actor, async (tx, rawTx) => {
          const row = await tx.findById(requestId, true);
          if (!row) throw requestNotFound();
          const stillParty =
            actor.userId === row.requesterUserId || actor.userId === row.assignedUserId;
          if (!stillParty || !isOpen(row.status) || row.assignedUserId === newAssigneeUserId) {
            throw ackStateInvalid();
          }
          // Taken after the lock and never before the stored window: a reassign that waited behind a newer one cannot move it back.
          const at = new Date(Math.max(clock().getTime(), row.windowStartedAt.getTime()));
          // The window restarts for the new assignee; requested_at never moves.
          const next = await tx.update(row.id, row.version, {
            status: "pending",
            assignedUserId: newAssigneeUserId,
            windowStartedAt: at,
            deadlineAt: defaultDeadline(row.ackClass, at),
            currentTier: 0,
            acknowledgedAt: null,
            acknowledgedByUserId: null,
            updatedAt: at,
          });
          await tx.insertEvent({
            organizationId: next.organizationId,
            requestId: next.id,
            eventType: "reassigned",
            actorUserId: actor.userId,
            fromStatus: row.status,
            toStatus: "pending",
            assignedUserId: next.assignedUserId,
            previousAssignedUserId: row.assignedUserId,
            tier: 0,
            at,
          });
          await publishAckEvent(deps.outbox, rawTx, M36_ACK_REASSIGNED, {
            ...factsOf(next, actor.userId, at),
            previousAssignedUserId: row.assignedUserId,
          });
          return { request: toAckRequestDto(next, actor.userId), changed: true };
        }),
      );
    },
  };
}
