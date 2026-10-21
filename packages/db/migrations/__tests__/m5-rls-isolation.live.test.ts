/**
 * M5 Patient & Demographics — RLS cross-tenant denial — LIVE Postgres (§9.3).
 *
 * WHY THIS SUITE EXISTS. M5 owns 16 tables and exactly ONE of them (`patient`) was named in any live
 * RLS suite — the `Live` ratio read `2/16`. That is the wrong one to stop at: the identifying detail
 * is in the SATELLITES. `patient` holds a name and a DOB, but `patient_identifier` holds the MBI and
 * the SSN, `patient_address`/`_phone`/`_email` hold contact details, `patient_privacy_flag_snapshot`
 * holds the 42 CFR Part 2 / VIP markers, and `patient_merge` / `patient_match_review` hold the
 * candidate pairs from identity resolution — i.e. rows that name TWO people at once. A policy on the
 * root with a leaky satellite is not tenant isolation; it is a locked front door beside an open window.
 *
 * Every table here is unpartitioned, so there are no leaves to reason about; the partition-leaf cases
 * live in the baseline and M23 suites.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  patient: string;
  identifier: string;
  alias: string;
  address: string;
  phone: string;
  email: string;
  payer: string;
  caregiver: string;
  patientCaregiver: string;
  emergencyContact: string;
  assignment: string;
  commPref: string;
  privacyFlags: string;
  amendment: string;
  matchReview: string;
  merge: string;
};

/**
 * All 16 M5-owned tables — every one is org-scoped, so every one belongs here.
 * `idCol` covers the two that are keyed on `patient_id` rather than a surrogate `id`
 * (a chart has exactly one comms preference and one privacy-flag snapshot).
 */
const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "patient", key: "patient" },
  { table: "patient_identifier", key: "identifier" },
  { table: "patient_name_alias", key: "alias" },
  { table: "patient_address", key: "address" },
  { table: "patient_phone", key: "phone" },
  { table: "patient_email", key: "email" },
  { table: "patient_payer", key: "payer" },
  { table: "caregiver", key: "caregiver" },
  { table: "patient_caregiver", key: "patientCaregiver" },
  { table: "emergency_contact", key: "emergencyContact" },
  { table: "patient_assignment", key: "assignment" },
  { table: "patient_communication_preference", key: "commPref", idCol: "patient_id" },
  { table: "patient_privacy_flag_snapshot", key: "privacyFlags", idCol: "patient_id" },
  { table: "patient_amendment_request", key: "amendment" },
  { table: "patient_match_review", key: "matchReview" },
  { table: "patient_merge", key: "merge" },
];

