/**
 * M24 Billing — Medicaid — per-line claim assembly, proven against real Postgres (WX-PR-011 follow-up).
 *
 * Drives the production `buildDrizzleM24WriteService(...).assembleClaim` as the NOBYPASSRLS `wardenx_app`
 * role, with FAKE `coverage`/`ccnReader`/`locPeriodReader`/`signedEncounters` ports (the composition root's
 * own escape-valve/seam reads are exercised elsewhere; this suite's job is the REAL Drizzle writes inside
 * assembleClaim — the segment-per-LOC-period walk, the rate-schedule resolution, the R&B day walk, and the
 * `medicaid_claim_line`/`medicaid_claim_line_encounter` inserts). Real DB rows: organization, provider_entity
 * (a real FK), state_medicaid_trading_partner_credential (resolves service_state). Oregon's
 * `medicaid_state_plan_code` + `medicaid_state_rate_schedule` platform rows come from the migration seeds
 * (0177 / 0182) — not hand-seeded here, proving the seed data is actually usable end-to-end.
 *
 * Gated on a live DB: WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run <this file>
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LevelOfCarePeriodReaderPort,
  type SignedEncounterWindowReaderPort,
  buildDrizzleM24WriteService,
} from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const RB_PATIENT = "66666666-6666-6666-6666-666666666666";
const RB_ADMISSION = "77777777-7777-7777-7777-777777777777";
const LOC_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const LOC_2 = "ffffffff-ffff-ffff-ffff-ffffffffffff";

describe.skipIf(!DB_URL)(
  "M24 per-line claim assembly — LIVE Postgres (WX-PR-011 follow-up)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let peId: string;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    type LocPeriodRow = {
      id: string;
      levelOfCare:
        | "routine_home_care"
        | "continuous_home_care"
        | "inpatient_respite_care"
        | "general_inpatient_care";
      effectiveAt: Date;
      endedAt: Date | null;
    };
    function locPeriodReader(periods: readonly LocPeriodRow[]): LevelOfCarePeriodReaderPort {
      return { periodsForAdmission: async () => periods };
    }
    function noEncounters(): SignedEncounterWindowReaderPort {
      return { encountersInWindow: async () => [] };
    }
    const NOOP_OUTBOX = { async publish() {} };
    const OPEN_CIPHER = { seal: (_o: string, p: string) => p, open: (_o: string, c: string) => c };
    const PAYER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const coverage = {
      async activeMedicaidCoverage() {
        return { id: PAYER, payerId: PAYER, subscriberId: "sub-1" };
      },
    };
    const ccnReader = {
      async ccnForProviderEntity() {
        return "123456";
      },
    };

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
        [ORG],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m24line@x.test')`, [USER]);
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,'123456','PE','1234567890','enc','0930') RETURNING id`,
        [ORG],
      );
      peId = pe.rows[0].id;
      await admin.query(
        `INSERT INTO state_medicaid_trading_partner_credential
         (organization_id, provider_entity_id, service_state, channel, trading_partner_id, active_from,
          created_by_membership_id, updated_by_membership_id)
       VALUES ($1,$2,'OR','direct_mmis','TP1','2026-01-01',$3,$3)`,
        [ORG, peId, USER],
      );
      await admin.query("ALTER ROLE wardenx_app LOGIN");
      handle = createDbClient({
        connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("hospice_only, one LOC period fully inside the window → one real medicaid_claim_line row", async () => {
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-01-01"),
            endedAt: new Date("2026-01-31"),
          },
        ]),
        noEncounters(),
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
        {
          patientId: PATIENT,
          admissionId: ADMISSION,
          providerEntityId: peId,
          serviceFrom: "2026-01-01",
          serviceTo: "2026-01-31",
          kind: "hospice_only",
        },
      );
      const lines = await admin.query(
        "SELECT line_number, revenue_code, q_code, level_of_care, units, rate_at_assembly_cents, charges_cents, is_rb FROM medicaid_claim_line WHERE medicaid_claim_id=$1 ORDER BY line_number",
        [claim.id],
      );
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0]).toMatchObject({
        line_number: 1,
        revenue_code: "0651",
        q_code: "Q5001",
        level_of_care: "RHC",
        units: 31,
        rate_at_assembly_cents: 20000,
        charges_cents: 31 * 20000,
        is_rb: false,
      });
    });

    it("two contiguous LOC periods (RHC then GIP) → two lines, correctly numbered", async () => {
      const admissionId = "88888888-8888-8888-8888-888888888888";
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-02-01"),
            endedAt: new Date("2026-02-10"),
          },
          {
            id: LOC_2,
            levelOfCare: "general_inpatient_care",
            effectiveAt: new Date("2026-02-11"),
            endedAt: new Date("2026-02-15"),
          },
        ]),
        noEncounters(),
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2026-02-01",
          serviceTo: "2026-02-15",
          kind: "hospice_only",
        },
      );
      const lines = await admin.query(
        "SELECT line_number, level_of_care, units FROM medicaid_claim_line WHERE medicaid_claim_id=$1 ORDER BY line_number",
        [claim.id],
      );
      expect(lines.rows).toEqual([
        { line_number: 1, level_of_care: "RHC", units: 10 },
        { line_number: 2, level_of_care: "GIP", units: 5 },
      ]);
    });

    it("links a signed encounter within the segment window via medicaid_claim_line_encounter", async () => {
      const admissionId = "99999999-9999-9999-9999-999999999999";
      const encounterId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-03-01"),
            endedAt: new Date("2026-03-05"),
          },
        ]),
        { encountersInWindow: async () => [{ encounterId, serviceDate: "2026-03-03" }] },
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-05",
          kind: "hospice_only",
        },
      );
      const line = await admin.query(
        "SELECT id FROM medicaid_claim_line WHERE medicaid_claim_id=$1 LIMIT 1",
        [claim.id],
      );
      const joins = await admin.query(
        "SELECT encounter_id FROM medicaid_claim_line_encounter WHERE medicaid_claim_line_id=$1",
        [line.rows[0].id],
      );
      expect(joins.rows).toEqual([{ encounter_id: encounterId }]);
    });

    it("no LOC period overlapping the window → MEDICAID_NO_BILLABLE_LOC_DAYS", async () => {
      const admissionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2025-01-01"),
            endedAt: new Date("2025-01-31"),
          },
        ]),
        noEncounters(),
      );
      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
          {
            patientId: PATIENT,
            admissionId,
            providerEntityId: peId,
            serviceFrom: "2026-04-01",
            serviceTo: "2026-04-05",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_NO_BILLABLE_LOC_DAYS" });
    });

    it("rb_only: one line per billable rb_day, and the rb_day flips to billed + linked back", async () => {
      const arrangement = await admin.query(
        `INSERT INTO rb_arrangement (organization_id, patient_id, provider_entity_id, nf_facility_mdm_id,
         nf_facility_name_snapshot, effective_from, nf_per_diem_routine_cents, nf_per_diem_resp_cents,
         nf_per_diem_gip_cents, pass_through_pct, retention_pct, created_by_membership_id, updated_by_membership_id)
       VALUES ($1,$2,$3,gen_random_uuid(),'NF','2026-05-01',20000,25000,80000,95,5,$4,$4) RETURNING id`,
        [ORG, RB_PATIENT, peId, USER],
      );
      const arrangementId = arrangement.rows[0].id;
      const rbDay = await admin.query(
        `INSERT INTO rb_day (organization_id, provider_entity_id, patient_id, rb_arrangement_id, service_date,
         loc_of_day, loc_period_id_snapshot, per_diem_cents_snapshot, status)
       VALUES ($1,$2,$3,$4,'2026-05-05','NF_RB',gen_random_uuid(),20000,'billable') RETURNING id`,
        [ORG, peId, RB_PATIENT, arrangementId],
      );
      const rbDayId = rbDay.rows[0].id;

      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
        {
          patientId: RB_PATIENT,
          admissionId: RB_ADMISSION,
          providerEntityId: peId,
          serviceFrom: "2026-05-01",
          serviceTo: "2026-05-31",
          kind: "rb_only",
          rbArrangementId: arrangementId,
        },
      );
      const lines = await admin.query(
        "SELECT id, revenue_code, q_code, level_of_care, is_rb, rb_day_id, rate_at_assembly_cents, state_rate_schedule_id_snapshot FROM medicaid_claim_line WHERE medicaid_claim_id=$1",
        [claim.id],
      );
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0]).toMatchObject({
        revenue_code: "0658",
        q_code: "Q5003",
        level_of_care: "NF_RB",
        is_rb: true,
        rb_day_id: rbDayId,
        rate_at_assembly_cents: 20000,
        state_rate_schedule_id_snapshot: null,
      });
      const rbDayAfter = await admin.query(
        "SELECT status, medicaid_claim_line_id FROM rb_day WHERE id=$1",
        [rbDayId],
      );
      expect(rbDayAfter.rows[0].status).toBe("billed");
      expect(rbDayAfter.rows[0].medicaid_claim_line_id).toBe(lines.rows[0].id);
    });

    it("a state with a plan code but no rate schedule → MEDICAID_STATE_RATE_SCHEDULE_MISSING", async () => {
      // A SEPARATE provider entity whose only credential is WA (the shared `peId` already carries an OR
      // credential — a second credential on the SAME PE would make service-state resolution ambiguous,
      // which is a real property of assembleClaim: it derives the state from "which credential this PE
      // holds", not from caller input). Seed a WA plan-code row (so assembly gets PAST the plan-code check)
      // but deliberately NO WA rate schedule row — proves the rate-schedule gap surfaces as its own
      // distinct, honest error.
      const waPe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,'654321','PE-WA','9876543210','enc','0930') RETURNING id`,
        [ORG],
      );
      const waPeId = waPe.rows[0].id;
      await admin.query(
        `INSERT INTO medicaid_state_plan_code (state_code, plan_code, plan_name, is_state_default, effective_from, load_source_ref)
       VALUES ('WA','WA-DEFAULT','WA Default', true, '2026-01-01', 'test')`,
      );
      await admin.query(
        `INSERT INTO state_medicaid_trading_partner_credential
         (organization_id, provider_entity_id, service_state, channel, trading_partner_id, active_from,
          created_by_membership_id, updated_by_membership_id)
       VALUES ($1,$2,'WA','direct_mmis','TP2','2026-01-01',$3,$3)`,
        [ORG, waPeId, USER],
      );
      const admissionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-06-01"),
            endedAt: new Date("2026-06-05"),
          },
        ]),
        noEncounters(),
      );
      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
          {
            patientId: PATIENT,
            admissionId,
            providerEntityId: waPeId,
            serviceFrom: "2026-06-01",
            serviceTo: "2026-06-05",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_STATE_RATE_SCHEDULE_MISSING" });
    });
  },
);
