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
//   - reassign: the CURRENT ASSIGNEE at any open state (a hand-off needs no qualification check: it must never strand the item);
//     the requester only until the request is taken, and then only while they still hold `messaging.urgent.send` (a lookup
//     ERROR propagates). The new assignee must pass the same checks as at create. The prior acknowledgment stays in the history.
//   - create: the message's author, on a patient care-team channel, naming a qualified care-team member of the channel.
// A repeat of a transition by the same actor is an idempotent success (`changed: false`: no write, no event, no outbox row).
import {
  ackClassFor,
  ackNotAcknowledged,
  ackStateInvalid,
  defaultDeadline,
  derivePatient,
} from "@chartwarden/messaging";
import {
  ACK_CHANNEL_LIST_CAP,
  type AckChannelListResponse,
  type AckReasonCode,
  type AckReassignCandidatesResponse,
  type AckRequestDetailResponse,
  type AckRequestResponse,
  type AckSupervisorReassignResponse,
  ChartWardenError,
  ForbiddenError,
  NotFoundError,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";
import { toAckEventDto, toAckRequestDto } from "./ack-dto";
import { escalationNotes } from "./ack-escalation-note";
import {
  type AckEventFacts,
  M36_ACK_ACKNOWLEDGED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
  M36_ACK_RESOLVED,
  publishAckEvent,
} from "./ack-events";
import { assigneeInvalid, isOpen, isWaiting, orElse, requestNotFound } from "./ack-shared";
import { createAckSupervisor } from "./ack-supervisor";
import { type AckRow, AckStaleError, type AckStore, type AckTx } from "./ack-types";

export interface AckActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface AckServiceDeps {
  /** The flag `messaging.ack_requests`. Gates CREATION only. A clean false is "not found"; a THROW is 503 (never a fake 404). */
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
  /** Does the user hold the keys to raise a request (`messaging.send` + `messaging.urgent.send`) right now? A throw propagates. */
  readonly canRaise: (orgId: string, userId: string) => Promise<boolean>;
  /** The display name of a colleague for the reassign pickers; absent or a throw reads as "no name" (the id still identifies them). */
  /** ADR-0078: is this user admitted by the Part 2 gate for the patient? A supervisor who is not is shown no candidates. REQUIRED: a missing gate must never admit anyone. */
  readonly part2Admitted: (orgId: string, userId: string, patientId: string) => Promise<boolean>;
  readonly displayName?: (orgId: string, userId: string) => Promise<string | null>;
  /** Warn-level, ids and a constraint name only (never a name, patient or text). Defaults to console.warn. */
  readonly log?: (message: string, context: Record<string, string>) => void;
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
  /** ADR-0081: the role the sender addressed (role-based send), absent when a person was named. */
  readonly addressedRole?: string | undefined;
}

export interface AckService {
  /** `important` (or a late request for an urgent message) on a message the caller wrote. */
  create(
    actor: AckActorRef,
    input: CreateAckInput,
  ): Promise<AckRequestResponse & { created: boolean }>;
  /** The urgent entry's hook: inside the message's own transaction. Never refuses on the flag (the caller checked it). */
  /** Returns the id of the request (ADR-0082: the after-hours link row and its event name it). */
  createForUrgentSend(rawTx: unknown, facts: UrgentAckFacts): Promise<{ readonly requestId: string }>;
  get(actor: AckActorRef, requestId: string): Promise<AckRequestDetailResponse>;
  listForChannel(actor: AckActorRef, channelId: string): Promise<AckChannelListResponse>;
  acknowledge(actor: AckActorRef, requestId: string): Promise<AckRequestResponse>;
  reassign(
    actor: AckActorRef,
    requestId: string,
    newAssigneeUserId: string,
  ): Promise<AckRequestResponse>;
  resolve(actor: AckActorRef, requestId: string): Promise<AckRequestResponse>;
  /** ADR-0078 (G-6): who the sender or assignee may hand THIS request to (same visibility and party rules as `reassign`). */
  reassignCandidates(actor: AckActorRef, requestId: string): Promise<AckReassignCandidatesResponse>;
  /** ADR-0078 (G-2): the same for a supervisor (the route demands `messaging.review`); works on a request they cannot open. */
  supervisorReassignCandidates(
    actor: AckActorRef,
    requestId: string,
  ): Promise<AckReassignCandidatesResponse>;
  /**
   * ADR-0078 (G-2): a supervisor moves a WAITING request to an eligible colleague with a required fixed reason. It reads no conversation,
   * acknowledges nothing and touches no acknowledged, resolved or cancelled request; the new assignee passes the normal reassign checks.
   */
  supervisorReassign(
    actor: AckActorRef,
    requestId: string,
    newAssigneeUserId: string,
    reasonCode: AckReasonCode,
  ): Promise<AckSupervisorReassignResponse>;
}

const messageNotFound = (): NotFoundError => new NotFoundError("message");
const unavailable = (): ChartWardenError =>
  new ChartWardenError(
    "ACK_UNAVAILABLE",
    "Response requests are unavailable right now. Try again.",
    503,
  );
interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

/** The driver error behind a (possibly wrapped) failure: the first error in the cause chain that carries a SQLSTATE. */
function pgErrorOf(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (typeof (current as PgErrorLike).code === "string") return current as PgErrorLike;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The migration-1107 guards (CHECK constraint or trigger) all carry this prefix in `constraint` or the message. */
const ACK_GUARD_NAME = /^message_ack_(?:request|event)[a-z_]*/;

/** The name of the ack guard that fired (SQLSTATE 23514), or null for any other failure (including other 23514s). */
export function ackGuardName(err: unknown): string | null {
  const pg = pgErrorOf(err);
  if (pg?.code !== "23514") return null;
  const hit = ACK_GUARD_NAME.exec(pg.constraint ?? "") ?? ACK_GUARD_NAME.exec(pg.message ?? "");
  return hit ? hit[0] : null;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : "unknown");

/** Who may reassign: the current assignee; the requester only until the request is taken. Null when allowed. */
function reassignDenied(actorId: string, row: AckRow): ChartWardenError | null {
  if (actorId === row.assignedUserId) return null;
  if (actorId !== row.requesterUserId) {
    return new ChartWardenError(
      "ACK_NOT_PARTY",
      "Only the sender or the current assignee can reassign.",
      403,
    );
  }
  if (row.status === "acknowledged") {
    return new ChartWardenError(
      "ACK_NOT_ASSIGNEE",
      "Only the person who took responsibility can hand it on.",
      403,
    );
  }
  return null;
}

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
      throw new ChartWardenError(
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
      addressedRole: facts.addressedRole,
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

  const log =
    deps.log ??
    ((message, context) => console.warn(`[m36:ack] ${message}`, JSON.stringify(context)));

  /** Maps a lost optimistic race, or a KNOWN database guard that fired on a race, to the conflict answer. */
  async function guarded<T>(work: () => Promise<T>, ids: Record<string, string>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof AckStaleError) throw ackStateInvalid();
      const guard = ackGuardName(err);
      if (guard) {
        // A delete, a deactivation or a newer reassign that won the race: a conflict, not a fault. The name says which guard.
        log("database guard refused a transition", { ...ids, guard });
        throw ackStateInvalid();
      }
      const pg = pgErrorOf(err);
      if (pg?.code === "23514") {
        log("unmapped check violation", { ...ids, constraint: pg.constraint ?? "unknown" });
      }
      throw err;
    }
  }

  const supervisor = createAckSupervisor({
    deps,
    store,
    clock,
    assignable,
    factsOf,
    guarded,
  });

  const unchanged = (row: AckRow, viewer: string): AckRequestResponse => ({
    request: toAckRequestDto(row, viewer),
    changed: false,
  });

  return {
    async create(actor, input) {
      // A clean "off" hides the feature (404); a failed flag read is not "off" and not "no such message": 503, retry.
      const enabled = await deps.isEnabled(actor.orgId).catch((err: unknown) => {
        log("flag read failed on create", { organizationId: actor.orgId, reason: errorName(err) });
        throw unavailable();
      });
      if (!enabled) throw messageNotFound();
      const message = await store.run(actor, (tx) => tx.messageFacts(input.messageId));
      if (!message || message.status === "deleted") throw messageNotFound();
      if (!(await deps.canViewChannel(actor.orgId, actor.userId, message.channelId))) {
        throw messageNotFound();
      }
      if (message.authorUserId !== actor.userId) {
        throw new ChartWardenError(
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
        throw new ChartWardenError(
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
      return guarded(
        () =>
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
                throw new ChartWardenError(
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
        { organizationId: actor.orgId, messageId: input.messageId },
      );
    },

    async createForUrgentSend(rawTx, facts) {
      const at = clock();
      try {
        const { row } = await insertRequest(
          store.bind(rawTx, facts.orgId),
          rawTx,
          { ...facts, ackClass: "urgent" },
          at,
        );
        return { requestId: row.id };
      } catch (err) {
        // The send fails whole (message and request roll back together); the log names the guard and ids only.
        const pg = pgErrorOf(err);
        log("urgent send could not create its request", {
          organizationId: facts.orgId,
          messageId: facts.messageId,
          channelId: facts.channelId,
          guard: ackGuardName(err) ?? pg?.constraint ?? pg?.code ?? errorName(err),
        });
        throw err;
      }
    },

    async get(actor, requestId) {
      const row = await visibleRequest(actor, requestId);
      const { events, notes } = await store.run(actor, async (tx) => ({
        events: await tx.listEvents(requestId),
        notes: await escalationNotes(tx, [row], clock()),
      }));
      return {
        request: toAckRequestDto(row, actor.userId, notes.get(row.id) ?? null),
        events: events.map(toAckEventDto),
      };
    },

    async listForChannel(actor, channelId) {
      if (!(await deps.canViewChannel(actor.orgId, actor.userId, channelId))) {
        throw new NotFoundError("channel");
      }
      const { rows, notes } = await store.run(actor, async (tx) => {
        const listed = await tx.listForChannel(channelId, ACK_CHANNEL_LIST_CAP);
        return { rows: listed, notes: await escalationNotes(tx, listed, clock()) };
      });
      return {
        requests: rows.map((r) => toAckRequestDto(r, actor.userId, notes.get(r.id) ?? null)),
      };
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
        throw new ChartWardenError("ACK_NOT_QUALIFIED", "Your role cannot take this message.", 403);
      }
      const at = clock();
      return guarded(
        () =>
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
        { organizationId: actor.orgId, requestId },
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
        throw new ChartWardenError(
          "ACK_NOT_QUALIFIED",
          "Your role cannot close this message.",
          403,
        );
      }
      const at = clock();
      return guarded(
        () =>
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
        { organizationId: actor.orgId, requestId },
      );
    },

    async reassign(actor, requestId, newAssigneeUserId) {
      const seen = await visibleRequest(actor, requestId);
      const denied = reassignDenied(actor.userId, seen);
      if (denied) throw denied;
      // The sender hands on only while they still hold the right to raise a request. The assignee needs no such check: a
      // hand-off must work even when their own role lapsed, or the item would strand with them. A lookup ERROR propagates.
      if (
        actor.userId === seen.requesterUserId &&
        isOpen(seen.status) &&
        !(await deps.canRaise(actor.orgId, actor.userId))
      ) {
        throw new ForbiddenError("You can no longer send response requests.");
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
      return guarded(
        () =>
          store.run(actor, async (tx, rawTx) => {
            const row = await tx.findById(requestId, true);
            if (!row) throw requestNotFound();
            // Re-decided on the locked row: a request taken or handed on since the first read changes who may reassign.
            if (
              reassignDenied(actor.userId, row) ||
              !isOpen(row.status) ||
              row.assignedUserId === newAssigneeUserId
            ) {
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
        { organizationId: actor.orgId, requestId },
      );
    },

    async reassignCandidates(actor, requestId) {
      const seen = await visibleRequest(actor, requestId);
      const denied = reassignDenied(actor.userId, seen);
      if (denied) throw denied;
      if (!isOpen(seen.status)) throw ackStateInvalid();
      return supervisor.candidatesFor(seen);
    },

    supervisorReassignCandidates: supervisor.candidates,
    supervisorReassign: supervisor.reassign,
  };
}
