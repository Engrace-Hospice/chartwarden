// apps/web/src/modules/31-portal - shared presentation helpers for the M31 staff surfaces (GAP-054).
import type { StatusTone } from "@chartwarden/ui";

const ACCOUNT_TONE: Record<string, StatusTone> = {
  active: "success",
  invited: "progress",
  bereaved: "neutral",
  suspended: "warning",
  revoked: "error",
};

const VISIT_TONE: Record<string, StatusTone> = {
  scheduled: "neutral",
  waiting: "progress",
  in_progress: "success",
  ended: "neutral",
  cancelled: "neutral",
  failed: "error",
};

const title = (token: string): string =>
  token.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const accountTone = (status: string): StatusTone => ACCOUNT_TONE[status] ?? "neutral";
export const visitTone = (state: string): StatusTone => VISIT_TONE[state] ?? "neutral";
export const statusLabel = title;

/** A visit that has finished (or never ran) cannot be joined or ended any more. */
export const isVisitLive = (state: string): boolean =>
  state !== "ended" && state !== "cancelled" && state !== "failed";

/** Daily.co's hosted-room frame source: https on the vendor host only, token in the `t` parameter. */
export interface JoinTicket {
  readonly vendor: string;
  readonly vendorJoinUrl: string;
  readonly vendorParticipantToken: string;
}

export const TELEHEALTH_FRAME_ALLOW = "camera; microphone; fullscreen; display-capture; autoplay";

export function roomFrameUrl(ticket: JoinTicket): string | null {
  if (ticket.vendor !== "daily_co" || !ticket.vendorParticipantToken) return null;
  let url: URL;
  try {
    url = new URL(ticket.vendorJoinUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".daily.co")) return null;
  const framed = new URL(url.toString());
  framed.searchParams.set("t", ticket.vendorParticipantToken);
  return framed.toString();
}
