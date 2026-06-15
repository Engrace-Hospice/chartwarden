// @wardenx/audit — M4-T02 unit tests (M4 spec §3.3, M04-F06, D10).
//
// Proves the PHI write-audit trigger generator without live infra:
//   • SHAPE — emits the §3.3 function/owner/trigger triad, scrubbing the denylist into the diff.
//   • HARDENING — SECURITY DEFINER + `OWNER TO wardenx_audit_writer` + hardened search_path (M04-F06).
//   • PHI-GUARDS — the generated trigger satisfies the arch:gaps audit-trigger heuristic (acceptance).
//   • DENYLIST — explicit columns ∪ named categories, deduped + deterministic (§5.1, D10).
//   • SAFETY — rejects non-identifier table/column names and refuses to self-audit audit_event.
import { describe, expect, it } from "vitest";
import {
  AUDIT_SCRUB_FUNCTION_DDL,
  CHANGE_MARKER,
  auditScrubFunctionDDL,
  auditWriterGrantsDDL,
  generateAuditTrigger,
  resolveDenylist,
} from "../src/index";

describe("generateAuditTrigger — §3.3 DDL shape", () => {
  const ddl = generateAuditTrigger({
    table: "encounter",
    resourceKind: "encounter",
    denylist: ["narrative", "ssn"],
  });

  it("emits the per-table function, owner change, and trigger", () => {
    expect(ddl).toContain("CREATE OR REPLACE FUNCTION audit_phi_write_encounter() RETURNS trigger");
    expect(ddl).toContain("ALTER FUNCTION audit_phi_write_encounter() OWNER TO wardenx_audit_writer;");
    expect(ddl).toContain(
      'CREATE TRIGGER "trg_audit_encounter" AFTER INSERT OR UPDATE OR DELETE ON encounter',
    );
    expect(ddl).toContain("EXECUTE FUNCTION audit_phi_write_encounter();");
  });

  it("is SECURITY DEFINER with a hardened search_path (M04-F06 #1, #3)", () => {
    expect(ddl).toContain("SECURITY DEFINER");
    expect(ddl).toContain("SET search_path = pg_catalog, public");
  });

  it("writes a scrubbed before/after diff into audit_event keyed on the row's organization_id", () => {
    expect(ddl).toContain("INSERT INTO audit_event");
    expect(ddl).toContain("audit_scrub(to_jsonb(OLD), ARRAY['narrative', 'ssn']::text[])");
    expect(ddl).toContain("audit_scrub(to_jsonb(NEW), ARRAY['narrative', 'ssn']::text[])");
    expect(ddl).toContain("COALESCE(NEW.organization_id, OLD.organization_id)");
    // event_type taxonomy: `<resourceKind>.<verb>` (§2.3), actor resolved from app.user_id.
    expect(ddl).toContain("'encounter.' || lower(TG_OP)");
  });

  it("defaults to the `compliance` retention class and honors an override", () => {
    expect(ddl).toContain("'compliance'");
    const part2 = generateAuditTrigger({
      table: "lab_observation",
      resourceKind: "lab_observation",
      retentionClass: "compliance_42cfr_part2",
    });
    expect(part2).toContain("'compliance_42cfr_part2'");
  });

  it("emits an empty denylist array when no columns are scrubbed", () => {
    const plain = generateAuditTrigger({ table: "care_team", resourceKind: "care_team" });
    expect(plain).toContain("audit_scrub(to_jsonb(NEW), ARRAY[]::text[])");
  });
});

describe("generateAuditTrigger — phi-guards acceptance (arch:gaps)", () => {
  // The exact heuristic from scripts/check-fitness-gaps.ts §3 PHI GUARDS: an org-scoped table
  // must carry a trigger whose definition mentions audit. Applying the generator's output must
  // make that check pass for a sample table.
  it("satisfies the audit-trigger-presence regex for the target table", () => {
    const table = "sample_phi";
    const ddl = generateAuditTrigger({ table, resourceKind: "sample_phi" });
    const auditTriggerPresent = new RegExp(
      `trigger[\\s\\S]*?on\\s+${table}\\b[\\s\\S]*?(audit|wardenx_audit)`,
      "i",
    );
    expect(auditTriggerPresent.test(ddl)).toBe(true);
  });
});

describe("resolveDenylist — explicit columns ∪ named categories (§5.1, D10)", () => {
  it("unions explicit columns with category-expanded columns, deduped and sorted", () => {
    const cols = resolveDenylist({
      denylist: ["ssn"],
      denylistCategories: ["pii_high_sensitivity", "narrative_free_text"],
      categoryColumns: {
        pii_high_sensitivity: ["ssn", "mbi"],
        narrative_free_text: ["narrative"],
      },
    });
    expect(cols).toEqual(["mbi", "narrative", "ssn"]);
  });

  it("contributes nothing for a category with no column mapping (catalog seed is M4-T07)", () => {
    expect(resolveDenylist({ denylistCategories: ["sud_value"] })).toEqual([]);
  });

  it("returns an empty list when nothing is declared", () => {
    expect(resolveDenylist({})).toEqual([]);
  });
});

describe("generateAuditTrigger — input safety", () => {
  it("rejects a non-identifier table name", () => {
    expect(() => generateAuditTrigger({ table: "drop table x;--", resourceKind: "x" })).toThrow(
      /invalid table/,
    );
  });

  it("rejects a non-identifier denylist column", () => {
    expect(() =>
      generateAuditTrigger({ table: "encounter", resourceKind: "encounter", denylist: ["a'; --"] }),
    ).toThrow(/invalid denylist column/);
  });

  it("refuses to attach a trigger to the append-only audit log (recursion guard)", () => {
    expect(() => generateAuditTrigger({ table: "audit_event", resourceKind: "audit_event" })).toThrow(
      /recurse/,
    );
    expect(() =>
      generateAuditTrigger({ table: "audit_event_2026_06", resourceKind: "audit_event" }),
    ).toThrow(/recurse/);
  });
});

describe("one-time DDL — audit_scrub helper + writer grants (M04-F06)", () => {
  it("audit_scrub replaces denied values with the change marker and passes NULL through", () => {
    expect(auditScrubFunctionDDL()).toBe(AUDIT_SCRUB_FUNCTION_DDL);
    expect(AUDIT_SCRUB_FUNCTION_DDL).toContain("CREATE OR REPLACE FUNCTION audit_scrub(payload jsonb, denylist text[])");
    expect(AUDIT_SCRUB_FUNCTION_DDL).toContain("WHEN payload IS NULL THEN NULL");
    expect(AUDIT_SCRUB_FUNCTION_DDL).toContain(`to_jsonb('${CHANGE_MARKER}'::text)`);
    expect(AUDIT_SCRUB_FUNCTION_DDL).toContain("SET search_path = pg_catalog, public");
  });

  it("grants the writer role INSERT-only access via a targeted RLS policy (no BYPASSRLS)", () => {
    const grants = auditWriterGrantsDDL();
    expect(grants).toContain("GRANT INSERT ON audit_event TO wardenx_audit_writer;");
    expect(grants).toContain("CREATE POLICY audit_writer_insert ON audit_event");
    expect(grants).toContain("FOR INSERT TO wardenx_audit_writer WITH CHECK (true)");
    expect(grants).not.toContain("BYPASSRLS");
  });
});
