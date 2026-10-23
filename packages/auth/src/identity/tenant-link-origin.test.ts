import { describe, expect, it } from "vitest";
import { createTenantOriginMatcher, rewriteLinkToRequestOrigin } from "./tenant-origin";

const matcher = createTenantOriginMatcher({
  baseDomain: "chartwarden.com",
  resolver: { resolve: async (label) => (label === "acme" ? { status: "active" } : null) },
});
const LINK = "https://auth.chartwarden.com/reset-password/tok123?callbackURL=%2Freset";
const member = async (_e: string, host: string) => host === "acme.chartwarden.com";
const req = (headers: Record<string, string>) =>
  new Request("https://acme.chartwarden.com/api/auth/x", { headers });

describe("rewriteLinkToRequestOrigin", () => {
  it("moves the link onto the trusted tenant host the request came from", async () => {
    const out = await rewriteLinkToRequestOrigin(
      LINK,
      req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" }),
      matcher,
      "a@b.test",
      member,
    );
    expect(out).toBe("https://acme.chartwarden.com/reset-password/tok123?callbackURL=%2Freset");
  });

  it("leaves the link alone when Origin and Host disagree", async () => {
    const r = req({ origin: "https://acme.chartwarden.com", host: "other.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, r, matcher, "a@b.test", member)).toBe(LINK);
  });

  it("leaves the link alone for an unknown tenant, look-alike, missing Origin or no matcher", async () => {
    const unknown = req({ origin: "https://nope.chartwarden.com", host: "nope.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, unknown, matcher, "a@b.test", member)).toBe(LINK);
    const evil = req({
      origin: "https://acme.chartwarden.com.evil.test",
      host: "acme.chartwarden.com.evil.test",
    });
    expect(await rewriteLinkToRequestOrigin(LINK, evil, matcher, "a@b.test", member)).toBe(LINK);
    expect(
      await rewriteLinkToRequestOrigin(
        LINK,
        req({ host: "acme.chartwarden.com" }),
        matcher,
        "a@b.test",
        member,
      ),
    ).toBe(LINK);
    const ok = req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, ok, undefined, "a@b.test", member)).toBe(LINK);
    expect(await rewriteLinkToRequestOrigin(LINK, undefined, matcher, "a@b.test", member)).toBe(
      LINK,
    );
  });

  it("leaves the link alone when the recipient is not a member of that tenant, or no membership check is wired", async () => {
    const ok = req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" });
    expect(await rewriteLinkToRequestOrigin(LINK, ok, matcher, "a@b.test", async () => false)).toBe(
      LINK,
    );
    expect(await rewriteLinkToRequestOrigin(LINK, ok, matcher, "a@b.test", undefined)).toBe(LINK);
  });

  describe("a link that stays on its own origin", () => {
    const FORGED =
      "https://auth.chartwarden.com/reset-password/tok123?callbackURL=https%3A%2F%2Feagle.chartwarden.com%2Freset-password";
    const forged = req({ origin: "https://acme.chartwarden.com", host: "acme.chartwarden.com" });

    it("does not deliver a non-member's reset token to the tenant named by a forged Origin", async () => {
      const out = await rewriteLinkToRequestOrigin(
        FORGED,
        forged,
        matcher,
        "a@b.test",
        async () => false,
      );
      expect(out).toBe(
        "https://auth.chartwarden.com/reset-password/tok123?callbackURL=https%3A%2F%2Fauth.chartwarden.com%2Freset-password",
      );
    });

    it("pins errorCallbackURL too, keeping the callback's path, query and fragment", async () => {
      const link =
        "https://auth.chartwarden.com/magic-link/verify?token=t&errorCallbackURL=https%3A%2F%2Feagle.chartwarden.com%2Fportal%2F%3Flink%3Dinvalid%23x";
      const out = new URL(
        await rewriteLinkToRequestOrigin(link, forged, matcher, "a@b.test", async () => false),
      );
      expect(out.searchParams.get("errorCallbackURL")).toBe(
        "https://auth.chartwarden.com/portal/?link=invalid#x",
      );
      expect(out.searchParams.get("token")).toBe("t");
    });

    it("leaves a callback already on the link's origin, a relative one, or a link with none, byte for byte", async () => {
      const same =
        "https://auth.chartwarden.com/reset-password/tok123?callbackURL=https%3A%2F%2Fauth.chartwarden.com%2Freset";
      expect(
        await rewriteLinkToRequestOrigin(same, forged, matcher, "a@b.test", async () => false),
      ).toBe(same);
      expect(
        await rewriteLinkToRequestOrigin(LINK, forged, matcher, "a@b.test", async () => false),
      ).toBe(LINK);
      const bare = "https://auth.chartwarden.com/reset-password/tok123";
      expect(
        await rewriteLinkToRequestOrigin(bare, forged, matcher, "a@b.test", async () => false),
      ).toBe(bare);
    });

    it("pins newUserCallbackURL and every copy of a repeated callback, and neutralises a non-web scheme", async () => {
      const link =
        "https://auth.chartwarden.com/magic-link/verify?token=t&newUserCallbackURL=https%3A%2F%2Feagle.chartwarden.com%2Fwelcome" +
        "&callbackURL=%2Fok&callbackURL=https%3A%2F%2Feagle.chartwarden.com%2Fx&errorCallbackURL=javascript%3Aalert(1)";
      const out = new URL(
        await rewriteLinkToRequestOrigin(link, forged, matcher, "a@b.test", async () => false),
      );
      expect(out.searchParams.get("newUserCallbackURL")).toBe(
        "https://auth.chartwarden.com/welcome",
      );
      expect(out.searchParams.getAll("callbackURL")).toEqual([
        "/ok",
        "https://auth.chartwarden.com/x",
      ]);
      expect(out.searchParams.get("errorCallbackURL")).toBe("https://auth.chartwarden.com/");
      expect(out.searchParams.get("token")).toBe("t");
    });

    it("does nothing at all when tenant mode is off (no matcher)", async () => {
      expect(await rewriteLinkToRequestOrigin(FORGED, forged, undefined, "a@b.test", member)).toBe(
        FORGED,
      );
    });

    it("a member's link is rewritten onto their host and its callback stays there", async () => {
      const out = await rewriteLinkToRequestOrigin(
        "https://auth.chartwarden.com/reset-password/tok123?callbackURL=https%3A%2F%2Facme.chartwarden.com%2Freset-password",
        forged,
        matcher,
        "a@b.test",
        member,
      );
      expect(out).toBe(
        "https://acme.chartwarden.com/reset-password/tok123?callbackURL=https%3A%2F%2Facme.chartwarden.com%2Freset-password",
      );
    });
  });
});
