// apps/backend/src/modules/36-messaging/ack-requests/unacknowledged-service.ts - WP 4.9 (ADR-0076): the supervisor's unacknowledged queue.
// The reader lists every waiting request in the organisation; THIS step re-checks channel visibility for the viewer on every item (the
// same `canViewChannel` the rest of M36 uses: membership and the Part 2 gate) and turns a request the viewer cannot open into a
// `restricted` row: the request, channel, message and patient ids are withheld (they would name a conversation the viewer may not
// enter), and so is the assignee's id. What stays is what a supervisor needs to chase it without learning who it is about: the
// assignee's display name, the class, the status, the times, the tier and the note. It is still listed and still counted, never
// invisible. ADR-0078 adds two fields to EVERY row, restricted or not: the sender's display name (the same disclosure class as the
// assignee's, OPEN for compliance review) and `request_ref`, the request's own id as the handle the supervisor reassign acts on (it opens
// nothing: every route that reads a request, thread or patient still answers 404 to a viewer who cannot see the channel). A visibility check that throws withholds the ids (fail closed); it does not drop the item. No message text is ever read.
import type { AckQueueItemDto, AckQueueResponse, AckQueueStatus } from "@chartwarden/types";
import {
  ACK_QUEUE_LIMIT_DEFAULT,
  ACK_QUEUE_LIMIT_MAX,
  toAckAddressedRole,
} from "@chartwarden/types";
import type { QueueRow, UnacknowledgedReader } from "./unacknowledged-reader-db";

export interface UnacknowledgedActor {
  readonly orgId: string;
  readonly userId: string;
}

export interface UnacknowledgedFilters {
  readonly status?: AckQueueStatus | undefined;
  readonly overdue?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** WP 6.1: service-level only (the route does not expose it): only the requests assigned to this user. */
  readonly assignedUserId?: string | undefined;
}

export interface UnacknowledgedService {
  list(actor: UnacknowledgedActor, filters: UnacknowledgedFilters): Promise<AckQueueResponse>;
}

export interface UnacknowledgedServiceDeps {
  readonly read: UnacknowledgedReader;
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

/** Bounds the per-page name lookups; the page itself is capped at ACK_QUEUE_LIMIT_MAX distinct assignees. */
const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(Math.trunc(limit ?? ACK_QUEUE_LIMIT_DEFAULT), 1), ACK_QUEUE_LIMIT_MAX);

function overdueSecondsOf(deadlineAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - deadlineAt.getTime()) / 1000));
}

export function createUnacknowledgedService(
  deps: UnacknowledgedServiceDeps,
): UnacknowledgedService {
  const clock = deps.now ?? (() => new Date());

  async function visibleChannels(
    actor: UnacknowledgedActor,
    rows: readonly QueueRow[],
  ): Promise<ReadonlySet<string>> {
    const visible = new Set<string>();
    for (const channelId of new Set(rows.map((r) => r.row.channelId))) {
      const allowed = await deps
        .canViewChannel(actor.orgId, actor.userId, channelId)
        .catch(() => false);
      if (allowed) visible.add(channelId);
    }
    return visible;
  }

  async function namesOf(
    actor: UnacknowledgedActor,
    rows: readonly QueueRow[],
  ): Promise<ReadonlyMap<string, string | null>> {
    const names = new Map<string, string | null>();
    // ADR-0078 (G-7): the sender's name is looked up with the assignee's, one lookup per distinct person, bounded by the page.
    const people = new Set(rows.flatMap((r) => [r.row.assignedUserId, r.row.requesterUserId]));
    for (const id of people) {
      names.set(id, await deps.displayName(actor.orgId, id).catch(() => null));
    }
    return names;
  }

  return {
    async list(actor, filters) {
      const now = clock();
      const page = await deps.read(actor.orgId, actor.userId, {
        status: filters.status ?? null,
        overdueOnly: filters.overdue === true,
        cursor: filters.cursor ?? null,
        limit: clampLimit(filters.limit),
        now,
        assignedUserId: filters.assignedUserId,
      });
      const visible = await visibleChannels(actor, page.rows);
      const names = await namesOf(actor, page.rows);
      const items = page.rows.map(({ row, note }): AckQueueItemDto => {
        const overdueSeconds = overdueSecondsOf(row.deadlineAt, now);
        const common = {
          status: row.status as AckQueueStatus,
          requested_at: row.requestedAt.toISOString(),
          deadline_at: row.deadlineAt.toISOString(),
          overdue: row.deadlineAt.getTime() <= now.getTime(),
          overdue_seconds: overdueSeconds,
          delivery_failed: row.status === "failed_unreachable",
          requester_display_name: names.get(row.requesterUserId) ?? null,
          request_ref: row.id,
        };
        if (!visible.has(row.channelId)) {
          return {
            ...common,
            restricted: true,
            id: null,
            channel_id: null,
            message_id: null,
            patient_id: null,
            ack_class: row.ackClass,
            addressed_role: toAckAddressedRole(row.addressedRole),
            assigned_user_id: null,
            assigned_display_name: names.get(row.assignedUserId) ?? null,
            current_tier: row.currentTier,
            escalation_note: note,
          };
        }
        return {
          ...common,
          restricted: false,
          id: row.id,
          channel_id: row.channelId,
          message_id: row.messageId,
          patient_id: row.patientId,
          ack_class: row.ackClass,
          addressed_role: toAckAddressedRole(row.addressedRole),
          assigned_user_id: row.assignedUserId,
          assigned_display_name: names.get(row.assignedUserId) ?? null,
          current_tier: row.currentTier,
          escalation_note: note,
        };
      });
      const filtered = filters.status !== undefined || filters.overdue === true;
      return {
        items,
        next_cursor: page.nextCursor,
        audit_request_id: items.find((i) => !i.restricted)?.id ?? null,
        complete: page.nextCursor === null,
        filtered,
        counts: page.counts,
      };
    },
  };
}
