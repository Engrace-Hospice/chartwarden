/**
 * M8 Encounters & Visit Notes — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M8's pure suites exercise the draft→signed→cosigned state machine and the HearthNote Layer-1 assembly but
 * never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This applies the real migrations to a real Postgres and drives the policies
 * as the unprivileged `chartwarden_app` role (no BYPASSRLS), covering all TEN clinical M8 tables. The last
 * describe block adds the two org-level closure-clock tables (`documentation_obligation_policy` / `_override`,
 * migration 1510, ADR-0113) plus the `encounter` clock columns.
 *
 * Two of the ten carry the risk that makes this worth more than a checkbox:
 *   • `encounter` is the signed clinical visit note — the CoP-418.104 legal record CMS and surveyors read.
 *     A cross-tenant write would let one tenant fabricate another's clinical documentation.
 *   • `encounter_signature` is the clinician attestation with step-up-auth evidence; a cross-tenant write
 *     would let one tenant manufacture another's signatures on that record.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m8` (SUPERUSER to a THROWAWAY db;
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
/** Every M8 `*_membership_id` column (authored_by / signed_by / routed_to / called_by) carries a real FK to
 * `membership`, so each org needs one seeded membership; a single seeded `user` backs both. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id are NOT NULL but carry NO FK — literals are fine (as M6/M7 do). */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
/** encounter_signature.session_id is NOT NULL but FK-less; the care-plan link ids and the assembled-output
 * vocab_version_id are likewise NOT NULL-or-nullable with no FK — constant UUIDs satisfy them. */
const SESSION = "66666666-6666-6666-6666-666666666666";
const PROBLEM = "77777777-7777-7777-7777-777777777777";
const VOCAB = "88888888-8888-8888-8888-888888888888";
const VISIT = "99999999-9999-4999-8999-999999999999";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  encounter: string;
  encounterAddendum: string;
  encounterSignature: string;
  encounterCarePlanLink: string;
  cosignatureRequest: string;
  vitals: string;
  mileage: string;
  hearthnoteSelection: string;
  hearthnoteAssembledOutput: string;
  hearthnoteLlmModification: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "encounter", key: "encounter" },
  { table: "encounter_addendum", key: "encounterAddendum" },
  { table: "encounter_signature", key: "encounterSignature" },
  { table: "encounter_care_plan_link", key: "encounterCarePlanLink" },
  { table: "cosignature_request", key: "cosignatureRequest" },
  { table: "vitals", key: "vitals" },
  { table: "mileage", key: "mileage" },
  { table: "hearthnote_selection", key: "hearthnoteSelection" },
  { table: "hearthnote_assembled_output", key: "hearthnoteAssembledOutput" },
  { table: "hearthnote_llm_modification", key: "hearthnoteLlmModification" },
];

