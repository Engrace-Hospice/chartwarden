// M36 WP 3.7 - chart promotion (ADR-0063): a clinician PROPOSES that a secure message belong in the chart. The proposal is a
// thin pointer (message id + a SHA-256 of the body at request time + who wrote it and when); nothing is written to the
// chart until a reviewer acts in the owning module (an M8 addendum they author and sign, or an M14 agenda item a
// coordinator adds). There is no stored copy of the text and no path to a clinical order. Ids, enums and instants only.

/** The only two places a message can be proposed for. Closed on purpose: no order, medication or prescribing target. */
export const CHART_PROMOTION_TARGETS = [
  { module: "m8", kind: "encounter_addendum" },
  { module: "m14", kind: "idg_agenda_item" },
] as const;

export const CHART_PROMOTION_TARGET_MODULES = ["m8", "m14"] as const;
export type ChartPromotionTargetModule = (typeof CHART_PROMOTION_TARGET_MODULES)[number];

export const CHART_PROMOTION_TARGET_KINDS = ["encounter_addendum", "idg_agenda_item"] as const;
export type ChartPromotionTargetKind = (typeof CHART_PROMOTION_TARGET_KINDS)[number];

export function isChartPromotionTarget(module: string, kind: string): boolean {
  return CHART_PROMOTION_TARGETS.some((t) => t.module === module && t.kind === kind);
}

export const CHART_PROMOTION_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "withdrawn",
] as const;
export type ChartPromotionStatus = (typeof CHART_PROMOTION_STATUSES)[number];

/** `requester` = taken back by the person who proposed it; `superseded` = replaced after the message was edited. */
export const CHART_PROMOTION_REASON_CODES = [
  "not_clinically_relevant",
  "already_documented",
  "duplicate",
  "wrong_patient",
  "other",
  "requester",
  "superseded",
] as const;
export type ChartPromotionReasonCode = (typeof CHART_PROMOTION_REASON_CODES)[number];

/** The reasons a reviewer may give when declining (the other two are system-set). */
export const CHART_PROMOTION_REJECT_REASONS = [
  "not_clinically_relevant",
  "already_documented",
  "duplicate",
  "wrong_patient",
  "other",
] as const satisfies readonly ChartPromotionReasonCode[];

/** What the caller may do to a request right now (computed server-side). */
export const CHART_PROMOTION_ACTIONS = ["withdraw"] as const;
export type ChartPromotionAction = (typeof CHART_PROMOTION_ACTIONS)[number];

export type ChartPromotionRole = "requester" | "other";

/** Outcome an owning module reports through its `mN.chart_promotion.decided` event. */
export const CHART_PROMOTION_OUTCOMES = ["accepted", "rejected"] as const;
export type ChartPromotionOutcome = (typeof CHART_PROMOTION_OUTCOMES)[number];

/** The module that owns each target (the only module whose decided event is believed for it). */
export const CHART_PROMOTION_OWNER_EVENT: Readonly<Record<ChartPromotionTargetModule, string>> = {
  m8: "m8.chart_promotion.decided",
  m14: "m14.chart_promotion.decided",
};

export interface ChartPromotionDto {
  readonly id: string;
  readonly message_id: string;
  readonly channel_id: string;
  readonly patient_id: string;
  readonly target_module: ChartPromotionTargetModule;
  readonly target_kind: ChartPromotionTargetKind;
  readonly suggested_target_ref: string | null;
  readonly status: ChartPromotionStatus;
  readonly requested_by: string;
  readonly requested_by_display_name: string | null;
  readonly requested_at: string;
  readonly source_author_user_id: string;
  readonly source_author_display_name: string | null;
  readonly source_sent_at: string;
  readonly result_ref: string | null;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly reason_code: ChartPromotionReasonCode | null;
  readonly allowed_actions: readonly ChartPromotionAction[];
}

// --- the seam M8 and M14 read (owner M36, read-only, org-explicit, fail closed) ---

/** A proposal waiting for a reviewer. Metadata only: no text, no hash. */
export interface ChartPromotionPending {
  readonly requestId: string;
  readonly patientId: string;
  readonly targetModule: ChartPromotionTargetModule;
  readonly targetKind: ChartPromotionTargetKind;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly sourceAuthorUserId: string;
  readonly sourceSentAt: string;
  readonly sourceMessageId: string;
  readonly sourceChannelId: string;
  readonly suggestedTargetRef: string | null;
}

export interface ChartPromotionReview extends ChartPromotionPending {
  /** Copied onto the target record as its attribution; never shown to a user. */
  readonly sourceBodySha256: string;
  /** The quoted text, for the M8 target only (null for M14, or when the text can no longer be proven). */
  readonly snapshotText: string | null;
  /** `edited_since`: the sender edited the message after it was proposed; the text shown is the version proposed. */
  readonly sourceState: "current" | "edited_since";
}

export interface ChartPromotionPendingQuery {
  readonly targetModule: ChartPromotionTargetModule;
  readonly patientIds: readonly string[];
  readonly reviewerUserId: string;
  readonly limit: number;
}

export interface ChartPromotionReviewQuery {
  readonly targetModule: ChartPromotionTargetModule;
  readonly reviewerUserId: string;
}

/**
 * Read-only. Never writes, never decides. Every method is org-explicit (opens its own tenant context, callable outside a
 * request) and fails closed: a flag that is off, a Part 2 denial or failure, a missing or erased message, or a body that
 * no longer matches its recorded hash yields nothing (`false`, an empty list, `null`), never a partial answer.
 */
export interface ChartPromotionSourceReader {
  enabled(orgId: string): Promise<boolean>;
  pendingForPatients(
    orgId: string,
    q: ChartPromotionPendingQuery,
  ): Promise<readonly ChartPromotionPending[]>;
  forReview(
    orgId: string,
    requestId: string,
    q: ChartPromotionReviewQuery,
  ): Promise<ChartPromotionReview | null>;
}
