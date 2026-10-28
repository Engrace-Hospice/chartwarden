import type { Client } from "pg";

// Canonical cluster-role lifecycle for live suites. Lives in packages/db so packages/db suites and the
// backend suites share ONE list without packages/db importing apps/backend (arch:boundaries).
// Re-exported by apps/backend/__tests__/_live-app-role.ts.
// ---------------------------------------------------------------------------------------------------
// Cluster-global roles: ONE drop list for every live suite.
//
// Postgres roles outlive the database. A suite that resets `public` must also drop every role the
// migrations create, or the next suite on the same cluster migrates on top of the previous one's
// leftovers. The sharp case: an earlier suite leaves `chartwarden_destruction`, migration 1139 then
// keeps the `wardenx_destruction` alias, and 1142 fails with "non-function objects still reference
// wardenx_destruction". Hand-written four-role lists missed it in 339 suites; this list replaces them,
// and `live-roles-canonical.test.ts` (non-live) fails if a suite declares its own or a migration
// creates a role that is not here.
//
// Private-cluster requirements (CLAUDE.md "live suites"): start Postgres with
// `-c max_locks_per_transaction=1024`, and drop the previous suite's database before the next
// suite's. Order matters below: login roles first (they are members of the group roles).
// ---------------------------------------------------------------------------------------------------
export const LIVE_DROP_ROLES: readonly string[] = [
  // login / member roles first
  "chartwarden_destruction_login",
  "chartwarden_platform_login",
  "chartwarden_body_backfill_login",
  "chartwarden_platform_live_test",
  "wp213_resealer",
  // post-1139 names
  "chartwarden_destruction",
  "chartwarden_platform",
  "chartwarden_m36_reseal",
  "chartwarden_label_backfill_owner",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  // pre-1139 names (a stale cluster, or the alias 1139 keeps while something still references it)
  "wardenx_destruction_login",
  "wardenx_platform_login",
  "wardenx_body_backfill_login",
  "wardenx_destruction",
  "wardenx_platform",
  "wardenx_m36_reseal",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  // NOLOGIN definer / loader roles created by individual migrations
  "billing_platform_loader",
  "cap_platform_loader",
  "consent_catalog_writer",
  "evv_coords_rekeyer",
  "invitation_token_reader",
  "m34_platform_role_reader",
  "mdm_canonical_writer",
  "medicaid_platform_loader",
  "membership_picker_reader",
  "messaging_admin_reader",
  "nppes_sync_writer",
  "portal_signin_reader",
  "report_writer",
  "tenant_platform_writer",
  "terminology_loader",
];

type Queryable = Pick<Client, "query">;

/** Drop every role in {@link LIVE_DROP_ROLES} (and what it owns in the current database) if it exists. */
export async function dropLiveRoles(admin: Queryable): Promise<void> {
  for (const r of LIVE_DROP_ROLES) {
    await admin.query(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
        `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
    );
  }
}

const OUT_OF_SHARED_MEMORY = "53200";
const DROP_TABLE_CHUNK = 20;

/**
 * `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, tolerating "out of shared memory": one
 * statement takes a lock per dropped object, and ~1000 tables overflow the default lock table. On
 * that error, drop the tables in small separate statements (own transaction each) and retry. The
 * real fix is `max_locks_per_transaction=1024` on the private cluster; this keeps a suite alive when
 * it was started without it.
 */
export async function resetPublicSchema(admin: Queryable): Promise<void> {
  try {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  } catch (err) {
    if ((err as { code?: string }).code !== OUT_OF_SHARED_MEMORY) throw err;
    const { rows } = await admin.query<{ fq: string }>(
      "SELECT format('%I.%I', schemaname, tablename) AS fq FROM pg_tables WHERE schemaname = 'public'",
    );
    for (let i = 0; i < rows.length; i += DROP_TABLE_CHUNK) {
      const chunk = rows.slice(i, i + DROP_TABLE_CHUNK).map((r) => r.fq);
      await admin.query(`DROP TABLE IF EXISTS ${chunk.join(", ")} CASCADE`);
    }
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  }
  await admin.query("CREATE SCHEMA public");
}
