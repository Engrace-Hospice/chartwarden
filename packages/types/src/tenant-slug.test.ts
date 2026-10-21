import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  ])("rejects %s (%s)", (slug, reason) => {
    expect(validateTenantSlug(slug)).toEqual({ ok: false, reason });
  });

  it("reserves every host ADR-0049 D2 names", () => {
    for (const host of ["www", "admin", "api", "portal", "storage", "app", "status", "docs", "mail"]) {
      expect(RESERVED_TENANT_SLUGS).toContain(host);
    }
  });

  it("keeps the migration CHECK in step with the constant", () => {
    const sql = readFileSync(
      resolve(__dirname, "../../db/migrations/1144_m1_organization_slug_alias.sql"),
      "utf8",
    );
    for (const reserved of RESERVED_TENANT_SLUGS) expect(sql).toContain(`'${reserved}'`);
    // Postgres regexes have no `(?:` group, so the CHECK carries the same pattern with a plain group.
    expect(sql).toContain(TENANT_SLUG_PATTERN.source.replace("(?:", "("));
  });
});
