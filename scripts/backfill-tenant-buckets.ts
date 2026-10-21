#!/usr/bin/env bun
/**
 * WardenX — create the per-tenant object-store bucket (`tenant-<orgId>`) for every organization that lacks it.
 *
 * M34 provisions the bucket at onboarding, but orgs that predate that (the dev demo org, older tenants) have none, so
 * the first object write 404s. Idempotent (HEAD, then PUT; an "already exists" 409 is success): safe to re-run, and
 * the compose `migrate` step runs it on every `up`. Needs DATABASE_ADMIN_URL (or DATABASE_URL) and MINIO_*.
 *
 * Run:   bun run scripts/backfill-tenant-buckets.ts
 */
import { createDbClient, schema } from "@chartwarden/db";
import {
  createS3TenantStorageProvisioner,
  s3ObjectStoreConfigFromEnv,
} from "../apps/backend/src/modules/22-documents/index";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  const config = s3ObjectStoreConfigFromEnv(process.env);
  if (!connectionString || !config) {
    console.error("DATABASE_ADMIN_URL (or DATABASE_URL) and MINIO_* must be set");
    process.exit(1);
  }
  const provisioner = createS3TenantStorageProvisioner(config);
  const { db, close } = createDbClient({ connectionString });
  let created = 0;
  let existing = 0;
  let failed = 0;
  try {
    for (const org of await db.select({ id: schema.organizations.id }).from(schema.organizations)) {
      try {
        const result = await provisioner.ensureTenantPrefixes({
          organizationId: org.id,
          prefixes: [],
        });
        if (result.created) created += 1;
        else existing += 1;
      } catch (err) {
        failed += 1;
        console.error(`org ${org.id}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
  } finally {
    await close();
  }
  console.log(`tenant buckets: ${created} created, ${existing} already present, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
