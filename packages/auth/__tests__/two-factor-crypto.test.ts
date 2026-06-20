// packages/auth/__tests__/two-factor-crypto.test.ts — ADR-0034 §2 pure cipher (AES-256-GCM).
// Infra-free. The adapter decorator + ciphertext-at-rest assertion are verified in the live-PG lane.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isSealed, loadTwoFactorKey, open, seal } from "../src/identity/two-factor-crypto";

const KEY = randomBytes(32);

describe("two-factor-crypto (ADR-0034)", () => {
  it("round-trips a secret", () => {
    const secret = "JBSWY3DPEHPK3PXP"; // a TOTP secret
    expect(open(seal(secret, KEY), KEY)).toBe(secret);
  });

  it("uses a fresh nonce per call (same plaintext → different ciphertext, both decrypt)", () => {
    const a = seal("same", KEY);
    const b = seal("same", KEY);
    expect(a).not.toBe(b);
    expect(open(a, KEY)).toBe("same");
    expect(open(b, KEY)).toBe("same");
  });

  it("fails (GCM auth) on tampered ciphertext", () => {
    const buf = Buffer.from(seal("tamper-me-please", KEY), "base64");
    buf[1 + 12 + 1] ^= 0xff; // flip a ciphertext byte (after version + nonce)
    expect(() => open(buf.toString("base64"), KEY)).toThrow();
  });

  it("fails with the wrong key", () => {
    const sealed = seal("secret-value", KEY);
    expect(() => open(sealed, randomBytes(32))).toThrow();
  });

  it("rejects an unsupported version byte", () => {
    const buf = Buffer.from(seal("v", KEY), "base64");
    buf[0] = 2;
    expect(() => open(buf.toString("base64"), KEY)).toThrow(/version/);
  });

  it("isSealed distinguishes our tokens from arbitrary strings", () => {
    expect(isSealed(seal("x", KEY))).toBe(true);
    expect(isSealed("not-a-token")).toBe(false);
  });

  describe("loadTwoFactorKey — fail-closed", () => {
    it("throws when absent", () => {
      expect(() => loadTwoFactorKey(undefined)).toThrow(/required/);
    });
    it("throws on the wrong length", () => {
      expect(() => loadTwoFactorKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    });
    it("loads a 32-byte base64 key", () => {
      const raw = randomBytes(32).toString("base64");
      expect(loadTwoFactorKey(raw)).toHaveLength(32);
    });
  });
});
