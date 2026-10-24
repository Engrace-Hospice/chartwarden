// M36 WP 6.7 (ADR-0099 D3) - the family contact's link. The organisation id, the one-time token and the agency's 24-hour number ride the URL FRAGMENT
// (`/family/open#t=<token>&o=<org>&n=<phone>`): a fragment is never sent to a server, so none of them reaches an access log, a proxy or a Referer header.
// The page scrubs it from the address bar on load. `n` lets the neutral dead-link page show a number without an unauthenticated lookup (an existence oracle).
export const FAMILY_PAGE_PATH = "/family/open";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PHONE = /^[0-9+()\-. xX]{3,40}$/;

export function buildFamilyInvitationLink(
  origin: string,
  organizationId: string,
  inviteToken: string,
  agencyPhone: string,
): string {
  const fragment = new URLSearchParams({ t: inviteToken, o: organizationId, n: agencyPhone });
  return `${origin}${FAMILY_PAGE_PATH}#${fragment.toString()}`;
}

export interface FamilyInvitation {
  readonly organizationId: string;
  readonly token: string;
}
export interface FamilyFragment {
  /** Null when the link is absent or malformed (the page then shows the one neutral state). */
  readonly invitation: FamilyInvitation | null;
  /** The agency number for the dead-link page, or null when it is absent or not phone-shaped. */
  readonly phone: string | null;
}

export function parseFamilyFragment(hash: string): FamilyFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const organizationId = params.get("o");
  const token = params.get("t");
  const rawPhone = params.get("n");
  const phone = rawPhone && PHONE.test(rawPhone) ? rawPhone : null;
  const valid = organizationId && token && UUID.test(organizationId) && TOKEN.test(token);
  return { invitation: valid ? { organizationId, token } : null, phone };
}
