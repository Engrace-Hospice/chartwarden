// A fingerprint covers a body that holds a write-once secret: a digest, never the body, stable for one body and different for any other,
// and still there on an origin with no crypto.subtle (plain http), where a write must not be lost to a missing API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyFingerprint, sha256HexOfText } from "../body-fingerprint";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sha256HexOfText and bodyFingerprint with crypto.subtle", () => {
  it("hashes the empty string to the well-known SHA-256 value", async () => {
    expect(await sha256HexOfText("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is a SHA-256 hex digest that does not contain the secret it covers", async () => {
    const secret = "write-only-credential-for-test";
    const fingerprint = await bodyFingerprint({ vendor: "stedi", secret });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain(secret);
  });
});

describe("without crypto.subtle (a non-secure origin)", () => {
  it("sha256HexOfText rejects instead of returning a made-up digest", async () => {
    vi.stubGlobal("crypto", {});
    await expect(sha256HexOfText("x")).rejects.toThrow(/crypto\.subtle/);
  });

  it("bodyFingerprint falls back to a digest that holds nothing of the body, is stable, and changes with the body", async () => {
    vi.stubGlobal("crypto", {});
    const secret = "write-only-credential-for-test";
    const first = await bodyFingerprint({ secret });
    expect(first).toMatch(/^weak:[0-9a-f]+:\d+$/);
    expect(first).not.toContain(secret);
    expect(await bodyFingerprint({ secret })).toBe(first);
    expect(await bodyFingerprint({ secret: `${secret}!` })).not.toBe(first);
    expect(await bodyFingerprint({ a: 1, secret })).not.toBe(first);
  });
});
