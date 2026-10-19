import { WardenXError } from "@wardenx/types";
// @wardenx/messaging — message body envelope crypto (M36 §3.4 / FB-T05).
import { describe, expect, it } from "vitest";
import {
  deriveOrgDek,
  loadMessagingKek,
  messageBodySha256,
  openMessageBody,
  sealMessageBody,
} from "../src/crypto";

const KEK_B64 = Buffer.alloc(32, 7).toString("base64");
const ORG_A = "org-a";
const ORG_B = "org-b";

describe("message body crypto (FB-T05)", () => {
  it("loads a 32-byte KEK from base64 and fails closed on absent/short keys", () => {
    expect(loadMessagingKek(KEK_B64).length).toBe(32);
    expect(() => loadMessagingKek(undefined)).toThrow(/required/);
    expect(() => loadMessagingKek(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("throws a typed 503 WardenXError (not a bare Error) when the key is missing or malformed", () => {
    for (const raw of [undefined, Buffer.alloc(16).toString("base64")]) {
      let thrown: unknown;
      try {
        loadMessagingKek(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WardenXError);
      expect(thrown).toMatchObject({ code: "MESSAGING_ENCRYPTION_UNAVAILABLE", statusCode: 503 });
    }
  });

  it("round-trips a body under the same tenant DEK", () => {
    const dek = deriveOrgDek(loadMessagingKek(KEK_B64), ORG_A);
    const sealed = sealMessageBody("the patient is stable", dek);
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(openMessageBody(sealed, dek)).toBe("the patient is stable");
  });

  it("derives a DIFFERENT DEK per org — a cross-tenant DEK cannot decrypt (isolation)", () => {
    const kek = loadMessagingKek(KEK_B64);
    const dekA = deriveOrgDek(kek, ORG_A);
    const dekB = deriveOrgDek(kek, ORG_B);
    expect(dekA.equals(dekB)).toBe(false);
    const sealed = sealMessageBody("org A only", dekA);
    expect(() => openMessageBody(sealed, dekB)).toThrow(); // GCM auth failure
  });

  it("rejects tampered ciphertext (GCM authentication)", () => {
    const dek = deriveOrgDek(loadMessagingKek(KEK_B64), ORG_A);
    const sealed = sealMessageBody("integrity", dek);
    sealed[sealed.length - 1] ^= 0xff; // flip a tag byte
    expect(() => openMessageBody(sealed, dek)).toThrow();
  });

  it("computes a stable 64-char hex sha256 of the plaintext (pre-encryption integrity digest)", () => {
    const digest = messageBodySha256("hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(messageBodySha256("hello")).toBe(digest); // deterministic
    expect(messageBodySha256("hellp")).not.toBe(digest);
  });
});
