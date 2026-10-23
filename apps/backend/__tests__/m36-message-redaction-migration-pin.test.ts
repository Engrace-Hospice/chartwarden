// WP 5.6 (ADR-0055 item 7) - migration 1156, the Drizzle schema, the manifest, the permission mirror and the guard allow-list agree; the structural
// promises (FORCEd RLS, two people, approve-once on the database clock, a redaction never writes the message, no app DELETE, audit without the
// reason text, admin roles left out) are pinned on the migration text. The behaviour is proved live in m36-message-redaction.live.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MESSAGE_REDACTION_REASON_MAX_LENGTH,
  MESSAGE_REDACTION_REASON_MIN_LENGTH,
  MESSAGING_REDACT_APPROVE_PERMISSION,
  MESSAGING_REDACT_COUNTERSIGN_PERMISSION,
  MESSAGING_REDACT_REQUEST_PERMISSION,
  REDACTION_COUNTERSIGN_HOURS,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1156_m36_message_redaction.sql"));
const schema = flat(read("packages/db/src/schema/messaging/message-redactions.ts"));

describe("migration 1156 message redaction", () => {
  it("the reason bounds in the SQL CHECK and the Drizzle CHECK are the constants", () => {
    const range = `BETWEEN ${MESSAGE_REDACTION_REASON_MIN_LENGTH} AND ${MESSAGE_REDACTION_REASON_MAX_LENGTH}`;
    expect(sql).toContain(range);
    expect(schema).toContain(range);
  });

  it("one redaction per message, a composite FK that cascades, and the approval pair and two-people CHECKs", () => {
    expect(sql).toContain(
      'CONSTRAINT "message_redaction_one_per_message" UNIQUE ("organization_id", "message_id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("organization_id", "message_id") REFERENCES "message"("organization_id", "id") ON DELETE CASCADE',
    );
    expect(sql).toContain('CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL))');
    expect(sql).toContain('CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by")');
    expect(schema).toContain("message_redaction_two_people");
  });

  it("FORCEd RLS on app.org_id for the app role, plus a destruction policy; the app role never holds DELETE", () => {
    expect(sql).toContain('ALTER TABLE "message_redaction" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "message_redaction" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'CREATE POLICY "message_redaction_org_isolation" ON "message_redaction" FOR ALL TO chartwarden_app',
    );
    expect(sql).toContain(
      'CREATE POLICY "message_redaction_destruction" ON "message_redaction" FOR ALL TO chartwarden_destruction',
    );
    expect(sql).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
    expect(sql).toContain('GRANT SELECT, INSERT ON "message_redaction" TO chartwarden_app');
  });

  it("the app role may update ONLY the two approval columns", () => {
    const upd = /GRANT UPDATE \(([^)]*)\) ON "message_redaction" TO chartwarden_app/.exec(sql);
    expect(upd).not.toBeNull();
    const cols = (upd?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    expect(cols).toEqual(["approved_by", "approved_at"]);
  });

  it("the guard binds both people to app.user_id, approves once, and stamps instants from the database clock", () => {
    const actor = "IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid";
    expect(sql).toContain(`IF NEW.requested_by ${actor} THEN`);
    expect(sql).toContain(`IF NEW.approved_by ${actor} THEN`);
    expect(sql).toContain("IF OLD.approved_at IS NOT NULL THEN");
    expect(sql).toContain("message_redaction_immutable: the only change allowed is the approval");
    expect(sql).toContain("NEW.requested_at := now()");
    expect(sql).toContain("NEW.approved_at := now()");
    expect(sql).toContain(
      "LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN IF TG_OP = 'INSERT'",
    );
  });

  it("a redaction never writes the message: the migration touches no column of `message`", () => {
    const code = flat(
      read("packages/db/migrations/1156_m36_message_redaction.sql").replace(/^--.*$/gm, ""),
    );
    expect(code).not.toMatch(/ALTER TABLE "?message"? /);
    expect(code).not.toMatch(/UPDATE "?message"? /);
    expect(code).not.toContain("body_cipher");
    expect(code).not.toContain("body_sha256");
  });

  it("the audit function leaves the free-text reason out of the row", () => {
    expect(sql).toContain("to_jsonb(OLD) - 'reason'");
    expect(sql).toContain("to_jsonb(NEW) - 'reason'");
    expect(sql).toContain(
      "ALTER FUNCTION audit_phi_write_message_redaction() OWNER TO chartwarden_audit_writer",
    );
  });

  it("seeds exactly the two permission keys, for the compliance officer only (org admin has no implicit right)", () => {
    expect(sql).toContain(
      `'${MESSAGING_REDACT_REQUEST_PERMISSION}', 'message_redaction', 'request'`,
    );
    expect(sql).toContain(
      `'${MESSAGING_REDACT_APPROVE_PERMISSION}', 'message_redaction', 'approve'`,
    );
    expect(sql.match(/WHERE r\."key" = 'compliance_officer'/g)?.length).toBe(2);
    expect(sql).not.toContain("'administrator'");
    expect(sql).not.toContain("'org_admin'");
  });

  it("the manifest (.ts and .cjs) lists the table under M36, and the guard is on the check-tenancy allow-list", () => {
    expect(read("architecture/module-manifest.ts")).toContain('"message_redaction",');
    expect(read("architecture/module-manifest.cjs")).toContain('"message_redaction",');
    expect(read("scripts/check-tenancy.ts")).toContain("message_redaction_guard");
    expect(read("packages/db/src/schema/index.ts")).toContain("./messaging/message-redactions");
  });
});

