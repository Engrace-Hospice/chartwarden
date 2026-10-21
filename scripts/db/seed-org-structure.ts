/**
 * ChartWarden — org structure demo data: provider_entity + location (local dev). NOT for production.
 *
 * M1 Foundation owns `provider_entity`/`location` (§3.4/§3.5) but exposes NO REST route to create
 * either — confirmed by reading every M1/M2 route file: the only reference anywhere in the backend
 * is read-only SELECTs, and the closest write path (`POST /api/v1/platform/tenants`) is gated on
 * platform_ops + step-up and enqueues an async provisioning worker, not a synchronous row you can
 * chain off of. So — same as `scripts/db/seed.ts` already does for organization/user/role/membership
 * — this seeds both tables directly via raw SQL under `session_replication_role = replica`.
 *
 * These two rows are a hard prerequisite for M6 admission (hospiceMedicalDirectorId references a
 * provider_entity's... no, actually the M6 admission body takes physician ids referencing
 * `external_physician`/staff, NOT provider_entity directly — but `election-statements` needs an
 * `electedProviderEntityId`, M17 scheduling/M37 IPU need a `location`, and M23/M24/M27 billing all
 * key claims/cost-reports to a `providerEntityId`). Fixed ids so re-runs are stable.
 *
 * Idempotent: fixed ids + ON CONFLICT (id) DO NOTHING.
 * Prereqs: bun run db:seed (the demo org must exist).
 * Run:     bun run db:seed:org-structure
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "chartwarden-demo";

// Fixed id so downstream scenario scripts can reference it without a lookup.
export const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001";
export const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001";
export const LOCATION_IPU_ID = "55555555-0000-4000-8000-000000000002";

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // skip audit triggers + RI for the seed

  const orgRes = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG_SLUG,
  ]);
  const orgId = orgRes.rows[0]?.id;
  if (!orgId) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);

  await db.query(
    `INSERT INTO provider_entity
       (id, organization_id, ccn, legal_name, doing_business_as, fiscal_intermediary, npi,
        tax_id_encrypted, fiscal_year_end, addresses, iqies_facility_id, status, created_at, updated_at)
     VALUES ($1,$2,'381588','Engrace Hospice, Inc.','Engrace Hospice','CGS Administrators',
             '1234567890','enc:demo-tax-id-not-real','1231',
             -- Demo provider fixture: CCN 381588, Pendleton, Oregon (ZIP 97801, Umatilla County). Never a default.
             '[{"line1":"100 Hospice Way","city":"Pendleton","state":"OR","postalCode":"97801"}]'::jsonb,
             -- Demo iQIES facility ID (HOPE FAC_ID); a real one is assigned by CMS at iQIES registration.
             'DEMO381588', 'active', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [PROVIDER_ENTITY_ID, orgId],
  );

  await db.query(
    `INSERT INTO location
       (id, provider_entity_id, name, address_line1, city, state, postal_code, phone, timezone,
        service_area, status, created_at, updated_at)
     VALUES ($1,$2,'Engrace Hospice — Main Office','100 Hospice Way','Asheville','NC','28801',
             '+18285550100','America/New_York',
             '["28801","28803","28804","28805","28792","28711"]'::jsonb,'active', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [LOCATION_MAIN_ID, PROVIDER_ENTITY_ID],
  );

  // A second location tagged for inpatient use — M37 IPU admission needs a `facilityId`/location
  // to assign a GIP/respite bed to (the M6 level-of-care route's `facilityId` field).
  await db.query(
    `INSERT INTO location
       (id, provider_entity_id, name, address_line1, city, state, postal_code, phone, timezone,
        service_area, status, created_at, updated_at)
     VALUES ($1,$2,'Engrace Hospice — Inpatient Unit','12 Serenity Blvd','Durham','NC','27704',
             '+19195550200','America/New_York','[]'::jsonb,'active', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [LOCATION_IPU_ID, PROVIDER_ENTITY_ID],
  );

  // The tenant-admin demo logins (`db:seed` admin@ + `db:seed:org-admin` orgadmin@) are created BEFORE any
  // location exists, so their membership carries no provider-entity scope and `default_location_ids = []` —
  // and empty scope can never contain a target's id, so provider/location-scoped ABAC predicates deny the
  // primary admin login. Assign the demo provider entity and both locations now that they exist.
  // Additive and idempotent: only ever UNIONS in the two ids (never removes an existing assignment), and only
  // touches these two accounts' memberships in the demo org. (The clinical personas from `db:seed:staff` are
  // already scoped to the main office by that script.)
  const assigned = await db.query(
    `UPDATE membership m
        SET default_provider_entity_id = $2,
            default_location_ids = (
              SELECT COALESCE(jsonb_agg(DISTINCT v ORDER BY v), '[]'::jsonb)
                FROM jsonb_array_elements_text(m.default_location_ids || $3::jsonb) AS t(v)
            )
       FROM "user" u
      WHERE u.id = m.user_id
        AND m.organization_id = $1
        AND u.email IN ('admin@chartwarden.local', 'orgadmin@chartwarden.local')
        AND (m.default_provider_entity_id IS DISTINCT FROM $2
             OR NOT (m.default_location_ids @> $3::jsonb))`,
    [orgId, PROVIDER_ENTITY_ID, JSON.stringify([LOCATION_MAIN_ID, LOCATION_IPU_ID])],
  );

  await db.end();
  console.log(
    `✓ org structure seed: ${assigned.rowCount ?? 0} admin membership(s) assigned to the demo provider entity and both locations.`,
  );
  console.log(
    `✓ org structure seed: provider_entity ${PROVIDER_ENTITY_ID} (CCN 341234), ` +
      `locations ${LOCATION_MAIN_ID} (main) + ${LOCATION_IPU_ID} (IPU).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
