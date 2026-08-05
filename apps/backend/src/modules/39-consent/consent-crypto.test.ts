import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConsentInternalNotesCipher } from "./consent-crypto";

describe("M39 tenant-DEK internal-note encryption", () => {
  it("produces randomized versioned ciphertext without retaining plaintext", async () => {
    const key = randomBytes(32);
    const cipher = createConsentInternalNotesCipher({
      async dekForOrg() {
        return { version: "v7", key };
      },
    });
    const a = await cipher.encrypt("11111111-1111-4111-8111-111111111111", "private note");
    const b = await cipher.encrypt("11111111-1111-4111-8111-111111111111", "private note");
    expect(a).toMatch(/^v1\.v7\./);
    expect(a).not.toContain("private note");
    expect(a).not.toBe(b);
  });

  it("refuses a non-256-bit tenant key", async () => {
    const cipher = createConsentInternalNotesCipher({
      async dekForOrg() {
        return { version: "v1", key: randomBytes(16) };
      },
    });
    await expect(cipher.encrypt("org", "note")).rejects.toThrow("32 bytes");
  });
});
