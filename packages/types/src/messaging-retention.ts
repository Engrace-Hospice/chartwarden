// M36 WP 5.6 (ADR-0086, PROPOSED) - message retention and legal hold. The retention periods themselves stay in @chartwarden/messaging
// (channel kinds); these are the cross-package names: the permission, the two fresh-step-up operation keys, the reason floor and the
// M4 destruction-certificate data classes the plan-only retention scan opens.

/** Lets a compliance officer apply / release a legal hold on messages and read the retention view (migration 1138). */
export const MESSAGING_RETENTION_MANAGE_PERMISSION = "messaging.retention.manage";

/** Fresh step-up operation keys; the apply and release routes each demand one. */
export const MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY = "messaging.legal_hold.apply";
export const MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY = "messaging.legal_hold.release";

/** A hold or release needs a written reason of at least this many characters. */
export const MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH = 10;
/** `legal_hold.criteria.origin` of a hold placed through the governance apply route. NOT a selector: readers ignore it; only the
 *  governance seam filters on it, so `messaging.retention.manage` never sees or releases a hold placed under `legalhold.manage`. */
export const MESSAGING_GOVERNANCE_HOLD_ORIGIN = "messaging_governance";

/**
 * Tenant ops flag (FeatureFlagReaderPort: tenant row wins, absent = off) that lets the message destruction executor run at all for a
 * tenant. ON still means DRY RUN unless the platform also sets `M36_RETENTION_DESTRUCTION_EXECUTE=true` (the second, deployment-wide key).
 */
export const RETENTION_DESTRUCTION_FLAG_KEY = "messaging.retention_destruction";
/**
 * Third tenant ops flag (absent = off): with `messaging.retention_destruction` ALSO on, the executor destroys the attachment OBJECTS of the
 * messages it is about to delete (same dry-run/live modes, same approved certificate, never a held message). Off: a message that still bears an
 * undestroyed object is kept, exactly as before. The scan counts such messages toward the certificate only while this flag is on.
 */
export const RETENTION_ATTACHMENT_DESTRUCTION_FLAG_KEY =
  "messaging.retention_attachment_destruction";
/** Environment key of the second switch: the executor deletes only when it is exactly "true". */
export const RETENTION_DESTRUCTION_EXECUTE_ENV = "M36_RETENTION_DESTRUCTION_EXECUTE";
export const RETENTION_DESTRUCTION_MODES = ["off", "dry_run", "live"] as const;
export type RetentionDestructionMode = (typeof RETENTION_DESTRUCTION_MODES)[number];
/** flag off => off; flag on, execute key unset => dry_run (deletes nothing); both => live. */
export const retentionDestructionModeOf = (
  flagOn: boolean,
  executeOn: boolean,
): RetentionDestructionMode => (!flagOn ? "off" : executeOn ? "live" : "dry_run");

/** The message retention classes, and the M4 certificate data class the scan files for each (`message.<class>`). */
export const MESSAGE_RETENTION_CLASSES = ["care_related", "bereavement", "operational"] as const;
export type MessageRetentionClass = (typeof MESSAGE_RETENTION_CLASSES)[number];
export const MESSAGE_RETENTION_DATA_CLASSES: readonly `message.${MessageRetentionClass}`[] =
  MESSAGE_RETENTION_CLASSES.map((c) => `message.${c}` as const);

// ---- HTTP contract of the governance routes (WP 5.6 S4 implements, S5 consumes). Ids, counts, dates and the display name of the STAFF
// ---- member who placed a hold or handled a redaction: never a message or a patient. Base path: /api/v1/messaging/governance. Wire keys are snake_case like the offboarding DTOs.

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
  /** ISO time of the next scheduled weekly scan. The scan only plans; destruction needs an APPROVED M4 certificate and the mode below. */
  readonly next_scan_at: string;
  readonly last_scan_at: string | null;
  /** off: the executor does nothing for this tenant; dry_run: it reports and deletes nothing; live: it destroys under approved certificates. */
  readonly destruction_mode: RetentionDestructionMode;
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
  /** The placing user's id. */
  readonly placed_by: string;
  /** The placing user's display name, resolved through the identity directory port; null when it cannot be resolved (shown as a labelled id). */
  readonly placed_by_name: string | null;
  readonly placed_at: string;
  readonly released_at: string | null;
  /**
   * GET /legal-holds (list): the MATERIALISED overlay count (rows in legal_hold_message), which may lag the live criteria until the next
   * retention scan (a message sent after the hold is not counted yet; enforcement still holds it). POST /legal-holds (apply) and the
   * returns the exact live count at that moment; release-preview and the release confirmation always use the exact live count. A released
   * hold reports 0.
   */
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

/**
 * Advisory-lock name that serialises "a legal hold is applied" (M4, EXCLUSIVE, transaction-scoped) against "messages are destroyed"
 * (the M36 tenant eraser, SHARED): without it the eraser's any-active-hold check and its destructive write are separate snapshots
 * and a hold committed in between is erased through.
 */
export const messagingHoldLockName = (organizationId: string): string =>
  `m36-legal-hold:${organizationId}`;

// ---- Redaction (ADR-0055 item 7, applied to held and unheld messages alike; migration 1156). A redaction MASKS a message at the access layer;
// ---- it never destroys the cipher or rewrites a hashed column, so a legal hold neither blocks it nor is weakened by it. Two people: the
// ---- requester and the approver differ (CHECK in the database and the service).

/** Ask for a message to be redacted (a compliance act: no channel membership is needed, and the requester never sees the body). */
export const MESSAGING_REDACT_REQUEST_PERMISSION = "messaging.redact.request";
/** Approve a redaction another person requested; fresh step-up MESSAGE_REDACT_APPROVE_STEP_UP_KEY. */
export const MESSAGING_REDACT_APPROVE_PERMISSION = "messaging.redact.approve";
export const MESSAGE_REDACT_APPROVE_STEP_UP_KEY = "messaging.redact.approve";
export const MESSAGE_REDACTION_REASON_MIN_LENGTH = 10;
export const MESSAGE_REDACTION_REASON_MAX_LENGTH = 1000;

/** POST /redactions. */
export interface RequestMessageRedactionRequest {
  readonly message_id: string;
  readonly reason: string;
}

/** One redaction as the governance screen reads it. Ids, names, instants and whether a hold applies: never the message or the reason text. */
export interface MessageRedactionDto {
  readonly id: string;
  readonly message_id: string;
  /** requested: masked for nobody yet; approved: masked for every reader. */
  readonly status: "requested" | "approved";
  readonly requested_by: string;
  readonly requested_by_name: string | null;
  readonly requested_at: string;
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  readonly approved_at: string | null;
  /** True when an active legal hold currently covers the message: the cipher is retained either way. */
  readonly under_legal_hold: boolean;
}
export interface MessageRedactionListDto {
  readonly redactions: readonly MessageRedactionDto[];
}
