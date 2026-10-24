// ADR-0087 S1 - migration 1140, the Drizzle schema, the manifest and the code-side constants agree; the structural promises (FORCEd RLS,
// insert/revoke-only grant, mandatory review, reviewer is not the grantee, read trail guarded by a live grant, no app DELETE, database
// clock) are pinned on the migration text. The behaviour is proven live in S4's suite (test:m36:break-glass:live).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BREAK_GLASS_DEFAULT_HOURS,
  BREAK_GLASS_JUSTIFICATION_MAX,
  BREAK_GLASS_JUSTIFICATION_MIN,
  BREAK_GLASS_MAX_HOURS,
  BREAK_GLASS_NOTE_MAX,
  BREAK_GLASS_READ_KINDS,
  BREAK_GLASS_REASON_CODES,
  BREAK_GLASS_REVIEW_OUTCOMES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1140_m36_break_glass.sql"));
const schema = flat(read("packages/db/src/schema/messaging/message-break-glass.ts"));
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const TABLES = [
  "message_break_glass_grant",
  "message_break_glass_review",
  "message_break_glass_read",
] as const;

describe("migration 1140 break-glass", () => {
  it("the closed sets and numeric bounds in the SQL CHECKs and the Drizzle CHECKs are the constants", () => {
    expect(sql).toContain(`CHECK ("reason_code" IN (${inList(BREAK_GLASS_REASON_CODES)}))`);
    expect(schema).toContain(`IN (${inList(BREAK_GLASS_REASON_CODES)})`);
    expect(sql).toContain(`CHECK ("outcome" IS NULL OR "outcome" IN (${inList(BREAK_GLASS_REVIEW_OUTCOMES)}))`);
    expect(sql).toContain(`CHECK ("read_kind" IN (${inList(BREAK_GLASS_READ_KINDS)}))`);
    expect(schema).toContain(`IN (${inList(BREAK_GLASS_READ_KINDS)})`);
    const range = `BETWEEN ${BREAK_GLASS_JUSTIFICATION_MIN} AND ${BREAK_GLASS_JUSTIFICATION_MAX}`;
    expect(sql).toContain(range);
    expect(schema).toContain(range);
    const max = `interval '${BREAK_GLASS_MAX_HOURS} hours'`;
    expect(sql).toContain(`"expires_at" <= "granted_at" + ${max}`);
    expect(schema).toContain(max);
    expect(sql).toContain(`char_length("note") <= ${BREAK_GLASS_NOTE_MAX}`);
    expect(BREAK_GLASS_DEFAULT_HOURS).toBeLessThan(BREAK_GLASS_MAX_HOURS);
  });

  it("every table has an org FK, FORCEd RLS on app.org_id and a destruction policy", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`CREATE TABLE "${t}"`);
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY "${t}_org_isolation" ON "${t}" FOR ALL TO chartwarden_app`);
      expect(sql).toContain(`CREATE POLICY "${t}_destruction" ON "${t}" FOR ALL TO chartwarden_destruction`);
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO chartwarden_destruction`);
    }
    expect(sql).toContain("USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)");
  });

  it("the app role never holds DELETE and can change only the revoke and review columns", () => {
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
    expect(sql).toContain('GRANT UPDATE ("revoked_at") ON "message_break_glass_grant" TO chartwarden_app');
    expect(sql).toContain(
      'GRANT UPDATE ("reviewer_user_id", "reviewed_at", "outcome", "note") ON "message_break_glass_review" TO chartwarden_app',
    );
    expect(sql).not.toMatch(/GRANT [^;]*UPDATE[^;(]*ON "message_break_glass_read"/);
    expect(sql).toContain('GRANT SELECT, INSERT ON "message_break_glass_read" TO chartwarden_app');
  });

  it("the grant is insert/revoke-only on the database clock with one open grant per channel and grantee", () => {
    expect(sql).toContain("NEW.granted_at := now()");
    expect(sql).toContain("NEW.revoked_at := now()");
    expect(sql).toContain("message_break_glass_grant_immutable: the only change allowed is ending the grant");
    expect(sql).toContain('CHECK ("expires_at" > "granted_at")');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "message_break_glass_grant_one_open" ON "message_break_glass_grant" ("organization_id", "channel_id", "grantee_user_id") WHERE "revoked_at" IS NULL',
    );
    expect(schema).toContain("message_break_glass_grant_one_open");
  });

  it("a grant cannot commit without its review (deferred constraint trigger)", () => {
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "trg_message_break_glass_grant_has_review"');
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("message_break_glass_grant_unreviewed");
    expect(sql).toContain('CONSTRAINT "message_break_glass_review_grant_unique" UNIQUE ("organization_id", "grant_id")');
  });

  it("the reviewer is never the grantee, the review is completed once and only after the grant ends", () => {
    expect(sql).toContain("NEW.reviewer_user_id IS NOT DISTINCT FROM v_grantee");
    expect(sql).toContain("message_break_glass_review_self");
    expect(sql).toContain("message_break_glass_review_done: a completed review cannot be changed");
    expect(sql).toContain("message_break_glass_review_open: the grant has not ended");
    expect(sql).toContain("NEW.reviewed_at := now()");
    // coalesce: a NULL note makes the bare comparison NULL, which a CHECK treats as passing (found by the live suite).
    expect(sql).toContain(
      'CHECK ("outcome" IS DISTINCT FROM \'concern\' OR coalesce(char_length(btrim("note")), 0) > 0)',
    );
  });

  it("a read is recorded only against a live grant held by the reader", () => {
    expect(sql).toContain("g.revoked_at IS NULL AND g.expires_at > now()");
    expect(sql).toContain("g.grantee_user_id = nullif(current_setting('app.user_id', true), '')::uuid");
    expect(sql).toContain("NEW.read_at := now()");
  });

  it("every guard is SECURITY INVOKER (cross-org probes see nothing) and the audit functions leave the free text out", () => {
    for (const fn of [
      "message_break_glass_grant_guard",
      "message_break_glass_review_guard",
      "message_break_glass_grant_has_review",
      "message_break_glass_read_guard",
    ]) {
      expect(sql).toMatch(new RegExp(`${fn}\\(\\) RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER`));
    }
    expect(sql).toContain("to_jsonb(NEW) - 'justification'");
    expect(sql).toContain("to_jsonb(NEW) - 'note'");
    expect(sql).toContain("OWNER TO chartwarden_audit_writer");
    for (const t of TABLES) expect(sql).toContain(`CREATE TRIGGER "trg_audit_${t}"`);
  });

  it("the permissions are seeded and granted to existing roles, with no aides or lpn on invoke", () => {
    expect(sql).toContain("'messaging.break_glass.invoke', 'message_break_glass', 'invoke', 'compliance', 'none'");
    expect(sql).toContain("'messaging.break_glass.review', 'message_break_glass', 'review', 'compliance', 'none'");
    const invokeBlock =
      /SELECT r\."organization_id", r\."id", 'messaging\.break_glass\.invoke' FROM "role" r WHERE r\."key" IN \(([^)]*)\)/.exec(
        sql,
      );
    expect(invokeBlock).not.toBeNull();
    const keys = (invokeBlock?.[1] ?? "").split(",").map((k) => k.trim().replace(/'/g, ""));
    for (const banned of ["lpn", "msw", "chaplain", "chha", "aide", "hospice_aide", "home_health_aide", "compliance_officer"]) {
      expect(keys).not.toContain(banned);
    }
    for (const needed of ["administrator", "org_admin", "rn", "medical_director", "director_of_nursing"]) {
      expect(keys).toContain(needed);
    }
  });

  it("the manifest (.ts and .cjs) owns all three tables", () => {
    for (const f of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      const m = read(f);
      for (const t of TABLES) expect(m, `${f} ${t}`).toContain(`"${t}"`);
    }
  });
});
