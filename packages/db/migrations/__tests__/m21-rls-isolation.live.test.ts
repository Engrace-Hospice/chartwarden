/**
 * M21 Supplies / DME / Comfort Kits — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §9.3 /
 * ADR-0010).
 *
 * The pure suites (apps/backend/__tests__/m21-*.test.ts, packages/supplies) exercise the §2.2 fulfillment
 * machine, the D4 routing ladder, the D8 discrepancy math and the §4.1 authz composition, but they never
 * touch a database — so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant
 * that leaks across tenants. This test applies the real migrations to a real Postgres and exercises the
 * policies as the unprivileged `chartwarden_app` role.
 *
 * `chartwarden_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies every
 * assertion below vacuously. That is asserted FIRST, before a single isolation case runs.
 *
 * M21 IS THREE POLICY SHAPES, NOT ONE, and each needs a different proof (§3.5):
 *
 *   1. **Eight canonical org-scoped tables** — `FOR ALL` on `organization_id = current_setting('app.org_id')`.
 *      Ordinary cross-tenant denial.
 *   2. **Three floor-plus-overlay tables** (`comfort_kit_template`, `comfort_kit_template_medication`,
 *      `vendor_routing_rule`) — the platform row is org-less and readable inside EVERY tenant, while a
 *      tenant's own rows stay isolated. Split by COMMAND on purpose: two permissive `FOR ALL` policies on
 *      one table would OR together, which is the shape ADR-0010 D3 forbids. So the proof is two-sided —
 *      the floor is visible to both tenants AND neither can write it.
 *   3. **`supply_item`** — genuinely org-less (D11 platform catalog): read-all restricted to active rows,
 *      writes only through `chartwarden_admin`. "Every tenant sees it" is the CORRECT outcome here, and the
 *      control that matters is the absence of a write grant.
 *
 * Two structural facts get their own cases:
 *   • `supply_request` and `comfort_kit_dispatch` are PARTITIONED. Policies and grants are declared on the
 *     parent only. A leaf addressed BY NAME is governed by its own flags — `CREATE TABLE … PARTITION OF`
 *     gives a leaf neither the parent's policies nor the parent's ACL — so the leaf's real defense is the
 *     GRANT layer, and that is what is asserted (the M16-T07 lesson: a leaf-`relrowsecurity` assertion
 *     would pass only by accident).
 *   • `comfort_kit_dispatched_content` is the DEA 21 CFR §1304 outbound log and carries SELECT + INSERT
 *     only. A dispatched line is a historical fact about what physically left the hub; a correction is a
 *     new return-reconciliation row, never an edit. Withholding UPDATE makes that a permission error
 *     rather than a code-review convention, so the missing grant is proved.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m21` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector**: the chain declares COLUMNS of type `vector`, so stripping the
 *     extension DDL cannot make a plain image work. Use `pgvector/pgvector:pgNN`.
 *   - Raise `max_locks_per_transaction` (512 is ample) — `DROP SCHEMA public CASCADE` takes one lock per
 *     relation and the chain's partitioned tables put the default 64 well out of reach.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** A membership sentinel — M21 stores membership ids without a cross-module FK (M2 owns that table). */
const MEMBERSHIP = "00000000-0000-0000-0000-000000000000";
/** The §3.1.12 platform-floor template seeded by migration 0103 on a fixed id. */
const FLOOR_TEMPLATE = "00000000-0021-0000-0000-000000000001";

type SeedIds = {
  pe: string;
  location: string;
  tenantItem: string;
  template: string;
  templateMed: string;
  routingRule: string;
  parStock: string;
  request: string;
  dispatch: string;
  dispatchedContent: string;
  ret: string;
  returnedContent: string;
};

/** The 10 org-scoped M21 tables, each with the seeded row the isolation case looks for. `supply_item` is
 *  absent by design: it has no organization_id at all, and its own case proves the org-less contract. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "tenant_supply_item_extension", key: "tenantItem" },
  { table: "comfort_kit_template", key: "template" },
  { table: "comfort_kit_template_medication", key: "templateMed" },
  { table: "vendor_routing_rule", key: "routingRule" },
  { table: "par_stock", key: "parStock" },
  { table: "supply_request", key: "request" },
  { table: "comfort_kit_dispatch", key: "dispatch" },
  { table: "comfort_kit_dispatched_content", key: "dispatchedContent" },
  { table: "comfort_kit_return", key: "ret" },
  { table: "comfort_kit_returned_content", key: "returnedContent" },
];

/** All 11 manifest-owned tables — the RLS-enabled and no-DELETE-grant assertions cover every one. */
const ALL_TABLES = ["supply_item", ...COVERED.map((c) => c.table)];

