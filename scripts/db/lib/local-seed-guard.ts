/**
 * Refuse to run a local dev seed anywhere but a local database outside production.
 *
 * `db:seed:all` is expanded without a shell by scripts/db/seed-all.ts and run in production by
 * deploy/production/reseed-demo.sh, so a seed that creates an account with authority must refuse a production
 * environment itself: being absent from that chain is not enough. Pure so it can be tested; the caller passes
 * `process.env.NODE_ENV` and its admin connection string. Only the host is ever reported, never the credentials.
 */
const LOCAL_DB_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]", "postgres"];
const LOCAL_AUTH_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
// An allow-list, not a deny-list on "production": production's seed-runner also reaches the host `postgres`, and an
// `env_file` can set NODE_ENV to anything (`staging`, `prod`, `Production`), so only a known-local value passes.
const LOCAL_NODE_ENVS: readonly (string | undefined)[] = [undefined, "development", "test"];

export function assertLocalDevSeed(input: {
  readonly nodeEnv: string | undefined;
  readonly databaseUrl: string | undefined;
  /**
   * `CHARTWARDEN_SEED_ALLOW_PRODUCTION`: set only on production's seed-runner (compose.yml), whatever NODE_ENV says.
   * Required (pass `undefined` when unset) so a caller cannot lose the check by leaving it out.
   */
  readonly productionSeedAck: string | undefined;
  /**
   * The backend the seed signs the account up on (`BETTER_AUTH_URL`): a freshly generated password is POSTed there, so
   * a remote backend with a local database would leave a stray account on it. Local hosts only; `postgres` is a
   * database host name, not a backend's.
   */
  readonly authUrl: string;
}): void {
  if (!LOCAL_NODE_ENVS.includes(input.nodeEnv)) {
    throw new Error(
      `this is a local dev seed and runs only with NODE_ENV unset, development or test (got ${input.nodeEnv})`,
    );
  }
  if (input.productionSeedAck) {
    throw new Error("this is a local dev seed and refuses to run in production's seed-runner");
  }
  if (!input.databaseUrl) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  let host: string;
  try {
    host = new URL(input.databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is not a valid URL");
  }
  if (!LOCAL_DB_HOSTS.includes(host)) {
    throw new Error(`${host} is not local; this seed only runs against a local database`);
  }
  let authHost: string;
  try {
    authHost = new URL(input.authUrl).hostname;
  } catch {
    throw new Error("BETTER_AUTH_URL is not a valid URL");
  }
  if (!LOCAL_AUTH_HOSTS.includes(authHost)) {
    throw new Error(`${authHost} is not local; this seed only signs up on a local backend`);
  }
}
