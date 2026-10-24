// M36 WP 6.9 (ADR-0098, PROPOSED) - the death-event coordination board: a checklist of follow-up work after a patient's death,
// each item with exactly ONE accountable owner and an append-only history. Ids, enums and instants only: no free text anywhere.
// The wording of an item comes from the platform-floor template below (fixed, reviewed text), never from a user or a chart. The board
// is COORDINATION ONLY: completing an item writes nothing to M4, M12, M22 or any chart.

export const DEATH_BOARD_FLAG_KEY = "messaging.death_board" as const;

export const DEATH_BOARD_ITEM_STATUSES = ["open", "done"] as const;
export type DeathBoardItemStatus = (typeof DEATH_BOARD_ITEM_STATUSES)[number];

export const DEATH_BOARD_EVENT_TYPES = [
  "created",
  "reassigned",
  "completed",
  "needs_owner",
] as const;
export type DeathBoardEventType = (typeof DEATH_BOARD_EVENT_TYPES)[number];

/** Why an owner changed: a person did it, a supervisor did, the offboarding sweep did, or the board was just created. */
export const DEATH_BOARD_REASON_CODES = [
  "creation",
  "manual",
  "supervisor",
  "offboarding",
] as const;
export type DeathBoardReasonCode = (typeof DEATH_BOARD_REASON_CODES)[number];

/** The platform-floor template, version 1. A tenant cannot add, remove or reword items in this version (ADR-0098 D6). */
export const DEATH_BOARD_TEMPLATE_VERSION = 1 as const;
export const DEATH_BOARD_TEMPLATE = [
  { key: "pronouncement", label: "Pronouncement of death recorded", dueMinutes: 120 },
  { key: "family_notification", label: "Family or representative notified", dueMinutes: 240 },
  { key: "dme_pickup", label: "Medical equipment pickup arranged", dueMinutes: 4320 },
  {
    key: "medication_disposal",
    label: "Medication disposal completed and witnessed",
    dueMinutes: 1440,
  },
  { key: "m4_record_tasks", label: "Clinical record follow-up tasks completed", dueMinutes: 4320 },
  { key: "m22_document_tasks", label: "Required documents filed", dueMinutes: 4320 },
] as const;
export type DeathBoardItemKey = (typeof DEATH_BOARD_TEMPLATE)[number]["key"];
export const DEATH_BOARD_ITEM_KEYS: readonly DeathBoardItemKey[] = DEATH_BOARD_TEMPLATE.map(
  (t) => t.key,
);

export const DEATH_BOARD_LIST_DEFAULT = 25;
export const DEATH_BOARD_LIST_MAX = 50;
/** How many recent boards one list call examines for the viewer's membership (ADR-0098 known limit). */
export const DEATH_BOARD_SCAN_MAX = 100;

export interface DeathBoardEventDto {
  readonly id: string;
  readonly event_type: DeathBoardEventType;
  readonly actor_kind: "user" | "system";
  readonly actor_user_id: string | null;
  readonly from_owner_user_id: string | null;
  readonly to_owner_user_id: string | null;
  readonly reason_code: DeathBoardReasonCode | null;
  readonly created_at: string;
}

export interface DeathBoardItemDto {
  readonly id: string;
  readonly item_key: DeathBoardItemKey;
  readonly label: string;
  readonly status: DeathBoardItemStatus;
  readonly owner_user_id: string;
  readonly owner_display_name: string | null;
  /** The owner left and nobody could take the item: a supervisor must reassign it. */
  readonly needs_owner: boolean;
  readonly due_at: string;
  readonly overdue: boolean;
  readonly completed_at: string | null;
  readonly completed_by_user_id: string | null;
  /** What the caller may do now (computed by the server; the web never re-derives policy). */
  readonly actions: readonly ("complete" | "reassign")[];
}

export interface DeathBoardDto {
  readonly id: string;
  readonly patient_id: string;
  readonly patient_display_name: string | null;
  readonly mrn_suffix: string | null;
  readonly created_at: string;
  readonly open_count: number;
  readonly items: readonly DeathBoardItemDto[];
}

export interface DeathBoardListDto {
  readonly enabled: boolean;
  readonly boards: readonly DeathBoardDto[];
}
