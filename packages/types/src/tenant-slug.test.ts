import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_TENANT_SLUGS, TENANT_SLUG_PATTERN, validateTenantSlug } from "./tenant-slug";

describe("validateTenantSlug", () => {
  it.each(["sunrise", "eagle-1", "a1b", "abc", "x".repeat(63)])("accepts %s", (slug) => {
    expect(validateTenantSlug(slug)).toEqual({ ok: true });
  });

  it.each([
    ["ab", "format"],
    ["", "format"],
    ["Sunrise", "format"],
    ["-sunrise", "format"],
    ["sunrise-", "format"],
    ["sun_rise", "format"],
    ["sun.rise", "format"],
    ["sunrise ", "format"],
    ["x".repeat(64), "format"],
    ["xn--bcher-kva", "punycode"],
    ["www", "reserved"],
    ["admin", "reserved"],
    ["portal", "reserved"],
    ["wardenx", "reserved"],
  ])("rejects %s (%s)", (slug, reason) => {
    expect(validateTenantSlug(slug)).toEqual({ ok: false, reason });
  });

  it("reserves every host ADR-0049 D2 names", () => {
    for (const host of [
      "www",
      "admin",
      "api",
      "portal",
      "storage",
      "app",
      "status",
      "docs",
      "mail",
    ]) {
      expect(RESERVED_TENANT_SLUGS).toContain(host);
    }
  });

  it("reserves the legacy host the infra rename leaves behind", () => {
    // deploy/production/nginx/chartwarden-legacy-redirects.conf redirects the exact vhost wardenx.chartwarden.cloud away.
    expect(RESERVED_TENANT_SLUGS).toContain("wardenx");
  });

  const migrationsDir = resolve(__dirname, "../../db/migrations");
  const migrationSql = (file: string) => readFileSync(join(migrationsDir, file), "utf8");

  it("keeps the database slug guards in step with the constant", () => {
    // Every `NEW.slug IN ('a', 'b')` list in a migration is part of the DB rule; together they must be exactly the constant.
    const inDatabase = new Set<string>();
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
      const sql = migrationSql(file);
      for (const list of sql.matchAll(/NEW\.slug IN \(([^)]*)\)/g)) {
        for (const name of (list[1] ?? "").matchAll(/'([^']+)'/g)) inDatabase.add(name[1] ?? "");
      }
    }
    expect([...inDatabase].sort()).toEqual([...RESERVED_TENANT_SLUGS].sort());
  });

  it("keeps the migration label pattern in step with the constant", () => {
    const sql = migrationSql("1144_m1_organization_slug_alias.sql");
    // Postgres regexes have no `(?:` group, so the guard carries the same pattern with a plain group.
    expect(sql).toContain(TENANT_SLUG_PATTERN.source.replace("(?:", "("));
  });
});
