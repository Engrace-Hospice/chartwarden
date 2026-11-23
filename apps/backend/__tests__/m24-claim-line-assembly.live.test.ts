import { randomUUID } from "node:crypto";
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
  type AdmissionCadenceReaderPort,
  type LevelOfCarePeriodReaderPort,
  type SignedEncounterWindowReaderPort,
  buildDrizzleM24WriteService as buildProductionM24WriteService,
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
const STATUS_READER_PATIENT = "abababab-abab-abab-abab-abababababab";
const PREVIEW_ADMISSION = "abababab-abab-abab-abab-abababababac";
const PREVIEW_OTHER_PE_PAYER = "abababab-abab-abab-abab-abababababad";
const LOC_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const LOC_2 = "ffffffff-ffff-ffff-ffff-ffffffffffff";
let TEST_PE_ID = "";

const testCadenceReader: AdmissionCadenceReaderPort = {
  previewSnapshotInTransaction: async (_tx, _org, admissionId) => ({
    patientId: admissionId === RB_ADMISSION ? RB_PATIENT : PATIENT,
    providerEntityId: TEST_PE_ID,
    locationId: null,
    serviceAddressState: "OR",
    dischargedAt: null,
    status: "active",
    stayEndFacts: {
      dischargeDate: null,
      dischargeReason: null,
      deceasedDate: null,
      pendingDischargeDates: [],
      transferOut: null,
      revocationDate: null,
    },
  }),
  cadenceSnapshotInTransaction: async (_tx, _org, admissionId) => ({
    patientId: admissionId === RB_ADMISSION ? RB_PATIENT : PATIENT,
    providerEntityId: TEST_PE_ID,
    locationId: null,
    serviceAddressState: "OR",
    dischargedAt: null,
    status: "active",
    stayEndFacts: {
      dischargeDate: null,
      dischargeReason: null,
      deceasedDate: null,
      pendingDischargeDates: [],
      transferOut: null,
      revocationDate: null,
    },
  }),
  periodsForAdmissionInTransaction: async () => [],
};

function buildDrizzleM24WriteServiceWithCadence(
  cadenceReader: AdmissionCadenceReaderPort,
  ...args: Parameters<typeof buildProductionM24WriteService>
): ReturnType<typeof buildProductionM24WriteService> {
  return buildProductionM24WriteService(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    args[7],
    args[8],
    args[9],
    args[10],
    args[11] ?? cadenceReader,
    args[12] ?? {
      adapterForState: () => ({ replacementTob: () => "817", voidTob: () => "818" }),
    },
  );
}

function buildDrizzleM24WriteService(
  ...args: Parameters<typeof buildProductionM24WriteService>
): ReturnType<typeof buildProductionM24WriteService> {
  return buildDrizzleM24WriteServiceWithCadence(testCadenceReader, ...args);
}

