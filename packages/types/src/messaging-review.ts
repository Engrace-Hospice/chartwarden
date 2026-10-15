// M36 WP 3.8 - the lifecycle review queue (ADR-0065). A supervisor decides what happens to the open communication tasks
// of a patient who was discharged, died or transferred: reassign or close with a reason CODE, never delete. Rows hold
// ids and enums only (no free text); the patient label is resolved at read time in an authorised, read-audited response.
import type { TaskCloseReason } from "./messaging-task";

/** `patient_lifecycle` is WP 3.8; `care_team_change` is reserved for WP 3.9 (same table, no schema change). */
export const REVIEW_SOURCES = ["patient_lifecycle", "care_team_change"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const REVIEW_LIFECYCLE_CAUSES = ["death", "discharge", "transfer"] as const;
export type ReviewLifecycleCause = (typeof REVIEW_LIFECYCLE_CAUSES)[number];
export const REVIEW_CARE_TEAM_CAUSES = ["care_team_removed"] as const;
export const REVIEW_CAUSES = [...REVIEW_LIFECYCLE_CAUSES, ...REVIEW_CARE_TEAM_CAUSES] as const;
export type ReviewCause = (typeof REVIEW_CAUSES)[number];

export const REVIEW_ITEM_KINDS = ["task"] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];

export const REVIEW_STATES = ["open", "resolved"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_RESOLUTIONS = ["reassigned", "closed", "closed_elsewhere"] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];

export const REVIEW_ACTIONS = ["reassign", "close"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export interface ReviewTaskDto {
  readonly status: string;
  readonly clinical_concern: boolean;
  readonly needs_owner: boolean;
  readonly due_at: string | null;
  readonly assignee_user_id: string;
  readonly assignee_display_name: string | null;
  readonly created_by_user_id: string;
  readonly created_by_display_name: string | null;
  readonly message_id: string;
  readonly channel_id: string;
}

export interface ReviewItemDto {
  readonly id: string;
  readonly source: ReviewSource;
  readonly cause: ReviewCause;
  readonly state: ReviewState;
  readonly resolution: ReviewResolution | null;
  readonly resolution_reason: TaskCloseReason | null;
  /** True when the Part 2 gate withholds the patient from the viewer (or could not answer): no label, no actions. */
  readonly restricted: boolean;
  readonly patient_id: string | null;
  readonly patient_display_name: string | null;
  readonly mrn_suffix: string | null;
  readonly item_kind: ReviewItemKind;
  readonly item_id: string;
  readonly task: ReviewTaskDto | null;
  readonly reassigned_to_user_id: string | null;
  readonly reassigned_to_display_name: string | null;
  readonly resolved_by_user_id: string | null;
  readonly resolved_by_display_name: string | null;
  readonly resolved_at: string | null;
  readonly created_at: string;
  readonly allowed_actions: readonly ReviewAction[];
}
