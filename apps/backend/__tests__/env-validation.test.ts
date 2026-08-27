/**
 * audit #M2 — production env validation (apps/backend/src/bootstrap/env.ts).
 *
 * NODE_ENV=production must fail closed when a required secret is missing or weak; dev/test keep their
 * safe fallbacks (the check is a no-op). Pure rules, exercised against injected env maps.
 */
import { describe, expect, it } from "vitest";
import {
  type EnvLike,
  assertProductionEnv,
  collectEnvProblems,
  hostnamesIn,
  isReservedPlaceholderHost,
  reservedPlaceholderProblem,
} from "../src/bootstrap/env";

const GOOD: EnvLike = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://app.wardenx.cloud",
  TRUSTED_ORIGINS: "https://app.wardenx.cloud",
  // 32 bytes base64-encoded
  TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  // M24 §8.7 — the master KEK for state trading-partner secrets (also 32 bytes base64).
  M24_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  // TASK-008 — the §7.4 witness-attestation HMAC secret (raw string, not base64).
  M13_WITNESS_SIGNING_KEY: "y".repeat(32),
  // TASK-010 — the remaining Phase 2 (SEC-005/OPS-010) required vars.
  REDIS_URL: "rediss://user:pass@host:6379",
  M23_X12_GATEWAY_URL: "https://x12.wardenx.cloud",
  M23_X12_GATEWAY_TOKEN: "x".repeat(32),
  M23_MAC_GATEWAY_URL: "https://mac.wardenx.cloud",
  M23_MAC_GATEWAY_TOKEN: "m".repeat(32),
  M34_PROVISION_GATEWAY_URL: "https://provision.wardenx.cloud",
  M34_PROVISION_GATEWAY_TOKEN: "p".repeat(32),
  M34_INVITATION_ACCEPT_URL: "https://app.wardenx.cloud/tenant-invitations",
  DATABASE_PLATFORM_URL: "postgres://u:p@platform-host:5432/db",
  PASSKEY_RP_ID: "app.wardenx.cloud",
  WEBAUTHN_RP_ID: "app.wardenx.cloud",
  MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  CURSOR_SIGNING_KEY: "z".repeat(32),
  TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
  // TASK-013 — the internal-seam machine-credential shared secret (authenticate.ts).
  INTERNAL_SERVICE_TOKEN: "w".repeat(32),
  // #105 — the platform KEK wrapping every tenant DEK: `<kekId>:<base64 32 bytes>` (ADR-0045).
  M34_TENANT_KEK: `kek-1:${Buffer.alloc(32, 5).toString("base64")}`,
};

