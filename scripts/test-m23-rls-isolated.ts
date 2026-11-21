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
  buildM23VitestEnvironment,
  isCompleteM23Qualification,
  isM23SuiteEntirelySkipped,
  runM23Child,
  startLoopbackTcpRelay,
  summarizeVitestFailureMessage,
  validateM23DockerIsolation,
} from "./m23-rls-isolation";
import {
  type M23CollectedTest,
  isM23TargetModuleEnvironmentSafe,
  parseM23TargetModuleDiagnosticJson,
  validateM23DynamicCollection,
} from "./m23-rls-target-diagnostic";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = "packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts";
const M23_SUITE_NAME = "M23 Billing — Medicare — RLS cross-tenant denial — LIVE Postgres (§3.5)";
const EXPECTED_M23_ASSERTIONS = [
  "chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously",
  "every M23 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)",
  "org B sees NONE of org A's rows, on every org-scoped M23 table",
  "a WITH CHECK refuses an INSERT carrying another tenant's organization_id",
  "new M23 routing and exception tables reject forged cross-tenant writes",
  "a cross-tenant UPDATE matches no rows (the USING clause covers writes too)",
  "enforces exception-review and operational-issue tenant ownership with append-only histories",
  "tenant Claim.MD inbox is org-scoped and captured evidence and credential bindings are immutable",
  "deduplicates active issues and keeps issue event plus notification intent transactional",
  "fences notification publication and preserves cross-tenant outbox isolation",
  "line evidence is append-only for its owner and invisible to another tenant",
  "only the DRAFT-claim subtree grants DELETE to the runtime role, each behind a draft-only trigger",
  "reserves and terminalizes a queued claim submission exactly once and rejects deletion",
  "the CLAIM chain is org-invisible end to end — not just the claim root",
  "a patient's Medicare eligibility response is not readable across tenants",
  "MAC submitter credentials never cross tenants (they are a submission identity)",
  "wage_index_factor is PLATFORM reference data — shared, and not writable by a tenant",
  "⚠ `claim_ack_file_uq` is NOT org-scoped — a cross-tenant write oracle",
  "every partition leaf minted for M23 is born with forced RLS (0118 event trigger)",
].map((assertion) => `${M23_SUITE_NAME} > ${assertion}`);
const VITEST_ENTRY = join(ROOT, "node_modules/vitest/vitest.mjs");
const ENV_PROBE_FILE = "scripts/__tests__/m23-rls-isolation.test.ts";
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
    assertionResults?: {
      fullName?: string;
      status?: string;
      failureMessages?: string[] | null;
    }[];
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
  requireExecutable("node");
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
  const envProbeReportPath = join(reportDir, "environment-probe.json");
  const reportPath = join(reportDir, "vitest.json");
  const collectionReportPath = join(reportDir, "m23-collection.json");
  const collectionDiagnosticPath = join(reportDir, "chartwarden-m23-target-module-collection.json");
  const runDiagnosticPath = join(reportDir, "chartwarden-m23-target-module-execution.json");
  const setupDiagnosticPath = join(reportDir, "chartwarden-m23-setup-stage.json");
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

    const vitestEnvironment = buildM23VitestEnvironment(process.env, {
      databaseUrl: databaseUrl.toString(),
      clusterName,
      systemIdentifier: identity.systemIdentifier,
      privateWorkDir: reportDir,
    });
    const envProbe = await runM23Child(
      "node",
      [
        VITEST_ENTRY,
        "run",
        ENV_PROBE_FILE,
        "--reporter=json",
        `--outputFile=${envProbeReportPath}`,
      ],
      {
        cwd: ROOT,
        env: { ...vitestEnvironment, CHARTWARDEN_M23_RLS_ENV_PROBE: "true" },
        timeoutMs: 60_000,
      },
    );
    let envProbeReport: VitestReport;
    try {
      envProbeReport = JSON.parse(readFileSync(envProbeReportPath, "utf8")) as VitestReport;
    } catch (error) {
      throw new Error("Vitest worker environment preflight did not produce a readable report", {
        cause: error,
      });
    }
    const envProbePassed = envProbeReport.testResults?.some((file) =>
      file.assertionResults?.some(
        (test) =>
          test.fullName?.includes("receives the isolated runner values") &&
          test.status === "passed",
      ),
    );
    if (
      envProbe.status !== 0 ||
      envProbePassed !== true ||
      envProbeReport.numFailedTests !== 0 ||
      envProbeReport.numPendingTests !== 0 ||
      envProbeReport.numTodoTests !== 0
    ) {
      throw new Error("Vitest worker environment preflight failed; M23 RLS suite was not started");
    }
    console.log(
      "Isolated Vitest worker environment preflight passed: private URL, marker, and cluster identity reached the worker.",
    );

    // Vitest's dynamic `list` command evaluates the target test module and registers its suites,
    // but does not run tests or lifecycle hooks. It uses the exact same Vitest config, project,
    // Node entry point and isolated environment as the destructive `run` below.
    const collection = await runM23Child(
      "node",
      [VITEST_ENTRY, "list", TEST_FILE, `--json=${collectionReportPath}`],
      {
        cwd: ROOT,
        env: {
          ...vitestEnvironment,
          CHARTWARDEN_M23_RLS_DIAGNOSTIC: "true",
          CHARTWARDEN_M23_RLS_DIAGNOSTIC_STAGE: "collection",
        },
        timeoutMs: 60_000,
      },
    );
    let collectionDiagnostic: ReturnType<typeof parseM23TargetModuleDiagnosticJson>;
    try {
      collectionDiagnostic = parseM23TargetModuleDiagnosticJson(
        readFileSync(collectionDiagnosticPath, "utf8"),
      );
    } catch (error) {
      throw new Error("M23 target module did not produce its safe collection diagnostic", {
        cause: error,
      });
    }
    if (!isM23TargetModuleEnvironmentSafe(collectionDiagnostic)) {
      throw new Error(
        `M23 target module guard preflight failed under collection (marker=${collectionDiagnostic.isolatedMarkerState}, databaseUrl=${collectionDiagnostic.privateDatabaseUrlPresent}, clusterIdentity=${collectionDiagnostic.clusterIdentityMarkersWellFormed}, decision=${collectionDiagnostic.moduleGuardDecision}); live database hooks were not started`,
      );
    }
    if (collection.status !== 0) {
      throw new Error("M23 dynamic collection failed; live database hooks were not started");
    }
    let collectedTests: M23CollectedTest[];
    try {
      const parsed: unknown = JSON.parse(readFileSync(collectionReportPath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      collectedTests = parsed as M23CollectedTest[];
    } catch (error) {
      throw new Error("M23 dynamic collection did not produce a valid test list", { cause: error });
    }
    validateM23DynamicCollection({
      tests: collectedTests,
      expectedFile: resolve(ROOT, TEST_FILE),
      expectedProject: "node",
      expectedNames: EXPECTED_M23_ASSERTIONS,
    });
    console.log(
      `M23 dynamic collection passed: target module evaluated; isolated marker present and true; module guard allows suite registration; private URL and cluster identity markers present; ${collectedTests.length} test names registered in project node. Collection does not establish Vitest's effective task mode. No hooks, test bodies, migrations, or database connections were executed during collection.`,
    );

    const child = await runM23Child(
      "node",
      [
        VITEST_ENTRY,
        "run",
        TEST_FILE,
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
      ],
      {
        cwd: ROOT,
        env: {
          ...vitestEnvironment,
          CHARTWARDEN_M23_RLS_DIAGNOSTIC: "true",
          CHARTWARDEN_M23_RLS_DIAGNOSTIC_STAGE: "execution",
        },
        timeoutMs: 240_000,
      },
    );
    const runDiagnostic = parseM23TargetModuleDiagnosticJson(
      readFileSync(runDiagnosticPath, "utf8"),
    );
    if (
      !isM23TargetModuleEnvironmentSafe(runDiagnostic) ||
      JSON.stringify(runDiagnostic) !== JSON.stringify(collectionDiagnostic)
    ) {
      throw new Error(
        "M23 target-module execution environment differed from the successful dynamic collection; qualification is failed",
      );
    }
    console.log(
      "M23 execution module confirmed: isolated marker true, private database URL present, cluster identity valid; module-level skip condition is false.",
    );

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
      try {
        const setupStage: unknown = JSON.parse(readFileSync(setupDiagnosticPath, "utf8"));
        if (
          setupStage &&
          typeof setupStage === "object" &&
          "phase" in setupStage &&
          typeof setupStage.phase === "string" &&
          [
            "connecting",
            "identity",
            "reset_schema",
            "migration",
            "organizations",
            "seed_a",
            "seed_b",
            "partitions_a",
            "partitions_b",
            "evidence_a",
            "evidence_b",
            "complete",
          ].includes(setupStage.phase) &&
          (!("step" in setupStage) ||
            (typeof setupStage.step === "number" &&
              Number.isSafeInteger(setupStage.step) &&
              setupStage.step >= 0 &&
              setupStage.step <= 10_000))
        ) {
          const progress = setupStage as { phase: string; step?: number };
          console.error(
            `  Last setup stage: ${progress.phase}${progress.step === undefined ? "" : `, step ${progress.step}`}.`,
          );
        } else {
          console.error("  Setup stage diagnostic was invalid; raw details withheld.");
        }
      } catch {
        console.error("  Setup stage diagnostic was unavailable.");
      }
      const safeExecutionDetails = new Set(
        [child.stdout, child.stderr]
          .filter((output): output is string => Boolean(output?.trim()))
          .flatMap(summarizeVitestFailureMessage),
      );
      if (safeExecutionDetails.size > 0) {
        console.error("  Execution diagnostics (allowlisted; raw details withheld):");
        for (const detail of safeExecutionDetails) console.error(`    ${detail}`);
      }
    }
    console.log(
      `M23 live result: total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}.`,
    );
    if (!qualified) {
      if (isM23SuiteEntirelySkipped({ total, passed, failed, pending: skipped, todo })) {
        console.error(
          "All M23 RLS tests were pending/skipped although the exact target module guard allowed suite registration at collection and execution; review sanitized hook/setup diagnostics below.",
        );
      }
      for (const file of report.testResults ?? []) {
        const nonPassed = (file.assertionResults ?? []).filter((test) => test.status !== "passed");
        if (file.status !== "passed" || nonPassed.length > 0) {
          console.error(
            `Vitest file status: ${file.status ?? "unknown"} (${file.name ?? "unnamed"})`,
          );
          const suiteDiagnostics = new Set([
            ...(file.message ? summarizeVitestFailureMessage(file.message) : []),
            ...nonPassed.flatMap((test) =>
              (test.failureMessages ?? []).flatMap(summarizeVitestFailureMessage),
            ),
          ]);
          if (suiteDiagnostics.size > 0) {
            console.error("  Suite failure diagnostic (allowlisted; raw details withheld):");
            for (const line of suiteDiagnostics) console.error(`    ${line}`);
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
