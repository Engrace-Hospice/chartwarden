// M36 WP 6.6 (ADR-0096 D19) - the partner invitation link. Both the organisation id and the one-time token ride the URL FRAGMENT
// (`/partner/share#o=<org>&t=<token>`): a fragment is never sent to a server, so neither reaches an access log, a proxy or a Referer header, and
// the partner page scrubs it from the address bar on load. No share id, partner name, channel or patient is ever in the link.
export const PARTNER_PAGE_PATH = "/partner/share";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function buildPartnerInvitationLink(
  origin: string,
  organizationId: string,
  inviteToken: string,
): string {
  return `${origin}${PARTNER_PAGE_PATH}#o=${organizationId}&t=${inviteToken}`;
}

export interface PartnerInvitation {
  readonly organizationId: string;
  readonly token: string;
}

/** The invitation in a URL fragment, or null when it is absent or malformed (the page then shows the one neutral state). */
export function parsePartnerFragment(hash: string): PartnerInvitation | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const organizationId = params.get("o");
  const token = params.get("t");
  if (!organizationId || !token || !UUID.test(organizationId) || !TOKEN.test(token)) return null;
  return { organizationId, token };
}
