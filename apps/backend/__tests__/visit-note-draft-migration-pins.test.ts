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
const FROZEN = read("1521_m8_assembled_output_frozen_after_sign.sql");
const PART2_PIN = read("1522_m8_assembled_output_part2_derived.sql");
const AMENDMENTS = read("1523_m8_note_amendments.sql");
const COSIGN_KIND = read("1524_m8_addendum_cosignature_signature_kind.sql");

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

  it("scrubs the content hash from the audit snapshot (an offline guessing oracle for anyone with audit.read), in SQL and in the M8 denylist mirror", () => {
    expect(CONFIRMATION).toMatch(/audit_scrub\(to_jsonb\(NEW\), ARRAY\['content_hash'\]/);
    expect(M8_AUDIT_DENYLIST.encounter_draft_confirmation).toEqual(["content_hash"]);
  });

  it("carries part2_derived with no default, files Part 2 rows under the Part 2 class and withholds their source ids from the audit image", () => {
    expect(CONFIRMATION).toMatch(/"part2_derived" boolean NOT NULL,/);
    expect(CONFIRMATION).toContain("compliance_42cfr_part2");
    expect(CONFIRMATION).toMatch(/audit_scrub\(v_after, ARRAY\['source_refs'\]/);
    expect(getTableConfig(schema.encounterDraftConfirmations).columns.map((c) => c.name)).toContain(
      "part2_derived",
    );
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

  it("scrubs the sealed text and the content hash from the audit snapshot, in SQL and in the M8 denylist mirror", () => {
    expect(SIGNED_SECTION).toMatch(
      /audit_scrub\(to_jsonb\(NEW\), ARRAY\['text_cipher', 'content_hash'\]/,
    );
    expect(M8_AUDIT_DENYLIST.hearthnote_signed_section).toEqual(["text_cipher", "content_hash"]);
  });

  it("files a Part 2 section under the Part 2 retention class and withholds its source ids from the audit image", () => {
    expect(SIGNED_SECTION).toContain("compliance_42cfr_part2");
    expect(SIGNED_SECTION).toMatch(/audit_scrub\(v_after, ARRAY\['source_refs'\]/);
  });

  it("gives the destruction role UPDATE on text_cipher only (a column grant, never table-level UPDATE)", () => {
    expect(SIGNED_SECTION).toContain(
      'GRANT UPDATE ("text_cipher") ON "hearthnote_signed_section" TO chartwarden_destruction',
    );
    expect(SIGNED_SECTION).not.toMatch(
      /GRANT [A-Z, ]*UPDATE[A-Z, ]* ON "hearthnote_signed_section" TO chartwarden_destruction/,
    );
  });

  it("ties the output to the row's own encounter and the siting pair to the encounter's", () => {
    expect(SIGNED_SECTION).toContain("o.encounter_id = NEW.encounter_id");
    expect(SIGNED_SECTION).toContain(
      "e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id",
    );
    expect(SIGNED_SECTION).toContain("e.location_id IS NOT DISTINCT FROM NEW.location_id");
  });

  it("has no default on part2_derived (the writer decides, fail closed); 1518 itself carries no amends column (1523 adds it)", () => {
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

describe("migration 1521: the signed narrative is frozen", () => {
  it("stays an expand (arch:migration-compat reads this header)", () => {
    expect(FROZEN.startsWith("-- compat: expand")).toBe(true);
  });

  it("is a BEFORE UPDATE trigger on hearthnote_assembled_output that guards the three ciphers", () => {
    expect(FROZEN).toMatch(
      /CREATE TRIGGER "trg_hearthnote_assembled_output_frozen_after_sign"\s+BEFORE UPDATE ON "hearthnote_assembled_output"/,
    );
    for (const column of ["layer1_cipher", "layer2_cipher", "final_cipher"]) {
      expect(FROZEN).toContain(`NEW.${column} IS NOT DISTINCT FROM OLD.${column}`);
    }
  });

  it("freezes at signed, cosign_pending and cosigned and fails closed on an unreadable parent", () => {
    expect(FROZEN).toContain(
      "v_status IS NULL OR v_status IN ('signed', 'cosign_pending', 'cosigned')",
    );
    expect(FROZEN).toContain("ERRCODE = 'restrict_violation'");
  });

  it("exempts only a non-superuser member of chartwarden_destruction writing the shred sentinel", () => {
    expect(FROZEN).toContain("pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')");
    expect(FROZEN).toContain("r.rolsuper");
    expect(FROZEN).toContain("NEW.final_cipher = ''");
  });
});

describe("migration 1522: the pin records whether it carries Part 2 derived text", () => {
  it("stays an expand (arch:migration-compat reads this header)", () => {
    expect(PART2_PIN.startsWith("-- compat: expand")).toBe(true);
  });

  it("adds one NOT NULL boolean that defaults to false, so every existing pin reads as carrying none", () => {
    expect(PART2_PIN).toMatch(
      /ALTER TABLE "hearthnote_assembled_output"\s+ADD COLUMN "part2_derived" boolean DEFAULT false NOT NULL/,
    );
  });

  it("is mirrored in the Drizzle schema, not null with a false default", () => {
    const column = getTableConfig(schema.hearthnoteAssembledOutputs).columns.find(
      (c) => c.name === "part2_derived",
    );
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(false);
  });
});

describe("migration 1523: amendments of a signed drafted note ride the addendum path (VN-D30)", () => {
  it("stays an expand (arch:migration-compat reads this header) and drops nothing", () => {
    expect(AMENDMENTS.startsWith("-- compat: expand")).toBe(true);
    const statements = AMENDMENTS.replace(/^--.*$/gm, "");
    expect(statements).not.toMatch(/\bDROP\s+(CONSTRAINT|COLUMN|TABLE|INDEX|TRIGGER|POLICY)\b/);
    expect(statements).not.toMatch(/\bADD\s+CONSTRAINT\b/);
  });

  describe.each([
    ["encounter_amendment", ["SELECT", "INSERT"]],
    ["addendum_cosignature_request", ["SELECT", "INSERT", "UPDATE"]],
  ])("%s", (table, privileges) => {
    it("enables AND forces RLS, with an org-isolation policy for the app role", () => {
      expect(AMENDMENTS).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(AMENDMENTS).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(AMENDMENTS).toContain(`CREATE POLICY "${table}_org_isolation" ON "${table}"`);
    });

    it("never grants the application role DELETE, and only the privileges the lifecycle needs", () => {
      expect(appGrant(AMENDMENTS, table)).toEqual(privileges);
    });

    it("carries the row audit trigger and an org guard, and lets the destruction role delete for tenant destruction", () => {
      expect(AMENDMENTS).toContain(`CREATE TRIGGER "trg_audit_${table}"`);
      expect(AMENDMENTS).toContain(`FUNCTION audit_phi_write_${table}()`);
      expect(AMENDMENTS).toMatch(
        new RegExp(`CREATE TRIGGER "trg_${table}(_org)?_guard"[\\s\\S]*?ON "${table}"`),
      );
      expect(AMENDMENTS).toContain(`GRANT SELECT, DELETE ON "${table}" TO chartwarden_destruction`);
    });
  });

  it("encounter_amendment: a resolution is UPDATEd by column and never anything else, unique per (addendum, section), all-or-none", () => {
    expect(AMENDMENTS).toMatch(
      /GRANT UPDATE \("resolution", "content_hash", "corpus_version", "edited", "part2_derived", "source_refs", "resolved_by_membership_id", "resolved_at"\)\s+ON "encounter_amendment" TO chartwarden_app/,
    );
    expect(AMENDMENTS).toContain('UNIQUE ("addendum_id", "section_id")');
    expect(AMENDMENTS).toContain('CONSTRAINT "encounter_amendment_resolved_together"');
    const names = getTableConfig(schema.encounterAmendments).checks.map((c) => c.name);
    for (const name of names) expect(AMENDMENTS).toContain(`"${name}"`);
    expect(names).toHaveLength(4);
  });

  it("encounter_amendment: the guard freezes a signed or voided addendum's rows, fixes the addendum, encounter and section, and takes a naming only from a draft", () => {
    expect(AMENDMENTS).toContain("v_status IN ('signed', 'voided')");
    expect(AMENDMENTS).toContain("a.encounter_id = NEW.encounter_id");
    expect(AMENDMENTS).toContain("TG_OP = 'INSERT' AND v_status <> 'draft'");
    expect(AMENDMENTS).toContain("NEW.section_id <> OLD.section_id");
  });

  it("encounter_amendment: scrubs the content hash from the audit snapshot, files a Part 2 row under the Part 2 class and withholds its source ids (SQL and denylist mirror)", () => {
    expect(AMENDMENTS).toMatch(/audit_scrub\(to_jsonb\(NEW\), ARRAY\['content_hash'\]/);
    expect(AMENDMENTS).toMatch(/audit_scrub\(v_after, ARRAY\['source_refs'\]/);
    expect(AMENDMENTS).toContain("compliance_42cfr_part2");
    expect(M8_AUDIT_DENYLIST.encounter_amendment).toEqual(["content_hash"]);
    expect(M8_AUDIT_DENYLIST.addendum_cosignature_request).toEqual(["supervisor_released_reason"]);
  });

  it("addendum_cosignature_request is a SIBLING of cosignature_request (that one is UNIQUE (encounter_id)), one per addendum", () => {
    expect(AMENDMENTS).toContain(
      'CONSTRAINT "addendum_cosignature_request_addendum_uniq" UNIQUE ("addendum_id")',
    );
    expect(AMENDMENTS).not.toMatch(/ALTER TABLE "cosignature_request"/);
    const request = getTableConfig(schema.cosignatureRequests).columns.map((c) => c.name);
    const sibling = getTableConfig(schema.addendumCosignatureRequests).columns.map((c) => c.name);
    expect(sibling.filter((name) => name !== "addendum_id")).toEqual(request);
  });

  it("hearthnote_signed_section gains addendum_id and amends_section_id, both nullable, and stays append-only for the application role", () => {
    expect(AMENDMENTS).toMatch(
      /ALTER TABLE "hearthnote_signed_section"\s+ADD COLUMN "addendum_id" uuid REFERENCES "encounter_addendum"\("id"\) ON DELETE CASCADE,\s+ADD COLUMN "amends_section_id" uuid REFERENCES "hearthnote_signed_section"\("id"\) ON DELETE CASCADE/,
    );
    expect(AMENDMENTS).not.toMatch(/GRANT[^;]*ON "hearthnote_signed_section" TO chartwarden_app/);
    const columns = getTableConfig(schema.hearthnoteSignedSections).columns;
    for (const name of ["addendum_id", "amends_section_id"]) {
      const column = columns.find((c) => c.name === name);
      expect(column?.notNull, name).toBe(false);
    }
  });

  it("the signed-section guard: both amendment columns or neither; the amended row is an ORIGINAL of the parent's own primary pin with the same section and position; the addendum is finalized", () => {
    expect(AMENDMENTS).toContain("(NEW.addendum_id IS NULL) <> (NEW.amends_section_id IS NULL)");
    expect(AMENDMENTS).toContain("a.status::text = 'finalized'");
    expect(AMENDMENTS).toContain("o.addendum_id = NEW.addendum_id");
    expect(AMENDMENTS).toContain("po.kind::text = 'primary_finalize'");
    expect(AMENDMENTS).toContain("po.encounter_id = NEW.encounter_id");
    expect(AMENDMENTS).toContain("v_amended.amends_section_id IS NOT NULL");
    expect(AMENDMENTS).toContain("v_amended.section_id <> NEW.section_id");
    expect(AMENDMENTS).toContain('v_amended."position" <> NEW."position"');
    // the encounter check 1518 made is kept
    expect(AMENDMENTS).toContain(
      "e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id",
    );
  });
});

describe("migration 1524: an amendment's cosignature is a signature kind of its own (VN-D30)", () => {
  it("stays an expand (arch:migration-compat reads this header) and only adds an enum value", () => {
    expect(COSIGN_KIND.startsWith("-- compat: expand")).toBe(true);
    const statements = COSIGN_KIND.replace(/^--.*$/gm, "").trim();
    expect(statements).toBe(
      `ALTER TYPE "public"."signature_kind" ADD VALUE IF NOT EXISTS 'addendum_cosignature';`,
    );
  });

  it("is mirrored in the Drizzle enum, and the encounter's own cosignature kind and its one-per-encounter index are untouched", () => {
    expect(schema.signatureKind.enumValues).toEqual([
      "primary",
      "cosignature",
      "addendum",
      "addendum_cosignature",
    ]);
    expect(COSIGN_KIND.replace(/^--.*$/gm, "")).not.toMatch(/unique_cosig_idx/);
  });
});

describe("module manifest", () => {
  it("lists the five tables under M8", () => {
    const m8 = MODULES.find((m) => m.id === 8);
    expect(m8?.ownedTables).toEqual(
      expect.arrayContaining([
        "encounter_draft_confirmation",
        "hearthnote_signed_section",
        "visit_note_draft_policy",
        "encounter_amendment",
        "addendum_cosignature_request",
      ]),
    );
  });
});
