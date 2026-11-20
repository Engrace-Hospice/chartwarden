import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  type M23ContainerInspection,
  type M23NetworkInspection,
  M23_PGDATA_TMPFS,
  assertFreshM23DatabaseInventory,
  isCompleteM23Qualification,
  isM23SuiteEntirelySkipped,
  startLoopbackTcpRelay,
  summarizeVitestFailureMessage,
  validateM23DockerIsolation,
} from "./m23-rls-isolation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = "packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts";
const POSTGRES_CONTEXT = join(ROOT, "deploy/production/postgres");
const PG_DOCKERFILE = join(POSTGRES_CONTEXT, "Dockerfile");
type VitestReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: {
    name?: string;
    message?: string;
    status?: string;
    assertionResults?: { fullName?: string; status?: string }[];
  }[];
};

function cleanup(resource: string, command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, [...args], { cwd: ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.warn(`Cleanup failed for a resource created by this run (${resource}).`);
    return false;
  }
  return true;
}

function run(command: string, args: readonly string[], options: { quiet?: boolean } = {}) {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? "without an exit code"}`);
  }
  return result.stdout.trim();
}

function requireExecutable(name: string) {
  const result = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name]);
  if (result.status !== 0) throw new Error(`Required executable is unavailable: ${name}`);
}

async function waitForPostgres(
  connectionString: string,
  expectedCluster: string,
  expectedDb: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      const result = await client.query<{
        database_name: string;
        cluster_name: string;
        server_version_num: number;
        is_superuser: boolean;
        system_identifier: string;
      }>(`
        SELECT current_database() AS database_name,
               current_setting('cluster_name') AS cluster_name,
               current_setting('server_version_num')::integer AS server_version_num,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
               (pg_control_system()).system_identifier::text AS system_identifier
      `);
      const row = result.rows[0];
      if (
        !row ||
        row.database_name !== expectedDb ||
        row.cluster_name !== expectedCluster ||
        Math.floor(row.server_version_num / 10_000) !== 18 ||
        row.is_superuser !== true ||
        !/^\d+$/.test(row.system_identifier)
      ) {
        throw new Error("Disposable PostgreSQL identity or privilege preflight failed");
      }
      await client.end();
      return { version: row.server_version_num, systemIdentifier: row.system_identifier };
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    await client.end().catch(() => undefined);
  }
  throw new Error("Disposable PostgreSQL did not pass the read-only identity preflight", {
    cause: lastError,
  });
}

async function main() {
  const requestedSuite = process.argv
    .slice(2)
    .filter((argument) => argument.endsWith(".live.test.ts"));
  if (requestedSuite.length !== 1 || requestedSuite[0] !== TEST_FILE) {
    throw new Error("The isolated M23 runner only accepts its registered M23 live suite");
  }
  requireExecutable("docker");
  const dockerfile = readFileSync(PG_DOCKERFILE, "utf8");
  if (!/^FROM\s+cgr\.dev\/chainguard\/wolfi-base@sha256:/m.test(dockerfile)) {
    throw new Error(
      "Unexpected PostgreSQL test image source; inspect deploy/production/postgres first",
    );
  }

  const id = randomUUID().replaceAll("-", "");
  const clusterName = `chartwarden-m23-${id}`;
  const databaseName = `m23_${id}`;
  const image = `chartwarden-postgres:m23-test-${id.slice(0, 12)}`;
  const container = `chartwarden-m23-rls-${id.slice(0, 12)}`;
  const network = `chartwarden-m23-net-${id.slice(0, 12)}`;
  const label = "com.chartwarden.test-suite=m23-rls-live";
  const password = randomBytes(32).toString("base64url");
  let imageBuilt = false;
  let networkCreated = false;
  let containerCreated = false;
  let relay: Awaited<ReturnType<typeof startLoopbackTcpRelay>> | undefined;
  let db: Client | undefined;
  const reportDir = mkdtempSync(join(tmpdir(), "chartwarden-m23-vitest-"));
  const reportPath = join(reportDir, "vitest.json");
  let runError: unknown;
  const cleanupFailures: string[] = [];

  try {
    run("docker", ["build", "-q", "-t", image, POSTGRES_CONTEXT], { quiet: true });
    imageBuilt = true;
    run("docker", ["network", "create", "--internal", "--label", label, network], {
      quiet: true,
    });
    networkCreated = true;
    run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "--label",
        label,
        "--network",
        network,
        "--tmpfs",
        `${M23_PGDATA_TMPFS}:rw,nosuid,size=2g,uid=999,gid=999`,
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
      { quiet: true },
    );
    containerCreated = true;

    const inspection = JSON.parse(run("docker", ["inspect", container], { quiet: true }))[0] as
      | M23ContainerInspection
      | undefined;
    const networkInspection = JSON.parse(
      run("docker", ["network", "inspect", network], { quiet: true }),
    )[0] as M23NetworkInspection | undefined;
    if (!inspection || !networkInspection) {
      throw new Error(
        "Docker isolation preflight failed (container or network inspection missing)",
      );
    }
    const databaseHost = validateM23DockerIsolation({
      container: inspection,
      network: networkInspection,
      expectedNetwork: network,
    });
    const mountFilesystemType = run(
      "docker",
      ["exec", container, "stat", "-f", "-c", "%T", M23_PGDATA_TMPFS],
      { quiet: true },
    );
    if (mountFilesystemType !== "tmpfs") {
      throw new Error("Docker isolation preflight failed (PostgreSQL mount is not tmpfs-backed)");
    }
    const pgdata = inspection.Config?.Env?.find((entry) => entry.startsWith("PGDATA="))?.slice(
      "PGDATA=".length,
    );
    if (!pgdata) {
      throw new Error(
        "Docker isolation preflight failed (PostgreSQL data directory is unidentified)",
      );
    }
    relay = await startLoopbackTcpRelay(databaseHost, 5432);
    const port = relay.port;
    const databaseUrl = new URL(`postgresql://postgres@127.0.0.1:${port}/${databaseName}`);
    databaseUrl.password = password;
    const identity = await waitForPostgres(databaseUrl.toString(), clusterName, databaseName);
    const pgdataFilesystemType = run(
      "docker",
      ["exec", container, "stat", "-f", "-c", "%T", pgdata],
      { quiet: true },
    );
    if (pgdataFilesystemType !== "tmpfs") {
      throw new Error(
        "Docker isolation preflight failed (PostgreSQL data directory is not tmpfs-backed)",
      );
    }
    db = new Client({ connectionString: databaseUrl.toString() });
    await db.connect();
    const databaseNames = await db.query<{ database_name: string }>(
      "SELECT datname AS database_name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
    );
    assertFreshM23DatabaseInventory(
      databaseNames.rows.map(({ database_name }) => database_name),
      databaseName,
    );

    console.log(
      `Isolated PostgreSQL preflight passed: PostgreSQL ${Math.floor(identity.version / 10_000)}.${identity.version % 10_000}, cluster ${clusterName}, ` +
        `database ${databaseName}, loopback port ${port}, system identifier ${identity.systemIdentifier}.`,
    );
    console.log(
      "Storage: container-local tmpfs only; network: Docker internal; no host database or volume mounted.",
    );

    const child = spawnSync(
      process.execPath,
      ["run", "vitest", "run", TEST_FILE, "--reporter=json", `--outputFile=${reportPath}`],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          CHARTWARDEN_TEST_DATABASE_URL: databaseUrl.toString(),
          CHARTWARDEN_M23_RLS_ISOLATED_RUN: "true",
          CHARTWARDEN_TEST_CLUSTER_ID: clusterName,
          CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER: identity.systemIdentifier,
        },
      },
    );
    if (child.error) throw child.error;

    let report: VitestReport;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestReport;
    } catch (error) {
      throw new Error("Vitest did not produce a readable machine report; qualification is failed", {
        cause: error,
      });
    }
    const total = report.numTotalTests ?? 0;
    const passed = report.numPassedTests ?? 0;
    const failed = report.numFailedTests ?? 0;
    const skipped = report.numPendingTests ?? 0;
    const todo = report.numTodoTests ?? 0;
    const qualified = isCompleteM23Qualification({
      exitStatus: child.status,
      total,
      passed,
      failed,
      pending: skipped,
      todo,
    });
    if (qualified) {
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
    } else {
      console.error("Vitest did not qualify; raw stdout/stderr withheld.");
    }
    console.log(
      `M23 live result: total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}.`,
    );
    if (!qualified) {
      if (isM23SuiteEntirelySkipped({ total, passed, failed, pending: skipped, todo })) {
        console.error(
          "All M23 RLS tests were skipped; the isolated-run marker was not visible inside Vitest.",
        );
      }
      for (const file of report.testResults ?? []) {
        const nonPassed = (file.assertionResults ?? []).filter((test) => test.status !== "passed");
        if (file.status !== "passed" || nonPassed.length > 0) {
          console.error(
            `Vitest file status: ${file.status ?? "unknown"} (${file.name ?? "unnamed"})`,
          );
          if (file.message) {
            console.error("  Suite failure diagnostic (allowlisted; raw details withheld):");
            for (const line of summarizeVitestFailureMessage(file.message)) {
              console.error(`    ${line}`);
            }
          }
          for (const test of nonPassed) {
            console.error(`  ${test.status ?? "unknown"}: ${test.fullName ?? "unnamed test"}`);
          }
        }
      }
    }
    if (!qualified) {
      throw new Error(
        "M23 live qualification failed or skipped tests; see the Vitest summary above",
      );
    }
  } catch (error) {
    runError = error;
  } finally {
    await db?.end().catch(() => cleanupFailures.push("database client"));
    await relay?.close().catch(() => cleanupFailures.push("loopback relay"));
    if (containerCreated && !cleanup("container", "docker", ["rm", "-f", container])) {
      cleanupFailures.push("container");
    }
    if (networkCreated && !cleanup("network", "docker", ["network", "rm", network])) {
      cleanupFailures.push("network");
    }
    if (imageBuilt && !cleanup("image", "docker", ["image", "rm", image])) {
      cleanupFailures.push("image");
    }
    try {
      rmSync(reportDir, { recursive: true, force: true });
    } catch {
      cleanupFailures.push("temporary report directory");
    }
  }

  if (cleanupFailures.length > 0) {
    throw new Error(
      `M23 qualification cleanup failed for: ${cleanupFailures.join(", ")}; qualification is failed.`,
      { cause: runError },
    );
  }
  console.log(
    "Cleanup passed: private container, network, image, relay, and report directory removed.",
  );
  if (runError) throw runError;
}

await main();
