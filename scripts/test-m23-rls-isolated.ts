import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = "packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts";
const POSTGRES_CONTEXT = join(ROOT, "deploy/production/postgres");
const PG_DOCKERFILE = join(POSTGRES_CONTEXT, "Dockerfile");
const PGDATA_TMPFS = "/var/lib/postgresql";

type ContainerInspection = {
  Config: { Labels: Record<string, string> | null };
  Mounts: Array<{ Destination: string; Type: string }>;
  NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
};

type VitestReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
};

function cleanup(command: string, args: readonly string[]) {
  const result = spawnSync(command, [...args], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    console.warn(`Cleanup needs operator review for a resource created by this run (${args[0]}).`);
  }
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

function parsePublishedPort(value: string): number {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(value);
  if (!match) throw new Error("PostgreSQL did not publish on a loopback-only ephemeral port");
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Docker returned an invalid PostgreSQL port");
  }
  return port;
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
  let db: Client | undefined;
  const reportDir = mkdtempSync(join(tmpdir(), "chartwarden-m23-vitest-"));
  const reportPath = join(reportDir, "vitest.json");

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
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        `${PGDATA_TMPFS}:rw,nosuid,size=2g,uid=999,gid=999`,
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
      | ContainerInspection
      | undefined;
    const mounts = inspection?.Mounts ?? [];
    const networks = Object.keys(inspection?.NetworkSettings.Networks ?? {});
    if (
      inspection?.Config.Labels?.["com.chartwarden.test-suite"] !== "m23-rls-live" ||
      mounts.length !== 1 ||
      mounts[0]?.Type !== "tmpfs" ||
      mounts[0]?.Destination !== PGDATA_TMPFS ||
      networks.length !== 1 ||
      networks[0] !== network
    ) {
      throw new Error(
        "Docker isolation preflight failed (expected one labeled container, tmpfs, and private network)",
      );
    }

    const port = parsePublishedPort(
      run("docker", ["port", container, "5432/tcp"], { quiet: true }),
    );
    const databaseUrl = new URL(`postgresql://postgres@127.0.0.1:${port}/${databaseName}`);
    databaseUrl.password = password;
    const identity = await waitForPostgres(databaseUrl.toString(), clusterName, databaseName);
    db = new Client({ connectionString: databaseUrl.toString() });
    await db.connect();
    const databaseNames = await db.query<{ names: string[] }>(
      "SELECT array_agg(datname ORDER BY datname) AS names FROM pg_database WHERE datallowconn AND NOT datistemplate",
    );
    const names = databaseNames.rows[0]?.names ?? [];
    if (names.length !== 2 || !names.includes("postgres") || !names.includes(databaseName)) {
      throw new Error(
        "Disposable cluster is not fresh (unexpected connectable database inventory)",
      );
    }

    console.log(
      `Isolated PostgreSQL preflight passed: PostgreSQL ${Math.floor(identity.version / 10_000)}.${identity.version % 10_000}, cluster ${clusterName}, ` +
        `database ${databaseName}, loopback port ${port}, system identifier ${identity.systemIdentifier}.`,
    );
    console.log(
      "Storage: container-local tmpfs only; network: Docker internal; no host database or volume mounted.",
    );

    const child = spawnSync(
      process.execPath,
      ["x", "vitest", "run", TEST_FILE, "--reporter=json", `--outputFile=${reportPath}`],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          CHARTWARDEN_TEST_DATABASE_URL: databaseUrl.toString(),
          CHARTWARDEN_TEST_CLUSTER_ID: clusterName,
          CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER: identity.systemIdentifier,
        },
      },
    );
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
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
    console.log(
      `M23 live result: total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped}.`,
    );
    if (child.status !== 0 || total === 0 || failed !== 0 || skipped !== 0 || passed !== total) {
      throw new Error(
        "M23 live qualification failed or skipped tests; see the Vitest summary above",
      );
    }
  } finally {
    await db?.end().catch(() => undefined);
    if (containerCreated) cleanup("docker", ["rm", "-f", container]);
    if (networkCreated) cleanup("docker", ["network", "rm", network]);
    if (imageBuilt) cleanup("docker", ["image", "rm", image]);
    rmSync(reportDir, { recursive: true, force: true });
  }
}

await main();
