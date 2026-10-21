// WP 2.10: small pure helpers for the poll card and the create dialog.
import { POLL_BLOCKED_CHANNEL_KINDS, type PollView } from "@chartwarden/types";
import type { ChannelKind } from "./messaging-types";

/** Channel kinds that carry a patient link: polls are non-clinical, so the composer action is unavailable there. */
export const POLL_BLOCKED_KINDS: readonly ChannelKind[] = POLL_BLOCKED_CHANNEL_KINDS;

export const POLL_BLOCKED_EXPLANATION =
  "Polls are for non-clinical questions and are not available in a conversation linked to a patient.";

export function pollAllowedIn(kind: ChannelKind): boolean {
  return !POLL_BLOCKED_KINDS.includes(kind);
}

/** "3 votes (60%)" - the count and the share as text, so the result never depends on colour or bar length. */
export function voteSummary(count: number, total: number): string {
  const share = total === 0 ? 0 : Math.round((count / total) * 100);
  return `${count} ${count === 1 ? "vote" : "votes"} (${share}%)`;
}

export function pollStatusText(poll: Pick<PollView, "closed" | "totalVotes">): string {
  const votes = `${poll.totalVotes} ${poll.totalVotes === 1 ? "vote" : "votes"}`;
  return `${votes} · ${poll.closed ? "Closed" : "Open"}`;
}

export type PollAction = "vote" | "close" | "load";

/** What to tell the user after a refused poll request. */
export function pollFailureCopy(status: number | undefined, action: PollAction): string {
  if (status === 409) return "This poll has closed. Votes can no longer be changed.";
  if (status === 410) return "This conversation is archived and read only.";
  if (status === 404) return "This poll is no longer available.";
  if (status === 403 && action === "close") {
    return "Only the person who asked the question or a channel manager can close this poll.";
  }
  if (action === "close") return "The poll could not be closed. Try again.";
  if (action === "load") return "Who voted could not be loaded. Try again.";
  return "Your vote could not be saved. Try again.";
}
