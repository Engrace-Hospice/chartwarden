// ADR-0096 S1 - migration 1180, the Drizzle schema, the manifest, the permission mirrors and the code-side constants agree; the structural
// promises (FORCEd RLS, read-only access, 30 day cap, hashes only, no app DELETE, a read trail the database refuses for a dead share, audit
// without secrets, the permission granted only to compliance/admin roles) are pinned on the migration text. Behaviour is proven live.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_SESSION_STAGES,
  EXTERNAL_SHARE_MAX_CODE_ATTEMPTS,
  EXTERNAL_SHARE_MAX_DAYS,
  EXTERNAL_SHARE_PARTNER_KINDS,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1180_m36_external_share.sql"));
const schema = flat(read("packages/db/src/schema/messaging/message-external-share.ts"));
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const TABLES = [
  "message_external_share",
  "message_external_session",
  "message_external_share_read",
] as const;

describe("migration 1180 external partner share", () => {
  it("the closed sets and numeric bounds in the SQL and Drizzle CHECKs are the constants", () => {
    expect(sql).toContain(`CHECK ("partner_kind" IN (${inList(EXTERNAL_SHARE_PARTNER_KINDS)}))`);
    expect(schema).toContain(`IN (${inList(EXTERNAL_SHARE_PARTNER_KINDS)})`);
    expect(sql).toContain(`CHECK ("stage" IN (${inList(EXTERNAL_SESSION_STAGES)}))`);
    expect(schema).toContain(`IN (${inList(EXTERNAL_SESSION_STAGES)})`);
    const cap = `"shared_from" + interval '${EXTERNAL_SHARE_MAX_DAYS} days'`;
    expect(sql).toContain(cap);
    expect(schema).toContain(`interval '${EXTERNAL_SHARE_MAX_DAYS} days'`);
    expect(sql).toContain(`"code_attempts" BETWEEN 0 AND ${EXTERNAL_SHARE_MAX_CODE_ATTEMPTS}`);
    expect(schema).toContain(`BETWEEN 0 AND ${EXTERNAL_SHARE_MAX_CODE_ATTEMPTS}`);
    expect(sql).toContain(`CHECK ("access" = 'read')`);
  });

  it("every table has an org FK, FORCEd RLS on app.org_id, a destruction policy and an audit trigger", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`CREATE TABLE "${t}"`);
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `CREATE POLICY "${t}_org_isolation" ON "${t}" FOR ALL TO chartwarden_app`,
      );
      expect(sql).toContain(
        `CREATE POLICY "${t}_destruction" ON "${t}" FOR ALL TO chartwarden_destruction`,
      );
      expect(sql).toContain(`"organization_id" uuid NOT NULL REFERENCES "organization"("id")`);
      expect(sql).toContain(`CREATE TRIGGER "trg_audit_${t}"`);
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO chartwarden_destruction`);
    }
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
  });

  it("the app role updates only the lifecycle columns and the read trail never updates", () => {
    expect(sql).toContain(
      `GRANT UPDATE ("revoked_at", "revoked_by", "invite_redeemed_at", "code_attempts") ON "message_external_share" TO chartwarden_app`,
    );
    expect(sql).toContain(
      `GRANT UPDATE ("stage", "activated_at") ON "message_external_session" TO chartwarden_app`,
    );
    expect(sql).toContain(
      `GRANT SELECT, INSERT ON "message_external_share_read" TO chartwarden_app`,
    );
    expect(sql).not.toMatch(/GRANT UPDATE[^;]*"message_external_share_read"/);
  });

  it("secrets are hashes only and are left out of the audit rows", () => {
    expect(sql).toContain('"invite_token_hash" text NOT NULL');
    expect(sql).toContain('"code_hash" text NOT NULL');
    expect(sql).toContain('"token_hash" text NOT NULL');
    expect(sql).not.toMatch(/"(invite_token|token|code)" text/);
    expect(sql).toContain("- 'invite_token_hash' - 'code_hash' - 'baa_reference' - 'partner_name'");
    expect(sql).toContain("- 'token_hash'");
  });

  it("the guards bind the creator and revoker, and refuse a read for a dead share", () => {
    expect(sql).toContain("a share is recorded only by its creator");
    expect(sql).toContain("a share is revoked once, by the acting user");
    expect(sql).toContain("the invitation is single use");
    expect(sql).toContain("a session needs a live, redeemed share and cannot outlive it");
    expect(sql).toContain(
      "x.stage = 'active' AND x.expires_at > now() AND s.revoked_at IS NULL AND s.expires_at > now()",
    );
    expect(
      sql.match(
        /FUNCTION message_external_\w+_guard\(\) RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER/g,
      )?.length,
    ).toBe(3);
  });

  it("grants the permission to compliance_officer, administrator and org_admin only", () => {
    expect(sql).toContain(
      `('messaging.share.manage', 'message_external_share', 'manage', 'compliance', 'none', '')`,
    );
    expect(sql).toContain(`WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')`);
  });

  it("the manifest .ts and .cjs both own the three tables", () => {
    for (const f of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      const text = read(f);
      for (const t of TABLES) expect(text, `${f} ${t}`).toContain(`"${t}"`);
    }
  });
});
