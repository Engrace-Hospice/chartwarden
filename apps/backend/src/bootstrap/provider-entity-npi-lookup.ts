// apps/backend/src/bootstrap/provider-entity-npi-lookup.ts — M1 Foundation's cross-tenant reads of its own
// `provider_entity` for M23's Claim.MD intake (one vendor account serves every tenant, ADR-0053 D8):
//   - providerEntityByNpi: which tenant and provider entity an NPI names (`npi` is unique platform-wide, so at most one);
//   - providerEntityById / listProviderEntitiesForPlatform: what the platform NPI-verification screen shows and verifies.
// All run on the PLATFORM role inside the caller's own audited withPlatformContext transaction (the caller passes that
// tx). The platform carrier holds a COLUMN grant on (id, organization_id, npi, legal_name) only
// (scripts/db/provision-runtime-roles.ts). Whether an NPI is platform-verified is M23's own table
// (provider_npi_verification); M23 checks it, not this file.
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";

export interface ProviderEntityByNpi {
  readonly id: string;
  readonly organizationId: string;
}

export interface PlatformProviderEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly legalName: string;
  readonly npi: string;
}

type Rows<T> = { rows: T[] };

export async function providerEntityByNpi(
  tx: DbClient,
  npi: string,
): Promise<ProviderEntityByNpi | null> {
  const res = (await tx.execute(
    sql`SELECT id, organization_id FROM provider_entity WHERE npi = ${npi}`,
  )) as unknown as Rows<{ id: string; organization_id: string }>;
  const row = res.rows[0];
  return row ? { id: row.id, organizationId: row.organization_id } : null;
}

interface EntityRow {
  id: string;
  organization_id: string;
  organization_name: string;
  legal_name: string;
  npi: string;
}

const toEntity = (r: EntityRow): PlatformProviderEntity => ({
  id: r.id,
  organizationId: r.organization_id,
  organizationName: r.organization_name,
  legalName: r.legal_name,
  npi: r.npi,
});

export async function providerEntityById(
  tx: DbClient,
  id: string,
): Promise<PlatformProviderEntity | null> {
  const res = (await tx.execute(
    sql`SELECT pe.id, pe.organization_id, o.display_name AS organization_name, pe.legal_name, pe.npi
        FROM provider_entity pe JOIN organization o ON o.id = pe.organization_id
        WHERE pe.id = ${id}`,
  )) as unknown as Rows<EntityRow>;
  const row = res.rows[0];
  return row ? toEntity(row) : null;
}

// ponytail: every provider entity in one response; hospice provider entities number in the hundreds platform-wide. Add
// a keyset cursor when the list outgrows one screen.
export async function listProviderEntitiesForPlatform(
  tx: DbClient,
): Promise<PlatformProviderEntity[]> {
  const res = (await tx.execute(
    sql`SELECT pe.id, pe.organization_id, o.display_name AS organization_name, pe.legal_name, pe.npi
        FROM provider_entity pe JOIN organization o ON o.id = pe.organization_id
        ORDER BY o.display_name, pe.legal_name, pe.id`,
  )) as unknown as Rows<EntityRow>;
  return res.rows.map(toEntity);
}
