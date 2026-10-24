// M36 WP 6.7 (ADR-0099, PROPOSED), slice S1 - family / caregiver messaging without an app (migrations 1230 and 1231): a consented person, bound to ONE
// M5 `patient_caregiver` row, writes text into a dedicated `family` conversation through a one-time link plus an out-of-band code. Constants and DTOs
// shared by the backend and the web. Every number marked "default" is a BUILD-TEAM default (ADR-0099 D3/D8), not an agreed value; the closed sets and
// bounds are pinned against the SQL CHECKs by a test.

/** Tenant flag (absent = off): gates creating an invitation AND every contact route; list, revoke, close and block never depend on it (D18). */
export const FAMILY_MESSAGING_FLAG_KEY = "messaging.family_messaging";

/** D9: create / reissue / revoke / close / block / settings. */
export const FAMILY_MANAGE_PERMISSION = "messaging.family.manage";
/** D9: see the Family lane and reply (the care-team disciplines). */
export const FAMILY_RESPOND_PERMISSION = "messaging.family.respond";
/** Fresh step-up action for create, revoke, block and unblock. */
export const FAMILY_MANAGE_STEP_UP_KEY = "messaging.family.manage";

/** CHECK `message_family_session_stage`; enrolment -> active, once. */
export const FAMILY_SESSION_STAGES = ["enrolment", "active"] as const;
export type FamilySessionStage = (typeof FAMILY_SESSION_STAGES)[number];

/** CHECK `message_family_contact_mode` (D15). */
export const FAMILY_MODES = ["standard", "bereavement"] as const;
export type FamilyMode = (typeof FAMILY_MODES)[number];

/** CHECK `message_family_invitation_revoke_reason`. `superseded` = a newer invitation replaced it (the reissue). */
export const FAMILY_REVOKE_REASONS = ["staff", "superseded", "blocked"] as const;
export type FamilyRevokeReason = (typeof FAMILY_REVOKE_REASONS)[number];

/** CHECK `message_family_access_action`. */
export const FAMILY_ACCESS_ACTIONS = ["read", "send"] as const;
export type FamilyAccessAction = (typeof FAMILY_ACCESS_ACTIONS)[number];

/** DEFAULT (D3): invitation life, in days (CHECK `message_family_invitation_expiry` pins the 30). */
export const FAMILY_INVITE_DEFAULT_DAYS = 7;
export const FAMILY_INVITE_MAX_DAYS = 30;
/** DEFAULT (D3): wrong code attempts before the invitation locks; only a staff reissue (a new invitation row) starts again (CHECK pins it). */
export const FAMILY_MAX_CODE_ATTEMPTS = 5;
/** DEFAULT (D3, DECISION NEEDED security): the code is eight digits plus a per-deployment pepper held outside the table. */
export const FAMILY_CODE_LENGTH = 8;
/** DEFAULT (D3): a contact session dies after this many idle minutes or this many hours in total, whichever is first (CHECK + guard pin them). */
export const FAMILY_SESSION_IDLE_MINUTES = 30;
export const FAMILY_SESSION_MAX_HOURS = 12;
/** D4: the longest message a contact may send. No attachments. */
export const FAMILY_MESSAGE_MAX_CHARS = 2000;
/** DEFAULT (D8): send budgets per contact (database clock) and the contact-message cap per thread before staff answer. */
export const FAMILY_SEND_PER_HOUR = 10;
export const FAMILY_SEND_PER_DAY = 40;
export const FAMILY_THREAD_UNANSWERED_CAP = 200;
/** DEFAULT (D8): invitations created per organisation / per staff creator in a rolling day. */
export const FAMILY_INVITES_PER_ORG_DAY = 25;
export const FAMILY_INVITES_PER_CREATOR_DAY = 10;
/** DEFAULT (D15): the bereavement programme window, in months after the death date. */
export const FAMILY_BEREAVEMENT_WINDOW_MONTHS = 13;
/** DEFAULT (D12, DECISION NEEDED clinical lead): days a contact keeps access after a discharge that is not a death. */
export const FAMILY_DISCHARGE_GRACE_DAYS = 0;
export const FAMILY_PAGE_MAX = 50;
/** Tenant setting bounds. */
export const FAMILY_SETTING_TEXT_MAX = 120;

/** D17: no automatic sender in this build. Named so no slice mixes it with the flag above. */
export const FAMILY_SEND_FLAG_KEY = "messaging.family_messaging.send";

/** D7: the ONLY text any family SMS / email may carry. Takes no argument. The catalogue key is `family.notification.text`. */
export const FAMILY_NOTIFICATION_TEXT =
  "You have a new secure message from your care team. Open your link to read it.";
/** D15: the bereavement-mode wording is a placeholder for the bereavement coordinator to replace; same constraints as D7. */
export const FAMILY_BEREAVEMENT_NOTIFICATION_TEXT =
  "You have a new message. Open your link to read it.";

/** D8: what a contact sees when the thread holds the unanswered cap. Plain, no blame. */
export const FAMILY_THREAD_CAP_MESSAGE =
  "The care team has not replied yet. Please call the agency if you need help sooner.";

/** D14: shown on the link page, the invitation screen and next to the composer, never omitted. */
export const FAMILY_NOT_EMERGENCY_TEXT =
  "This is not for emergencies. If this is an emergency, call 911 or the agency's 24-hour number.";

