/**
 * M24 Billing — Medicaid — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §8.1 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../24-billing-medicaid, packages/medicaid-adapters) exercise the domain
 * but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This test applies the actual migrations to a real Postgres and exercises the
 * policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), proving cross-tenant denial for real on
 * all org-scoped M24 tables under the canonical `organization_id = current_setting('app.org_id')` ONE-SHAPE
 * policy (ADR-0010 D3 — no second PERMISSIVE provider_entity policy; PE narrowing is the M3 ABAC at the
 * handler) — including the six LIST-partitioned tables (the parent policy propagates to every partition incl.
 * DEFAULT, PG11+).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
/** Membership sentinels: the recorder of every row, and a second person who may verify it (four-eyes). */
const RECORDER = "00000000-0000-0000-0000-000000000000";
const REVIEWER = "00000000-0000-0000-0000-0000000000aa";

type SeedIds = {
  pe: string;
  claim: string;
  claimLine: string;
  lineEncounter: string;
  stateHistory: string;
  submission: string;
  acknowledgment: string;
  validationRun: string;
  validationResult: string;
  validationOverride: string;
  ruleConfig: string;
  eligibility: string;
  rbArrangement: string;
  rbDay: string;
  credential: string;
  programAssignment: string;
  enrollmentEvidence: string;
  payerAuthorizationEvent: string;
  payerRatePolicy: string;
};

const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "medicaid_claim", key: "claim" },
  { table: "medicaid_claim_line", key: "claimLine" },
  { table: "medicaid_claim_line_encounter", key: "lineEncounter", idCol: "medicaid_claim_line_id" },
  { table: "medicaid_claim_state_history", key: "stateHistory" },
  { table: "medicaid_submission", key: "submission" },
  { table: "medicaid_acknowledgment", key: "acknowledgment" },
  { table: "medicaid_validation_run", key: "validationRun" },
  { table: "medicaid_validation_result", key: "validationResult" },
  { table: "medicaid_validation_override", key: "validationOverride" },
  { table: "medicaid_validation_rule_config", key: "ruleConfig" },
  { table: "medicaid_eligibility_check", key: "eligibility" },
  { table: "rb_arrangement", key: "rbArrangement" },
  { table: "rb_day", key: "rbDay" },
  { table: "state_medicaid_trading_partner_credential", key: "credential" },
  { table: "medicaid_program_assignment", key: "programAssignment" },
  { table: "medicaid_enrollment_evidence", key: "enrollmentEvidence" },
  { table: "medicaid_payer_authorization_event", key: "payerAuthorizationEvent" },
  { table: "medicaid_payer_rate_policy", key: "payerRatePolicy" },
];

/**
 * The four tables 1535/1538/1539 add, each with ONE valid INSERT ($1 org, $2 provider entity, $3 patient,
 * $4 recorder) and the name of its BEFORE INSERT provider-entity guard. The statement satisfies every CHECK,
 * so the only things that can refuse it are the grant, RLS and that guard trigger.
 */
const NEW_TABLES = [
  {
    table: "medicaid_program_assignment",
    guard: "trg_medicaid_program_assignment_provider_entity",
    insert: `INSERT INTO medicaid_program_assignment
      (organization_id, provider_entity_id, recorded_by_membership_id, patient_id, patient_payer_id, admission_id,
       service_state, program_kind, canonical_payer_id, status, effective_from, source_kind)
      VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'OR','managed_care',gen_random_uuid(),
              'pending','2026-01-01','manual_candidate')`,
  },
  {
    table: "medicaid_enrollment_evidence",
    guard: "trg_medicaid_enrollment_evidence_provider_entity",
    insert: `INSERT INTO medicaid_enrollment_evidence
      (organization_id, provider_entity_id, recorded_by_membership_id, service_state, transaction_type,
       evidence_kind, status, effective_from)
      VALUES ($1,$2,$3,'OR','837I','837i_enrollment','pending','2026-01-01')`,
  },
  {
    table: "medicaid_payer_authorization_event",
    guard: "trg_medicaid_payer_authorization_evidence_status",
    insert: `INSERT INTO medicaid_payer_authorization_event
      (organization_id, provider_entity_id, recorded_by_membership_id, patient_id, patient_payer_id, admission_id,
       canonical_payer_id, service_state, service_from, service_to, event_kind, evidence_status, evidence_source)
      VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'OR','2026-01-01','2026-01-31',
              'authorization_pending','unverified','operator_record')`,
  },
  {
    table: "medicaid_payer_rate_policy",
    guard: "trg_medicaid_payer_rate_policy_status",
    insert: `INSERT INTO medicaid_payer_rate_policy
      (organization_id, provider_entity_id, recorded_by_membership_id, canonical_payer_id, program_kind,
       service_state, locality_code, service_category, unit_basis, rate_cents, source_kind, effective_from)
      VALUES ($1,$2,$3,gen_random_uuid(),'managed_care','OR','CBSA-TEST','RHC','per_day',10000,'cco_contract',
              '2026-01-01')`,
  },
] as const;

/** Bind exactly the parameters a statement mentions (pg refuses a bound parameter it never sees). */
const bindsFor = (insert: string, org: string, pe: string): string[] =>
  [org, pe, RECORDER, PATIENT].slice(
    0,
    Math.max(...[...insert.matchAll(/\$(\d)/g)].map((m) => Number(m[1]))),
  );

