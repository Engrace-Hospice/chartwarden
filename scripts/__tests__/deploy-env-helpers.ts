// Shared fixtures for the deploy.sh tests that exercise `.env.production` handling against a stubbed docker.

/**
 * The object-store variables deploy.sh makes sure exist in `.env.production` (generated once when absent, never rotated).
 * compose.yml reads exactly these; the retired MINIO_* rollback aliases are not among them.
 */
export const OBJECT_STORE_ENV_NAMES: readonly string[] = [
  "SEAWEEDFS_ADMIN_ACCESS_KEY",
  "SEAWEEDFS_ADMIN_SECRET_KEY",
  "SEAWEEDFS_APP_ACCESS_KEY",
  "SEAWEEDFS_APP_SECRET_KEY",
  "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN",
];

/** The MINIO_* names a host that ran the SeaweedFS compatibility release may still carry (unused now). */
export const LEFTOVER_MINIO_ENV_NAMES: readonly string[] = [
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "MINIO_APP_ACCESS_KEY",
  "MINIO_APP_SECRET_KEY",
  "MINIO_ACCESS_LOG_WEBHOOK_TOKEN",
];

/** Distinct, obviously synthetic values: a value found in deploy output is a leak, never a coincidence. */
export function syntheticValue(name: string, flavour: "old" | "new"): string {
  return `synthetic-${flavour}-${name.toLowerCase().replace(/_/g, "-")}-not-a-real-secret`;
}

/** Last value wins, the way compose reads an env file; `count` is how many lines name the key. */
export function envEntry(
  envText: string,
  key: string,
): { readonly value: string | undefined; readonly count: number } {
  const hits = envText.split("\n").filter((line) => line.startsWith(`${key}=`));
  const last = hits[hits.length - 1];
  return { value: last === undefined ? undefined : last.slice(key.length + 1), count: hits.length };
}
