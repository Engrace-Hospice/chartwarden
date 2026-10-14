// M36 WP 3.5 - clinical handoffs (ADR-0062): a sender offers a set of open-work POINTERS (patient, visit, refill
// request, symptom follow-up, task) to one named colleague, who accepts or declines PER ITEM. Ids, enums and instants
// only: no free text anywhere. Per-item display (patient label, visit status, ...) is re-resolved at read time through
// the owning seam. Until an item is accepted its accountable clinician stays the sender.

export const HANDOFF_STATES = ["offered", "accepted", "declined", "expired", "cancelled"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const HANDOFF_ITEM_STATES = [
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled",
] as const;
export type HandoffItemState = (typeof HANDOFF_ITEM_STATES)[number];

export const HANDOFF_ITEM_KINDS = [
  "patient",
  "visit",
  "refill_request",
  "symptom_followup",
  "task",
] as const;
export type HandoffItemKind = (typeof HANDOFF_ITEM_KINDS)[number];

export const HANDOFF_CLOSE_REASONS = [
  "all_resolved",
  "deadline",
  "sender_cancelled",
  "recipient_left",
] as const;
export type HandoffCloseReason = (typeof HANDOFF_CLOSE_REASONS)[number];

export const HANDOFF_EVENT_TYPES = [
  "offered",
  "items_accepted",
  "items_declined",
  "closed",
  "cancelled",
  "needs_attention",
  "recipient_left",
  "sender_left",
] as const;
export type HandoffEventType = (typeof HANDOFF_EVENT_TYPES)[number];

export const HANDOFF_ACTOR_KINDS = ["user", "system"] as const;
export type HandoffActorKind = (typeof HANDOFF_ACTOR_KINDS)[number];

/** What the caller may do to a handoff right now (computed server-side; the web never re-derives policy). */
export const HANDOFF_ACTIONS = ["accept", "decline", "cancel"] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

/** Why a handoff ended with items nobody accepted. Carried by `m36.handoff.unaccepted`. */
export const HANDOFF_UNACCEPTED_CAUSES = [
  "declined",
  "expired",
  "recipient_left",
  "sender_left",
] as const;
export type HandoffUnacceptedCause = (typeof HANDOFF_UNACCEPTED_CAUSES)[number];

/**
 * The offer deadline, in minutes. The platform value is also the CEILING: a tenant may only shorten it (tighten-only).
 * PROVISIONAL: clinical-lead sign-off is not recorded. The SQL CHECK on tenant_handoff_policy pins the same bounds.
 */
export const HANDOFF_EXPIRY_PLATFORM_MINUTES = 240;
export const HANDOFF_EXPIRY_MIN_MINUTES = 15;

/** Who the caller is relative to a handoff. */
export type HandoffRole = "sender" | "recipient" | "none";

export type HandoffItemSummaryState = "ok" | "gone" | "unavailable" | "restricted";

export interface HandoffItemSummary {
  readonly state: HandoffItemSummaryState;
  readonly status?: string | undefined;
  readonly occurred_at?: string | undefined;
  readonly still_open?: boolean | undefined;
}

export interface HandoffItemDto {
  readonly id: string;
  readonly patient_id: string | null;
  readonly patient_display_name: string | null;
  readonly mrn_suffix: string | null;
  readonly kind: HandoffItemKind;
  readonly ref_id: string | null;
  readonly state: HandoffItemState;
  readonly accountable_user_id: string;
  readonly accountable_display_name: string | null;
  readonly resolved_at: string | null;
  readonly summary: HandoffItemSummary;
}

export interface HandoffItemCounts {
  readonly pending: number;
  readonly accepted: number;
  readonly declined: number;
  readonly expired: number;
  readonly cancelled: number;
}

export interface HandoffDto {
  readonly id: string;
  readonly from_user_id: string;
  readonly from_display_name: string | null;
  readonly to_user_id: string;
  readonly to_display_name: string | null;
  readonly state: HandoffState;
  readonly offered_at: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly closed_at: string | null;
  readonly closed_reason: HandoffCloseReason | null;
  readonly needs_attention: boolean;
  /** Distinct patients across the items (a count only; the list row shows no patient). */
  readonly patient_count: number;
  readonly item_counts: HandoffItemCounts;
  readonly allowed_actions: readonly HandoffAction[];
  readonly items?: readonly HandoffItemDto[] | undefined;
}

export interface HandoffPolicyView {
  readonly expiry_minutes: number;
  readonly platform_max_minutes: number;
  readonly customised: boolean;
}
