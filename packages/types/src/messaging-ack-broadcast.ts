// M36 WP 6.8 (ADR-0097, PROPOSED) - acknowledge-required broadcast. An announcement the author marks "acknowledgment required" gets a
// frozen audience (everyone who could be reached at that moment) and one explicit, per-person, idempotent acknowledgment each. OPENING an
// announcement never acknowledges it (the read receipt of WP 2.9 stays a separate fact). Behind the tenant flag `messaging.ack_broadcast`
// (default off, absent = off): off is a uniform 404, checked before any query is parsed.

/** The tenant flag that gates every route of the feature. */
export const ACK_BROADCAST_FLAG_KEY = "messaging.ack_broadcast";

/** The audience is frozen at publish; a tenant larger than this is refused outright (never a silently partial audience). */
export const ACK_BROADCAST_MAX_AUDIENCE = 5000;

/** Rows per page of the supervisor's list; the page is exact (counts cover the whole audience), nothing is silently truncated. */
export const ACK_BROADCAST_PAGE_DEFAULT = 100;
export const ACK_BROADCAST_PAGE_MAX = 200;

/** Broadcasts in the supervisor's list / the recipient's own waiting list. */
export const ACK_BROADCAST_LIST_MAX = 50;

/**
 * Where one recipient stands. `acknowledged` is the only state that means the person said so. `opened` and `not_opened` are both
 * NOT acknowledged (the difference is only whether the announcement was displayed to them). `ineligible` is a recipient who is no
 * longer an active member (offboarded, suspended): they are listed apart so nobody is chased who cannot act, and nobody vanishes.
 */
export const ACK_BROADCAST_STATES = ["acknowledged", "opened", "not_opened", "ineligible"] as const;
export type AckBroadcastState = (typeof ACK_BROADCAST_STATES)[number];

/** The filter of the supervisor's list: `pending` is every eligible person who has not acknowledged (opened or not). */
export const ACK_BROADCAST_FILTERS = ["pending", "acknowledged", "ineligible", "all"] as const;
export type AckBroadcastFilter = (typeof ACK_BROADCAST_FILTERS)[number];

/**
 * A deadline is DISPLAY ONLY (ADR-0097 D13): the author may set one when requiring acknowledgment, between this many minutes and days ahead.
 * Passing it marks the broadcast "past deadline" on the author's list and does nothing else: no reminder, no push, no SMS, no email, no escalation.
 */
export const ACK_BROADCAST_DEADLINE_MIN_MINUTES = 5;
export const ACK_BROADCAST_DEADLINE_MAX_DAYS = 90;

export interface AckBroadcastCounts {
  /** Everyone frozen into the audience at publish (the author is never in it). */
  readonly audience: number;
  readonly acknowledged: number;
  /** Eligible people who have not acknowledged: opened + notOpened. These are the "non-readers" the supervisor chases. */
  readonly pending: number;
  readonly opened: number;
  readonly notOpened: number;
  /** Not acknowledged and no longer an active member. */
  readonly ineligible: number;
  /** Active staff who joined (or were missed) after publish and so are NOT in this broadcast's audience. */
  readonly outsideAudience: number;
}

export interface AckBroadcastSummary {
  readonly messageId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly counts: AckBroadcastCounts;
  /** The author's optional display-only deadline (ADR-0097 D13), or null. */
  readonly deadlineAt: string | null;
  /** When the author stopped asking (ADR-0097 D14), or null. A withdrawn broadcast is read-only; recorded acknowledgments are kept. */
  readonly withdrawnAt: string | null;
  /** The deadline passed, the broadcast was not withdrawn and somebody eligible still has not acknowledged. A marker, not an action. */
  readonly pastDeadline: boolean;
}

export interface AckBroadcastPerson {
  readonly userId: string;
  readonly displayName: string;
  readonly state: AckBroadcastState;
  readonly openedAt: string | null;
  readonly acknowledgedAt: string | null;
}

export interface AckBroadcastDetail extends AckBroadcastSummary {
  readonly filter: AckBroadcastFilter;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly people: readonly AckBroadcastPerson[];
}

export interface AckBroadcastCreated extends AckBroadcastSummary {
  /** False when the announcement already required acknowledgment (the frozen audience was not touched). */
  readonly created: boolean;
}

/** The caller's own waiting item. No message text: the announcement is read where it lives. */
export interface AckBroadcastMine {
  readonly messageId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  /** The author's display-only deadline, or null. */
  readonly deadlineAt: string | null;
}

/** The result of withdrawing: the summary after the move. `already` is true when it had been withdrawn before (the original instant stands). */
export interface AckBroadcastWithdrawn extends AckBroadcastSummary {
  readonly already: boolean;
}

export interface AckBroadcastAcknowledged {
  readonly messageId: string;
  readonly acknowledgedAt: string;
  /** True when the person had already acknowledged (the original instant stands). */
  readonly already: boolean;
}
