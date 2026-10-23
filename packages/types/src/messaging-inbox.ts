// M36 WP 6.1 (ADR-0100) - the smart work inbox: ONE read-only, ranked queue of the work waiting on the caller. It stores nothing and
// acts on nothing: every row points at the surface that already owns the item (acknowledgment request, task, handoff, conversation),
// and the ranking is a fixed rule table, not a model. Behind the ops flag `messaging.smart_inbox` (default off, absent = off).

/** The tenant flag that gates the route. Off (or unreadable) answers 200 with enabled:false. */
export const SMART_INBOX_FLAG_KEY = "messaging.smart_inbox";

/**
 * Rank bands, most pressing first. The band is the primary sort key and never changes with volume, so an urgent acknowledgment
 * request can not be pushed below anything else (a fixed order, no weights that can be out-voted).
 */
export const SMART_INBOX_BANDS = [
  "urgent_ack",
  "handoff_awaiting",
  "task_assigned",
  "mention",
  "care_team_unread",
] as const;
export type SmartInboxBand = (typeof SMART_INBOX_BANDS)[number];

/** Why a row sits where it does: a stable code (for tests and the UI) plus a plain sentence the row shows verbatim. */
export const SMART_INBOX_REASON_CODES = [
  "ack_failed_unreachable",
  "ack_overdue",
  "ack_waiting",
  "handoff_expires_soon",
  "handoff_waiting",
  "task_overdue",
  "task_clinical_concern",
  "task_due",
  "task_open",
  "mention_unread",
  "care_team_unread",
] as const;
export type SmartInboxReasonCode = (typeof SMART_INBOX_REASON_CODES)[number];

export interface SmartInboxReason {
  readonly code: SmartInboxReasonCode;
  readonly text: string;
}

export interface SmartInboxItemDto {
  /** Stable per source row, e.g. `ack:<id>`; a restricted ack row uses its request_ref. */
  readonly key: string;
  readonly band: SmartInboxBand;
  /** 1-based position in the full ranked list. */
  readonly rank: number;
  /** The row's own title: generic wording only, never message text. */
  readonly title: string;
  readonly reasons: readonly SmartInboxReason[];
  /** The instant the row's clock started (requested, offered, created or last activity), ISO. */
  readonly since: string;
  /** The instant that makes it overdue or expiring, ISO, or null. */
  readonly due_at: string | null;
  /** The conversation to open, or null (a restricted request, a handoff). */
  readonly channel_id: string | null;
  /** The owning surface: where the user acts. The inbox never acts. */
  readonly target: "acknowledgment_request" | "task" | "handoff" | "conversation";
  /** The source row's id for `target`, or null when restricted. */
  readonly target_id: string | null;
  /** True when the caller cannot open the conversation (ids withheld, exactly as the supervisor queue does). */
  readonly restricted: boolean;
  /** Unread messages for a conversation row, else null. */
  readonly count: number | null;
}

export interface SmartInboxResponse {
  /** False when the tenant flag is off: `items` is empty and the web hides the screen. */
  readonly enabled: boolean;
  readonly items: readonly SmartInboxItemDto[];
  /** Rows per band over the WHOLE list (before `limit`), so a short page can not hide a band. */
  readonly band_counts: Readonly<Record<SmartInboxBand, number>>;
  /** True when `items` is the entire ranked list. Urgent rows are always included; only lower bands are ever cut. */
  readonly complete: boolean;
  /** False when more urgent requests exist than one read returned (the supervisor queue's page cap): say so, never hide it. */
  readonly urgent_complete: boolean;
  /** Sources that failed to read; the rest still show, and the screen says what is missing. */
  readonly unavailable_sources: readonly SmartInboxBand[];
}

export const SMART_INBOX_LIMIT_DEFAULT = 50;
export const SMART_INBOX_LIMIT_MAX = 100;
/** A handoff with this long left is "expiring soon" (PROVISIONAL, clinical lead to confirm). */
export const SMART_INBOX_HANDOFF_SOON_MINUTES = 60;
