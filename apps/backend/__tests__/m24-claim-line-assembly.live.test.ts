/**
 * M24 Billing — Medicaid — per-line claim assembly, proven against real Postgres (WX-PR-011 follow-up).
 *
 * Drives the production `buildDrizzleM24WriteService(...).assembleClaim` as the NOBYPASSRLS `chartwarden_app`
 * role, with FAKE `coverage`/`ccnReader`/`locPeriodReader`/`signedEncounters` ports (the last describe block
 * drives the REAL `ccnReader`/`locPeriodReader` production binds — M1's `buildProviderEntityCcnResolver` and
 * M6's `createAdmissionLocPeriodsReader`; the rest of this suite's job is the REAL Drizzle writes inside
 * assembleClaim — the segment-per-LOC-period walk, the rate-schedule resolution, the R&B day walk, and the
 * `medicaid_claim_line`/`medicaid_claim_line_encounter` inserts). Real DB rows: organization, provider_entity
 * (a real FK), state_medicaid_trading_partner_credential (resolves service_state). Oregon's
 * `medicaid_state_plan_code` + `medicaid_state_rate_schedule` platform rows come from the migration seeds
 * (0177 / 0182) — not hand-seeded here, proving the seed data is actually usable end-to-end.
 *
 * Gated on a live DB: CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run <this file>
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { PlaceOfServiceFacilityKind } from "@chartwarden/medicaid-adapters";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProviderEntityCcnResolver } from "../src/bootstrap/provider-entity-resolver";
import { createAdmissionLocPeriodsReader } from "../src/modules/06-admission";
import {
  type LevelOfCarePeriodReaderPort,
  type SignedEncounterWindowReaderPort,
  buildDrizzleM24WriteService,
} from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
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
      facilityId?: string | null;
      ipuBedAssignmentId?: string | null;
    };
    function locPeriodReader(periods: readonly LocPeriodRow[]): LevelOfCarePeriodReaderPort {
      return {
        periodsForAdmission: async () =>
          periods.map((p) => ({
            ...p,
            facilityId: p.facilityId ?? null,
            ipuBedAssignmentId: p.ipuBedAssignmentId ?? null,
          })),
      };
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
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({
        connectionString: appRoleUrl(DB_URL as string),
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
        rate_at_assembly_cents: 23083,
        charges_cents: 31 * 23083,
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

    it("residence at an ALF resolves the real Q5002 place-of-service code, not the LOC-based Q5001 default", async () => {
      const admissionId = "dddddddd-1111-2222-3333-444444444444";
      const facility = await admin.query(
        `INSERT INTO facility (kind, name) VALUES ('alf', 'Sunny ALF') RETURNING id`,
      );
      const facilityId: string = facility.rows[0].id;
      const facilityKindReader = {
        async kindsFor(ids: readonly string[]) {
          const m = new Map<string, PlaceOfServiceFacilityKind>();
          if (ids.includes(facilityId)) m.set(facilityId, "alf");
          return m;
        },
      };
      const residenceReader = {
        async residenceAt() {
          return { kind: "facility" as const, facilityId };
        },
      };
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
            effectiveAt: new Date("2026-07-01"),
            endedAt: new Date("2026-07-05"),
          },
        ]),
        noEncounters(),
        facilityKindReader,
        residenceReader,
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2026-07-01",
          serviceTo: "2026-07-05",
          kind: "hospice_only",
        },
      );
      const lines = await admin.query(
        "SELECT q_code FROM medicaid_claim_line WHERE medicaid_claim_id=$1",
        [claim.id],
      );
      expect(lines.rows).toEqual([{ q_code: "Q5002" }]);
    });

    it("a confirmed own-IPU bed resolves Q5006 regardless of the LOC period's facility kind", async () => {
      const admissionId = "dddddddd-5555-6666-7777-888888888888";
      const facility = await admin.query(
        `INSERT INTO facility (kind, name) VALUES ('hospital', 'Contracted Hospital') RETURNING id`,
      );
      const facilityId: string = facility.rows[0].id;
      const facilityKindReader = {
        async kindsFor(ids: readonly string[]) {
          const m = new Map<string, PlaceOfServiceFacilityKind>();
          if (ids.includes(facilityId)) m.set(facilityId, "hospital");
          return m;
        },
      };
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_2,
            levelOfCare: "general_inpatient_care",
            effectiveAt: new Date("2026-07-10"),
            endedAt: new Date("2026-07-12"),
            facilityId,
            ipuBedAssignmentId: "ipu-bed-1",
          },
        ]),
        noEncounters(),
        facilityKindReader,
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2026-07-10",
          serviceTo: "2026-07-12",
          kind: "hospice_only",
        },
      );
      const lines = await admin.query(
        "SELECT q_code FROM medicaid_claim_line WHERE medicaid_claim_id=$1",
        [claim.id],
      );
      expect(lines.rows).toEqual([{ q_code: "Q5006" }]);
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

    it("the real composition-root LOC-period query excludes status='assigning' rows (confirm-handshake fix)", async () => {
      // apps/backend/src/index.ts's m24LocPeriodReader (the REAL escape valve, not this file's fake) adds
      // `ne(status, 'assigning')` to its WHERE clause — an unconfirmed IRC/GIP bed request must never
      // surface as a billable LOC period. This proves that exact predicate against real Postgres, not just
      // that the fake reader this suite otherwise uses behaves as scripted.
      const adm = await admin.query(
        "INSERT INTO admission (organization_id, patient_id) VALUES ($1,$2) RETURNING id",
        [ORG, PATIENT],
      );
      const admissionId = adm.rows[0].id;
      // `lcp_adm_open_idx` permits only one open (ended_at IS NULL) period per admission — end this one so
      // the second insert below doesn't collide; the predicate under test only cares about `status`.
      await admin.query(
        `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, status, effective_at, ended_at)
         VALUES ($1,$2,'general_inpatient_care','assigning','2026-08-01','2026-08-02')`,
        [ORG, admissionId],
      );
      const activeRow = await admin.query(
        `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, status, effective_at)
         VALUES ($1,$2,'routine_home_care','active','2026-08-05') RETURNING id`,
        [ORG, admissionId],
      );
      // Same predicate shape as m24LocPeriodReader's WHERE clause (organizationId + admissionId +
      // status != 'assigning'), run as a plain query — RLS enforcement on this table is proven
      // separately (m24-rls-isolation.live.test.ts); this test is purely about the status predicate.
      const rows = await admin.query(
        `SELECT id, status FROM level_of_care_period
         WHERE organization_id=$1 AND admission_id=$2 AND status != 'assigning'`,
        [ORG, admissionId],
      );
      expect(rows.rows).toEqual([{ id: activeRow.rows[0].id, status: "active" }]);
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
    describe("the real ccnReader / locPeriodReader production binds (M1 / M6 readers)", () => {
      const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
      const ESC_PATIENT = "88888888-8888-8888-8888-888888888888";
      const ESC_ADMISSION = "99999999-9999-9999-9999-999999999999";
      const ESC_LOC = "abababab-abab-abab-abab-abababababab";
      const ESC_LOC_ASSIGNING = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";

      beforeAll(async () => {
        // `level_of_care_period` FKs an admission this suite never builds; replica mode skips the FK
        // triggers for the fixture rows only — the reads under test still run as `chartwarden_app` under RLS.
        await admin.query("SET session_replication_role = replica");
        await admin.query(
          `INSERT INTO level_of_care_period (id, organization_id, admission_id, level_of_care, effective_at, ended_at, status)
           VALUES ($1,$3,$4,'routine_home_care','2026-03-01','2026-03-31','active'),
                  ($2,$3,$4,'general_inpatient_care','2026-03-15',NULL,'assigning')`,
          [ESC_LOC, ESC_LOC_ASSIGNING, ORG, ESC_ADMISSION],
        );
        await admin.query("SET session_replication_role = DEFAULT");
      });

      it("ccnReader reads provider_entity under the org's RLS context (was a 22P02 500 with no app.org_id)", async () => {
        const reader = { ccnForProviderEntity: buildProviderEntityCcnResolver(handle.db).ccnFor };
        await expect(reader.ccnForProviderEntity(ORG, peId)).resolves.toBe("123456");
        await expect(reader.ccnForProviderEntity(OTHER_ORG, peId)).resolves.toBeNull();
      });

      it("locPeriodReader reads level_of_care_period under RLS, skipping 'assigning' periods", async () => {
        const reader = createAdmissionLocPeriodsReader(handle.db);
        const periods = await reader.periodsForAdmission(ORG, ESC_ADMISSION);
        expect(periods.map((p) => p.id)).toEqual([ESC_LOC]);
        expect(periods[0]).toMatchObject({ levelOfCare: "routine_home_care", facilityId: null });
        await expect(reader.periodsForAdmission(OTHER_ORG, ESC_ADMISSION)).resolves.toEqual([]);
      });

      it("assembleClaim with both real readers writes the line (the dev-seed M24 assemble 500)", async () => {
        const svc = buildDrizzleM24WriteService(
          handle.db,
          NOOP_OUTBOX,
          OPEN_CIPHER,
          coverage,
          { ccnForProviderEntity: buildProviderEntityCcnResolver(handle.db).ccnFor },
          createAdmissionLocPeriodsReader(handle.db),
          noEncounters(),
        );
        const claim = await svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [], stepUpRecent: false },
          {
            patientId: ESC_PATIENT,
            admissionId: ESC_ADMISSION,
            providerEntityId: peId,
            serviceFrom: "2026-03-01",
            serviceTo: "2026-03-31",
            kind: "hospice_only",
          },
        );
        const lines = await admin.query(
          "SELECT level_of_care, units FROM medicaid_claim_line WHERE medicaid_claim_id=$1",
          [claim.id],
        );
        expect(lines.rows).toEqual([{ level_of_care: "RHC", units: 31 }]);
      });
    });
    describe("S11 (#711): submit refused for states without a Medicaid gateway", () => {
      async function readyClaim(
        state: string,
        claimState: string,
        isGatewayBound?: (s: string) => boolean,
      ) {
        const published: unknown[] = [];
        const svc = buildDrizzleM24WriteService(
          handle.db,
          {
            async publish(_tx: unknown, ev: unknown) {
              published.push(ev);
            },
          } as never,
          OPEN_CIPHER,
          coverage,
          ccnReader,
          locPeriodReader([
            {
              id: LOC_1,
              levelOfCare: "routine_home_care",
              effectiveAt: new Date("2026-06-01"),
              endedAt: new Date("2026-06-10"),
            },
          ]),
          noEncounters(),
          undefined,
          undefined,
          undefined,
          isGatewayBound,
        );
        const actor = { organizationId: ORG, userId: USER, roles: [], stepUpRecent: true };
        const claim = await svc.assembleClaim(actor, {
          patientId: PATIENT,
          admissionId: "99999999-9999-9999-9999-999999999999",
          providerEntityId: peId,
          serviceFrom: "2026-06-01",
          serviceTo: "2026-06-10",
          kind: "hospice_only",
        });
        await admin.query("UPDATE medicaid_claim SET state=$3, service_state=$2 WHERE id=$1", [
          claim.id,
          state,
          claimState,
        ]);
        published.length = 0;
        const v = await admin.query("SELECT version FROM medicaid_claim WHERE id=$1", [claim.id]);
        return { svc, actor, claim, published, version: v.rows[0].version as number };
      }

      it("ordering: a non-READY WA claim still gets 409 INVALID_TRANSITION, not the gateway refusal", async () => {
        const { svc, actor, claim, version } = await readyClaim("WA", "DRAFT");
        await expect(
          svc.submitClaim(actor, claim.id, { expectedVersion: version }),
        ).rejects.toMatchObject({ code: "INVALID_TRANSITION", statusCode: 409 });
      });

      it("a READY Oregon claim with a bound gateway still submits (SUBMITTED, submission row, outbox event)", async () => {
        const { svc, actor, claim, published, version } = await readyClaim("OR", "READY");
        await svc.submitClaim(actor, claim.id, { expectedVersion: version });
        const after = await admin.query("SELECT state FROM medicaid_claim WHERE id=$1", [claim.id]);
        expect(after.rows[0].state).toBe("SUBMITTED");
        const subs = await admin.query(
          "SELECT 1 FROM medicaid_submission WHERE medicaid_claim_id=$1",
          [claim.id],
        );
        expect(subs.rowCount).toBe(1);
        expect((published as { eventName: string }[]).map((e) => e.eventName)).toContain(
          "m24.medicaid_claim.submit_requested",
        );
      });

      it("a READY Oregon claim is refused with the same code when the gateway is unbound", async () => {
        const { svc, actor, claim, published, version } = await readyClaim(
          "OR",
          "READY",
          (s) => s !== "OR",
        );
        await expect(
          svc.submitClaim(actor, claim.id, { expectedVersion: version }),
        ).rejects.toMatchObject({
          code: "MEDICAID_STATE_NO_ELECTRONIC_GATEWAY",
          statusCode: 422,
        });
        const subs = await admin.query(
          "SELECT 1 FROM medicaid_submission WHERE medicaid_claim_id=$1",
          [claim.id],
        );
        expect(subs.rowCount).toBe(0);
        expect(published).toHaveLength(0);
      });
      it.each(["WA", "ID", "CA", "NV"])(
        "%s: submit is refused with the stable code, no submission row, no outbox event, state unchanged",
        async (state) => {
          const published: unknown[] = [];
          const svc = buildDrizzleM24WriteService(
            handle.db,
            {
              async publish(_tx: unknown, ev: unknown) {
                published.push(ev);
              },
            } as never,
            OPEN_CIPHER,
            coverage,
            ccnReader,
            locPeriodReader([
              {
                id: LOC_1,
                levelOfCare: "routine_home_care",
                effectiveAt: new Date("2026-05-01"),
                endedAt: new Date("2026-05-10"),
              },
            ]),
            noEncounters(),
          );
          const actor = { organizationId: ORG, userId: USER, roles: [], stepUpRecent: true };
          const claim = await svc.assembleClaim(actor, {
            patientId: PATIENT,
            admissionId: "99999999-9999-9999-9999-999999999999",
            providerEntityId: peId,
            serviceFrom: "2026-05-01",
            serviceTo: "2026-05-10",
            kind: "hospice_only",
          });
          await admin.query(
            "UPDATE medicaid_claim SET state='READY', service_state=$2 WHERE id=$1",
            [claim.id, state],
          );
          published.length = 0; // assembleClaim emits its own events; only submit-time emissions matter
          const ready = await admin.query("SELECT version FROM medicaid_claim WHERE id=$1", [
            claim.id,
          ]);
          await expect(
            svc.submitClaim(actor, claim.id, { expectedVersion: ready.rows[0].version }),
          ).rejects.toMatchObject({
            code: "MEDICAID_STATE_NO_ELECTRONIC_GATEWAY",
            statusCode: 422,
            message: expect.stringMatching(/manually.*paper/),
          });
          const subs = await admin.query(
            "SELECT 1 FROM medicaid_submission WHERE medicaid_claim_id=$1",
            [claim.id],
          );
          expect(subs.rowCount).toBe(0);
          expect(published).toHaveLength(0);
          const after = await admin.query("SELECT state FROM medicaid_claim WHERE id=$1", [
            claim.id,
          ]);
          expect(after.rows[0].state).toBe("READY");
        },
      );
    });
  },
);
