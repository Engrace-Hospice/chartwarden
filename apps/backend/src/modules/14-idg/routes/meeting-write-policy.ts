import { IdgStateError } from "@wardenx/idg";
import type { IdgMeetingStatus } from "@wardenx/types";

/**
 * Child writes are serialized on the parent meeting row by the DB service, then checked here.
 * This is deliberately separate from the meeting transition machine: it describes which meeting
 * phases permit editing each child resource, while `transitionMeeting` remains the sole authority
 * for changing the meeting itself.
 */
export type IdgMeetingWriteOperation =
  | "attendance"
  | "agenda"
  | "decision"
  | "action_item_create"
  | "action_item_remove"
  | "action_item_follow_up";

const PREPARATION_OR_LIVE = new Set<IdgMeetingStatus>([
  "scheduled",
  "packets_building",
  "packets_ready",
  "live",
]);

export function assertMeetingWriteAllowed(
  status: IdgMeetingStatus,
  operation: IdgMeetingWriteOperation,
): void {
  if (operation === "attendance" || operation === "agenda") {
    if (PREPARATION_OR_LIVE.has(status)) return;
    throw new IdgStateError(
      "ILLEGAL_MEETING_TRANSITION",
      `Meeting content is read-only after it becomes ${status}.`,
    );
  }

  if (operation === "action_item_follow_up") {
    if (status === "live" || status === "adjourned") return;
    throw new IdgStateError(
      "ILLEGAL_MEETING_TRANSITION",
      `Action-item follow-up is unavailable while the meeting is ${status}.`,
    );
  }

  if (status === "live") return;
  throw new IdgStateError(
    "MEETING_NOT_LIVE",
    operation === "decision"
      ? "Decisions can only be recorded or changed while the meeting is live."
      : "Action items can only be added to or removed from a live meeting.",
  );
}
