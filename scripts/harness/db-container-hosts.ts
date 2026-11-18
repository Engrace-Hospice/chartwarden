/**
 * Names that are database hosts on a private container network, not on the internet (wave 11, part D, D3; round-8 R8-CR-8).
 * `DATABASE_URL=postgres://u:p@chartwarden-postgres:5432/x bun run test`, `REDIS_URL=redis://valkey:6379 bun run dev` and
 * `DATABASE_URL=...@db:5432/... bun run db:migrate` were allowed in wave 9 and DENIED in wave 10: the shared local-host predicate
 * (`content-scan.ts` `LOCAL_HOST`) knows the services of the development compose file and nothing else, and wave 10 refuses a
 * database variable whose host it does not know. A program started with such a variable reads the host the compose network
 * resolves; it is a false positive, and an agent that runs a stack of its own names its services this way all the time.
 *
 * Two tables, read ONLY for a program that is not a database client (`db-any-program.ts`: a program that reads a variable such as
 * DATABASE_URL), never for `psql -h NAME` (a client run from this shell resolves NAME through the host's resolver):
 *   - `PROJECT_CONTAINER_HOSTS`: the names this repository's own compose files and images use. Local.
 *   - `GENERIC_CONTAINER_HOSTS`: the names a compose file conventionally gives a database service (`db`, `mysql`, `mongo`), which
 *     the repository does not use but a throwaway container may. They resolve only on a compose network, but a resolver search
 *     domain could also resolve one, so the guard ASKS instead of refusing or allowing.
 * Sources: `docker-compose.yml` services (postgres, redis, rustfs, clamav, ...), `deploy/production/compose.yml` services (postgres,
 * valkey, seaweedfs, minio, ...), the image and container names `chartwarden-postgres` (the dev image the compose file builds,
 * `docker build -t chartwarden-postgres:dev`), `chartwarden-valkey` and `chartwarden-redis` (the live-suite container names). Pure.
 */

export const PROJECT_CONTAINER_HOSTS: ReadonlySet<string> = new Set([
  "postgres",
  "redis",
  "valkey",
  "minio",
  "rustfs",
  "seaweedfs",
  "clamav",
  "chartwarden-postgres",
  "chartwarden-valkey",
  "chartwarden-redis",
]);

export const GENERIC_CONTAINER_HOSTS: ReadonlySet<string> = new Set([
  "db",
  "database",
  "postgresql",
  "pg",
  "mysql",
  "mariadb",
  "mongo",
  "mongodb",
  "clickhouse",
  "cassandra",
  "cache",
]);

/** How a bare host name is read for a program that is not a database client. */
export function containerHostKind(host: string): "project" | "generic" | null {
  const name = host.toLowerCase();
  if (PROJECT_CONTAINER_HOSTS.has(name)) return "project";
  return GENERIC_CONTAINER_HOSTS.has(name) ? "generic" : null;
}
