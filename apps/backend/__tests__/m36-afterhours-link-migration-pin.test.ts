// ADR-0082 slice S1 - migration 1132, the Drizzle schema, the manifest and the @chartwarden/types constants agree. The structural promises
// (FORCEd org RLS, UNIQUE message, the once-only update guard, no M19 FK, index-covered FKs) are asserted on the SQL text; the live
// suite proves the same rules against a real database as wardenx_app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@chartwarden/db";
import {
  ACK_REQUESTS_FLAG_KEY,
  AFTERHOURS_TRIAGE_FLAG_KEY,
  AFTERHOURS_TRIAGE_OUTCOMES,
  AFTERHOURS_TRIAGE_REQUIRED_FLAG_KEYS,
  ROLE_SEND_FLAG_KEY,
  URGENT_CLINICAL_FLAG_KEY,
} from "@chartwarden/types";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sql = read("packages/db/migrations/1132_m36_afterhours_triage_link.sql");
const flat = sql.replace(/\s+/g, " ");
const T = '"message_afterhours_triage_link"';

describe("migration 1132 message_afterhours_triage_link", () => {
  it("has exactly the frozen columns", () => {
    const cols = getTableConfig(schema.messageAfterhoursTriageLinks).columns.map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "organization_id",
      "message_id",
      "request_id",
      "source_outbox_event_id",
      "triage_call_id",
      "outcome",
      "created_at",
    ]);
    expect(flat).toContain('"source_outbox_event_id" uuid NOT NULL');
    expect(flat).toContain('"triage_call_id" uuid,');
    expect(flat).toContain('"outcome" text,');
  });

  it("pins the outcome list to the TypeScript constant", () => {
    const quoted = AFTERHOURS_TRIAGE_OUTCOMES.map((o) => `'${o}'`).join(", ");
    expect(flat).toContain(`"outcome" IN (${quoted})`);
  });

  it("makes message_id and the source event UNIQUE and covers the request FK with an index", () => {
    expect(flat).toContain('UNIQUE ("message_id")');
    expect(flat).toContain('UNIQUE ("source_outbox_event_id")');
    expect(flat).toContain(`ON ${T} ("organization_id", "request_id")`);
    const cfg = getTableConfig(schema.messageAfterhoursTriageLinks);
    expect(cfg.uniqueConstraints.map((u) => u.name).sort()).toEqual([
      "message_afterhours_triage_link_event_uq",
      "message_afterhours_triage_link_message_uq",
    ]);
  });

  it("references no M19 table and no outbox row", () => {
    expect(sql.match(/REFERENCES "([a-z_]+)"/g)).toEqual([
      'REFERENCES "organization"',
      'REFERENCES "message_acknowledgment_request"',
    ]);
  });

  it("enables AND forces RLS on the app.org_id GUC, for wardenx_app, with a WITH CHECK", () => {
    expect(flat).toContain(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
    expect(flat).toContain(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
    expect(flat).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    expect(flat).toContain(
      "WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    expect(flat).toContain(`GRANT SELECT, INSERT ON ${T} TO wardenx_app`);
    expect(flat).toContain(`GRANT UPDATE ("triage_call_id", "outcome") ON ${T} TO wardenx_app`);
  });

  it("guards the update: identity fixed, outcome once, and carries the audit trigger", () => {
    expect(flat).toContain("NEW.message_id <> OLD.message_id");
    expect(flat).toContain("NEW.source_outbox_event_id <> OLD.source_outbox_event_id");
    expect(flat).toContain("IF OLD.outcome IS NOT NULL THEN");
    expect(flat).toContain(`BEFORE UPDATE ON ${T}`);
    expect(flat).toContain("EXECUTE FUNCTION wardenx_audit_trigger()");
  });

  it("is not a different ordinal and the manifest owns the table in the .ts and the .cjs", () => {
    for (const p of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      expect(read(p)).toContain('"message_afterhours_triage_link"');
    }
  });
});

describe("after-hours triage flag constants", () => {
  it("names the flag and chains the four required flags", () => {
    expect(AFTERHOURS_TRIAGE_FLAG_KEY).toBe("messaging.afterhours_triage");
    expect([...AFTERHOURS_TRIAGE_REQUIRED_FLAG_KEYS].sort()).toEqual(
      [
        ROLE_SEND_FLAG_KEY,
        ACK_REQUESTS_FLAG_KEY,
        URGENT_CLINICAL_FLAG_KEY,
        "messaging.sbar",
      ].sort(),
    );
  });
});
