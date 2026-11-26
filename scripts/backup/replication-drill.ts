#!/usr/bin/env bun
/**
 * Streaming-replication drill (CW-CP-01), end to end on PRIVATE containers only.
 *
 *   bun run backup:replication-drill            # writes audit/restore-drill/<date>-replication-drill.{md,json}
 *
 * What it runs is the production config, not a copy of it: the `postgres` command of deploy/production/compose.replication.yml
 * and the `standby` command of deploy/production/db-replication/compose.standby.yml (read with js-yaml), the image built
 * from deploy/production/backup/, db-replication/make-certs.sh, provision-primary.sh, standby-bootstrap.sh and
 * replication-monitor.sh, each in a one-shot container hardened like the compose service (no capabilities, read-only root).
 * Only the pgBackRest repository differs: production restores the standby from the off-site S3 repository, the drill from a
 * local one (`STANDBY_RESTORE_REPO=1`), because the S3 path is what `bun run backup:coordinated-drill` proves.
 *
 *   1. primary (TLS on, archiving to a local pgBackRest repo), a full backup, synthetic rows
 *   2. provision-primary.sh twice (idempotent), then the access controls: replication works ONLY over TLS with a client
 *      certificate this CA signed for the role; plain text, no certificate, another CA's certificate, a wrong CN and a
 *      normal login as the role are all refused, and every other login (password over TCP, the socket) still works
 *   3. standby-bootstrap.sh (pgbackrest --type=standby), the standby starts, streams over TLS from the slot; rows written
 *      before the backup, between backup and standby, and while streaming all arrive; the WALL clock of each phase is recorded
 *   4. the monitor: healthy is silent; a stopped standby with WAL piling up raises standby_absent and slot_wal_retained, is
 *      rate-limited on the next pass, and clears when the standby is back; an unreadable primary raises monitor_blind
 *   5. promotion rehearsal (DR/BCP 6.1): the standby promotes, takes a write and holds every row
 *
 * Never touches the shared Docker cluster: every container, volume and network is created here, labelled with the run
 * id and removed at the end. Needs docker (images are built from the working tree unless WX_BACKUP_IMAGE names one), bun, openssl.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChecks } from "../lib/backup/drill-report";
import { postgresSettings, serviceCommand } from "../lib/replication/compose-command";
import { POSTGRES_IMAGE, ensurePostgresImage, sleep } from "../lib/restore-drill/docker";
import { type Check, summarise } from "../lib/restore-drill/report";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD = join(REPO, "deploy", "production");
const REPL_DIR = join(PROD, "db-replication");
const LABEL = "cw-replication-drill";
const DB = "chartwarden";
const PRIMARY_HOST = "primary.drill.test";
const SUPERUSER_PW = `drill-${randomBytes(6).toString("hex")}`;
const WAIT_MS = 120_000;
const SCRIPTS_MOUNT = "/usr/local/share/cw-replication";

interface Run {
  readonly status: number;
  readonly stdout: string;
  /** stdout + stderr, for error messages and the alert assertions. */
  readonly out: string;
}

