// M36 WP 5.5 (ADR-0083, PROPOSED) - every word the device and session manager shows, in one place. PROVISIONAL pending SEC review of the
// session policy. Device names are coarse labels ("Chrome · macOS"); the screen never shows an IP address, a raw user agent or a token.

export const DEVICES_TITLE = "Devices and sessions";
export const DEVICES_BREADCRUMB = "General / Messaging";
export const DEVICES_NOTICE =
  "Every place you are signed in. Revoking one signs it out immediately, closes its live connection and stops push notifications to it.";
export const DEVICES_LIST_LABEL = "Your signed-in devices";
export const DEVICES_EMPTY_TITLE = "No other sessions";
export const DEVICES_EMPTY_TEXT = "No active sessions were found.";
export const DEVICES_LOAD_FAILED = "Could not load your devices.";
export const DEVICES_RETRY_LABEL = "Retry";
export const DEVICES_SIGN_IN = "Your session has ended. Sign in again to manage your devices.";
export const DEVICES_DENIED = "You are not permitted to manage these sessions.";

export const CURRENT_LABEL = "This device";
export const CURRENT_PILL = "Current";
export const PUSH_ON_PILL = "Push on";
export const PUSH_OFF_TEXT = "No push";
export const REVOKE_LABEL = "Revoke";
export const REVOKING_LABEL = "Revoking";
export const REVOKE_RETRY_LABEL = "Try again";

export const lastUsedText = (iso: string, nowMs: number): string => {
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "Last used time unknown";
  if (minutes < 2) return "Active now";
  if (minutes < 60) return `Last used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last used ${hours} h ago`;
  return `Last used ${Math.round(hours / 24)} days ago`;
};

export const revokeButtonName = (label: string, current: boolean): string =>
  current ? `Revoke ${label} (this device)` : `Revoke ${label}`;
export const revokedAnnouncement = (label: string): string => `${label} revoked`;
export const revokeFailedText = (label: string): string =>
  `Could not revoke ${label}. It is still signed in. Try again.`;

// Confirm step (required for the current session: revoking it signs the person out of this page).
export const CONFIRM_CURRENT_TITLE = "Sign out of this device?";
export const CONFIRM_CURRENT_TEXT =
  "You are revoking the session you are using now. You will be signed out and will need to sign in again. Anything you have not sent will be lost.";
export const CONFIRM_CURRENT_ACTION = "Revoke and sign out";
export const notFoundAnnouncement = (label: string): string =>
  `${label} was not found: it may already be revoked. The list was refreshed.`;
export const CONFIRM_CANCEL = "Cancel";

// The security officer's variant (messaging.sessions.manage; the revoke also needs a fresh step-up).
export const GOVERNANCE_TITLE = "Sessions";
export const GOVERNANCE_BREADCRUMB = "Admin / Messaging";
export const GOVERNANCE_NOTICE =
  "List and revoke another person's sessions in this organization. Every look and every revoke is recorded. A revoke needs a recent second-factor check.";
export const GOVERNANCE_USER_LABEL = "User id";
export const GOVERNANCE_USER_HINT = "Paste the person's user id, then press Show sessions.";
export const GOVERNANCE_SHOW_LABEL = "Show sessions";
export const GOVERNANCE_BAD_ID =
  "Enter a valid user id (it looks like 123e4567-e89b-12d3-a456-426614174000).";
export const GOVERNANCE_EMPTY_TITLE = "No active sessions";
export const GOVERNANCE_EMPTY_TEXT =
  "This person has no active sessions in this organization (or the id is not one of your users).";
export const GOVERNANCE_STEP_UP_TEXT =
  "A recent second-factor check is required to revoke a session. Verify with your authenticator, then try again.";
export const GOVERNANCE_LIST_LABEL = "Sessions of the selected person";
export const governanceRevokeName = (label: string): string => `Revoke ${label} for this person`;