/** `previewClaimAssembly` is optional on the service interface; the Drizzle service always implements it. */
function previewClaimAssemblyOf(svc: ReturnType<typeof buildProductionM24WriteService>) {
  const preview = svc.previewClaimAssembly;
  if (!preview)
    throw new Error("the Drizzle M24 write service must implement previewClaimAssembly");
  return preview.bind(svc);
}

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
    const coverageForRank = (rank: number) => ({
      id: PAYER,
      patientId: PATIENT,
      payerId: PAYER,
      rank,
      coverageKind: "medicaid",
      subscriberId: "synthetic-member-0001",
      groupNumber: null,
      current: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    });
    const resolution = (coverageRow: ReturnType<typeof coverageForRank>) => ({
      status: "uniform" as const,
      coverage: coverageRow,
    });
    function makeCoverage(preflightRank: number, lockedRank = preflightRank) {
      const preflightMedicaid = coverageForRank(preflightRank);
      const lockedMedicaid = coverageForRank(lockedRank);
      const medicarePrimary = {
        ...preflightMedicaid,
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        payerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        rank: 1,
        coverageKind: "medicare_ffs",
        subscriberId: "synthetic-member-0002",
      };
      return {
        async activeMedicaidCoverage() {
          return { id: PAYER, payerId: PAYER, subscriberId: "synthetic-member-0001", rank: 1 };
        },
        async claimCoverageForRange() {
          return {
            medicaid: resolution(preflightMedicaid),
            primary: resolution(preflightRank === 1 ? preflightMedicaid : medicarePrimary),
          };
        },
        async claimCoverageSnapshotInTransaction() {
          return {
            medicaid: resolution(lockedMedicaid),
            primary: resolution(lockedRank === 1 ? lockedMedicaid : medicarePrimary),
            patientLifecycle: { status: "active" as const, deceasedDate: null },
          };
        },
      };
    }
    const coverage = makeCoverage(1);
    const ccnReader = {
      async ccnForProviderEntity() {
        return "123456";
      },
    };
    function coverageWithRanks(preflightRank: number, lockedRank = preflightRank) {
      return makeCoverage(preflightRank, lockedRank);
    }

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
      TEST_PE_ID = peId;
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

    async function expectUnpricedAssembly(operation: () => Promise<unknown>) {
      const before = await admin.query(
        "SELECT (SELECT count(*)::int FROM medicaid_claim) AS claims, (SELECT count(*)::int FROM medicaid_claim_line) AS lines",
      );
      await expect(operation()).rejects.toMatchObject({ code: "MEDICAID_RATE_POLICY_UNRESOLVED" });
      const after = await admin.query(
        "SELECT (SELECT count(*)::int FROM medicaid_claim) AS claims, (SELECT count(*)::int FROM medicaid_claim_line) AS lines",
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    }

    it("migration 1537 treats nullable payer/locality keys as one rate identity", async () => {
      const identity = {
        state: "OR",
        loc: "RHC",
        from: "2099-01-01",
        to: "2099-12-31",
      };
      const insert = (payer: string | null, county: string | null) =>
        admin.query(
          `INSERT INTO medicaid_state_rate_schedule
             (state_code, level_of_care, county_code, canonical_payer_id, rate_source_kind,
              verification_status, rate_cents, effective_from, effective_to, load_source_ref)
           VALUES ($1,$2,$3,$4,'legacy_unqualified','unverified',1000,$5,$6,'synthetic:test-identity')`,
          [identity.state, identity.loc, county, payer, identity.from, identity.to],
        );

      await insert(null, null);
      await expect(insert(null, null)).rejects.toMatchObject({ code: "23505" });
      const payerA = "aaaaaaaa-0000-4000-8000-000000000001";
      const payerB = "bbbbbbbb-0000-4000-8000-000000000002";
      await insert(payerA, null);
      await insert(payerB, null);
      await expect(insert(payerA, null)).rejects.toMatchObject({ code: "23505" });
      await insert(null, "001");
    });

    it("migration 1536 rejects a line whose inclusive through-date exceeds its parent claim", async () => {
      const parent = await admin.query(
        `INSERT INTO medicaid_claim
           (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
            service_state, kind, tob, service_from, service_to, state_plan_code_id,
            state_plan_code_snapshot, medicaid_claim_control_number, created_by_membership_id,
            updated_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'OR','hospice_only','811','2098-01-01','2098-01-10',
                 gen_random_uuid(),'synthetic-test-plan',$6,$7,$7)
         RETURNING id`,
        [ORG, peId, PATIENT, PAYER, ADMISSION, `T-${randomUUID().slice(0, 24)}`, USER],
      );
      await expect(
        admin.query(
          `INSERT INTO medicaid_claim_line
             (organization_id, provider_entity_id, medicaid_claim_id, line_number,
              service_date, service_date_to, revenue_code, q_code, level_of_care, loc_period_id,
              units, rate_at_assembly_cents, state_rate_schedule_id_snapshot, charges_cents)
           VALUES ($1,$2,$3,1,'2098-01-01','2098-01-11','0651','Q5001','RHC',$4,1,1000,$5,1000)`,
          [ORG, peId, parent.rows[0].id, LOC_1, randomUUID()],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("outside claim range") });
    });

    it("keeps Medicaid-primary hospice assembly blocked when no qualified rate policy exists", async () => {
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
            endedAt: new Date("2026-02-01"),
          },
        ]),
        noEncounters(),
      );
      await expectUnpricedAssembly(() =>
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId: ADMISSION,
            providerEntityId: peId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            kind: "hospice_only",
          },
        ),
      );
    });

    it("assembly preview scopes eligibility to provider and selected coverage, marks stale evidence, and writes no billing rows", async () => {
      const otherPe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'654322','PE-preview-other','9876543211','enc','0930') RETURNING id`,
        [ORG],
      );
      await admin.query(
        `INSERT INTO medicaid_eligibility_check
         (organization_id, provider_entity_id, patient_id, patient_payer_id, service_state,
          as_of_service_date, outcome, checked_at, stale_at)
         VALUES
         ($1,$2,$3,$4,'OR','2026-08-05','active','2026-08-05','2099-01-01'),
         ($1,$2,$3,$5,'OR','2026-08-15','inactive','2026-08-15','2099-01-01'),
         ($1,$6,$3,$4,'OR','2026-08-20','inactive','2026-08-20','2099-01-01'),
         ($1,$2,$3,$4,'OR','2026-09-05','active','2026-09-05','2026-10-01')`,
        [ORG, peId, PATIENT, PAYER, PREVIEW_OTHER_PE_PAYER, otherPe.rows[0].id],
      );
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );
      const actor = { organizationId: ORG, userId: USER, roles: [] } as const;
      const countBusinessRows = async () => {
        const result = await admin.query(
          `SELECT
             (SELECT count(*)::int FROM medicaid_claim) AS claims,
             (SELECT count(*)::int FROM medicaid_claim_line) AS lines,
             (SELECT count(*)::int FROM rb_day) AS rb_days,
             (SELECT count(*)::int FROM outbox_event WHERE organization_id=$1) AS outbox`,
          [ORG],
        );
        return result.rows[0];
      };
      const before = await countBusinessRows();
      const previewClaimAssembly = previewClaimAssemblyOf(svc);
      const current = await previewClaimAssembly(actor, {
        patientId: PATIENT,
        admissionId: PREVIEW_ADMISSION,
        providerEntityId: peId,
        serviceFrom: "2026-08-01",
        serviceTo: "2026-08-31",
      });
      expect(current.recordedEligibility).toMatchObject({
        status: "current",
        outcome: "active",
        asOfServiceDate: "2026-08-05",
      });
      expect(current.medicareEvidence.match).toBe("not_applicable");

      const stale = await previewClaimAssembly(actor, {
        patientId: PATIENT,
        admissionId: PREVIEW_ADMISSION,
        providerEntityId: peId,
        serviceFrom: "2026-09-01",
        serviceTo: "2026-09-30",
      });
      expect(stale.recordedEligibility).toMatchObject({ status: "stale", outcome: "active" });
      expect(await countBusinessRows()).toEqual(before);

      const refreshed = await svc.refreshEligibility(actor, {
        patientId: PATIENT,
        patientPayerId: PAYER,
        providerEntityId: peId,
        asOfServiceDate: "2026-10-15",
      });
      const refreshedEvidence = await admin.query(
        "SELECT provider_entity_id FROM medicaid_eligibility_check WHERE id=$1",
        [refreshed.checkId],
      );
      expect(refreshedEvidence.rows[0]?.provider_entity_id).toBe(peId);

      await expect(
        previewClaimAssembly(actor, {
          patientId: PATIENT,
          admissionId: PREVIEW_ADMISSION,
          providerEntityId: "00000000-0000-4000-8000-000000000000",
          serviceFrom: "2026-08-01",
          serviceTo: "2026-08-31",
        }),
      ).rejects.toMatchObject({ code: "MEDICAID_ADMISSION_IDENTITY_MISMATCH", statusCode: 409 });
    });

    it("refuses hospice_only when Medicare is the rank-1 payer in the range preflight", async () => {
      const before = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverageWithRanks(2),
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );

      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId: "10101010-1010-1010-1010-101010101010",
            providerEntityId: peId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICARE_PRIMARY_HOSPICE_RESPONSIBILITY", statusCode: 409 });
      const after = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("refuses when the selected Medicaid coverage changes in the locked transaction snapshot", async () => {
      const before = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverageWithRanks(1, 2),
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );

      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId: "20202020-2020-2020-2020-202020202020",
            providerEntityId: peId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_COVERAGE_CHANGED", statusCode: 409 });
      const after = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("refuses assembly after M5 records death, before writing a claim or outbox event", async () => {
      const before = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      const base = coverageWithRanks(1);
      const deceasedCoverage = {
        ...base,
        async claimCoverageSnapshotInTransaction() {
          return {
            medicaid: resolution(coverageForRank(1)),
            primary: resolution(coverageForRank(1)),
            patientLifecycle: { status: "deceased" as const, deceasedDate: "2026-03-03" },
          };
        },
      };
      const published: string[] = [];
      const svc = buildDrizzleM24WriteServiceWithCadence(
        testCadenceReader,
        handle.db,
        {
          async publish(_tx, event) {
            published.push(event.eventName);
          },
        },
        OPEN_CIPHER,
        deceasedCoverage,
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );

      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId: ADMISSION,
            providerEntityId: peId,
            serviceFrom: "2026-03-01",
            serviceTo: "2026-03-05",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_CLAIM_AFTER_PATIENT_DEATH", statusCode: 409 });
      const after = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(published).toHaveLength(0);
    });

    it("refuses when only the actual primary coverage identity changes in the locked snapshot", async () => {
      const before = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      const unchangedMedicaid = coverageForRank(1);
      const changedPrimary = {
        ...unchangedMedicaid,
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        payerId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        subscriberId: "synthetic-member-0003",
      };
      const baseCoverage = coverageWithRanks(1);
      const coverageWithPrimaryIdentityChange = {
        ...baseCoverage,
        async claimCoverageSnapshotInTransaction() {
          return {
            medicaid: resolution(unchangedMedicaid),
            primary: resolution(changedPrimary),
            patientLifecycle: { status: "active" as const, deceasedDate: null },
          };
        },
      };
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverageWithPrimaryIdentityChange,
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );

      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId: "21212121-2121-2121-2121-212121212121",
            providerEntityId: peId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_COVERAGE_CHANGED", statusCode: 409 });
      const after = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("refuses unverified combined secondary-Medicaid format before any claim rows are written", async () => {
      const before = await admin.query(
        "SELECT (SELECT count(*)::int FROM medicaid_claim) AS claims, (SELECT count(*)::int FROM medicaid_claim_line) AS lines",
      );
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverageWithRanks(2),
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-08-01"),
            endedAt: null,
          },
        ]),
        noEncounters(),
      );

      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId: "30303030-3030-3030-3030-303030303030",
            providerEntityId: peId,
            serviceFrom: "2026-08-01",
            serviceTo: "2026-08-05",
            kind: "combined_hospice_rb",
            rbArrangementId: "30303030-3030-3030-3030-303030303031",
          },
        ),
      ).rejects.toMatchObject({
        code: "MEDICAID_SECONDARY_COMBINED_FORMAT_UNVERIFIED",
        statusCode: 409,
      });
      const after = await admin.query(
        "SELECT (SELECT count(*)::int FROM medicaid_claim) AS claims, (SELECT count(*)::int FROM medicaid_claim_line) AS lines",
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    // The `it.skip` cases below (cadence, 817 replacement, Q5002/Q5006, encounter linking) each assemble a hospice
    // level-of-care segment, and `rateByLoc` is always empty (no qualified payer-specific rate policy), so
    // assembly throws 503 MEDICAID_RATE_POLICY_UNRESOLVED before the behaviour under test runs. Unskipped on a
    // private database every one of them fails with exactly that error, so the skip stays until a rate policy
    // exists. R&B-only assembly never prices a hospice line and runs.
    it.skip("serializes concurrent original-claim cadence on the M6 admission row (requires qualified pricing)", async () => {
      const admissionId = "40404040-4040-4040-4040-404040404040";
      const locId = "41414141-4141-4141-4141-414141414141";
      await admin.query(
        `INSERT INTO admission (id, organization_id, patient_id, provider_entity_id, service_address_state, status, admission_at)
         VALUES ($1,$2,$3,$4,'OR','active','2026-09-01')`,
        [admissionId, ORG, PATIENT, peId],
      );
      await admin.query(
        `INSERT INTO level_of_care_period
           (id, organization_id, admission_id, level_of_care, status, effective_at)
         VALUES ($1,$2,$3,'routine_home_care','active','2026-09-01')`,
        [locId, ORG, admissionId],
      );
      const m6Reader = createAdmissionLocPeriodsReader(handle.db);
      const svc = buildProductionM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        m6Reader,
        noEncounters(),
        undefined,
        undefined,
        undefined,
        () => true,
        m6Reader,
        { adapterForState: () => ({ replacementTob: () => "817", voidTob: () => "818" }) },
      );
      const assemble = (serviceFrom: string, serviceTo: string) =>
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId,
            providerEntityId: peId,
            serviceFrom,
            serviceTo,
            kind: "hospice_only",
          },
        );

      const claims = await Promise.all([
        assemble("2026-09-01", "2026-09-30"),
        assemble("2026-10-01", "2026-10-31"),
      ]);
      expect(claims.map((claim) => claim.tob).sort()).toEqual(["812", "813"]);
    });

    it.skip("preserves 812 cadence through an accepted 817 replacement before the next original (requires qualified pricing)", async () => {
      const admissionId = "42424242-4242-4242-4242-424242424242";
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
            effectiveAt: new Date("2026-11-01"),
            endedAt: null,
          },
        ]),
        noEncounters(),
      );
      const first = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2026-11-01",
          serviceTo: "2026-11-30",
          kind: "hospice_only",
        },
      );
      expect(first.tob).toBe("812");
      await admin.query("UPDATE medicaid_claim SET state='ACK_ACCEPTED' WHERE id=$1", [first.id]);
      const replacement = await svc.replaceClaim(
        { organizationId: ORG, userId: USER, roles: [] },
        first.id,
        {
          expectedVersion: first.version,
          reason: "Corrected accepted claim after payer review confirmed the error.",
        },
      );
      expect(replacement.tob).toBe("817");
      await admin.query("UPDATE medicaid_claim SET state='REPLACED' WHERE id=$1", [first.id]);
      await admin.query("UPDATE medicaid_claim SET state='ACK_ACCEPTED' WHERE id=$1", [
        replacement.id,
      ]);

      const next = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2026-12-01",
          serviceTo: "2026-12-31",
          kind: "hospice_only",
        },
      );
      expect(next.tob).toBe("813");
    });

    it.skip("inserts no successor when the predecessor control number is malformed (requires qualified pricing)", async () => {
      const admissionId = "43434343-4343-4343-4343-434343434343";
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
            effectiveAt: new Date("2027-01-01"),
            endedAt: null,
          },
        ]),
        noEncounters(),
      );
      const original = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2027-01-01",
          serviceTo: "2027-01-31",
          kind: "hospice_only",
        },
      );
      await admin.query(
        "UPDATE medicaid_claim SET state='ACK_ACCEPTED', medicaid_claim_control_number='malformed' WHERE id=$1",
        [original.id],
      );
      const before = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      await expect(
        svc.replaceClaim({ organizationId: ORG, userId: USER, roles: [] }, original.id, {
          expectedVersion: original.version,
          reason: "Correction requested after a confirmed billing entry error.",
        }),
      ).rejects.toMatchObject({ code: "MEDICAID_CONTROL_NUMBER_INVALID", statusCode: 409 });
      const after = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it.skip("fails closed without a state Medicaid adapter and inserts no successor (requires qualified pricing)", async () => {
      const admissionId = "44434343-4343-4343-4343-434343434343";
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
            effectiveAt: new Date("2027-02-01"),
            endedAt: null,
          },
        ]),
        noEncounters(),
      );
      const original = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
        {
          patientId: PATIENT,
          admissionId,
          providerEntityId: peId,
          serviceFrom: "2027-02-01",
          serviceTo: "2027-02-28",
          kind: "hospice_only",
        },
      );
      await admin.query("UPDATE medicaid_claim SET state='ACK_ACCEPTED' WHERE id=$1", [
        original.id,
      ]);
      const serviceWithoutAdapter = buildProductionM24WriteService(handle.db);
      const before = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      await expect(
        serviceWithoutAdapter.replaceClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          original.id,
          {
            expectedVersion: original.version,
            reason: "Correction requested after a confirmed billing entry error.",
          },
        ),
      ).rejects.toMatchObject({
        code: "MEDICAID_ADJUSTMENT_ADAPTER_UNAVAILABLE",
        statusCode: 503,
      });
      const after = await admin.query("SELECT count(*)::int AS n FROM medicaid_claim");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("keeps multiple LOC segments unpriced until every payer-specific rate is qualified", async () => {
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
            endedAt: new Date("2026-02-11"),
          },
          {
            id: LOC_2,
            levelOfCare: "general_inpatient_care",
            effectiveAt: new Date("2026-02-11"),
            endedAt: new Date("2026-02-16"),
          },
        ]),
        noEncounters(),
      );
      await expectUnpricedAssembly(() =>
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId,
            providerEntityId: peId,
            serviceFrom: "2026-02-01",
            serviceTo: "2026-02-15",
            kind: "hospice_only",
          },
        ),
      );
    });

    it.skip("residence at an ALF resolves the real Q5002 place-of-service code, not the LOC-based Q5001 default (pricing required)", async () => {
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
            endedAt: new Date("2026-07-06"),
          },
        ]),
        noEncounters(),
        facilityKindReader,
        residenceReader,
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
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

    it.skip("a confirmed own-IPU bed resolves Q5006 regardless of the LOC period's facility kind (pricing required)", async () => {
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
            endedAt: new Date("2026-07-13"),
            facilityId,
            ipuBedAssignmentId: "ipu-bed-1",
          },
        ]),
        noEncounters(),
        facilityKindReader,
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
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

    it.skip("links a signed encounter within the segment window via medicaid_claim_line_encounter (pricing required)", async () => {
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
            endedAt: new Date("2026-03-06"),
          },
        ]),
        { encountersInWindow: async () => [{ encounterId, serviceDate: "2026-03-03" }] },
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
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
          { organizationId: ORG, userId: USER, roles: [] },
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
        "INSERT INTO admission (organization_id, patient_id, status) VALUES ($1,$2,'closed') RETURNING id",
        [ORG, STATUS_READER_PATIENT],
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

    it("rb_only with primary Medicaid writes each billable rb_day and links it back", async () => {
      await admin.query(
        `INSERT INTO admission (id, organization_id, patient_id, provider_entity_id, service_address_state, status, admission_at)
         VALUES ($1,$2,$3,$4,'OR','active','2026-05-01')`,
        [RB_ADMISSION, ORG, RB_PATIENT, peId],
      );
      await admin.query(
        `INSERT INTO level_of_care_period (id, organization_id, admission_id, level_of_care, status, effective_at)
         VALUES ($1,$2,$3,'routine_home_care','active','2026-05-01')`,
        [LOC_1, ORG, RB_ADMISSION],
      );
      const arrangement = await admin.query(
        `INSERT INTO rb_arrangement (organization_id, patient_id, provider_entity_id, nf_facility_mdm_id,
         nf_facility_name_snapshot, effective_from, contract_document_id, contract_started_at,
         nf_per_diem_routine_cents, nf_per_diem_resp_cents, nf_per_diem_gip_cents, pass_through_pct,
         retention_pct, state, created_by_membership_id, updated_by_membership_id)
       VALUES ($1,$2,$3,gen_random_uuid(),'NF','2026-05-01',gen_random_uuid(),'2026-05-01',
         20000,25000,80000,95,5,'ACTIVE',$4,$4) RETURNING id`,
        [ORG, RB_PATIENT, peId, USER],
      );
      const arrangementId = arrangement.rows[0].id;
      const location = await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Synthetic R&B Site','1 Test Way','Test City','OR','97000','America/Los_Angeles')
         RETURNING id`,
        [peId],
      );
      const locationId = location.rows[0].id as string;
      await admin.query("UPDATE rb_arrangement SET location_id=$2 WHERE id=$1", [
        arrangementId,
        locationId,
      ]);
      const rbLocPeriodReader = locPeriodReader([
        {
          id: LOC_1,
          levelOfCare: "routine_home_care",
          effectiveAt: new Date("2026-05-01"),
          endedAt: null,
        },
      ]);
      const rbDay = await admin.query(
        `INSERT INTO rb_day (organization_id, provider_entity_id, location_id, patient_id, rb_arrangement_id, service_date,
         loc_of_day, loc_period_id_snapshot, per_diem_cents_snapshot, status)
       VALUES ($1,$2,$3,$4,$5,'2026-05-05','RHC',$6,20000,'billable') RETURNING id`,
        [ORG, peId, locationId, RB_PATIENT, arrangementId, LOC_1],
      );
      const rbDayId = rbDay.rows[0].id;
      const m6Reader = createAdmissionLocPeriodsReader(handle.db);

      const svc = buildDrizzleM24WriteServiceWithCadence(
        m6Reader,
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        rbLocPeriodReader,
        noEncounters(),
      );
      const claim = await svc.assembleClaim(
        { organizationId: ORG, userId: USER, roles: [] },
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
        "SELECT id, revenue_code, q_code, level_of_care, is_rb, rb_day_id, location_id, rate_at_assembly_cents, state_rate_schedule_id_snapshot FROM medicaid_claim_line WHERE medicaid_claim_id=$1",
        [claim.id],
      );
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0]).toMatchObject({
        revenue_code: "0658",
        q_code: "Q5003",
        level_of_care: "NF_RB",
        is_rb: true,
        rb_day_id: rbDayId,
        location_id: locationId,
        rate_at_assembly_cents: 20000,
        state_rate_schedule_id_snapshot: null,
      });
      const rbDayAfter = await admin.query(
        "SELECT status, medicaid_claim_line_id FROM rb_day WHERE id=$1",
        [rbDayId],
      );
      expect(rbDayAfter.rows[0].status).toBe("billed");
      expect(rbDayAfter.rows[0].medicaid_claim_line_id).toBe(lines.rows[0].id);

      await admin.query(
        "UPDATE level_of_care_period SET level_of_care='general_inpatient_care' WHERE organization_id=$1 AND id=$2",
        [ORG, LOC_1],
      );
      const validationRunsBefore = await admin.query(
        "SELECT count(*)::int AS n FROM medicaid_validation_run WHERE organization_id=$1 AND medicaid_claim_id=$2",
        [ORG, claim.id],
      );
      await expect(
        svc.validateClaim({ organizationId: ORG, userId: USER, roles: [] }, claim.id),
      ).rejects.toMatchObject({ code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE", statusCode: 409 });
      const validationRunsAfter = await admin.query(
        "SELECT count(*)::int AS n FROM medicaid_validation_run WHERE organization_id=$1 AND medicaid_claim_id=$2",
        [ORG, claim.id],
      );
      expect(validationRunsAfter.rows[0].n).toBe(validationRunsBefore.rows[0].n);
    });

    it("fails closed for an R&B-only claim with secondary Medicaid", async () => {
      const svc = buildDrizzleM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverageWithRanks(2),
        ccnReader,
        locPeriodReader([]),
        noEncounters(),
      );
      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: RB_PATIENT,
            admissionId: RB_ADMISSION,
            providerEntityId: peId,
            serviceFrom: "2026-06-01",
            serviceTo: "2026-06-30",
            kind: "rb_only",
            rbArrangementId: "77777777-7777-4777-8777-777777777778",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_SECONDARY_RB_FORMAT_UNVERIFIED", statusCode: 409 });
    });

    it("a state with a plan code but no qualified rate source remains unresolved", async () => {
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
      const waCadenceReader: AdmissionCadenceReaderPort = {
        cadenceSnapshotInTransaction: async () => ({
          patientId: PATIENT,
          providerEntityId: waPeId,
          locationId: null,
          serviceAddressState: "WA",
          dischargedAt: null,
          status: "active",
          stayEndFacts: {
            dischargeDate: null,
            dischargeReason: null,
            deceasedDate: null,
            pendingDischargeDates: [],
            transferOut: null,
            revocationDate: null,
          },
        }),
      };
      const svc = buildDrizzleM24WriteServiceWithCadence(
        waCadenceReader,
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
            endedAt: new Date("2026-06-06"),
          },
        ]),
        noEncounters(),
      );
      await expect(
        svc.assembleClaim(
          { organizationId: ORG, userId: USER, roles: [] },
          {
            patientId: PATIENT,
            admissionId,
            providerEntityId: waPeId,
            serviceFrom: "2026-06-01",
            serviceTo: "2026-06-05",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_RATE_POLICY_UNRESOLVED" });
    });
    describe("the real ccnReader / locPeriodReader production binds (M1 / M6 readers)", () => {
      const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
      const ESC_PATIENT = "88888888-8888-8888-8888-888888888888";
      const ESC_ADMISSION = "99999999-9999-9999-9999-999999999999";
      const ESC_LOC = "abababab-abab-abab-abab-abababababab";
      const ESC_LOC_ASSIGNING = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";

      beforeAll(async () => {
        // Seed the real synthetic admission so the production cadence reader verifies the same patient and
        // provider identity as the request, and the LOC reader can follow the actual M6 relationship.
        await admin.query(
          `INSERT INTO admission (id, organization_id, provider_entity_id, patient_id, service_address_state, status, admission_at)
           VALUES ($1,$2,$3,$4,'OR','active','2026-03-01')`,
          [ESC_ADMISSION, ORG, peId, ESC_PATIENT],
        );
        await admin.query(
          `INSERT INTO level_of_care_period (id, organization_id, admission_id, level_of_care, effective_at, ended_at, status)
           VALUES ($1,$3,$4,'routine_home_care','2026-03-01','2026-03-31','active'),
                  ($2,$3,$4,'general_inpatient_care','2026-03-15',NULL,'assigning')`,
          [ESC_LOC, ESC_LOC_ASSIGNING, ORG, ESC_ADMISSION],
        );
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

      it("both real readers resolve the M6 facts, then pricing fails closed without a qualified rate", async () => {
        const svc = buildDrizzleM24WriteServiceWithCadence(
          createAdmissionLocPeriodsReader(handle.db),
          handle.db,
          NOOP_OUTBOX,
          OPEN_CIPHER,
          coverage,
          { ccnForProviderEntity: buildProviderEntityCcnResolver(handle.db).ccnFor },
          createAdmissionLocPeriodsReader(handle.db),
          noEncounters(),
        );
        await expectUnpricedAssembly(() =>
          svc.assembleClaim(
            { organizationId: ORG, userId: USER, roles: [] },
            {
              patientId: ESC_PATIENT,
              admissionId: ESC_ADMISSION,
              providerEntityId: peId,
              serviceFrom: "2026-03-01",
              serviceTo: "2026-03-30",
              kind: "hospice_only",
            },
          ),
        );
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
              endedAt: new Date("2026-06-11"),
            },
          ]),
          noEncounters(),
          undefined,
          undefined,
          undefined,
          isGatewayBound,
        );
        const actor = { organizationId: ORG, userId: USER, roles: [] };
        // Submission refusal is tested against an already persisted synthetic READY/DRAFT row. New
        // assembly cannot create a financially complete claim until an evidence-backed rate exists.
        const seeded = await admin.query(
          `INSERT INTO medicaid_claim
             (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
              service_state, kind, tob, service_from, service_to, state_plan_code_id,
              state_plan_code_snapshot, medicaid_claim_control_number, state, created_by_membership_id,
              updated_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,$6,'hospice_only','811','2026-06-01','2026-06-10',
                   gen_random_uuid(),'synthetic-test-plan',$7,$8,$9,$9)
           RETURNING id, version`,
          [
            ORG,
            peId,
            PATIENT,
            PAYER,
            "99999999-9999-9999-9999-999999999999",
            state,
            `T-${randomUUID().slice(0, 24)}`,
            claimState,
            USER,
          ],
        );
        const claim = seeded.rows[0] as { id: string; version: number };
        published.length = 0;
        return { svc, actor, claim, published, version: claim.version };
      }

      it("ordering: a non-READY WA claim still gets 409 INVALID_TRANSITION, not the gateway refusal", async () => {
        const { svc, actor, claim, version } = await readyClaim("WA", "DRAFT");
        await expect(
          svc.submitClaim(actor, claim.id, { expectedVersion: version }),
        ).rejects.toMatchObject({ code: "INVALID_TRANSITION", statusCode: 409 });
      });

      it("a READY Oregon claim remains blocked even with a gateway bound until certification is verified", async () => {
        const { svc, actor, claim, published, version } = await readyClaim(
          "OR",
          "READY",
          () => true,
        );
        await expect(
          svc.submitClaim(actor, claim.id, { expectedVersion: version }),
        ).rejects.toMatchObject({
          code: "MEDICAID_STATE_NO_ELECTRONIC_GATEWAY",
          statusCode: 422,
        });
        const after = await admin.query("SELECT state FROM medicaid_claim WHERE id=$1", [claim.id]);
        expect(after.rows[0].state).toBe("READY");
        const subs = await admin.query(
          "SELECT 1 FROM medicaid_submission WHERE medicaid_claim_id=$1",
          [claim.id],
        );
        expect(subs.rowCount).toBe(0);
        expect(published).toHaveLength(0);
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
                endedAt: new Date("2026-05-11"),
              },
            ]),
            noEncounters(),
          );
          const actor = { organizationId: ORG, userId: USER, roles: [] };
          const seeded = await admin.query(
            `INSERT INTO medicaid_claim
               (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
                service_state, kind, tob, service_from, service_to, state_plan_code_id,
                state_plan_code_snapshot, medicaid_claim_control_number, state, created_by_membership_id,
                updated_by_membership_id)
             VALUES ($1,$2,$3,$4,$5,$6,'hospice_only','811','2026-05-01','2026-05-10',
                     gen_random_uuid(),'synthetic-test-plan',$7,'READY',$8,$8)
             RETURNING id, version`,
            [
              ORG,
              peId,
              PATIENT,
              PAYER,
              "99999999-9999-9999-9999-999999999999",
              state,
              `T-${randomUUID().slice(0, 24)}`,
              USER,
            ],
          );
          const claim = seeded.rows[0] as { id: string; version: number };
          published.length = 0;
          await expect(
            svc.submitClaim(actor, claim.id, { expectedVersion: claim.version }),
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
          const after = await admin.query("SELECT state FROM medicaid_claim WHERE id=$1", [
            claim.id,
          ]);
          expect(after.rows[0].state).toBe("READY");
        },
      );
    });
  },
);
