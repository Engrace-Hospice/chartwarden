// apps/backend/src/modules/36-messaging/ack-requests/ack-dto.ts - WP 4.2: row -> wire shape (snake_case, ISO instants).
import { viewerActionsFor } from "@wardenx/messaging";
import type { AckEventDto, AckRequestDto } from "@wardenx/types";
import type { AckEventRow, AckRow } from "./ack-types";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toAckRequestDto(row: AckRow, viewerUserId: string): AckRequestDto {
  const base = {
    id: row.id,
    message_id: row.messageId,
    channel_id: row.channelId,
    patient_id: row.patientId,
    ack_class: row.ackClass,
    status: row.status,
    requester_user_id: row.requesterUserId,
    assigned_user_id: row.assignedUserId,
    requested_at: row.requestedAt.toISOString(),
    window_started_at: row.windowStartedAt.toISOString(),
    deadline_at: row.deadlineAt.toISOString(),
    current_tier: row.currentTier,
    acknowledged_at: iso(row.acknowledgedAt),
    acknowledged_by_user_id: row.acknowledgedByUserId,
    resolved_at: iso(row.resolvedAt),
    cancelled_at: iso(row.cancelledAt),
    version: row.version,
  };
  return {
    ...base,
    viewer_actions: viewerActionsFor(
      {
        status: row.status,
        requester_user_id: row.requesterUserId,
        assigned_user_id: row.assignedUserId,
      },
      viewerUserId,
    ),
  };
}

export function toAckEventDto(e: AckEventRow): AckEventDto {
  return {
    id: e.id,
    event_type: e.eventType,
    actor_user_id: e.actorUserId,
    actor_kind: e.actorKind,
    from_status: e.fromStatus,
    to_status: e.toStatus,
    assigned_user_id: e.assignedUserId,
    previous_assigned_user_id: e.previousAssignedUserId,
    tier: e.tier,
    created_at: e.createdAt.toISOString(),
  };
}
