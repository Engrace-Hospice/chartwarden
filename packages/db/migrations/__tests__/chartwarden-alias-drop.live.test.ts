/**
 * Migration 1142 — drop of the legacy `wardenx_destruction` alias role — the LIVE Postgres proof.
 *
 * Applies every migration BEFORE 1142 (so the nine applied function bodies still say
 * `pg_has_role(..., 'wardenx_destruction', 'MEMBER')` and the alias exists, as production does), applies 1142,
 * and proves: no function body mentions the alias, the alias role is gone, the rewritten append-only /
 * destruction guards still let chartwarden_destruction DELETE and still refuse chartwarden_app, and a re-run
 * is a no-op.
 *
 * Roles are cluster-global, so run it on a fresh cluster (a private pgvector container), one database at a
 * time:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:…@host/throwaway bun run test:alias-drop:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const DROP_MIGRATION = "1142_chartwarden_alias_drop.sql";
const REWRITTEN = [
  "order_transmission_attestation_append_only",
  "order_recovery_request_guard",
  "hospice_rate_table_guard",
  "tenant_wage_index_guard",
  "sequestration_policy_guard",
  "hospice_visit_charge_schedule_guard",
  "dde_work_event_append_only",
  "m23_is_destruction_role",
  "message_ack_event_append_only",
];
const GUARDS_WITH_TRIGGER_SHAPE = ["message_ack_event_append_only", "dde_work_event_append_only"] as const;

describe.skipIf(!DB_URL)("migration 1142 — wardenx_destruction alias drop — LIVE Postgres", () => {
  let db: Client;
  const run = () => db.query(readFileSync(join(MIGRATIONS_DIR, DROP_MIGRATION), "utf8"));
  const defOf = async (name: string) =>
    (await db.query("SELECT pg_get_functiondef(oid) d FROM pg_proc WHERE proname = $1", [name])).rows[0].d as string;
  const signatures = async () =>
    (await db.query("SELECT oid::regprocedure::text s FROM pg_proc WHERE proname = ANY($1) ORDER BY 1", [REWRITTEN])).rows.map(
      (r) => r.s as string,
    );
  let signaturesBefore: string[];

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < DROP_MIGRATION)
      .sort();
    for (const f of files) await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    signaturesBefore = await signatures();
    await run();
  }, 600_000);

  afterAll(async () => {
    await db?.end();
  });

  it("started from the legacy state: all nine rewritten functions exist", () => {
    expect(signaturesBefore).toHaveLength(REWRITTEN.length);
  });

  it("leaves no function body mentioning wardenx_destruction, and keeps every signature", async () => {
    const stale = await db.query("SELECT proname FROM pg_proc WHERE prosrc LIKE '%wardenx\\_destruction%'");
    expect(stale.rows).toEqual([]);
    expect(await signatures()).toEqual(signaturesBefore);
  });

  it("drops the alias role and its membership", async () => {
    const gone = await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname = 'wardenx_destruction'");
    expect(gone.rows[0].n).toBe(0);
    const chart = await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname = 'chartwarden_destruction'");
    expect(chart.rows[0].n).toBe(1);
  });

  it("collapses the duplicated IN-list entry in message_ack_event_append_only without losing the session_user branch", async () => {
    const d = await defOf("message_ack_event_append_only");
    expect(d).not.toContain("'chartwarden_destruction', 'chartwarden_destruction'");
    expect(d).toContain("pg_has_role(session_user, 'chartwarden_destruction', 'MEMBER')");
    expect(d).toMatch(/SET search_path TO 'pg_catalog', 'public', 'pg_temp'/);
  });

  it("m23_is_destruction_role() is true for chartwarden_destruction and false for chartwarden_app", async () => {
    const as = async (role: string) => {
      await db.query(`SET ROLE ${role}`);
      try {
        return (await db.query("SELECT m23_is_destruction_role() t")).rows[0].t as boolean;
      } finally {
        await db.query("RESET ROLE");
      }
    };
    expect(await as("chartwarden_destruction")).toBe(true);
    expect(await as("chartwarden_app")).toBe(false);
  });

  it.each(GUARDS_WITH_TRIGGER_SHAPE)("%s still permits DELETE for chartwarden_destruction and refuses it for chartwarden_app", async (fn) => {
    const t = `alias_drop_probe_${fn}`;
    await db.query(`CREATE TABLE ${t} (id int PRIMARY KEY)`);
    await db.query(`GRANT SELECT, DELETE ON ${t} TO chartwarden_app, chartwarden_destruction`);
    await db.query(`CREATE TRIGGER t BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await db.query(`INSERT INTO ${t} VALUES (1), (2)`);
      await db.query("SET ROLE chartwarden_app");
      await expect(db.query(`DELETE FROM ${t} WHERE id = 1`)).rejects.toThrow();
      await db.query("RESET ROLE");
      await db.query("SET ROLE chartwarden_destruction");
      const del = await db.query(`DELETE FROM ${t} WHERE id = 1`);
      await db.query("RESET ROLE");
      expect(del.rowCount).toBe(1);
    } finally {
      await db.query("RESET ROLE");
      await db.query(`DROP TABLE ${t}`);
    }
  });

  it("is idempotent (re-run with the alias already gone is a no-op)", async () => {
    const before = await defOf("m23_is_destruction_role");
    await run();
    expect(await defOf("m23_is_destruction_role")).toBe(before);
    expect(await signatures()).toEqual(signaturesBefore);
  });
});
