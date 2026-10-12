/**
 * Private-container helpers for the M36 restore drill (scripts/m36-restore-drill.ts).
 *
 * Everything the drill touches is a container THIS run starts, named `wx-m36-drill-<runId>-*` and labelled
 * `wx-m36-restore-drill=<runId>`; `removeRunContainers` deletes by that label only, so it can never reach the shared
 * wardenx4-* stack or another session's containers.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Client } from "pg";

export const POSTGRES_IMAGE = "pgvector/pgvector:pg18";
// The dev stack's image (present locally); production's compose.yml pins `minio/minio:latest`.
export const MINIO_IMAGE = process.env.WX_DRILL_MINIO_IMAGE ?? "cgr.dev/chainguard/minio:latest";
export const PG_SUPERUSER = "postgres";
export const PG_PASSWORD = "drill-superuser-pw";
export const MINIO_ROOT_USER = "drill-minio-admin";
export const MINIO_ROOT_PASSWORD = "drill-minio-secret-0123456789";
const LABEL = "wx-m36-restore-drill";
const WAIT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024 * 1024;

export function docker(args: string[], input?: Buffer): Buffer {
  const res = spawnSync("docker", args, { input, maxBuffer: MAX_BUFFER });
  if (res.status !== 0) {
    throw new Error(
      `docker ${args.slice(0, 3).join(" ")} failed: ${res.stderr?.toString().trim()}`,
    );
  }
  return res.stdout;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A free loopback port. Fixed per container so a stop/start (the MinIO quiesce) keeps the same address. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface Pg {
  readonly name: string;
  readonly port: number;
  /** Connection string for database `db` (superuser unless a user is given). */
  url(db: string, user?: string, password?: string): string;
}

export interface Minio {
  readonly name: string;
  readonly port: number;
  readonly endpoint: string;
}

async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await sleep(300);
  }
  throw new Error(`${what} did not become ready within ${WAIT_MS / 1000}s`);
}

export async function startPostgres(runId: string, role: string): Promise<Pg> {
  const name = `wx-m36-drill-${runId}-${role}-pg`;
  const port = await freePort();
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=${runId}`,
    "-e",
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    "-p",
    `127.0.0.1:${port}:5432`,
    POSTGRES_IMAGE,
  ]);
  const pg: Pg = {
    name,
    port,
    url: (db, user = PG_SUPERUSER, password = PG_PASSWORD) =>
      `postgres://${user}:${password}@127.0.0.1:${port}/${db}`,
  };
  // The image's init phase answers on the unix socket only; two consecutive TCP successes mean the real server is up.
  let streak = 0;
  await waitFor(`postgres ${name}`, async () => {
    const c = new Client({ connectionString: pg.url("postgres") });
    try {
      await c.connect();
      await c.query("SELECT 1");
      streak += 1;
      return streak >= 2;
    } catch (error) {
      streak = 0;
      throw error;
    } finally {
      await c.end().catch(() => undefined);
    }
  });
  return pg;
}

export async function startMinio(runId: string, role: string, dataTar?: string): Promise<Minio> {
  const name = `wx-m36-drill-${runId}-${role}-minio`;
  const port = await freePort();
  docker([
    "create",
    "--name",
    name,
    "--label",
    `${LABEL}=${runId}`,
    "--user",
    "root",
    "-e",
    `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}`,
    "-p",
    `127.0.0.1:${port}:9000`,
    MINIO_IMAGE,
    "server",
    "/data",
  ]);
  const minio: Minio = { name, port, endpoint: `http://127.0.0.1:${port}` };
  if (dataTar) copyTarInto(minio, dataTar);
  docker(["start", name]);
  await waitMinioReady(minio);
  return minio;
}

async function waitMinioReady(minio: Minio): Promise<void> {
  await waitFor(`minio ${minio.name}`, async () => {
    const res = await fetch(`${minio.endpoint}/minio/health/ready`);
    return res.ok;
  });
}

/** The object-store backup: a tar of the stopped server's /data (the closest real mechanism: a data-volume copy). */
export function backupMinioData(minio: Minio, tarPath: string): void {
  docker(["stop", minio.name]);
  const fd = openSync(tarPath, "w");
  try {
    const res = spawnSync("docker", ["cp", `${minio.name}:/data`, "-"], {
      stdio: ["ignore", fd, "pipe"],
    });
    if (res.status !== 0)
      throw new Error(`docker cp (minio backup) failed: ${res.stderr?.toString()}`);
  } finally {
    closeSync(fd);
  }
}

/** Resume the quiesced source after its volume copy (writes after the backup go here). */
export async function resumeMinio(minio: Minio): Promise<void> {
  docker(["start", minio.name]);
  await waitMinioReady(minio);
}

function copyTarInto(minio: Minio, tarPath: string): void {
  const fd = openSync(tarPath, "r");
  try {
    const res = spawnSync("docker", ["cp", "-", `${minio.name}:/`], {
      stdio: [fd, "ignore", "pipe"],
    });
    if (res.status !== 0)
      throw new Error(`docker cp (minio restore) failed: ${res.stderr?.toString()}`);
  } finally {
    closeSync(fd);
  }
}

/** `bucket/objectKey` of every stored object, read off the server's data directory (no cross-bucket S3 list exists in the adapter). */
export function listStoredObjects(minio: Minio, scratchDir: string): Set<string> {
  mkdirSync(scratchDir, { recursive: true });
  docker(["cp", `${minio.name}:/data`, scratchDir]);
  const found = new Set<string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      if (rel === "" && entry.startsWith(".")) continue; // .minio.sys is server metadata
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, rel === "" ? entry : `${rel}/${entry}`);
      } else if (entry === "xl.meta" && rel.includes("/")) {
        found.add(rel);
      }
    }
  };
  walk(join(scratchDir, "data"), "");
  return found;
}

export function killContainer(name: string): void {
  docker(["kill", name]);
}

export function removeRunContainers(runId: string): void {
  const ids = docker(["ps", "-aq", "--filter", `label=${LABEL}=${runId}`])
    .toString()
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) docker(["rm", "-f", "-v", ...ids]);
}
