// WP 5.6 - migration 1159 and the Drizzle schema agree: the approved count is immutable once the certificate leaves pending, the spend lives in
// its own columns, and the destruction credential can only READ the certificate. Behaviour is proved live in m36-retention-destruction.live.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1159_m4_destruction_certificate_spend.sql"));
const schema = flat(read("packages/db/src/schema/destruction-certificates.ts"));

describe("migration 1159 destruction certificate spend", () => {
  it("adds the two spend columns beside record_count, in SQL and in Drizzle", () => {
    expect(sql).toContain('ADD COLUMN "destroyed_count" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('ADD COLUMN "reserved_count" integer DEFAULT 0 NOT NULL');
    expect(schema).toContain('destroyedCount: integer("destroyed_count").notNull().default(0)');
    expect(schema).toContain('reservedCount: integer("reserved_count").notNull().default(0)');
  });

  it("keeps the spend within the approved count and non-negative (CHECKs)", () => {
    expect(sql).toContain('CHECK ("destroyed_count" >= 0 AND "reserved_count" >= 0)');
    expect(sql).toContain('CHECK ("destroyed_count" + "reserved_count" <= "record_count")');
  });

  it("the guard freezes record_count once the certificate leaves pending and lets destroyed_count only rise", () => {
    expect(sql).toContain(
      "IF OLD.status <> 'pending' AND NEW.record_count IS DISTINCT FROM OLD.record_count AND (OLD.data_class LIKE 'message.%' OR NEW.status = OLD.status) THEN",
    );
    expect(sql).toContain("IF NEW.destroyed_count < OLD.destroyed_count THEN");
    expect(sql).toContain(
      'CREATE TRIGGER "trg_destruction_certificate_count_guard" BEFORE UPDATE ON "destruction_certificate"',
    );
    expect(sql).toContain("SECURITY INVOKER");
  });

  it("the destruction credential gets SELECT only, org-pinned, and nothing else on the table", () => {
    expect(sql).toContain('GRANT SELECT ON "destruction_certificate" TO chartwarden_destruction');
    expect(sql).toContain("FOR SELECT TO chartwarden_destruction");
    expect(sql).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    expect(sql).not.toMatch(/GRANT [^;]*(UPDATE|INSERT|DELETE)[^;]*TO chartwarden_destruction/);
  });

  it("the executor never writes record_count", () => {
    const src = read("apps/backend/src/modules/04-audit/messaging-hold-workflow.ts");
    expect(src).not.toMatch(/set\(\{[^}]*recordCount/);
    expect(src).not.toContain("record_count -");
  });
});
