import { describe, expect, it } from "vitest";
import {
  bypassesRls,
  connectionRefusal,
  isLocalHost,
  targetMigrationState,
} from "../lib/m25-preflight-guards";

describe("M25 preflight connection guard", () => {
  it("allows loopback hosts and unix sockets without TLS", () => {
    for (const url of [
      "postgresql://u:p@localhost:5432/db",
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@[::1]:5432/db",
      "postgresql://u:p@/db?host=/var/run/postgresql",
    ])
      expect(connectionRefusal(url, {}), url).toBeNull();
  });

  it("refuses a non-local host that does not verify the server (no sslmode, require, verify-ca)", () => {
    for (const mode of ["", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=disable"]) {
      const refusal = connectionRefusal(`postgresql://u:p@db.example.invalid:5432/db${mode}`, {});
      expect(refusal, mode).toMatch(/sslmode=verify-full/);
    }
  });

  it("accepts a non-local host with sslmode=verify-full from the URL or PGSSLMODE", () => {
    expect(
      connectionRefusal("postgresql://u:p@db.example.invalid/db?sslmode=verify-full", {}),
    ).toBeNull();
    expect(
      connectionRefusal("postgresql://u:p@db.example.invalid/db", { PGSSLMODE: "verify-full" }),
    ).toBeNull();
    // the URL wins over the environment
    expect(
      connectionRefusal("postgresql://u:p@db.example.invalid/db?sslmode=require", {
        PGSSLMODE: "verify-full",
      }),
    ).toMatch(/sslmode=verify-full/);
  });

  it("judges the host the driver dials: a ?host= parameter wins over the URL host, and an empty host falls back to PGHOST", () => {
    expect(connectionRefusal("postgresql://u:p@localhost/db?host=remote.example", {})).toMatch(
      /sslmode=verify-full/,
    );
    expect(connectionRefusal("postgresql://u:p@/db", { PGHOST: "remote.example" })).toMatch(
      /sslmode=verify-full/,
    );
    expect(connectionRefusal("postgresql://u:p@/db", {})).toBeNull();
    expect(connectionRefusal("postgresql://u:p@remote.example/db?host=localhost", {})).toBeNull();
  });

  it("never echoes the connection string (it can hold a password)", () => {
    const refusal = connectionRefusal("postgresql://user:hunter2@db.example.invalid/db", {});
    expect(refusal).not.toContain("hunter2");
    expect(connectionRefusal("not a url hunter2", {})).not.toContain("hunter2");
  });

  it("classifies hosts", () => {
    expect(isLocalHost("LOCALHOST")).toBe(true);
    expect(isLocalHost("/tmp")).toBe(true);
    expect(isLocalHost("db.internal")).toBe(false);
    expect(isLocalHost("10.0.0.5")).toBe(false);
  });
});

describe("M25 preflight role and target guards", () => {
  it("only a superuser or BYPASSRLS role can see rows through RLS", () => {
    expect(bypassesRls({ rolsuper: true, rolbypassrls: false })).toBe(true);
    expect(bypassesRls({ rolsuper: false, rolbypassrls: true })).toBe(true);
    expect(bypassesRls({ rolsuper: false, rolbypassrls: false })).toBe(false);
  });

  it("reports a target migration that is neither applied nor on disk as MISSING", () => {
    const target = "1508_x.sql";
    expect(targetMigrationState(target, new Set([target]), [])).toBe("APPLIED");
    expect(targetMigrationState(target, new Set(), [target])).toBe("PENDING");
    expect(targetMigrationState(target, new Set(), ["1509_y.sql"])).toBe("MISSING");
  });
});
