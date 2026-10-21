// apps/backend/src/modules/36-messaging/ack-requests/ack-supervisor.ts - ADR-0078: the reassign picker and the SUPERVISOR reassign.
//
// A supervisor (the route demands `messaging.read` + `messaging.review`) may move a request that still WAITS to an eligible colleague
// with a required fixed reason. It reads no conversation, acknowledges nothing, touches no acknowledged / resolved / cancelled request
// and never names a patient's care team to someone the Part 2 gate walls off. The permission is the route's; the database guard of
// migration 1126 is the backstop.
import { defaultDeadline } from "@wardenx/messaging";
import { ackStateInvalid } from "@wardenx/messaging";
import {
  ACK_REASSIGN_CANDIDATE_CAP,
  type AckReassignCandidate,
  type AckReassignCandidatesResponse,
  type AckSupervisorReasonCode,
  type AckSupervisorReassignResponse,
  ChartWardenError,
} from "@wardenx/types";
import { type AckEventFacts, M36_ACK_REASSIGNED, publishAckEvent } from "./ack-events";
import { assigneeInvalid, isWaiting, orElse, requestNotFound } from "./ack-shared";
import type { AckRow, AckStore } from "./ack-types";

/** At most this many supervisor reassigns of ONE request inside the rolling window: a ping-pong between supervisors stops here. */
export const SUPERVISOR_REASSIGN_CAP = 5;
export const SUPERVISOR_REASSIGN_WINDOW_MS = 24 * 3_600_000;

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

export interface SupervisorContext {
  readonly deps: {
    readonly outbox: Parameters<typeof publishAckEvent>[0];
    readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
    readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
    readonly isQualified: (orgId: string, userId: string, patientId: string) => Promise<boolean>;
    readonly part2Admitted: (orgId: string, userId: string, patientId: string) => Promise<boolean>;
    readonly displayName?: (orgId: string, userId: string) => Promise<string | null>;
  };
  readonly store: AckStore;
  readonly clock: () => Date;
  readonly assignable: (
    orgId: string,
    channelId: string,
    patientId: string,
    userId: string,
  ) => Promise<boolean>;
  readonly factsOf: (row: AckRow, actorUserId: string, at: Date) => AckEventFacts;
  readonly guarded: <T>(work: () => Promise<T>, ids: Record<string, string>) => Promise<T>;
}

const limitReached = (): ChartWardenError =>
  new ChartWardenError(
    "ACK_SUPERVISOR_REASSIGN_LIMIT",
    "This request has been moved several times today. Ask the clinical lead to decide who takes it.",
    409,
  );

