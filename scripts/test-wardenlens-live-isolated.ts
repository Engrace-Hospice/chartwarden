import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  WARDENLENS_PGDATA_TMPFS,
  WARDENLENS_TEST_LABEL,
  type WardenLensContainerInspection,
  assertLocalDockerEndpoint,
  assertFreshWardenLensDatabase,
  assertWardenLensDatabaseIdentity,
  buildWardenLensSuiteEnvironment,
  isCompleteWardenLensSuite,
  validateWardenLensContainerIsolation,
} from "./wardenlens-live-isolation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_CONTEXT = join(ROOT, "deploy/production/postgres");
const PG_DOCKERFILE = join(POSTGRES_CONTEXT, "Dockerfile");
const VITEST_ENTRY = join(ROOT, "node_modules/vitest/vitest.mjs");
const LABEL_VALUE = "wardenlens-live";
const SUITES = [
  { key: "f236", file: "apps/backend/__tests__/f236-doclens-intake.live.test.ts" },
  { key: "f237", file: "apps/backend/__tests__/f237-doclens-review.live.test.ts" },
] as const;

type VitestReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
};

function run(command: string, args: readonly string[], quiet = false): string {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (!quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status ?? "without status"}`);
  return result.stdout.trim();
}

function cleanup(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, [...args], { cwd: ROOT, encoding: "utf8" });
  return !result.error && result.status === 0;
}

function requireExecutable(name: string): void {
  const result = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name]);
  if (result.status !== 0) throw new Error(`Required executable is unavailable: ${name}`);
}

async function waitForIdentity(
  databaseUrl: string,
  expected: { databaseName: string; clusterName: string },
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      const result = await client.query<{
        database_name: string;
        cluster_name: string;
        server_version_num: number;
        is_superuser: boolean;
        max_locks_per_transaction: number;
        system_identifier: string;
      }>(`
        SELECT current_database() AS database_name,
               current_setting('cluster_name') AS cluster_name,
               current_setting('server_version_num')::integer AS server_version_num,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
               current_setting('max_locks_per_transaction')::integer AS max_locks_per_transaction,
               (pg_control_system()).system_identifier::text AS system_identifier
      `);
      const row = result.rows[0];
      if (!row) throw new Error("Disposable database returned no identity row");
      const identity = {
        databaseName: row.database_name,
        clusterName: row.cluster_name,
        serverVersionNum: row.server_version_num,
        isSuperuser: row.is_superuser,
        maxLocksPerTransaction: row.max_locks_per_transaction,
        systemIdentifier: row.system_identifier,
      };
      assertWardenLensDatabaseIdentity(identity, expected);
      await client.end();
      return identity;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  throw new Error("Disposable PostgreSQL did not pass the identity preflight", {
    cause: lastError,
  });
}

async function runSuite(input: {
  suite: (typeof SUITES)[number];
  image: string;
  runId: string;
  workDir: string;
}): Promise<void> {
  const { suite, image, runId, workDir } = input;
  const databaseName = `wardenlens_${suite.key}_${runId}`;
  const clusterName = `wardenlens-${suite.key}-${runId}`;
  const containerName = `chartwarden-wardenlens-${suite.key}-${runId}`;
  const password = randomBytes(32).toString("base64url");
  const label = `${WARDENLENS_TEST_LABEL}=${LABEL_VALUE}`;
  let created = false;
  let client: Client | undefined;
  let runError: unknown;

  try {
    run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerName,
        "--label",
        label,
        "--tmpfs",
        `${WARDENLENS_PGDATA_TMPFS}:rw,noexec,nosuid,size=2g,uid=999,gid=999`,
        "-p",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_USER=postgres",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        `POSTGRES_DB=${databaseName}`,
        image,
        "-c",
        "max_locks_per_transaction=1024",
        "-c",
        `cluster_name=${clusterName}`,
      ],
      true,
    );
    created = true;

    const inspection = JSON.parse(run("docker", ["inspect", containerName], true))[0] as
      | WardenLensContainerInspection
      | undefined;
    if (!inspection) throw new Error("WardenLens Docker isolation preflight found no container");
    const endpoint = validateWardenLensContainerIsolation(inspection, {
      expectedImage: image,
      expectedLabel: LABEL_VALUE,
    });
    const filesystemType = run(
      "docker",
      ["exec", containerName, "stat", "-f", "-c", "%T", endpoint.pgdata],
      true,
    );
    if (filesystemType !== "tmpfs") {
      throw new Error("WardenLens Docker isolation preflight found non-tmpfs PGDATA");
    }

    const databaseUrl = new URL(
      `postgresql://postgres@${endpoint.host}:${endpoint.port}/${databaseName}`,
    );
    databaseUrl.password = password;
    const identity = await waitForIdentity(databaseUrl.toString(), { databaseName, clusterName });
    client = new Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    const databases = await client.query<{ database_name: string }>(
      "SELECT datname AS database_name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
    );
    assertFreshWardenLensDatabase(
      databases.rows.map((row) => row.database_name),
      databaseName,
    );
    await client.end();
    client = undefined;

    console.log(
      `${suite.key.toUpperCase()} isolation PASS: PostgreSQL ${Math.floor(identity.serverVersionNum / 10_000)}, ` +
        `database ${databaseName}, cluster ${clusterName}, system ${identity.systemIdentifier}, loopback ${endpoint.port}, tmpfs only.`,
    );

    const reportPath = join(workDir, `${suite.key}-vitest.json`);
    const environment = buildWardenLensSuiteEnvironment(process.env, {
      databaseUrl: databaseUrl.toString(),
      privateWorkDir: workDir,
    });
    const result = spawnSync(
      "node",
      [VITEST_ENTRY, "run", suite.file, "--reporter=json", `--outputFile=${reportPath}`],
      {
        cwd: ROOT,
        env: environment,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15 * 60_000,
      },
    );
    let report: VitestReport;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestReport;
    } catch (error) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`${suite.key.toUpperCase()} did not produce a readable Vitest report`, {
        cause: error,
      });
    }
    const counts = {
      total: report.numTotalTests ?? 0,
      passed: report.numPassedTests ?? 0,
      failed: report.numFailedTests ?? 0,
      pending: report.numPendingTests ?? 0,
      todo: report.numTodoTests ?? 0,
      exitStatus: result.status,
    };
    if (!isCompleteWardenLensSuite(counts)) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(
        `${suite.key.toUpperCase()} live suite did not pass completely: ${JSON.stringify(counts)}`,
      );
    }
    console.log(
      `${suite.key.toUpperCase()} suite PASS: ${counts.passed}/${counts.total} tests passed; none skipped.`,
    );
  } catch (error) {
    runError = error;
  } finally {
    await client?.end().catch(() => undefined);
    if (created && !cleanup("docker", ["rm", "-f", containerName])) {
      runError = runError ?? new Error(`${suite.key.toUpperCase()} container cleanup failed`);
    }
  }
  if (runError) throw runError;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("The WardenLens isolated runner accepts no suite or database arguments");
  }
  requireExecutable("docker");
  requireExecutable("node");
  if (process.env.DOCKER_HOST || process.env.DOCKER_TLS_VERIFY) {
    throw new Error(
      "WardenLens isolated runner refuses DOCKER_HOST/DOCKER_TLS_VERIFY overrides; use a verified local context",
    );
  }
  const dockerContext = run("docker", ["context", "show"], true);
  const dockerEndpoint = run(
    "docker",
    ["context", "inspect", dockerContext, "--format", "{{.Endpoints.docker.Host}}"],
    true,
  );
  assertLocalDockerEndpoint(dockerEndpoint);
  const dockerfile = readFileSync(PG_DOCKERFILE, "utf8");
  if (!/^FROM\s+cgr\.dev\/chainguard\/wolfi-base@sha256:/m.test(dockerfile)) {
    throw new Error("Unexpected PostgreSQL image source; inspect deploy/production/postgres first");
  }

  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const image = `chartwarden-postgres:wardenlens-test-${runId}`;
  const workDir = mkdtempSync(join(tmpdir(), "chartwarden-wardenlens-live-"));
  let built = false;
  let runError: unknown;
  try {
    run("docker", ["build", "-q", "-t", image, POSTGRES_CONTEXT], true);
    built = true;
    for (const suite of SUITES) await runSuite({ suite, image, runId, workDir });
    console.log(
      "WardenLens isolated live qualification PASS: F236 and F237 completed on separate disposable clusters.",
    );
  } catch (error) {
    runError = error;
  } finally {
    if (built && !cleanup("docker", ["image", "rm", image])) {
      runError = runError ?? new Error("WardenLens test image cleanup failed");
    }
    rmSync(workDir, { recursive: true, force: true });
  }
  if (runError) throw runError;
}

await main();
