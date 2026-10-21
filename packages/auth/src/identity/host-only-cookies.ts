// ADR-0049 D4 — per-tenant hosts keep one session per host: the Better Auth cookies are HOST-ONLY.
// `__Host-` prefix (the browser then rejects a Domain attribute and requires Secure + Path=/), so a cookie minted on
// sunrise.<base> is never sent to eagle.<base> and a sibling subdomain cannot toss one over it. Cross-subdomain
// cookies stay off. With TENANT_BASE_DOMAIN unset (demo, dev, test) this adds nothing: dev runs on plain http, where
// a `__Host-`/Secure cookie would never be stored.

/** The subset of Better Auth's `advanced` options this controls. */
export interface HostOnlyCookieOptions {
  useSecureCookies?: boolean;
  cookiePrefix?: string;
  defaultCookieAttributes?: { secure: boolean; path: string; sameSite: "lax" };
  crossSubDomainCookies?: { enabled: false };
}

export function hostOnlyCookieOptions(
  env: Record<string, string | undefined> = process.env,
): HostOnlyCookieOptions {
  if (!env.TENANT_BASE_DOMAIN?.trim()) return {};
  return {
    // Better Auth would prepend `__Secure-`; the prefix is carried in `cookiePrefix` instead so the name is `__Host-…`.
    useSecureCookies: false,
    cookiePrefix: "__Host-better-auth",
    defaultCookieAttributes: { secure: true, path: "/", sameSite: "lax" },
    crossSubDomainCookies: { enabled: false },
  };
}
