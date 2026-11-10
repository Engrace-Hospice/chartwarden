import { describe, expect, it } from "vitest";
import { bodyFingerprint, sha256Hex } from "./body-digest";

describe("bodyFingerprint", () => {
  it("is a SHA-256 hex digest that does not contain the secret it covers", async () => {
    const secret = "write-only-credential-for-test";
    const fingerprint = await bodyFingerprint({ vendor: "stedi", secret, reason: "kickoff" });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain(secret);
  });

  it("is stable for one body and changes with any byte of it (a corrected secret is a new attempt)", async () => {
    const first = await bodyFingerprint({ secret: "one" });
    expect(await bodyFingerprint({ secret: "one" })).toBe(first);
    expect(await bodyFingerprint({ secret: "two" })).not.toBe(first);
  });

  it("hashes the empty string to the well-known SHA-256 value", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
