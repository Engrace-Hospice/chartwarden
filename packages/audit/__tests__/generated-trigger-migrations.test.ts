// TASK-063 follow-up — proves the hand-embedded SQL in the two migrations that patch an existing
// audit trigger (0163, 0164) is BYTE-FOR-BYTE what `generateAuditTrigger()` actually produces, not
// a hand-transcribed approximation that could drift from the generator/catalog it claims to match.
// This is the strongest verification available without a live Postgres instance: if the generator's
// own unit tests (trigger-generator.test.ts) prove its output is syntactically sound, and this test
// proves the shipped migration IS that output, the migration is sound by transitivity.
//
// Reads packages/db/migrations/*.sql by relative filesystem path (not a package import — packages/db
// depends on @chartwarden/audit, so the reverse import would be circular; a plain file read has no such
// boundary).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAuditTrigger } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../../db/migrations");
const read = (file: string): string => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
// 0163/0164 were applied before the role rename (1139), so they say `wardenx_audit_writer`; the generator now emits `chartwarden_`.
const asApplied = (sql: string): string => sql.replaceAll("chartwarden_", "wardenx_");

describe("0163_care_plan_version_state_snapshot_redaction.sql — matches the generator verbatim", () => {
  it("contains generateAuditTrigger's function+owner DDL for care_plan_version's corrected denylist", () => {
    const generated = generateAuditTrigger({
      table: "care_plan_version",
      resourceKind: "care_plan_version",
      denylist: ["patient_understanding_text", "state_snapshot"],
    });
    // The migration doesn't re-run the CREATE TRIGGER-then-EXECUTE FUNCTION suffix line the
    // generator emits as one contiguous statement the same way — it splits function/owner from the
    // CREATE OR REPLACE TRIGGER restatement across two statement-breakpoints for readability. Assert
    // the SEMANTICALLY LOAD-BEARING pieces (the function body, the denylist array, the retention
    // class, the owner grant) are present verbatim rather than a brittle whole-string match.
    const migration = read("0163_care_plan_version_state_snapshot_redaction.sql");
    const functionBody = asApplied(generated).slice(
      0,
      asApplied(generated).indexOf("ALTER FUNCTION") + "ALTER FUNCTION audit_phi_write_care_plan_version() OWNER TO wardenx_audit_writer;".length,
    );
    expect(migration).toContain(functionBody);
  });

  it("re-affirms the trigger binding via CREATE OR REPLACE TRIGGER (PG14+) targeting the same function", () => {
    const migration = read("0163_care_plan_version_state_snapshot_redaction.sql");
    expect(migration).toContain(
      'CREATE OR REPLACE TRIGGER "trg_audit_care_plan_version" AFTER INSERT OR UPDATE OR DELETE ON care_plan_version',
    );
    expect(migration).toContain("EXECUTE FUNCTION audit_phi_write_care_plan_version();");
  });
});

describe("0164_lab_observation_value_sud_redaction.sql — matches the generator verbatim", () => {
  it("contains generateAuditTrigger's exact row-conditional function+owner DDL", () => {
    const generated = generateAuditTrigger({
      table: "lab_observation_value",
      resourceKind: "lab_observation_value",
      denylistCategories: ["sud_value"],
      retentionClass: "compliance_42cfr_part2",
    });
    const migration = read("0164_lab_observation_value_sud_redaction.sql");
    const functionBody = asApplied(generated).slice(
      0,
      asApplied(generated).indexOf("ALTER FUNCTION") +
        "ALTER FUNCTION audit_phi_write_lab_observation_value() OWNER TO wardenx_audit_writer;".length,
    );
    expect(migration).toContain(functionBody);
  });

  it("re-affirms the trigger binding via CREATE OR REPLACE TRIGGER targeting the same function", () => {
    const migration = read("0164_lab_observation_value_sud_redaction.sql");
    expect(migration).toContain(
      'CREATE OR REPLACE TRIGGER "trg_audit_lab_observation_value" AFTER INSERT OR UPDATE OR DELETE ON lab_observation_value',
    );
    expect(migration).toContain("EXECUTE FUNCTION audit_phi_write_lab_observation_value();");
  });

  it("no longer captures OLD/NEW verbatim via a bare to_jsonb() with no audit_scrub call (the original bug)", () => {
    const migration = read("0164_lab_observation_value_sud_redaction.sql");
    expect(migration).not.toMatch(/v_before\s*:=\s*CASE WHEN TG_OP IN \('UPDATE','DELETE'\) THEN to_jsonb\(OLD\)/);
    expect(migration).toContain("audit_scrub(to_jsonb(OLD), v_denylist)");
  });
});
