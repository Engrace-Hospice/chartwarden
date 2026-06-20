// packages/auth/__tests__/password-hash.test.ts — AUTH-T04 (ADR-0033).
// Infra-free: Argon2id hashing is pure crypto (hash-wasm). The Better Auth wiring (minPasswordLength,
// haveIBeenPwned plugin, password.hash/verify) is verified end-to-end in the AUTH-T06 live-PG lane.
import { describe, expect, it } from "vitest";
import { argon2idHash, argon2idVerify } from "../src/identity/password-hash";

describe("argon2id password hashing (AUTH-T04)", () => {
  it("hashes to an argon2id-encoded string and verifies the correct password", async () => {
    const hash = await argon2idHash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await argon2idVerify(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await argon2idHash("s3cret-passphrase-123456");
    expect(await argon2idVerify(hash, "wrong-password")).toBe(false);
  });

  it("uses a unique salt per hash (same password → different encoded hash)", async () => {
    const a = await argon2idHash("same-password-aaaaaa");
    const b = await argon2idHash("same-password-aaaaaa");
    expect(a).not.toBe(b);
    expect(await argon2idVerify(a, "same-password-aaaaaa")).toBe(true);
    expect(await argon2idVerify(b, "same-password-aaaaaa")).toBe(true);
  });
});
