import { describe, expect, it } from "vitest";
import { hmacRecipient, ringRecipientHasher } from "./recipient-hash";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

describe("recipient hash", () => {
  it("is a 64-char hex HMAC that depends on the tenant key", () => {
    const a = hmacRecipient(KEY_A, "d@funeral.example");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(hmacRecipient(KEY_A, "d@funeral.example"));
    expect(a).not.toBe(hmacRecipient(KEY_B, "d@funeral.example"));
    expect(a).not.toBe(hmacRecipient(KEY_A, "e@funeral.example"));
  });

  it("derives the key from the active ring version and fails closed when the ring is unavailable", async () => {
    const seen: string[] = [];
    const ok = ringRecipientHasher({
      activeVersion: async () => "v7",
      tagKey: async (_o, v) => (seen.push(v), KEY_A),
    });
    expect(await ok("org", "d@funeral.example")).toBe(hmacRecipient(KEY_A, "d@funeral.example"));
    expect(seen).toEqual(["v7"]);
    const down = ringRecipientHasher({
      activeVersion: async () => {
        throw new Error("ring destroyed");
      },
      tagKey: async () => KEY_A,
    });
    await expect(down("org", "d@funeral.example")).rejects.toThrow();
  });
});