export function createAckSupervisor(ctx: SupervisorContext) {
  const { deps, store, clock } = ctx;

  /** The picker: bounded BEFORE the per-person checks, never the sender or the current assignee, ids and names only. */
  async function candidatesFor(row: AckRow): Promise<AckReassignCandidatesResponse> {
    const qualified = (userId: string): Promise<boolean> =>
      orElse(
        async () =>
          (await deps.canViewChannel(row.organizationId, userId, row.channelId)) &&
          (await deps.isQualified(row.organizationId, userId, row.patientId)),
        false,
      );
    const ids = [
      ...(await orElse(() => deps.careTeamMembers(row.organizationId, row.patientId), [])),
    ]
      .filter(
        (id, i, all) =>
          id !== row.requesterUserId && id !== row.assignedUserId && all.indexOf(id) === i,
      )
      .sort()
      .slice(0, ACK_REASSIGN_CANDIDATE_CAP * 2);
    const candidates: AckReassignCandidate[] = [];
    for (const id of ids) {
      if (candidates.length >= ACK_REASSIGN_CANDIDATE_CAP) break;
      if (!(await qualified(id))) continue;
      const name = deps.displayName
        ? await orElse(() => deps.displayName!(row.organizationId, id), null)
        : null;
      candidates.push({ user_id: id, display_name: name });
    }
    candidates.sort(
      (x, y) =>
        (x.display_name ?? "").localeCompare(y.display_name ?? "") ||
        x.user_id.localeCompare(y.user_id),
    );
    return { candidates };
  }

  /** A request read by a supervisor: no channel-visibility check (the route demanded `messaging.review`); RLS still scopes the tenant. */
  async function supervisedRequest(actor: Actor, requestId: string): Promise<AckRow> {
    const row = await store.run(actor, (tx) => tx.findById(requestId, false));
    if (!row) throw requestNotFound();
    return row;
  }

  /** A supervisor the Part 2 gate walls off from the patient learns nothing about the care team and cannot move the request. */
  const admitted = (actor: Actor, row: AckRow): Promise<boolean> =>
    orElse(() => deps.part2Admitted(actor.orgId, actor.userId, row.patientId), false);

  const recentSupervisorMoves = (
    events: readonly { eventType: string; reasonCode?: string | null; createdAt: Date }[],
  ): number => {
    const since = clock().getTime() - SUPERVISOR_REASSIGN_WINDOW_MS;
    return events.filter(
      (e) => e.eventType === "reassigned" && e.reasonCode && e.createdAt.getTime() >= since,
    ).length;
  };

  async function candidates(
    actor: Actor,
    requestId: string,
  ): Promise<AckReassignCandidatesResponse> {
    const seen = await supervisedRequest(actor, requestId);
    // The wall comes first: a walled-off supervisor gets the same empty list whatever state the request is in.
    if (!(await admitted(actor, seen))) return { candidates: [] };
    if (!isWaiting(seen.status)) throw ackStateInvalid();
    return candidatesFor(seen);
  }

  async function reassign(
    actor: Actor,
    requestId: string,
    newAssigneeUserId: string,
    reasonCode: AckSupervisorReasonCode,
  ): Promise<AckSupervisorReassignResponse> {
    const seen = await supervisedRequest(actor, requestId);
    const response = (row: AckRow, changed: boolean): AckSupervisorReassignResponse => ({
      request_ref: row.id,
      status: "pending",
      assigned_user_id: row.assignedUserId,
      deadline_at: row.deadlineAt.toISOString(),
      changed,
    });
    // A supervisor never assigns a request to themselves: the person who moves it is not the person who takes it.
    if (newAssigneeUserId === actor.userId) throw assigneeInvalid();
    // The wall comes first: a walled-off supervisor gets the same uniform 422 whatever state the request is in (and no repeat path).
    if (!(await admitted(actor, seen))) throw assigneeInvalid();
    if (seen.assignedUserId === newAssigneeUserId) {
      // A repeat of the reassign this very supervisor just made (same reason) is a success; anything else names nobody new.
      const last = await store.run(actor, async (tx) => {
        const events = await tx.listEvents(seen.id);
        return events[events.length - 1];
      });
      if (
        seen.status === "pending" &&
        last?.eventType === "reassigned" &&
        last.actorUserId === actor.userId &&
        last.reasonCode === reasonCode
      ) {
        return response(seen, false);
      }
      throw isWaiting(seen.status) ? assigneeInvalid() : ackStateInvalid();
    }
    if (!isWaiting(seen.status)) throw ackStateInvalid();
    if (
      newAssigneeUserId === seen.requesterUserId ||
      !(await ctx.assignable(actor.orgId, seen.channelId, seen.patientId, newAssigneeUserId))
    ) {
      throw assigneeInvalid();
    }
    return ctx.guarded(
      () =>
        store.run(actor, async (tx, rawTx) => {
          const row = await tx.findById(requestId, true);
          if (!row) throw requestNotFound();
          // Re-decided on the locked row: acknowledged, closed or already moved since the first read is a conflict.
          if (!isWaiting(row.status) || row.assignedUserId === newAssigneeUserId) {
            throw ackStateInvalid();
          }
          if (recentSupervisorMoves(await tx.listEvents(row.id)) >= SUPERVISOR_REASSIGN_CAP) {
            throw limitReached();
          }
          const at = new Date(Math.max(clock().getTime(), row.windowStartedAt.getTime()));
          await tx.allowSupervisorReassign();
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
            reasonCode,
          });
          await publishAckEvent(deps.outbox, rawTx, M36_ACK_REASSIGNED, {
            ...ctx.factsOf(next, actor.userId, at),
            previousAssignedUserId: row.assignedUserId,
            supervisorReassign: true,
            requesterUserId: next.requesterUserId,
          });
          return response(next, true);
        }),
      { organizationId: actor.orgId, requestId },
    );
  }

  return { candidatesFor, candidates, reassign };
}
