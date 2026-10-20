// ADR-0086 (PROPOSED) WP 5.6 S2 - migration 1137, the Drizzle schema, the manifest, the permission and the code-side constants agree;
// the structural promises (FORCEd RLS, append-only overlay, SECURITY DEFINER backstop on 23001, grants) are pinned on the migration text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY,
  MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH,
  MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY,
  MESSAGE_RETENTION_DATA_CLASSES,
  MESSAGING_RETENTION_MANAGE_PERMISSION,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1137_m36_message_legal_hold.sql"));
const schema = flat(read("packages/db/src/schema/messaging/legal-hold-messages.ts"));

describe("migration 1137 message legal hold", () => {
  it("the code-side constants are the ADR's", () => {
    expect(MESSAGING_RETENTION_MANAGE_PERMISSION).toBe("messaging.retention.manage");
    expect(MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY).toBe("messaging.legal_hold.apply");
    expect(MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY).toBe("messaging.legal_hold.release");
    expect(MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH).toBe(10);
    expect([...MESSAGE_RETENTION_DATA_CLASSES]).toEqual([
      "message.care_related",
      "message.bereavement",
      "message.operational",
    ]);
  });

  it("has the overlay columns, a composite cascading message FK and the Drizzle schema matches", () => {
    for (const c of ["id", "organization_id", "legal_hold_id", "message_id", "held_at"]) {
      expect(sql).toContain(`"${c}"`);
    }
    expect(sql).toContain('FOREIGN KEY ("organization_id", "message_id")');
    expect(sql).toContain('REFERENCES "message"("organization_id", "id") ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE ("legal_hold_id", "message_id")');
    expect(sql).not.toMatch(/"legal_hold_id" uuid NOT NULL REFERENCES/);
    expect(schema).toContain('pgTable( "legal_hold_message"');
    expect(schema).toContain('name: "legal_hold_message_message_fk"');
    expect(schema).toContain('"legal_hold_message_hold_message_unique"');
  });

  it("is FORCEd RLS on app.org_id with the nullif shape", () => {
    expect(sql).toContain('ALTER TABLE "legal_hold_message" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "legal_hold_message" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    expect(sql).toContain('FOR ALL TO wardenx_admin USING (true) WITH CHECK (true)');
  });

  it("is append-only for the app role and delete-only for the destruction credential", () => {
    expect(sql).toContain('GRANT SELECT, INSERT ON "legal_hold_message" TO wardenx_app');
    expect(sql).toContain('GRANT SELECT, DELETE ON "legal_hold_message" TO wardenx_destruction');
    expect(sql).not.toMatch(/GRANT [^;]*(UPDATE|DELETE)[^;]*TO wardenx_app/);
  });

  it("backstops DELETE and body_cipher UPDATE with a pinned SECURITY DEFINER guard on 23001", () => {
    expect(sql).toMatch(/message_legal_hold_guard\(\) RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog/);
    expect(sql).toContain("USING ERRCODE = '23001'");
    expect(sql).toContain("l.status = 'active'");
    expect(sql).toContain("ALTER FUNCTION message_legal_hold_guard() OWNER TO wardenx_admin");
    expect(sql).toContain('BEFORE DELETE ON "message"');
    expect(sql).toContain('BEFORE UPDATE OF "body_cipher" ON "message"');
  });

  it("audits changes to the overlay and registers the permission with its three grants", () => {
    expect(sql).toContain("AFTER UPDATE OR DELETE ON legal_hold_message");
    expect(sql).toContain("EXECUTE FUNCTION wardenx_audit_trigger()");
    expect(sql).toContain(
      "('messaging.retention.manage', 'message_retention', 'manage', 'compliance', 'none', '')",
    );
    expect(sql).toContain("IN ('compliance_officer', 'administrator', 'org_admin')");
  });

  it("is owned by M36 in both manifests", () => {
    for (const f of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      expect(read(f)).toContain('"legal_hold_message"');
    }
  });
});