describe.skipIf(!DB_URL)("M5 Patient — RLS cross-tenant denial — LIVE Postgres (§9.3)", () => {
  let db: Client;
  let a: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN
           EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
  }

  /** Seed one full M5 chart for `org` as superuser (RLS + grants bypassed). `n` distinguishes rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const day = "1940-01-01";
    const from = "2026-01-01";
    const one = async (sql: string, params: unknown[]): Promise<string> =>
      (await db.query(sql, params)).rows[0].id as string;

    // `patient_assignment.clinician_user_id` and `patient_amendment_request.requested_by_user_id` are
    // REAL foreign keys to the M1-owned `user` (unlike most cross-module ids in the billing modules,
    // which are plain uuids), so a sentinel will not do — seed an actual user per org.
    const user = await one(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
      `clinician-${n}@example.test`,
    ]);

    const patient = await one(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,'Ada','Tenant',$3,'female') RETURNING id`,
      [org, `MRN-${n}`, day],
    );
    // `patient_identifier_public_plaintext`: CHECK (kind IN ('ssn','state_id') OR value IS NOT NULL) —
    // the two identifiers that must never sit in plaintext live in `value_encrypted`, everything else
    // keeps a readable `value`. Seed BOTH shapes so the isolation cases cover the encrypted one too.
    const identifier = await one(
      `INSERT INTO patient_identifier (patient_id, organization_id, kind, value, effective_from)
       VALUES ($1,$2,'mbi',$3,$4) RETURNING id`,
      [patient, org, `1EG4TE5MK7${n}`, from],
    );
    await db.query(
      `INSERT INTO patient_identifier (patient_id, organization_id, kind, value_encrypted, value_last4, effective_from)
       VALUES ($1,$2,'ssn','cipher',$3,$4)`,
      [patient, org, `000${n}`, from],
    );
    const alias = await one(
      `INSERT INTO patient_name_alias (patient_id, organization_id, kind) VALUES ($1,$2,'preferred') RETURNING id`,
      [patient, org],
    );
    const address = await one(
      // `patient_address_us_state_required`: CHECK (country <> 'US' OR state IS NOT NULL) — `country`
      // defaults to 'US', so a US address without a state is refused.
      `INSERT INTO patient_address (patient_id, organization_id, line1, city, state, postal_code, effective_from)
       VALUES ($1,$2,'1 Main St','Town','OR','97000',$3) RETURNING id`,
      [patient, org, from],
    );
    const phone = await one(
      "INSERT INTO patient_phone (patient_id, organization_id, e164) VALUES ($1,$2,$3) RETURNING id",
      [patient, org, `+150055500${n}0`],
    );
    const email = await one(
      "INSERT INTO patient_email (patient_id, organization_id, email) VALUES ($1,$2,$3) RETURNING id",
      [patient, org, `p${n}@example.test`],
    );
    const payer = await one(
      `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
       VALUES ($1,$2,gen_random_uuid(),1,'medicare_ffs',$3,$4) RETURNING id`,
      [patient, org, `SUB-${n}`, from],
    );
    const caregiver = await one(
      `INSERT INTO caregiver (organization_id, first_name, last_name) VALUES ($1,'Care','Giver') RETURNING id`,
      [org],
    );
    const patientCaregiver = await one(
      `INSERT INTO patient_caregiver (patient_id, caregiver_id, organization_id, relationship, involvement_from)
       VALUES ($1,$2,$3,'child',$4) RETURNING id`,
      [patient, caregiver, org, from],
    );
    const emergencyContact = await one(
      `INSERT INTO emergency_contact (patient_id, organization_id, name, relationship, phone)
       VALUES ($1,$2,'Next Kin','child',$3) RETURNING id`,
      [patient, org, `+150055501${n}0`],
    );
    const assignment = await one(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',$4) RETURNING id`,
      [patient, org, user, from],
    );
    const commPref = await one(
      "INSERT INTO patient_communication_preference (patient_id, organization_id) VALUES ($1,$2) RETURNING patient_id AS id",
      [patient, org],
    );
    const privacyFlags = await one(
      `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags)
       VALUES ($1,$2,ARRAY['part2_sud']::text[]) RETURNING patient_id AS id`,
      [patient, org],
    );
    const amendment = await one(
      `INSERT INTO patient_amendment_request (organization_id, patient_id, requested_by_user_id, scope,
         requested_changes, rationale, sla_due_at)
       VALUES ($1,$2,$3,'demographics','{}'::jsonb,'because', now() + interval '30 days') RETURNING id`,
      [org, patient, user],
    );
    const matchReview = await one(
      `INSERT INTO patient_match_review (organization_id, candidate_existing_patient_id, candidate_incoming,
         score, feature_breakdown)
       VALUES ($1,$2,'{}'::jsonb,0.91,'{}'::jsonb) RETURNING id`,
      [org, patient],
    );
    // `patient_merge_no_self`: a merge names TWO charts, so seed a genuine duplicate to merge FROM.
    // This is also what makes the merge row worth isolating — it links two identities at once.
    const dupPatient = await one(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,'Ada','Tenant',$3,'female') RETURNING id`,
      [org, `MRN-${n}-DUP`, day],
    );
    const merge = await one(
      `INSERT INTO patient_merge (organization_id, source_patient_id, target_patient_id, reason, merged_field_diff)
       VALUES ($1,$2,$3,'duplicate','{}'::jsonb) RETURNING id`,
      [org, dupPatient, patient],
    );

    return {
      patient,
      identifier,
      alias,
      address,
      phone,
      email,
      payer,
      caregiver,
      patientCaregiver,
      emergencyContact,
      assignment,
      commPref,
      privacyFlags,
      amendment,
      matchReview,
      merge,
    };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M5 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0021_patient_m5_rls_audit_triggers.sql"),
      "utf8",
    );
    const blocks = rls.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b, `policy uses a subquery: ${b.slice(0, 80)}`).not.toMatch(/SELECT\s+.*\s+FROM/i);
      expect(b, `policy keys on a role: ${b.slice(0, 80)}`).not.toMatch(/pg_has_role/i);
      if (/current_setting/.test(b)) {
        expect(b, `policy keys on a non-canonical setting: ${b.slice(0, 80)}`).toMatch(
          /current_setting\('app\.org_id'/,
        );
      }
    }
  });

  it("org B sees NONE of org A's rows, on all 16 M5 tables", async () => {
    for (const { table, key, idCol } of COVERED) {
      const col = idCol ?? "id";
      const seen = await withOrg(ORG_B, () =>
        db.query(`SELECT ${col} FROM ${table} WHERE ${col} = $1`, [a[key]]),
      );
      expect(seen.rowCount, `${table}: org B could read an org-A row`).toBe(0);

      const own = await withOrg(ORG_A, () =>
        db.query(`SELECT ${col} FROM ${table} WHERE ${col} = $1`, [a[key]]),
      );
      expect(own.rowCount, `${table}: org A cannot read its OWN row`).toBe(1);
    }
  });

  it("the IDENTIFYING satellites are invisible by patient_id, not just by row id", async () => {
    // The realistic attack is not "select by primary key" — it is "I know a patient id, give me
    // everything hanging off it". `patient_identifier` is the MBI/SSN table; the contact tables are
    // how you reach the person. Reaching them via the FK must fail exactly as reaching them by id does.
    const byPatient = await withOrg(ORG_B, async () => ({
      identifiers: (
        await db.query("SELECT 1 FROM patient_identifier WHERE patient_id=$1", [a.patient])
      ).rowCount,
      addresses: (await db.query("SELECT 1 FROM patient_address WHERE patient_id=$1", [a.patient]))
        .rowCount,
      phones: (await db.query("SELECT 1 FROM patient_phone WHERE patient_id=$1", [a.patient]))
        .rowCount,
      emails: (await db.query("SELECT 1 FROM patient_email WHERE patient_id=$1", [a.patient]))
        .rowCount,
      payers: (await db.query("SELECT 1 FROM patient_payer WHERE patient_id=$1", [a.patient]))
        .rowCount,
      contacts: (await db.query("SELECT 1 FROM emergency_contact WHERE patient_id=$1", [a.patient]))
        .rowCount,
      assignments: (
        await db.query("SELECT 1 FROM patient_assignment WHERE patient_id=$1", [a.patient])
      ).rowCount,
    }));
    expect(byPatient).toEqual({
      identifiers: 0,
      addresses: 0,
      phones: 0,
      emails: 0,
      payers: 0,
      contacts: 0,
      assignments: 0,
    });
  });

  it("the 42 CFR Part 2 / privacy-flag snapshot does not cross tenants", async () => {
    // Knowing merely THAT a patient carries `part2_sud` is itself the disclosure Part 2 governs —
    // the flag is the sensitive fact, independent of the clinical record behind it.
    const seen = await withOrg(ORG_B, () =>
      db.query("SELECT flags FROM patient_privacy_flag_snapshot WHERE patient_id = $1", [
        a.patient,
      ]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it("identity-resolution rows never cross tenants — they name two people at once", async () => {
    // `patient_match_review` and `patient_merge` each reference a PAIR of patients. A leak here
    // discloses not one chart but a link between two, and the match candidate carries the incoming
    // demographics verbatim in `candidate_incoming`.
    const review = await withOrg(ORG_B, () =>
      db.query(
        "SELECT candidate_incoming FROM patient_match_review WHERE candidate_existing_patient_id = $1",
        [a.patient],
      ),
    );
    expect(review.rowCount, "org B read another tenant's match candidate").toBe(0);

    // Keyed on target_patient_id: the seed merges a DUPLICATE chart INTO `a.patient`, so the surviving
    // chart is the target. Each negative is paired with a positive control — without it, querying a
    // column that matches nothing would pass for both tenants and prove nothing at all.
    const merge = await withOrg(ORG_B, () =>
      db.query("SELECT merged_field_diff FROM patient_merge WHERE target_patient_id = $1", [
        a.patient,
      ]),
    );
    expect(merge.rowCount, "org B read another tenant's merge diff").toBe(0);

    const ownReview = await withOrg(ORG_A, () =>
      db.query("SELECT 1 FROM patient_match_review WHERE candidate_existing_patient_id = $1", [
        a.patient,
      ]),
    );
    expect(ownReview.rowCount, "control: org A must see its OWN match review").toBe(1);
    const ownMerge = await withOrg(ORG_A, () =>
      db.query("SELECT 1 FROM patient_merge WHERE target_patient_id = $1", [a.patient]),
    );
    expect(ownMerge.rowCount, "control: org A must see its OWN merge row").toBe(1);
  });

  it("a WITH CHECK refuses writing a patient into another tenant's scope", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
           VALUES ($1,'MRN-EVIL','Evil','Insert','1940-01-01','female')`,
          [ORG_A],
        ),
      ),
    ).rejects.toThrow();
  });

  it("a cross-tenant UPDATE matches no rows (the USING clause covers writes too)", async () => {
    const upd = await withOrg(ORG_B, () =>
      db.query("UPDATE patient SET legal_last_name = 'Overwritten' WHERE id = $1", [a.patient]),
    );
    expect(upd.rowCount, "org B updated an org-A patient").toBe(0);

    const stillOwn = await withOrg(ORG_A, () =>
      db.query("SELECT legal_last_name FROM patient WHERE id = $1", [a.patient]),
    );
    expect(stillOwn.rows[0].legal_last_name).toBe("Tenant");
  });

  it("the patient CHART root is not deletable by the app role — only the caregiver links are", async () => {
    // Discovered while writing this suite: DELETE is granted on exactly `caregiver`,
    // `patient_caregiver` and `emergency_contact` — the relationship tables a family can correct —
    // and on NOTHING else in M5. A patient, an identifier, an address or a merge record cannot be
    // removed by the application at all; erasure runs through the M4 destruction-certificate path.
    const r = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name
         FROM information_schema.role_table_grants
        WHERE grantee = 'wardenx_app' AND privilege_type = 'DELETE'
          AND table_name IN (${COVERED.map((c) => `'${c.table}'`).join(",")})
        ORDER BY table_name`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([
      "caregiver",
      "emergency_contact",
      "patient_caregiver",
    ]);
  });
});
