// The canonical <-> legacy object-store credential pairs deploy.sh reconciles in `.env.production` (additive
// compatibility release). One list for every deployment test, so a pair added to deploy.sh fails here until the tests
// follow: object-store-env-contract.test.ts compares this list with deploy.sh's own OBJECT_STORE_ENV_PAIRS.
//
// `canonical` is what compose.yml and object-store-provision read; `legacy` is the rollback alias a release that
// predates the rename still reads (and, for MINIO_ROOT_*, also the real legacy-MinIO root credential).

export interface ObjectStoreEnvPair {
  readonly canonical: string;
  readonly legacy: string;
}

export const OBJECT_STORE_ENV_PAIRS: readonly ObjectStoreEnvPair[] = [
  { canonical: "SEAWEEDFS_ADMIN_ACCESS_KEY", legacy: "MINIO_ROOT_USER" },
  { canonical: "SEAWEEDFS_ADMIN_SECRET_KEY", legacy: "MINIO_ROOT_PASSWORD" },
  { canonical: "SEAWEEDFS_APP_ACCESS_KEY", legacy: "MINIO_APP_ACCESS_KEY" },
  { canonical: "SEAWEEDFS_APP_SECRET_KEY", legacy: "MINIO_APP_SECRET_KEY" },
  { canonical: "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN", legacy: "MINIO_ACCESS_LOG_WEBHOOK_TOKEN" },
];

/** Legacy alias name -> canonical name. */
export const CANONICAL_OF_LEGACY: ReadonlyMap<string, string> = new Map(
  OBJECT_STORE_ENV_PAIRS.map((p) => [p.legacy, p.canonical]),
);

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
