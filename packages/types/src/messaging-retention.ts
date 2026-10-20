// M36 WP 5.6 (ADR-0086, PROPOSED) - message retention and legal hold. The retention periods themselves stay in @wardenx/messaging
// (channel kinds); these are the cross-package names: the permission, the two fresh-step-up operation keys, the reason floor and the
// M4 destruction-certificate data classes the plan-only retention scan opens.

/** Lets a compliance officer apply / release a legal hold on messages and read the retention view (migration 1137). */
export const MESSAGING_RETENTION_MANAGE_PERMISSION = "messaging.retention.manage";

/** Fresh step-up operation keys; the apply and release routes each demand one. */
export const MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY = "messaging.legal_hold.apply";
export const MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY = "messaging.legal_hold.release";

/** A hold or release needs a written reason of at least this many characters. */
export const MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH = 10;

/** The message retention classes, and the M4 certificate data class the scan files for each (`message.<class>`). */
export const MESSAGE_RETENTION_CLASSES = ["care_related", "bereavement", "operational"] as const;
export type MessageRetentionClass = (typeof MESSAGE_RETENTION_CLASSES)[number];
export const MESSAGE_RETENTION_DATA_CLASSES: readonly `message.${MessageRetentionClass}`[] =
  MESSAGE_RETENTION_CLASSES.map((c) => `message.${c}` as const);

// ---- HTTP contract of the governance routes (WP 5.6 S4 implements, S5 consumes). Ids, counts and dates only: never a message, a name or a
// ---- patient. Base path: /api/v1/messaging/governance. Wire keys are snake_case like the offboarding DTOs.

export const MESSAGE_LEGAL_HOLD_SCOPE_KINDS = ["channel", "patient", "user"] as const;
export type MessageLegalHoldScopeKind = (typeof MESSAGE_LEGAL_HOLD_SCOPE_KINDS)[number];

/** GET /retention - one row per class; the periods are read-only (ADR-0086 D2). */
export interface RetentionClassDto {
  readonly class: MessageRetentionClass;
  readonly period_years: number;
  /** Always the platform default in this WP; there is no tenant override. */
  readonly source: "platform_default";
  /** Planned by the last scan: eligible now / withheld by a hold. null before the first scan. */
  readonly eligible: number | null;
  readonly held: number | null;
  readonly capped: boolean;
  /** Pending M4 certificate for the current month, if the scan opened one (ids only; link target is the M4 certificate list). */
  readonly certificate_id: string | null;
  readonly certificate_status: string | null;
}
export interface RetentionOverviewDto {
  readonly classes: readonly RetentionClassDto[];
  /** ISO time of the next scheduled weekly scan; the scan is plan-only until a human approves a certificate, and approval destroys nothing yet. */
  readonly next_scan_at: string;
  readonly last_scan_at: string | null;
  readonly destruction_built: false;
}

/** GET /legal-holds - messaging-relevant M4 holds (channelIds/userIds/patientIds/org-wide) with scope ids and counts. */
export interface MessageLegalHoldDto {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "released";
  readonly scope: {
    readonly channel_ids: readonly string[];
    readonly user_ids: readonly string[];
    readonly patient_ids: readonly string[];
    readonly org_wide: boolean;
  };
  readonly placed_by: string;
  readonly placed_at: string;
  readonly released_at: string | null;
  /** Messages held by this hold now (overlay rows plus live criteria; capped counts are exact up to the cap). */
  readonly held_messages: number;
}
export interface MessageLegalHoldListDto {
  readonly holds: readonly MessageLegalHoldDto[];
}

/** POST /legal-holds (permission + fresh step-up MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY). At least one of the three id lists, or org_wide true. */
export interface ApplyMessageLegalHoldRequest {
  readonly name: string;
  readonly reason: string;
  readonly channel_ids?: readonly string[];
  readonly user_ids?: readonly string[];
  readonly patient_ids?: readonly string[];
  readonly org_wide?: boolean;
}

/** GET /legal-holds/:id/release-preview. */
export interface MessageLegalHoldReleasePreviewDto {
  readonly hold_id: string;
  readonly held_messages: number;
  /** Past their retention window and held by no other active hold: they become eligible on the next scan. */
  readonly eligible_on_release: number;
}

/** POST /legal-holds/:id/release (permission + fresh step-up MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY). Server recomputes; a different count is 409 RELEASE_PREVIEW_STALE. */
export interface ReleaseMessageLegalHoldRequest {
  readonly reason: string;
  readonly confirmed_eligible_count: number;
}
export const RELEASE_PREVIEW_STALE_CODE = "RELEASE_PREVIEW_STALE";
