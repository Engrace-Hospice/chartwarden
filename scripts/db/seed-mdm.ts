/**
 * WardenX — MDM canonical demo data (local dev). NOT for production / real provider data.
 *
 * Populates the org-less canonical Master Data directory (external_physician / facility / payer) so
 * the M40 MDM console shows records. These are the public-read "golden" entities (RLS USING(true))
 * that the merge-redirect + per-tenant overlay read paths resolve. In production these come from the
 * NPPES nightly sync (M29) + platform-ops; this seeds a handful by hand for manual UI verification.
 *
 * Idempotent: fixed ids + ON CONFLICT (id) DO NOTHING. Inserted under `session_replication_role =
 * replica` (skip audit triggers + RI), same pattern as the other scripts/db seeds. The payer table
 * also carries the Medicare/Medicaid reference rows from db:seed — these are additive demo payers.
 *
 * Run: bun run db:seed:mdm   (DATABASE_ADMIN_URL or DATABASE_URL from .env)
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

// Fixed ids (1111…/2222…/3333… prefixes) so re-runs are stable and easy to identify/clear.
const PHYSICIANS = [
  [
    "11111111-0000-4000-8000-000000000001",
    "1003000001",
    "Eleanor",
    "Whitfield",
    "MD",
    false,
    "207RH0003X",
    ["NC", "SC"],
    { line1: "100 Hospice Way", city: "Asheville", state: "NC", postalCode: "28801" },
  ],
  [
    "11111111-0000-4000-8000-000000000002",
    "1003000002",
    "Marcus",
    "Delgado",
    "DO",
    false,
    "207RC0000X",
    ["NC"],
    { line1: "22 Cardiology Pkwy", city: "Charlotte", state: "NC", postalCode: "28202" },
  ],
  [
    "11111111-0000-4000-8000-000000000003",
    "1003000003",
    "Priya",
    "Nair",
    "NP",
    true,
    "363L00000X",
    ["NC", "VA"],
    { line1: "7 Palliative Ln", city: "Durham", state: "NC", postalCode: "27701" },
  ],
  [
    "11111111-0000-4000-8000-000000000004",
    "1003000004",
    "Samuel",
    "Okonkwo",
    "MD",
    false,
    "2084N0400X",
    ["NC"],
    { line1: "410 Neurology Ct", city: "Raleigh", state: "NC", postalCode: "27601" },
  ],
  [
    "11111111-0000-4000-8000-000000000005",
    "1003000005",
    "Hannah",
    "Berg",
    "NP",
    true,
    "363LX0001X",
    ["SC"],
    { line1: "55 Comfort Rd", city: "Greenville", state: "SC", postalCode: "29601" },
  ],
] as const;

// [id, ccn|null, npi, kind, name, address, sendingFacilityCodes]
const FACILITIES = [
  [
    "22222222-0000-4000-8000-000000000001",
    "340001",
    "1093000001",
    "hospital",
    "Mission Regional Medical Center",
    { line1: "509 Biltmore Ave", city: "Asheville", state: "NC", postalCode: "28801" },
    ["MISSION_ADT"],
  ],
  [
    "22222222-0000-4000-8000-000000000002",
    "345012",
    "1093000002",
    "snf",
    "Oakdale Skilled Nursing",
    { line1: "88 Oakdale Dr", city: "Charlotte", state: "NC", postalCode: "28210" },
    [],
  ],
  [
    "22222222-0000-4000-8000-000000000003",
    "341500",
    "1093000003",
    "ipu",
    "Engrace Inpatient Hospice Unit",
    { line1: "12 Serenity Blvd", city: "Durham", state: "NC", postalCode: "27704" },
    [],
  ],
  [
    "22222222-0000-4000-8000-000000000004",
    null,
    "1093000004",
    "alf",
    "Brookhaven Assisted Living",
    { line1: "300 Brookhaven Way", city: "Raleigh", state: "NC", postalCode: "27612" },
    [],
  ],
] as const;

// [id, kind, stateCode|null, payerId, name]
const PAYERS = [
  ["33333333-0000-4000-8000-000000000001", "commercial", null, "AETNA", "Aetna"],
  [
    "33333333-0000-4000-8000-000000000002",
    "commercial",
    "NC",
    "BCBSNC",
    "Blue Cross Blue Shield of North Carolina",
  ],
  [
    "33333333-0000-4000-8000-000000000003",
    "medicare_advantage",
    null,
    "HUMANA-MA",
    "Humana Medicare Advantage",
  ],
] as const;

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // skip audit triggers + RI for the seed

  for (const [id, npi, first, last, creds, isNp, taxonomy, states, addr] of PHYSICIANS) {
    await db.query(
      `INSERT INTO external_physician
         (id, npi, first_name, last_name, credentials, is_np, specialty_taxonomy, license_states,
          primary_address, contact_methods, status, merged_from, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,'active','{}',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [id, npi, first, last, creds, isNp, taxonomy, states, JSON.stringify(addr)],
    );
  }

  for (const [id, ccn, npi, kind, name, addr, codes] of FACILITIES) {
    await db.query(
      `INSERT INTO facility
         (id, ccn, npi, kind, name, primary_address, sending_facility_codes, status, merged_from,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active','{}',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [id, ccn, npi, kind, name, JSON.stringify(addr), JSON.stringify(codes)],
    );
  }

  for (const [id, kind, stateCode, payerId, name] of PAYERS) {
    await db.query(
      `INSERT INTO payer (id, kind, state_code, payer_id, name, status, merged_from, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active','{}',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [id, kind, stateCode, payerId, name],
    );
  }

  await db.end();
  console.log(
    `✓ MDM seed: ${PHYSICIANS.length} physicians, ${FACILITIES.length} facilities, ` +
      `${PAYERS.length} demo payers (canonical directory). Open /mdm and switch the entity kind.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
