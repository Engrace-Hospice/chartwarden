#!/usr/bin/env bun
/**
 * Coordinated backup -> restore -> verify drill (#857), end to end on PRIVATE containers only.
 *
 *   bun run backup:coordinated-drill            # writes audit/restore-drill/<date>-coordinated-backup-drill.{md,json}
 *
 * What it runs is the production tooling, unmodified: the image built from deploy/production/backup/, its
 * cw-backup.sh (WAL archiving via archive_command, `snapshot`, `restore-db`, `restore-objects`), restore.sh, and the
 * verifier scripts/lib/backup/verify-restore.ts. Topology:
 *   - source Postgres: that image, archive_mode=on, published on 127.0.0.1:55802 (WX_DRILL_PG_PORT), migrated +
 *     provisioned the production way, two tenants seeded through the real M36 routes (rows + objects)
 *   - source MinIO (the app's object store) and a SECOND MinIO standing in for the off-site target, on TLS with a
 *     throwaway CA, object lock + versioning, written through a bucket-scoped account
 *   - snapshot 1 = full base backup + objects; more writes; snapshot 2 = no base backup (so restoring it needs WAL
 *     replay: point-in-time recovery to the marker LSN); more writes (the lost window); the source is destroyed
 *   - restore.sh restores the newest snapshot into new containers on a new network; the verifier and the
 *     drill-only comparisons (every table's row count and every org's audit chain equal the source at the snapshot)
 *     decide PASS/FAIL. Negative controls prove the alert hook and the object check actually fire.
 *
 * Never touches the shared Docker cluster: every container, volume and network is created here and removed at the end.
 * Needs: docker (Docker Desktop: host.docker.internal), bun, openssl.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbAuditChainReader, partitionNameForMonth } from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import {
  createS3ObjectStore,
  deriveTenantBucket,
} from "../../apps/backend/src/modules/22-documents";
import { type CoordinatedDrillRecord, renderDrillMarkdown } from "../lib/backup/drill-report";
import {
  type SnapshotMarker,
  auditIntegrity,
  objectReconciliation,
  readManifestGz,
  verifyRestore,
} from "../lib/backup/verify-restore";
import {
  MINIO_IMAGE,
  MINIO_ROOT_PASSWORD,
  MINIO_ROOT_USER,
  docker,
  freePort,
  listStoredObjects,
  removeRunContainers,
  sleep,
  startMinio,
} from "../lib/restore-drill/docker";
import { type Check, parseRtoTargetMs, rtoCheck, summarise } from "../lib/restore-drill/report";
import { ORG_A, ORG_B, createWorld } from "../lib/restore-drill/seed";
import { fingerprintObject, withClient } from "../lib/restore-drill/verify";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKUP_DIR = join(REPO, "deploy", "production", "backup");
const LABEL = "wx-m36-restore-drill"; // the label removeRunContainers() cleans up by
const DB = "chartwarden";
const PG_PORT = Number(process.env.WX_DRILL_PG_PORT ?? 55802);
const PG_PW = "drill-superuser-pw";
const APP_PW = "drill-app-pw";
const RTO_TARGET_MS = parseRtoTargetMs(process.env.WX_DRILL_RTO_TARGET_S);

interface Run {
  readonly stdout: string;
  /** stdout + stderr, for the secret scan and error messages. */
  readonly out: string;
  readonly ms: number;
}

function sh(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Run {
  const t0 = performance.now();
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: env ?? process.env,
    maxBuffer: 1 << 28,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 4).join(" ")} failed (${res.status}):\n${out.slice(-3000)}`,
    );
  return { stdout: res.stdout ?? "", out, ms: Math.round(performance.now() - t0) };
}

const hex = (n: number): string => randomBytes(n).toString("hex");

async function waitPg(url: string): Promise<void> {
  let streak = 0;
  for (let i = 0; i < 200; i += 1) {
    const c = new Client({ connectionString: url });
    try {
      await c.connect();
      await c.query("SELECT 1");
      streak += 1;
      if (streak >= 2) return;
    } catch {
      streak = 0;
    } finally {
      await c.end().catch(() => undefined);
    }
    await sleep(500);
  }
  throw new Error("source postgres never became ready");
}

async function tableCounts(adminUrl: string): Promise<Record<string, number>> {
  return withClient(adminUrl, async (c) => {
    const tables = (
      await c.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`,
      )
    ).rows.map((r) => r.relname as string);
    const out: Record<string, number> = {};
    for (const t of tables)
      out[t] = (await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n as number;
    return out;
  });
}

