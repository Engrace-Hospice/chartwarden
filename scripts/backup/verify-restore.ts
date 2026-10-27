#!/usr/bin/env bun
/**
 * Verify an isolated restore produced by deploy/production/backup/restore.sh (#857).
 *
 *   RESTORE_ENV_FILE=./restore-<id>/restore.env bun run backup:verify-restore
 *
 * On the production host (no bun there) run it from the release image, which carries this repo:
 *   docker run --rm --network host --env-file ./restore-<id>/restore.env -v "$PWD/restore-<id>:$PWD/restore-<id>:ro" \
 *     "$CHARTWARDEN_IMAGE" bun run backup:verify-restore
 *
 * Exit 0 = every check passed; 1 = a check failed; 2 = the verifier could not run.
 */
import { readFileSync } from "node:fs";
import { renderChecks } from "../lib/backup/drill-report";
import { type SnapshotMarker, readManifestGz, verifyRestore } from "../lib/backup/verify-restore";

function loadEnvFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set (RESTORE_ENV_FILE or the environment)`);
  return v;
}

async function main(): Promise<number> {
  const env = { ...loadEnvFile(process.env.RESTORE_ENV_FILE), ...process.env };
  const marker = JSON.parse(
    readFileSync(required(env, "RESTORE_MARKER_FILE"), "utf8"),
  ) as SnapshotMarker;
  const result = await verifyRestore({
    adminUrl: required(env, "RESTORE_ADMIN_URL"),
    appUrl: required(env, "RESTORE_APP_URL"),
    minioEndpoint: required(env, "RESTORE_MINIO_ENDPOINT"),
    minioAccessKey: required(env, "RESTORE_MINIO_ACCESS_KEY"),
    minioSecretKey: required(env, "RESTORE_MINIO_SECRET_KEY"),
    marker,
    manifest: readManifestGz(readFileSync(required(env, "RESTORE_MANIFEST_FILE"))),
  });
  console.log(
    `# Restore verification - snapshot ${marker.snapshotId}\n\n${renderChecks(result.checks)}`,
  );
  return result.checks.every((c) => c.ok) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