function run(cmd: string, args: readonly string[]): Run {
  const res = spawnSync(cmd, [...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function sh(cmd: string, args: readonly string[]): Run {
  const res = run(cmd, args);
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 5).join(" ")} failed (${res.status}): ${res.out.trim().slice(-1200)}`,
    );
  }
  return res;
}

const hex = (n: number): string => randomBytes(n).toString("hex");
const ms = (since: number): number => Math.round(performance.now() - since);

async function waitFor(what: string, probe: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await Promise.resolve(probe()).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`${what} not ready within ${WAIT_MS / 1000}s`);
}

interface ReplicationDrillRecord {
  readonly runId: string;
  readonly startedAt: string;
  readonly scale: string;
  readonly tooling: Readonly<Record<string, string>>;
  readonly primarySettings: Readonly<Record<string, string>>;
  readonly standbySettings: Readonly<Record<string, string>>;
  readonly timingsMs: Readonly<Record<string, number>>;
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

function renderMarkdown(r: ReplicationDrillRecord): string {
  const settings = (s: Readonly<Record<string, string>>): string[] =>
    Object.entries(s).map(([k, v]) => `- \`${k}=${v}\``);
  return [
    `# Streaming replication drill - ${r.passed ? "PASS" : "FAIL"}`,
    "",
    "> **Synthetic scale, private containers on one machine.** It proves the replication configuration (TLS and client",
    "> certificate auth, the slot, hot standby, the monitor's alerts, promotion). It does not size production. NOT proven",
    "> here: the standby is restored from a local pgBackRest repository, so a standby bootstrap from the off-site S3",
    "> repository is not exercised (the coordinated drill proves an off-site restore, with a different recovery type); the",
    "> restore_command fallback (catching up from the WAL archive) is configured and asserted, never forced; and nothing",
    "> reaches a real alert receiver (the monitor's alerts are asserted from its own output).",
    "",
    `Run ${r.runId} at ${r.startedAt}. Scale: ${r.scale}.`,
    "",
    "## Tooling",
    ...Object.entries(r.tooling).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "## Primary settings under test (compose.replication.yml)",
    ...settings(r.primarySettings),
    "",
    "## Standby settings under test (db-replication/compose.standby.yml)",
    ...settings(r.standbySettings),
    "",
    "## Timings (synthetic scale)",
    "| phase | wall |",
    "|---|---|",
    ...Object.entries(r.timingsMs).map(([k, v]) => `| ${k} | ${(v / 1000).toFixed(1)} s |`),
    "",
    "## Checks",
    renderChecks(r.checks),
    "",
  ].join("\n");
}