function diffCounts(
  name: string,
  expected: Record<string, number>,
  actual: Record<string, number>,
): Check {
  const diffs = Object.keys(expected).filter((t) => expected[t] !== actual[t]);
  const rows = Object.values(expected).reduce((a, b) => a + b, 0);
  return {
    name,
    ok: diffs.length === 0,
    detail:
      diffs.length === 0
        ? `${Object.keys(expected).length} tables, ${rows} rows, all equal`
        : diffs.map((t) => `${t}: ${expected[t]} != ${actual[t] ?? "missing"}`).join("; "),
  };
}

/** Throwaway CA-less self-signed cert whose SANs cover how containers reach the off-site MinIO. */
function makeCert(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sh("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    join(dir, "private.key"),
    "-out",
    join(dir, "public.crt"),
    "-subj",
    "/CN=offsite-drill",
    "-addext",
    "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1",
  ]);
  sh("chmod", ["644", join(dir, "private.key")]);
}

async function main(): Promise<number> {
  const runId = hex(3);
  const p = `wx857-${runId}`;
  const startedAt = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), `${p}-`));
  const certs = join(work, "certs");
  const envFile = join(work, "backup.env");
  const image = process.env.WX_BACKUP_IMAGE ?? `chartwarden-backup:${p}`;
  const net = `${p}-net`;
  const vols = {
    pgdata: `${p}-pgdata`,
    pgsock: `${p}-pgsock`,
    pgrepo: `${p}-pgrepo`,
    state: `${p}-state`,
  };
  const restoreId = `${runId}r`;
  const logs: string[] = [];
  const secrets: string[] = [];
  process.env.LOG_LEVEL ??= "warn";
  console.log(`coordinated backup drill ${runId}`);
  try {
    if (!process.env.WX_BACKUP_IMAGE) sh("docker", ["build", "-q", "-t", image, BACKUP_DIR]);
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
      objectStore: `${MINIO_IMAGE} (source, restore target and off-site stand-in)`,
      offsite:
        "second private MinIO over TLS (throwaway self-signed cert), object lock GOVERNANCE + versioning, bucket-scoped account, SSE-C",
    };
    makeCert(certs);
    sh("docker", ["network", "create", "--label", `${LABEL}=${runId}`, net]);
    for (const v of Object.values(vols))
      sh("docker", ["volume", "create", "--label", `${LABEL}=${runId}`, v]);

    // Off-site stand-in: TLS, object lock, a bucket-scoped account for the backup job.
    const offPort = await freePort();
    const offRoot = { user: `off-admin-${hex(3)}`, pw: hex(16) };
    const offUser = { user: `cw-backup-${hex(3)}`, pw: hex(16) };
    secrets.push(offRoot.pw, offUser.pw);
    sh("docker", [
      "run",
      "-d",
      "--name",
      `${p}-offsite`,
      "--label",
      `${LABEL}=${runId}`,
      "-p",
      `127.0.0.1:${offPort}:9000`,
      "-v",
      `${certs}:/certs:ro`,
      "-e",
      `MINIO_ROOT_USER=${offRoot.user}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${offRoot.pw}`,
      MINIO_IMAGE,
      "server",
      "/data",
      "--certs-dir",
      "/certs",
    ]);
    const offMc = (...args: string[]): Run =>
      sh("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "mc",
        "-e",
        `MC_HOST_off=https://${offRoot.user}:${offRoot.pw}@host.docker.internal:${offPort}`,
        image,
        "--insecure",
        "--quiet",
        ...args,
      ]);
    for (let i = 0; ; i += 1) {
      try {
        offMc("ready", "off");
        break;
      } catch (error) {
        if (i > 60) throw error;
        await sleep(500);
      }
    }
    offMc("mb", "--with-lock", "off/cw-offsite");
    offMc("retention", "set", "--default", "GOVERNANCE", "7d", "off/cw-offsite");
    const policy = join(work, "offsite-policy.json");
    writeFileSync(
      policy,
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "s3:ListBucket",
              "s3:GetBucketLocation",
              "s3:ListBucketVersions",
              "s3:GetBucketObjectLockConfiguration",
            ],
            Resource: ["arn:aws:s3:::cw-offsite"],
          },
          {
            Effect: "Allow",
            Action: [
              "s3:GetObject",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:GetObjectVersion",
              "s3:GetObjectRetention",
            ],
            Resource: ["arn:aws:s3:::cw-offsite/*"],
          },
        ],
      }),
    );
    sh("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "-v",
      `${policy}:/policy.json:ro`,
      "-e",
      `MC_HOST_off=https://${offRoot.user}:${offRoot.pw}@host.docker.internal:${offPort}`,
      image,
      "-c",
      `mc --insecure admin policy create off cw-backup /policy.json && mc --insecure admin user add off '${offUser.user}' '${offUser.pw}' && mc --insecure admin policy attach off cw-backup --user '${offUser.user}'`,
    ]);

    // Source object store (the app's MinIO) on the drill network.
    const srcMinio = await startMinio(runId, "src");
    sh("docker", ["network", "connect", "--alias", "srcminio", net, srcMinio.name]);
    const reader = { user: `cw-reader-${hex(3)}`, pw: hex(16) };
    const keys = { local: hex(32), offsite: hex(32), sse: randomBytes(32).toString("base64") };
    secrets.push(
      reader.pw,
      keys.local,
      keys.offsite,
      keys.sse.replace(/=+$/, ""),
      MINIO_ROOT_PASSWORD,
      PG_PW,
      APP_PW,
    );
    writeFileSync(
      envFile,
      [
        `BACKUP_OFFSITE_S3_ENDPOINT=https://host.docker.internal:${offPort}`,
        "BACKUP_OFFSITE_S3_BUCKET=cw-offsite",
        "BACKUP_OFFSITE_S3_REGION=us-east-1",
        `BACKUP_OFFSITE_S3_ACCESS_KEY=${offUser.user}`,
        `BACKUP_OFFSITE_S3_SECRET_KEY=${offUser.pw}`,
        "BACKUP_OFFSITE_CA_FILE=/certs/public.crt",
        `BACKUP_PG_LOCAL_CIPHER_PASS=${keys.local}`,
        `BACKUP_PG_OFFSITE_CIPHER_PASS=${keys.offsite}`,
        `BACKUP_OBJECT_SSE_C_KEY=${keys.sse}`,
        "BACKUP_SOURCE_MINIO_URL=http://srcminio:9000",
        `BACKUP_SOURCE_MINIO_ACCESS_KEY=${reader.user}`,
        `BACKUP_SOURCE_MINIO_SECRET_KEY=${reader.pw}`,
        `CHARTWARDEN_DB_NAME=${DB}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const backupRun = (
      args: readonly string[],
      extra: readonly string[] = [],
      env = envFile,
    ): Run => {
      const r = sh("docker", [
        "run",
        "--rm",
        "--label",
        `${LABEL}=${runId}`,
        "--network",
        net,
        "--user",
        "postgres",
        "--env-file",
        env,
        "-v",
        `${vols.pgdata}:/var/lib/postgresql`,
        "-v",
        `${vols.pgsock}:/var/run/postgresql`,
        "-v",
        `${vols.pgrepo}:/var/lib/pgbackrest`,
        "-v",
        `${vols.state}:/var/lib/cw-backup`,
        "-v",
        `${certs}:/certs:ro`,
        ...extra,
        image,
        "cw-backup.sh",
        ...args,
      ]);
      logs.push(r.out);
      return r;
    };
    backupRun(
      ["provision-source-reader"],
      [
        "-e",
        `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
        "-e",
        `MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}`,
      ],
    );

    // Source Postgres: the backup image with WAL archiving on, exactly as compose.backup.yml runs it.
    sh("docker", [
      "run",
      "-d",
      "--name",
      `${p}-srcpg`,
      "--label",
      `${LABEL}=${runId}`,
      "--network",
      net,
      "-p",
      `127.0.0.1:${PG_PORT}:5432`,
      "--env-file",
      envFile,
      "-e",
      `POSTGRES_PASSWORD=${PG_PW}`,
      "-e",
      `POSTGRES_DB=${DB}`,
      "-v",
      `${vols.pgdata}:/var/lib/postgresql`,
      "-v",
      `${vols.pgsock}:/var/run/postgresql`,
      "-v",
      `${vols.pgrepo}:/var/lib/pgbackrest`,
      "-v",
      `${certs}:/certs:ro`,
      image,
      "postgres",
      "-c",
      "max_locks_per_transaction=1024",
      "-c",
      "archive_mode=on",
      "-c",
      "archive_command=pgbackrest --stanza=chartwarden archive-push %p",
      "-c",
      "archive_timeout=60",
    ]);
    const srcAdmin = `postgres://postgres:${PG_PW}@127.0.0.1:${PG_PORT}/${DB}`;
    await waitPg(srcAdmin);
    sh("docker", [
      "exec",
      "-u",
      "postgres",
      `${p}-srcpg`,
      "pgbackrest",
      "--stanza=chartwarden",
      "stanza-create",
    ]);
    const migEnv = {
      ...process.env,
      DATABASE_ADMIN_URL: srcAdmin,
      PROVISION_DATABASE_URL: srcAdmin,
      CHARTWARDEN_APP_PASSWORD: APP_PW,
      CHARTWARDEN_PLATFORM_PASSWORD: "drill-platform-pw",
      CHARTWARDEN_DESTRUCTION_PASSWORD: "drill-destruction-pw",
    };
    sh("bun", ["run", "scripts/db/migrate.ts"], migEnv);
    sh("bun", ["run", "scripts/db/provision-runtime-roles.ts"], migEnv);
    const kek = randomBytes(32);
    const world = await createWorld({
      adminUrl: srcAdmin,
      appUrl: `postgres://chartwarden_app:${APP_PW}@127.0.0.1:${PG_PORT}/${DB}`,
      destructionUrl: `postgres://chartwarden_destruction_login:drill-destruction-pw@127.0.0.1:${PG_PORT}/${DB}`,
      minio: srcMinio,
      kek,
    });
    await world.seedBaseline();
    // A stray object present at snapshot 1 and deleted before snapshot 2: the off-site copy keeps it (history), the
    // restore of snapshot 2 must not resurrect it.
    const stray = {
      bucket: deriveTenantBucket(ORG_A as never),
      objectKey: `drill-stray-${runId}.pdf`,
    };
    await world.store.putObject({
      ...stray,
      bytes: Buffer.from("%PDF-1.4 stray\n%%EOF"),
      mimeType: "application/pdf",
    });
    console.log("  source migrated and seeded (2 tenants)");

    const snapshots: CoordinatedDrillRecord["snapshots"][number][] = [];
    const takeSnapshot = (type: string): SnapshotMarker => {
      const r = backupRun(["snapshot", type]);
      const m = JSON.parse(backupRun(["marker", "latest"]).stdout) as SnapshotMarker & {
        db: { backupLabel: string };
        objects: { bytes: number };
      };
      snapshots.push({
        id: m.snapshotId,
        baseBackup: `${m.db.backupLabel}${type === "none" ? " (reused)" : ` (${type})`}`,
        lsn: m.db.lsn,
        objects: m.objects.count,
        bytes: m.objects.bytes,
        wallMs: r.ms,
      });
      return m;
    };
    takeSnapshot("full");
    const messagesAtSnap1 = (await tableCounts(srcAdmin)).message ?? 0;
    await world.seedAfterBackup(); // in the restored snapshot only through WAL replay (no base backup after it)
    await world.store.destroyAllVersions({ ...stray, organizationId: ORG_A as never });
    // Seal the (still open) current month the way the M4 seal job computes it (createDbAuditChainReader digest, linked
    // to the previous seal), so the restored copy has real seals for the verifier to recompute. Inserted with triggers
    // off: the job's own insert is audited, which is harmless for the CLOSED months production seals but would add an
    // event to this open month after its seal. Done last before the snapshot: no later write in the month.
    const sealDb = createDbClient({
      connectionString: `postgres://chartwarden_app:${APP_PW}@127.0.0.1:${PG_PORT}/${DB}`,
    });
    let sealedMonths = 0;
    try {
      const sealReader = createDbAuditChainReader(sealDb.db);
      await withClient(srcAdmin, async (c) => {
        await c.query("SET session_replication_role = replica");
        for (const org of [ORG_A, ORG_B]) {
          let prev: string | null = null;
          for (const month of await sealReader.listClosedMonths(
            org,
            new Date("2100-01-01T00:00:00Z"),
          )) {
            const d = await sealReader.digestMonth(org, month, prev);
            if (!d?.fromId || !d.toId) continue;
            await c.query(
              `INSERT INTO audit_seal (organization_id, partition, from_id, to_id, event_count, prev_chain_hash, chain_hash)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                org,
                partitionNameForMonth(month),
                d.fromId,
                d.toId,
                d.eventCount,
                prev,
                d.chainHash,
              ],
            );
            prev = d.chainHash;
            sealedMonths += 1;
          }
        }
      });
    } finally {
      await sealDb.close();
    }
    const snap2 = takeSnapshot("none");
    const countsAtSnap2 = await tableCounts(srcAdmin);
    const chainsAtSnap2 = (
      await auditIntegrity(
        srcAdmin,
        `postgres://chartwarden_app:${APP_PW}@127.0.0.1:${PG_PORT}/${DB}`,
      )
    ).chains;
    const snapAt = new Date();
    console.log(`  snapshots taken: ${snapshots.map((s) => s.id).join(", ")}`);

    // Negative control 1: a failing snapshot exits non-zero and posts the ops notice.
    const alerts: string[] = [];
    const hook = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        alerts.push(body);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "0.0.0.0", resolve));
    const hookPort = (hook.address() as AddressInfo).port;
    let failedExit = 0;
    const badEnv = join(work, "backup-bad.env");
    writeFileSync(
      badEnv,
      `${readFileSync(envFile, "utf8").replace(`BACKUP_SOURCE_MINIO_SECRET_KEY=${reader.pw}`, "BACKUP_SOURCE_MINIO_SECRET_KEY=wrong-secret")}OPS_ALERT_WEBHOOK_URL=http://host.docker.internal:${hookPort}/ops\n`,
      { mode: 0o600 },
    );
    try {
      backupRun(["snapshot", "none"], [], badEnv);
    } catch (error) {
      failedExit = 1;
      logs.push(String(error));
    }
    await sleep(200);
    await new Promise<void>((resolve) => hook.close(() => resolve()));
    const alert = alerts[0]
      ? (JSON.parse(alerts[0]) as { kind: string; details: { step: string } })
      : null;

    // The lost window, then the site is gone.
    await world.seedAfterBackup();
    const countsAtFailure = await tableCounts(srcAdmin);
    const failureAt = new Date();
    const objectsAtFailure = listStoredObjects(srcMinio, join(work, "src-objects")).size;
    await world.close();
    logs.push(sh("docker", ["logs", `${p}-srcpg`]).out);
    sh("docker", ["rm", "-f", `${p}-srcpg`, srcMinio.name]);
    for (const v of [vols.pgdata, vols.pgrepo, vols.pgsock, vols.state])
      sh("docker", ["volume", "rm", v]);
    console.log(
      "  source destroyed (containers, data, local pgBackRest repo); restoring from off-site only",
    );

    // Restore (RTO clock) with the production script.
    const restoreOut = join(work, "restore");
    const [rPg, rMinio] = [await freePort(), await freePort()];
    const restored = sh("bash", [join(BACKUP_DIR, "restore.sh"), "latest"], {
      ...process.env,
      BACKUP_ENV_FILE: envFile,
      BACKUP_IMAGE: image,
      RESTORE_ID: restoreId,
      RESTORE_PG_PORT: String(rPg),
      RESTORE_MINIO_PORT: String(rMinio),
      RESTORE_MINIO_IMAGE: MINIO_IMAGE,
      RESTORE_OUT_DIR: restoreOut,
      RESTORE_PG_MAX_LOCKS: "1024",
      BACKUP_OFFSITE_CA_HOST_FILE: join(certs, "public.crt"),
      BACKUP_OFFSITE_CA_FILE: "/certs/public.crt",
    });
    logs.push(restored.out);
    const renv = Object.fromEntries(
      readFileSync(join(restoreOut, "restore.env"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    ) as Record<string, string>;
    const marker = JSON.parse(
      readFileSync(renv.RESTORE_MARKER_FILE as string, "utf8"),
    ) as SnapshotMarker;
    const manifest = readManifestGz(readFileSync(renv.RESTORE_MANIFEST_FILE as string));
    const target = {
      adminUrl: renv.RESTORE_ADMIN_URL as string,
      appUrl: renv.RESTORE_APP_URL as string,
      minioEndpoint: renv.RESTORE_MINIO_ENDPOINT as string,
      minioAccessKey: renv.RESTORE_MINIO_ACCESS_KEY as string,
      minioSecretKey: renv.RESTORE_MINIO_SECRET_KEY as string,
      marker,
      manifest,
    };

    // Verify.
    const verifyStart = performance.now();
    const restoredCounts = await tableCounts(target.adminUrl);
    const result = await verifyRestore(target);
    const verifyWallMs = Math.round(performance.now() - verifyStart);
    const restoredStore = createS3ObjectStore({
      endpoint: target.minioEndpoint,
      accessKeyId: target.minioAccessKey,
      secretAccessKey: target.minioSecretKey,
    });
    const strayAfter = await fingerprintObject(
      restoredStore,
      () => ORG_A,
      stray.bucket,
      stray.objectKey,
    );
    const checks: Check[] = [
      {
        name: "restore.sh picked the newest complete snapshot (snapshot 2, no base backup of its own)",
        ok: marker.snapshotId === snap2.snapshotId,
        detail: `restored ${marker.snapshotId}, expected ${snap2.snapshotId}`,
      },
      ...result.checks,
      diffCounts(
        "every table's row count equals the source at the snapshot (whole schema)",
        countsAtSnap2,
        restoredCounts,
      ),
      {
        name: "point-in-time recovery: rows written after the last base backup are present (WAL replay to the marker LSN)",
        ok:
          (countsAtSnap2.message ?? 0) > messagesAtSnap1 &&
          restoredCounts.message === countsAtSnap2.message,
        detail: `message rows: base backup ${messagesAtSnap1}, snapshot LSN ${countsAtSnap2.message}, restored ${restoredCounts.message}`,
      },
      {
        name: "every org's audit hash chain (all months) equals the source's at the snapshot",
        ok:
          JSON.stringify(chainsAtSnap2) === JSON.stringify(result.auditChains) &&
          Object.keys(chainsAtSnap2).length >= 2,
        detail: `${Object.keys(chainsAtSnap2).length} org chains compared`,
      },
      {
        name: "M4 seals were written before the snapshot, so the verifier's seal recompute is exercised (not vacuous)",
        ok:
          sealedMonths >= 2 &&
          result.checks.some((c) => c.name.startsWith("M4 audit hash chain") && c.ok),
        detail: `${sealedMonths} month seal(s) written from the M4 chain digest across 2 orgs`,
      },
      {
        name: "an object deleted before the snapshot is not resurrected (the off-site history keeps it; the restore drops it)",
        ok: strayAfter === null,
        detail: strayAfter === null ? "absent after restore" : "PRESENT after restore",
      },
      {
        name: "a failing snapshot exits non-zero and POSTs backup.snapshot_failed to OPS_ALERT_WEBHOOK_URL",
        ok: failedExit === 1 && alert?.kind === "backup.snapshot_failed",
        detail: `exit ${failedExit ? "non-zero" : "0"}; alert ${alert ? `${alert.kind} at step ${alert.details.step}` : "not received"}`,
      },
    ];
    // Negative control 2: remove one referenced object from the restored store; the object check must fail.
    const victim = manifest.find((m) => m.b === deriveTenantBucket(ORG_B as never));
    if (victim)
      await restoredStore.destroyAllVersions({
        bucket: victim.b,
        objectKey: victim.k,
        organizationId: ORG_B as never,
      });
    const tampered = await objectReconciliation(target);
    checks.push({
      name: "negative control: the verifier FAILS when a referenced object is missing from the restored store",
      ok: victim !== undefined && tampered.some((c) => !c.ok),
      detail: victim
        ? (tampered.find((c) => !c.ok)?.detail ?? "verifier still passed")
        : "no tenant-B object to remove",
    });
    const allLogs = logs.join("\n");
    const leakedSecrets = secrets.filter((s) => s.length >= 8 && allLogs.includes(s)).length;
    checks.push({
      name: "no secret (cipher passes, SSE-C key, S3/MinIO/Postgres passwords) appears in any backup/restore output",
      ok: leakedSecrets === 0,
      detail: `${secrets.length} secrets scanned across ${logs.length} captured outputs; ${leakedSecrets} found`,
    });
    const restoreWallMs = Number(renv.RESTORE_WALL_MS);
    checks.push(rtoCheck(restoreWallMs, RTO_TARGET_MS));

    const rowsLost = Object.fromEntries(
      Object.keys(countsAtFailure).map((t) => [
        t,
        (countsAtFailure[t] ?? 0) - (restoredCounts[t] ?? 0),
      ]),
    );
    const record: CoordinatedDrillRecord = {
      runId,
      startedAt,
      scale: `synthetic: 2 tenants seeded through the real M36 routes; ${Object.values(countsAtSnap2).reduce((a, b) => a + b, 0)} rows in ${Object.keys(countsAtSnap2).length} tables (incl. reference data); ${marker.objects.count} objects`,
      tooling,
      snapshots,
      rto: {
        restoreWallMs,
        phasesMs: {
          "pgBackRest restore from the off-site repo (base backup)": Number(
            renv.RESTORE_PHASE_DB_MS,
          ),
          "Postgres start + WAL replay to the marker LSN + promotion": Number(
            renv.RESTORE_PHASE_REPLAY_MS,
          ),
          "objects: off-site -> fresh MinIO, sha256 checked against the manifest": Number(
            renv.RESTORE_PHASE_OBJECTS_MS,
          ),
        },
        verifyWallMs,
      },
      rpo: {
        snapshotAt: snapAt.toISOString(),
        failureAt: failureAt.toISOString(),
        windowMs: failureAt.getTime() - snapAt.getTime(),
        rowsLost,
        objectsLost: objectsAtFailure - marker.objects.count,
      },
      checks,
      passed: summarise(checks).passed,
    };
    const outDir =
      process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
      join(REPO, "audit", "restore-drill");
    mkdirSync(outDir, { recursive: true });
    const stem = `${startedAt.slice(0, 10)}-coordinated-backup-drill`;
    writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(outDir, `${stem}.md`), renderDrillMarkdown(record));
    console.log(renderDrillMarkdown(record));
    return record.passed ? 0 : 1;
  } finally {
    spawnSync("bash", [join(BACKUP_DIR, "restore.sh"), "destroy", restoreId], { stdio: "ignore" });
    try {
      removeRunContainers(runId);
    } catch {
      // best effort
    }
    spawnSync("docker", ["network", "rm", net], { stdio: "ignore" });
    for (const v of Object.values(vols))
      spawnSync("docker", ["volume", "rm", "-f", v], { stdio: "ignore" });
    if (!process.env.WX_BACKUP_IMAGE)
      spawnSync("docker", ["rmi", "-f", image], { stdio: "ignore" });
    rmSync(work, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
