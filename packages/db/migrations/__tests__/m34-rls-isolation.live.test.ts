/**
 * M34 SaaS Tenant Platform — RLS cross-tenant denial: the LIVE Postgres proof (M34 §9.3;
 * M34-F17, ARCH-211, SEC-053, SD-081).
 *
 * §9.3 is the CI gate that proves the canonical `app.org_id` predicate (ADR-0010 / M34-F02) is
 * wired on EVERY tenant-scoped M34 table — cross-tenant-denial tests are not optional. The pure
 * unit suites in packages/saas-tenant-platform exercise the lifecycle/worker orchestration but
 * never touch a database, so they cannot catch a wrong policy predicate, a missing WITH CHECK, or
 * a base-table grant that leaks ciphertext. This test applies the actual migrations to a real
 * Postgres and exercises the policies as the unprivileged `wardenx_app` role (no BYPASSRLS),
 * proving cross-tenant denial for real on all 14 tenant-scoped M34 tables.
 *
 * It covers, under the canonical `organization_id = current_setting('app.org_id')` predicate:
 *   tenant_account · tenant_account_status_event · tenant_invitation · tenant_key_ring (+ the
 *   tenant_key_ring_metadata_v masking view) · tenant_key_destruction_log · onboarding_task ·
 *   support_consent_grant · support_session (+ support_session_event) · dsar_export_job (+
 *   dsar_export_job_event) · tenant_export_job (+ tenant_export_job_event) · platform_tenant_baa_record.
 * Plus the §3.10 lockdown that wardenx_app's SELECT on the tenant_key_ring BASE table is REVOKED
 * (the wrapped-DEK ciphertext is reachable only through the org-filtered metadata view).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live` job provides a postgres service + WARDENX_TEST_DATABASE_URL.
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live`
 * The URL must be a SUPERUSER connection to a THROWAWAY database (the suite drops and recreates
 * the public schema + roles). For a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "mdm_canonical_writer",
  "tenant_platform_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/** Ids of org A's seeded row in each covered table — resolved in beforeAll, read at run time. */
type SeedIds = {
  tenantAccount: string;
  statusEvent: string;
  invitation: string;
  keyRing: string;
  destructionLog: string;
  onboardingTask: string;
  supportGrant: string;
  supportSession: string;
  supportSessionEvent: string;
  dsarJob: string;
  dsarEvent: string;
  exportJob: string;
  exportEvent: string;
  baaRecord: string;
};

// The 13 tenant-scoped tables proven through a direct base-table SELECT under wardenx_app. The
// 14th — tenant_key_ring — is proven separately via its masking view because the base-table SELECT
// is REVOKED from wardenx_app (§3.10). A row's `id` PK uniquely identifies org A's seeded row.
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "tenant_account", key: "tenantAccount" },
  { table: "tenant_account_status_event", key: "statusEvent" },
  { table: "tenant_invitation", key: "invitation" },
  { table: "tenant_key_destruction_log", key: "destructionLog" },
  { table: "onboarding_task", key: "onboardingTask" },
  { table: "support_consent_grant", key: "supportGrant" },
  { table: "support_session", key: "supportSession" },
  { table: "support_session_event", key: "supportSessionEvent" },
  { table: "dsar_export_job", key: "dsarJob" },
  { table: "dsar_export_job_event", key: "dsarEvent" },
  { table: "tenant_export_job", key: "exportJob" },
  { table: "tenant_export_job_event", key: "exportEvent" },
  { table: "platform_tenant_baa_record", key: "baaRecord" },
];

