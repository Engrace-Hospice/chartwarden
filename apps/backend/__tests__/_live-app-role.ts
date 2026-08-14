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
 * in as it. Pass the SUPERUSER client and the suite's `WARDENX_TEST_DATABASE_URL`.
 *
 * Throws on a url that cannot be parsed rather than degrading to the caller's identity — the failure mode
 * this replaces was precisely a silent fallback to superuser.
 */
export async function appRoleConnectionString(admin: Client, dbUrl: string): Promise<string> {
  await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
  return appRoleUrl(dbUrl);
}

/** The url half of {@link appRoleConnectionString}, for a suite that grants LOGIN itself. */
export function appRoleUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.username = "wardenx_app";
  url.password = LIVE_APP_ROLE_PASSWORD;
  return url.toString();
}
