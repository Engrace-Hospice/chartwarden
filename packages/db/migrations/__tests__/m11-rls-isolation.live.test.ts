/**
 * M11 Orders — RLS cross-tenant denial: the LIVE Postgres proof (§3.6 / ADR-0010).
 *
 * M11's pure suites exercise the order-machine, verbal-48h-timer, standing-order spawn and cosign logic but
 * never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This applies the real migrations to a real Postgres and drives the policies
 * as the unprivileged `wardenx_app` role (no BYPASSRLS), covering all SEVEN org-scoped M11 tables.
 *
 * The one that makes this worth more than a checkbox:
 *   • `order_record` is the clinical order of record — a lab, DME, level-of-care change or recertification a
 *     physician signs and the agency acts on. A cross-tenant write would let one tenant manufacture a signed
 *     order against another org's patient; a cross-tenant read discloses another org's active orders. It is
 *     also the §3.6/§3.7 RANGE-partitioned table: the parent carries the org policy and the row-triggers, and
 *     every monthly partition leaf inherits both (PG11+ propagates ENABLE ROW LEVEL SECURITY + FOR EACH ROW
 *     triggers to partitions), so the sweep drives the parent and the leaves are protected transitively.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m11` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
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
/** M11's actor columns (`drafter_membership_id`, `signer_membership_id`, `recording_membership_id`,
 * `updated_by_membership_id`) carry real FKs to `membership`, so each org seeds its own. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id / ordering_physician_mdm_id are NOT NULL but carry NO SQL FK — literals fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  standingOrder: string;
  orderRecord: string;
  orderSignature: string;
  verbalOrder: string;
  standingOrderInstance: string;
  orderDiscontinuation: string;
  orderVerbalPolicy: string;
  orderIdgApplication: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "standing_order", key: "standingOrder" },
  // order_record is RANGE-partitioned (§3.6/§3.7); the org policy + row-triggers live on the parent and
  // propagate to every monthly partition leaf, so it stays in both the sweep and the policy count.
  { table: "order_record", key: "orderRecord" },
  { table: "order_signature", key: "orderSignature" },
  { table: "verbal_order", key: "verbalOrder" },
  { table: "standing_order_instance", key: "standingOrderInstance" },
  { table: "order_discontinuation", key: "orderDiscontinuation" },
  { table: "order_verbal_policy", key: "orderVerbalPolicy" },
  { table: "order_idg_decision_application", key: "orderIdgApplication" },
];

describe.skipIf(!DB_URL)("M11 Orders — RLS cross-tenant denial — LIVE Postgres (§3.6)", () => {
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

  /** Seed one full M11 orders chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;

    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M11${n}`, `M11 Provider ${n}`, `NPI-M11${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M11${n}`],
      )
    ).rows[0].id as string;

    const standingOrder = (
      await db.query(
        `INSERT INTO standing_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, kind, kind_version, template_data, cadence, effective_from, ordering_physician_mdm_id)
         VALUES ($1,$2,$3,$4,$5,'dme','v1','{}'::jsonb,'weekly', now(), $6) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    // kind='dme' (not 'lab') so the BEFORE-INSERT lab-initial-states trigger is a no-op; replaces_order_id
    // left null so the correction-supersede trigger does not fire.
    const orderRecord = (
      await db.query(
        `INSERT INTO order_record (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           kind, kind_version, data, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
         VALUES ($1,$2,$3,$4,$5,'dme','v1','{}'::jsonb,$6,'rn',$7) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    // signature_kind='cosignature' so the AFTER-INSERT apply-to-target trigger (which fires only for the
    // primary 'signature') stays inert and the order_record status is not mutated by seeding.
    const orderSignature = (
      await db.query(
        `INSERT INTO order_signature (organization_id, provider_entity_id, location_id, target_kind, target_id,
           signature_kind, signer_membership_id, signer_discipline)
         VALUES ($1,$2,$3,'order',$4,'cosignature',$5,'rn') RETURNING id`,
        [org, providerEntity, location, orderRecord, membership],
      )
    ).rows[0].id as string;

    // target_kind='medication_order' so verbal_order_set_target_pending (which RAISES unless the linked
    // order is in pending_signature) does not fire against our draft order_record.
    const verbalOrder = (
      await db.query(
        `INSERT INTO verbal_order (organization_id, provider_entity_id, location_id, target_kind, target_id,
           recording_membership_id, ordering_physician_mdm_id, verbal_attestation, received_at, deadline_at,
           deadline_policy_version)
         VALUES ($1,$2,$3,'medication_order',$4,$5,$6,'read back', now(), now() + interval '48 hours','v1')
         RETURNING id`,
        [org, providerEntity, location, orderRecord, membership, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    const standingOrderInstance = (
      await db.query(
        `INSERT INTO standing_order_instance (organization_id, provider_entity_id, location_id,
           standing_order_id, order_record_id, spawned_by)
         VALUES ($1,$2,$3,$4,$5,'system') RETURNING id`,
        [org, providerEntity, location, standingOrder, orderRecord],
      )
    ).rows[0].id as string;

    const orderDiscontinuation = (
      await db.query(
        `INSERT INTO order_discontinuation (organization_id, provider_entity_id, location_id, order_record_id,
           reason, effective_at)
         VALUES ($1,$2,$3,$4,'clinical_judgement', now()) RETURNING id`,
        [org, providerEntity, location, orderRecord],
      )
    ).rows[0].id as string;

    const orderVerbalPolicy = (
      await db.query(
        `INSERT INTO order_verbal_policy (organization_id, provider_entity_id, location_id,
           updated_by_membership_id)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [org, providerEntity, location, membership],
      )
    ).rows[0].id as string;

    const orderIdgApplication = (
      await db.query(
        `INSERT INTO order_idg_decision_application
           (organization_id, idg_decision_id, order_ids)
         VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [org, `7777777${n}-7777-4777-8777-777777777777`, JSON.stringify([orderRecord])],
      )
    ).rows[0].id as string;

    return {
      membership,
      providerEntity,
      location,
      standingOrder,
      orderRecord,
      orderSignature,
      verbalOrder,
      standingOrderInstance,
      orderDiscontinuation,
      orderVerbalPolicy,
      orderIdgApplication,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m11-actor@x.test')`, [USER]);
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

  it("every M11 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = [
      "0037_orders_m11_rls_audit_triggers.sql",
      "0168_idg_downstream_consumer_projections.sql",
    ]
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
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

  it("a WITH CHECK refuses an order_record forged into another tenant's organization", async () => {
    // order_record is the signed clinical order of record — a cross-tenant write would let one tenant
    // manufacture an order against another org's patient. The row is tagged organization_id = ORG_A while
    // the session is org B; the WITH CHECK must reject it even though the FK targets (provider/location/
    // membership) are org A's real rows.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO order_record (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, kind, kind_version, data, drafter_membership_id, drafter_discipline,
             ordering_physician_mdm_id)
           VALUES ($1,$2,$3,$4,$5,'dme','v1','{}'::jsonb,$6,'rn',$7)`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, a.membership, PHYSICIAN_MDM],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's order_record (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE order_record SET status='discontinued' WHERE id=$1", [a.orderRecord]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM order_record WHERE id=$1", [a.orderRecord]);
    expect(still.rows[0].status).toBe("draft");
  });

  it("the M4 write-audit trigger fired for the order_record writes (§3.8)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'order_record'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
