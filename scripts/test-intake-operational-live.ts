import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { verifyLocalDockerDaemon } from "./intake-docker-safety";

export const INTAKE_OPERATIONAL_LIVE_SUITES = [
  "apps/backend/__tests__/f235-doclens-m5-writeback.live.test.ts",
  "apps/backend/__tests__/f236-doclens-intake.live.test.ts",
  "apps/backend/__tests__/f237-doclens-review.live.test.ts",
  "apps/backend/__tests__/f238-doclens-dx-writeback.live.test.ts",
  "apps/backend/__tests__/f238-doclens-clinical-writeback.live.test.ts",
  "apps/backend/__tests__/f238-doclens-identity-relink.live.test.ts",
  "apps/backend/__tests__/f238-records-request.live.test.ts",
] as const;

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const IMAGE = "chartwarden-postgres:intake-operational-live";
const LABEL = "com.chartwarden.test-suite=intake-operational-live";

function run(
  command: string,
  args: readonly string[],
  options: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status ?? "without an exit code"}`);
  return result.stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      const result = await client.query<{ bypass: boolean; database: string }>(
        `select current_database() as database,
                (select rolbypassrls from pg_roles where rolname=current_user) as bypass`,
      );
      if (result.rows[0]?.bypass !== true) throw new Error("disposable admin is not privileged");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  throw new Error("disposable PostgreSQL did not become ready", { cause: lastError });
}

async function runSuite(suite: string): Promise<void> {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const container = `chartwarden-intake-live-${id}`;
  const database = `intake_${id}`;
  const password = randomBytes(32).toString("base64url");
  let created = false;
  let failure: unknown;
  let startedAt: string | undefined;
  let passed = false;
  try {
    run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "--label",
        LABEL,
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql:rw,nosuid,size=2g,uid=999,gid=999",
        "--env",
        "POSTGRES_USER=postgres",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        `POSTGRES_DB=${database}`,
        IMAGE,
        "-c",
        "max_locks_per_transaction=1024",
      ],
      { quiet: true },
    );
    created = true;
    const binding = run("docker", ["port", container, "5432/tcp"], { quiet: true });
    const port = /127\.0\.0\.1:(\d+)/.exec(binding)?.[1];
    if (!port) throw new Error("disposable PostgreSQL is not loopback-bound");
    const url = new URL(`postgresql://postgres@127.0.0.1:${port}/${database}`);
    url.password = password;
    await waitForPostgres(url.toString());

    startedAt = new Date().toISOString();
    console.log(JSON.stringify({ suite, startedAt, isolation: "fresh-loopback-tmpfs" }));
    run("bunx", ["vitest", "run", suite], {
      env: { ...process.env, CHARTWARDEN_TEST_DATABASE_URL: url.toString() },
    });
    passed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      const cleanup = spawnSync("docker", ["rm", "-f", "--volumes", container], {
        cwd: ROOT,
        encoding: "utf8",
      });
      if (cleanup.status !== 0) {
        const cleanupError = new Error(`cleanup failed for ${container}`);
        failure = failure
          ? new AggregateError([failure, cleanupError], "live suite and cleanup both failed")
          : cleanupError;
      }
    }
  }
  if (failure) throw failure;
  if (!passed || !startedAt) throw new Error(`suite ${suite} completed without PASS evidence`);
  console.log(
    JSON.stringify({ suite, startedAt, completedAt: new Date().toISOString(), result: "PASS" }),
  );
}

export async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const suites = requested.length ? requested : [...INTAKE_OPERATIONAL_LIVE_SUITES];
  const unsupported = suites.filter(
    (suite) =>
      !INTAKE_OPERATIONAL_LIVE_SUITES.includes(
        suite as (typeof INTAKE_OPERATIONAL_LIVE_SUITES)[number],
      ),
  );
  if (unsupported.length)
    throw new Error(`unsupported intake live suite: ${unsupported.join(", ")}`);

  verifyLocalDockerDaemon(process.env);
  run("docker", ["build", "-q", "-t", IMAGE, "deploy/production/postgres"], { quiet: true });
  for (const suite of suites) await runSuite(suite);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
