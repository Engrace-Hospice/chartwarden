/**
 * Migration 1143 — wardenx_* -> chartwarden_* function / event-trigger rename — the LIVE Postgres proof.
 *
 * Applies every migration BEFORE 1143 (the catalog production holds), snapshots every user trigger's bound
 * function and every event trigger, applies 1143, and asserts: the old names are gone, the new ones exist,
 * every previously bound trigger is still bound to the SAME function (by OID, so by renamed name), the
 * audit trigger still writes an audit row, a freshly created partition is still secured by the event
 * trigger, the step-up tighten-only trigger still rejects a loosening write, a re-run is a no-op, and a
 * fresh end-to-end replay (in a second database) lands in the same state.
 *
 * Roles are cluster-global, so run it on a private pgvector container, one database at a time:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:…@host/throwaway bun run test:function-rename:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const RENAME_MIGRATION = "1143_chartwarden_function_rename.sql";
const RENAMES: Readonly<Record<string, string>> = {
  wardenx_audit_trigger: "chartwarden_audit_trigger",
  wardenx_secure_new_partition: "chartwarden_secure_new_partition",
  wardenx_tenant_step_up_tighten_only: "chartwarden_tenant_step_up_tighten_only",
};
const OLD_EVENT_TRIGGER = "wardenx_secure_new_partition_trg";
const NEW_EVENT_TRIGGER = "chartwarden_secure_new_partition_trg";
const LEAF = "audit_event_2098_01";

const sqlFiles = (upTo?: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && (upTo === undefined || f < upTo))
    .sort();

async function replay(db: Client, files: string[]) {
  for (const f of files) await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
}

const bindings = async (db: Client) =>
  (
    await db.query(
      `SELECT tgrelid::regclass::text AS tbl, tgname, tgfoid::regproc::text AS fn, tgenabled
         FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
    )
  ).rows as { tbl: string; tgname: string; fn: string; tgenabled: string }[];

const eventTriggers = async (db: Client) =>
  (
    await db.query(
      "SELECT evtname, evtfoid::regproc::text AS fn, evtenabled FROM pg_event_trigger ORDER BY 1",
    )
  ).rows as { evtname: string; fn: string; evtenabled: string }[];

const wardenxCatalogNames = async (db: Client) =>
  (
    await db.query(
      `SELECT proname AS n FROM pg_proc WHERE proname LIKE 'wardenx%'
       UNION ALL SELECT evtname FROM pg_event_trigger WHERE evtname LIKE 'wardenx%'
       UNION ALL SELECT tgname FROM pg_trigger WHERE tgname LIKE 'wardenx%'
       UNION ALL SELECT relname FROM pg_class WHERE relname LIKE 'wardenx%'`,
    )
  ).rows.map((r) => r.n as string);

describe.skipIf(!DB_URL)("migration 1143 — function / event-trigger rename — LIVE Postgres", () => {
  let db: Client;
  let before: Awaited<ReturnType<typeof bindings>>;
  let eventBefore: Awaited<ReturnType<typeof eventTriggers>>;
  let secdefBefore: unknown;

  const renamed = (fn: string) => RENAMES[fn] ?? fn;
  const fnMeta = async () =>
    (
      await db.query(
        `SELECT prosecdef, proconfig, proowner::regrole::text AS owner, proacl::text AS acl
           FROM pg_proc WHERE proname IN ('wardenx_audit_trigger', 'chartwarden_audit_trigger')`,
      )
    ).rows;

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await replay(db, sqlFiles(RENAME_MIGRATION));
    before = await bindings(db);
    eventBefore = await eventTriggers(db);
    secdefBefore = await fnMeta();
    await db.query(readFileSync(join(MIGRATIONS_DIR, RENAME_MIGRATION), "utf8"));
  }, 900_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined); // the replay test retires this connection itself
  });

  it("starts from the legacy catalog: all three functions bound, one event trigger", () => {
    expect(before.some((b) => b.fn === "wardenx_audit_trigger")).toBe(true);
    expect(before.filter((b) => b.fn === "wardenx_tenant_step_up_tighten_only")).toHaveLength(1);
    expect(eventBefore).toEqual([
      { evtname: OLD_EVENT_TRIGGER, fn: "wardenx_secure_new_partition", evtenabled: "O" },
    ]);
  });

  it("leaves no wardenx-named function, trigger, event trigger or relation behind", async () => {
    expect(await wardenxCatalogNames(db)).toEqual([]);
    for (const nw of Object.values(RENAMES)) {
      const r = await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1", [nw]);
      expect(r.rows[0].n, nw).toBe(1);
    }
  });

  it("keeps EVERY user trigger bound to the same (renamed) function, with the same enabled state", async () => {
    const after = await bindings(db);
    expect(after).toEqual(before.map((b) => ({ ...b, fn: renamed(b.fn) })));
    expect(after.length).toBeGreaterThan(100);
  });

  it("keeps the event trigger (renamed) bound to the renamed function", async () => {
    expect(await eventTriggers(db)).toEqual([
      { evtname: NEW_EVENT_TRIGGER, fn: "chartwarden_secure_new_partition", evtenabled: "O" },
    ]);
  });

  it("keeps the audit function's SECURITY DEFINER / search_path / owner / ACL unchanged", async () => {
    expect(await fnMeta()).toEqual(secdefBefore);
  });

  it("the audit trigger still writes an audit row on insert and update", async () => {
    const id = "00000000-0000-4000-8000-0000000014a3";
    await db.query(
      "INSERT INTO organization (id, slug, legal_name, display_name) VALUES ($1, 'fn-rename', 'FR', 'FR')",
      [id],
    );
    await db.query("UPDATE organization SET display_name = 'FR2' WHERE id = $1", [id]);
    const r = await db.query(
      "SELECT event_type FROM audit_event WHERE resource_kind = 'organization' AND resource_id = $1 ORDER BY created_at, event_type",
      [id],
    );
    expect(r.rows.map((x) => x.event_type)).toEqual(
      expect.arrayContaining(["organization.insert", "organization.update"]),
    );
  });

  it("a partition created after the rename is still secured by the event trigger", async () => {
    await db.query(
      `CREATE TABLE ${LEAF} PARTITION OF audit_event FOR VALUES FROM ('2098-01-01') TO ('2098-02-01')`,
    );
    const r = await db.query(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = $1",
      [LEAF],
    );
    expect(r.rows).toEqual([{ rls: true, forced: true }]);
  });

  it("the step-up tighten-only trigger still rejects a loosening write", async () => {
    const loosen = (maxAge: number, factors: string) =>
      db.query(
        `INSERT INTO tenant_step_up_policy_override (organization_id, operation_key, qualifying_factors,
           max_age_sec, rationale, configured_by_membership_id)
         VALUES (gen_random_uuid(), 'op.fn-rename', ARRAY[${factors}]::step_up_factor[], $1, 'x', gen_random_uuid())`,
        [maxAge],
      );
    await expect(loosen(9999, "'totp'")).rejects.toMatchObject({ code: "23514" });
    await expect(loosen(300, "'totp','sms'")).rejects.toMatchObject({ code: "23514" });
  });

  it("is idempotent: a second run changes nothing", async () => {
    await db.query(readFileSync(join(MIGRATIONS_DIR, RENAME_MIGRATION), "utf8"));
    const rebound = (await bindings(db)).filter((b) => b.tbl !== LEAF);
    expect(rebound).toEqual(before.map((b) => ({ ...b, fn: renamed(b.fn) })));
    expect(await wardenxCatalogNames(db)).toEqual([]);
  });

  it("a fresh end-to-end replay of every migration (second database) lands in the same state", async () => {
    // Roles are cluster-global. Migration 1142 drops the wardenx_destruction alias, so a replay into a SECOND database of
    // a cluster whose roles are already renamed would get a fresh alias that its own policies name, and 1142 would
    // (correctly, per its multi-database caveat) refuse. Retire the database the earlier tests used, and its roles, so
    // this replay starts from the same pre-1139 cluster production's first database did.
    await db.end();
    const u = new URL(DB_URL as string);
    const firstDb = u.pathname.slice(1);
    const maintenance = new URL(u.toString());
    maintenance.pathname = "/postgres";
    const admin = new Client({ connectionString: maintenance.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE ${firstDb} WITH (FORCE)`);
    const stale = await admin.query(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'chartwarden\\_%' OR rolname LIKE 'wardenx\\_%'",
    );
    for (const { rolname } of stale.rows) await admin.query(`DROP ROLE "${rolname}"`);
    const name = `fn_rename_replay_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    u.pathname = `/${name}`;
    const fresh = new Client({ connectionString: u.toString() });
    try {
      await fresh.connect();
      await replay(fresh, sqlFiles());
      expect(await wardenxCatalogNames(fresh)).toEqual([]);
      expect((await eventTriggers(fresh)).map((e) => e.evtname)).toEqual([NEW_EVENT_TRIGGER]);
      const fns = new Set((await bindings(fresh)).map((b) => b.fn));
      expect(fns.has("chartwarden_audit_trigger")).toBe(true);
      expect(fns.has("chartwarden_tenant_step_up_tighten_only")).toBe(true);
      expect([...fns].filter((f) => f.startsWith("wardenx"))).toEqual([]);
    } finally {
      await fresh.end().catch(() => undefined);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 900_000);
});
