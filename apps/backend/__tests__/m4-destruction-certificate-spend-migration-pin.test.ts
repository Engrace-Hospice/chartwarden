// WP 5.6 - migration 1159 and the Drizzle schema agree: the approved count is immutable once the certificate leaves pending (one positive audit_event.*
// carve-out), the spend lives in its own columns written only by definer functions, a stranded reservation can be reconciled from a batch row, and
// the destruction credential can only READ the certificate (column-limited). Behaviour is proved live in m36-retention-destruction.live.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1159_m4_destruction_certificate_spend.sql"));
const schema = flat(read("packages/db/src/schema/destruction-certificates.ts"));
const batchSchema = flat(read("packages/db/src/schema/messaging/message-destruction-batches.ts"));

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

  it("the guard: no return to pending, no data_class change, record_count frozen except the one positive audit_event.* transition, destroyed only rises", () => {
    expect(sql).toContain("IF NEW.status = 'pending' THEN");
    expect(sql).toContain("IF NEW.data_class IS DISTINCT FROM OLD.data_class THEN");
    expect(sql).toContain(
      "NEW.record_count IS DISTINCT FROM OLD.record_count AND NOT (OLD.status = 'approved' AND NEW.status IN ('executed', 'partial_refused', 'held') AND OLD.data_class LIKE 'audit_event.%' AND NEW.data_class = OLD.data_class)",
    );
    // L3: a message certificate's count is also frozen on the way OUT of pending
    expect(sql).toContain(
      "OLD.status = 'pending' AND NEW.status <> 'pending' AND OLD.data_class LIKE 'message.%' AND NEW.record_count IS DISTINCT FROM OLD.record_count",
    );
    expect(sql).toContain("IF NEW.destroyed_count < OLD.destroyed_count THEN");
    expect(sql).toContain(
      'CREATE TRIGGER "trg_destruction_certificate_count_guard" BEFORE UPDATE ON "destruction_certificate"',
    );
    // a positive match for audit_event.*: no negative match on message.% anywhere in the guard
    expect(sql).not.toContain("OLD.data_class LIKE 'message.%' OR");
  });

  it("the app role loses table-wide UPDATE and DELETE and keeps only the columns M4 / M34 / the close step write", () => {
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE ON "destruction_certificate" FROM chartwarden_app',
    );
    const grant = /GRANT UPDATE \(([^)]*)\) ON "destruction_certificate" TO chartwarden_app/.exec(
      sql,
    );
    expect(grant).not.toBeNull();
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    for (const forbidden of [
      "destroyed_count",
      "reserved_count",
      "data_class",
      "organization_id",
      "created_at",
    ]) {
      expect(cols).not.toContain(forbidden);
    }
    expect(cols).toEqual(expect.arrayContaining(["status", "executed_at", "record_count"]));
  });

  it("the spend and the batch rows are written only by SECURITY DEFINER functions owned by the admin role that pin the tenant, the class and the ceiling", () => {
    for (const fn of [
      "destruction_certificate_reserve(uuid, uuid, uuid, uuid[])",
      "destruction_certificate_settle(uuid, uuid, integer, text)",
    ]) {
      expect(sql).toContain(`ALTER FUNCTION ${fn} OWNER TO chartwarden_admin`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO chartwarden_app`);
    }
    expect(sql).toContain(
      "p_org IS DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid",
    );
    expect(sql).toContain("data_class LIKE 'message.%'");
    expect(sql).toContain("record_count - destroyed_count - reserved_count >= v_count");
    // reserve writes the batch row and refuses ids an unsettled batch holds; settle is bound to the batch id
    expect(sql).toContain("INSERT INTO public.message_destruction_batch");
    expect(sql).toContain("b.state = 'reserved' AND b.planned_message_ids && p_ids");
    expect(sql).toContain(
      "WHERE id = p_batch AND organization_id = p_org AND state = 'reserved' FOR UPDATE",
    );
    expect(sql).toContain("reserved_count - v_batch.planned_count");
    expect(sql).toContain("AND reserved_count >= v_batch.planned_count");
    // a clamp would hide a double settle: it must be an error
    expect(sql).not.toContain("greatest(reserved_count");
  });

  it("the destruction credential gets column-limited SELECT only, org-pinned, and nothing else on the table", () => {
    const grant =
      /GRANT SELECT \(([^)]*)\) ON "destruction_certificate" TO chartwarden_destruction/.exec(sql);
    expect(grant).not.toBeNull();
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    expect(cols).toEqual(
      expect.arrayContaining(["id", "organization_id", "status", "data_class", "created_at"]),
    );
    expect(cols).not.toContain("approved_by");
    expect(sql).toContain("FOR SELECT TO chartwarden_destruction");
    expect(sql).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
    expect(sql).not.toMatch(/GRANT [^;]*(UPDATE|INSERT|DELETE)[^;]*TO chartwarden_destruction/);
  });

  it("message_destruction_batch: FORCEd org RLS, the app role can only SELECT it, state is monotonic, audited, in the Drizzle schema and the manifest", () => {
    expect(sql).toContain('ALTER TABLE "message_destruction_batch" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT ON "message_destruction_batch" TO chartwarden_app');
    expect(sql).not.toMatch(
      /GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]*"message_destruction_batch" TO chartwarden_app/,
    );
    expect(sql).toContain('REVOKE ALL ON "message_destruction_batch" FROM PUBLIC');
    expect(sql).toContain("IF OLD.state <> 'reserved' THEN");
    expect(sql).toContain('CREATE TRIGGER "trg_message_destruction_batch_guard"');
    expect(sql).toContain('CREATE TRIGGER "trg_audit_message_destruction_batch"');
    expect(batchSchema).toContain('pgTable( "message_destruction_batch"');
    expect(read("architecture/module-manifest.ts")).toContain('"message_destruction_batch",');
    expect(read("architecture/module-manifest.cjs")).toContain('"message_destruction_batch",');
  });

  it("the platform carrier gets a COLUMN grant on the certificate, never the spend columns or data_class", () => {
    const src = read("scripts/db/provision-runtime-roles.ts");
    const list = /DESTRUCTION_CERTIFICATE_PLATFORM_UPDATE_COLUMNS = \[([^\]]*)\]/.exec(src);
    expect(list).not.toBeNull();
    const cols = (list?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    for (const forbidden of ["destroyed_count", "reserved_count", "data_class"]) {
      expect(cols).not.toContain(forbidden);
    }
    expect(src).not.toMatch(/PLATFORM_PROVISION_UPDATE_TABLES = \[[^\]]*"destruction_certificate"/);
  });

  it("the executor never writes record_count", () => {
    const src = read("apps/backend/src/modules/04-audit/messaging-hold-workflow.ts");
    expect(src).not.toMatch(/set\(\{[^}]*recordCount/);
    expect(src).not.toContain("record_count -");
  });
});