describe.skipIf(!DB_URL)("M8 Encounters — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
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

  /** Seed one full M8 encounter chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;

    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M8${n}`, `M8 Provider ${n}`, `NPI-M8${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M8${n}`],
      )
    ).rows[0].id as string;

    const encounter = (
      await db.query(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           visit_id, encounter_type, discipline, authored_by_membership_id, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','rn',$7, now()::date, 'draft') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, VISIT, membership],
      )
    ).rows[0].id as string;

    const encounterAddendum = (
      await db.query(
        `INSERT INTO encounter_addendum (organization_id, provider_entity_id, location_id, encounter_id,
           authored_by_membership_id, reason, status)
         VALUES ($1,$2,$3,$4,$5,'Late clarification of vitals','draft') RETURNING id`,
        [org, providerEntity, location, encounter, membership],
      )
    ).rows[0].id as string;

    const encounterSignature = (
      await db.query(
        `INSERT INTO encounter_signature (organization_id, provider_entity_id, location_id, encounter_id,
           kind, signed_by_membership_id, signed_by_discipline, method, session_id, step_up_auth_at,
           attestation_text, layer2_involved_at_signing)
         VALUES ($1,$2,$3,$4,'primary',$5,'rn','passkey',$6, now(),
           'I attest this encounter record is accurate and complete.', false) RETURNING id`,
        [org, providerEntity, location, encounter, membership, SESSION],
      )
    ).rows[0].id as string;

    const encounterCarePlanLink = (
      await db.query(
        `INSERT INTO encounter_care_plan_link (organization_id, provider_entity_id, location_id, encounter_id,
           problem_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [org, providerEntity, location, encounter, PROBLEM],
      )
    ).rows[0].id as string;

    const cosignatureRequest = (
      await db.query(
        `INSERT INTO cosignature_request (organization_id, provider_entity_id, location_id, encounter_id,
           routed_to_membership_id, status)
         VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
        [org, providerEntity, location, encounter, membership],
      )
    ).rows[0].id as string;

    const vitals = (
      await db.query(
        `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at,
           heart_rate, spo2)
         VALUES ($1,$2,$3,$4, now(), 72, 97) RETURNING id`,
        [org, providerEntity, location, encounter],
      )
    ).rows[0].id as string;

    const mileage = (
      await db.query(
        `INSERT INTO mileage (organization_id, provider_entity_id, location_id, encounter_id, miles_driven,
           miles_driven_source)
         VALUES ($1,$2,$3,$4,'12.4','odometer') RETURNING id`,
        [org, providerEntity, location, encounter],
      )
    ).rows[0].id as string;

    const hearthnoteSelection = (
      await db.query(
        `INSERT INTO hearthnote_selection (organization_id, provider_entity_id, location_id, encounter_id,
           template_key, template_version)
         VALUES ($1,$2,$3,$4,'rn_routine','v1') RETURNING id`,
        [org, providerEntity, location, encounter],
      )
    ).rows[0].id as string;

    const hearthnoteAssembledOutput = (
      await db.query(
        `INSERT INTO hearthnote_assembled_output (organization_id, provider_entity_id, location_id,
           encounter_id, kind, layer1_cipher, final_cipher, layer2_eligibility, assembly_template_key,
           vocab_version_id)
         VALUES ($1,$2,$3,$4,'primary_finalize','c1','cf','eligible','assemble_rn',$5) RETURNING id`,
        [org, providerEntity, location, encounter, VOCAB],
      )
    ).rows[0].id as string;

    const hearthnoteLlmModification = (
      await db.query(
        `INSERT INTO hearthnote_llm_modification (organization_id, provider_entity_id, location_id,
           assembled_output_id, prompt_template_key, prompt_template_version, model_id, tokens_input,
           tokens_output, latency_ms, diff_json, called_by_membership_id)
         VALUES ($1,$2,$3,$4,'polish','v1','model-x',100,120,42,'[]'::jsonb,$5) RETURNING id`,
        [org, providerEntity, location, hearthnoteAssembledOutput, membership],
      )
    ).rows[0].id as string;

    return {
      membership,
      providerEntity,
      location,
      encounter,
      encounterAddendum,
      encounterSignature,
      encounterCarePlanLink,
      cosignatureRequest,
      vitals,
      mileage,
      hearthnoteSelection,
      hearthnoteAssembledOutput,
      hearthnoteLlmModification,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m8-actor@x.test')`, [USER]);
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

  it("every M8 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    // Ten org-scoped tables → ten `*_org` policy blocks. The audit_writer_insert policy on audit_event is
    // matched by the regex too but filtered out here (its table is not in COVERED), exactly as M6/M7 do.
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0031_encounters_m8_rls_audit_triggers.sql"),
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

  it.each(COVERED)(
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

  it("a WITH CHECK refuses an encounter forged into another tenant (the signed clinical record)", async () => {
    // encounter is the CoP-418.104 legal visit note — a cross-tenant write would let one tenant fabricate
    // another's clinical documentation, the record CMS and surveyors read.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id,
             encounter_type, discipline, authored_by_membership_id, service_date, status)
           VALUES ($1,$2,$3,$4,$5,'routine_visit','rn',$6, now()::date, 'draft')`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, b.membership],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's encounter (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE encounter SET late_entry_tier='normal' WHERE id=$1", [a.encounter]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM encounter WHERE id=$1", [a.encounter]);
    expect(still.rows[0].status).toBe("draft");
  });

  it("allows the same visit id across tenants but rejects a duplicate seed within one tenant", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, visit_id, encounter_type, discipline, authored_by_membership_id,
             service_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','rn',$7,now()::date,'draft')`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, VISIT, a.membership],
        ),
      ),
    ).rejects.toThrow(/encounter_org_visit_unique/);
  });

  it("allows a future-dated scheduled draft while route-level ad hoc authoring retains its guard", async () => {
    const futureVisit = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const inserted = await withOrg(ORG_A, () =>
      db.query(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, visit_id, encounter_type, discipline, authored_by_membership_id,
           service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','rn',$7,current_date + 1,'draft')
         RETURNING id`,
        [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, futureVisit, a.membership],
      ),
    );
    expect(inserted.rows).toHaveLength(1);
  });

  it("the M4 write-audit trigger fired for the encounter writes (§3.8)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'encounter'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  // ── migration 1510 / ADR-0113: the closure clock, tenant policy and supervisor override ──────────────────────────────
  describe("documentation clock (migration 1510)", () => {
    const REASON = "Clinician is mid-emergency and cannot chart; lifting the block for the shift.";
    let subjectA: string;
    let granterA: string;
    let subjectB: string;
    let granterB: string;
    let overrideA: string;

    /** An extra active membership for `org` backed by a fresh user (one active membership per user and org). */
    async function extraMembership(org: string, email: string): Promise<string> {
      const user = (await db.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email]))
        .rows[0].id as string;
      return (
        await db.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
    }

    const insertOverride = (
      org: string,
      subject: string,
      granter: string,
      reason: string,
      hours: number,
    ) =>
      db.query(
        `INSERT INTO documentation_obligation_override
           (organization_id, subject_membership_id, granted_by_membership_id, obligation_kind, reason, expires_at)
         VALUES ($1,$2,$3,'visit_note',$4, now() + make_interval(hours => $5)) RETURNING id`,
        [org, subject, granter, reason, hours],
      );

    beforeAll(async () => {
      subjectA = await extraMembership(ORG_A, "closure-subject-a@x.test");
      granterA = await extraMembership(ORG_A, "closure-granter-a@x.test");
      subjectB = await extraMembership(ORG_B, "closure-subject-b@x.test");
      granterB = await extraMembership(ORG_B, "closure-granter-b@x.test");
      overrideA = (await insertOverride(ORG_A, subjectA, granterA, REASON, 4)).rows[0].id as string;
      await insertOverride(ORG_B, subjectB, granterB, REASON, 4);
      for (const org of [ORG_A, ORG_B]) {
        await db.query(
          `INSERT INTO documentation_obligation_policy (organization_id, obligation_kind, configured_by_user_id)
           VALUES ($1,'visit_note',$2)`,
          [org, USER],
        );
      }
    });

    it("both tables have RLS enabled AND FORCEd", async () => {
      const { rows } = await db.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('documentation_obligation_policy','documentation_obligation_override')`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual([
          row.relname,
          true,
          true,
        ]);
    });

    it.each(["documentation_obligation_policy", "documentation_obligation_override"])(
      "%s: org A sees its row, org B sees only its own",
      async (table) => {
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT organization_id FROM ${table}`),
        );
        expect(seenByA.rows.map((r) => r.organization_id)).toEqual([ORG_A]);
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT organization_id FROM ${table}`),
        );
        expect(seenByB.rows.map((r) => r.organization_id)).toEqual([ORG_B]);
      },
    );

    it("a WITH CHECK refuses an override or a policy forged into another tenant", async () => {
      await expect(
        withOrg(ORG_B, () => insertOverride(ORG_A, subjectA, granterA, REASON, 4)),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO documentation_obligation_policy (organization_id, obligation_kind, configured_by_user_id)
             VALUES ($1,'cti',$2)`,
            [ORG_A, USER],
          ),
        ),
      ).rejects.toThrow();
    });

    it("the application role has no DELETE on either table, and the policy defaults to warn / 24", async () => {
      for (const table of [
        "documentation_obligation_policy",
        "documentation_obligation_override",
      ]) {
        await expect(withOrg(ORG_A, () => db.query(`DELETE FROM ${table}`))).rejects.toThrow(
          /permission denied/,
        );
      }
      const row = (
        await withOrg(ORG_A, () =>
          db.query(
            `SELECT mode, threshold_hours, enforce_from FROM documentation_obligation_policy`,
          ),
        )
      ).rows[0];
      expect(row).toEqual({ mode: "warn", threshold_hours: 24, enforce_from: null });
    });

    it("the override is append-only: only the two revocation columns can be updated, and only as a pair", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(`UPDATE documentation_obligation_override SET reason = $1 WHERE id = $2`, [
            REASON,
            overrideA,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `UPDATE documentation_obligation_override SET revoked_at = now() WHERE id = $1`,
            [overrideA],
          ),
        ),
      ).rejects.toThrow(/revocation_pair/);
      const revoked = await withOrg(ORG_A, () =>
        db.query(
          `UPDATE documentation_obligation_override SET revoked_at = now(), revoked_by_membership_id = $2 WHERE id = $1`,
          [overrideA, granterA],
        ),
      );
      expect(revoked.rowCount).toBe(1);
    });

    it.each([
      ["a reason shorter than 40 characters", "too short", 4, /reason_len/],
      ["a window longer than 24 hours", REASON, 25, /expiry_window/],
      ["an override that has already expired", REASON, -1, /expiry_window/],
    ])("the override CHECKs refuse %s", async (_label, reason, hours, expected) => {
      await expect(
        withOrg(ORG_A, () => insertOverride(ORG_A, subjectA, granterA, reason, hours)),
      ).rejects.toThrow(expected);
    });

    it("a supervisor cannot override themselves", async () => {
      await expect(
        withOrg(ORG_A, () => insertOverride(ORG_A, granterA, granterA, REASON, 4)),
      ).rejects.toThrow(/not_self/);
    });

    it("the policy CHECK bounds the threshold to 1..168 hours", async () => {
      for (const hours of [0, 169]) {
        await expect(
          withOrg(ORG_A, () =>
            db.query(`UPDATE documentation_obligation_policy SET threshold_hours = $1`, [hours]),
          ),
        ).rejects.toThrow(/threshold/);
      }
    });

    it("the audit trigger records an override without the free-text reason", async () => {
      const { rows } = await db.query(
        `SELECT after FROM audit_event WHERE resource_kind = 'documentation_obligation_override' AND event_type LIKE '%insert' AND resource_id = $1`,
        [overrideA],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].after.reason).toBe("<changed>");
      expect(JSON.stringify(rows[0].after)).not.toContain("mid-emergency");
    });

    it("encounter.clock_started_at and clock_start_source are set together or not at all", async () => {
      await expect(
        db.query(`UPDATE encounter SET clock_started_at = now() WHERE id = $1`, [a.encounter]),
      ).rejects.toThrow(/clock_start_consistency/);
      await expect(
        db.query(`UPDATE encounter SET clock_start_source = 'draft_created' WHERE id = $1`, [
          a.encounter,
        ]),
      ).rejects.toThrow(/clock_start_consistency/);
      const both = await withOrg(ORG_A, () =>
        db.query(
          `UPDATE encounter SET clock_started_at = now(), clock_start_source = 'evv_check_in' WHERE id = $1`,
          [a.encounter],
        ),
      );
      expect(both.rowCount).toBe(1);
    });

    it("the destruction role can read and delete only the organization it is scoped to", async () => {
      await db.query("SET ROLE chartwarden_destruction");
      await db.query("SELECT set_config('app.org_id', $1, false)", [ORG_B]);
      try {
        const removed = await db.query(`DELETE FROM documentation_obligation_override`);
        expect(removed.rowCount).toBe(1);
        const policies = await db.query(`DELETE FROM documentation_obligation_policy`);
        expect(policies.rowCount).toBe(1);
      } finally {
        await db.query("RESET ROLE");
      }
      const left = await db.query(`SELECT organization_id FROM documentation_obligation_override`);
      expect(left.rows.map((r) => r.organization_id)).toEqual([ORG_A]);
    });
  });
});
