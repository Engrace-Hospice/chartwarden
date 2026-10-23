// M36 WP 6.6 (ADR-0096, PROPOSED), slice S1 - external partner share (migration 1180): a read-only, single-conversation, expiring grant for a
// non-workforce partner. Constants and DTOs shared by the backend and the web. The numeric bounds and closed sets are pinned against the SQL CHECKs.

/** Tenant flag (absent = off): gates creating a share AND every partner route; listing and revoking never depend on it. */
export const EXTERNAL_PARTNERS_FLAG_KEY = "messaging.external_partners";

export const EXTERNAL_SHARE_MANAGE_PERMISSION = "messaging.share.manage";
/** Fresh step-up action for create and revoke. */
export const EXTERNAL_SHARE_MANAGE_STEP_UP_KEY = "messaging.share.manage";

/** CHECK `message_external_share_kind`. */
export const EXTERNAL_SHARE_PARTNER_KINDS = ["pharmacy", "dme", "other"] as const;
export type ExternalSharePartnerKind = (typeof EXTERNAL_SHARE_PARTNER_KINDS)[number];

/** D1: the only channel kinds that may be shared (no patient subject, no tenant-wide broadcast, no direct message: ADR-0096 D1). */
export const EXTERNAL_SHARE_CHANNEL_KINDS = ["discipline", "location", "on_call"] as const;

/** CHECK `message_external_session_stage`; enrolment -> active, once. */
export const EXTERNAL_SESSION_STAGES = ["enrolment", "active"] as const;
export type ExternalSessionStage = (typeof EXTERNAL_SESSION_STAGES)[number];

/** D3: default and maximum lifetime of a share, in days (CHECK `message_external_share_expiry` pins the 30). */
export const EXTERNAL_SHARE_DEFAULT_DAYS = 7;
export const EXTERNAL_SHARE_MAX_DAYS = 30;
/** CHECK `message_external_share_name_len` / `_baa_len`. */
export const EXTERNAL_SHARE_NAME_MAX = 120;
export const EXTERNAL_SHARE_BAA_MAX = 120;
/** D5: wrong second-factor attempts before the share locks (CHECK `message_external_share_attempts`). */
export const EXTERNAL_SHARE_MAX_CODE_ATTEMPTS = 5;
/** D10: abuse bounds. */
export const EXTERNAL_SHARE_MAX_LIVE_PER_TENANT = 10;
export const EXTERNAL_SHARE_MAX_PER_CREATOR_DAY = 3;
export const EXTERNAL_PARTNER_READS_PER_MINUTE = 60;
export const EXTERNAL_PARTNER_PAGE_MAX = 50;

/** D9: the ONLY text a partner notification may carry. A constant: there is no parameter through which content could enter. */
export const EXTERNAL_PARTNER_NOTIFICATION_TEXT =
  "You have a new secure message. Sign in with your link to read it.";

/** Trail-only outbox events (ids and instants only). */
export const EXTERNAL_SHARE_EVENT_CREATED = "m36.external_share.created";
export const EXTERNAL_SHARE_EVENT_REVOKED = "m36.external_share.revoked";

export interface CreateExternalShareRequest {
  readonly channelId: string;
  readonly partnerName: string;
  readonly partnerKind: ExternalSharePartnerKind;
  readonly baaReference: string;
  /** Days until expiry; default 7, at most 30. */
  readonly expiresInDays?: number | undefined;
}

export type ExternalShareStatus = "active" | "expired" | "revoked";

export interface ExternalShareDto {
  readonly id: string;
  readonly channelId: string;
  readonly channelTitle: string | null;
  readonly partnerName: string;
  readonly partnerKind: ExternalSharePartnerKind;
  readonly status: ExternalShareStatus;
  readonly sharedFrom: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly revokedAt: string | null;
  readonly redeemed: boolean;
  readonly codeLocked: boolean;
}

/** Returned ONCE at creation: the invitation link parts and the code the creator gives the partner through a different channel. */
export interface CreatedExternalShareDto extends ExternalShareDto {
  /** Part of the redeem body the partner sends with the token. */
  readonly organizationId: string;
  readonly inviteToken: string;
  readonly verificationCode: string;
}

/** The partner's view of their own share: no channel id, no staff identity. */
export interface PartnerShareStateDto {
  readonly shareId: string;
  readonly stage: ExternalSessionStage;
  readonly partnerName: string;
  readonly expiresAt: string;
}

export interface PartnerMessageDto {
  readonly messageId: string;
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly edited: boolean;
}

export interface PartnerMessagesDto {
  readonly messages: readonly PartnerMessageDto[];
  /** Keyset cursor (the last message's created_at text); null when there is no further page. */
  readonly nextCursor: string | null;
}