// WP 5.6 (ADR-0055 D9, PROVISIONAL): the single-officer fallback, migration 1165.
const fallbackSql = flat(read("packages/db/migrations/1165_m36_redaction_single_officer.sql"));
describe("migration 1165 single-officer redaction fallback", () => {
  it("the guard fixes the countersign period at 72 hours on the database clock (the shared constant)", () => {
    expect(fallbackSql).toContain(`now() + interval '${REDACTION_COUNTERSIGN_HOURS} hours'`);
    expect(fallbackSql).toContain("now() > OLD.countersign_deadline_at");
  });

  it("only the requester self-approves, only a different person countersigns, and a countersign is bound to app.user_id", () => {
    expect(fallbackSql).toContain("v_user IS DISTINCT FROM OLD.requested_by");
    expect(fallbackSql).toContain(
      "NEW.countersigned_by IS DISTINCT FROM v_user OR NEW.countersigned_by = OLD.requested_by",
    );
    expect(fallbackSql).toContain(
      'CHECK ("countersigned_by" IS NULL OR "countersigned_by" <> "requested_by")',
    );
  });

  it("a self-approved row is final only with a countersign, and the two-people rule is relaxed only for a row that carries a self-approval", () => {
    expect(fallbackSql).toContain(
      'CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by" OR "self_approved_at" IS NOT NULL)',
    );
    expect(fallbackSql).toContain(
      'CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by" OR "countersigned_by" IS NOT NULL)',
    );
    // the ordinary path still refuses the requester
    expect(fallbackSql).toContain("NEW.approved_by IS NULL OR NEW.approved_by = OLD.requested_by");
  });

  it("the app role may update the four new columns; no DELETE is granted and the message table is never written", () => {
    expect(fallbackSql).toContain(
      'GRANT UPDATE ("self_approved_at", "countersign_deadline_at", "countersigned_by", "countersigned_at") ON "message_redaction" TO chartwarden_app',
    );
    expect(fallbackSql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
    const code = flat(
      read("packages/db/migrations/1165_m36_redaction_single_officer.sql").replace(/^--.*$/gm, ""),
    );
    expect(code).not.toMatch(/ALTER TABLE "?message"? /);
    expect(code).not.toMatch(/UPDATE "?message"? /);
  });

  it("the countersign permission goes to org_admin and the privacy officer, never the compliance officer, and matches the constant", () => {
    expect(fallbackSql).toContain(
      `'${MESSAGING_REDACT_COUNTERSIGN_PERMISSION}', 'message_redaction', 'countersign'`,
    );
    expect(fallbackSql).toContain("r.\"key\" IN ('org_admin', 'hipaa_privacy_officer')");
    expect(fallbackSql).not.toContain("'compliance_officer'");
  });

  it("the Drizzle schema carries the new columns and the same CHECK names", () => {
    for (const name of [
      "self_approved_at",
      "countersign_deadline_at",
      "countersigned_by",
      "countersigned_at",
      "message_redaction_self_approval_pair",
      "message_redaction_countersign_pair",
      "message_redaction_countersign_needs_self_approval",
      "message_redaction_countersigner_is_another",
      "message_redaction_self_final_needs_countersign",
    ]) {
      expect(schema, name).toContain(name);
      expect(fallbackSql, name).toContain(name);
    }
  });
});
