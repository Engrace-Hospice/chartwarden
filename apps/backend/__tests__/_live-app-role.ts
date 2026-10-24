// apps/backend/__tests__/_live-app-role.ts — the one correct way a live suite connects AS the
// RLS-enforced tenant role (GAP-086).
//
// Every live suite seeds as the SUPERUSER (`admin`), then drives the production code path as the
// unprivileged NOBYPASSRLS `chartwarden_app` role, because that is what production connects as and because a
// superuser BYPASSES ROW LEVEL SECURITY unconditionally — no policy, and no amount of FORCE RLS, applies
// to it. A cross-tenant assertion made on a superuser connection therefore proves nothing at all: it
// asserts that org B cannot see org A's rows while sitting on a connection for which that restriction
// does not exist.
//
// Thirty-four suites did that role switch by string surgery on the connection URL:
//
//     connectionString: (DB_URL as string).replace("://postgres@", "://chartwarden_app@")
//
// which only matches a PASSWORDLESS url (`postgres://postgres@host/db`). Against any url carrying a
// password — including CI's own `postgresql://postgres:postgres@localhost:5432/chartwarden_test` — the
// pattern misses, `String.replace` returns the input unchanged, and the suite silently connects as the
// superuser instead. It fails open and says nothing: no error, no warning, just a weaker test. Locally,
// with the passwordless url the runbook prescribes, the same suites switched roles correctly and passed —
// which is exactly why this survived: the bug is invisible in the only environment where these suites had
// ever been run. Wiring them into CI (their whole point) surfaced 23 of 25 failing on cross-tenant
// assertions that a superuser connection cannot possibly satisfy.
//
// Parse the url instead of pattern-matching it, and give the role a password so it can log in over TCP
// regardless of the server's auth method.
import type { Client } from "pg";

/** The password granted to `chartwarden_app` for the duration of a live suite. Test-only, never a secret. */
export const LIVE_APP_ROLE_PASSWORD = "chartwarden_app_live_test";

/**
 * Grant `chartwarden_app` LOGIN (the migrations create it NOLOGIN) and return the connection string that logs
 * in as it. Pass the SUPERUSER client and the suite's `CHARTWARDEN_TEST_DATABASE_URL`.
 *
 * Throws on a url that cannot be parsed rather than degrading to the caller's identity — the failure mode
 * this replaces was precisely a silent fallback to superuser.
 */
export async function appRoleConnectionString(admin: Client, dbUrl: string): Promise<string> {
  await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
  const url = appRoleUrl(dbUrl);
  await assertConnectsAsAppRole(url);
  return url;
}

/**
 * Prove the returned url actually logs in as the NOBYPASSRLS `chartwarden_app` — and NOT as a superuser or
 * any BYPASSRLS role — before a suite builds its handle on it.
 *
 * The GAP-086 bug was invisible precisely because nothing ever asked. A suite that quietly connects as
 * the superuser still passes every test it has; it just stops proving the one thing it exists to prove,
 * and it says nothing while doing so. Five suites written AFTER the GAP-086 sweep reintroduced the
 * string-replace idiom, so "we fixed them all once" is not a durable answer. Checking here means the
 * next silent fallback fails loudly in `beforeAll` instead of turning a cross-tenant suite vacuous.
 */
async function assertConnectsAsAppRole(url: string): Promise<void> {
  const { Client: PgClient } = await import("pg");
  const probe = new PgClient({ connectionString: url });
  await probe.connect();
  try {
    const { rows } = await probe.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
    );
    const who = rows[0];
    if (!who || who.current_user !== "chartwarden_app") {
      throw new Error(
        `live suite connected as '${who?.current_user ?? "unknown"}', expected 'chartwarden_app' — RLS assertions on this connection would be vacuous (GAP-086)`,
      );
    }
    if (who.rolsuper || who.rolbypassrls) {
      throw new Error(
        "live suite's chartwarden_app carries SUPERUSER/BYPASSRLS — no policy applies to it, so every " +
          "cross-tenant assertion would pass regardless (GAP-086)",
      );
    }
  } finally {
    await probe.end();
  }
}

/** The url half of {@link appRoleConnectionString}, for a suite that grants LOGIN itself. */
export function appRoleUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.username = "chartwarden_app";
  url.password = LIVE_APP_ROLE_PASSWORD;
  return url.toString();
}

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