describe("collectEnvProblems", () => {
  it("is a no-op outside production (dev/test keep fallbacks)", () => {
    expect(collectEnvProblems({ NODE_ENV: "development" })).toEqual([]);
    expect(collectEnvProblems({})).toEqual([]);
  });

  it("passes a fully-configured production env", () => {
    expect(collectEnvProblems(GOOD)).toEqual([]);
  });

  it("flags a malformed platform KEK by shape, not just by absence (#105)", () => {
    const problemFor = (v: string) =>
      collectEnvProblems({ ...GOOD, M34_TENANT_KEK: v }).find((p) => p.key === "M34_TENANT_KEK")
        ?.problem;
    expect(problemFor("just-a-key")).toMatch(/<kekId>:<base64 32-byte key>/);
    expect(problemFor(`kek 1:${Buffer.alloc(32).toString("base64")}`)).toMatch(/kekId must be/);
    expect(problemFor(`kek-1:${Buffer.alloc(16).toString("base64")}`)).toMatch(/32 base64 bytes/);
    expect(problemFor(GOOD.M34_TENANT_KEK as string)).toBeUndefined();
  });

  it("flags every missing required secret", () => {
    const keys = collectEnvProblems({ NODE_ENV: "production" }).map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "TRUSTED_ORIGINS",
        "TWO_FACTOR_ENCRYPTION_KEY",
        "M24_CREDENTIAL_ENCRYPTION_KEY",
        "M13_WITNESS_SIGNING_KEY",
        "REDIS_URL",
        "M23_X12_GATEWAY_URL",
        "M23_X12_GATEWAY_TOKEN",
        "M23_MAC_GATEWAY_URL",
        "M23_MAC_GATEWAY_TOKEN",
        "M34_PROVISION_GATEWAY_URL",
        "M34_PROVISION_GATEWAY_TOKEN",
        "M34_INVITATION_ACCEPT_URL",
        "DATABASE_PLATFORM_URL",
        "PASSKEY_RP_ID",
        "WEBAUTHN_RP_ID",
        "MESSAGING_ENCRYPTION_KEY",
        "CURSOR_SIGNING_KEY",
        "TRUSTED_PROXY_CIDRS",
      ]),
    );
  });

  it("flags a too-short auth secret", () => {
    const problems = collectEnvProblems({ ...GOOD, BETTER_AUTH_SECRET: "short" });
    expect(problems).toEqual([
      { key: "BETTER_AUTH_SECRET", problem: "must be at least 32 characters" },
    ]);
  });

  it("flags a non-https auth URL", () => {
    const problems = collectEnvProblems({ ...GOOD, BETTER_AUTH_URL: "http://insecure.example" });
    expect(problems).toEqual([{ key: "BETTER_AUTH_URL", problem: "must be an https:// origin" }]);
  });

  it("flags a 2FA key that does not decode to 32 bytes", () => {
    const problems = collectEnvProblems({
      ...GOOD,
      TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64"),
    });
    expect(problems).toEqual([
      { key: "TWO_FACTOR_ENCRYPTION_KEY", problem: "must decode to 32 base64 bytes" },
    ]);
  });

  it("flags an M24 credential KEK that does not decode to 32 bytes", () => {
    // A short KEK would still derive a DEK, so the failure has to be caught here rather than at the
    // first trading-partner write — a weak key silently protecting billing secrets is the bad outcome.
    const problems = collectEnvProblems({
      ...GOOD,
      M24_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64"),
    });
    expect(problems).toEqual([
      { key: "M24_CREDENTIAL_ENCRYPTION_KEY", problem: "must decode to 32 base64 bytes" },
    ]);
  });

  it("flags a too-short M13 witness signing key", () => {
    const problems = collectEnvProblems({ ...GOOD, M13_WITNESS_SIGNING_KEY: "short" });
    expect(problems).toEqual([
      { key: "M13_WITNESS_SIGNING_KEY", problem: "must be at least 32 characters" },
    ]);
  });

  it("flags a non-redis REDIS_URL", () => {
    const problems = collectEnvProblems({ ...GOOD, REDIS_URL: "http://host:6379" });
    expect(problems).toEqual([
      { key: "REDIS_URL", problem: "must be a redis:// or rediss:// URL" },
    ]);
  });

  it("flags a messaging encryption key that does not decode to 32 bytes", () => {
    const problems = collectEnvProblems({
      ...GOOD,
      MESSAGING_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64"),
    });
    expect(problems).toEqual([
      { key: "MESSAGING_ENCRYPTION_KEY", problem: "must decode to 32 base64 bytes" },
    ]);
  });

  it("flags a too-short cursor signing key", () => {
    const problems = collectEnvProblems({ ...GOOD, CURSOR_SIGNING_KEY: "short" });
    expect(problems).toEqual([
      { key: "CURSOR_SIGNING_KEY", problem: "must be at least 32 characters" },
    ]);
  });

  it("flags a too-short internal service token", () => {
    const problems = collectEnvProblems({ ...GOOD, INTERNAL_SERVICE_TOKEN: "short" });
    expect(problems).toEqual([
      { key: "INTERNAL_SERVICE_TOKEN", problem: "must be at least 32 characters" },
    ]);
  });
});

describe("assertProductionEnv", () => {
  it("throws listing all problems when production is misconfigured", () => {
    expect(() => assertProductionEnv({ NODE_ENV: "production" })).toThrow(
      /Production environment validation failed/,
    );
  });

  it("does not throw for a valid production env or outside production", () => {
    expect(() => assertProductionEnv(GOOD)).not.toThrow();
    expect(() => assertProductionEnv({ NODE_ENV: "test" })).not.toThrow();
  });
});

