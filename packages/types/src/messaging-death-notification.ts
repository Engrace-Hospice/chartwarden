// M36 death-notification cascade (builds on ADR-0098, PROPOSED): who must be told a patient died, and whether each recipient has
// acknowledged. Ids, enums and instants only: no clinical content, no names and no free text anywhere. The board stays coordination-only;
// this layer only fans out fixed-text notices. An INTERNAL notice is an in-app alert acknowledged by an explicit authenticated act (never
// a read receipt). An EXTERNAL notice discloses to a third party, so it is sent only when a BAA is on file for that entity.

export const DEATH_NOTIFICATIONS_FLAG_KEY = "messaging.death_notifications" as const;

export const DEATH_NOTIFICATION_INTERNAL_KINDS = [
  "attending",
  "medical_director",
  "bereavement_coordinator",
  "billing_lead",
  "pharmacy_liaison",
  "dme_liaison",
] as const;
/** Pharmacy and DME vendors are modelled but not sent to: no vendor transport exists yet (follow-up), so no route or sender uses them. */
export const DEATH_NOTIFICATION_EXTERNAL_KINDS = [
  "funeral_home",
  "pharmacy_vendor",
  "dme_vendor",
] as const;
export const DEATH_NOTIFICATION_KINDS = [
  ...DEATH_NOTIFICATION_INTERNAL_KINDS,
  ...DEATH_NOTIFICATION_EXTERNAL_KINDS,
] as const;
export type DeathNotificationInternalKind = (typeof DEATH_NOTIFICATION_INTERNAL_KINDS)[number];
export type DeathNotificationKind = (typeof DEATH_NOTIFICATION_KINDS)[number];

export const DEATH_NOTIFICATION_STATES = [
  "pending",
  "sent",
  "acked",
  "failed",
  "blocked_no_baa",
  "not_applicable",
] as const;
export type DeathNotificationState = (typeof DEATH_NOTIFICATION_STATES)[number];

/** Minutes an internal notice may stay unacknowledged before the stall sweep tells the supervisors (once). */
export const DEATH_NOTIFICATION_STALL_MINUTES = 120;

export const DEATH_NOTIFICATION_EVENTS = {
  opened: "m36.death_board.opened",
  sent: "m36.death_notification.sent",
  acked: "m36.death_notification.acked",
  blocked: "m36.death_notification.blocked",
} as const;

export interface DeathNotificationDto {
  readonly id: string;
  readonly board_id: string;
  readonly recipient_kind: DeathNotificationKind;
  readonly state: DeathNotificationState;
  readonly created_at: string;
  readonly acked_at: string | null;
  readonly acked_by: string | null;
  /** The caller may acknowledge it now (the server decides; the web never re-derives policy). */
  readonly can_ack: boolean;
}

export interface DeathNotificationListDto {
  readonly enabled: boolean;
  readonly notifications: readonly DeathNotificationDto[];
}
