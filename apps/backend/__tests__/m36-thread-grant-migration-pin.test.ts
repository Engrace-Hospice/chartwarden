// ADR-0084 G1 - migration 1134, the Drizzle schema, the manifest and the code-side constants agree; the structural promises (RLS,
// insert/revoke-only guard, one live grant, audit trigger, database clock) are pinned on the migration text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THREAD_ACCESS_GRANT_FLAG_KEY, THREAD_ACCESS_GRANT_REASONS } from "@wardenx/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1134_m36_thread_access_grant.sql"));
const schema = flat(read("packages/db/src/schema/messaging/message-thread-access-grants.ts"));

describe("migration 1134 thread access grant", () => {
  it("the flag key is the ADR's and the reasons match the SQL CHECK and the Drizzle CHECK", () => {
    expect(THREAD_ACCESS_GRANT_FLAG_KEY).toBe("messaging.thread_access_grant");
    const list = THREAD_ACCESS_GRANT_REASONS.map((r) => `'${r}'`).join(", ");
    expect(sql).toContain(`CHECK ("reason" IN (${list}))`);
    expect(schema).toContain(`IN (${list})`);
  });

  it("has the ADR columns, an org FK and FORCEd RLS on app.org_id", () => {
    for (const c of [
      "id",
      "organization_id",
      "channel_id",
      "root_message_id",
      "request_id",
      "grantee_user_id",
      "reason",
      "granted_at",
      "expires_at",
      "revoked_at",
    ]) {
      expect(sql).toContain(`"${c}"`);
    }
    expect(sql).toContain('ALTER TABLE "message_thread_access_grant" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "message_thread_access_grant" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    // The guard reads under the caller's own RLS: no SECURITY DEFINER on the grant guard.
    expect(sql).toMatch(/message_thread_grant_guard\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY INVOKER/);
  });

  it("is insert/revoke-only: no app DELETE, UPDATE only on revoked_at, guard on the database clock", () => {
    expect(sql).toContain('GRANT SELECT, INSERT ON "message_thread_access_grant" TO wardenx_app');
    expect(sql).toContain(
      'GRANT UPDATE ("revoked_at") ON "message_thread_access_grant" TO wardenx_app',
    );
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO wardenx_app/);
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "message_thread_access_grant"');
    expect(sql).toContain("NEW.granted_at := now()");
    expect(sql).toContain("NEW.revoked_at := now()");
    expect(sql).toContain('CHECK ("expires_at" > "granted_at")');
    expect(sql).toContain(`CHECK ("expires_at" <= "granted_at" + interval '7 days')`);
  });

  it("binds channel and root to the request inside the insert guard", () => {
    expect(sql).toContain("message_thread_grant_binding: the channel is the request''s channel");
    expect(sql).toContain(
      "FROM message_acknowledgment_request r WHERE r.organization_id = NEW.organization_id AND r.id = NEW.request_id",
    );
    expect(sql).toContain("m.parent_message_id");
  });

  it("has one live grant per (request, grantee), index-covered FKs and the PHI audit trigger", () => {
    expect(sql).toContain(
      'UNIQUE INDEX "message_thread_grant_one_live" ON "message_thread_access_grant" ("organization_id", "request_id", "grantee_user_id") WHERE "revoked_at" IS NULL',
    );
    expect(sql).toContain(
      'INDEX "message_thread_grant_root_idx" ON "message_thread_access_grant" ("organization_id", "channel_id", "root_message_id")',
    );
    expect(sql).toContain(
      'INDEX "message_thread_grant_grantee_user_idx" ON "message_thread_access_grant" ("grantee_user_id")',
    );
    expect(sql).toContain("AFTER INSERT OR UPDATE OR DELETE ON message_thread_access_grant");
    expect(sql).toContain("OWNER TO wardenx_audit_writer");
  });

  it("cascades from the message and the request like the sibling ack tables, so the eraser's message delete works", () => {
    expect(sql).not.toContain("ON DELETE RESTRICT,\n");
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(2);
    expect(schema.match(/onDelete\("cascade"\)/g)).toHaveLength(2);
  });

  it("is owned by M36 in both manifests", () => {
    for (const f of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      expect(read(f)).toContain('"message_thread_access_grant"');
    }
  });
});
