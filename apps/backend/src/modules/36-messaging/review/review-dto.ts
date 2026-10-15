// apps/backend/src/modules/36-messaging/review/review-dto.ts - WP 3.8: the read model. A review row stores pointers only, so
// the patient label is resolved HERE, at read time, and the Part 2 gate is re-applied to the VIEWER on every row. A row whose
// patient the viewer may not see (or whose gate cannot answer) is `restricted`: no label, no patient id, no actions - but it
// is still listed and counted, never invisible. No message body is ever shown.
import { allowedReviewActions } from "@wardenx/messaging";
import type {
  ReviewCause,
  ReviewItemDto,
  ReviewItemKind,
  ReviewResolution,
  ReviewSource,
  ReviewState,
  TaskCloseReason,
} from "@wardenx/types";
import { TASK_ACTIVE_STATUSES } from "@wardenx/types";
import type { PatientLabelPort } from "../handoffs/handoff-dto";
import type { Part2ChannelGate } from "../part2-channel-gate";
import type { ReviewRow, ReviewTaskRow } from "./review-store-db";

export interface ReviewDtoPorts {
  readonly patientLabels: PatientLabelPort;
  readonly part2Gate: Part2ChannelGate;
}

/** Of the distinct patients, the ones the viewer may see. A gate that throws withholds that patient (fail closed). */
export async function visiblePatientIds(
  gate: Part2ChannelGate,
  orgId: string,
  viewerId: string,
  patientIds: readonly string[],
): Promise<Set<string>> {
  const visible = new Set<string>();
  for (const patientId of new Set(patientIds)) {
    try {
      const allowed = await gate.allowedUserIds({
        organizationId: orgId,
        patientId,
        userIds: [viewerId],
      });
      if (allowed.has(viewerId)) visible.add(patientId);
    } catch {
      // fail closed: the row stays listed, restricted
    }
  }
  return visible;
}

const isActiveTask = (task: ReviewTaskRow | undefined): boolean =>
  task !== undefined && (TASK_ACTIVE_STATUSES as readonly string[]).includes(task.status);

export async function buildReviewDtos(
  ports: ReviewDtoPorts,
  orgId: string,
  viewerId: string,
  rows: readonly ReviewRow[],
  tasks: ReadonlyMap<string, ReviewTaskRow>,
  nameOf: (userId: string) => string | null,
): Promise<ReviewItemDto[]> {
  const visible = await visiblePatientIds(
    ports.part2Gate,
    orgId,
    viewerId,
    rows.map((r) => r.patientId),
  );
  const labels = await ports.patientLabels(orgId, [...visible]).catch(() => new Map());
  return rows.map((r): ReviewItemDto => {
    const restricted = !visible.has(r.patientId);
    const task = tasks.get(r.itemId);
    const label = restricted ? undefined : labels.get(r.patientId);
    return {
      id: r.id,
      source: r.source as ReviewSource,
      cause: r.cause as ReviewCause,
      state: r.state as ReviewState,
      resolution: r.resolution as ReviewResolution | null,
      resolution_reason: r.resolutionReason as TaskCloseReason | null,
      restricted,
      patient_id: restricted ? null : r.patientId,
      patient_display_name: label?.displayName ?? null,
      mrn_suffix: label?.mrnSuffix ?? null,
      item_kind: r.itemKind as ReviewItemKind,
      item_id: r.itemId,
      // A restricted row keeps only the task id: no channel, message or people.
      task:
        task && !restricted
          ? {
              status: task.status,
              clinical_concern: task.clinicalConcern,
              needs_owner: task.needsOwner,
              due_at: task.dueAt ? task.dueAt.toISOString() : null,
              assignee_user_id: task.assigneeId,
              assignee_display_name: nameOf(task.assigneeId),
              created_by_user_id: task.createdBy,
              created_by_display_name: nameOf(task.createdBy),
              message_id: task.messageId,
              channel_id: task.channelId,
            }
          : null,
      reassigned_to_user_id: r.reassignedToUserId,
      reassigned_to_display_name: r.reassignedToUserId ? nameOf(r.reassignedToUserId) : null,
      resolved_by_user_id: r.resolvedByUserId,
      resolved_by_display_name: r.resolvedByUserId ? nameOf(r.resolvedByUserId) : null,
      resolved_at: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      created_at: r.createdAt.toISOString(),
      allowed_actions: allowedReviewActions(
        { state: r.state as ReviewState },
        { restricted, taskActive: isActiveTask(task) },
      ),
    };
  });
}