/** D16: trail-only outbox events (ids and instants only). */
export const FAMILY_EVENT_CREATED = "m36.family_contact.created";
export const FAMILY_EVENT_REVOKED = "m36.family_contact.revoked";
export const FAMILY_EVENT_BEREAVEMENT_MODE = "m36.family_contact.bereavement_mode";

/** D17 / ADR-0096 D17: the deployment cannot key per-address budgets on a real client address. */
export const FAMILY_ACCESS_UNAVAILABLE_CODE = "FAMILY_ACCESS_UNAVAILABLE";
/** D2: creating an invitation for a person who is not currently eligible. The reason code is in the details. */
export const FAMILY_NOT_ELIGIBLE_CODE = "FAMILY_CONTACT_NOT_ELIGIBLE";
export const FAMILY_SETTINGS_MISSING_CODE = "FAMILY_SETTINGS_MISSING";
export const FAMILY_CODE_INVALID_CODE = "FAMILY_CODE_INVALID";
export const FAMILY_LIMIT_CODE = "FAMILY_LIMIT";
export const FAMILY_THREAD_CLOSED_CODE = "FAMILY_THREAD_CLOSED";

/** Why a person is, or is not, eligible right now (D2 / D10 / D12). `ok` is the only reason that allows access. */
export const FAMILY_ELIGIBILITY_REASONS = [
  "ok",
  "no_consent",
  "involvement_ended",
  "part2_restricted",
  "patient_status",
  "not_in_bereavement_plan",
  "blocked",
] as const;
export type FamilyEligibilityReason = (typeof FAMILY_ELIGIBILITY_REASONS)[number];

export type FamilyLinkState =
  | "none"
  | "not_opened"
  | "verifying"
  | "active"
  | "locked"
  | "expired"
  | "revoked";

export interface FamilySettingsDto {
  /** D7: a neutral sender / agency display name chosen by the tenant (DECISION NEEDED privacy officer). */
  readonly agencyName: string | null;
  /** D14: the agency's 24-hour number. Required before an invitation may be created. */
  readonly agencyPhone: string | null;
  /** D15: the bereavement support number. */
  readonly bereavementPhone: string | null;
}

export interface FamilyEligibleCaregiverDto {
  readonly patientCaregiverId: string;
  readonly displayName: string;
  readonly relationship: string;
  readonly isLegalRepresentative: boolean;
  readonly eligible: boolean;
  readonly reason: FamilyEligibilityReason;
  /** The language the contact prefers (ISO-639), or null. */
  readonly language: string | null;
}

export interface CreateFamilyInvitationRequest {
  readonly patientId: string;
  readonly patientCaregiverId: string;
  /** Days until the link expires; default 7, at most 30. */
  readonly expiresInDays?: number | undefined;
  /** D1: the staff member confirms the code will be given by voice, never in the same message as the link. */
  readonly codeByVoiceConfirmed: true;
}

export interface FamilyContactSummaryDto {
  readonly contactId: string;
  readonly patientId: string;
  readonly patientCaregiverId: string;
  /** Staff-only: the patient the thread is about. Never sent to the contact. */
  readonly patientName: string;
  readonly displayName: string;
  readonly relationship: string;
  readonly consentState: FamilyEligibilityReason;
  readonly linkState: FamilyLinkState;
  readonly mode: FamilyMode;
  readonly language: string | null;
  readonly closed: boolean;
  readonly blocked: boolean;
  readonly channelId: string | null;
  readonly lastContactActivityAt: string | null;
  /** The instant of the oldest contact message nobody on the care team has answered, or null. */
  readonly unansweredSince: string | null;
  /** D8: the contact reached the hourly send budget. */
  readonly highVolume: boolean;
}

/** Returned ONCE: the link parts and the code the staff member speaks to the contact (D3). */
export interface CreatedFamilyInvitationDto {
  readonly contactId: string;
  readonly organizationId: string;
  readonly inviteToken: string;
  readonly verificationCode: string;
  readonly expiresAt: string;
  readonly agencyPhone: string;
}

export interface FamilyStaffMessageDto {
  readonly messageId: string;
  readonly from: "contact" | "staff";
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface FamilyStaffThreadDto {
  readonly contact: FamilyContactSummaryDto;
  readonly messages: readonly FamilyStaffMessageDto[];
}

/** The contact's view of their own access (D4a). No patient, no staff, no ids beyond the stage. */
export interface FamilyContactStateDto {
  readonly stage: FamilySessionStage;
  readonly mode: FamilyMode;
  readonly agencyName: string | null;
  readonly agencyPhone: string | null;
  readonly bereavementPhone: string | null;
  readonly language: string | null;
  readonly closed: boolean;
  readonly expiresAt: string;
}

/** D3: what verify returns. `sessionToken` is the NEW active bearer, shown once; null when the session was already active. */
export interface FamilyContactVerifiedDto extends FamilyContactStateDto {
  readonly sessionToken: string | null;
}

export interface FamilyContactMessageDto {
  readonly messageId: string;
  readonly from: "you" | "care_team";
  readonly body: string;
  readonly createdAt: string;
  /** Only for the contact's own messages: a staff member has the thread in a worked queue (D4). */
  readonly receivedByCareTeam: boolean;
}

export interface FamilyContactMessagesDto {
  readonly messages: readonly FamilyContactMessageDto[];
  readonly nextCursor: string | null;
}
