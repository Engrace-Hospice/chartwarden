// M36 WP 5.9 (ADR-0084, PROPOSED) - every word the offboarding screen shows, in one place. PROVISIONAL pending clinical-lead and SEC review. The page
// shows counts and fixed labels only: no name, message text or patient. State is always a word plus a glyph, never colour alone.
import type { OffboardingItemKey, OffboardingItemState } from "@wardenx/types";

export const OFFBOARDING_TITLE = "Offboarding";
export const OFFBOARDING_BREADCRUMB = "Admin / Messaging";
export const OFFBOARDING_NOTICE =
  "Attribution is kept. Messages are never deleted. Running this ends the person's sessions and push notifications, moves what colleagues can take and lists what still needs a person.";
export const OFFBOARDING_LIST_LABEL = "Offboarding checklist";
export const OFFBOARDING_LOAD_FAILED = "Could not load the offboarding status.";
export const OFFBOARDING_RETRY_LABEL = "Retry";
export const OFFBOARDING_SIGN_IN = "Your session has ended. Sign in again to continue.";
export const OFFBOARDING_DENIED = "You are not permitted to offboard this person.";
export const OFFBOARDING_NOT_FOUND = "This person was not found in your organization.";
export const OFFBOARDING_NOT_OFFBOARDED =
  "This person has not left. Offboarding applies to someone who was deactivated or removed.";
export const OFFBOARDING_STEP_UP_TEXT =
  "A recent second-factor check is required to run this. Verify with your authenticator, then try again.";
export const OFFBOARDING_RUN_FAILED =
  "Could not run the offboarding. Nothing was lost; run it again.";

export const progressText = (done: number, total: number): string => `Done ${done} of ${total}`;

export const RUN_LABEL = "Run offboarding";
export const RUN_AGAIN_LABEL = "Run again";
export const RUNNING_LABEL = "Running";
export const CONFIRM_TITLE = "Run offboarding?";
export const CONFIRM_TEXT =
  "This ends every session and push notification of this person now, moves the work colleagues can take, and removes their scheduled sends and reminders. Nothing is deleted from the record. It is safe to run again.";
export const CONFIRM_ACTION = "Run offboarding";
export const CONFIRM_CANCEL = "Cancel";

export const COMPLETE_TEXT = "Complete: nothing is left for messaging to do.";
export const blockedText = (n: number): string =>
  n === 1
    ? "Not complete: 1 item still needs attention."
    : `Not complete: ${n} items still need attention.`;
export const RAN_ANNOUNCEMENT = "Offboarding ran. The checklist shows what is left.";

export interface ItemWording {
  readonly title: string;
  readonly detail: string;
}

export const ITEM_WORDING: Readonly<Record<OffboardingItemKey, ItemWording>> = {
  sessions_devices: {
    title: "Sessions and devices",
    detail: "Sessions are signed out and push notifications stop.",
  },
  channel_memberships: {
    title: "Channel memberships",
    detail: "Removed from live delivery; history and attribution stay.",
  },
  tasks: {
    title: "Open communication tasks",
    detail: "Moved to the creator or the care team; one with nobody is flagged for its creator.",
  },
  handoffs: {
    title: "Handoffs offered or received",
    detail: "Offers to the person are declined; offers from them are flagged to supervisors.",
  },
  ack_assigned: {
    title: "Requests waiting on this person",
    detail:
      "Moved to an eligible colleague; one nobody can take stays in the unacknowledged queue.",
  },
  ack_sent: {
    title: "Requests this person sent",
    detail: "Kept as sent; the sender is never changed.",
  },
  urgent_untracked: {
    title: "Urgent messages with no tracked request",
    detail: "A supervisor must check that someone has seen them.",
  },
  oncall_seats: {
    title: "On-call seats",
    detail: "The roster belongs to on-call scheduling. Check it for a vacant seat.",
  },
  scheduled_sends: {
    title: "Scheduled sends",
    detail: "Cancelled. Nothing is sent as this person.",
  },
  reminders_snoozes: {
    title: "Reminders and snoozes",
    detail: "Removed.",
  },
  drafts: {
    title: "Drafts",
    detail: "Kept, never sent and not shown to anyone.",
  },
};

export interface StateWording {
  readonly label: string;
  readonly tone: "success" | "progress" | "warning" | "error" | "neutral";
  readonly glyph: "check-circle" | "clock" | "alert" | "block" | "dot";
}

export const STATE_WORDING: Readonly<Record<OffboardingItemState, StateWording>> = {
  done: { label: "Done", tone: "success", glyph: "check-circle" },
  pending: { label: "To do", tone: "progress", glyph: "clock" },
  needs_person: { label: "Needs a person", tone: "warning", glyph: "alert" },
  kept: { label: "Kept", tone: "neutral", glyph: "dot" },
  advisory: { label: "Check manually", tone: "warning", glyph: "alert" },
  failed: { label: "Failed, run again", tone: "error", glyph: "block" },
};

export const countText = (count: number): string => (count === 1 ? "1 item" : `${count} items`);

export const UNACKNOWLEDGED_LINK_LABEL = "Open the unacknowledged queue";
export const UNACKNOWLEDGED_LINK = "/messaging/unacknowledged";
