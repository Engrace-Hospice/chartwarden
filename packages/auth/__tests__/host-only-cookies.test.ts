// ADR-0049 D4 — in subdomain mode (TENANT_BASE_DOMAIN set) the Better Auth cookies are HOST-ONLY: `__Host-` prefix,
// Secure, Path=/, never a Domain attribute, crossSubDomainCookies off. Unset keeps today's options untouched.
import { getCookies } from "better-auth/cookies";
import { describe, expect, it } from "vitest";
import { hostOnlyCookieOptions } from "../src/identity/host-only-cookies";

const cookiesFor = (
  env: Record<string, string | undefined>,
  baseURL = "https://sunrise.chartwarden.com",
) => getCookies({ baseURL, advanced: hostOnlyCookieOptions(env) } as never);

describe("hostOnlyCookieOptions", () => {
  it("adds nothing in single-host mode (unset or blank), so demo/dev/test cookies are unchanged", () => {
    expect(hostOnlyCookieOptions({})).toEqual({});
    expect(hostOnlyCookieOptions({ TENANT_BASE_DOMAIN: "  " })).toEqual({});
  });

  it("names the session cookie __Host-better-auth.session_token with Secure, Path=/ and no Domain", () => {
    const { sessionToken } = cookiesFor({ TENANT_BASE_DOMAIN: "chartwarden.com" });
    expect(sessionToken.name).toBe("__Host-better-auth.session_token");
    expect(sessionToken.attributes).toMatchObject({
      secure: true,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    expect(sessionToken.attributes).not.toHaveProperty("domain");
  });

  it("keeps every Better Auth cookie host-only, even with an http base URL (no __Secure- fallback)", () => {
    const all = cookiesFor({ TENANT_BASE_DOMAIN: "chartwarden.com" }, "http://localhost:3000");
    for (const c of Object.values(all)) {
      expect(c.name.startsWith("__Host-")).toBe(true);
      expect(c.attributes.secure).toBe(true);
      expect(c.attributes).not.toHaveProperty("domain");
    }
  });

  it("never enables cross-subdomain cookies", () => {
    const advanced = hostOnlyCookieOptions({ TENANT_BASE_DOMAIN: "chartwarden.com" });
    expect(advanced.crossSubDomainCookies?.enabled ?? false).toBe(false);
  });

  it("leaves Better Auth's single-host naming alone when unset", () => {
    expect(cookiesFor({}, "http://localhost:3000").sessionToken.name).toBe(
      "better-auth.session_token",
    );
  });
});
