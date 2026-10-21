// packages/auth/__tests__/identity-auth-config.test.ts — AUTH-T05 (+T04) config shape.
// betterAuth() builds synchronously (no DB query at construction), so we can assert the wiring with a
// stub db: the M2 plugins are present, the organization plugin is deliberately absent, and the T04
// password policy holds. Plugin RUNTIME (TOTP/passkey/magic-link flows) is verified in the AUTH-T06
// live-PG lane.
import { describe, expect, it } from "vitest";
import {
  createIdentityAuth,
  resolveMobileAuthOrigins,
  resolvePasskeyOrigins,
  resolveSignUpRequiresInvite,
  resolveTrustedOrigins,
  resolveWebTrustedOrigins,
} from "../src/identity/auth";

// No DB query happens at construction; a stub satisfies the adapter for a shape assertion.
const auth = createIdentityAuth({} as never);
const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);

describe("createIdentityAuth — plugin wiring (AUTH-T05)", () => {
  it("wires 2FA, passkey, magic-link, and the HIBP breach check", () => {
    expect(pluginIds).toEqual(
      expect.arrayContaining(["expo", "two-factor", "passkey", "magic-link", "have-i-been-pwned"]),
    );
  });

  it("uses the official Expo plugin on the same instance without its implicit exp:// trust", () => {
    expect(pluginIds.filter((id) => id === "expo")).toHaveLength(1);
    expect(
      (auth.options.plugins ?? []).find((plugin) => plugin.id === "expo")?.init,
    ).toBeUndefined();
  });

  it("does NOT use Better Auth's organization plugin (ChartWarden owns its org/membership model)", () => {
    expect(pluginIds).not.toContain("organization");
  });

  it("keeps the AUTH-T04 password policy (length floor + Argon2id)", () => {
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12);
    expect(typeof auth.options.emailAndPassword?.password?.hash).toBe("function");
  });

  it("GAP-002: a fixed 72-h outer lifetime, never refreshed on use (SESSION_POLICY decides the rest)", () => {
    expect(auth.options.session?.expiresIn).toBe(72 * 60 * 60);
    expect(auth.options.session?.disableSessionRefresh).toBe(true);
  });
});

describe("native origins stay separate from browser/WebAuthn origins", () => {
  const env = {
    NODE_ENV: "production",
    BETTER_AUTH_URL: "https://api.chartwarden.health",
    TRUSTED_ORIGINS: "https://app.chartwarden.health,https://portal.chartwarden.health",
    MOBILE_AUTH_TRUSTED_ORIGINS: "chartwarden://,chartwarden-staging://,chartwarden://",
  };

  it("adds exact native schemes to Better Auth only", () => {
    expect(resolveWebTrustedOrigins(env)).toEqual([
      "https://app.chartwarden.health",
      "https://portal.chartwarden.health",
    ]);
    expect(resolveMobileAuthOrigins(env)).toEqual(["chartwarden://", "chartwarden-staging://"]);
    expect(resolveTrustedOrigins(env)).toEqual([
      "https://app.chartwarden.health",
      "https://portal.chartwarden.health",
      "chartwarden://",
      "chartwarden-staging://",
    ]);
  });

  it("never uses a native scheme as a WebAuthn expectedOrigin", () => {
    expect(resolvePasskeyOrigins(env)).toEqual([
      "https://app.chartwarden.health",
      "https://portal.chartwarden.health",
      "https://api.chartwarden.health",
    ]);
  });

  it.each([
    "*",
    "null",
    "https://mobile.chartwarden.health",
    "chartwarden://callback",
    "chartwarden://*",
    "exp://",
  ])("rejects non-exact or non-custom mobile origin %s", (origin) => {
    expect(() => resolveMobileAuthOrigins({ MOBILE_AUTH_TRUSTED_ORIGINS: origin })).toThrow(
      /exact custom schemes/,
    );
  });
});

describe("GAP-009 — closed registration (invite-token sign-up)", () => {
  it("resolves strict in production, open elsewhere, and the env flag wins both ways", () => {
    expect(resolveSignUpRequiresInvite({ NODE_ENV: "production" })).toBe(true);
    expect(resolveSignUpRequiresInvite({ NODE_ENV: "development" })).toBe(false);
    expect(resolveSignUpRequiresInvite({ NODE_ENV: "test" })).toBe(false);
    expect(resolveSignUpRequiresInvite({})).toBe(false);
    expect(
      resolveSignUpRequiresInvite({
        NODE_ENV: "development",
        CHARTWARDEN_SIGNUP_REQUIRES_INVITE: "true",
      }),
    ).toBe(true);
    expect(
      resolveSignUpRequiresInvite({
        NODE_ENV: "production",
        CHARTWARDEN_SIGNUP_REQUIRES_INVITE: "false",
      }),
    ).toBe(false);
  });

  it("installs the before-hook always, and closes magic-link account creation only when strict", () => {
    const strict = createIdentityAuth({} as never, { requireInviteForSignUp: true });
    const open = createIdentityAuth({} as never, { requireInviteForSignUp: false });
    const magic = (a: typeof strict) =>
      (a.options.plugins ?? []).find((p) => p.id === "magic-link") as unknown as {
        options?: { disableSignUp?: boolean };
      };
    expect(strict.options.hooks?.before).toBeTypeOf("function");
    expect(magic(strict).options?.disableSignUp).toBe(true);
    expect(magic(open).options?.disableSignUp).toBe(false);
  });
});

describe("ADR-0049 D6 — tenant origins are matched by rule", () => {
  const trusting = (trusted: string) =>
    createIdentityAuth({} as never, {
      tenantOrigins: { isTrusted: async (origin) => origin === trusted },
    });
  const trustedFor = (a: ReturnType<typeof createIdentityAuth>, origin: string | null, host?: string) => {
    const fn = a.options.trustedOrigins as (request?: Request) => Promise<string[]>;
    const request = origin
      ? new Request(`https://${host ?? new URL(origin).host}/x`, { headers: { origin } })
      : undefined;
    return fn(request);
  };

  it("keeps the static allowlist in single-host mode", () => {
    expect(Array.isArray(auth.options.trustedOrigins)).toBe(true);
  });

  it("adds the request origin only when the matcher trusts it", async () => {
    const tenant = trusting("https://sunrise.chartwarden.com");
    expect(await trustedFor(tenant, "https://sunrise.chartwarden.com")).toContain("https://sunrise.chartwarden.com");
    expect(await trustedFor(tenant, "https://evil.example")).not.toContain("https://evil.example");
    expect(await trustedFor(tenant, null)).toEqual(resolveTrustedOrigins());
  });

  it("does not trust a tenant origin on another tenant's host", async () => {
    const tenant = trusting("https://sunrise.chartwarden.com");
    expect(await trustedFor(tenant, "https://sunrise.chartwarden.com", "eagle.chartwarden.com")).toEqual(
      resolveTrustedOrigins(),
    );
  });
});
