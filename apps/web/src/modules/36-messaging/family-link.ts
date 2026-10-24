// M36 WP 6.7 (ADR-0099 D3) - the family contact's link. The organisation id, the one-time token and the agency's 24-hour number ride the URL FRAGMENT
// (`/family/open#t=<token>&o=<org>`): a fragment is never sent to a server, so none of them reaches an access log, a proxy or a Referer header.
// The page scrubs it from the address bar on load. The link carries NO phone number: anything in a URL is forgeable, and a number shown on this page
// under the agency's name would be a phishing prompt ("call this number"). The only numbers the page shows come from the server, for a valid bearer.
export const FAMILY_PAGE_PATH = "/family/open";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function buildFamilyInvitationLink(
  origin: string,
  organizationId: string,
  inviteToken: string,
): string {
  const fragment = new URLSearchParams({ t: inviteToken, o: organizationId });
  return `${origin}${FAMILY_PAGE_PATH}#${fragment.toString()}`;
}

export interface FamilyInvitation {
  readonly organizationId: string;
  readonly token: string;
}
export interface FamilyFragment {
  /** Null when the link is absent or malformed (the page then shows the one neutral state). */
  readonly invitation: FamilyInvitation | null;
}

export function parseFamilyFragment(hash: string): FamilyFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const organizationId = params.get("o");
  const token = params.get("t");
  const valid = organizationId && token && UUID.test(organizationId) && TOKEN.test(token);
  return { invitation: valid ? { organizationId, token } : null };
}
