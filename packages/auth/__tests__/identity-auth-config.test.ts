// packages/auth/__tests__/identity-auth-config.test.ts — AUTH-T05 (+T04) config shape.
// betterAuth() builds synchronously (no DB query at construction), so we can assert the wiring with a
// stub db: the M2 plugins are present, the organization plugin is deliberately absent, and the T04
// password policy holds. Plugin RUNTIME (TOTP/passkey/magic-link flows) is verified in the AUTH-T06
// live-PG lane.
import { describe, expect, it } from "vitest";
import { createIdentityAuth } from "../src/identity/auth";

// No DB query happens at construction; a stub satisfies the adapter for a shape assertion.
const auth = createIdentityAuth({} as never);
const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);

describe("createIdentityAuth — plugin wiring (AUTH-T05)", () => {
  it("wires 2FA, passkey, magic-link, and the HIBP breach check", () => {
    expect(pluginIds).toEqual(expect.arrayContaining(["two-factor", "passkey", "magic-link", "have-i-been-pwned"]));
  });

  it("does NOT use Better Auth's organization plugin (WardenX owns its org/membership model)", () => {
    expect(pluginIds).not.toContain("organization");
  });

  it("keeps the AUTH-T04 password policy (length floor + Argon2id)", () => {
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12);
    expect(typeof auth.options.emailAndPassword?.password?.hash).toBe("function");
  });
});
