// M36 WP 4.2 - the acknowledgment-request aggregate (ADR-0069, extends ADR-0056). A request asks ONE named, qualified clinician to
// take clinical responsibility for a message; the clinician does so by an explicit authenticated action. Opening, reading, a
// reaction or a push tap never does. Delivery, push-sent, read and acknowledged are four distinct records (plan invariant 6).
//
// WP 4.2 stores the request and its append-only history and exposes the transitions. Timers, tiers, routing, overdue handling
// and delivery-failure handling are WP 4.3 - 4.5: no code in 4.2 writes `escalated`, `failed_unreachable`, `overdue`,
// `delivery_failed`, `opened` or `delivered`.

/** Ops flag (default off, absent = off). Gates CREATING a request; an existing one can always be settled. */
export const ACK_REQUESTS_FLAG_KEY = "messaging.ack_requests";

/**
 * Ops flag (default off, absent = off) for WP 4.4. Gates the escalation ACTION (the worker's state change), not arming: with it
 * off a due request is left exactly as it is, still open and visible. See ADR-0070.
 */
export const ACK_ESCALATION_TIMERS_FLAG_KEY = "messaging.escalation_timers";

/**
 * The role key WP 4.4 asks the EscalationRouter about. PROVISIONAL: the request stores no `required_role` (ADR-0069), so every
 * class asks for the same ladder until the M19 owner and the clinical lead name the role-to-ladder map (ADR-0057, ADR-0070).
 */
export const ACK_ESCALATION_REQUIRED_ROLE = "rn";

/**
 * Status meanings (the enum is the whole machine; 4.4/4.5 only add writers):
 *  - pending            waiting for the assignee to act (also the state a reassign returns to).
 *  - acknowledged       the assignee took clinical responsibility by an explicit action.
 *  - escalated          the deadline passed and the request was routed to the next tier (`current_tier` >= 1). WP 4.4 only.
 *  - failed_unreachable every tier was exhausted or every route failed. WP 4.5 only. Never terminal in effect: it stays open
 *                       (supervisor work item) until a human acknowledges, reassigns or resolves it.
 *  - resolved           the assignee closed the loop after acknowledging. Terminal.
 *  - cancelled          withdrawn: the message was deleted. Terminal.
 */
export const ACK_STATUSES = [
  "pending",
  "acknowledged",
  "escalated",
  "resolved",
  "cancelled",
  "failed_unreachable",
] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

/** A request that still needs a human: every status that is not terminal. */
export const ACK_OPEN_STATUSES = [
  "pending",
  "acknowledged",
  "escalated",
  "failed_unreachable",
] as const satisfies readonly AckStatus[];

/** The ack class (ADR-0056 decision 7). `critical_symptom` has NO writer in WP 4.2 (who may raise or take it is an open sign-off item). */
export const ACK_CLASSES = ["important", "urgent", "critical_symptom"] as const;
export type AckClass = (typeof ACK_CLASSES)[number];

export const ACK_EVENT_TYPES = [
  "requested",
  "delivered",
  "opened",
  "acknowledged",
  "overdue",
  "escalated",
  "reassigned",
  "resolved",
  "cancelled",
  "delivery_failed",
  // WP 4.4 (migration 1114): the deadline passed and no tier could be reached (`route_unavailable`), or the ladder has no
  // further tier (`ladder_exhausted`). Neither changes the request's state; both are id-only history rows.
  "route_unavailable",
  "ladder_exhausted",
] as const;
export type AckEventType = (typeof ACK_EVENT_TYPES)[number];

/** The event types WP 4.2 writes. Everything else in `ACK_EVENT_TYPES` belongs to WP 4.3 - 4.5. */
export const ACK_EVENT_TYPES_WRITTEN_BY_4_2 = [
  "requested",
  "acknowledged",
  "reassigned",
  "resolved",
  "cancelled",
] as const satisfies readonly AckEventType[];

/** The event types WP 4.4 writes (a timer, never a person). `overdue` is not written: `escalated` / `route_unavailable` say it. */
export const ACK_EVENT_TYPES_WRITTEN_BY_4_4 = [
  "escalated",
  "route_unavailable",
  "ladder_exhausted",
] as const satisfies readonly AckEventType[];

/**
 * Deadline policy (ADR-0056 decision D4). PROVISIONAL platform defaults pending clinical-lead sign-off. The maximum is also a
 * database CHECK (migration 1107) so no code path can store a longer window. A tenant may only SHORTEN a default (tenant
 * tightening is deferred; WP 4.2 ships the platform values).
 */
