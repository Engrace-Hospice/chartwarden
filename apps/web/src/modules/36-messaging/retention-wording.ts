// M36 WP 5.6 (ADR-0086, PROPOSED) - every word the retention and legal-hold screen shows. PROVISIONAL pending compliance sign-off. The page shows
// ids, counts and dates only: never message text. Hold names and reasons are free text written by staff and are rendered as text, never as markup.
import type { MessageLegalHoldDto, MessageRetentionClass } from "@wardenx/types";

export const RETENTION_TITLE = "Retention and legal holds";
export const RETENTION_BREADCRUMB = "Admin / Messaging";
export const RETENTION_NOTICE =
  "The retention scan only plans. It never deletes a message, and approving a destruction certificate destroys nothing yet: message destruction is not built.";
export const TAB_RETENTION = "Retention";
export const TAB_HOLDS = "Legal holds";
export const TABS_LABEL = "Retention sections";

export const LOAD_FAILED = "Could not load this section.";
export const RETRY_LABEL = "Retry";
export const SIGN_IN = "Your session has ended. Sign in again to continue.";
export const DENIED = "You are not permitted to manage message retention or legal holds.";
export const STEP_UP_TEXT =
  "A recent second-factor check is required. Verify with your authenticator, then try again.";

export const CLASS_WORDING: Readonly<Record<MessageRetentionClass, string>> = {
  care_related: "Care-related messages",
  bereavement: "Bereavement messages",
  operational: "Operational messages",
};
export const periodText = (years: number): string =>
  years === 1 ? "Kept 1 year" : `Kept ${years} years`;
export const SOURCE_TEXT = "Platform default. It cannot be changed here.";
export const eligibleText = (n: number | null): string =>
  n === null ? "Not scanned yet" : n === 1 ? "1 message eligible" : `${n} messages eligible`;
export const heldText = (n: number | null): string =>
  n === null
    ? ""
    : n === 1
      ? "1 message held by a legal hold"
      : `${n} messages held by a legal hold`;
export const CAPPED_TEXT = "Counts stop at the scan limit; more messages may be eligible.";
export const CERTIFICATE_NONE = "No destruction certificate open.";
// The server sends the M4 certificate status as a plain string; an unrecognised value reads as a neutral word, never the raw enum.
const CERTIFICATE_STATUS_WORDING: Readonly<Record<string, string>> = {
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
  partial_refused: "Partly refused",
  held: "Held",
};
export const CERTIFICATE_STATUS_UNKNOWN = "Status not recognised";
export const certificateStatusLabel = (status: string): string =>
  CERTIFICATE_STATUS_WORDING[status] ?? CERTIFICATE_STATUS_UNKNOWN;
export const certificateText = (status: string): string =>
  `Destruction certificate: ${certificateStatusLabel(status).toLowerCase()}. Approving it destroys nothing yet.`;
export const certificateIdText = (id: string): string => `Certificate ${id}`;
export const NEVER_SCANNED = "No scan has run yet. Counts appear after the first scan.";
export const lastScanText = (when: string): string => `Last scan ${when}`;
export const nextScanText = (when: string): string => `Next scan ${when}`;
export const RETENTION_LIST_LABEL = "Retention by message class";

export const HOLDS_LIST_LABEL = "Legal holds";
export const HOLDS_EMPTY_TITLE = "No legal holds";
export const HOLDS_EMPTY_TEXT =
  "No legal hold covers messages. Place one to keep matching messages out of the retention plan.";
export const PLACE_HOLD_LABEL = "Place legal hold";
export const HOLD_STATUS = {
  active: { label: "Active", tone: "warning", glyph: "block" },
  released: { label: "Released", tone: "neutral", glyph: "check-circle" },
} as const;
export const heldMessagesText = (n: number): string =>
  n === 1 ? "1 message held" : `${n} messages held`;
export const placedText = (by: string, at: string): string => `Placed by ${by} on ${at}`;
export const PLACED_BY_YOU = "you";
export const shortUserId = (id: string): string => `user ${id.slice(0, 8)}`;
export const releasedText = (at: string): string => `Released ${at}`;
export const releaseLabel = (hold: Pick<MessageLegalHoldDto, "name">): string =>
  `Release hold ${hold.name}`;
export const RELEASE_BUTTON = "Release";
export const ORG_WIDE_TEXT = "Whole organization";

export function scopeText(scope: MessageLegalHoldDto["scope"]): string {
  if (scope.org_wide) return ORG_WIDE_TEXT;
  const parts: string[] = [];
  if (scope.channel_ids.length > 0) parts.push(`Channels: ${scope.channel_ids.join(", ")}`);
  if (scope.user_ids.length > 0) parts.push(`People: ${scope.user_ids.join(", ")}`);
  if (scope.patient_ids.length > 0) parts.push(`Patients: ${scope.patient_ids.join(", ")}`);
  return parts.join(" · ");
}

export const CREATE_TITLE = "Place a legal hold";
export const CREATE_DETAIL =
  "A hold keeps matching messages out of the retention plan. It does not change a message's class or period. A channel or person hold covers the messages in that channel or sent by that person. A patient hold also covers that patient's other records and every bereavement channel. Holding the whole organization covers all messages only.";
export const NAME_LABEL = "Name";
export const REASON_LABEL = "Reason";
export const REASON_HINT = "At least 10 characters. It is kept in the audit trail.";
export const REASON_PRIVACY_HINT =
  "Do not include patient names or identifiers; the reason is stored in audit events.";
export const ORG_WIDE_LABEL = "Hold every message in the organization";
export const CHANNEL_IDS_LABEL = "Channel ids";
export const USER_IDS_LABEL = "Person ids";
export const PATIENT_IDS_LABEL = "Patient ids";
export const IDS_HINT = "One id per line or separated by commas.";
export const CREATE_ACTION = "Place hold";
export const CANCEL_LABEL = "Cancel";
export const BACK_LABEL = "Back";
export const NAME_REQUIRED = "Enter a name for the hold.";
export const REASON_SHORT = "The reason must be at least 10 characters.";
export const SCOPE_REQUIRED = "Choose a scope: at least one id, or the whole organization.";
export const idsInvalid = (label: string): string => `${label}: every entry must be a valid id.`;
export const CREATE_FAILED = "The hold could not be placed. Nothing was changed; try again.";
export const CREATE_INVALID =
  "The server did not accept this hold. Check the scope and the reason.";
export const PLACED_ANNOUNCEMENT = "Legal hold placed.";

export const RELEASE_TITLE = "Release legal hold";
export const previewText = (n: number): string =>
  n === 1
    ? "1 message will become eligible on the next scan."
    : `${n} messages will become eligible on the next scan.`;
export const PREVIEW_LOADING = "Counting the messages this release frees.";
export const PREVIEW_FAILED = "Could not count the messages this release frees.";
export const RELEASE_REASON_LABEL = "Reason for release";
export const CONTINUE_LABEL = "Continue";
export const CONFIRM_TITLE = "Confirm release";
export const confirmText = (name: string, n: number): string =>
  `Release hold ${name}? ${previewText(n)} The scan is plan-only: nothing is destroyed until a certificate is approved, and approval destroys nothing yet.`;
export const confirmActionLabel = (name: string): string => `Release hold ${name} now`;
export const staleText = (n: number): string =>
  `The count changed while you were deciding. ${previewText(n)} Confirm again to release.`;
export const RELEASE_FAILED = "The hold could not be released. Nothing was changed; try again.";
export const PREVIEW_RETRY_LABEL = "Retry count";
export const RELEASE_ANNOUNCEMENT = "Legal hold released.";
