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
