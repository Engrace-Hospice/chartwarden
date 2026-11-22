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
const NOTE_GUARDS = read("1525_m8_note_guards_after_sign.sql");
const DISCIPLINE_LINK = read("1540_m8_encounter_discipline_plan_link.sql");
const IDG_LINK = read("1545_m8_encounter_idg_action_item_link.sql");

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
  ["1540", DISCIPLINE_LINK, "encounter_discipline_plan_link"],
  ["1545", IDG_LINK, "encounter_idg_action_item_link"],
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

// ADR-0114 S4b (VN-D58, VN-D61): the link from an encounter to the M15 goals and interventions its drafted plan keeps. Soft-removed like M7's
// `encounter_care_plan_link` (the application role holds DELETE on no M8 table), one element per row, never read as "the visit addressed this".
describe("encounter_discipline_plan_link", () => {
  const table = "encounter_discipline_plan_link";

  it("is insert-and-soft-remove for the application role: SELECT and INSERT, UPDATE of the removal columns and the Part 2 flag only, never DELETE", () => {
    expect(appGrant(DISCIPLINE_LINK, table)).toEqual(["SELECT", "INSERT"]);
    expect(DISCIPLINE_LINK).toContain(
      'GRANT UPDATE ("removed_at", "removed_by_membership_id", "part2_derived") ON "encounter_discipline_plan_link" TO chartwarden_app',
    );
  });

  it("gives the destruction role an org-scoped policy beside its grant (without one the eraser's DELETE matches no row)", () => {
    expect(DISCIPLINE_LINK).toMatch(
      /CREATE POLICY "encounter_discipline_plan_link_destruction" ON "encounter_discipline_plan_link"\s+FOR ALL TO chartwarden_destruction\s+USING \("organization_id" = nullif\(current_setting\('app\.org_id', true\), ''\)::uuid\)/,
    );
  });

  it("names exactly one M15 element per row and keeps the removal columns together", () => {
    expect(DISCIPLINE_LINK).toContain(
      'CHECK (("goal_id" IS NOT NULL) <> ("intervention_id" IS NOT NULL))',
    );
    expect(DISCIPLINE_LINK).toContain(
      'CHECK (("removed_at" IS NULL) = ("removed_by_membership_id" IS NULL))',
    );
  });

  it("allows one LIVE link per (encounter, element) and any number of removed ones", () => {
    expect(DISCIPLINE_LINK).toMatch(
      /CREATE UNIQUE INDEX "encounter_discipline_plan_link_live_goal_uniq"\s+ON "encounter_discipline_plan_link" \("encounter_id", "goal_id"\)\s+WHERE "removed_at" IS NULL AND "goal_id" IS NOT NULL/,
    );
    expect(DISCIPLINE_LINK).toMatch(
      /CREATE UNIQUE INDEX "encounter_discipline_plan_link_live_intervention_uniq"\s+ON "encounter_discipline_plan_link" \("encounter_id", "intervention_id"\)\s+WHERE "removed_at" IS NULL AND "intervention_id" IS NOT NULL/,
    );
  });

  it("carries part2_derived with no default, files Part 2 rows under the Part 2 class and withholds their element ids from the audit image", () => {
    expect(DISCIPLINE_LINK).toMatch(/"part2_derived" boolean NOT NULL,/);
    expect(DISCIPLINE_LINK).toContain("compliance_42cfr_part2");
    expect(DISCIPLINE_LINK).toMatch(/audit_scrub\(v_before, ARRAY\['goal_id', 'intervention_id'\]/);
    expect(DISCIPLINE_LINK).toMatch(/audit_scrub\(v_after, ARRAY\['goal_id', 'intervention_id'\]/);
    expect(M8_AUDIT_DENYLIST.encounter_discipline_plan_link).toEqual([]);
    expect(
      getTableConfig(schema.encounterDisciplinePlanLinks).columns.map((c) => c.name),
    ).toContain("part2_derived");
  });

  it("files every DELETE as Part 2 whatever the row's flag says (a row filed low, whose element a plan revision later made Part 2, is erased with its id withheld)", () => {
    expect(DISCIPLINE_LINK).toMatch(
      /v_part2 := TG_OP = 'DELETE' OR COALESCE\(OLD\.part2_derived, false\) OR COALESCE\(NEW\.part2_derived, false\);/,
    );
  });

  it("holds a row to its encounter: the siting pair is the encounter's, and a signed, cosign-pending, cosigned or voided note takes no write except from the destruction role", () => {
    expect(DISCIPLINE_LINK).toMatch(
      /e\.provider_entity_id IS NOT DISTINCT FROM NEW\.provider_entity_id\s+AND e\.location_id IS NOT DISTINCT FROM NEW\.location_id/,
    );
    expect(DISCIPLINE_LINK).toContain(
      "v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')",
    );
    expect(DISCIPLINE_LINK).toMatch(
      /pg_has_role\(current_user, 'chartwarden_destruction', 'MEMBER'\)\s+AND NOT \(SELECT r\.rolsuper FROM pg_catalog\.pg_roles r WHERE r\.rolname = current_user\)/,
    );
    expect(DISCIPLINE_LINK).toMatch(/USING ERRCODE = 'restrict_violation'/);
  });

  it("lets an update change only the removal columns and raise the Part 2 flag: identity is frozen, a removal is final, a flag never comes down", () => {
    for (const frozen of [
      "NEW.encounter_id <> OLD.encounter_id",
      "NEW.goal_id IS DISTINCT FROM OLD.goal_id",
      "NEW.intervention_id IS DISTINCT FROM OLD.intervention_id",
      "NEW.location_id IS DISTINCT FROM OLD.location_id",
      "NEW.created_at IS DISTINCT FROM OLD.created_at",
      "OLD.removed_at IS NOT NULL",
      "OLD.part2_derived AND NOT NEW.part2_derived",
    ]) {
      expect(DISCIPLINE_LINK).toContain(frozen);
    }
    expect(DISCIPLINE_LINK).toMatch(
      /BEFORE INSERT OR UPDATE ON "encounter_discipline_plan_link"\s+FOR EACH ROW EXECUTE FUNCTION encounter_discipline_plan_link_org_guard/,
    );
  });

  it("matches its Drizzle mirror's constraint and index names", () => {
    const config = getTableConfig(schema.encounterDisciplinePlanLinks);
    for (const check of config.checks) expect(DISCIPLINE_LINK).toContain(`"${check.name}"`);
    expect(config.checks).toHaveLength(2);
    for (const index of config.indexes) expect(DISCIPLINE_LINK).toContain(`"${index.config.name}"`);
  });
});

// ADR-0114 S5b (VN-D64, VN-D67): the link from an IDG follow-up visit to the ONE M14 action item it follows up. Soft-removed like the plan link, one LIVE
// row per encounter, never read as "the visit completed the item" (M14's own auto-close does not read it).
describe("encounter_idg_action_item_link", () => {
  const table = "encounter_idg_action_item_link";

  it("is insert-and-soft-remove for the application role: SELECT and INSERT, UPDATE of the removal columns and the Part 2 flag only, never DELETE", () => {
    expect(appGrant(IDG_LINK, table)).toEqual(["SELECT", "INSERT"]);
    expect(IDG_LINK).toContain(
      'GRANT UPDATE ("removed_at", "removed_by_membership_id", "part2_derived") ON "encounter_idg_action_item_link" TO chartwarden_app',
    );
  });

  it("gives the destruction role an org-scoped policy beside its grant (without one the eraser's DELETE matches no row)", () => {
    expect(IDG_LINK).toMatch(
      /CREATE POLICY "encounter_idg_action_item_link_destruction" ON "encounter_idg_action_item_link"\s+FOR ALL TO chartwarden_destruction\s+USING \("organization_id" = nullif\(current_setting\('app\.org_id', true\), ''\)::uuid\)/,
    );
  });

  it("holds a logical M14 id (no cross-module foreign key: M8 must not import M14) and keeps the removal columns together", () => {
    expect(IDG_LINK).toMatch(/"action_item_id" uuid NOT NULL,/);
    expect(IDG_LINK).not.toMatch(/"action_item_id" uuid NOT NULL REFERENCES/);
    expect(IDG_LINK).toContain(
      'CHECK (("removed_at" IS NULL) = ("removed_by_membership_id" IS NULL))',
    );
  });

  it("allows ONE live link per encounter and any number of removed ones (VN-D64)", () => {
    expect(IDG_LINK).toMatch(
      /CREATE UNIQUE INDEX "encounter_idg_action_item_link_live_uniq"\s+ON "encounter_idg_action_item_link" \("encounter_id"\)\s+WHERE "removed_at" IS NULL;/,
    );
  });

  it("carries part2_derived with no default, files Part 2 rows under the Part 2 class and withholds their action item id from the audit image", () => {
    expect(IDG_LINK).toMatch(/"part2_derived" boolean NOT NULL,/);
    expect(IDG_LINK).toContain("compliance_42cfr_part2");
    expect(IDG_LINK).toMatch(/audit_scrub\(v_before, ARRAY\['action_item_id'\]/);
    expect(IDG_LINK).toMatch(/audit_scrub\(v_after, ARRAY\['action_item_id'\]/);
    expect(M8_AUDIT_DENYLIST.encounter_idg_action_item_link).toEqual([]);
    expect(getTableConfig(schema.encounterIdgActionItemLinks).columns.map((c) => c.name)).toContain(
      "part2_derived",
    );
  });

  it("files every DELETE as Part 2 whatever the row's flag says", () => {
    expect(IDG_LINK).toMatch(
      /v_part2 := TG_OP = 'DELETE' OR COALESCE\(OLD\.part2_derived, false\) OR COALESCE\(NEW\.part2_derived, false\);/,
    );
  });

  it("holds a row to its encounter and its members: the siting pair is the encounter's, a signed, cosign-pending, cosigned or voided note takes no write except from the destruction role", () => {
    expect(IDG_LINK).toMatch(
      /e\.provider_entity_id IS NOT DISTINCT FROM NEW\.provider_entity_id\s+AND e\.location_id IS NOT DISTINCT FROM NEW\.location_id/,
    );
    expect(IDG_LINK).toContain(
      "m.id = NEW.linked_by_membership_id AND m.organization_id = NEW.organization_id",
    );
    expect(IDG_LINK).toContain("v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')");
    expect(IDG_LINK).toMatch(
      /pg_has_role\(current_user, 'chartwarden_destruction', 'MEMBER'\)\s+AND NOT \(SELECT r\.rolsuper FROM pg_catalog\.pg_roles r WHERE r\.rolname = current_user\)/,
    );
    expect(IDG_LINK).toMatch(/USING ERRCODE = 'restrict_violation'/);
  });

  it("lets an update change only the removal columns and raise the Part 2 flag: identity is frozen, a removal is final, a flag never comes down", () => {
    for (const frozen of [
      "NEW.encounter_id <> OLD.encounter_id",
      "NEW.action_item_id <> OLD.action_item_id",
      "NEW.linked_by_membership_id <> OLD.linked_by_membership_id",
      "NEW.location_id IS DISTINCT FROM OLD.location_id",
      "NEW.created_at IS DISTINCT FROM OLD.created_at",
      "OLD.removed_at IS NOT NULL",
      "OLD.part2_derived AND NOT NEW.part2_derived",
    ]) {
      expect(IDG_LINK).toContain(frozen);
    }
    expect(IDG_LINK).toMatch(
      /BEFORE INSERT OR UPDATE ON "encounter_idg_action_item_link"\s+FOR EACH ROW EXECUTE FUNCTION encounter_idg_action_item_link_org_guard/,
    );
  });

  it("matches its Drizzle mirror's constraint and index names", () => {
    const config = getTableConfig(schema.encounterIdgActionItemLinks);
    for (const check of config.checks) expect(IDG_LINK).toContain(`"${check.name}"`);
    expect(config.checks).toHaveLength(1);
    for (const index of config.indexes) expect(IDG_LINK).toContain(`"${index.config.name}"`);
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

describe("migration 1525: the database-side guards behind a signed note (C5, D1-D7)", () => {
  /** The statements of the file, comments removed. */
  const sql = NOTE_GUARDS.replace(/^--.*$/gm, "");

  it("stays an expand (arch:migration-compat reads this header): replaces functions, adds two triggers, removes and tightens nothing", () => {
    expect(NOTE_GUARDS.startsWith("-- compat: expand")).toBe(true);
    expect(sql).not.toMatch(/\bDROP\s+(CONSTRAINT|COLUMN|TABLE|INDEX|TRIGGER|POLICY|FUNCTION)\b/);
    expect(sql).not.toMatch(/\b(ADD\s+CONSTRAINT|CREATE\s+UNIQUE\s+INDEX|REVOKE|GRANT)\b/);
  });

  it("every guard is SECURITY INVOKER (its reads run under the caller's RLS) and carries the neighbours' search_path", () => {
    const functions =
      sql.match(
        /CREATE OR REPLACE FUNCTION [a-z_0-9]+\(\) RETURNS trigger\s+LANGUAGE plpgsql[^$]*\$\$/g,
      ) ?? [];
    expect(functions).toHaveLength(6);
    for (const header of functions) {
      expect(header).toContain("SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp");
    }
  });

  it("D1: the pin's parent, kind and organization never change; its Part 2 flag and ciphers are frozen with the encounter, read from OLD", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION hearthnote_assembled_output_frozen_after_sign()",
    );
    for (const column of ["encounter_id", "addendum_id", "kind", "organization_id"]) {
      expect(sql).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(sql).toContain(
      "COALESCE(OLD.encounter_id, (SELECT a.encounter_id FROM encounter_addendum a WHERE a.id = OLD.addendum_id))",
    );
    expect(sql).not.toContain("COALESCE(NEW.encounter_id");
    expect(sql).toContain("NEW.part2_derived IS DISTINCT FROM OLD.part2_derived");
    // the eraser's shred exception is the 1521 one
    expect(sql).toContain("pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')");
    expect(sql).toContain("NEW.final_cipher = ''");
  });

  it("D2: a BEFORE INSERT guard on the pin: kind matches the parent column, parent in the organization, a signed note or addendum takes no pin", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER "trg_hearthnote_assembled_output_insert_guard"\s+BEFORE INSERT ON "hearthnote_assembled_output"/,
    );
    expect(sql).toContain("NEW.kind::text = 'primary_finalize' AND NEW.encounter_id IS NULL");
    expect(sql).toContain("NEW.kind::text = 'addendum_finalize' AND NEW.addendum_id IS NULL");
    expect(sql).toContain("v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')");
    // an addendum's pin is written while its parent is already signed: the addendum's own status decides
    expect(sql).toContain("v_status IN ('signed', 'voided')");
    expect(sql).toContain("e.organization_id = NEW.organization_id");
    expect(sql).toContain("a.organization_id = NEW.organization_id");
  });

  it("D3: an original sealed row needs a finalized encounter; the amendment branch of 1523 is kept", () => {
    expect(sql).toContain("e.status::text = 'finalized'");
    expect(sql).toContain("a.status::text = 'finalized'");
    expect(sql).toContain("v_amended.amends_section_id IS NOT NULL");
  });

  it("D4: the addendum's request guard fires on INSERT OR UPDATE (CREATE OR REPLACE TRIGGER, not a drop), checks the releasing member and fixes the tenancy columns", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE TRIGGER "trg_addendum_cosignature_request_org_guard"\s+BEFORE INSERT OR UPDATE ON "addendum_cosignature_request"/,
    );
    expect(sql).toContain("m.id = NEW.supervisor_released_by");
    for (const column of [
      "organization_id",
      "encounter_id",
      "addendum_id",
      "provider_entity_id",
      "location_id",
    ]) {
      expect(sql).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
  });

  it("D5: an addendum cosignature signature needs an addendum of its encounter and organization, one per addendum, under an advisory lock", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER "trg_encounter_signature_addendum_cosignature_guard"\s+BEFORE INSERT ON "encounter_signature"/,
    );
    expect(sql).toContain("NEW.kind::text <> 'addendum_cosignature'");
    expect(sql).toContain(
      "a.encounter_id = NEW.encounter_id AND a.organization_id = NEW.organization_id",
    );
    expect(sql).toContain(
      "pg_advisory_xact_lock(hashtextextended('encounter_signature:addendum_cosignature:'",
    );
    expect(sql).toContain(
      "s.addendum_id = NEW.addendum_id AND s.kind::text = 'addendum_cosignature'",
    );
  });

  it("C5 / D6 / D7: the confirmation guard compares the siting pair and refuses a signed or voided encounter, bar the destruction role", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION encounter_draft_confirmation_org_guard()");
    const guard = sql.slice(sql.indexOf("FUNCTION encounter_draft_confirmation_org_guard"));
    expect(guard).toContain("e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id");
    expect(guard).toContain("e.location_id IS NOT DISTINCT FROM NEW.location_id");
    expect(guard).toContain("v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')");
    expect(guard).toContain("pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')");
    // the trigger itself (1517) already fires on both and is not re-created
    expect(CONFIRMATION).toMatch(/BEFORE INSERT OR UPDATE ON "encounter_draft_confirmation"/);
    expect(sql).not.toContain("trg_encounter_draft_confirmation_org_guard");
  });

  it("no table, column or policy changes: nothing to mirror in the Drizzle schema or the manifest", () => {
    expect(sql).not.toMatch(/\b(CREATE TABLE|ALTER TABLE|CREATE POLICY|ADD COLUMN)\b/);
  });
});

describe("module manifest", () => {
  it("lists the draft tables under M8", () => {
    const m8 = MODULES.find((m) => m.id === 8);
    expect(m8?.ownedTables).toEqual(
      expect.arrayContaining([
        "encounter_discipline_plan_link",
        "encounter_idg_action_item_link",
        "encounter_draft_confirmation",
        "hearthnote_signed_section",
        "visit_note_draft_policy",
        "encounter_amendment",
        "addendum_cosignature_request",
      ]),
    );
  });
});
