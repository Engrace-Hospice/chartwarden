import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildClearinghouseSecretCipher } from "./secret-cipher";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const KEY = "fake-claimmd-key#with*specials";

describe("clearinghouse secret cipher", () => {
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  const ctx = { vendor: "claimmd", mode: "test" } as const;

  it("round-trips a secret that contains # and *", async () => {
    const sealed = await cipher.encrypt(ORG_A, KEY, ctx);
    expect(sealed.cipher).not.toContain(KEY);
    expect(await cipher.decrypt(ORG_A, ctx, sealed.cipher)).toBe(KEY);
  });

  it("will not open for another tenant, another vendor or the other mode", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG_A, KEY, ctx);
    await expect(cipher.decrypt(ORG_B, ctx, sealed)).rejects.toThrow(/did not open/);
    await expect(cipher.decrypt(ORG_A, { ...ctx, vendor: "stedi" }, sealed)).rejects.toThrow(
      /did not open/,
    );
    await expect(cipher.decrypt(ORG_A, { ...ctx, mode: "production" }, sealed)).rejects.toThrow(
      /did not open/,
    );
  });

  it("will not open under another key, or a tampered or truncated envelope", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG_A, KEY, ctx);
    const other = buildClearinghouseSecretCipher(randomBytes(32));
    await expect(other.decrypt(ORG_A, ctx, sealed)).rejects.toThrow(/did not open/);
    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await expect(cipher.decrypt(ORG_A, ctx, bytes.toString("base64"))).rejects.toThrow(/did not open/);
    await expect(cipher.decrypt(ORG_A, ctx, "AA==")).rejects.toThrow(/did not open/);
  });

  it("seals the same secret differently each time", async () => {
    const a = await cipher.encrypt(ORG_A, KEY, ctx);
    const b = await cipher.encrypt(ORG_A, KEY, ctx);
    expect(a.cipher).not.toBe(b.cipher);
  });

  it("rejects a KEK that is not 32 bytes", () => {
    expect(() => buildClearinghouseSecretCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
