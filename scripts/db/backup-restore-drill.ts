/**
 * scripts/db/backup-restore-drill.ts — pgBackRest restore drill (TASK-040G, OPS-014).
 *
 * Proves the pgBackRest backup+restore MECHANICS end-to-end against a throwaway, disposable local
 * Postgres cluster: seed deterministic rows, take a full backup (repo1, local disk), stop the
 * source, restore into a SEPARATE fresh data directory, start it, and assert the restored row count
 * + checksum match the source exactly. Mirrors the monthly restore-drill procedure in
 * CHARTWARDEN_DR_BCP_v0.1.md §8.2, automated and scoped to what a laptop/CI runner can actually exercise.
 *
 * SCOPE (see §4.1 for the full spec; ops/pgbackrest/pgbackrest.conf.template for the doc-matching
 * production config): this drill exercises repo1 (local disk) ONLY.
 *   - repo2 (on-prem backup VM, §4.1.1) has no real host in any environment this repo has ever run
 *     in — there is nothing to point it at.
 *   - repo3 (off-site S3-compatible — MinIO, per TASK-040F's docker-compose.yml and this task's own
 *     go-ahead) needs pgBackRest's S3 driver to negotiate TLS; the local dev MinIO container
 *     deliberately runs plain http:// (matching the app's own zero-dep SigV4 adapter in
 *     apps/backend/src/modules/22-documents/seams/s3-object-store.ts), so exercising that path live
 *     needs either a TLS-terminating MinIO or a real cloud target — neither of which this task's
 *     acceptance criteria requires ("a scripted backup + restore round-trip against a local
 *     disposable Postgres"). This script does NOT claim the full 3-repo topology is exercised.
 *
 * Requires `pgbackrest` and PostgreSQL 18 server/client binaries on PATH (or POSTGRES_BIN_DIR
 * pointing at their directory) — this script shells out to real OS binaries, unlike the rest of
 * scripts/db/*.ts (which only ever speak to Postgres over the wire via the `pg` client); there is no
 * way to drive pgBackRest or initdb/pg_ctl through a database connection alone.
 *   macOS:  brew install pgbackrest postgresql@18
 *
 * Run: bun run backup:restore-drill
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

const STANZA = "chartwarden_drill";
const PORT = Number(process.env.CHARTWARDEN_DRILL_PG_PORT ?? 55432);
const PROBE_ROWS = 500;

function pgBinDir(): string {
  const override = process.env.POSTGRES_BIN_DIR;
  if (override) return override;
  for (const candidate of [
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ]) {
    try {
      execFileSync(join(candidate, "initdb"), ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next candidate; falls through to bare command names below
    }
  }
  return ""; // rely on PATH
}

function bin(dir: string, name: string): string {
  return dir ? join(dir, name) : name;
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function waitForReady(hostArg: string, port: number, binDir: string, timeoutMs = 15_000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      run(bin(binDir, "pg_isready"), ["-h", hostArg, "-p", String(port)]);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Postgres on port ${port} never became ready`);
      Bun.sleepSync(300);
    }
  }
}

async function probeChecksum(client: Client): Promise<{ rows: number; checksum: string }> {
  const { rows } = await client.query<{ n: number; checksum: string }>(
    "SELECT count(*)::int AS n, md5(coalesce(string_agg(val, ',' ORDER BY id), '')) AS checksum FROM drill_probe",
  );
  return { rows: rows[0]!.n, checksum: rows[0]!.checksum };
}

async function main(): Promise<void> {
  const binDir = pgBinDir();
  try {
    run(bin(binDir, "initdb"), ["--version"]);
  } catch {
    throw new Error(
      "initdb not found. Install PostgreSQL 18 (macOS: brew install postgresql@18) or set POSTGRES_BIN_DIR.",
    );
  }
  try {
    run("pgbackrest", ["version"]);
  } catch {
    throw new Error("pgbackrest not found. Install it (macOS: brew install pgbackrest) and retry.");
  }

  const work = mkdtempSync(join(tmpdir(), "chartwarden-backup-drill-"));
  // A Unix-domain socket path is capped at ~103 bytes on macOS — `work` (under the OS tmpdir) can
  // exceed that, so the socket directory is a short, separate path under /tmp, not `work` itself.
  const sockDir = join("/tmp", `chartwarden-drill-sock-${process.pid}`);
  const sourceData = join(work, "source-data");
  const restoreData = join(work, "restore-data");
  const repo1 = join(work, "repo1");
  const confPath = join(work, "pgbackrest.conf");
  const logPath = join(work, "pgbackrest-log");
  mkdirSync(sockDir, { recursive: true });
  mkdirSync(repo1, { recursive: true });
  mkdirSync(logPath, { recursive: true });

  let sourceStarted = false;
  let restoreStarted = false;
  try {
    console.log(`Work dir: ${work}`);
    console.log("• initdb (source cluster) …");
    run(bin(binDir, "initdb"), [
      "-D",
      sourceData,
      "-U",
      "postgres",
      "-A",
      "trust",
      "--no-locale",
      "-E",
      "UTF8",
    ]);

    appendFileSync(
      join(sourceData, "postgresql.conf"),
      `\nport = ${PORT}\nunix_socket_directories = '${sockDir}'\narchive_mode = on\narchive_command = 'pgbackrest --config=${confPath} --stanza=${STANZA} archive-push %p'\nwal_level = replica\n`,
    );

    // repo1 ONLY — see the file header for why repo2/repo3 are out of scope for a live run.
    Bun.write(
      confPath,
      `[global]\nrepo1-path=${repo1}\nrepo1-retention-full=2\nlog-path=${logPath}\nlog-level-console=info\nlog-level-file=detail\nstart-fast=y\n\n[${STANZA}]\npg1-path=${sourceData}\npg1-port=${PORT}\npg1-socket-path=${sockDir}\npg1-user=postgres\nrecovery-option=recovery_target_action=promote\n`,
    );

    console.log("• starting source cluster …");
    run(bin(binDir, "pg_ctl"), ["-D", sourceData, "-l", join(work, "source.log"), "start"]);
    sourceStarted = true;
    waitForReady(sockDir, PORT, binDir);

    console.log("• pgbackrest stanza-create …");
    run("pgbackrest", ["--config", confPath, "--stanza", STANZA, "stanza-create"]);

    console.log(`• seeding ${PROBE_ROWS} deterministic rows …`);
    const seedClient = new Client({
      host: sockDir,
      port: PORT,
      user: "postgres",
      database: "postgres",
    });
    await seedClient.connect();
    await seedClient.query("CREATE TABLE drill_probe (id serial PRIMARY KEY, val text NOT NULL)");
    await seedClient.query(
      "INSERT INTO drill_probe (val) SELECT 'row-' || g FROM generate_series(1, $1) AS g",
      [PROBE_ROWS],
    );
    const source = await probeChecksum(seedClient);
    await seedClient.end();
    console.log(`  source: ${source.rows} rows, checksum ${source.checksum}`);

    console.log("• pgbackrest --type=full backup (repo1) …");
    run("pgbackrest", ["--config", confPath, "--stanza", STANZA, "--type", "full", "backup"]);

    console.log("• stopping source cluster …");
    run(bin(binDir, "pg_ctl"), ["-D", sourceData, "-m", "fast", "stop"]);
    sourceStarted = false;

    console.log("• pgbackrest restore → fresh directory …");
    mkdirSync(restoreData, { recursive: true });
    run("pgbackrest", [
      "--config",
      confPath,
      "--stanza",
      STANZA,
      "--pg1-path",
      restoreData,
      "restore",
    ]);

    console.log("• starting restored cluster …");
    run(bin(binDir, "pg_ctl"), ["-D", restoreData, "-l", join(work, "restore.log"), "start"]);
    restoreStarted = true;
    waitForReady(sockDir, PORT, binDir);

    const verifyClient = new Client({
      host: sockDir,
      port: PORT,
      user: "postgres",
      database: "postgres",
    });
    await verifyClient.connect();
    const restored = await probeChecksum(verifyClient);
    await verifyClient.end();
    console.log(`  restored: ${restored.rows} rows, checksum ${restored.checksum}`);

    if (restored.rows !== source.rows || restored.checksum !== source.checksum) {
      throw new Error(
        `RESTORE DRILL FAILED: source (${source.rows} rows, ${source.checksum}) != ` +
          `restored (${restored.rows} rows, ${restored.checksum})`,
      );
    }
    console.log("✓ restore drill passed: row count + checksum match exactly.");
  } finally {
    console.log("• tearing down …");
    if (restoreStarted) {
      try {
        run(bin(binDir, "pg_ctl"), ["-D", restoreData, "-m", "immediate", "stop"]);
      } catch {
        // best-effort teardown
      }
    }
    if (sourceStarted) {
      try {
        run(bin(binDir, "pg_ctl"), ["-D", sourceData, "-m", "immediate", "stop"]);
      } catch {
        // best-effort teardown
      }
    }
    rmSync(work, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
