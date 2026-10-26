// @chartwarden/messaging — WP 2.6 scheduled send.
//
// A scheduled message is a PRIVATE, sealed message-to-be (like a draft) that the dispatcher sends at `scheduledFor`
// after re-checking, at dispatch, that the sender may still send it. This file holds the pure rules shared by the
// route service and the dispatcher (so they cannot disagree) and the service interface the routes depend on.
import { ChartWardenError, ValidationError } from "@chartwarden/types";
import { MAX_DRAFT_BODY_LENGTH } from "../drafts";

/** A schedule must be at least this far ahead: the sweep runs every minute, so anything nearer is just "send". */
export const MIN_SCHEDULE_LEAD_MS = 60_000;
/** ...and no further than 30 days out. */
export const MAX_SCHEDULE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** Pending + blocked scheduled messages one user may hold (409 SCHEDULE_LIMIT_REACHED). */
export const DEFAULT_MAX_SCHEDULED_PER_USER = 50;
/** Unexpected dispatch failures tolerated (one try per sweep) before the message is blocked as `dispatch_failed`. */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** Same ceiling as a sent message body. */
export const MAX_SCHEDULED_BODY_LENGTH = MAX_DRAFT_BODY_LENGTH;

export const SCHEDULE_BLOCK_REASONS = [
  "channel_archived",
  "not_member",
  "permission_revoked",
  "announcement_not_permitted",
  "parent_unavailable",
  "dispatch_failed",
] as const;
export type ScheduleBlockReason = (typeof SCHEDULE_BLOCK_REASONS)[number];

export type ScheduledMessageStatus = "pending" | "blocked";

export interface ScheduledMessageView {
  readonly id: string;
  readonly channelId: string;
  readonly parentMessageId: string | null;
  readonly body: string;
  /** ISO instant. */
  readonly scheduledFor: string;
  /** IANA zone the sender picked the time in; display only, `scheduledFor` is the instant. */
  readonly timeZone: string;
  readonly status: ScheduledMessageStatus;
  readonly blockedReason: ScheduleBlockReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateScheduledMessageInput {
  readonly userId: string;
  readonly channelId: string;
  readonly parentMessageId?: string | null | undefined;
  readonly body: string;
  readonly scheduledFor: string;
  readonly timeZone?: string | undefined;
  /** Stable across retries: a second create with the same (org, user, id) returns the first row, not a new one. */
  readonly clientMessageId?: string | null | undefined;
}

export interface ScheduledSendService {
  /** Schedule a message. 422 for a time outside the window / blank / too long; 409 SCHEDULE_LIMIT_REACHED; 410 archived. */
  create(orgId: string, input: CreateScheduledMessageInput): Promise<ScheduledMessageView>;
  /** The caller's OWN scheduled messages, soonest first; optionally one channel's. Never anyone else's. */
  listMine(
    orgId: string,
    input: { userId: string; channelId?: string | undefined },
  ): Promise<readonly ScheduledMessageView[]>;
  /** Idempotent. `cancelled` is false when there was nothing left to cancel (already sent, cancelled or never theirs). */
  cancel(orgId: string, input: { userId: string; id: string }): Promise<{ cancelled: boolean }>;
  /** Move a pending or blocked message to a new time (a blocked one becomes pending again). 404 when not theirs. */
  reschedule(
    orgId: string,
    input: { userId: string; id: string; scheduledFor: string },
  ): Promise<ScheduledMessageView>;
}

const HAS_OFFSET = /T[0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})$/i;

/** Parse and bound a requested send time. Throws a typed 422; returns the instant. */
export function assertScheduleTime(raw: string, now: Date): Date {
  const when = new Date(raw);
  // An instant needs an offset: without one `Date` reads it in the SERVER's zone, a silent hours-off schedule.
  if (!HAS_OFFSET.test(raw) || Number.isNaN(when.getTime())) {
    throw new ValidationError("scheduledFor is not a valid time", [
      { field: "scheduledFor", code: "INVALID", message: "use an ISO 8601 date and time" },
    ]);
  }
  const ahead = when.getTime() - now.getTime();
  if (ahead < MIN_SCHEDULE_LEAD_MS) {
    throw new ChartWardenError(
      "SCHEDULE_TOO_SOON",
      "a message can be scheduled at least one minute ahead; send it now instead",
      422,
    );
  }
  if (ahead > MAX_SCHEDULE_HORIZON_MS) {
    throw new ChartWardenError(
      "SCHEDULE_TOO_FAR",
      "a message can be scheduled at most 30 days ahead",
      422,
    );
  }
  return when;
}

/** A valid IANA zone name, or UTC when none was given. */
export function normalizeScheduleTimeZone(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    throw new ValidationError("timeZone is not a valid IANA time zone", [
      { field: "timeZone", code: "INVALID", message: "use an IANA name such as America/Chicago" },
    ]);
  }
}

/**
 * The outcome of the dispatch-time re-checks as a reason code, or null when every check held. A check is `false` when it
 * FAILED; an omitted check is not evaluated. Order is the order of precedence when several fail at once.
 */
export function scheduleBlockReasonFor(checks: {
  archived?: boolean;
  member?: boolean;
  permission?: boolean;
  announce?: boolean;
}): ScheduleBlockReason | null {
  if (checks.member === false) return "not_member";
  if (checks.permission === false) return "permission_revoked";
  if (checks.archived === true) return "channel_archived";
  if (checks.announce === false) return "announcement_not_permitted";
  return null;
}

/** Notification text for the sender. Generic on purpose: no channel title, patient, or message content. */
export function scheduleBlockedMessage(reason: ScheduleBlockReason): string {
  switch (reason) {
    case "channel_archived":
      return "A scheduled message was not sent because its conversation is closed.";
    case "not_member":
    case "permission_revoked":
    case "announcement_not_permitted":
      return "A scheduled message was not sent because your access to that conversation changed.";
    case "parent_unavailable":
      return "A scheduled message was not sent because the message it replies to is no longer available.";
    case "dispatch_failed":
      return "A scheduled message could not be sent. Open Scheduled to retry or cancel it.";
  }
}
