import { PROVISION_MINIO_PREFIXES } from "@chartwarden/saas-tenant-platform";
import { Client } from "pg";
import {
  createS3TenantStorageProvisioner,
  s3ObjectStoreConfigFromEnv,
} from "../../apps/backend/src/modules/22-documents/index";

export interface TenantStorageReconcilePort {
  listTenantOrganizationIds(): Promise<readonly string[]>;
  ensureTenantPrefixes(input: {
    readonly organizationId: string;
    readonly prefixes: readonly string[];
  }): Promise<{ readonly bucket: string; readonly created: boolean }>;
}

export interface TenantStorageReconcileResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
  readonly errors: readonly { readonly organizationId: string; readonly error: string }[];
}

export async function reconcileTenantStorage(
  port: TenantStorageReconcilePort,
  log: Pick<Console, "log" | "error"> = console,
): Promise<TenantStorageReconcileResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const errors: { organizationId: string; error: string }[] = [];

  for (const organizationId of await port.listTenantOrganizationIds()) {
    try {
      const result = await port.ensureTenantPrefixes({
        organizationId,
        prefixes: PROVISION_MINIO_PREFIXES,
      });
      if (result.created) {
        created.push(result.bucket);
        log.log(`created ${result.bucket}`);
      } else {
        existing.push(result.bucket);
        log.log(`exists  ${result.bucket}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ organizationId, error: message });
      log.error(`error   tenant-${organizationId}: ${message}`);
    }
  }

  log.log(
    `tenant storage reconcile complete: ${created.length} created, ${existing.length} existing, ${errors.length} errors`,
  );
  return { created, existing, errors };
}

async function listActiveTenantOrganizationIds(db: Client): Promise<readonly string[]> {
  const rows = await db.query<{ organization_id: string }>(
    `SELECT organization_id
       FROM tenant_account
      WHERE status NOT IN ('destroyed', 'destruction_pending')
      ORDER BY organization_id`,
  );
  return rows.rows.map((row) => row.organization_id);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_PLATFORM_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_PLATFORM_URL is required; use the wardenx_platform_login credential, not a tenant or superuser connection",
    );
  }
  const s3Config = s3ObjectStoreConfigFromEnv(process.env);
  if (!s3Config) {
    throw new Error("MINIO_ENDPOINT, MINIO_ACCESS_KEY, and MINIO_SECRET_KEY are required");
  }

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const provisioner = createS3TenantStorageProvisioner(s3Config);
    const result = await reconcileTenantStorage({
      listTenantOrganizationIds: () => listActiveTenantOrganizationIds(db),
      ensureTenantPrefixes: (input) => provisioner.ensureTenantPrefixes(input),
    });
    if (result.errors.length > 0) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
