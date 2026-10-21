// @wardenx/messaging - the pure rules of the acknowledgment-request aggregate (M36 WP 4.2, ADR-0069): the state machine, the
// deadline policy and the viewer hints. The SAME transition table is enforced by the database trigger in migration 1107 (a pin
// test compares them), so a later writer (WP 4.4 timers) cannot step outside it. Nothing here reads message text.
import {
  ACK_DEADLINE_POLICY,
  ACK_OPEN_STATUSES,
  type AckClass,
  type AckRequestDto,
  type AckStatus,
  ChartWardenError,
} from "@wardenx/types";

/** Status changes that move to a DIFFERENT status. Terminal states (`resolved`, `cancelled`) have none. */
export const ACK_TRANSITIONS: Readonly<Record<AckStatus, readonly AckStatus[]>> = {
  pending: ["acknowledged", "escalated", "failed_unreachable", "cancelled"],
  // `escalated -> pending` is a reassign (new assignee, new window).
  escalated: ["acknowledged", "failed_unreachable", "cancelled", "pending"],
  // `acknowledged -> pending` is a reassign; a deleted message withdraws the request from any open state.
  acknowledged: ["resolved", "pending", "cancelled"],
  // Never terminal in effect: a human acknowledges, reassigns or resolves it.
  failed_unreachable: ["acknowledged", "resolved", "pending", "cancelled"],
  resolved: [],
  cancelled: [],
};

/**
 * The only two same-status updates: a reassign keeps `pending` (new assignee, restarted window) and an escalation to a higher
 * tier keeps `escalated`. Anything else that leaves the status unchanged is not a transition.
 */
export const ACK_SAME_STATUS_UPDATES: readonly AckStatus[] = ["pending", "escalated"];

export const ackStateInvalid = (
  message = "That request is not in a state that allows this.",
): ChartWardenError => new ChartWardenError("ACK_STATE_INVALID", message, 409);
export const ackNotAcknowledged = (): ChartWardenError =>
  new ChartWardenError(
    "ACK_NOT_ACKNOWLEDGED",
    "A request is resolved only after it has been acknowledged.",
    409,
  );

export function isOpenAckStatus(status: AckStatus): boolean {
  return (ACK_OPEN_STATUSES as readonly AckStatus[]).includes(status);
}

/** True when `from -> to` (different statuses) is on the table. */
export function canTransition(from: AckStatus, to: AckStatus): boolean {
  return ACK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AckStatus, to: AckStatus): void {
  if (!canTransition(from, to)) throw ackStateInvalid();
}

/** The class a request takes from the message it is about: an urgent message is `urgent`, anything else `important`. */
export function ackClassFor(messageUrgency: string): AckClass {
  return messageUrgency === "urgent" ? "urgent" : "important";
}

const MS_PER_MINUTE = 60_000;

/** The platform default deadline for a window that starts at `windowStart`. */
export function defaultDeadline(ackClass: AckClass, windowStart: Date): Date {
  return new Date(
    windowStart.getTime() + ACK_DEADLINE_POLICY[ackClass].defaultMinutes * MS_PER_MINUTE,
  );
}

/** The latest deadline the platform allows for a window that starts at `windowStart` (also a database CHECK). */
export function maxDeadline(ackClass: AckClass, windowStart: Date): Date {
  return new Date(windowStart.getTime() + ACK_DEADLINE_POLICY[ackClass].maxMinutes * MS_PER_MINUTE);
}

type ViewerFacts = Pick<AckRequestDto, "status" | "requester_user_id" | "assigned_user_id">;

/**
 * Which controls to OFFER the viewer, from identity and state only. The server re-decides every call (and re-checks the
 * caller's qualification), so this is a hint: showing a button is never an authorization.
 */
export function viewerActionsFor(
  request: ViewerFacts,
  viewerUserId: string,
): AckRequestDto["viewer_actions"] {
  const isAssignee = request.assigned_user_id === viewerUserId;
  const isParty = isAssignee || request.requester_user_id === viewerUserId;
  const open = isOpenAckStatus(request.status);
  return {
    can_acknowledge:
      isAssignee &&
      (request.status === "pending" ||
        request.status === "escalated" ||
        request.status === "failed_unreachable"),
    can_reassign: isParty && open,
    can_resolve: isAssignee && request.status === "acknowledged",
  };
}
