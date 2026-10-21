import { describe, expect, it } from "vitest";
// @chartwarden/portal — the Better Auth calls the sign-in screen makes, and the pure helpers around the redemption /
// signed-in screens. The fetch is injected, so every outcome (including throttling and the second-factor redirect) is
// proven without a network.
import { requestMagicLink, signInWithPassword, signOut, verifyTotp } from "../src/auth-http";
import { tokenFromHash } from "../src/screens/funeral-redeem";
import { blockedMessage } from "../src/screens/signed-in";

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("portal auth-http", () => {
  it("requests a magic link that returns to /portal/signed-in and answers 'sent' on any 2xx (no enumeration)", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const outcome = await requestMagicLink("a@b.test", "https://portal.test", async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return reply(200, { status: true });
    });
    expect(outcome).toBe("sent");
    expect(calls[0]?.url).toBe("/api/auth/sign-in/magic-link");
    expect(calls[0]?.body.callbackURL).toBe("https://portal.test/portal/signed-in");
    expect(calls[0]?.body.errorCallbackURL).toBe("https://portal.test/portal/?link=invalid");
  });

  it("maps 429 to rate_limited and any other failure to failed", async () => {
    expect(await requestMagicLink("a@b.test", "o", async () => reply(429))).toBe("rate_limited");
    expect(await requestMagicLink("a@b.test", "o", async () => reply(500))).toBe("failed");
    expect(await signInWithPassword("a@b.test", "pw", async () => reply(401))).toBe("failed");
    expect(await signInWithPassword("a@b.test", "pw", async () => reply(429))).toBe("rate_limited");
  });

  it("signals the second factor and completes it", async () => {
    expect(
      await signInWithPassword("a@b.test", "pw", async () =>
        reply(200, { twoFactorRedirect: true }),
      ),
    ).toBe("two_factor");
    expect(await signInWithPassword("a@b.test", "pw", async () => reply(200, { user: {} }))).toBe(
      "ok",
    );
    expect(await verifyTotp("123456", async () => reply(200))).toBe("ok");
    expect(await verifyTotp("000000", async () => reply(401))).toBe("failed");
  });

  it("signOut never throws", async () => {
    await expect(
      signOut(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("portal secure-link redemption helpers", () => {
  it("reads the token from the URL fragment only", () => {
    expect(tokenFromHash("#token=abc.def")).toBe("abc.def");
    expect(tokenFromHash("token=abc")).toBe("abc");
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#other=1")).toBeNull();
    expect(tokenFromHash("#token=")).toBeNull();
  });
});

describe("signed-in refusal copy", () => {
  it("never shows a raw code and always offers a next step", () => {
    for (const code of [
      "SIGN_IN_ACCOUNT_NOT_ACTIVATED",
      "SIGN_IN_ACCOUNT_NOT_ACTIVE",
      "SIGN_IN_EMAIL_UNVERIFIED",
      "SIGN_IN_NO_ACTIVE_GRANT",
      "SIGN_IN_ORGANIZATION_NOT_ACTIVE",
      "SIGN_IN_USER_INACTIVE",
      null,
    ]) {
      const message = blockedMessage(code);
      expect(message).not.toMatch(/SIGN_IN_/);
      expect(message.length).toBeGreaterThan(20);
    }
  });
});
