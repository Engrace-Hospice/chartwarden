// ADR-0114 - static pins for what migrations 1517 / 1518 / 1519 carry that no gate reads: who may write each table, the audit scrub on the
// sealed text, and the code-side mirrors (Drizzle schema, M8 audit denylist, manifest). These assert STRUCTURE (statements, names,
// constants), never the wording of a comment. The behaviour itself is proven live (m8-visit-note-drafting.live.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@chartwarden/db";
import { M8_AUDIT_DENYLIST } from "@chartwarden/types";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { MODULES } from "../../../architecture/module-manifest";

const ROOT = join(__dirname, "../../..");
const read = (name: string): string =>
  readFileSync(join(ROOT, "packages/db/migrations", name), "utf8");
const CONFIRMATION = read("1517_m8_encounter_draft_confirmation.sql");
const SIGNED_SECTION = read("1518_m8_hearthnote_signed_section.sql");
const POLICY = read("1519_m8_visit_note_draft_policy.sql");

/** The privilege list of the `GRANT ... ON "<table>" TO chartwarden_app` statement. */
function appGrant(source: string, table: string): readonly string[] {
  const match = new RegExp(`GRANT ([A-Z, ]+) ON "${table}" TO chartwarden_app`).exec(source);
  expect(match, `an app-role GRANT on ${table}`).not.toBeNull();
  return (match?.[1] ?? "").split(",").map((privilege) => privilege.trim());
}

describe.each([
  ["1517", CONFIRMATION, "encounter_draft_confirmation"],
  ["1518", SIGNED_SECTION, "hearthnote_signed_section"],
  ["1519", POLICY, "visit_note_draft_policy"],
])("migration %s", (_ordinal, source, table) => {
  it("stays an expand (arch:migration-compat reads this header)", () => {
    expect(source.startsWith("-- compat: expand")).toBe(true);
  });

  it("enables AND forces RLS, with an org-isolation policy for the app role", () => {
    expect(source).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(source).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    expect(source).toContain(`CREATE POLICY "${table}_org_isolation" ON "${table}"`);
  });

  it("never grants the application role DELETE", () => {
    expect(appGrant(source, table)).not.toContain("DELETE");
  });

  it("carries the row audit trigger", () => {
    expect(source).toContain(`CREATE TRIGGER "trg_audit_${table}"`);
    expect(source).toContain(`FUNCTION audit_phi_write_${table}()`);
  });

  it("guards that the rows it references belong to its own organization (single-column FKs ignore RLS)", () => {
    expect(source).toContain(`CREATE TRIGGER "trg_${table}_org_guard"`);
    expect(source).toMatch(/RAISE EXCEPTION[^;]*USING ERRCODE = '23503'/);
  });

  it("lets the destruction role delete the rows for tenant destruction", () => {
    expect(source).toMatch(
      new RegExp(`GRANT SELECT, (UPDATE, )?DELETE ON "${table}" TO chartwarden_destruction`),
    );
  });
});

describe("encounter_draft_confirmation", () => {
  it("is upsertable (INSERT + UPDATE) and unique per (encounter, section)", () => {
    expect(appGrant(CONFIRMATION, "encounter_draft_confirmation")).toEqual([
      "SELECT",
      "INSERT",
      "UPDATE",
    ]);
    expect(CONFIRMATION).toContain('UNIQUE ("encounter_id", "section_id")');
  });

  it("constrains resolution, content hash and source refs", () => {
    expect(CONFIRMATION).toContain(`CHECK ("resolution" IN ('confirmed', 'deselected'))`);
    expect(CONFIRMATION).toContain(`"content_hash" ~ '^[0-9a-f]{64}$'`);
    expect(CONFIRMATION).toContain(`jsonb_typeof("source_refs") = 'array'`);
  });

  it("matches its Drizzle mirror's constraint names", () => {
    const names = getTableConfig(schema.encounterDraftConfirmations).checks.map((c) => c.name);
    for (const name of names) expect(CONFIRMATION).toContain(`"${name}"`);
    expect(names).toHaveLength(3);
  });
});

describe("hearthnote_signed_section", () => {
  it("is append-only for the application role: SELECT and INSERT, nothing else", () => {
    expect(appGrant(SIGNED_SECTION, "hearthnote_signed_section")).toEqual(["SELECT", "INSERT"]);
  });

  it("is unique per (output, section) and per (output, position)", () => {
    expect(SIGNED_SECTION).toContain('UNIQUE ("assembled_output_id", "section_id")');
    expect(SIGNED_SECTION).toContain('UNIQUE ("assembled_output_id", "position")');
  });

  it("scrubs the sealed text from the audit snapshot, in SQL and in the M8 denylist mirror", () => {
    expect(SIGNED_SECTION).toMatch(/audit_scrub\(to_jsonb\(NEW\), ARRAY\['text_cipher'\]/);
    expect(M8_AUDIT_DENYLIST.hearthnote_signed_section).toEqual(["text_cipher"]);
    expect(M8_AUDIT_DENYLIST.encounter_draft_confirmation).toEqual([]);
  });

  it("has no default on part2_derived (the writer decides, fail closed) and no amends column yet", () => {
    expect(SIGNED_SECTION).toMatch(/"part2_derived" boolean NOT NULL,/);
    expect(SIGNED_SECTION).not.toMatch(/"amends/);
  });

  it("matches its Drizzle mirror's constraint names", () => {
    const names = getTableConfig(schema.hearthnoteSignedSections).checks.map((c) => c.name);
    for (const name of names) expect(SIGNED_SECTION).toContain(`"${name}"`);
    expect(names).toHaveLength(3);
  });
});

describe("visit_note_draft_policy", () => {
  it("is one row per organization and off by default", () => {
    expect(POLICY).toMatch(/"organization_id" uuid PRIMARY KEY REFERENCES "organization"/);
    expect(POLICY).toMatch(/"enabled" boolean DEFAULT false NOT NULL/);
    expect(appGrant(POLICY, "visit_note_draft_policy")).toEqual(["SELECT", "INSERT", "UPDATE"]);
  });

  it("pins enabled_at to the switch, in SQL and in the Drizzle mirror", () => {
    expect(POLICY).toContain(`CHECK ("enabled" = ("enabled_at" IS NOT NULL))`);
    const names = getTableConfig(schema.visitNoteDraftPolicies).checks.map((c) => c.name);
    expect(names).toEqual(["visit_note_draft_policy_enabled_at_check"]);
  });
});

describe("module manifest", () => {
  it("lists the three tables under M8", () => {
    const m8 = MODULES.find((m) => m.id === 8);
    expect(m8?.ownedTables).toEqual(
      expect.arrayContaining([
        "encounter_draft_confirmation",
        "hearthnote_signed_section",
        "visit_note_draft_policy",
      ]),
    );
  });
});