describe.skipIf(!DB_URL)("M21 Supplies — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE chartwarden_app");
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
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M21 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const patient = `4444444${n}-4444-4444-4444-444444444444`;
    const admission = `5555555${n}-5555-5555-5555-555555555555`;
    const deployment = `6666666${n}-6666-6666-6666-666666666666`;
    const pe = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Supply Hub','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    const tenantItem = (
      await db.query(
        `INSERT INTO tenant_supply_item_extension (organization_id, name, local_sku_code, default_unit)
         VALUES ($1,'Agency wound kit','LOCAL-${n}','each') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    // A TENANT template: org-bearing and NOT the floor (the CHECK pair makes the other combination
    // impossible, which is what keeps a nullable organization_id safe).
    const template = (
      await db.query(
        `INSERT INTO comfort_kit_template (organization_id, name, is_platform_floor, system_locked)
         VALUES ($1,'Tenant kit v1', false, false) RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const templateMed = (
      await db.query(
        `INSERT INTO comfort_kit_template_medication (template_id, organization_id, is_platform_floor, rxnorm,
           drug_name, strength, dosage_form, route_of_administration, is_controlled_substance,
           controlled_substance_schedule, expected_quantity, expected_unit)
         VALUES ($1,$2,false,'894801','Morphine sulfate','20 mg/mL','solution','oral',true,'CII',30,'mL')
         RETURNING id`,
        [template, org],
      )
    ).rows[0].id as string;
    // `tenant` scope carries no target and MUST carry an org (§3.1.5's platform-scope CHECK).
    const routingRule = (
      await db.query(
        `INSERT INTO vendor_routing_rule (organization_id, scope_kind, assigned_fulfillment_mode,
           precedence_priority)
         VALUES ($1,'tenant','internal_supply_hub',100) RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const parStock = (
      await db.query(
        `INSERT INTO par_stock (organization_id, provider_entity_id, location_id, tenant_sku_extension_id,
           current_quantity, unit, reorder_point, reorder_quantity, min_safety_stock)
         VALUES ($1,$2,$3,$4, 12,'each', 10, 25, 5) RETURNING id`,
        [org, pe, location, tenantItem],
      )
    ).rows[0].id as string;
    // `requested` keeps the routing-frozen CHECK satisfied without a resolved routing record.
    const request = (
      await db.query(
        `INSERT INTO supply_request (organization_id, patient_id, admission_id, location_id,
           provider_entity_id, requested_by_membership_id, kind, data, status)
         VALUES ($1,$2,$3,$4,$5,$6,'comfort_kit_deploy','{"kind":"comfort_kit_deploy"}'::jsonb,'requested')
         RETURNING id`,
        [org, patient, admission, location, pe, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const dispatchRow = (
      await db.query(
        `INSERT INTO comfort_kit_dispatch (supply_request_id, organization_id, patient_id, admission_id,
           location_id, provider_entity_id, comfort_kit_template_id, deployment_site, pharmacy_dispatch_mode,
           dispatch_source, kit_serial_number, dispatched_by_membership_id,
           controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'home','supply_hub_dispatch','supply_hub','KIT-${n}',$8,'digest','[]'::jsonb)
         RETURNING id, dispatched_at`,
        [request, org, patient, admission, location, pe, template, MEMBERSHIP],
      )
    ).rows[0] as { id: string; dispatched_at: Date };
    // A controlled line REQUIRES a lot AND an expiration, and 0106's BEFORE trigger enforces the 14-day
    // floor — so the expiration is a year out rather than "today".
    const dispatchedContent = (
      await db.query(
        `INSERT INTO comfort_kit_dispatched_content (dispatch_id, dispatch_partition_dispatched_at,
           organization_id, provider_entity_id, location_id, comfort_kit_template_medication_id, rxnorm,
           drug_name, strength, dosage_form, route_of_administration, is_controlled_substance,
           controlled_substance_schedule, dispatched_quantity, dispatched_unit, lot_number, expiration_date)
         VALUES ($1,$2,$3,$4,$5,$6,'894801','Morphine sulfate','20 mg/mL','solution','oral',true,'CII',
           30,'mL','LOT-${n}', (now() + interval '365 days')::date) RETURNING id`,
        [dispatchRow.id, dispatchRow.dispatched_at, org, pe, location, templateMed],
      )
    ).rows[0].id as string;
    const ret = (
      await db.query(
        `INSERT INTO comfort_kit_return (dispatch_id, dispatch_partition_dispatched_at, m13_deployment_id,
           organization_id, patient_id, admission_id, provider_entity_id, location_id, return_required_at,
           return_due_at, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now() + interval '30 days', 'requested') RETURNING id`,
        [
          dispatchRow.id,
          dispatchRow.dispatched_at,
          deployment,
          org,
          patient,
          admission,
          pe,
          location,
        ],
      )
    ).rows[0].id as string;
    // The three D8 columns are computed by 0106's trigger from the DISPATCHED line — it fails CLOSED if
    // that line is not visible, which is why this row is seeded as superuser alongside its parent.
    const returnedContent = (
      await db.query(
        `INSERT INTO comfort_kit_returned_content (return_id, dispatched_content_id, organization_id,
           provider_entity_id, location_id, quantity_returned, quantity_disposed_at_home,
           is_controlled_substance, controlled_substance_schedule)
         VALUES ($1,$2,$3,$4,$5, 20, 0, true, 'CII') RETURNING id`,
        [ret, dispatchedContent, org, pe, location],
      )
    ).rows[0].id as string;
    return {
      pe,
      location,
      tenantItem,
      template,
      templateMed,
      routingRule,
      parStock,
      request,
      dispatch: dispatchRow.id,
      dispatchedContent,
      ret,
      returnedContent,
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
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 180_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M21 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0106_supplies_m21_rls_audit_triggers.sql"),
      "utf8",
    );
    const policyBlocks =
      rls.match(/CREATE POLICY[\s\S]*?(?:WITH CHECK \([^;]*\)|USING \([^;]*\));/g) ?? [];
    // 1 org-less read + 1 tenant-item + 3×3 floor-plus-overlay + 6 canonical org policies.
    expect(policyBlocks.length).toBe(17);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
      // `supply_item_read` is org-LESS by design (D11) and names no setting at all; every other policy may
      // name app.org_id and nothing else.
      expect(new Set(vars).size <= 1).toBe(true);
      for (const v of vars) expect(v).toBe("app.org_id");
      expect(block).not.toMatch(/pg_has_role/i);
      // No EXISTS-subquery tenancy: §3.1.4's proposed parent-join policy was replaced by denormalized
      // discriminators precisely so tenancy is never a join (ADR-0010 D2).
      expect(block).not.toMatch(/EXISTS\s*\(/i);
      // The PE / Location narrowing the patient-bearing tables carry is M3 ABAC at the handler, never a
      // second pivot that would OR rather than AND.
      expect(block).not.toMatch(/provider_entity_id\s*=/i);
    }
  });

  it("RLS is ENABLED on every one of the 11 owned tables", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind IN ('r','p')`,
      [ALL_TABLES],
    );
    expect(rows).toHaveLength(ALL_TABLES.length);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
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
      expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
    },
  );

  it("the D11 platform SKU catalog is org-less: BOTH tenants read it, NEITHER may write it", async () => {
    const item = (
      await db.query(
        `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit)
         VALUES ('E0260','Hospital bed, semi-electric','E','each') RETURNING id`,
      )
    ).rows[0].id as string;
    for (const org of [ORG_A, ORG_B]) {
      const seen = await withOrg(org, () =>
        db.query<{ n: number }>("SELECT count(*)::int AS n FROM supply_item WHERE id=$1", [item]),
      );
      expect(seen.rows[0].n).toBe(1); // every tenant resolves the canonical catalog
    }
    // The permission key is the first gate; this grant is the backstop. A catalog write that leaked into a
    // tenant would corrupt every OTHER tenant's SKU list, which is why there are deliberately two.
    const { rows } = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND table_name='supply_item'`,
    );
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["SELECT"]);
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit)
           VALUES ('E0261','Injected bed','E','each')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("the D3 platform-floor template is readable inside EVERY tenant and writable by none", async () => {
    for (const org of [ORG_A, ORG_B]) {
      const seen = await withOrg(org, () =>
        db.query<{ n: number }>("SELECT count(*)::int AS n FROM comfort_kit_template WHERE id=$1", [
          FLOOR_TEMPLATE,
        ]),
      );
      expect(seen.rows[0].n).toBe(1);
    }
    // The UPDATE policy's USING clause excludes `is_platform_floor = true`, so this touches zero rows
    // rather than raising — which is the same outcome for the caller and a stronger one for the record.
    const res = await withOrg(ORG_A, () =>
      db.query("UPDATE comfort_kit_template SET name='tampered' WHERE id=$1", [FLOOR_TEMPLATE]),
    );
    expect(res.rowCount).toBe(0);
    const check = await db.query("SELECT name FROM comfort_kit_template WHERE id=$1", [
      FLOOR_TEMPLATE,
    ]);
    expect(check.rows[0].name).toContain("Platform Floor");
  });

  it("a tenant cannot INSERT a platform-floor template or a platform-scope routing rule", async () => {
    // Both are two gates deep: the TypeBox union omits the value AND the WITH CHECK refuses it. This proves
    // the second one, which is the gate that still stands if a route is ever added carelessly.
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO comfort_kit_template (organization_id, name, is_platform_floor)
           VALUES (NULL,'Injected floor', true)`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO vendor_routing_rule (organization_id, scope_kind, assigned_fulfillment_mode)
           VALUES (NULL,'platform','internal_supply_hub')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it.each(["supply_request", "comfort_kit_dispatch"])(
    "%s: a PARTITION cannot be addressed directly by chartwarden_app (the leaf carries no grant)",
    async (parent) => {
      // PostgreSQL applies the PARENT's policy to a query routed THROUGH the parent, but a leaf addressed by
      // name is governed by its own `relrowsecurity` — and `CREATE TABLE … PARTITION OF` gives a leaf neither
      // the parent's policies nor the parent's ACL. So the leaf's protection is the GRANT layer, and that is
      // what has to be asserted: an assertion that leaves inherit RLS would pass only by accident.
      const leaves = await db.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = $1 ORDER BY c.relname`,
        [parent],
      );
      expect(leaves.rows.length).toBeGreaterThan(0); // the DEFAULT plus the 13 seeded monthly leaves

      const granted = await db.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.role_table_grants
         WHERE grantee='chartwarden_app' AND table_name = ANY($1)`,
        [leaves.rows.map((r) => r.relname)],
      );
      expect(granted.rows.map((r) => r.table_name)).toEqual([]);

      const leaf = leaves.rows[0]?.relname as string;
      await expect(
        withOrg(ORG_B, () => db.query(`SELECT 1 FROM ${leaf} LIMIT 1`)),
      ).rejects.toThrow();
    },
  );

  it.each(["supply_request", "comfort_kit_dispatch"])(
    "%s read THROUGH the parent is tenant-scoped across every partition",
    async (parent) => {
      const asA = await withOrg(ORG_A, () =>
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${parent}`),
      );
      const asB = await withOrg(ORG_B, () =>
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${parent}`),
      );
      expect(asA.rows[0].n).toBe(1);
      expect(asB.rows[0].n).toBe(1); // each org sees ONLY its own seeded row
    },
  );

  it("an UPDATE from the wrong tenant touches zero rows (not just an unreadable SELECT)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE supply_request SET status='cancelled' WHERE id=$1", [a.request]),
    );
    expect(res.rowCount).toBe(0);
    const check = await db.query("SELECT status FROM supply_request WHERE id=$1", [a.request]);
    expect(check.rows[0].status).toBe("requested");
  });

  it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO par_stock (organization_id, provider_entity_id, location_id, tenant_sku_extension_id,
             current_quantity, unit)
           VALUES ($1,$2,$3,$4, 1, 'each')`,
          [ORG_A, a.pe, a.location, a.tenantItem], // B tries to write a row scoped to A
        ),
      ),
    ).rejects.toThrow();
  });

  it("the DEA outbound log holds no UPDATE grant — a dispatched line is never edited (§3.5)", async () => {
    const { rows } = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND table_name='comfort_kit_dispatched_content'`,
    );
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE comfort_kit_dispatched_content SET dispatched_quantity = 1 WHERE id=$1", [
          a.dispatchedContent,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("the D8 discrepancy columns are computed by the database, not accepted from the writer", async () => {
    // 30 dispatched − 20 returned − 0 disposed = 10 unaccounted, one third of what went out and well past
    // the D8 threshold. The writer supplied none of these three values; a flag the reconciler could set is
    // one they could clear.
    //
    // `discrepancy_pct` IS A FRACTION IN [0,1], NOT A PERCENTAGE, despite its name — the trigger compares
    // against `0.05` and `replenishment_threshold_pct` carries the same [0,1] CHECK. The scale is asserted
    // here on purpose: this value reaches the wire raw, and a screen that printed 0.05 under a "%" heading
    // would understate a controlled-substance shortfall a hundredfold. The web slice converts it in exactly
    // one place (`fractionAsPct` in supplies-status.ts).
    const { rows } = await db.query<{
      quantity_unaccounted: string;
      discrepancy_pct: string;
      discrepancy_flagged: boolean;
    }>(
      `SELECT quantity_unaccounted, discrepancy_pct, discrepancy_flagged
       FROM comfort_kit_returned_content WHERE id=$1`,
      [a.returnedContent],
    );
    expect(Number(rows[0].quantity_unaccounted)).toBeCloseTo(10, 6);
    expect(Number(rows[0].discrepancy_pct)).toBeCloseTo(1 / 3, 6);
    expect(Number(rows[0].discrepancy_pct)).toBeLessThanOrEqual(1);
    expect(rows[0].discrepancy_flagged).toBe(true);
  });

  it("chartwarden_app holds no DELETE on any M21 table — destruction runs through the eraser (§8.4)", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND privilege_type='DELETE' AND table_name = ANY($1)`,
      [ALL_TABLES],
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
