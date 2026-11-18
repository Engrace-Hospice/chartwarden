/**
 * Pure decisions behind scripts/preflight-m25-835-migrations.ts (READ ONLY). Kept apart from the script
 * (which runs on import) so each one is unit tested without a database.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** A loopback host or a Unix-socket path (an empty host or a leading "/" in a URL connection string). */
export function isLocalHost(hostname: string): boolean {
  return hostname === "" || hostname.startsWith("/") || LOCAL_HOSTS.has(hostname.toLowerCase());
}

/**
 * The host the driver will actually dial for this URL: pg-connection-string lets a `?host=` query parameter win over
 * the URL's own host, and an empty host falls back to PGHOST. A guard that read only the URL host would be bypassed
 * by `postgresql://u@localhost/db?host=remote.example`.
 */
function effectiveHost(url: URL, env: NodeJS.ProcessEnv, urlHasEmptyHost: boolean): string {
  const fromQuery = url.searchParams.get("host");
  if (fromQuery) return fromQuery;
  const fromUrl = urlHasEmptyHost ? "" : decodeURIComponent(url.hostname);
  return fromUrl || env.PGHOST || "";
}

/**
 * Why this connection string may not be used, or null when it may. A non-local host must verify the server
 * certificate and name (`sslmode=verify-full`, from the URL or PGSSLMODE): the preflight reads identity rows,
 * so it must not talk to a remote database in the clear or to an unverified endpoint. The URL itself (it can
 * hold a password) is never echoed.
 */
export function connectionRefusal(databaseUrl: string, env: NodeJS.ProcessEnv): string | null {
  let url: URL;
  let urlHasEmptyHost = false;
  try {
    url = new URL(databaseUrl);
  } catch {
    try {
      // An empty host with credentials (`user@/db`) is not a valid WHATWG URL; the driver retries with a dummy host.
      url = new URL(databaseUrl.replace("@/", "@___DUMMY___/"));
      urlHasEmptyHost = true;
    } catch {
      return "M25_PREFLIGHT_DATABASE_URL is not a valid connection URL.";
    }
  }
  if (isLocalHost(effectiveHost(url, env, urlHasEmptyHost))) return null;
  const sslmode = url.searchParams.get("sslmode") ?? env.PGSSLMODE;
  return sslmode === "verify-full"
    ? null
    : "A non-local database host requires sslmode=verify-full (in M25_PREFLIGHT_DATABASE_URL or PGSSLMODE).";
}

/**
 * RLS hides every row from a role that neither is a superuser nor has BYPASSRLS (`app.org_id` is unset on a
 * plain connection), so the data checks would print 0/0 and look clean. They are only meaningful for a role
 * that bypasses it.
 */
export function bypassesRls(role: {
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}): boolean {
  return role.rolsuper || role.rolbypassrls;
}

export type TargetMigrationState = "APPLIED" | "PENDING" | "MISSING";

/** MISSING: the target migration is neither applied nor among the migration files, so there is nothing to apply. */
export function targetMigrationState(
  target: string,
  applied: ReadonlySet<string>,
  pending: readonly string[],
): TargetMigrationState {
  if (applied.has(target)) return "APPLIED";
  return pending.includes(target) ? "PENDING" : "MISSING";
}
