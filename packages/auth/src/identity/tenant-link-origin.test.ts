import { describe, expect, it } from "vitest";
import { createTenantOriginMatcher, rewriteLinkToRequestOrigin } from "./tenant-origin";

const matcher = createTenantOriginMatcher({
  baseDomain: "chartwarden.com",
  resolver: { resolve: async (label) => (label === "acme" ? { status: "active" } : null) },
});
const LINK = "https://auth.chartwarden.com/reset-password/tok123?callbackURL=%2Freset";
const member = async (_e: string, host: string) => host === "acme.chartwarden.com";
const req = (headers: Record<string, string>) => new Request("https://acme.chartwarden.com/api/auth/x", { headers });

describe("rewriteLinkToRequestOrigin", () => {
  it("moves the link onto the trusted tenant host the request came from", async () => {
    const out = await rewriteLinkToRequestOrigin(LINK, req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" }), matcher, "a@b.test", member);
    expect(out).toBe("https://acme.chartwarden.com/reset-password/tok123?callbackURL=%2Freset");
  });

  it("leaves the link alone when Origin and Host disagree", async () => {
    const r = req({ origin: "https://acme.chartwarden.com", host: "other.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, r, matcher, "a@b.test", member)).toBe(LINK);
  });

  it("leaves the link alone for an unknown tenant, look-alike, missing Origin or no matcher", async () => {
    const unknown = req({ origin: "https://nope.chartwarden.com", host: "nope.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, unknown, matcher, "a@b.test", member)).toBe(LINK);
    const evil = req({ origin: "https://acme.chartwarden.com.evil.test", host: "acme.chartwarden.com.evil.test" });
    expect(await rewriteLinkToRequestOrigin(LINK, evil, matcher, "a@b.test", member)).toBe(LINK);
    expect(await rewriteLinkToRequestOrigin(LINK, req({ host: "acme.chartwarden.com" }), matcher, "a@b.test", member)).toBe(LINK);
    const ok = req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, ok, undefined, "a@b.test", member)).toBe(LINK);
    expect(await rewriteLinkToRequestOrigin(LINK, undefined, matcher, "a@b.test", member)).toBe(LINK);
  });

  it("leaves the link alone when the recipient is not a member of that tenant, or no membership check is wired", async () => {
    const ok = req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, ok, matcher, "a@b.test", async () => false)).toBe(LINK);
    expect(await rewriteLinkToRequestOrigin(LINK, ok, matcher, "a@b.test", undefined)).toBe(LINK);
  });
});
