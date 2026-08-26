/**
 * WardenX — clinical demo data for the Patient Chart M5 tabs (local dev). NOT for production / real PHI.
 *
 * The built, data-fetching chart tabs are M5-owned (Demographics, Identifiers, Addresses, Coverage/
 * Payers, Care Team, Privacy Flags). Most have no POST route, so this seeds their tables directly under
 * `session_replication_role = replica` (skip M4 audit triggers + RI, same pattern as scripts/db/seed.ts).
 * Cross-module tabs (Care Plan/Encounters/Orders/eMAR…) are Track B — their routes aren't mounted, so
 * there's no built screen to show them yet.
 *
 * Idempotent: clears prior demo clinical rows for the demo patients, then re-inserts.
 * Prereqs: bun run db:seed:patients (the 6 demo patients must exist).
 * Run:     bun run db:seed:clinical
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "wardenx-demo";

// Fixed payer ids so re-runs are stable.
const PAYER_MEDICARE = "00000000-0000-0000-0000-0000000000a1";
const PAYER_MEDICAID_NC = "00000000-0000-0000-0000-0000000000a2";

// Per-patient demographic + relationship detail, applied in last-name order (deterministic).
const DETAIL = [
  {
    gi: "female",
    pr: "she_her",
    ms: "widowed",
    race: ["2106-3"],
    eth: ["2186-5"],
    mbi: "1EG4TE5MK73",
    cg: {
      first: "Thomas",
      last: "Brandt",
      rel: "child",
      lr: "dpoa_healthcare",
      phone: "+18285550100",
    },
    ec: [
      { name: "Thomas Brandt", rel: "Son", phone: "+18285550100", pri: 1 },
      { name: "Linda Pearce", rel: "Neighbor", phone: "+18285550101", pri: 2 },
    ],
    payers: ["medicare"],
    flags: [] as string[],
  },
  {
    gi: "female",
    pr: "she_her",
    ms: "married",
    race: ["2054-5"],
    eth: ["2186-5"],
    mbi: "2CW3RD8KH49",
    cg: {
      first: "Miguel",
      last: "Delgado",
      rel: "spouse",
      lr: "next_of_kin",
      phone: "+18285550110",
    },
    ec: [{ name: "Miguel Delgado", rel: "Spouse", phone: "+18285550110", pri: 1 }],
    payers: ["medicare", "medicaid"],
    flags: [],
  },
  {
    gi: "male",
    pr: "he_him",
    ms: "widowed",
    race: ["2106-3"],
    eth: ["2186-5"],
    mbi: "3FT6GH2JL90",
    cg: { first: "Grace", last: "Fairbanks", rel: "child", lr: "guardian", phone: "+18285550120" },
    ec: [{ name: "Grace Fairbanks", rel: "Daughter", phone: "+18285550120", pri: 1 }],
    payers: ["medicare"],
    flags: [],
  },
  {
    gi: "male",
    pr: "he_him",
    ms: "married",
    race: ["2028-9"],
    eth: ["2186-5"],
    mbi: "4KM5PN7QR28",
    cg: {
      first: "Yuki",
      last: "Nakamura",
      rel: "spouse",
      lr: "dpoa_healthcare",
      phone: "+18285550130",
    },
    ec: [{ name: "Yuki Nakamura", rel: "Spouse", phone: "+18285550130", pri: 1 }],
    payers: ["medicare", "medicaid"],
    flags: [],
  },
  {
    gi: "male",
    pr: "he_him",
    ms: "divorced",
    race: ["2054-5"],
    eth: ["2135-2"],
    mbi: "5DA9VE3WX64",
    cg: { first: "Rosa", last: "Okonkwo", rel: "child", lr: "next_of_kin", phone: "+18285550140" },
    ec: [{ name: "Rosa Okonkwo", rel: "Daughter", phone: "+18285550140", pri: 1 }],
    payers: ["medicare"],
    flags: ["sud_part2"],
  },
  {
    gi: "female",
    pr: "she_her",
    ms: "widowed",
    race: ["2106-3"],
    eth: ["2186-5"],
    mbi: "6HU2YC8KT57",
    cg: {
      first: "Arthur",
      last: "Whitfield",
      rel: "child",
      lr: "dpoa_healthcare",
      phone: "+18285550150",
    },
    ec: [
      { name: "Arthur Whitfield", rel: "Son", phone: "+18285550150", pri: 1 },
      { name: "Eve Carter", rel: "Friend", phone: "+18285550151", pri: 2 },
    ],
    payers: ["medicare"],
    flags: [],
  },
];

// Primary home address per patient (last-name order). Admit doesn't persist primaryAddress, so seed here.
const ADDR = [
  { line1: "76 Riverside Dr", city: "Asheville", state: "NC", postal: "28804" }, // Brandt
  { line1: "9 Mountain View Ct", city: "Hendersonville", state: "NC", postal: "28792" }, // Delgado
  { line1: "215 Oak Knoll Dr", city: "Black Mountain", state: "NC", postal: "28711" }, // Fairbanks
  { line1: "330 Sweeten Creek Rd", city: "Asheville", state: "NC", postal: "28803" }, // Nakamura
  { line1: "1187 Birch St", city: "Asheville", state: "NC", postal: "28805" }, // Okonkwo
  { line1: "42 Camellia Ln", city: "Asheville", state: "NC", postal: "28801" }, // Whitfield
];

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // skip audit triggers + RI for the seed

  const orgRes = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG_SLUG,
  ]);
  const org = orgRes.rows[0]?.id;
  if (!org) throw new Error("demo org not found — run db:seed first");

  const users = await db.query<{ email: string; id: string }>(
    `SELECT email, id FROM "user"
      WHERE email IN ('admin@wardenx.local','casey@wardenx.local','rita@wardenx.local')`,
  );
  // F-014 (#39) — the caseload anchor decides who `caseload_or_scope` lets through, and every
  // scenario seed acts as the RN Case Manager persona. `caseload_or_scope` (M7 §6, and the ~nine
  // other modules that bind the name) is satisfied by an OPEN `patient_assignment` row for the
  // CALLING user, so a caseload anchored to one clinician while seed-scenario-clinical-core.ts
  // signs in as another denies every M7/M8/M9/M10 write — and `notFoundOnDeny: true` reports it as
  // NOT_FOUND rather than a denial.
  //
  // Prefer rita when she exists; fall back to `casey@wardenx.local` (the base demo Clinician) when
  // she does not. In the `db:seed:all` chain `db:seed:staff` runs immediately BEFORE this script
  // (#39 moved it there precisely so rita exists by now), so the persona branch is the one that
  // runs and the caseload is anchored to her in one pass. The fallback is what keeps this script
  // working when it is run STANDALONE against a tenant that has no personas yet.
  //
  // `db:seed:staff` also re-anchors on its own (`anchorDemoCaseload`, seed-staff-personas.ts), which
  // it must regardless of order: it drops and re-creates rita's user row on every run, so a caseload
  // anchored to a previous run's rita would point at a user id that no longer exists.
  const personaRn = users.rows.find((u) => u.email === "rita@wardenx.local")?.id;
  const baseRn = users.rows.find((u) => u.email === "casey@wardenx.local")?.id;
  const rn = personaRn ?? baseRn;
  const md = users.rows.find((u) => u.email === "admin@wardenx.local")?.id; // attending = admin
  if (!rn || !md) throw new Error("demo users not found — run db:seed first");
  const rnEmail = personaRn ? "rita@wardenx.local" : "casey@wardenx.local";

  const pats = await db.query<{ id: string }>(
    "SELECT id FROM patient WHERE organization_id = $1 ORDER BY legal_last_name",
    [org],
  );
  if (pats.rowCount !== DETAIL.length) {
    console.log(
      `note: ${pats.rowCount} patients found, ${DETAIL.length} detail rows — seeding min of both.`,
    );
  }
  const ids = pats.rows.map((r) => r.id);

  // Payer canonical (M40) — fixed ids, upsert.
  await db.query(
    `INSERT INTO payer (id, kind, state_code, payer_id, name, status, merged_from)
     VALUES ($1,'medicare',NULL,'MEDICARE','Medicare (CMS)','active','{}'),
            ($2,'medicaid','NC','NC-MEDICAID','North Carolina Medicaid','active','{}')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [PAYER_MEDICARE, PAYER_MEDICAID_NC],
  );

  // Idempotent cleanup for the demo patients.
  for (const t of [
    "patient_payer",
    "emergency_contact",
    "patient_caregiver",
    "patient_assignment",
    "patient_address",
  ]) {
    await db.query(`DELETE FROM ${t} WHERE patient_id = ANY($1)`, [ids]);
  }
  await db.query(`DELETE FROM patient_identifier WHERE patient_id = ANY($1) AND kind = 'mbi'`, [
    ids,
  ]);
  await db.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id = ANY($1)", [ids]);
  // orphan caregivers from a prior run (not referenced by any patient_caregiver)
  await db.query(
    `DELETE FROM caregiver c WHERE organization_id = $1
       AND NOT EXISTS (SELECT 1 FROM patient_caregiver pc WHERE pc.caregiver_id = c.id)`,
    [org],
  );

  const today = "2026-02-01";
  let n = 0;
  for (let i = 0; i < Math.min(ids.length, DETAIL.length); i++) {
    const pid = ids[i];
    const d = DETAIL[i];

    // Demographics (UPDATE the patient spine)
    await db.query(
      `UPDATE patient SET gender_identity_code=$2, pronouns_code=$3, marital_status_code=$4,
         race_codes=$5, ethnicity_codes=$6, updated_at=now() WHERE id=$1`,
      [pid, d.gi, d.pr, d.ms, d.race, d.eth],
    );

    // Primary home address
    const a = ADDR[i];
    await db.query(
      `INSERT INTO patient_address (patient_id, organization_id, kind, line1, city, state, postal_code,
         country, is_primary, effective_from)
       VALUES ($1,$2,'home',$3,$4,$5,$6,'US',true,$7)`,
      [pid, org, a.line1, a.city, a.state, a.postal, today],
    );

    // MBI identifier
    await db.query(
      `INSERT INTO patient_identifier (patient_id, organization_id, kind, value, issuer, effective_from)
       VALUES ($1,$2,'mbi',$3,'CMS',$4)`,
      [pid, org, d.mbi, "2024-01-01"],
    );

    // Care team — assignments (RN drives caseload), one caregiver, emergency contacts
    await db.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',$5), ($1,$2,$4,'attending_clinician',$5)`,
      [pid, org, rn, md, today],
    );
    const cg = await db.query<{ id: string }>(
      `INSERT INTO caregiver (organization_id, first_name, last_name, phone)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [org, d.cg.first, d.cg.last, d.cg.phone],
    );
    await db.query(
      `INSERT INTO patient_caregiver (patient_id, caregiver_id, organization_id, relationship, is_primary,
         is_legal_representative, lr_authority, portal_invitation_consented, involvement_from)
       VALUES ($1,$2,$3,$4,true,$5,$6,false,$7)`,
      [pid, cg.rows[0].id, org, d.cg.rel, d.cg.lr !== "none", d.cg.lr, today],
    );
    for (const e of d.ec) {
      await db.query(
        `INSERT INTO emergency_contact (patient_id, organization_id, name, relationship, phone, priority)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pid, org, e.name, e.rel, e.phone, e.pri],
      );
    }

    // Coverage / payers
    let rank = 1;
    for (const kind of d.payers) {
      const payerId = kind === "medicare" ? PAYER_MEDICARE : PAYER_MEDICAID_NC;
      const coverageKind = kind === "medicare" ? "medicare_ffs" : "medicaid";
      await db.query(
        `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind,
           subscriber_id, effective_from)
         VALUES ($1,$2,$3,$4,$5::patient_payer_coverage_kind,$6,$7)`,
        [pid, org, payerId, rank, coverageKind, d.mbi, "2024-01-01"],
      );
      rank++;
    }

    // Privacy flags (one patient gets a Part-2/SUD restriction to exercise the gated tab)
    if (d.flags.length) {
      await db.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, captured_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (patient_id) DO UPDATE SET flags = EXCLUDED.flags, captured_at = now()`,
        [pid, org, d.flags],
      );
    }
    n++;
  }

  await db.end();
  console.log(
    `✓ clinical seed: enriched ${n} patients (demographics, MBI, care team, payers; ` +
      `${DETAIL.filter((d) => d.flags.length).length} with a privacy flag). Caseload RN = ${rnEmail}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