// ── #115 — RFC 2606 placeholder hosts ─────────────────────────────────────────────────────────────────
//
// The validator's whole purpose is that a production boot cannot be misconfigured silently. For the four
// gateway URLs it was doing the opposite: their rule asks only for `https://`, and the `.env.example` an
// operator copies supplies exactly that against `*.example.invalid` — a TLD RFC 2606 §2 reserves so that
// it can NEVER resolve. So a copied example file passed production validation intact and the stack booted
// "validated" against hosts DNS is guaranteed not to answer, failing at the first tenant operation.
describe("#115 — reserved placeholder hosts", () => {
  it("recognises every RFC 2606 reserved name, and subdomains of them", () => {
    for (const host of [
      "provision-gateway.example.invalid",
      "gw.invalid",
      "invalid",
      "app.example",
      "example.com",
      "www.example.net",
      "deep.sub.example.org",
      "svc.test",
    ]) {
      expect(isReservedPlaceholderHost(host), host).toBe(true);
    }
  });

  it("leaves real hosts alone — including the loopback a co-located service legitimately uses", () => {
    for (const host of [
      "app.wardenx.cloud",
      "storage.wardenx.chartwarden.cloud",
      "postgres",
      "valkey",
      // Deliberately NOT reserved: a single-host deployment addressing its own Postgres or object
      // store as localhost is ordinary and correct. Rejecting it would break real deployments to
      // catch a mistake the reserved-name rule already catches.
      "localhost",
      "127.0.0.1",
      // A name that merely CONTAINS a reserved string is not one.
      "example.company.com",
      "notexample.com",
      "myinvalid.com",
    ]) {
      expect(isReservedPlaceholderHost(host), host).toBe(false);
    }
  });

  it("extracts hosts from URLs, connection strings, origin lists and bare names", () => {
    expect(hostnamesIn("https://gw.example.invalid/dek/unwrap")).toEqual(["gw.example.invalid"]);
    expect(hostnamesIn("postgresql://u:p%40ss@db-host:5432/wardenx")).toEqual(["db-host"]);
    expect(hostnamesIn("https://a.wardenx.cloud, https://b.wardenx.cloud")).toEqual([
      "a.wardenx.cloud",
      "b.wardenx.cloud",
    ]);
    expect(hostnamesIn("app.wardenx.cloud")).toEqual(["app.wardenx.cloud"]);
  });

  it("does not mistake a secret for a hostname", () => {
    // Every non-URL requirement's value: base64 keys, hex-ish tokens, CIDRs. None may produce a host,
    // or the rule would start rejecting secrets for what they happen to spell.
    for (const secret of [
      Buffer.alloc(32, 7).toString("base64"),
      "x".repeat(32),
      "replace-with-a-32-character-service-token",
      "10.0.0.0/8",
    ]) {
      expect(reservedPlaceholderProblem(secret), secret).toBeNull();
    }
  });

  it("REJECTS the .env.example placeholders the old rules accepted", () => {
    // These four values are verbatim from `.env.example`, and every one of them satisfied its own
    // per-key rule (`/^https:\/\//`). That is the bug.
    const copied: EnvLike = {
      ...GOOD,
      M23_X12_GATEWAY_URL: "https://x12-gateway.example.invalid",
      M23_MAC_GATEWAY_URL: "https://mac-gateway.example.invalid",
      M34_PROVISION_GATEWAY_URL: "https://provision-gateway.example.invalid",
      M34_INVITATION_ACCEPT_URL: "https://app.example.invalid/tenant-invitations",
    };
    const keys = collectEnvProblems(copied).map((p) => p.key);
    expect(keys).toEqual([
      "M23_X12_GATEWAY_URL",
      "M23_MAC_GATEWAY_URL",
      "M34_PROVISION_GATEWAY_URL",
      "M34_INVITATION_ACCEPT_URL",
    ]);
    expect(collectEnvProblems(copied)[0]?.problem).toMatch(/RFC 2606 reserved host/);
  });

  it("catches a placeholder in a non-URL requirement too", () => {
    // PASSKEY_RP_ID is a bare hostname with no URL rule at all, so nothing else would look at it.
    expect(collectEnvProblems({ ...GOOD, PASSKEY_RP_ID: "app.example.com" })).toEqual([
      { key: "PASSKEY_RP_ID", problem: expect.stringMatching(/RFC 2606 reserved host/) },
    ]);
  });

  it("reports the per-key rule first when a value is both wrong and a placeholder", () => {
    // One problem per key: telling an operator their URL is not https AND is a placeholder is noise
    // when fixing the scheme is not the fix.
    const problems = collectEnvProblems({
      ...GOOD,
      M23_X12_GATEWAY_URL: "http://x.example.invalid",
    });
    expect(problems).toEqual([{ key: "M23_X12_GATEWAY_URL", problem: "must be an https:// URL" }]);
  });

  it("stays a no-op outside production", () => {
    expect(
      collectEnvProblems({ ...GOOD, NODE_ENV: "development", PASSKEY_RP_ID: "x.invalid" }),
    ).toEqual([]);
  });
});
