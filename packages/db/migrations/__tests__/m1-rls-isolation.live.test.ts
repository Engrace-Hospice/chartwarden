/**
 * M1 Foundation — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M1 is the partitioned schema + gate LAYER: it owns the tenancy spine (organization / user /
 * membership), the platform-shared registries, and the transactional mechanism tables (idempotency,
 * outbox, feature flags). Its scoping is deliberately MIXED — some tables belong to a tenant, some
 * are global by design — so a blanket "everything is org-scoped" sweep would be wrong. This suite
 * applies the real migrations to a real Postgres and drives ONLY the genuinely org-scoped tables as
 * the unprivileged `wardenx_app` role (no BYPASSRLS), proving cross-tenant reads/writes are refused.
 *
 * The one invariant that makes this worth more than a checkbox is M01-F06a: a tenant connection may
 * READ a platform-global (org-NULL) feature flag but may never WRITE one. A hole here would let one
 * tenant forge or flip a GLOBAL kill-switch — a platform-wide outage triggered from a single org.
 *
 * COVERED (org_id + a tenant RLS policy): provider_entity, location (scoped via its provider_entity),
 * membership, feature_flag, feature_flag_evaluation, idempotency_key, outbox_event.
 * EXCLUDED and why:
 *   • organization  — the tenancy ROOT; its policy keys on `id`, not `organization_id` (it is not a
 *                     row that "belongs to" a tenant, it IS the tenant).
 *   • user / session / account / verification — a user spans orgs; deliberately un-RLS'd (0001 comment),
 *                     org context is applied at the app layer.
 *   • audit_event   — append-only audit SINK: read-only to tenants (no WITH CHECK / tenant write path);
 *                     its cross-tenant isolation is asserted by the audit-trigger test below.
 *   • system_status — a single platform-status row, no organization_id.
 *   • organization_settings_registry / outbox_event_catalog — global platform CATALOGS, no organization_id.
 * No COVERED table is partitioned (only audit_event is, and it is excluded), so the 0118 partition-leaf
 * RLS has no covered leaf to seed here.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m1` (SUPERUSER to a THROWAWAY
 *     db; for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `membership.user_id` carries a real FK to `user`; one seeded user memberships into both orgs
 * (the unique index on (user_id, organization_id) permits one per org). */
const USER = "33333333-3333-3333-3333-333333333333";

type SeedIds = {
  providerEntity: string;
  location: string;
  membership: string;
  featureFlag: string;
  featureFlagEvaluation: string;
  idempotencyKey: string;
  outboxEvent: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "provider_entity", key: "providerEntity" },
  { table: "location", key: "location" },
  { table: "membership", key: "membership" },
  { table: "feature_flag", key: "featureFlag" },
  { table: "feature_flag_evaluation", key: "featureFlagEvaluation" },
  { table: "idempotency_key", key: "idempotencyKey" },
  { table: "outbox_event", key: "outboxEvent" },
];

/** The M1 tenant RLS lives across MORE than one file (unlike a single-module migration): the spine +
 * mechanism policies in 0001, the feature_flag global-read exception in 0002, and the
 * feature_flag_evaluation policies retro-added in 0120. The policy assertion scans all three. */
const RLS_FILES = [
  "0001_foundation_rls_roles_partitioning.sql",
  "0002_feature_flag_global_read.sql",
  "0120_foundation_feature_flag_evaluation_rls.sql",
];

describe.skipIf(!DB_URL)("M1 Foundation — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M1 foundation slice for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M1${n}`, `M1 Provider ${n}`, `NPI-M1${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M1${n}`],
      )
    ).rows[0].id as string;

    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;

    const featureFlag = (
      await db.query(
        `INSERT INTO feature_flag (organization_id, flag_key, value_type, value)
         VALUES ($1,$2,'bool','true'::jsonb) RETURNING id`,
        [org, `flag-m1-${n}`],
      )
    ).rows[0].id as string;

    const featureFlagEvaluation = (
      await db.query(
        `INSERT INTO feature_flag_evaluation (flag_id, organization_id, user_id, evaluated_value)
         VALUES ($1,$2,$3,'true'::jsonb) RETURNING id`,
        [featureFlag, org, USER],
      )
    ).rows[0].id as string;

    const idempotencyKey = (
      await db.query(
        `INSERT INTO idempotency_key (organization_id, key, request_hash, response_status, response_body, expires_at)
         VALUES ($1,$2,'hash','200','{}'::jsonb, now() + interval '1 day') RETURNING id`,
        [org, `idem-m1-${n}`],
      )
    ).rows[0].id as string;

    const outboxEvent = (
      await db.query(
        `INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
         VALUES ($1,'m1.seeded','provider_entity',$2,'{}'::jsonb) RETURNING id`,
        [org, providerEntity],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      membership,
      featureFlag,
      featureFlagEvaluation,
      idempotencyKey,
      outboxEvent,
    };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m1-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M1 tenant RLS policy keys ONLY on app.org_id, and no WRITE admits a NULL org", async () => {
    // M1's policies are heterogeneous — a single FOR ALL block (provider_entity, membership,
    // idempotency_key, outbox_event), a provider_entity SUBQUERY (location), and split per-command
    // policies with a deliberate org-NULL READ exception (feature_flag, feature_flag_evaluation). The
    // invariant that must hold across all of them: the only session var is app.org_id, no pg_has_role
    // escape — and the org-NULL branch is confined to READ, never a WITH CHECK (M01-F06a).
    const rls = RLS_FILES.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?;/g) ?? []).filter((b) =>
      COVERED.some((t) => b.includes(`ON "${t.table}"`)),
    );
    // Every covered table carries at least one tenant policy.
    for (const { table } of COVERED) {
      expect(policyBlocks.some((b) => b.includes(`ON "${table}"`))).toBe(true);
    }
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(vars.length).toBeGreaterThan(0);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      // The org-NULL escape is a READ-only exception; a tenant WITH CHECK must never admit it.
      const withCheck = block.match(/WITH CHECK \(([\s\S]*?)\)\s*;\s*$/);
      if (withCheck) expect(withCheck[1]).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses a provider_entity forged into another tenant's org", async () => {
    // provider_entity carries the CCN/NPI — the Medicare billing identity. A cross-tenant write would
    // let one tenant manufacture a provider record under another org's tenancy.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-FORGE','Forged','NPI-FORGE','enc','12-31')`,
          [ORG_A],
        ),
      ),
    ).rejects.toThrow();
  });

  it("a tenant context cannot WRITE a GLOBAL (org-NULL) feature flag (M01-F06a)", async () => {
    // Named separately because the failure mode is categorically worse than a same-shape leak: a
    // GLOBAL flag/kill-switch belongs to no tenant and reaches every tenant. The WITH CHECK is a
    // plain `=`, which yields NULL (not true) for a null org and therefore refuses it — so a tenant
    // can neither forge nor flip a platform-wide switch. A tenant may still READ global flags.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value)
           VALUES (NULL,'global-kill','kill_switch','bool','true'::jsonb)`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's provider_entity (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE provider_entity SET status='active' WHERE id=$1", [a.providerEntity]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM provider_entity WHERE id=$1", [a.providerEntity]);
    expect(still.rows[0].status).toBe("created");
  });

  it("the M4 write-audit trigger fired for the provider_entity writes (§3.8)", async () => {
    // resource_kind is TG_TABLE_NAME from wardenx_audit_trigger() (0004). provider_entity is audited;
    // idempotency_key / outbox_event are attached-but-no-op (hot-path skip), so provider_entity is the
    // right probe for a live audit row.
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'provider_entity'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