describe.skipIf(!DB_URL)(
  "M24 Billing — Medicaid — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
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

    /** Run `fn` with one trigger switched off (superuser connection), then switch it back on. */
    async function withTriggerOff<T>(
      table: string,
      trigger: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      try {
        return await fn();
      } finally {
        await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    }

    /** INSERT one row from a column->value map on the superuser connection (grants, RLS and CHECK-only guards). */
    async function insertRow(table: string, row: Record<string, unknown>): Promise<string> {
      const cols = Object.keys(row);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
        Object.values(row),
      );
      return rows[0].id;
    }

    const assignmentRow = (over: Record<string, unknown> = {}) => ({
      organization_id: ORG_A,
      provider_entity_id: a.pe,
      patient_id: PATIENT,
      patient_payer_id: randomUUID(),
      admission_id: randomUUID(),
      service_state: "OR",
      program_kind: "managed_care",
      canonical_payer_id: randomUUID(),
      status: "pending",
      effective_from: "2026-01-01",
      source_kind: "manual_candidate",
      recorded_by_membership_id: RECORDER,
      ...over,
    });
    const assignmentVerification = {
      verified_at: "2026-02-01T00:00:00Z",
      verified_by_membership_id: REVIEWER,
      evidence_reference: "doc:synthetic-assignment-evidence",
    };
    const evidenceRow = (over: Record<string, unknown> = {}) => ({
      organization_id: ORG_A,
      provider_entity_id: a.pe,
      service_state: "OR",
      transaction_type: "837I",
      evidence_kind: "837i_enrollment",
      status: "pending",
      effective_from: "2026-01-01",
      recorded_by_membership_id: RECORDER,
      ...over,
    });
    const evidenceVerification = {
      verified_at: "2026-02-01T00:00:00Z",
      verified_by_membership_id: REVIEWER,
      verification_source: "state_registry",
      evidence_reference: "doc:synthetic-enrollment-evidence",
    };

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
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        }
        try {
          await db.query(sql);
        } catch (cause) {
          throw new Error(
            `migration ${f} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }

    /** Seed one full M24 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const st = "OR";
      const from = "2026-01-01";
      const to = "2026-01-31";
      const patient = "44444444-4444-4444-4444-444444444444";
      const m = "00000000-0000-0000-0000-000000000000"; // membership sentinel
      const pe = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      const programAssignment = (
        await db.query(
          `INSERT INTO medicaid_program_assignment
           (organization_id, patient_id, patient_payer_id, admission_id, provider_entity_id, service_state,
            program_kind, canonical_payer_id, status, effective_from, source_kind, recorded_by_membership_id)
           VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),$3,'OR','managed_care',gen_random_uuid(),
            'pending',$4,'manual_candidate',$5) RETURNING id`,
          [org, patient, pe, from, m],
        )
      ).rows[0].id as string;
      const enrollmentEvidence = (
        await db.query(
          `INSERT INTO medicaid_enrollment_evidence
           (organization_id, provider_entity_id, service_state, transaction_type, evidence_kind, status, effective_from, recorded_by_membership_id)
           VALUES ($1,$2,'OR','837I','837i_enrollment','pending',$3,$4) RETURNING id`,
          [org, pe, from, m],
        )
      ).rows[0].id as string;
      const payerAuthorizationEvent = (
        await db.query(
          `INSERT INTO medicaid_payer_authorization_event
             (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
              canonical_payer_id, service_state, service_from, service_to, event_kind,
              evidence_status, evidence_source, evidence_reference, recorded_by_membership_id)
           VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$4,$5,$6,
                   'authorization_pending','unverified','operator_record','payer-response:synthetic-test',$7)
           RETURNING id`,
          [org, pe, patient, st, from, to, m],
        )
      ).rows[0].id as string;
      const payerRatePolicy = (
        await db.query(
          `INSERT INTO medicaid_payer_rate_policy
             (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
              locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
              source_kind, effective_from, recorded_by_membership_id)
           VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','CBSA-TEST','RHC','per_day',1,60,
                   10000,'cco_contract',$3,$4) RETURNING id`,
          [org, pe, from, m],
        )
      ).rows[0].id as string;
      const claim = (
        await db.query(
          `INSERT INTO medicaid_claim (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
           service_state, kind, tob, service_from, service_to, state_plan_code_id, state_plan_code_snapshot,
           medicaid_claim_control_number, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,'hospice_only','0813',$5,$6,gen_random_uuid(),
           'OHP', $7, $8, $8) RETURNING id`,
          [org, pe, patient, st, from, to, `000000-OR-260101-0000${n}-00`, m],
        )
      ).rows[0].id as string;
      const claimLine = (
        await db.query(
          `INSERT INTO medicaid_claim_line (organization_id, provider_entity_id, medicaid_claim_id, line_number,
           service_date, revenue_code, q_code, level_of_care, loc_period_id, units, rate_at_assembly_cents,
           state_rate_schedule_id_snapshot, charges_cents)
         VALUES ($1,$2,$3,1,$4,'0651','Q5001','RHC',gen_random_uuid(),1,10000,gen_random_uuid(),10000) RETURNING id`,
          [org, pe, claim, from],
        )
      ).rows[0].id as string;
      const lineEncounter = (
        await db.query(
          `INSERT INTO medicaid_claim_line_encounter (medicaid_claim_line_id, encounter_id, organization_id)
         VALUES ($1,gen_random_uuid(),$2) RETURNING medicaid_claim_line_id AS id`,
          [claimLine, org],
        )
      ).rows[0].id as string;
      const stateHistory = (
        await db.query(
          `INSERT INTO medicaid_claim_state_history (organization_id, medicaid_claim_id, to_state, trigger_source)
         VALUES ($1,$2,'DRAFT','user') RETURNING id`,
          [org, claim],
        )
      ).rows[0].id as string;
      const submission = (
        await db.query(
          `INSERT INTO medicaid_submission (organization_id, medicaid_claim_id, provider_entity_id, service_state,
           channel, medicaid_claim_control_number, adapter_vendor, adapter_version)
         VALUES ($1,$2,$3,$4,'direct_mmis',$5,'deferred','0') RETURNING id`,
          [org, claim, pe, st, `000000-OR-260101-0000${n}-00`],
        )
      ).rows[0].id as string;
      const acknowledgment = (
        await db.query(
          `INSERT INTO medicaid_acknowledgment (organization_id, medicaid_claim_id, medicaid_submission_id, kind, outcome)
         VALUES ($1,$2,$3,'sync_277ca','accepted') RETURNING id`,
          [org, claim, submission],
        )
      ).rows[0].id as string;
      const validationRun = (
        await db.query(
          `INSERT INTO medicaid_validation_run (organization_id, medicaid_claim_id, rule_registry_version, triggered_by,
           claim_state_at_trigger, idempotency_key)
         VALUES ($1,$2,'1','manual','DRAFT',$3) RETURNING id`,
          [org, claim, `idem-${n}`],
        )
      ).rows[0].id as string;
      const validationResult = (
        await db.query(
          `INSERT INTO medicaid_validation_result (organization_id, medicaid_validation_run_id, rule_key, rule_version, outcome)
         VALUES ($1,$2,'medicaid.eligibility.active',1,'pass') RETURNING id`,
          [org, validationRun],
        )
      ).rows[0].id as string;
      const validationOverride = (
        await db.query(
          `INSERT INTO medicaid_validation_override (organization_id, medicaid_validation_result_id, medicaid_claim_id,
           rule_key, override_role_applied, reason, step_up_auth_token_at, actor_membership_id)
         VALUES ($1,$2,$3,'medicaid.eligibility.active','billing_manager',
           'a deliberate override reason that exceeds forty chars', now(), gen_random_uuid()) RETURNING id`,
          [org, validationResult, claim],
        )
      ).rows[0].id as string;
      const ruleConfig = (
        await db.query(
          `INSERT INTO medicaid_validation_rule_config (organization_id, rule_key, regulatory_required_snapshot, updated_by_membership_id)
         VALUES ($1,$2,false,$3) RETURNING id`,
          [org, `custom.rule.${n}`, m],
        )
      ).rows[0].id as string;
      const eligibility = (
        await db.query(
          `INSERT INTO medicaid_eligibility_check (organization_id, patient_id, patient_payer_id, service_state,
           as_of_service_date, outcome, stale_at)
         VALUES ($1,$2,gen_random_uuid(),$3,$4,'active', now() + interval '30 days') RETURNING id`,
          [org, patient, st, from],
        )
      ).rows[0].id as string;
      const rbArrangement = (
        await db.query(
          `INSERT INTO rb_arrangement (organization_id, patient_id, provider_entity_id, nf_facility_mdm_id,
           nf_facility_name_snapshot, effective_from, nf_per_diem_routine_cents, nf_per_diem_resp_cents,
           nf_per_diem_gip_cents, pass_through_pct, retention_pct, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid(),'NF',$4,20000,25000,80000,95,5,$5,$5) RETURNING id`,
          [org, patient, pe, from, m],
        )
      ).rows[0].id as string;
      const rbDay = (
        await db.query(
          `INSERT INTO rb_day (organization_id, provider_entity_id, patient_id, rb_arrangement_id, service_date,
           loc_of_day, loc_period_id_snapshot, per_diem_cents_snapshot)
         VALUES ($1,$2,$3,$4,$5,'NF_RB',gen_random_uuid(),20000) RETURNING id`,
          [org, pe, patient, rbArrangement, from],
        )
      ).rows[0].id as string;
      const credential = (
        await db.query(
          `INSERT INTO state_medicaid_trading_partner_credential (organization_id, provider_entity_id, service_state,
           channel, trading_partner_id, active_from, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,'direct_mmis','TP1',$4,$5,$5) RETURNING id`,
          [org, pe, st, from, m],
        )
      ).rows[0].id as string;
      return {
        pe,
        claim,
        claimLine,
        lineEncounter,
        stateHistory,
        submission,
        acknowledgment,
        validationRun,
        validationResult,
        validationOverride,
        ruleConfig,
        eligibility,
        rbArrangement,
        rbDay,
        credential,
        programAssignment,
        enrollmentEvidence,
        payerAuthorizationEvent,
        payerRatePolicy,
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
      b = await seedOrg(ORG_B, 2);
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M24 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0096_billing_medicaid_m24_rls.sql"), "utf8");
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBe(14);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
      // The later migrations that add tenant tables: 1535 (two), 1538 and 1539 (one each).
      const laterMigrations = [
        ["1535_m24_payer_program_readiness.sql", 2],
        ["1538_m24_payer_authorization_evidence.sql", 1],
        ["1539_m24_payer_rate_policy_evidence.sql", 1],
      ] as const;
      for (const [file, expected] of laterMigrations) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        const policies = sql.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
        expect(policies, file).toHaveLength(expected);
        for (const block of policies) {
          const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
          expect(new Set(vars), file).toEqual(new Set(["app.org_id"]));
          expect(block, file).not.toMatch(/pg_has_role/i);
          expect(block, file).not.toMatch(/IS NULL/i);
        }
      }
    });

    it.each(NEW_TABLES)(
      "$table: the live catalog holds exactly one org-keyed policy, RLS enabled and FORCEd",
      async ({ table }) => {
        const { rows: flags } = await db.query(
          "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
          [table],
        );
        expect(flags[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const { rows: policies } = await db.query<{
          cmd: string;
          roles: string;
          qual: string;
          with_check: string;
        }>(
          "SELECT cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename=$1",
          [table],
        );
        expect(policies).toHaveLength(1);
        expect(policies[0].cmd).toBe("ALL");
        expect(policies[0].roles).toBe("{chartwarden_app}");
        for (const expression of [policies[0].qual, policies[0].with_check]) {
          expect(expression).toContain("app.org_id");
          expect(expression).not.toMatch(/select|pg_has_role|is null/i);
        }
      },
    );

    it.each(COVERED)(
      "$table: org A sees its row, org B cannot (cross-tenant denial)",
      async ({ table, key, idCol }) => {
        const id = a[key];
        const col = idCol ?? "id";
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
        );
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      },
    );

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO medicaid_validation_rule_config (organization_id, rule_key, regulatory_required_snapshot, updated_by_membership_id)
           VALUES ($1,'cross.tenant.rule',false,'00000000-0000-0000-0000-000000000000')`,
            [ORG_A], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow(/new row violates row-level security policy/);
    });

    it.each(NEW_TABLES)(
      "$table: org A can write its own row, and the WITH CHECK alone refuses org B writing into org A's scope",
      async ({ table, guard, insert }) => {
        // Control: the identical statement is valid for the owning tenant, so the refusal below cannot be a
        // CHECK, a missing grant or a typo.
        const own = await withOrg(ORG_A, () => db.query(insert, bindsFor(insert, ORG_A, a.pe)));
        expect(own.rowCount).toBe(1);
        // The provider-entity guard refuses a cross-tenant row first (the writer cannot see org A's provider
        // entity, and org B's would not match the row's organization), so only that guard is switched off:
        // what stands between org B and the insert is then the policy, and nothing else.
        await withTriggerOff(table, guard, async () => {
          await expect(
            withOrg(ORG_B, () => db.query(insert, bindsFor(insert, ORG_A, a.pe))),
          ).rejects.toThrow(/new row violates row-level security policy/);
        });
      },
    );

    it.each(
      COVERED.filter((t) =>
        ["medicaid_program_assignment", "medicaid_enrollment_evidence"].includes(t.table),
      ),
    )("$table: org B cannot UPDATE org A's row (USING covers writes)", async ({ table, key }) => {
      const res = await withOrg(ORG_B, () =>
        db.query(`UPDATE ${table} SET version = version + 1 WHERE id=$1`, [a[key]]),
      );
      expect(res.rowCount).toBe(0);
      const own = await withOrg(ORG_A, () =>
        db.query(`UPDATE ${table} SET version = version WHERE id=$1`, [a[key]]),
      );
      expect(own.rowCount).toBe(1);
    });

    it.each(NEW_TABLES)(
      "$table: a provider entity from another organization is refused by the guard (the row itself is valid for its tenant)",
      async ({ insert }) => {
        await expect(
          withOrg(ORG_A, () => db.query(insert, bindsFor(insert, ORG_A, b.pe))),
        ).rejects.toThrow(/provider entity must belong/);
      },
    );

    const APPEND_ONLY = [
      { table: "medicaid_payer_authorization_event", key: "payerAuthorizationEvent" },
      { table: "medicaid_payer_rate_policy", key: "payerRatePolicy" },
    ] as const;

    it.each(APPEND_ONLY)(
      "$table: the append-only trigger refuses UPDATE and DELETE even on a superuser connection",
      async ({ table, key }) => {
        // A superuser holds every grant and skips RLS, so only the trigger can answer here.
        await expect(
          db.query(`UPDATE ${table} SET created_at = created_at WHERE id=$1`, [a[key]]),
        ).rejects.toThrow(/append-only/);
        await expect(db.query(`DELETE FROM ${table} WHERE id=$1`, [a[key]])).rejects.toThrow(
          /append-only/,
        );
      },
    );

    it.each(APPEND_ONLY)(
      "$table: the application role holds no UPDATE or DELETE grant",
      async ({ table, key }) => {
        await expect(
          withOrg(ORG_A, () =>
            db.query(`UPDATE ${table} SET created_at = created_at WHERE id=$1`, [a[key]]),
          ),
        ).rejects.toThrow(/permission denied for table/);
        await expect(
          withOrg(ORG_A, () => db.query(`DELETE FROM ${table} WHERE id=$1`, [a[key]])),
        ).rejects.toThrow(/permission denied for table/);
      },
    );

    it("authorization evidence cannot be inserted as verified by the application role", async () => {
      const verified = `INSERT INTO medicaid_payer_authorization_event
               (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
                canonical_payer_id, service_state, service_from, service_to, event_kind,
                evidence_status, evidence_source, evidence_reference, verified_at,
                verified_by_membership_id, recorded_by_membership_id)
             VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),
                     gen_random_uuid(),'OR','2026-01-01','2026-01-31','authorization_approved',
                     'verified','payer_response','payer-response:test-review',now(),
                     gen_random_uuid(),gen_random_uuid())`;
      // Control: the same row is valid (every CHECK, RLS, grants); only a non-application role may write it.
      expect((await db.query(verified, [ORG_A, a.pe, PATIENT])).rowCount).toBe(1);
      await expect(
        withOrg(ORG_A, () => db.query(verified, [ORG_A, a.pe, PATIENT])),
      ).rejects.toThrow(/separate reviewer path/);
    });

    it("authorization event audit records omit patient and evidence references", async () => {
      const audit = await db.query<{ after: unknown }>(
        `SELECT after FROM audit_event
         WHERE resource_kind='medicaid_payer_authorization_event' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.payerAuthorizationEvent],
      );
      expect(audit.rows).toHaveLength(1);
      const payload = JSON.stringify(audit.rows[0].after);
      expect(payload).not.toContain("44444444-4444-4444-4444-444444444444");
      expect(payload).not.toContain("payer-response:synthetic-test");
    });

    it("payer rate policy: application inserts cannot assert verification, and the locality CHECK holds", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_payer_rate_policy
               (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, rate_cents, source_kind, effective_from,
                recorded_by_membership_id)
             VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','   ','RHC','per_day',
                     10000,'cco_contract','2026-01-01','00000000-0000-0000-0000-000000000000')`,
            [ORG_A, a.pe],
          ),
        ),
      ).rejects.toThrow(/medicaid_payer_rate_policy_locality_valid/);
      const verified = `INSERT INTO medicaid_payer_rate_policy
               (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
                source_kind, verification_status, effective_from, source_document_ref, verified_at,
                verified_by_membership_id, recorded_by_membership_id)
             VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','CBSA-TEST','RHC','per_day',1,60,
                     10000,'cco_contract','verified','2026-01-01','doc:synthetic',now(),
                     gen_random_uuid(),gen_random_uuid())`;
      // Control: the same row satisfies every CHECK, so the refusal is the verification guard.
      expect((await db.query(verified, [ORG_A, a.pe])).rowCount).toBe(1);
      await expect(withOrg(ORG_A, () => db.query(verified, [ORG_A, a.pe]))).rejects.toThrow(
        /separate reviewer path/,
      );
    });

    it("payer rate policy audit omits source document references", async () => {
      const audit = await db.query<{ after: unknown }>(
        `SELECT after FROM audit_event
         WHERE resource_kind='medicaid_payer_rate_policy' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.payerRatePolicy],
      );
      expect(audit.rows).toHaveLength(1);
      const payload = JSON.stringify(audit.rows[0].after);
      expect(payload).not.toContain("doc:synthetic");
    });

    // ── A2 — siting: the patient-keyed 1535/1538 tables carry the same nullable location_id as every older M24
    // patient table (a location FK is RESTRICT-on-delete, like the rest of M24).
    describe.each([
      {
        table: "medicaid_program_assignment",
        insertWith: (location_id: string) =>
          insertRow("medicaid_program_assignment", assignmentRow({ location_id })),
      },
      {
        table: "medicaid_payer_authorization_event",
        insertWith: (location_id: string) =>
          insertRow("medicaid_payer_authorization_event", {
            organization_id: ORG_A,
            provider_entity_id: a.pe,
            patient_id: PATIENT,
            patient_payer_id: randomUUID(),
            admission_id: randomUUID(),
            canonical_payer_id: randomUUID(),
            service_state: "OR",
            service_from: "2026-01-01",
            service_to: "2026-01-31",
            event_kind: "authorization_pending",
            evidence_source: "operator_record",
            recorded_by_membership_id: RECORDER,
            location_id,
          }),
      },
    ])("$table siting", ({ table, insertWith }) => {
      it("has a nullable location_id referencing location(id) ON DELETE RESTRICT", async () => {
        const col = await db.query(
          "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='location_id'",
          [table],
        );
        expect(col.rows).toEqual([{ is_nullable: "YES", data_type: "uuid" }]);
        const fk = await db.query(
          `SELECT confrelid::regclass::text AS parent, confdeltype FROM pg_constraint
           WHERE conrelid = $1::regclass AND contype = 'f'
             AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'location_id')]`,
          [table],
        );
        expect(fk.rows).toEqual([{ parent: "location", confdeltype: "r" }]);
      });

      it("stores a real location and refuses an unknown one", async () => {
        const location = (
          await db.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc A','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [a.pe],
          )
        ).rows[0].id as string;
        expect(await insertWith(location)).toBeTruthy();
        await expect(insertWith(randomUUID())).rejects.toThrow(/violates foreign key constraint/);
      });
    });

    // ── A3 — the 1535 mutable evidence tables: four-eyes CHECK, column-limited UPDATE, identity guard and a
    // status-transition guard (the 1532 / WF09 precedent), each reachable only by the control under test.
    const VERIFY_COLUMNS =
      "status='verified', verification_source='state_registry', evidence_reference='doc:synthetic-evidence', verified_at=now(), verified_by_membership_id=$2, version=version+1, updated_at=now()";
    const MUTABLE = [
      {
        table: "medicaid_program_assignment",
        seedKey: "programAssignment" as const,
        row: assignmentRow,
        verification: assignmentVerification,
        fourEyes: "medicaid_program_assignment_four_eyes",
        updatable: [
          "canonical_payer_classification_id",
          "evidence_reference",
          "revocation_reason",
          "status",
          "updated_at",
          "verification_source",
          "verified_at",
          "verified_by_membership_id",
          "version",
        ],
        verifySet: `${VERIFY_COLUMNS}, canonical_payer_classification_id=gen_random_uuid()`,
        identityChanges: () => ({
          organization_id: ORG_B,
          patient_id: randomUUID(),
          patient_payer_id: randomUUID(),
          admission_id: randomUUID(),
          provider_entity_id: randomUUID(),
          location_id: randomUUID(),
          service_state: "WA",
          program_kind: "unsupported",
          canonical_payer_id: randomUUID(),
          payer_snapshot: JSON.stringify({ label: "changed" }),
          effective_from: "2026-03-01",
          effective_to: "2026-12-31",
          source_kind: "other",
          recorded_by_membership_id: REVIEWER,
          supersedes_id: randomUUID(),
          created_at: "2020-01-01T00:00:00Z",
        }),
        terminal: ["rejected", "revoked", "superseded"],
        afterVerified: ["revoked", "superseded"],
        open: ["candidate", "pending"],
        frozenEvidence: {
          canonical_payer_classification_id: () => randomUUID(),
          evidence_reference: () => "doc:rewritten",
          verification_source: () => "payer_confirmation",
          verified_at: () => "2026-03-01T00:00:00Z",
          verified_by_membership_id: () => "00000000-0000-0000-0000-0000000000bb",
        },
      },
      {
        table: "medicaid_enrollment_evidence",
        seedKey: "enrollmentEvidence" as const,
        row: evidenceRow,
        verification: evidenceVerification,
        fourEyes: "medicaid_enrollment_evidence_four_eyes",
        updatable: [
          "evidence_reference",
          "revocation_reason",
          "status",
          "updated_at",
          "verification_source",
          "verified_at",
          "verified_by_membership_id",
          "version",
        ],
        verifySet: VERIFY_COLUMNS,
        identityChanges: () => ({
          organization_id: ORG_B,
          provider_entity_id: randomUUID(),
          service_state: "WA",
          program_kind: "unsupported",
          canonical_payer_id: randomUUID(),
          clearinghouse: "other-house",
          vendor_payer_id: "OTHER-VENDOR",
          transaction_type: "835",
          evidence_kind: "835_era_enrollment",
          effective_from: "2026-03-01",
          effective_to: "2026-12-31",
          recorded_by_membership_id: REVIEWER,
          supersedes_id: randomUUID(),
          created_at: "2020-01-01T00:00:00Z",
        }),
        terminal: ["rejected", "expired", "revoked", "superseded"],
        afterVerified: ["revoked", "expired", "superseded"],
        open: ["pending"],
        frozenEvidence: {
          evidence_reference: () => "doc:rewritten",
          verification_source: () => "payer_confirmation",
          verified_at: () => "2026-03-01T00:00:00Z",
          verified_by_membership_id: () => "00000000-0000-0000-0000-0000000000bb",
        },
      },
    ];

    describe.each(MUTABLE)("$table mutation guards", (cfg) => {
      const { table } = cfg;
      /** A fresh row at `status` (inserted on the superuser connection, which bypasses grants, RLS and the update guard). */
      const rowAt = (status: string) =>
        insertRow(
          table,
          cfg.row({
            status,
            ...(status === "verified" ? cfg.verification : {}),
            ...(status === "revoked" ? { revocation_reason: "other" } : {}),
          }),
        );

      it("four-eyes: the verifier cannot be the person who recorded the row", async () => {
        await expect(
          insertRow(
            table,
            cfg.row({
              status: "verified",
              ...cfg.verification,
              verified_by_membership_id: RECORDER,
            }),
          ),
        ).rejects.toThrow(new RegExp(cfg.fourEyes));
        // Control: the same row with a different verifier is valid.
        expect(await rowAt("verified")).toBeTruthy();
      });

      it("the application role may update exactly the columns the verify and revoke paths write", async () => {
        const granted = await db.query<{ attname: string }>(
          `SELECT attname FROM pg_attribute
           WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
             AND has_column_privilege('chartwarden_app', attrelid, attnum, 'UPDATE')
           ORDER BY attname`,
          [table],
        );
        expect(granted.rows.map((r) => r.attname).sort()).toEqual([...cfg.updatable].sort());
        const all = await db.query<{ attname: string }>(
          "SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped",
          [table],
        );
        for (const { attname } of all.rows.filter((r) => !cfg.updatable.includes(r.attname))) {
          await expect(
            withOrg(ORG_A, () =>
              db.query(`UPDATE ${table} SET ${attname} = ${attname} WHERE id=$1`, [a[cfg.seedKey]]),
            ),
          ).rejects.toThrow(/permission denied for table/);
        }
      });

      it("the application role can record, verify and revoke a row (the paths the service uses)", async () => {
        const entry = NEW_TABLES.find((t) => t.table === table);
        if (!entry) throw new Error(`${table} missing from NEW_TABLES`);
        const id = (
          await withOrg(ORG_A, () =>
            db.query<{ id: string }>(
              `${entry.insert} RETURNING id`,
              bindsFor(entry.insert, ORG_A, a.pe),
            ),
          )
        ).rows[0].id;
        const verified = await withOrg(ORG_A, () =>
          db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, REVIEWER]),
        );
        expect(verified.rowCount).toBe(1);
        const revoked = await withOrg(ORG_A, () =>
          db.query(
            `UPDATE ${table} SET status='revoked', revocation_reason='other', version=version+1, updated_at=now() WHERE id=$1`,
            [id],
          ),
        );
        expect(revoked.rowCount).toBe(1);
      });

      it("identity: no column that says what the row IS can change, for any role", async () => {
        // The superuser holds every grant and skips RLS, so only the guard trigger can answer.
        const changes = Object.entries(cfg.identityChanges());
        expect(changes.length).toBeGreaterThan(10);
        for (const [column, value] of changes) {
          const id = await rowAt("pending");
          await expect(
            db.query(`UPDATE ${table} SET ${column} = $2 WHERE id=$1`, [id, value]),
            column,
          ).rejects.toThrow(/cannot be changed/);
        }
        // Control: a value column still updates.
        const id = await rowAt("pending");
        expect(
          (await db.query(`UPDATE ${table} SET version = version + 1 WHERE id=$1`, [id])).rowCount,
        ).toBe(1);
      });

      it("status: a row verifies only from an open status, a verified row can only be revoked or superseded, a closed row is final", async () => {
        const everyStatus = [...cfg.open, "verified", ...cfg.terminal];
        const legal = (from: string, to: string) =>
          cfg.open.includes(from) || (from === "verified" && cfg.afterVerified.includes(to));
        for (const from of everyStatus) {
          for (const to of everyStatus.filter((s) => s !== from)) {
            const id = await rowAt(from);
            const attempt =
              to === "verified"
                ? db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, REVIEWER])
                : db.query(`UPDATE ${table} SET status=$2 WHERE id=$1`, [id, to]);
            if (legal(from, to)) {
              expect((await attempt).rowCount, `${from} -> ${to}`).toBe(1);
            } else {
              await expect(attempt, `${from} -> ${to}`).rejects.toThrow(/is final|can only be/);
            }
          }
        }
      });

      it("insert: the application role records only an open row, so a one-statement verified or closed insert is refused and a later UPDATE to verified still works", async () => {
        // The verified and closed rows satisfy every CHECK (the four-eyes CHECK compares two values the same caller
        // supplies), so only the BEFORE INSERT status guard can refuse them. The control is the identical row written
        // outside the application role. This refuses a ONE-statement insert only; the known-limit test below pins
        // what it does not stop.
        const forgedStatuses = ["verified", ...cfg.terminal];
        for (const status of forgedStatuses) {
          const forged = cfg.row({
            status,
            ...(status === "verified" ? cfg.verification : {}),
            ...(status === "revoked" ? { revocation_reason: "other" } : {}),
          });
          expect(
            await insertRow(table, forged),
            `control: ${status} outside the app role`,
          ).toBeTruthy();
          await expect(
            withOrg(ORG_A, () => insertRow(table, forged)),
            status,
          ).rejects.toThrow(/requires a separate reviewer path/);
        }
        // The legitimate path: an open row is recorded by the application role and verified by another member.
        for (const status of cfg.open) {
          const id = await withOrg(ORG_A, () => insertRow(table, cfg.row({ status })));
          const verified = await withOrg(ORG_A, () =>
            db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, REVIEWER]),
          );
          expect(verified.rowCount, `verify a row recorded as ${status}`).toBe(1);
        }
      });

      // PINS A KNOWN LIMIT so nobody re-claims more than the database does. The database cannot tell the verify route
      // from other application SQL (a trigger has no caller-bound identity), so the insert guard above does not make
      // verification route-only: the application role can insert an open row and verify it in a second statement,
      // naming any verifier. Verification itself (the M40 classification match, the source allow-list, step-up) is
      // enforced by the verify service. What the database does guarantee is the four-eyes arithmetic (the verifier
      // column differs from the recorder column), the identity and evidence freeze after verification and the
      // transition table (all proved by the tests above), not WHO the verifier is.
      it("known limit: the application role can insert an open row and then verify it, naming any verifier, except the recorder", async () => {
        const id = await withOrg(ORG_A, () => insertRow(table, cfg.row({ status: "pending" })));
        const asRecorder = withOrg(ORG_A, () =>
          db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, RECORDER]),
        );
        await expect(asRecorder, "the recorder as verifier").rejects.toThrow(
          new RegExp(cfg.fourEyes),
        );
        const chosenVerifier = randomUUID();
        const verified = await withOrg(ORG_A, () =>
          db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, chosenVerifier]),
        );
        expect(verified.rowCount).toBe(1);
        const { rows } = await db.query<{ status: string; verified_by_membership_id: string }>(
          `SELECT status, verified_by_membership_id FROM ${table} WHERE id=$1`,
          [id],
        );
        expect(rows[0]).toEqual({ status: "verified", verified_by_membership_id: chosenVerifier });
      });

      it("evidence: once a row leaves its open status the verification evidence cannot be rewritten", async () => {
        for (const [column, value] of Object.entries(cfg.frozenEvidence)) {
          const id = await rowAt("verified");
          await expect(
            db.query(`UPDATE ${table} SET ${column} = $2 WHERE id=$1`, [id, value()]),
            column,
          ).rejects.toThrow(/verification evidence cannot change/);
        }
        // Control: the same columns are written freely while the row is still open (that is the verify step).
        const id = await rowAt(cfg.open[cfg.open.length - 1]);
        expect(
          (
            await db.query(
              `UPDATE ${table} SET evidence_reference='doc:first', verification_source='state_registry' WHERE id=$1`,
              [id],
            )
          ).rowCount,
        ).toBe(1);
      });
    });

    // ── A4 — the 1539 identity key is per chain head: a correction names its predecessor and may reuse the
    // effective date; a second correction of the same predecessor (a fork) and a second head are still refused.
    it("payer rate policy: a correcting row may repeat the identity and effective date, once per predecessor", async () => {
      const correction = (supersedes: string | null) =>
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_payer_rate_policy
               (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
                source_kind, effective_from, recorded_by_membership_id, supersedes_id)
             SELECT organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, bucket_from, bucket_to, 9000,
                source_kind, effective_from, recorded_by_membership_id, $2::uuid
             FROM medicaid_payer_rate_policy WHERE id = $1`,
            [a.payerRatePolicy, supersedes],
          ),
        );
      // A second head with the same identity (no predecessor) is a duplicate.
      await expect(correction(null)).rejects.toThrow(/medicaid_payer_rate_policy_identity_uq/);
      // The correction names the row it replaces.
      expect((await correction(a.payerRatePolicy)).rowCount).toBe(1);
      // Two corrections of the same predecessor would fork the chain.
      await expect(correction(a.payerRatePolicy)).rejects.toThrow(
        /medicaid_payer_rate_policy_identity_uq/,
      );
    });

    // ── WX-PR-011 — `medicaid_state_plan_code` is PLATFORM-SHARED (no organization_id), unlike the
    // tenant-scoped tables above — read-all for every tenant, write-only via `medicaid_platform_loader`
    // (the wage_index_factor precedent). Proves 0177's seed row is real + readable, and that chartwarden_app
    // truly cannot write it (not just "the app never happens to").
    it("medicaid_state_plan_code: every org reads the platform seed row (no organization_id)", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_plan_code WHERE state_code='OR' AND plan_code='OHP-PLUS'",
        ),
      );
      expect(seenByA.rows[0].n).toBe(1);
      const seenByB = await withOrg(ORG_B, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_plan_code WHERE state_code='OR' AND plan_code='OHP-PLUS'",
        ),
      );
      expect(seenByB.rows[0].n).toBe(1); // platform-shared — org B reads it too, not just org A
    });

    it("medicaid_state_plan_code: chartwarden_app cannot INSERT (platform-loader-only write)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_state_plan_code (state_code, plan_code, plan_name, effective_from, load_source_ref)
           VALUES ('OR','SNEAK-IN','nope', now(), 'test')`,
          ),
        ),
      ).rejects.toThrow();
    });

    // ── WX-PR-011 line-assembly follow-up — `medicaid_state_rate_schedule` is PLATFORM-SHARED, same
    // posture as `medicaid_state_plan_code` above. Proves 0182's four Oregon LOC seed rows are real +
    // readable, and that chartwarden_app cannot write it.
    it("medicaid_state_rate_schedule: every org reads all four Oregon LOC seed rows", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_rate_schedule WHERE state_code='OR'",
        ),
      );
      expect(seenByA.rows[0].n).toBe(4);
      const seenByB = await withOrg(ORG_B, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_rate_schedule WHERE state_code='OR'",
        ),
      );
      expect(seenByB.rows[0].n).toBe(4);
    });

    it("medicaid_state_rate_schedule: chartwarden_app cannot INSERT (platform-loader-only write)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_state_rate_schedule (state_code, level_of_care, rate_cents, effective_from, load_source_ref)
           VALUES ('OR','RHC',1,now(),'test')`,
          ),
        ),
      ).rejects.toThrow();
    });

    it("medicaid_state_rate_schedule: the NF_RB CHECK forbids a schedule row for Room & Board", async () => {
      await expect(
        db.query(
          `INSERT INTO medicaid_state_rate_schedule (state_code, level_of_care, rate_cents, effective_from, load_source_ref)
         VALUES ('OR','NF_RB',1,now(),'test')`,
        ),
      ).rejects.toThrow(/medicaid_state_rate_schedule_no_rb/);
    });
  },
);
