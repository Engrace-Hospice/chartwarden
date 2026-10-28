/**
 * M6 Admission, Election & Certification — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M6's pure suites exercise the five state-machines (referral → admission → election → CTI → discharge) but
 * never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This applies the real migrations to a real Postgres and drives the policies
 * as the unprivileged `chartwarden_app` role (no BYPASSRLS), covering all TWELVE org-scoped M6 tables.
 *
 * Two of the twelve carry the risk that makes this worth more than a checkbox:
 *   • `certification_of_terminal_illness` is the Medicare benefit gate — a cross-tenant write would let one
 *     tenant manufacture another's terminal-illness certifications, the document CMS pays the claim against.
 *   • `election_statement` is the beneficiary's signed election of the hospice benefit; a cross-tenant read is
 *     a disclosure of another org's patient electing to forgo curative care.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m6` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `face_to_face_encounter.performed_by_user_id` and `level_of_care_period.assigned_by` carry real FKs to
 * `user`, so a single seeded user is enough for every user reference in the chain. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admitted_by_physician_id / hospice_md_id are NOT NULL but carry NO FK — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const PHYSICIAN = "55555555-5555-5555-5555-555555555555";

type SeedIds = {
  providerEntity: string;
  location: string;
  referral: string;
  admission: string;
  electionPeriod: string;
  electionStatement: string;
  certificationOfTerminalIllness: string;
  faceToFaceEncounter: string;
  levelOfCarePeriod: string;
  revocationEvent: string;
  transferEvent: string;
  dischargeEvent: string;
  noticeOfRightsAcknowledgment: string;
  complianceWindow: string;
  referralActivity: string;
  referralNote: string;
  admissionEvidence: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "referral", key: "referral" },
  { table: "admission", key: "admission" },
  { table: "election_period", key: "electionPeriod" },
  { table: "election_statement", key: "electionStatement" },
  { table: "certification_of_terminal_illness", key: "certificationOfTerminalIllness" },
  { table: "face_to_face_encounter", key: "faceToFaceEncounter" },
  { table: "level_of_care_period", key: "levelOfCarePeriod" },
  { table: "revocation_event", key: "revocationEvent" },
  { table: "transfer_event", key: "transferEvent" },
  { table: "discharge_event", key: "dischargeEvent" },
  { table: "notice_of_rights_acknowledgment", key: "noticeOfRightsAcknowledgment" },
  { table: "compliance_window", key: "complianceWindow" },
];

// GAP-183 — org-scoped PHI tables added after the twelve above, previously without a cross-tenant proof as
// `chartwarden_app`: the referral audit trail, the free-text referral notes, and the admission evidence index.
const EXTRA_COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "referral_activity", key: "referralActivity" },
  { table: "referral_note", key: "referralNote" },
  { table: "admission_evidence", key: "admissionEvidence" },
];

describe.skipIf(!DB_URL)("M6 Admission — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE chartwarden_app");
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
    await dropLiveRoles(db);
  }

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M6 admission chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M6${n}`, `M6 Provider ${n}`, `NPI-M6${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M6${n}`],
      )
    ).rows[0].id as string;

    const referral = (
      await db.query(
        `INSERT INTO referral (organization_id, provider_entity_id, location_id, patient_id,
           patient_name_at_receipt, source_channel)
         VALUES ($1,$2,$3,$4,'Doe, Jane','hospital_discharge_planner') RETURNING id`,
        [org, providerEntity, location, PATIENT],
      )
    ).rows[0].id as string;

    const admission = (
      await db.query(
        `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id, referral_id,
           admitted_by_physician_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id`,
        [org, providerEntity, location, PATIENT, referral, PHYSICIAN],
      )
    ).rows[0].id as string;

    const electionPeriod = (
      await db.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status)
         VALUES ($1,$2,1,'ninety_day','active') RETURNING id`,
        [org, admission],
      )
    ).rows[0].id as string;

    const electionStatement = (
      await db.query(
        `INSERT INTO election_statement (organization_id, election_period_id, patient_id, signer_kind,
           patient_name_at_signing, hospice_name_at_signing, curative_care_acknowledgment, signed_at,
           signature_method)
         VALUES ($1,$2,$3,'patient','Jane Doe','M6 Hospice',true, now()::date, 'electronic_witnessed')
         RETURNING id`,
        [org, electionPeriod, PATIENT],
      )
    ).rows[0].id as string;

    const certificationOfTerminalIllness = (
      await db.query(
        `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id,
           terminal_diagnosis_icd10, narrative, period_start, period_end)
         VALUES ($1,$2,$3,'C34.90','Terminal', now()::date, now()::date + 90) RETURNING id`,
        [org, electionPeriod, PHYSICIAN],
      )
    ).rows[0].id as string;

    const faceToFaceEncounter = (
      await db.query(
        `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
           performer_role)
         VALUES ($1,$2,$3,'hospice_md') RETURNING id`,
        [org, electionPeriod, USER],
      )
    ).rows[0].id as string;

    const levelOfCarePeriod = (
      await db.query(
        `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, effective_at,
           assigned_by, reason, q_code)
         VALUES ($1,$2,'routine_home_care', now(), $3,'admit','Q5001') RETURNING id`,
        [org, admission, USER],
      )
    ).rows[0].id as string;

    const revocationEvent = (
      await db.query(
        `INSERT INTO revocation_event (organization_id, admission_id, election_period_id, signer_kind,
           effective_at, signed_at, revocation_reason)
         VALUES ($1,$2,$3,'patient', now()::date, now()::date, 'dissatisfaction') RETURNING id`,
        [org, admission, electionPeriod],
      )
    ).rows[0].id as string;

    const transferEvent = (
      await db.query(
        `INSERT INTO transfer_event (organization_id, admission_id, direction, receiving_or_sending_ccn,
           receiving_or_sending_name, effective_at, period_sequence_at_transfer)
         VALUES ($1,$2,'out','CCN-OTHER','Other Hospice', now()::date, 1) RETURNING id`,
        [org, admission],
      )
    ).rows[0].id as string;

    const dischargeEvent = (
      await db.query(
        `INSERT INTO discharge_event (organization_id, admission_id, discharge_type, effective_at)
         VALUES ($1,$2,'death', now()::date) RETURNING id`,
        [org, admission],
      )
    ).rows[0].id as string;

    const noticeOfRightsAcknowledgment = (
      await db.query(
        `INSERT INTO notice_of_rights_acknowledgment (organization_id, admission_id, patient_id, signer_kind,
           acknowledged_at, acknowledgment_method)
         VALUES ($1,$2,$3,'patient', now()::date, 'electronic_witnessed') RETURNING id`,
        [org, admission, PATIENT],
      )
    ).rows[0].id as string;

    const complianceWindow = (
      await db.query(
        `INSERT INTO compliance_window (organization_id, admission_id, window_kind, starts_at,
           must_complete_by)
         VALUES ($1,$2,'care_plan_5d', now(), now() + interval '5 days') RETURNING id`,
        [org, admission],
      )
    ).rows[0].id as string;

    const referralActivity = (
      await db.query(
        `INSERT INTO referral_activity (organization_id, referral_id, action) VALUES ($1,$2,'received')
         RETURNING id`,
        [org, referral],
      )
    ).rows[0].id as string;

    const referralNote = (
      await db.query(
        `INSERT INTO referral_note (organization_id, referral_id, content) VALUES ($1,$2,'intake note')
         RETURNING id`,
        [org, referral],
      )
    ).rows[0].id as string;

    const admissionEvidence = (
      await db.query(
        `INSERT INTO admission_evidence (organization_id, admission_id, patient_id, requirement_type,
           source_type, structured_entity_type, structured_entity_id)
         VALUES ($1,$2,$3,'notice_of_rights','structured','notice_of_rights',$4) RETURNING id`,
        [org, admission, PATIENT, noticeOfRightsAcknowledgment],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      referral,
      admission,
      electionPeriod,
      electionStatement,
      certificationOfTerminalIllness,
      faceToFaceEncounter,
      levelOfCarePeriod,
      revocationEvent,
      transferEvent,
      dischargeEvent,
      noticeOfRightsAcknowledgment,
      complianceWindow,
      referralActivity,
      referralNote,
      admissionEvidence,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable.
  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M6 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0027_admission_m6_rls_audit_triggers.sql"),
      "utf8",
    );
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  // GAP-183 — tables whose RLS policy lives in a LATER migration than the file the policy-shape case above
  // reads, so they are proven here by behaviour (and the catalog check below) rather than by policy text.
  it.each([...COVERED, ...EXTRA_COVERED])(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses a CTI forged into another tenant's election period", async () => {
    // certification_of_terminal_illness is the Medicare benefit gate — a cross-tenant write would let one
    // tenant manufacture another's terminal-illness certifications, the document CMS pays the claim against.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id,
             terminal_diagnosis_icd10, narrative, period_start, period_end)
           VALUES ($1,$2,$3,'C34.90','forged', now()::date, now()::date + 90)`,
          [ORG_A, a.electionPeriod, PHYSICIAN],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's admission (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE admission SET status='discharged' WHERE id=$1", [a.admission]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM admission WHERE id=$1", [a.admission]);
    expect(still.rows[0].status).toBe("active");
  });

  it("the M4 write-audit trigger fired for the admission writes (§3.8)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'admission'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
