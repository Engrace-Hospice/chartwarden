// M36 WP 4.12 (ADR-0080) - every word the on-call directory shows, in one place. PROVISIONAL pending clinical-lead review. The screen
// only answers "who is covering now"; it pages and sends nothing, and a gap or an unconnected roster is said in words, never an empty list.
import type { OnCallDirectoryRole, OnCallRank } from "@chartwarden/types";

export const ONCALL_TITLE = "On call now";
export const ONCALL_BREADCRUMB = "General / Messaging";
export const ONCALL_NOTICE =
  "Who is covering right now. This list does not page anyone and is not the emergency path; for critical symptoms follow the agency telephone procedure.";
export const ONCALL_ROLE_LABEL = "Role";
export const ONCALL_ROLE_NAMES: Readonly<Record<OnCallDirectoryRole, string>> = {
  rn: "RN",
  physician: "Physician",
};
export const ONCALL_NO_PATIENT_TITLE = "Open this from a patient's care team";
export const ONCALL_NO_PATIENT_TEXT =
  "Coverage is read for one patient's care team. Open the on-call list from a patient's conversation to see who covers that team.";
export const ONCALL_LOAD_FAILED = "Could not load who is on call.";
export const ONCALL_STALE = "This may be out of date: the last refresh failed.";
export const ONCALL_RETRY_LABEL = "Retry";
export const ONCALL_DENIED = "You are not permitted to see who is on call.";
export const ONCALL_UNAVAILABLE =
  "The on-call directory is not available here: it is not turned on for your organization, or you do not have access to this patient.";
export const ONCALL_SIGN_IN = "Your session has ended. Sign in again to see who is on call.";
export const ONCALL_NOT_CONNECTED =
  "The on-call roster is not connected, so who is covering is unknown. Use the agency telephone procedure.";
export const ONCALL_NOT_CONFIGURED =
  "No on-call schedule is set up for this role. Use the agency telephone procedure.";
export const ONCALL_GAP = "No one is rostered right now. Use the agency telephone procedure.";
export const ONCALL_NAME_UNKNOWN = "Name not available";
export const ONCALL_SHIFT_END_UNKNOWN = "Shift end not provided";
export const ONCALL_ZONE_UNKNOWN = "time zone unavailable";

/** Closed wording for the server's rank enum (text, never colour alone). No server free text is shown. */
export const RANK_LABELS: Readonly<Record<OnCallRank, string>> = {
  primary: "Primary",
  backup: "Backup",
};

export const tierLabel = (tier: number): string =>
  tier === 1 ? "On call" : `Backup, tier ${tier}`;

function format(iso: string, timeZone: string, withDate: boolean): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      ...(withDate ? { month: "short", day: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return null; // an unknown zone: say so instead of guessing the viewer's or the server's
  }
}

/** "as of 2:07 PM PDT": always in the roster's zone. */
export const asOfText = (iso: string, timeZone: string): string =>
  `as of ${format(iso, timeZone, false) ?? `${iso} (${ONCALL_ZONE_UNKNOWN})`}`;

/** "until 7:00 PM PDT" (with the date when the shift ends on another day than `asOf`), in the roster's zone. */
export const untilText = (endIso: string, asOfIso: string, timeZone: string): string => {
  const dayOf = (iso: string): string | null =>
    format(iso, timeZone, true)?.replace(/,? [\d:]+\s?[AP]M.*$/, "") ?? null;
  const sameDay = dayOf(endIso) === dayOf(asOfIso);
  return `until ${format(endIso, timeZone, !sameDay) ?? `${endIso} (${ONCALL_ZONE_UNKNOWN})`}`;
};
