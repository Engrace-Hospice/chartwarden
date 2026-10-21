// apps/backend/__tests__/_live-app-role.ts — the one correct way a live suite connects AS the
// RLS-enforced tenant role (GAP-086).
//
// Every live suite seeds as the SUPERUSER (`admin`), then drives the production code path as the
// unprivileged NOBYPASSRLS `wardenx_app` role, because that is what production connects as and because a
// superuser BYPASSES ROW LEVEL SECURITY unconditionally — no policy, and no amount of FORCE RLS, applies
// to it. A cross-tenant assertion made on a superuser connection therefore proves nothing at all: it
// asserts that org B cannot see org A's rows while sitting on a connection for which that restriction
// does not exist.
//
// Thirty-four suites did that role switch by string surgery on the connection URL:
//
//     connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@")
//
// which only matches a PASSWORDLESS url (`postgres://postgres@host/db`). Against any url carrying a
// password — including CI's own `postgresql://postgres:postgres@localhost:5432/wardenx_test` — the
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

/** The password granted to `wardenx_app` for the duration of a live suite. Test-only, never a secret. */
export const LIVE_APP_ROLE_PASSWORD = "wardenx_app_live_test";

/**
 * Grant `wardenx_app` LOGIN (the migrations create it NOLOGIN) and return the connection string that logs
 * in as it. Pass the SUPERUSER client and the suite's `CHARTWARDEN_TEST_DATABASE_URL`.
 *
 * Throws on a url that cannot be parsed rather than degrading to the caller's identity — the failure mode
 * this replaces was precisely a silent fallback to superuser.
 */
export async function appRoleConnectionString(admin: Client, dbUrl: string): Promise<string> {
  await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
  const url = appRoleUrl(dbUrl);
  await assertConnectsAsAppRole(url);
  return url;
}

/**
 * Prove the returned url actually logs in as the NOBYPASSRLS `wardenx_app` — and NOT as a superuser or
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
    if (!who || who.current_user !== "wardenx_app") {
      throw new Error(
        `live suite connected as '${who?.current_user ?? "unknown"}', expected 'wardenx_app' — RLS assertions on this connection would be vacuous (GAP-086)`,
      );
    }
    if (who.rolsuper || who.rolbypassrls) {
      throw new Error(
        "live suite's wardenx_app carries SUPERUSER/BYPASSRLS — no policy applies to it, so every " +
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
  url.username = "wardenx_app";
  url.password = LIVE_APP_ROLE_PASSWORD;
  return url.toString();
}
