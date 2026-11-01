// CW-RUST-M02 P1 — assertion signer and bridge configuration.
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RustBridgeConfigError, parseRustBridgeConfig, rustBridgeActive } from "../config";
import { ASSERTION_LIFETIME_SECS, createAssertionSigner } from "../signer";

// Deterministic test key: PKCS#8 DER prefix for Ed25519 + a fixed 32-byte seed. Not a real credential.
const PKCS8_PREFIX = "302e020100300506032b657004220420";
const pkcs8 = (seedByte: number) =>
  Buffer.concat([Buffer.from(PKCS8_PREFIX, "hex"), Buffer.alloc(32, seedByte)]);
const key = createPrivateKey({ key: pkcs8(7), format: "der", type: "pkcs8" });
const SUBJECT = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  sessionId: "s-1",
  sessionClass: "staff",
  requestId: "r-1",
  method: "GET",
  path: "/api/v1/me/permissions",
};

/**
 * Cross-language golden vector. The Rust verifier (chartwarden-rust cw-actor test
 * `accepts_the_bun_signer_golden_vector`) accepts exactly this token with public key
 * 6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw at now = 1_800_000_000. Ed25519 is deterministic, so any change to
 * the header, claim names, claim order or encoding changes the token and fails here first.
 */
const GOLDEN =
  "eyJhbGciOiJFZERTQSIsImtpZCI6InZlYyIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjdy1idW4iLCJhdWQiOiJjdy1ydXN0Iiwic3ViIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwib3JnIjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwic2lkIjoicy0xIiwiY2xzIjoic3RhZmYiLCJtdGgiOiJHRVQiLCJwdGgiOiIvYXBpL3YxL21lL3Blcm1pc3Npb25zIiwicmlkIjoici0xIiwianRpIjoicTZ1cnE2dXJxNnVycTZ1cnE2dXJxdyIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDMwfQ.UIotSSkL2hLtGC00l7a8SyX9l3xePbSdZ2nm5j5nF_B29xKUouQ4rwYoE1tdGm59LFVICUvTEkC-ujPx-Sc9Aw";

