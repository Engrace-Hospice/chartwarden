// apps/backend/src/bootstrap/provider-entity-npi-lookup.ts — M1 Foundation's one cross-tenant read of its own
// `provider_entity`: which tenant and provider entity an NPI names. `provider_entity.npi` is unique platform-wide, so the
// answer is at most one row. Used by M23's Claim.MD webhook sweep (one vendor account serves every tenant, ADR-0053 D8) on
// the PLATFORM role, inside its own audited withPlatformContext transaction (the caller passes that tx). The platform
// carrier holds a COLUMN grant on (id, organization_id, npi) only (scripts/db/provision-runtime-roles.ts).
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";

export interface ProviderEntityByNpi {
  readonly id: string;
  readonly organizationId: string;
}

export async function providerEntityByNpi(
  tx: DbClient,
  npi: string,
): Promise<ProviderEntityByNpi | null> {
  const res = (await tx.execute(
    sql`SELECT id, organization_id FROM provider_entity WHERE npi = ${npi}`,
  )) as unknown as { rows: { id: string; organization_id: string }[] };
  const row = res.rows[0];
  return row ? { id: row.id, organizationId: row.organization_id } : null;
}