export const ACK_DEADLINE_POLICY: Readonly<
  Record<AckClass, { readonly defaultMinutes: number; readonly maxMinutes: number }>
> = {
  important: { defaultMinutes: 60, maxMinutes: 120 },
  urgent: { defaultMinutes: 15, maxMinutes: 30 },
  critical_symptom: { defaultMinutes: 5, maxMinutes: 10 },
};

/** Requests listed for one channel (the thread card read). */
export const ACK_CHANNEL_LIST_CAP = 100;

export const ACK_ERROR_CODES = [
  "ACK_ALREADY_REQUESTED",
  "ACK_ASSIGNEE_INVALID",
  "ACK_NOT_PATIENT_CHANNEL",
  "ACK_NOT_REQUESTER",
  "ACK_NOT_ASSIGNEE",
  "ACK_NOT_QUALIFIED",
  "ACK_NOT_PARTY",
  "ACK_STATE_INVALID",
  "ACK_NOT_ACKNOWLEDGED",
  "ACK_MESSAGE_NOT_EDITABLE",
  "ACK_MESSAGE_HAS_OPEN_REQUEST",
  "ACK_UNAVAILABLE",
] as const;
export type AckErrorCode = (typeof ACK_ERROR_CODES)[number];

/**
 * WP 4.4: why an overdue open request has not moved on. `route_unavailable`: the deadline passed and no next tier could be reached
 * (no router bound, a coverage gap, nobody qualified); `ladder_exhausted`: there is no further tier. Neither is a state change; both
 * say the request is STILL OPEN with its current assignee. Only on reads (the detail and the channel list), never null-filled elsewhere.
 */
export const ACK_ESCALATION_NOTES = ["route_unavailable", "ladder_exhausted"] as const;
export type AckEscalationNote = (typeof ACK_ESCALATION_NOTES)[number];

export interface AckRequestDto {
  readonly id: string;
  readonly message_id: string;
  readonly channel_id: string;
  readonly patient_id: string;
  readonly ack_class: AckClass;
  readonly status: AckStatus;
  readonly requester_user_id: string;
  readonly assigned_user_id: string;
  /** Never changes, even across a reassign (reporting). */
  readonly requested_at: string;
  /** Start of the current window: equals `requested_at` until a reassign restarts it. */
  readonly window_started_at: string;
  readonly deadline_at: string;
  readonly current_tier: number;
  readonly acknowledged_at: string | null;
  readonly acknowledged_by_user_id: string | null;
  readonly resolved_at: string | null;
  readonly cancelled_at: string | null;
  readonly version: number;
  /** WP 4.4: present on reads only; null when the request is not overdue-and-unrouted. */
  readonly escalation_note?: AckEscalationNote | null;
  /**
   * Which controls the viewer is offered, from identity and state ONLY (a hint, not an authorization: the server decides on
   * every call and re-checks the caller's qualification).
   */
  readonly viewer_actions: {
    readonly can_acknowledge: boolean;
    readonly can_reassign: boolean;
    readonly can_resolve: boolean;
  };
}

export interface AckEventDto {
  readonly id: string;
  readonly event_type: AckEventType;
  readonly actor_user_id: string | null;
  readonly actor_kind: "user" | "system";
  readonly from_status: AckStatus | null;
  readonly to_status: AckStatus | null;
  readonly assigned_user_id: string | null;
  readonly previous_assigned_user_id: string | null;
  readonly tier: number;
  readonly created_at: string;
}

export interface AckRequestResponse {
  readonly request: AckRequestDto;
  /** False when the call was an idempotent repeat: nothing was written and nothing was published. */
  readonly changed: boolean;
}

export interface AckRequestDetailResponse {
  readonly request: AckRequestDto;
  readonly events: readonly AckEventDto[];
}

export interface AckChannelListResponse {
  readonly requests: readonly AckRequestDto[];
}

/**
 * Ops flag (default off, absent = off) for WP 4.6 (ADR-0073). Gates the notification policy's OUT-OF-BAND routes for the designated
 * safety-critical alerts (urgent_sent, ack.requested / reassigned / escalated). It must be on TOGETHER WITH the flag of the event's own
 * family (`messaging.urgent_clinical` for urgent_sent, `messaging.ack_requests` for ack.*); with it off the seeded in-app-only rules apply.
 */
export const NOTIFICATION_POLICY_FLAG_KEY = "messaging.notification_policy";