describe("createAssertionSigner", () => {
  it("reproduces the cross-language golden vector byte for byte", () => {
    const signer = createAssertionSigner(
      { kid: "vec", key },
      { nowSecs: () => 1_800_000_000, random: (n) => Buffer.alloc(n, 0xab) },
    );
    expect(signer.sign(SUBJECT)).toBe(GOLDEN);
    expect((createPublicKey(key).export({ format: "jwk" }) as { x: string }).x).toBe(
      "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw",
    );
  });

  it("signs exactly the claim set Rust accepts, with a ≤30 s lifetime and a fresh 16-byte jti", () => {
    const signer = createAssertionSigner({ kid: "k1", key });
    const a = signer.sign(SUBJECT);
    const b = signer.sign(SUBJECT);
    const [h, p, s] = a.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "EdDSA",
      kid: "k1",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(Object.keys(claims).sort()).toEqual(
      ["aud", "cls", "exp", "iat", "iss", "jti", "mth", "org", "pth", "rid", "sid", "sub"].sort(),
    );
    expect(claims).toMatchObject({
      iss: "cw-bun",
      aud: "cw-rust",
      sub: SUBJECT.userId,
      org: SUBJECT.organizationId,
    });
    expect(claims.exp - claims.iat).toBe(ASSERTION_LIFETIME_SECS);
    expect(Buffer.from(claims.jti, "base64url")).toHaveLength(16);
    expect(JSON.parse(Buffer.from(b.split(".")[1] as string, "base64url").toString()).jti).not.toBe(
      claims.jti,
    );
    expect(
      verify(null, Buffer.from(`${h}.${p}`), createPublicKey(key), Buffer.from(s, "base64url")),
    ).toBe(true);
  });

  it("refuses non-canonical identities and incomplete subjects (a machine principal is never forwarded)", () => {
    const signer = createAssertionSigner({ kid: "k1", key });
    expect(() => signer.sign({ ...SUBJECT, userId: "system" })).toThrow();
    expect(() =>
      signer.sign({ ...SUBJECT, organizationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
    ).toThrow();
    expect(() =>
      signer.sign({ ...SUBJECT, organizationId: "{22222222-2222-4222-8222-222222222222}" }),
    ).toThrow();
    expect(() => signer.sign({ ...SUBJECT, sessionId: "" })).toThrow();
    expect(() => signer.sign({ ...SUBJECT, requestId: "" })).toThrow();
  });
});

describe("parseRustBridgeConfig", () => {
  const goodKey = `k1=${pkcs8(9).toString("base64url")}`;

  it("is entirely off by default (merging P1 changes nothing)", () => {
    const c = parseRustBridgeConfig({});
    expect(c.routes.size).toBe(0);
    expect(c.sweepEnabled).toBe(false);
    expect(c.signingKey).toBeNull();
    expect(rustBridgeActive(c)).toBe(false);
    expect(c).toMatchObject({
      mode: "shadow",
      timeoutMs: 300,
      socketPath: "/run/cw-rust/cw-rust.sock",
      sweepAtUtc: "10:17",
    });
  });

  it("parses an enabled route with a valid key", () => {
    const c = parseRustBridgeConfig({
      RUST_ROUTES: "me-permissions",
      RUST_ROUTE_MODE: "serve",
      CW_ACTOR_SIGNING_KEY: goodKey,
    });
    expect([...c.routes]).toEqual(["me-permissions"]);
    expect(c.mode).toBe("serve");
    expect(c.signingKey?.kid).toBe("k1");
  });

  it.each([
    [{ RUST_ROUTES: "me-permissions" }, "CW_ACTOR_SIGNING_KEY is required"],
    [{ RUST_PARITY_SWEEP: "on" }, "CW_ACTOR_SIGNING_KEY is required"],
    [{ RUST_ROUTES: "me-permission" }, "unknown route"],
    [{ RUST_ROUTE_MODE: "on" }, "RUST_ROUTE_MODE"],
    [{ RUST_PARITY_SWEEP: "yes" }, "RUST_PARITY_SWEEP"],
    [{ RUST_TIMEOUT_MS: "5" }, "RUST_TIMEOUT_MS"],
    [{ RUST_TIMEOUT_MS: "abc" }, "RUST_TIMEOUT_MS"],
    [{ RUST_SOCKET: "relative.sock" }, "RUST_SOCKET"],
    [{ RUST_PARITY_SWEEP_UTC: "25:00" }, "RUST_PARITY_SWEEP_UTC"],
    [{ RUST_ROUTES: "me-permissions", CW_ACTOR_SIGNING_KEY: "no-equals-sign" }, "kid="],
    [{ RUST_ROUTES: "me-permissions", CW_ACTOR_SIGNING_KEY: "k1=!!!" }, "not a valid PKCS#8"],
  ])("fails closed on %j", (env, message) => {
    expect(() => parseRustBridgeConfig(env)).toThrow(RustBridgeConfigError);
    expect(() => parseRustBridgeConfig(env)).toThrow(message);
  });

  it("refuses a non-Ed25519 key and never echoes key material in the error", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    const value = `k1=${Buffer.from(rsa).toString("base64url")}`;
    let message = "";
    try {
      parseRustBridgeConfig({ RUST_ROUTES: "me-permissions", CW_ACTOR_SIGNING_KEY: value });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("not an Ed25519 private key");
    expect(message).not.toContain(value.slice(3, 40));
    // A corrupted key is refused, and the error names the variable, not its value.
    let corrupted = "";
    try {
      parseRustBridgeConfig({ RUST_ROUTES: "me-permissions", CW_ACTOR_SIGNING_KEY: `${goodKey}x` });
    } catch (e) {
      corrupted = (e as Error).message;
    }
    expect(corrupted).toContain("CW_ACTOR_SIGNING_KEY");
    expect(corrupted).not.toContain(goodKey.slice(3, 30));
  });
});
