// WP 3.8 - the TypeScript closed unions are pinned to the CHECK lists in migration 1103 and to the Drizzle schema, and the
// structural guarantees the review queue relies on (one open review per task, no DELETE for wardenx_app, forced RLS, both
// triggers, the scrubbing audit trigger, the permission row) are asserted on the migration text, so a change in one place
// without the others fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_ITEM_KINDS,
  REVIEW_LIFECYCLE_CAUSES,
  REVIEW_RESOLUTIONS,
  REVIEW_STATES,
  TASK_CLOSE_REASONS,
  TASK_REASSIGN_SOURCES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const sql = readFileSync(join(root, "packages/db/migrations/1103_m36_review_queue.sql"), "utf8");
const drizzle = readFileSync(
  join(root, "packages/db/src/schema/messaging/review-items.ts"),
  "utf8",
);
const flat = (s: string) => s.replace(/\s+/g, " ");
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

describe("closed unions agree with the CHECK lists in SQL and Drizzle", () => {
  it.each([
    ["lifecycle causes", REVIEW_LIFECYCLE_CAUSES],
    ["item kind", REVIEW_ITEM_KINDS],
    ["state", REVIEW_STATES],
    ["resolution", REVIEW_RESOLUTIONS],
    ["close reason", TASK_CLOSE_REASONS],
  ] as const)("%s", (_name, values) => {
    expect(flat(sql)).toContain(`IN (${list(values)})`);
    expect(flat(drizzle)).toContain(`IN (${list(values)})`);
  });

  it("the review reassign source is a known task reassign source", () => {
    expect(TASK_REASSIGN_SOURCES).toContain("review");
  });
});

describe("migration 1103 structure", () => {
  it("names the same constraints and indexes the Drizzle schema declares", () => {
    for (const name of [
      "messaging_review_item_org_id_uq",
      "messaging_review_item_source_cause",
      "messaging_review_item_kind_shape",
      "messaging_review_item_state_shape",
      "messaging_review_item_resolution_shape",
      "messaging_review_item_resolved_shape",
      "messaging_review_item_closed_reason",
      "messaging_review_item_reassigned_to",
      "messaging_review_item_decided_by",
      "messaging_review_item_trigger_uq",
      "messaging_review_item_one_open",
      "messaging_review_item_queue_idx",
      "messaging_review_item_item_idx",
      "messaging_review_item_patient_idx",
      "messaging_review_item_subject_idx",
    ]) {
      expect(sql, `${name} in SQL`).toContain(`"${name}"`);
      expect(drizzle, `${name} in Drizzle`).toContain(`"${name}"`);
    }
  });

  it("allows one OPEN review per task and one row per trigger and task", () => {
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "messaging_review_item_one_open" ON "messaging_review_item" ("organization_id", "item_kind", "item_id") WHERE "state" = \'open\'',
    );
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "messaging_review_item_trigger_uq" ON "messaging_review_item" ("organization_id", "source", "trigger_ref", "item_kind", "item_id")',
    );
  });

  it("keeps the task lookup index plain (the closing trigger and the service read any state)", () => {
    expect(flat(sql)).toMatch(
      /CREATE INDEX "messaging_review_item_item_idx" ON "messaging_review_item" \("organization_id", "item_kind", "item_id"\);/,
    );
  });

  it("forces RLS and gives wardenx_app no DELETE", () => {
    expect(sql).toContain('ALTER TABLE "messaging_review_item" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "messaging_review_item" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT, DELETE ON "messaging_review_item" TO wardenx_destruction');
    const appGrants = [...sql.matchAll(/GRANT ([A-Z, ]+?) ON "(\w+)" TO wardenx_app/g)].map(
      (m) => [m[2], m[1]] as const,
    );
    expect(appGrants).toEqual([["messaging_review_item", "SELECT, INSERT"]]);
  });

  it("UPDATE is column-level and freezes the pointers", () => {
    const grant = /GRANT UPDATE \(([^)]+)\)\s+ON "messaging_review_item" TO wardenx_app/.exec(sql);
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    expect(cols.sort()).toEqual(
      [
        "reassigned_to_user_id",
        "resolution",
        "resolution_reason",
        "resolved_at",
        "resolved_by_user_id",
        "state",
        "updated_at",
        "version",
      ].sort(),
    );
    for (const frozen of [
      "patient_id",
      "item_id",
      "trigger_ref",
      "subject_user_id",
      "source",
      "cause",
      "organization_id",
    ])
      expect(cols).not.toContain(frozen);
  });

  it("makes a decided row final and resolves the review when the task closes by any path", () => {
    expect(sql).toContain("trg_messaging_review_item_resolved_final");
    expect(sql).toContain("messaging_review_item_resolved");
    expect(flat(sql)).toContain(
      "AFTER UPDATE OF status ON communication_task FOR EACH ROW WHEN (OLD.status IN ('open', 'accepted') AND NEW.status IN ('done', 'cancelled')) EXECUTE FUNCTION communication_task_resolve_review()",
    );
    expect(sql).toContain("resolution = 'closed_elsewhere'");
    // arch:tenancy: app.user_id may be read only inside an audit trigger, so the closing trigger records no actor.
    const fn =
      /FUNCTION communication_task_resolve_review\(\)[\s\S]*?END \$\$;/.exec(sql)?.[0] ?? "";
    expect(fn).not.toContain("current_setting");
    expect(sql).toMatch(
      /communication_task_resolve_review\(\) RETURNS trigger\s+LANGUAGE plpgsql SET search_path/,
    );
    expect(sql).not.toMatch(/communication_task_resolve_review\(\)[^;]*SECURITY DEFINER/);
  });

  it("carries a scrubbing audit trigger that hides the patient and the trigger reference", () => {
    expect(sql).toContain("audit_phi_write_messaging_review_item");
    expect(sql).toContain("ARRAY['patient_id','trigger_ref']");
    expect(sql).toContain(
      "ALTER FUNCTION audit_phi_write_messaging_review_item() OWNER TO wardenx_audit_writer",
    );
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON messaging_review_item/);
  });

  it("registers messaging.review for supervisory roles only, never org_admin", () => {
    expect(sql).toContain("('messaging.review', 'review_item', 'manage', 'clinical', 'none', '')");
    const grant = /WHERE r\."key" IN \(([^)]+)\)/.exec(sql);
    const roles = (grant?.[1] ?? "").split(",").map((r) => r.trim().replace(/'/g, ""));
    expect(roles.sort()).toEqual(
      ["clinical_lead", "clinical_supervisor", "director_of_nursing", "don"].sort(),
    );
    expect(roles).not.toContain("org_admin");
  });

  it("stores no free text: no title, body, note or justification column", () => {
    const table = /CREATE TABLE "messaging_review_item" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    expect(table.length).toBeGreaterThan(0);
    expect(table).not.toMatch(/"(title|body|note|notes|text|description|excerpt|justification)"/);
  });
});
