// A local dev seed must never run against production: `db:seed:all` is expanded without a shell by
// scripts/db/seed-all.ts and run by deploy/production/reseed-demo.sh. `seed-superadmin.ts` is deliberately NOT in
// that chain and, because it creates an account with the whole catalog, refuses a non-local environment itself
// through this guard (`seed-org-admin.ts` creates an org_admin and a platform_ops account and has no such guard).
import { describe, expect, it } from "vitest";
import { assertLocalDevSeed } from "../db/lib/local-seed-guard";

const LOCAL = "postgres://seeduser@localhost:5432/chartwarden";
const LOCAL_AUTH = "http://localhost:3000";

/** The seed-runner acknowledgement and the backend URL are REQUIRED inputs, so a caller cannot drop a check by omitting one. */
const input = (parts: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  productionSeedAck?: string | undefined;
  authUrl?: string;
}) => ({ productionSeedAck: undefined, authUrl: LOCAL_AUTH, ...parts });

describe("assertLocalDevSeed", () => {
  it("accepts a local database outside production", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "postgres"]) {
      expect(() =>
        assertLocalDevSeed(
          input({ nodeEnv: "development", databaseUrl: `postgres://seeduser@${host}:5432/d` }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertLocalDevSeed(input({ nodeEnv: undefined, databaseUrl: LOCAL })),
    ).not.toThrow();
  });

  it("accepts only a known-local NODE_ENV, so any other spelling of production is refused too", () => {
    for (const nodeEnv of ["production", "Production", "prod", "staging", "", "live"]) {
      expect(() => assertLocalDevSeed(input({ nodeEnv, databaseUrl: LOCAL }))).toThrow(
        /local dev seed/,
      );
    }
    expect(() => assertLocalDevSeed(input({ nodeEnv: "test", databaseUrl: LOCAL }))).not.toThrow();
  });

  it("refuses production's seed-runner even when NODE_ENV is unset and the host is `postgres`", () => {
    // compose.yml sets this acknowledgement only on the seed-runner, and the runner reaches the host `postgres`.
    expect(() =>
      assertLocalDevSeed({
        nodeEnv: undefined,
        databaseUrl: "postgres://seeduser@postgres:5432/chartwarden",
        productionSeedAck: "yes-reseed-demo",
        authUrl: LOCAL_AUTH,
      }),
    ).toThrow(/seed-runner/);
    expect(() =>
      assertLocalDevSeed({
        nodeEnv: undefined,
        databaseUrl: LOCAL,
        productionSeedAck: undefined,
        authUrl: LOCAL_AUTH,
      }),
    ).not.toThrow();
  });

  it("refuses a remote backend even with a local database: the generated password is POSTed there", () => {
    const remote = () =>
      assertLocalDevSeed(
        input({
          nodeEnv: "development",
          databaseUrl: LOCAL,
          authUrl: "https://api.example.test/",
        }),
      );
    expect(remote).toThrow(/api\.example\.test is not local/);
    // `postgres` is a database host name, never a backend's.
    expect(() =>
      assertLocalDevSeed(
        input({ nodeEnv: "development", databaseUrl: LOCAL, authUrl: "http://postgres:3000" }),
      ),
    ).toThrow(/postgres is not local/);
    for (const authUrl of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() =>
        assertLocalDevSeed(input({ nodeEnv: "development", databaseUrl: LOCAL, authUrl })),
      ).not.toThrow();
    }
    expect(() =>
      assertLocalDevSeed(input({ nodeEnv: "development", databaseUrl: LOCAL, authUrl: "nope" })),
    ).toThrow(/BETTER_AUTH_URL/);
  });

  it("refuses a database that is not local, naming only its host", () => {
    const refuse = () =>
      assertLocalDevSeed(
        input({ nodeEnv: "development", databaseUrl: "postgres://seeduser@db.example.test/d" }),
      );
    expect(refuse).toThrow(/db\.example\.test is not local/);
    expect(refuse).not.toThrow(/seeduser/);
  });

  it("refuses a missing or malformed database url", () => {
    expect(() =>
      assertLocalDevSeed(input({ nodeEnv: "development", databaseUrl: undefined })),
    ).toThrow(/DATABASE_ADMIN_URL/);
    expect(() =>
      assertLocalDevSeed(input({ nodeEnv: "development", databaseUrl: "not a url" })),
    ).toThrow(/DATABASE_ADMIN_URL/);
  });
});
