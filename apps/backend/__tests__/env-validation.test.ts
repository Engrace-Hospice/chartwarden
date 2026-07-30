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
