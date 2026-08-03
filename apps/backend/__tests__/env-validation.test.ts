/**
 * audit #M2 — production env validation (apps/backend/src/bootstrap/env.ts).
 *
 * NODE_ENV=production must fail closed when a required secret is missing or weak; dev/test keep their
 * safe fallbacks (the check is a no-op). Pure rules, exercised against injected env maps.
 */
import { describe, expect, it } from "vitest";
import { type EnvLike, assertProductionEnv, collectEnvProblems } from "../src/bootstrap/env";

const GOOD: EnvLike = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://app.wardenx.example",
  TRUSTED_ORIGINS: "https://app.wardenx.example",
  // 32 bytes base64-encoded
  TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  // M24 §8.7 — the master KEK for state trading-partner secrets (also 32 bytes base64).
  M24_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  // TASK-008 — the §7.4 witness-attestation HMAC secret (raw string, not base64).
  M13_WITNESS_SIGNING_KEY: "y".repeat(32),
  // TASK-010 — the remaining Phase 2 (SEC-005/OPS-010) required vars.
  REDIS_URL: "rediss://user:pass@host:6379",
  DATABASE_PLATFORM_URL: "postgres://u:p@platform-host:5432/db",
  PASSKEY_RP_ID: "app.wardenx.example",
  WEBAUTHN_RP_ID: "app.wardenx.example",
  MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  CURSOR_SIGNING_KEY: "z".repeat(32),
  TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
  // TASK-013 — the internal-seam machine-credential shared secret (authenticate.ts).
  INTERNAL_SERVICE_TOKEN: "w".repeat(32),
};

describe("collectEnvProblems", () => {
  it("is a no-op outside production (dev/test keep fallbacks)", () => {
    expect(collectEnvProblems({ NODE_ENV: "development" })).toEqual([]);
    expect(collectEnvProblems({})).toEqual([]);
  });

  it("passes a fully-configured production env", () => {
    expect(collectEnvProblems(GOOD)).toEqual([]);
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
    expect(problems).toEqual([{ key: "CURSOR_SIGNING_KEY", problem: "must be at least 32 characters" }]);
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