async function main(): Promise<number> {
  const runId = hex(3);
  const startedAt = new Date().toISOString();
  const p = `cwrepl-${runId}`;
  const net = `${p}-net`;
  const vol = {
    pgdata: `${p}-pgdata`,
    sock: `${p}-sock`,
    repo: `${p}-repo`,
    secrets: `${p}-secrets`,
    standby: `${p}-standby`,
    mon: `${p}-mon`,
  };
  const work = mkdtempSync(join(tmpdir(), `${p}-`));
  const image = process.env.WX_BACKUP_IMAGE ?? `chartwarden-backup:${p}`;
  const checks: Check[] = [];
  const timings: Record<string, number> = {};
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `: ${detail}`}`);
  };
  console.log(`replication drill ${runId}`);
  try {
    if (!process.env.WX_BACKUP_IMAGE) {
      ensurePostgresImage();
      sh("docker", [
        "build",
        "-q",
        "-t",
        image,
        "--build-arg",
        `POSTGRES_IMAGE=${POSTGRES_IMAGE}`,
        join(PROD, "backup"),
      ]);
    }
    const tooling = {
      pgbackrest: sh("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "pgbackrest",
        image,
        "version",
      ]).out.trim(),
      postgres: sh("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "postgres",
        image,
        "--version",
      ]).out.trim(),
    };
    const primaryCommand = serviceCommand(join(PROD, "compose.replication.yml"), "postgres");
    const standbyCommand = serviceCommand(join(REPL_DIR, "compose.standby.yml"), "standby");

    // --- certificates: the production script, a second CA for the negative controls, a wrong-CN leaf from the real CA
    const certs = join(work, "certs");
    sh("bash", [join(REPL_DIR, "make-certs.sh"), certs, PRIMARY_HOST, "2"]);
    const foreign = join(work, "foreign");
    sh("bash", [join(REPL_DIR, "make-certs.sh"), foreign, PRIMARY_HOST, "2"]);
    cpSync(join(foreign, "replication_client_cert"), join(certs, "foreignca_client_cert"));
    cpSync(join(foreign, "replication_client_key"), join(certs, "foreignca_client_key"));
    sh("openssl", [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-out",
      join(certs, "wrongcn_client_key"),
    ]);
    sh("openssl", [
      "req",
      "-new",
      "-key",
      join(certs, "wrongcn_client_key"),
      "-subj",
      "/CN=someone_else",
      "-out",
      join(work, "wrongcn.csr"),
    ]);
    writeFileSync(
      join(work, "wrongcn.ext"),
      "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n",
    );
    sh("openssl", [
      "x509",
      "-req",
      "-in",
      join(work, "wrongcn.csr"),
      "-CA",
      join(certs, "replication_ca.crt"),
      "-CAkey",
      join(`${certs}.ca`, "replication_ca.key"),
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      join(work, "wrongcn.ext"),
      "-out",
      join(certs, "wrongcn_client_cert"),
    ]);

    const conf = join(work, "pgbackrest.conf");
    writeFileSync(
      conf,
      [
        "[global]",
        "repo1-path=/var/lib/pgbackrest",
        "repo1-retention-full=2",
        "start-fast=y",
        "archive-async=n",
        "log-level-console=info",
        "log-level-file=off",
        "",
        "[chartwarden]",
        "pg1-path=/var/lib/postgresql/18/docker",
        "pg1-socket-path=/var/run/postgresql",
        "",
      ].join("\n"),
    );
    chmodSync(conf, 0o644);

    // A /24 of our own, so the standby has a fixed address the pg_hba rule can be pinned to (and a second address can be
    // refused). 10.100-199.x.0/24 is tried at random until Docker accepts one that overlaps nothing it already has.
    let subnet = "";
    for (let attempt = 0; attempt < 12 && !subnet; attempt += 1) {
      const candidate = `10.${100 + Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 256)}`;
      const made = run("docker", [
        "network",
        "create",
        "--label",
        `${LABEL}=${runId}`,
        "--subnet",
        `${candidate}.0/24`,
        net,
      ]);
      if (made.status === 0) subnet = candidate;
    }
    if (!subnet) throw new Error("no free /24 for the drill network");
    const standbyIp = `${subnet}.10`;
    const otherIp = `${subnet}.11`;
    // Docker takes a secret from the CLI's own environment with a bare `-e NAME`, so none of these reach an argv.
    process.env.POSTGRES_PASSWORD = SUPERUSER_PW;
    process.env.PGPASSWORD = SUPERUSER_PW;
    for (const v of Object.values(vol))
      sh("docker", ["volume", "create", "--label", `${LABEL}=${runId}`, v]);
    sh("docker", [
      "run",
      "--rm",
      "--user",
      "root",
      "--entrypoint",
      "sh",
      "-v",
      `${vol.secrets}:/dst`,
      "-v",
      `${certs}:/src:ro`,
      image,
      "-c",
      "cd /src && cp replication_ca replication_server_cert replication_server_key replication_client_cert replication_client_key foreignca_client_cert foreignca_client_key wrongcn_client_cert wrongcn_client_key /dst/ && chown 999:999 /dst/* && chmod 0400 /dst/*",
    ]);
    sh("docker", [
      "run",
      "--rm",
      "--user",
      "root",
      "--entrypoint",
      "sh",
      "-v",
      `${vol.mon}:/state`,
      image,
      "-c",
      "chown 999:999 /state",
    ]);

    // --- 1. the primary, started with the overlay's own command
    const label = ["--label", `${LABEL}=${runId}`];
    const confMount = ["-v", `${conf}:/etc/pgbackrest/pgbackrest.conf:ro`];
    const primary = `${p}-primary`;
    const standby = `${p}-standby`;
    sh("docker", [
      "run",
      "-d",
      "--name",
      primary,
      ...label,
      "--network",
      net,
      "--network-alias",
      PRIMARY_HOST,
      "--init",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      `POSTGRES_DB=${DB}`,
      "-v",
      `${vol.pgdata}:/var/lib/postgresql`,
      "-v",
      `${vol.sock}:/var/run/postgresql`,
      "-v",
      `${vol.repo}:/var/lib/pgbackrest`,
      "-v",
      `${vol.secrets}:/run/secrets:ro`,
      ...confMount,
      "--entrypoint",
      "/usr/local/bin/docker-entrypoint.sh",
      image,
      ...primaryCommand,
    ]);
    const sql = (container: string, query: string): string =>
      sh("docker", [
        "exec",
        container,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-h",
        "/var/run/postgresql",
        "-U",
        "postgres",
        "-d",
        DB,
        "-c",
        query,
      ]).stdout.trim();
    const trySql = (container: string, query: string): string => {
      const r = run("docker", [
        "exec",
        container,
        "psql",
        "-X",
        "-At",
        "-h",
        "/var/run/postgresql",
        "-U",
        "postgres",
        "-d",
        DB,
        "-c",
        query,
      ]);
      return r.status === 0 ? r.stdout.trim() : "";
    };
    // The image's init phase answers on the socket only: two consecutive loopback TCP successes mean the real server is up.
    let streak = 0;
    await waitFor("the primary", () => {
      const r = run("docker", [
        "exec",
        primary,
        "psql",
        "-X",
        "-At",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        DB,
        "-c",
        "SELECT 1",
      ]);
      streak = r.status === 0 ? streak + 1 : 0;
      return streak >= 2;
    });
    const pgbackrest = (...args: string[]): Run =>
      sh("docker", [
        "exec",
        "-u",
        "postgres",
        primary,
        "pgbackrest",
        "--stanza=chartwarden",
        ...args,
      ]);
    pgbackrest("stanza-create");
    sql(primary, "CREATE TABLE cp01_probe (id bigint PRIMARY KEY, note text NOT NULL)");
    sql(
      primary,
      "INSERT INTO cp01_probe SELECT g, 'synthetic row ' || g FROM generate_series(1, 1000) g",
    );

    const oneShot = (extra: readonly string[], script: string, ...args: readonly string[]): Run =>
      run("docker", [
        "run",
        "--rm",
        ...label,
        "--user",
        "postgres",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--entrypoint",
        "bash",
        ...(extra.includes("--network") ? [] : ["--network", net]),
        "-v",
        `${REPL_DIR}:${SCRIPTS_MOUNT}:ro`,
        ...extra,
        image,
        `${SCRIPTS_MOUNT}/${script}`,
        ...args,
      ]);
    // Like the compose service: no network (it reaches Postgres through the socket volume), the standby's address as a /32.
    const provisionMounts = [
      "--network",
      "none",
      "-v",
      `${vol.sock}:/var/run/postgresql`,
      "-v",
      `${vol.pgdata}:/var/lib/postgresql`,
      "-e",
      `CHARTWARDEN_DB_NAME=${DB}`,
      "-e",
      "REPLICATION_ROLE=cw_replicator",
      "-e",
      "REPLICATION_SLOT=cw_standby",
      "-e",
      `REPLICATION_STANDBY_CIDR=${standbyIp}/32`,
    ];

    // --- 2. provisioning, idempotent, and the access controls
    const first = oneShot(provisionMounts, "provision-primary.sh");
    const second = oneShot(provisionMounts, "provision-primary.sh");
    check(
      "provision-primary.sh creates the role, the slot and the pg_hba block",
      first.status === 0 && /replication provisioned/.test(first.out),
      first.out.trim().slice(-300),
    );
    check(
      "a second provision-primary.sh run changes nothing",
      second.status === 0 && /already carries the managed block/.test(second.out),
      second.out.trim().slice(-300),
    );
    const hbaRules = sql(
      primary,
      "SELECT line_number || ':' || type || ':' || database::text || ':' || user_name::text || ':' || auth_method FROM pg_hba_file_rules ORDER BY line_number LIMIT 5",
    );
    check(
      "the managed pg_hba block is first: hostssl replication cert, then the two rejects",
      /^\d+:hostssl:\{replication\}:\{cw_replicator\}:cert\n\d+:host:\{replication\}:\{cw_replicator\}:reject\n\d+:host:\{all\}:\{cw_replicator\}:reject\n/.test(
        `${hbaRules}\n`,
      ),
      hbaRules,
    );
    check(
      "the pg_hba block appears once and the file has no invalid line",
      sql(primary, "SELECT count(*) FROM pg_hba_file_rules WHERE auth_method = 'cert'") === "1" &&
        sql(primary, "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL") === "0",
      "see pg_hba_file_rules",
    );
    check(
      "the replication role has REPLICATION, no password, no other attribute and a connection limit of 2",
      sql(
        primary,
        "SELECT rolreplication AND rolpassword IS NULL AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND rolconnlimit = 2 FROM pg_authid WHERE rolname = 'cw_replicator'",
      ) === "t",
      "pg_authid",
    );
    check(
      "the cert rule is pinned to the standby's address (a /32), not to every address",
      sql(
        primary,
        "SELECT address || '|' || netmask FROM pg_hba_file_rules WHERE auth_method = 'cert'",
      ) === `${standbyIp}|255.255.255.255`,
      sql(
        primary,
        "SELECT address || '|' || netmask FROM pg_hba_file_rules WHERE auth_method = 'cert'",
      ),
    );

    const clientBase = (cert: string, key: string, mode = "verify-full"): string =>
      `host=${PRIMARY_HOST} port=5432 user=cw_replicator sslmode=${mode} sslrootcert=/s/replication_ca${cert ? ` sslcert=/s/${cert} sslkey=/s/${key}` : ""}`;
    // From a given address of the drill network (the standby's by default); PGPASSWORD is passed through, never in argv.
    const probe = (conninfo: string, query: string, ip = standbyIp): Run =>
      run("docker", [
        "run",
        "--rm",
        ...label,
        "--network",
        net,
        "--ip",
        ip,
        "-e",
        "PGPASSWORD",
        "--user",
        "postgres",
        "-v",
        `${vol.secrets}:/s:ro`,
        "--entrypoint",
        "psql",
        image,
        conninfo,
        "-X",
        "-At",
        "-c",
        query,
      ]);
    const goodConn = `${clientBase("replication_client_cert", "replication_client_key")} replication=yes`;
    const positive = probe(goodConn, "IDENTIFY_SYSTEM");
    check(
      "replication connects over verified TLS with the client certificate, from the standby's address",
      positive.status === 0,
      positive.out.trim().slice(-300),
    );
    // "rejects connection" for a normal connection, "rejects replication connection" for a physical replication one.
    const rejected = /pg_hba\.conf rejects (replication )?connection/;
    const negatives: ReadonlyArray<readonly [string, string, string, RegExp, string?]> = [
      [
        "replication in plain text is refused (no TLS)",
        `host=${PRIMARY_HOST} port=5432 user=cw_replicator sslmode=disable replication=yes`,
        "IDENTIFY_SYSTEM",
        rejected,
      ],
      [
        "replication over TLS without a client certificate is refused",
        `${clientBase("", "")} replication=yes`,
        "IDENTIFY_SYSTEM",
        /certificate/i,
      ],
      [
        "a client certificate from another CA is refused",
        `${clientBase("foreignca_client_cert", "foreignca_client_key")} replication=yes`,
        "IDENTIFY_SYSTEM",
        /certificate|SSL error/i, // the TLS layer refuses it before pg_hba is consulted
      ],
      [
        "a certificate from our CA whose CN is not the role is refused",
        `${clientBase("wrongcn_client_cert", "wrongcn_client_key")} replication=yes`,
        "IDENTIFY_SYSTEM",
        /certificate authentication failed/,
      ],
      [
        "the right certificate from any other address is refused (the rule is pinned to the standby)",
        goodConn,
        "IDENTIFY_SYSTEM",
        rejected,
        otherIp,
      ],
      [
        "a logical (replication=database) connection by the role is refused",
        `${clientBase("replication_client_cert", "replication_client_key")} replication=database dbname=${DB}`,
        "SELECT 1",
        rejected,
      ],
      [
        "the replication role cannot log in as a normal user",
        `${clientBase("replication_client_cert", "replication_client_key")} dbname=${DB}`,
        "SELECT 1",
        rejected,
      ],
    ];
    for (const [name, conninfo, query, expected, ip] of negatives) {
      const r = probe(conninfo, query, ip);
      check(name, r.status !== 0 && expected.test(r.out), r.out.trim().slice(-300));
    }
    const password = probe(
      `host=${PRIMARY_HOST} port=5432 user=postgres dbname=${DB} sslmode=disable`,
      "SELECT 'app-login-ok'",
      otherIp,
    );
    const passwordTls = probe(
      `host=${PRIMARY_HOST} port=5432 user=postgres dbname=${DB} sslmode=require`,
      "SELECT 'app-login-ok'",
      otherIp,
    );
    check(
      "password logins still work over TCP, with and without TLS (the existing clients are untouched)",
      password.stdout.trim() === "app-login-ok" && passwordTls.stdout.trim() === "app-login-ok",
      `${password.out}${passwordTls.out}`.trim().slice(-300),
    );
    check(
      "the local socket login the backup sidecar uses still works",
      sql(primary, "SELECT 'socket-ok'") === "socket-ok",
      "psql over the socket",
    );

    // --- 3. backup, rows in between, standby bootstrap and streaming
    let t = performance.now();
    pgbackrest("--type=full", "backup");
    timings["full base backup (synthetic scale)"] = ms(t);
    sql(
      primary,
      "INSERT INTO cp01_probe SELECT g, 'between backup and standby ' || g FROM generate_series(1001, 1500) g",
    );
    t = performance.now();
    const bootstrapMounts = [
      "-v",
      `${vol.standby}:/var/lib/postgresql`,
      "-v",
      `${vol.repo}:/var/lib/pgbackrest`,
      "-v",
      `${vol.secrets}:/run/secrets:ro`,
      ...confMount,
    ];
    const bootstrap = oneShot(
      [
        ...bootstrapMounts,
        "--tmpfs",
        "/var/spool/pgbackrest:uid=999,gid=999,mode=0700",
        "--tmpfs",
        "/var/run/postgresql:uid=999,gid=999,mode=0700",
        "-e",
        `STANDBY_PRIMARY_HOST=${PRIMARY_HOST}`,
        "-e",
        "STANDBY_RESTORE_REPO=1",
        "-e",
        "BACKUP_PG_STANZA=chartwarden",
      ],
      "standby-bootstrap.sh",
    );
    timings["standby-bootstrap.sh (pgbackrest --type=standby restore)"] = ms(t);
    check(
      "standby-bootstrap.sh restores the standby data directory",
      bootstrap.status === 0 && /standby data directory ready/.test(bootstrap.out),
      bootstrap.out.trim().slice(-400),
    );
    const rerun = oneShot(
      [...bootstrapMounts, "-e", `STANDBY_PRIMARY_HOST=${PRIMARY_HOST}`],
      "standby-bootstrap.sh",
    );
    check(
      "a second standby-bootstrap.sh leaves the existing cluster alone",
      rerun.status === 0 && /nothing to restore/.test(rerun.out),
      rerun.out.trim().slice(-300),
    );

    t = performance.now();
    sh("docker", [
      "run",
      "-d",
      "--name",
      standby,
      ...label,
      "--network",
      net,
      "--ip",
      standbyIp,
      "--init",
      ...bootstrapMounts,
      "--entrypoint",
      "/usr/local/bin/docker-entrypoint.sh",
      image,
      ...standbyCommand,
    ]);
    const streaming = (): boolean =>
      trySql(
        primary,
        "SELECT count(*) FROM pg_stat_replication r JOIN pg_replication_slots s ON s.active_pid = r.pid WHERE s.slot_name = 'cw_standby' AND r.state = 'streaming'",
      ) === "1";
    await waitFor("the standby to stream from the slot", streaming);
    timings["standby start to streaming"] = ms(t);
    check("the standby streams from the slot cw_standby", streaming(), "pg_stat_replication");
    check(
      "the walsender connection negotiated TLS 1.3 with the client certificate's CN",
      (() => {
        const seen = trySql(
          primary,
          "SELECT CASE WHEN s.ssl THEN 'tls' ELSE 'plain' END || '|' || coalesce(s.version, '') || '|' || coalesce(s.client_dn, '') FROM pg_stat_ssl s JOIN pg_stat_replication r USING (pid) LIMIT 1",
        );
        return /^tls\|TLSv1\.3\|.*CN=cw_replicator/.test(seen);
      })(),
      "pg_stat_ssl",
    );
    const count = (c: string, table = "cp01_probe"): string =>
      trySql(c, `SELECT count(*) FROM ${table}`);
    check(
      "rows from before the backup and from between backup and standby are on the standby",
      count(standby) === "1500",
      `standby has ${count(standby)} of 1500 rows`,
    );
    t = performance.now();
    sql(
      primary,
      "INSERT INTO cp01_probe SELECT g, 'while streaming ' || g FROM generate_series(1501, 2000) g",
    );
    await waitFor("rows to replicate", () => count(standby) === "2000");
    timings["write on the primary visible on the standby"] = ms(t);
    check(
      "a write on the primary reaches the standby while streaming",
      count(standby) === "2000",
      `standby has ${count(standby)} of 2000 rows`,
    );
    const sb = (k: string): string => trySql(standby, `SHOW ${k}`);
    check(
      "the standby is in recovery with the intended recovery settings",
      trySql(standby, "SELECT pg_is_in_recovery()") === "t" &&
        sb("primary_slot_name") === "cw_standby" &&
        /archive-get/.test(sb("restore_command")) &&
        /sslmode=verify-full/.test(sb("primary_conninfo")) &&
        sb("archive_mode") === "off" &&
        sb("hot_standby") === "on" &&
        sb("log_connections") !== "off" &&
        sb("log_disconnections") === "on",
      `slot=${sb("primary_slot_name")} archive_mode=${sb("archive_mode")} log_connections=${sb("log_connections")}`,
    );
    // The provisioner leaves a line in the SERVER log (the one-shot's own stderr is gone once it is removed).
    check(
      "provisioning left a trace in the primary's server log",
      run("docker", ["logs", primary]).out.includes(
        "cw-replication: replication role cw_replicator",
      ),
      "docker logs of the primary",
    );
    const pri = (k: string): string => sql(primary, `SHOW ${k}`);
    check(
      "the primary runs the overlay's settings (ssl, wal_level, bounded slot)",
      pri("ssl") === "on" &&
        pri("wal_level") === "replica" &&
        pri("max_slot_wal_keep_size") === "4GB" &&
        pri("ssl_min_protocol_version") === "TLSv1.3",
      `ssl=${pri("ssl")} max_slot_wal_keep_size=${pri("max_slot_wal_keep_size")}`,
    );

    // --- 4. the monitor
    const monitorEnv = (db: string, extra: readonly string[] = []): readonly string[] => [
      "-v",
      `${vol.sock}:/var/run/postgresql`,
      "-v",
      `${vol.mon}:/state`,
      "-e",
      `CHARTWARDEN_DB_NAME=${db}`,
      "-e",
      "REPLICATION_SLOT=cw_standby",
      "-e",
      "REPLICATION_STATE_DIR=/state",
      ...extra.flatMap((e) => ["-e", e]),
    ];
    const monitor = (extra: readonly string[] = [], db = DB): Run =>
      oneShot(monitorEnv(db, extra), "replication-monitor.sh", "check");
    const alerts = (r: Run): string[] =>
      [...r.out.matchAll(/ALERT \[(replication\.[a-z_]+)\] (SEV-\d)?/g)].map(
        (m) => `${m[1]}${m[2] ? ` ${m[2]}` : ""}`,
      );
    const healthy = monitor();
    check(
      "the monitor is silent and exits 0 while the standby streams",
      healthy.status === 0 && alerts(healthy).length === 0,
      healthy.out.trim().slice(-300),
    );

    sh("docker", ["stop", "-t", "30", standby]);
    await waitFor(
      "the slot to go inactive",
      () =>
        trySql(
          primary,
          "SELECT active FROM pg_replication_slots WHERE slot_name = 'cw_standby'",
        ) === "f",
    );
    sql(primary, "CREATE TABLE cp01_wal (id bigint, pad text)");
    for (let i = 0; i < 2; i += 1) {
      sql(
        primary,
        "INSERT INTO cp01_wal SELECT g, repeat('x', 500) FROM generate_series(1, 20000) g",
      );
      sql(primary, "SELECT pg_switch_wal()");
    }
    sh("docker", [
      "run",
      "--rm",
      "--user",
      "postgres",
      "--entrypoint",
      "sh",
      "-v",
      `${vol.mon}:/state`,
      image,
      "-c",
      "echo $(( $(date +%s) - 600 )) > /state/absent-since",
    ]);
    const lowRetained = ["REPLICATION_SLOT_RETAINED_ALERT_BYTES=1000000"];
    const down = monitor(lowRetained);
    const downAlerts = alerts(down);
    check(
      "a stopped standby pages: standby_absent (SEV-2 after 10 min) and slot_wal_retained",
      down.status === 1 &&
        downAlerts.includes("replication.standby_absent SEV-2") &&
        downAlerts.includes("replication.slot_wal_retained SEV-3"),
      `${down.status} ${downAlerts.join(", ")}`,
    );
    const again = monitor(lowRetained);
    check(
      "the same alerts are not repeated on the next pass (the exit stays 1)",
      again.status === 1 && alerts(again).length === 0,
      `${again.status} ${alerts(again).join(", ")}`,
    );
    const blind = monitor([], "no_such_database");
    check(
      "an unreadable primary raises monitor_blind",
      blind.status !== 0 && alerts(blind).includes("replication.monitor_blind SEV-2"),
      alerts(blind).join(", "),
    );

    t = performance.now();
    sh("docker", ["start", standby]);
    await waitFor("the standby to stream again", streaming);
    await waitFor("the standby to catch up", () => count(standby, "cp01_wal") === "40000");
    timings["restarted standby catches up 40000 rows of WAL"] = ms(t);
    const recovered = monitor();
    const stateFiles = run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "ls",
      "-v",
      `${vol.mon}:/state`,
      image,
      "/state",
    ]).stdout;
    check(
      "after the standby catches up the monitor is silent again and the absence clock is cleared",
      recovered.status === 0 &&
        alerts(recovered).length === 0 &&
        !stateFiles.includes("absent-since"),
      recovered.out.trim().slice(-300),
    );

    // --- 5. promotion rehearsal
    t = performance.now();
    const promoted = trySql(standby, "SELECT pg_promote(true, 60)");
    timings["promotion (pg_promote, waited)"] = ms(t);
    sql(standby, "INSERT INTO cp01_probe VALUES (999999, 'written after promotion')");
    check(
      "the standby promotes, takes a write and holds every row",
      promoted === "t" &&
        trySql(standby, "SELECT pg_is_in_recovery()") === "f" &&
        count(standby) === "2001",
      `promoted=${promoted} rows=${count(standby)}`,
    );

    const record: ReplicationDrillRecord = {
      runId,
      startedAt,
      tooling,
      scale:
        "synthetic: one probe table (2000 rows) and 40000 rows of padding WAL; one primary, one standby, one throwaway CA",
      primarySettings: Object.fromEntries(postgresSettings(primaryCommand)),
      standbySettings: Object.fromEntries(postgresSettings(standbyCommand)),
      timingsMs: timings,
      checks,
      passed: summarise(checks).passed,
    };
    const outDir =
      process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
      join(REPO, "audit", "restore-drill");
    mkdirSync(outDir, { recursive: true });
    const stem = `${startedAt.slice(0, 10)}-replication-drill`;
    writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(outDir, `${stem}.md`), renderMarkdown(record));
    console.log(renderMarkdown(record));
    return record.passed ? 0 : 1;
  } finally {
    const ids = run("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${runId}`])
      .stdout.split("\n")
      .filter(Boolean);
    if (ids.length > 0) run("docker", ["rm", "-f", "-v", ...ids]);
    run("docker", ["network", "rm", net]);
    for (const v of Object.values(vol)) run("docker", ["volume", "rm", "-f", v]);
    if (!process.env.WX_BACKUP_IMAGE) run("docker", ["rmi", "-f", image]);
    rmSync(work, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
