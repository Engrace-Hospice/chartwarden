// ADR-0101 - migration 1250, the Drizzle schema, the manifest, the permission mirrors and the code-side constants agree. The structural promises
// (FORCEd RLS on every table, no severity above warn in the database, a secret that is a cipher and never in the audit row, one-way disable,
// a rotation that bumps the generation by one, an event that settles once, no DELETE for the app role, the permission only for compliance and
// admin roles) are pinned on the migration text. Behaviour is proven live (m36-alarm-ingest.live.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALARM_INGEST_ALERT_TYPES,
  ALARM_INGEST_EVENT_STATUSES,
  ALARM_INGEST_MANAGE_PERMISSION,
  ALARM_REQUESTED_SEVERITIES,
  ALARM_SEVERITY_CEILINGS,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1250_m36_alarm_ingest.sql"));
const schema = flat(read("packages/db/src/schema/messaging/alarm-ingest.ts"));
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const TABLES = ["alarm_source", "alarm_source_mapping", "alarm_ingest_event"] as const;

describe("migration 1250 alarm ingest", () => {
  it("the closed sets in the SQL and Drizzle CHECKs are the constants", () => {
    for (const text of [sql, schema]) {
      expect(text).toContain(`IN (${list(ALARM_INGEST_ALERT_TYPES)})`);
      expect(text).toContain(`IN (${list(ALARM_SEVERITY_CEILINGS)})`);
      expect(text).toContain(`IN (${list(ALARM_INGEST_EVENT_STATUSES)})`);
      expect(text).toContain(`IN (${list(ALARM_REQUESTED_SEVERITIES)})`);
    }
  });

  it("nothing above warn can be stored: the effective severity is CHECKed to info or warn", () => {
    expect(sql).toContain(
      `CHECK ("effective_severity" IS NULL OR "effective_severity" IN ('info', 'warn'))`,
    );
    expect(sql).not.toMatch(/"severity_ceiling" IN \([^)]*critical/);
    expect(sql).not.toMatch(/"effective_severity" IN \([^)]*critical/);
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
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO chartwarden_destruction`);
    }
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
    expect(sql).toContain("CREATE TRIGGER \"trg_audit_alarm_source\"");
    expect(sql).toContain("CREATE TRIGGER \"alarm_source_mapping_audit\"");
    expect(sql).toContain("CREATE TRIGGER \"alarm_ingest_event_audit\"");
  });

  it("the child tables hang off the source by a composite (organization, id) key", () => {
    expect(sql).toContain('CONSTRAINT "alarm_source_org_id_uq" UNIQUE ("organization_id", "id")');
    expect(sql).toContain(
      'FOREIGN KEY ("organization_id", "source_id") REFERENCES "alarm_source"("organization_id", "id") ON DELETE CASCADE',
    );
    expect(schema).toContain("alarm_source_mapping_source_fk");
    expect(schema).toContain("alarm_ingest_event_source_fk");
  });

  it("the secret is a sealed cipher, never a hash or plain text, and the audit row omits it", () => {
    expect(sql).toContain('"secret_cipher" bytea NOT NULL');
    expect(sql).not.toMatch(/"secret" (text|bytea)/);
    expect(sql).toContain("ARRAY['secret_cipher']::text[]");
    expect(sql).not.toContain("alarm_source_audit");
  });

  it("the app role cannot DELETE; a mapping never changes; a source and an event update only their lifecycle columns", () => {
    expect(sql).toContain(
      `GRANT UPDATE ("secret_cipher", "secret_generation", "enabled", "rotated_at", "rotated_by", "disabled_at", "disabled_by", "updated_at") ON "alarm_source" TO chartwarden_app`,
    );
    expect(sql).toContain(
      `GRANT UPDATE ("status", "alert_id", "recipient_count", "updated_at") ON "alarm_ingest_event" TO chartwarden_app`,
    );
    expect(sql).toContain(`GRANT SELECT, INSERT ON "alarm_source_mapping" TO chartwarden_app`);
    expect(sql).not.toMatch(/GRANT UPDATE[^;]*"alarm_source_mapping"/);
  });

  it("the guards: one-way disable, rotation bumps the generation by one on an enabled source, an event settles once forward", () => {
    expect(sql).toContain("a disabled source cannot change; create a new source");
    expect(sql).toContain("a rotation bumps the generation by one, by a person, on an enabled source");
    expect(sql).toContain("the generation changes only with the secret");
    expect(sql).toContain("received settles once");
    expect(sql).toContain("an event is born received or unmapped");
    expect(sql).toContain("NEW.disabled_at := now()");
    expect(sql).toContain("NEW.rotated_at := now()");
    // The guards read no session variable (check-tenancy would refuse a policy-shaped use; none is needed).
    const from = sql.indexOf("CREATE OR REPLACE FUNCTION alarm_source_guard");
    const guards = sql.slice(from, sql.indexOf('ALTER TABLE "alarm_source" ENABLE ROW LEVEL SECURITY'));
    expect(guards.length).toBeGreaterThan(500);
    expect(guards).not.toContain("current_setting");
  });

  it("the idempotency arbiter is a unique index on (organization, source, event id)", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "alarm_ingest_event_one_per_id" ON "alarm_ingest_event" ("organization_id", "source_id", "event_id")',
    );
  });

  it("an event holds no free text: ids, enums, a digest, counts and instants only", () => {
    const table = sql.slice(
      sql.indexOf('CREATE TABLE "alarm_ingest_event"'),
      sql.indexOf('CREATE UNIQUE INDEX "alarm_ingest_event_one_per_id"'),
    );
    const textColumns = [...table.matchAll(/"(\w+)" text(?: NOT NULL| DEFAULT|,)/g)].map((m) => m[1]);
    expect(textColumns.sort()).toEqual(
      [
        "alarm_kind",
        "alert_type",
        "effective_severity",
        "event_id",
        "payload_digest",
        "requested_severity",
        "status",
      ].sort(),
    );
    for (const c of [
      "event_id",
      "payload_digest",
      "alarm_kind",
      "alert_type",
      "status",
      "requested_severity",
      "effective_severity",
    ]) {
      // every text column is pinned by a CHECK shape (a regex or a closed list)
      expect(table, c).toMatch(new RegExp(`CHECK \\("${c}" (~|IN|IS NULL OR)`));
    }
  });

  it("grants the permission to compliance_officer, administrator and org_admin only", () => {
    expect(sql).toContain(
      `('${ALARM_INGEST_MANAGE_PERMISSION}', 'alarm_source', 'manage', 'compliance', 'none', '')`,
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
