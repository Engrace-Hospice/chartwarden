// M36 WP 5.8 (ADR-0087, PROPOSED), slice S1 - messaging break-glass: a self-requested, time-limited, read-only grant on one channel, always
// reviewed afterwards (migration 1140). Constants only; nothing reads them until S2. The numeric bounds are pinned against the SQL CHECKs.

/** Tenant flag (absent = off): off is the uniform 404 and the grant is never consulted. */
export const BREAK_GLASS_FLAG_KEY = "messaging.break_glass";

/** Why the reader needs the channel (migration 1140 CHECK `message_break_glass_grant_reason`). */
export const BREAK_GLASS_REASON_CODES = [
  "patient_safety",
  "covering_colleague",
  "record_correction",
  "other",
] as const;
export type BreakGlassReasonCode = (typeof BREAK_GLASS_REASON_CODES)[number];

/** Free-text justification bounds, after trimming (CHECK `message_break_glass_grant_justification`). Reviewer-only text. */
export const BREAK_GLASS_JUSTIFICATION_MIN = 20;
export const BREAK_GLASS_JUSTIFICATION_MAX = 280;

/** D2: the default and the hard maximum (CHECK `message_break_glass_grant_max_window`). Renewal is a new request. */
export const BREAK_GLASS_DEFAULT_HOURS = 4;
export const BREAK_GLASS_MAX_HOURS = 24;

/** D5 (default, not yet confirmed by the owner): a review is due this many business days after the grant ends, and alerts after the second. */
export const BREAK_GLASS_REVIEW_DUE_BUSINESS_DAYS = 1;
export const BREAK_GLASS_REVIEW_ESCALATE_DAYS = 3;

/** The read paths that record a trail row (CHECK `message_break_glass_read_kind`). */
export const BREAK_GLASS_READ_KINDS = [
  "channel",
  "messages",
  "thread",
  "attachment",
  "search",
  "ack",
  "handoff",
  "context",
] as const;
export type BreakGlassReadKind = (typeof BREAK_GLASS_READ_KINDS)[number];

/** A completed review's verdict (CHECK `message_break_glass_review_outcome`); a concern needs a note. */
export const BREAK_GLASS_REVIEW_OUTCOMES = ["reviewed", "concern"] as const;
export type BreakGlassReviewOutcome = (typeof BREAK_GLASS_REVIEW_OUTCOMES)[number];

export const BREAK_GLASS_NOTE_MAX = 1000;

// ── S3: routes (ADR-0087) ────────────────────────────────────────────────────────────────────────────────────────────────────

export const MESSAGING_BREAK_GLASS_INVOKE_PERMISSION = "messaging.break_glass.invoke";
export const MESSAGING_BREAK_GLASS_REVIEW_PERMISSION = "messaging.break_glass.review";
/** The fresh step-up a grant request demands (the web prompts for this action). */
export const BREAK_GLASS_INVOKE_STEP_UP_KEY = "messaging.break_glass.invoke";

/** The requested duration in minutes: at least 15, 4 hours by default, 24 hours at most (the SQL CHECK is the backstop). */
export const BREAK_GLASS_MIN_MINUTES = 15;
export const BREAK_GLASS_DEFAULT_MINUTES = BREAK_GLASS_DEFAULT_HOURS * 60;
export const BREAK_GLASS_MAX_MINUTES = BREAK_GLASS_MAX_HOURS * 60;

/** The caller can already read the channel (membership): nothing to request. */
export const BREAK_GLASS_NOT_NEEDED_CODE = "BREAK_GLASS_NOT_NEEDED";
/** The caller already holds a live grant on this channel. */
export const BREAK_GLASS_ALREADY_ACTIVE_CODE = "BREAK_GLASS_ALREADY_ACTIVE";
/** A review can only be completed after its grant has ended. */
export const BREAK_GLASS_STILL_ACTIVE_CODE = "BREAK_GLASS_STILL_ACTIVE";
/** The review was already completed (a completed review is final). */
export const BREAK_GLASS_REVIEW_DONE_CODE = "BREAK_GLASS_REVIEW_DONE";

export type BreakGlassGrantStatus = "active" | "expired" | "revoked";

/** POST /api/v1/messaging/break-glass. The justification is reviewer-only text; durationMinutes defaults to 4 hours. */
export interface CreateBreakGlassRequest {
  channelId: string;
  reasonCode: BreakGlassReasonCode;
  justification: string;
  durationMinutes?: number;
}

/** A grant as its holder sees it. Never the justification text of anyone else's grant, never a message. */
export interface BreakGlassGrantDto {
  id: string;
  channelId: string;
  channelKind: string;
  reasonCode: BreakGlassReasonCode;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: BreakGlassGrantStatus;
}

/** One row of the compliance queue. `endedAt` is the earlier of expiry and revocation (the planned expiry while the grant is still live). */
export interface BreakGlassReviewDto {
  reviewId: string;
  grantId: string;
  granteeUserId: string;
  granteeName: string | null;
  channelId: string;
  channelKind: string;
  /** The stored title, except for a care-team channel (its title can name a patient): null there, and `patientId` identifies the subject. */
  channelTitle: string | null;
  /** The care-team channel's patient (an id, never a name); null for every other kind. */
  patientId: string | null;
  reasonCode: BreakGlassReasonCode;
  justification: string;
  grantedAt: string;
  endedAt: string;
  stillActive: boolean;
  readCount: number;
  status: "pending" | "reviewed";
  outcome: BreakGlassReviewOutcome | null;
  reviewedAt: string | null;
  reviewerUserId: string | null;
  note: string | null;
  /** One business day after the grant ends (D5, default unconfirmed). */
  dueAt: string;
  overdue: boolean;
}

/** One audited read under the grant: kind, optional resource id, item count, instant. Never a body. */
export interface BreakGlassReadDto {
  readKind: BreakGlassReadKind;
  resourceId: string | null;
  itemCount: number | null;
  readAt: string;
}

export interface BreakGlassReviewDetailDto extends BreakGlassReviewDto {
  reads: BreakGlassReadDto[];
}

/** POST /api/v1/messaging/break-glass/reviews/:id/complete. A concern needs a note. */
export interface CompleteBreakGlassReviewRequest {
  outcome: BreakGlassReviewOutcome;
  note?: string;
}

/** The alert raised once a review is still open this many days after its grant ended (rule `m36.break_glass.review_overdue`, system_locked). */
export const BREAK_GLASS_REVIEW_OVERDUE_ALERT = "m36.break_glass.review_overdue";
