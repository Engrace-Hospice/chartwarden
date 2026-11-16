import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { m23MacJurisdiction } from "../../src/schema/billing/types";

const SQL = readFileSync(
  fileURLToPath(new URL("../1475_m23_mac_jurisdiction_type.sql", import.meta.url)),
  "utf8",
);
const JOURNAL = JSON.parse(
  readFileSync(fileURLToPath(new URL("../meta/_journal.json", import.meta.url)), "utf8"),
) as { entries: Array<{ tag: string }> };

const enumLabels = (block: string): string[] =>
  [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]!);

describe("M23 migration 1475 MAC jurisdiction prerequisite", () => {
  it("creates the deployed enum before migration 1489 without changing deployed files", () => {
    expect(SQL).toContain("-- compat: expand");
    expect(SQL).toContain("to_regtype('public.m23_mac_jurisdiction') IS NULL");
    expect(SQL).toContain("CREATE TYPE public.m23_mac_jurisdiction AS ENUM");
    expect(SQL).not.toContain("ALTER TYPE");

    const migrationFiles = readdirSync(fileURLToPath(new URL("..", import.meta.url)))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(migrationFiles.indexOf("1475_m23_mac_jurisdiction_type.sql")).toBeLessThan(
      migrationFiles.indexOf("1489_m23_medicare_provider_routing.sql"),
    );
    expect(JOURNAL.entries.some((entry) => entry.tag === "1475_m23_mac_jurisdiction_type")).toBe(
      true,
    );
  });

  it("keeps created and validated enum labels aligned with the Drizzle schema", () => {
    const expected = SQL.match(/expected_labels constant text\[\] := ARRAY\[([\s\S]*?)\];/);
    const created = SQL.match(/CREATE TYPE public\.m23_mac_jurisdiction AS ENUM \(([\s\S]*?)\);/);
    expect(expected).not.toBeNull();
    expect(created).not.toBeNull();
    expect(enumLabels(expected![1]!)).toEqual(m23MacJurisdiction.enumValues);
    expect(enumLabels(created![1]!)).toEqual(m23MacJurisdiction.enumValues);
    expect(SQL).toContain("actual_labels IS DISTINCT FROM expected_labels");
  });

  it("provides a label-preserving assignment cast for the deployed 1489 backfill", () => {
    expect(SQL).toContain("value public.mac_jurisdiction");
    expect(SQL).toContain("RETURNS public.m23_mac_jurisdiction");
    expect(SQL).toContain("SELECT value::text::public.m23_mac_jurisdiction");
    expect(SQL).toContain(
      "CREATE CAST (public.mac_jurisdiction AS public.m23_mac_jurisdiction)",
    );
    expect(SQL).toContain("AS ASSIGNMENT");
  });
});