describe.skipIf(!DB_URL)(
  "M34 SaaS Tenant Platform — RLS cross-tenant denial — LIVE Postgres (§9.3)",
  () => {
    let db: Client;
    let a: SeedIds; // org A's seeded ids
    let ringB: string; // org B's key-ring id (metadata-view cross-tenant probe)

    /** Run `fn` as the unprivileged app role with app.org_id = `org` (RLS enforced). */
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
            /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
            "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set; local PG without pgvector)",
          );
        }
        await db.query(sql);
      }
    }

    /**
     * Seed one full M34 tenant chain for `org` as superuser (RLS + grants bypassed). The three
     * *_event tables are LIST-partitioned by organization_id with only the empty parent created by
     * the migration (the provision worker makes per-org children), so we create org `org`'s leaf
     * partition before routing an event row into it. Returns the row ids for assertions.
     */
    async function seedTenant(org: string, label: string): Promise<SeedIds> {
      for (const evt of [
        "support_session_event",
        "dsar_export_job_event",
        "tenant_export_job_event",
      ]) {
        await db.query(
          `CREATE TABLE "${evt}_${label}" PARTITION OF "${evt}" FOR VALUES IN ('${org}')`,
        );
      }

      const ta = (
        await db.query(
          `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,'Legal LLC','bill@x.test','breach@x.test') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const statusEvent = (
        await db.query(
          `INSERT INTO tenant_account_status_event (tenant_account_id, organization_id, to_status, transition_reason, actor_kind)
         VALUES ($1,$2,'provisioning','seed','platform_ops') RETURNING id`,
          [ta, org],
        )
      ).rows[0].id as string;

      const invitation = (
        await db.query(
          `INSERT INTO tenant_invitation (organization_id, tenant_account_id, invitee_email, invitee_full_name, token_hash, inviter_membership_id, expires_at)
         VALUES ($1,$2,'admin@x.test','First Admin',$3, gen_random_uuid(), now() + interval '7 days') RETURNING id`,
          [org, ta, `tokhash-${label}`],
        )
      ).rows[0].id as string;

      const keyRing = (
        await db.query(
          `INSERT INTO tenant_key_ring (organization_id, tenant_account_id, current_dek_version, current_dek_kek_wrapped_ciphertext, current_dek_kek_id, dek_created_at)
         VALUES ($1,$2,'v1', decode('00','hex'),'kek-1', now()) RETURNING id`,
          [org, ta],
        )
      ).rows[0].id as string;

      const destructionLog = (
        await db.query(
          `INSERT INTO tenant_key_destruction_log (organization_id, tenant_key_ring_id, destruction_phase)
         VALUES ($1,$2,'deks_zeroized') RETURNING id`,
          [org, keyRing],
        )
      ).rows[0].id as string;

      const onboardingTask = (
        await db.query(
          `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key)
         VALUES ($1,$2,'account_created') RETURNING id`,
          [org, ta],
        )
      ).rows[0].id as string;

      const supportGrant = (
        await db.query(
          `INSERT INTO support_consent_grant (organization_id, tenant_account_id, scope, grant_reason, grantor_membership_id, expires_at)
         VALUES ($1,$2,'organization_scoped','seed grant', gen_random_uuid(), now() + interval '24 hours') RETURNING id`,
          [org, ta],
        )
      ).rows[0].id as string;

      const supportSession = (
        await db.query(
          `INSERT INTO support_session (organization_id, support_consent_grant_id, actor_membership_id, expires_at)
         VALUES ($1,$2, gen_random_uuid(), now() + interval '1 hour') RETURNING id`,
          [org, supportGrant],
        )
      ).rows[0].id as string;

      const supportSessionEvent = (
        await db.query(
          `INSERT INTO support_session_event (organization_id, support_session_id, event_kind)
         VALUES ($1,$2,'session_started') RETURNING id`,
          [org, supportSession],
        )
      ).rows[0].id as string;

      const dsarJob = (
        await db.query(
          `INSERT INTO dsar_export_job (organization_id, patient_id, request_source, requestor_identity_verification_evidence, requesting_membership_id, sla_due_at)
         VALUES ($1, gen_random_uuid(),'patient','id-evidence', gen_random_uuid(), now() + interval '30 days') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const dsarEvent = (
        await db.query(
          `INSERT INTO dsar_export_job_event (organization_id, dsar_export_job_id, event_kind)
         VALUES ($1,$2,'requested') RETURNING id`,
          [org, dsarJob],
        )
      ).rows[0].id as string;

      const exportJob = (
        await db.query(
          `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id)
         VALUES ($1,'migration', gen_random_uuid()) RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const exportEvent = (
        await db.query(
          `INSERT INTO tenant_export_job_event (organization_id, tenant_export_job_id, event_kind)
         VALUES ($1,$2,'requested') RETURNING id`,
          [org, exportJob],
        )
      ).rows[0].id as string;

      const baaRecord = (
        await db.query(
          `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status)
         VALUES ($1,$2,'v1','executed') RETURNING id`,
          [org, ta],
        )
      ).rows[0].id as string;

      return {
        tenantAccount: ta,
        statusEvent,
        invitation,
        keyRing,
        destructionLog,
        onboardingTask,
        supportGrant,
        supportSession,
        supportSessionEvent,
        dsarJob,
        dsarEvent,
        exportJob,
        exportEvent,
        baaRecord,
      };
    }

    beforeAll(async () => {
      // Runs in its OWN CI job (`rls-live-m34`) with a fresh Postgres service, so the schema/role
      // reset starts clean (a fresh cluster has no prior migration set / cluster-global roles to fight).
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      await resetSchema();
      await applyMigrations();

      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );

      a = await seedTenant(ORG_A, "a");
      const b = await seedTenant(ORG_B, "b");
      ringB = b.keyRing;
    }, 120_000);

    afterAll(async () => {
      await db?.end();
    });

    // ── §3.10 canonical predicate (artifact fidelity) ────────────────────────────────────────────
    // Every covered table's policy must key ONLY on the canonical app.org_id session variable — the
    // same rule the check-tenancy.ts gate enforces. A policy that joined on tenant_account or used
    // pg_has_role(...) would be the M34-F09 regression (silent cross-tenant read) this test guards.
    it("§3.10 every covered policy keys ONLY on the canonical app.org_id variable", () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0052_saas_m34_rls.sql"), "utf8");
      for (const { table } of [...COVERED, { table: "tenant_key_ring" }]) {
        const blocks = [...rls.matchAll(/CREATE POLICY[\s\S]*?;/g)]
          .map((m) => m[0])
          .filter((bk) => new RegExp(`ON "${table}"`).test(bk));
        expect(blocks.length).toBeGreaterThan(0);
        for (const bk of blocks) {
          const vars = [...bk.matchAll(/current_setting\(\s*'(app\.[a-z_]+)'/g)].map((m) => m[1]);
          expect(vars.length).toBeGreaterThan(0);
          expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
          expect(bk).not.toMatch(/pg_has_role/i);
        }
      }
    });

    // ── Per-table cross-tenant denial (§9.3.1) ───────────────────────────────────────────────────
    // Org A reads its own row; org B's session sees NONE of org A's rows (RLS silently returns empty,
    // the correct behavior — not a 403).
    describe.each(COVERED)("$table — cross-tenant denial (§9.3.1)", ({ table, key }) => {
      it("org A sees its own row; org B sees none of it", async () => {
        const id = a[key];
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`, [id]),
        );
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      });
    });

    // ── tenant_key_ring (§3.10 ciphertext lockdown + cross-tenant denial via the masking view) ────
    describe("tenant_key_ring — base-table SELECT revoked, view-scoped, cross-tenant denial (§3.10)", () => {
      it("wardenx_app cannot SELECT the tenant_key_ring base table at all (SELECT revoked)", async () => {
        await expect(
          withOrg(ORG_A, () => db.query("SELECT count(*) FROM tenant_key_ring")),
        ).rejects.toThrow(/permission denied/i);
      });

      it("wardenx_app has NO column SELECT privilege on the wrapped-DEK ciphertext", async () => {
        const r = await db.query(
          "SELECT has_column_privilege('wardenx_app','tenant_key_ring','current_dek_kek_wrapped_ciphertext','SELECT') AS can",
        );
        expect(r.rows[0].can).toBe(false);
      });

      it("the metadata view exposes NO ciphertext column", async () => {
        const r = await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_key_ring_metadata_v'`,
        );
        const cols = r.rows.map((x) => x.column_name as string);
        expect(cols).toContain("current_dek_version"); // non-secret metadata is present
        expect(cols).not.toContain("current_dek_kek_wrapped_ciphertext"); // the wrapped DEK is masked out
      });

      it("org A reads its own key-ring metadata row; org B sees none of it", async () => {
        const seenByA = await withOrg(ORG_A, () =>
          db.query("SELECT count(*)::int AS n FROM tenant_key_ring_metadata_v WHERE id = $1", [
            a.keyRing,
          ]),
        );
        const seenByB = await withOrg(ORG_B, () =>
          db.query("SELECT count(*)::int AS n FROM tenant_key_ring_metadata_v WHERE id = $1", [
            a.keyRing,
          ]),
        );
        expect(seenByA.rows[0].n).toBe(1);
        expect(seenByB.rows[0].n).toBe(0);
        // and org B's own ring is invisible to org A through the same org-filtered view
        const bRingUnderA = await withOrg(ORG_A, () =>
          db.query("SELECT count(*)::int AS n FROM tenant_key_ring_metadata_v WHERE id = $1", [
            ringB,
          ]),
        );
        expect(bRingUnderA.rows[0].n).toBe(0);
      });
    });

    // ── Cross-tenant WRITE rejection (WITH CHECK) on the tenant-writable tables ───────────────────
    // The export/DSAR/support tables are full-CRUD for the tenant (worker runs under withOrgContext,
    // F09); the canonical WITH CHECK must still refuse a row stamped with another org's id.
    it("§9.3.1 org B cannot INSERT a dsar_export_job stamped with org A (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO dsar_export_job (organization_id, patient_id, request_source, requestor_identity_verification_evidence, requesting_membership_id, sla_due_at)
           VALUES ($1, gen_random_uuid(),'patient','x', gen_random_uuid(), now() + interval '30 days')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§9.3.1 org B cannot INSERT a support_consent_grant stamped with org A (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO support_consent_grant (organization_id, tenant_account_id, scope, grant_reason, grantor_membership_id, expires_at)
           VALUES ($1,$2,'organization_scoped','x', gen_random_uuid(), now() + interval '1 hour')`,
            [ORG_A, a.tenantAccount],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.10 tenant_account is SELECT-only to wardenx_app (no tenant UPDATE path)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE tenant_account SET plan_label='x' WHERE id = $1", [a.tenantAccount]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  },
);
