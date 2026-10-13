// M36 WP 2.6 — the scheduled-message shape the UI works with (the server's ScheduledMessageView).
export interface ScheduledMessageItem {
  readonly id: string;
  readonly channelId: string;
  readonly parentMessageId: string | null;
  readonly body: string;
  /** ISO instant. */
  readonly scheduledFor: string;
  readonly timeZone: string;
  readonly status: "pending" | "blocked";
  readonly blockedReason:
    | "channel_archived"
    | "not_member"
    | "permission_revoked"
    | "announcement_not_permitted"
    | "parent_unavailable"
    | "dispatch_failed"
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
