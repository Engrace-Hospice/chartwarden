#!/usr/bin/env bun
/**
 * M36 Phase 1 gate - "restore consistency": a restore drill that proves DB + object-store consistency and measures
 * RPO/RTO (docs/messaging-hub/ restore-drill runbook: docs/runbooks/m36-restore-drill.md).
 *
 * Runs ONLY against containers this process starts (pgvector/pgvector:pg18 + MinIO), never the shared Docker cluster:
 *   1. source: migrate + provision roles (the production path), seed two tenants through the real M36 routes
 *   2. backup the way production does it: `pg_dump -d wardenx | gzip` (deploy/production/reseed-demo.sh) plus a copy of
 *      the MinIO data volume (production has NO object-store backup at all - see the runbook; this is the closest
 *      real mechanism)
 *   3. write more data after the backup, then kill the source (the RPO is what that data window costs)
 *   4. restore into a SCRATCH Postgres + SCRATCH MinIO, timing it (RTO, demo scale)
 *   5. verify consistency (counts, hashes, objects, audit chain, RLS/grants) and write JSON + markdown reports
 *
 *   bun run m36:restore-drill                      # expect exit 0
 *   bun run m36:restore-drill -- --fault=missing-object|hash-flip|object-bytes   # expect exit 1 (detection proof)
 *   bun run m36:restore-drill:detect               # runs all three faults and asserts each one FAILS the drill
 *
 * Needs: docker, bun. Optional: WX_DRILL_MINIO_IMAGE (default cgr.dev/chainguard/minio:latest), --out=<dir>.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createS3ObjectStore, deriveTenantBucket } from "../apps/backend/src/modules/22-documents";
import {
  MINIO_ROOT_PASSWORD,
  MINIO_ROOT_USER,
  type Minio,
  type Pg,
  backupMinioData,
  docker,
  killContainer,
  listStoredObjects,
  removeRunContainers,
  resumeMinio,
  startMinio,
  startPostgres,
} from "./lib/restore-drill/docker";
import {
  type Check,
  type DrillReport,
  compareCounts,
  compareObjects,
  renderMarkdown,
  summarise,
} from "./lib/restore-drill/report";
import { ORG_A, ORG_B, createWorld } from "./lib/restore-drill/seed";
import {
  M36_TABLES,
  attachmentRows,
  auditFingerprints,
  catalogFingerprint,
  compareMaps,
  countM36Tables,
  fingerprintAll,
  hashVerifyAll,
  rlsChecks,
  withClient,
} from "./lib/restore-drill/verify";

const FAULTS = ["none", "missing-object", "hash-flip", "object-bytes"] as const;
type Fault = (typeof FAULTS)[number];

const DB = "wardenx"; // the production database name (deploy/production/reseed-demo.sh)
const APP_PW = "drill-app-pw";
const PLATFORM_PW = "drill-platform-pw";
const DESTRUCTION_PW = "drill-destruction-pw";
const ORGS = [ORG_A, ORG_B] as const;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseFault(): Fault {
  const fault = arg("fault") ?? "none";
  if (!(FAULTS as readonly string[]).includes(fault))
    throw new Error(`--fault must be one of ${FAULTS.join(", ")}`);
  return fault as Fault;
}

const timed = async <T>(
  phases: Record<string, number>,
  name: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    phases[name] = Math.round(performance.now() - t0);
  }
};

/** migrate (production path: DDL as superuser, then the wardenx_app LOGIN bootstrap) + provision the runtime roles. */
function migrateAndProvision(pg: Pg, db: string): void {
  const env = {
    ...process.env,
    DATABASE_ADMIN_URL: pg.url(db),
    PROVISION_DATABASE_URL: pg.url(db),
    CHARTWARDEN_APP_PASSWORD: APP_PW,
    CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PW,
    CHARTWARDEN_DESTRUCTION_PASSWORD: DESTRUCTION_PW,
  };
  for (const script of ["scripts/db/migrate.ts", "scripts/db/provision-runtime-roles.ts"]) {
    const res = spawnSync("bun", ["run", script], { env, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`${script} failed:\n${res.stdout}\n${res.stderr}`);
  }
}

async function createDatabase(pg: Pg, db: string): Promise<void> {
  await withClient(pg.url("postgres"), (c) => c.query(`CREATE DATABASE ${db}`));
}

function pgDump(pg: Pg): Buffer {
  // deploy/production/reseed-demo.sh: `docker compose exec -T postgres pg_dump -U postgres -d wardenx | gzip`
  return gzipSync(docker(["exec", pg.name, "pg_dump", "-U", "postgres", "-d", DB]));
}

function psqlRestore(pg: Pg, dump: Buffer): void {
  const res = spawnSync(
    "docker",
    ["exec", "-i", pg.name, "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q"],
    { input: gunzipSync(dump), maxBuffer: 1 << 30, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`psql restore failed: ${res.stderr.trim().slice(0, 600)}`);
}

/**
 * A plain pg_dump carries no roles, and its GRANTs / policies name them. Restoring onto a bare cluster fails (or, without
 * ON_ERROR_STOP, silently drops thousands of statements including the RLS policies). The repo's own code defines the
 * roles, so the drill creates them the same way a deploy does: migrate + provision against a throwaway database, then drop it.
 */
async function bootstrapRoles(pg: Pg): Promise<void> {
  await createDatabase(pg, "roles_bootstrap");
  migrateAndProvision(pg, "roles_bootstrap");
  await withClient(pg.url("postgres"), (c) => c.query("DROP DATABASE roles_bootstrap"));
}

async function injectFault(fault: Fault, pg: Pg, minio: Minio): Promise<string> {
  if (fault === "none") return "none";
  if (fault === "hash-flip") {
    await withClient(pg.url(DB), async (c) => {
      await c.query("SET session_replication_role = replica"); // an attacker/corruption bypasses the immutability triggers
      await c.query(
        `UPDATE message SET body_sha256 = repeat('f', 64) WHERE id = (SELECT id FROM message ORDER BY id LIMIT 1)`,
      );
    });
    return "hash-flip: one message.body_sha256 overwritten after restore";
  }
  const row = await withClient(
    pg.url(DB),
    async (c) =>
      (
        await c.query(
          `SELECT organization_id, object_key FROM message_attachment WHERE completed_at IS NOT NULL AND object_destroyed_at IS NULL AND object_key IS NOT NULL ORDER BY id LIMIT 1`,
        )
      ).rows[0],
  );
  const bucket = deriveTenantBucket(row.organization_id as never);
  if (fault === "missing-object") {
    await createS3ObjectStore({
      endpoint: minio.endpoint,
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey: MINIO_ROOT_PASSWORD,
    }).destroyAllVersions({
      bucket,
      objectKey: row.object_key,
      organizationId: row.organization_id,
    });
    return `missing-object: ${bucket}/${row.object_key} deleted from the restored store`;
  }
  // object-bytes: replace the object with same-length different bytes (corruption that size checks cannot see).
  const size = (
    await withClient(pg.url(DB), (c) =>
      c.query(
        `SELECT byte_size FROM message_attachment WHERE organization_id=$1 AND object_key=$2`,
        [row.organization_id, row.object_key],
      ),
    )
  ).rows[0].byte_size as number;
  await createS3ObjectStore({
    endpoint: minio.endpoint,
    accessKeyId: MINIO_ROOT_USER,
    secretAccessKey: MINIO_ROOT_PASSWORD,
  }).putObject({
    bucket,
    objectKey: row.object_key,
    bytes: randomBytes(size),
    mimeType: "application/pdf",
  });
  return `object-bytes: ${bucket}/${row.object_key} overwritten with same-size random bytes`;
}

async function main(): Promise<number> {
  const fault = parseFault();
  const runId = randomBytes(3).toString("hex");
  const work = mkdtempSync(join(tmpdir(), `wx-m36-drill-${runId}-`));
  const startedAt = new Date().toISOString();
  const phases: Record<string, number> = {};
  const kek = randomBytes(32);
  process.env.LOG_LEVEL ??= "warn"; // the in-process route stack logs every request at info
  console.log(`M36 restore drill ${runId} (fault: ${fault})`);
  try {
    // 1. source environment
    const [src, srcMinio] = await timed(phases, "source-up", () =>
      Promise.all([startPostgres(runId, "src"), startMinio(runId, "src")]),
    );
    await createDatabase(src, DB);
    migrateAndProvision(src, DB);
    const world = await createWorld({
      adminUrl: src.url(DB),
      appUrl: src.url(DB, "wardenx_app", APP_PW),
      destructionUrl: src.url(DB, "wardenx_destruction_login", DESTRUCTION_PW),
      minio: srcMinio,
      kek,
    });
    await world.seedBaseline();
    console.log("  seeded baseline through the real M36 routes");

    // 2. backup-time manifest (read-only), then the backup itself
    const appUrl = src.url(DB, "wardenx_app", APP_PW);
    const rowsAtBackup = await attachmentRows(src.url(DB));
    const manifest = {
      counts: await countM36Tables(src.url(DB)),
      catalog: await catalogFingerprint(src.url(DB)),
      audit: await auditFingerprints(appUrl, src.url(DB), ORGS),
      objects: await fingerprintAll(world.store, rowsAtBackup, ORGS),
    };
    const backupAt = new Date();
    const dump = pgDump(src);
    const tarPath = join(work, "minio-data.tar");
    backupMinioData(srcMinio, tarPath);
    console.log(`  backup taken: pg_dump ${dump.length} bytes (gzip), minio data tar`);
    await resumeMinio(srcMinio);

    // 3. data after the backup, then the failure
    await world.seedAfterBackup();
    const countsAtFailure = await countM36Tables(src.url(DB));
    const objectsAtFailure = listStoredObjects(srcMinio, join(work, "src-objects")).size;
    const failureAt = new Date();
    await world.close();
    killContainer(src.name);
    killContainer(srcMinio.name);
    console.log("  source killed; restoring into scratch containers");

    // 4. restore (RTO clock)
    const restoreStart = performance.now();
    const [scratch, scratchMinio] = await timed(
      phases,
      "scratch-containers-up (stand-in for a new host)",
      () => Promise.all([startPostgres(runId, "scratch"), startMinio(runId, "scratch", tarPath)]),
    );
    // --no-role-bootstrap reproduces the naive restore (dump onto a bare cluster) to show it does not work.
    if (!process.argv.includes("--no-role-bootstrap")) {
      await timed(phases, "roles bootstrap (migrate+provision on a throwaway db)", () =>
        bootstrapRoles(scratch),
      );
    }
    await createDatabase(scratch, DB);
    await timed(phases, "pg_dump load (psql, ON_ERROR_STOP)", async () =>
      psqlRestore(scratch, dump),
    );
    const restoreWallMs = Math.round(performance.now() - restoreStart);
    console.log(`  restore complete in ${(restoreWallMs / 1000).toFixed(1)} s`);

    // 5. verify
    const faultNote = await injectFault(fault, scratch, scratchMinio);
    const verifyStart = performance.now();
    const checks: Check[] = [];
    const restoredAppUrl = scratch.url(DB, "wardenx_app", APP_PW);
    const restoredCounts = await countM36Tables(scratch.url(DB));
    checks.push(compareCounts(manifest.counts, restoredCounts));
    checks.push(
      compareMaps(
        "RLS flags, policies, grants and triggers per M36 table equal the source",
        manifest.catalog,
        await catalogFingerprint(scratch.url(DB)),
      ),
    );
    checks.push(
      compareMaps(
        "audit_event count and M4 hash chain per org equal the backup-time source",
        manifest.audit,
        await auditFingerprints(restoredAppUrl, scratch.url(DB), ORGS),
      ),
    );
    const restoredRows = await attachmentRows(scratch.url(DB));
    const restoredStore = createS3ObjectStore({
      endpoint: scratchMinio.endpoint,
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey: MINIO_ROOT_PASSWORD,
    });
    const restoredStored = listStoredObjects(scratchMinio, join(work, "scratch-objects"));
    checks.push(
      ...compareObjects(restoredRows, manifest.objects, {
        fingerprints: await fingerprintAll(restoredStore, restoredRows, ORGS),
        stored: restoredStored,
      }),
    );
    checks.push(...(await rlsChecks(restoredAppUrl, ORG_A, ORG_B)));
    // Last: the job writes its own audit rows, which would disturb the audit comparison above.
    checks.push(
      await hashVerifyAll(
        restoredAppUrl,
        kek,
        ORGS,
        (restoredCounts.message ?? 0) + (restoredCounts.message_revision ?? 0),
      ),
    );
    const verifyWallMs = Math.round(performance.now() - verifyStart);

    // 6. report
    const rowsLostPerTable = Object.fromEntries(
      M36_TABLES.map((t) => [t, (countsAtFailure[t] ?? 0) - (restoredCounts[t] ?? 0)]),
    );
    const { passed } = summarise(checks);
    const report: DrillReport = {
      runId,
      startedAt,
      scale:
        "demo: 2 tenants, ~15 messages, ~6 attachments (<= 1.2 MB), private containers on one machine",
      fault: faultNote,
      backupMethod: {
        postgres:
          "pg_dump -U postgres -d wardenx | gzip, as deploy/production/reseed-demo.sh runs it (logical, single snapshot, no WAL archive, no PITR)",
        objectStore:
          "tar of the stopped MinIO /data (closest real mechanism; production has NO object-store backup)",
        coordination:
          "writes quiesced between the two (production has no coordination between them)",
      },
      rto: { restoreWallMs, phasesMs: phases, verifyWallMs },
      rpo: {
        backupAt: backupAt.toISOString(),
        failureAt: failureAt.toISOString(),
        dataWindowLostMs: failureAt.getTime() - backupAt.getTime(),
        rowsLostPerTable,
        objectsLost: objectsAtFailure - restoredStored.size,
      },
      checks,
      passed,
    };
    const outDir = arg("out") ?? join("audit", "restore-drill");
    mkdirSync(outDir, { recursive: true });
    const stem = fault === "none" ? "m36-restore-drill" : `m36-restore-drill.${fault}`;
    writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDir, `${stem}.md`), renderMarkdown(report));
    console.log(renderMarkdown(report));
    return passed ? 0 : 1;
  } finally {
    try {
      removeRunContainers(runId);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(2);
  });
