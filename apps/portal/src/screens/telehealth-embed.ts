// @wardenx/portal - the iframe src for a telehealth join ticket (GAP-053).
//
// Daily.co's hosted room is embedded as an iframe with the per-participant meeting token in the `t` query
// parameter; the token is short-lived and bound to one room. Anything that is not an https URL on the
// ticket's own vendor host is refused (null), so a malformed or spoofed ticket never becomes a navigable frame.
export interface TelehealthEmbedTicket {
  readonly vendor: string;
  readonly vendorJoinUrl: string;
  readonly vendorParticipantToken: string;
}

const EMBEDDABLE_VENDOR = "daily_co";
const DAILY_HOST_SUFFIX = ".daily.co";

/** The permissions the video frame needs and nothing else (camera, microphone, fullscreen, screen share). */
export const TELEHEALTH_FRAME_ALLOW = "camera; microphone; fullscreen; display-capture; autoplay";

export function telehealthEmbedUrl(ticket: TelehealthEmbedTicket): string | null {
  if (ticket.vendor !== EMBEDDABLE_VENDOR || !ticket.vendorParticipantToken) return null;
  let url: URL;
  try {
    url = new URL(ticket.vendorJoinUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(DAILY_HOST_SUFFIX)) return null;
  const framed = new URL(url.toString());
  framed.searchParams.set("t", ticket.vendorParticipantToken);
  return framed.toString();
}
