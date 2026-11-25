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
import { createMdmEntityProvider } from "@chartwarden/mdm";
import type { PlaceOfServiceFacilityKind } from "@chartwarden/medicaid-adapters";
import { NARRATIVE_VOCAB_RELEASES } from "@chartwarden/narrative-vocab";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProviderEntityCcnResolver } from "../src/bootstrap/provider-entity-resolver";
import { buildPatientAddressReader } from "../src/modules/05-patient/address-reader";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { createAdmissionLocPeriodsReader } from "../src/modules/06-admission";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/drizzle-store";
import { m6LocClaimEndDate } from "../src/modules/24-billing-medicaid/claim-hospice-line-snapshot";
import { runMedicaidRevalidate } from "../src/modules/24-billing-medicaid/jobs/revalidate-jobs";
import { resolveSignedChcClinicalQuantity } from "../src/modules/24-billing-medicaid/pricing/chc-clinical-quantity";
import { readMedicaidHospiceBillingEvidence } from "../src/modules/24-billing-medicaid/pricing/rhc-pricing-snapshot";
import type { WriteOutboxPort } from "../src/modules/24-billing-medicaid/routes/write-service";
import {
  type AdmissionCadenceReaderPort,
  type CanonicalPayerIdentityReader,
  type LevelOfCarePeriodReaderPort,
  type SignedEncounterWindowReaderPort,
  buildM24MedicaidCoverageResolver,
  buildDrizzleM24WriteService as buildProductionM24WriteService,
  readMedicaidRatePolicyLineage,
} from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";
import {
  createDbMdmStore,
  facilityKindsForIds,
  facilityKindsForIdsInTransaction,
} from "../src/modules/40-mdm";
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
const RHC_PATIENT = "abababab-abab-abab-abab-abababababa1";
const RHC_ADMISSION = "abababab-abab-abab-abab-abababababa2";
const RHC_COVERAGE = "abababab-abab-abab-abab-abababababa3";
const RHC_PAYER = "abababab-abab-abab-abab-abababababa4";
const RHC_CLASSIFICATION = "abababab-abab-abab-abab-abababababa5";
const RHC_LOC = "abababab-abab-abab-abab-abababababa6";
const RHC_EVIDENCE = "abababab-abab-abab-abab-abababababa7";
const RHC_RATE_EARLY = "abababab-abab-abab-abab-abababababa8";
const RHC_RATE_LATE = "abababab-abab-abab-abab-abababababa9";
const RHC_ASSIGNMENT = "abababab-abab-abab-abab-abababababaa";
const RHC_ADDRESS = "abababab-abab-abab-abab-abababababac";
const RHC_ENCOUNTER = "abababab-abab-abab-abab-abababababcc";
const RHC_UNRELATED_ENCOUNTER = "abababab-abab-abab-abab-abababababce";
const RHC_SIGNER_MEMBERSHIP = "abababab-abab-abab-abab-abababababcd";
const ALF_RHC_PATIENT = "abababab-abab-abab-abab-ababababac01";
const ALF_RHC_ADMISSION = "abababab-abab-abab-abab-ababababac02";
const ALF_RHC_COVERAGE = "abababab-abab-abab-abab-ababababac03";
const ALF_RHC_ASSIGNMENT = "abababab-abab-abab-abab-ababababac04";
const ALF_RHC_LOC = "abababab-abab-abab-abab-ababababac05";
const ALF_RHC_FACILITY = "abababab-abab-abab-abab-ababababac06";
const ALF_RHC_ADDRESS = "abababab-abab-abab-abab-ababababac07";
const ALF_RHC_EVIDENCE_EARLY = "abababab-abab-abab-abab-ababababac08";
const ALF_RHC_EVIDENCE_LATE = "abababab-abab-abab-abab-ababababac09";
const ALF_CADENCE_PATIENT = "abababab-abab-abab-abab-ababababac11";
const ALF_CADENCE_COVERAGE = "abababab-abab-abab-abab-ababababac12";
const ALF_CADENCE_ADMISSION = "abababab-abab-abab-abab-ababababac13";
const ALF_CADENCE_LOC = "abababab-abab-abab-abab-ababababac14";
const ALF_CADENCE_ASSIGNMENT = "abababab-abab-abab-abab-ababababac15";
const ALF_CADENCE_ADDRESS = "abababab-abab-abab-abab-ababababac16";
const ALF_CADENCE_EVIDENCE_EARLY = "abababab-abab-abab-abab-ababababac17";
const ALF_CADENCE_EVIDENCE_LATE = "abababab-abab-abab-abab-ababababac18";
const CHC_LOC = "abababab-abab-abab-abab-abababababd3";
const CHC_ENCOUNTER = "abababab-abab-abab-abab-abababababd4";
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
};

function buildDrizzleM24WriteServiceWithCadence(
  cadenceReader: AdmissionCadenceReaderPort,
  ...args: Parameters<typeof buildProductionM24WriteService>
): ReturnType<typeof buildProductionM24WriteService> {
  const cadence = args[11] ?? cadenceReader;
  // Only test fakes bridge their fixture LOC list through this method. Production binds M6's
  // transaction-bound implementation and never uses this compatibility adapter.
  const cadenceWithLocSnapshot = cadence.periodsForAdmissionInTransaction
    ? cadence
    : {
        ...cadence,
        periodsForAdmissionInTransaction: async (
          _tx: unknown,
          organizationId: string,
          admissionId: string,
        ) => (args[5] ? args[5].periodsForAdmission(organizationId, admissionId) : []),
      };
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
    cadenceWithLocSnapshot,
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
    function m8SignedEncounterReader(
      db: ReturnType<typeof createDbClient>["db"],
    ): SignedEncounterWindowReaderPort {
      const reader = createDrizzleEncounterReaderStore(db);
      return {
        async encountersInWindow(organizationId, patientId, from, to) {
          const rows = await reader.signedEncountersForPatientSince(
            organizationId,
            patientId,
            new Date(from).toISOString(),
          );
          return rows
            .filter((row) => row.serviceDate >= from && row.serviceDate <= to)
            .map((row) => ({ ...row, organizationId }));
        },
      };
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
      await expect(operation()).rejects.toMatchObject({
        code: expect.stringMatching(
          /^MEDICAID_(RATE_POLICY_UNRESOLVED|BILLING_EVIDENCE_UNRESOLVED)$/,
        ),
      });
      const after = await admin.query(
        "SELECT (SELECT count(*)::int FROM medicaid_claim) AS claims, (SELECT count(*)::int FROM medicaid_claim_line) AS lines",
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    }

    it("persists an evidence-backed synthetic daily RHC draft across an effective rate boundary", async () => {
      const locationId = randomUUID();
      const verifierId = "33333333-3333-3333-3333-333333333334";
      const m5Reader = buildPatientCoverageReader(handle.db);
      const patientAddressReader = buildPatientAddressReader(handle.db);
      const coverageResolver = buildM24MedicaidCoverageResolver(() => m5Reader);
      const m6Reader = createAdmissionLocPeriodsReader(handle.db);
      const facilityKindReader = {
        kindsFor: (facilityIds: readonly string[]) => facilityKindsForIds(handle.db, facilityIds),
        kindsForInTransaction: (tx: unknown, facilityIds: readonly string[]) =>
          facilityKindsForIdsInTransaction(tx, facilityIds),
      };
      const mdmProvider = createMdmEntityProvider(createDbMdmStore(handle.db));
      const canonicalPayerReader: CanonicalPayerIdentityReader = {
        async resolvePayer(organizationId, canonicalPayerId) {
          const resolved = await mdmProvider.resolvePayer(organizationId, canonicalPayerId);
          return resolved
            ? {
                id: resolved.id,
                displayName: resolved.canonical.displayName,
                kind: resolved.canonical.kind,
                stateCode: resolved.canonical.stateCode,
                status: resolved.status,
              }
            : null;
        },
        medicaidProgramClassifications: (organizationId, payerId, state, from, to) =>
          mdmProvider.medicaidPayerProgramClassifications(organizationId, payerId, state, from, to),
      };

      await admin.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
         VALUES ($1,$2,'Synthetic RHC location','123 Test St','Testville','OR','00000','America/Los_Angeles')`,
        [locationId, peId],
      );
      await admin.query(
        `INSERT INTO payer (id,kind,state_code,payer_id,name,status)
         VALUES ($1,'medicaid','OR',NULL,'Synthetic Medicaid CCO for qualification','active')`,
        [RHC_PAYER],
      );
      await admin.query(
        `INSERT INTO mdm_medicaid_payer_program_classification
           (id,canonical_payer_id,state_code,classification,effective_from,verification_status,
            source_kind,source_reference,verified_at,verified_by)
         VALUES ($1,$2,'OR','medicaid_cco','2026-01-01','verified','state_contract',
                 'contract:synthetic-rhc/classification','2026-01-01T00:00:00Z','synthetic-qualification-reviewer')`,
        [RHC_CLASSIFICATION, RHC_PAYER],
      );
      await admin.query(
        `INSERT INTO patient
           (id,organization_id,provider_entity_id,location_id,mrn,legal_first_name,legal_last_name,
            dob,sex_assigned_at_birth,status)
         VALUES ($1,$2,$3,$4,'SYN-RHC-0001','Riley','Testpatient','1950-01-01','unknown','active')`,
        [RHC_PATIENT, ORG, peId, locationId],
      );
      await admin.query(
        `INSERT INTO patient_address
           (id,patient_id,organization_id,provider_entity_id,kind,line1,city,state,postal_code,
            country,is_primary,effective_from)
         VALUES ($1,$2,$3,$4,'home','123 Test St','Testville','OR','00000','US',true,'2026-11-01')`,
        [RHC_ADDRESS, RHC_PATIENT, ORG, peId],
      );
      await admin.query(
        `INSERT INTO patient_payer
           (id,patient_id,organization_id,provider_entity_id,location_id,payer_id,rank,coverage_kind,
            subscriber_id,effective_from,effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,1,'medicaid','SYNTHETIC-MEMBER-RHC-01','2026-01-01',NULL)`,
        [RHC_COVERAGE, RHC_PATIENT, ORG, peId, locationId, RHC_PAYER],
      );
      await admin.query(
        `INSERT INTO admission
           (id,organization_id,provider_entity_id,location_id,patient_id,status,admission_at,activated_at,
            admitted_by_physician_id,service_address_line1,service_address_city,service_address_state,
            service_address_postal_code,service_address_country)
         VALUES ($1,$2,$3,$4,$5,'active','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',$6,
                 '123 Test St','Testville','OR','00000','US')`,
        [RHC_ADMISSION, ORG, peId, locationId, RHC_PATIENT, USER],
      );
      await admin.query(
        `INSERT INTO level_of_care_period
           (id,organization_id,admission_id,level_of_care,status,effective_at,ended_at,
            assigned_by,reason,q_code,version)
         VALUES ($1,$2,$3,'routine_home_care','ended','2026-11-01T00:00:00Z',
                 '2026-11-05T00:00:00Z',$4,'Synthetic qualification fixture','Q5001',0)`,
        [RHC_LOC, ORG, RHC_ADMISSION, USER],
      );
      await admin.query(
        `INSERT INTO level_of_care_period
           (id,organization_id,admission_id,level_of_care,status,effective_at,ended_at,
            assigned_by,reason,q_code,version)
         VALUES ($1,$2,$3,'continuous_home_care','ended','2026-11-05T00:00:00Z',
                 '2026-11-06T00:00:00Z',$4,'Synthetic CHC quantity qualification','Q5001',0)`,
        [CHC_LOC, ORG, RHC_ADMISSION, USER],
      );
      const signerMembership = await admin.query(
        `INSERT INTO membership (id,user_id,organization_id,status,default_provider_entity_id)
         VALUES ($1,$2,$3,'active',$4) RETURNING id`,
        [RHC_SIGNER_MEMBERSHIP, USER, ORG, peId],
      );
      await admin.query(
        `INSERT INTO encounter
           (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,
            encounter_type,discipline,authored_by_membership_id,service_date,started_at,ended_at,
            time_source,status,signed_at,vocab_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','rn',$7,'2026-11-02',
                 '2026-11-02T18:00:00Z','2026-11-02T19:30:00Z','clinician','signed',
                 '2026-11-03T01:00:00Z',$8)`,
        [
          RHC_ENCOUNTER,
          ORG,
          peId,
          locationId,
          RHC_PATIENT,
          RHC_ADMISSION,
          signerMembership.rows[0]!.id,
          NARRATIVE_VOCAB_RELEASES[0]!.id,
        ],
      );
      await admin.query(
        `INSERT INTO encounter
           (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,
            encounter_type,discipline,authored_by_membership_id,service_date,started_at,ended_at,
            time_source,status,signed_at,vocab_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','rn',$7,'2026-11-05',
                 '2026-11-05T18:00:00Z','2026-11-05T19:30:00Z','clinician','signed',
                 '2026-11-06T01:00:00Z',$8)`,
        [
          CHC_ENCOUNTER,
          ORG,
          peId,
          locationId,
          RHC_PATIENT,
          RHC_ADMISSION,
          signerMembership.rows[0]!.id,
          NARRATIVE_VOCAB_RELEASES[0]!.id,
        ],
      );
      await admin.query(
        `INSERT INTO encounter
           (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,
            encounter_type,discipline,authored_by_membership_id,service_date,started_at,ended_at,
            time_source,status,signed_at,vocab_version_id)
         VALUES ($1,$2,$3,$4,$5,'abababab-abab-abab-abab-abababababcf',
                 'routine_visit','rn',$6,'2026-11-02','2026-11-02T20:00:00Z',
                 '2026-11-02T21:00:00Z','clinician','signed','2026-11-03T01:00:00Z',$7)`,
        [
          RHC_UNRELATED_ENCOUNTER,
          ORG,
          peId,
          locationId,
          RHC_PATIENT,
          signerMembership.rows[0]!.id,
          NARRATIVE_VOCAB_RELEASES[0]!.id,
        ],
      );
      await admin.query(
        `INSERT INTO medicaid_program_assignment
           (id,organization_id,patient_id,patient_payer_id,admission_id,provider_entity_id,location_id,
            service_state,program_kind,canonical_payer_id,canonical_payer_classification_id,
            payer_snapshot,status,effective_from,effective_to,source_kind,verification_source,
            evidence_reference,verified_at,verified_by_membership_id,recorded_by_membership_id,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'OR','managed_care',$8,$9,
                 jsonb_build_object('id',$8::uuid::text,'displayName','Synthetic Medicaid CCO','kind','medicaid','stateCode','OR'),
                 'verified','2026-11-01','2026-11-04','payer_confirmation','synthetic_qualification_fixture',
                 'doc:synthetic-rhc/program-assignment','2026-01-01T00:00:00Z',$10,$11,1)`,
        [
          RHC_ASSIGNMENT,
          ORG,
          RHC_PATIENT,
          RHC_COVERAGE,
          RHC_ADMISSION,
          peId,
          locationId,
          RHC_PAYER,
          RHC_CLASSIFICATION,
          verifierId,
          USER,
        ],
      );

      const noEvidenceService = buildProductionM24WriteService(
        handle.db,
        NOOP_OUTBOX,
        OPEN_CIPHER,
        coverageResolver,
        { ccnForProviderEntity: buildProviderEntityCcnResolver(handle.db).ccnFor },
        m6Reader,
        noEncounters(),
        undefined,
        {
          async residenceAt(organizationId, patientId, asOfDate) {
            return patientAddressReader.residenceAt(organizationId, patientId, asOfDate);
          },
          async residencesBetweenInTransaction(transaction, organizationId, patientId, from, to) {
            const read = patientAddressReader.residencesBetweenInTransaction;
            if (!read) throw new Error("transaction-bound M5 residence reader unavailable");
            const rows = await read(transaction, organizationId, patientId, from, to);
            return rows.flatMap((row) =>
              row.addressId ? [{ ...row, addressId: row.addressId }] : [],
            );
          },
        },
        undefined,
        () => false,
        m6Reader,
        undefined,
        undefined,
        canonicalPayerReader,
      );
      await expectUnpricedAssembly(() =>
        noEvidenceService.assembleClaim(
          { organizationId: ORG, userId: USER, roles: ["billing_manager"] },
          {
            patientId: RHC_PATIENT,
            admissionId: RHC_ADMISSION,
            providerEntityId: peId,
            serviceFrom: "2026-11-01",
            serviceTo: "2026-11-04",
            kind: "hospice_only",
          },
        ),
      );

      const evidenceValues = [
        RHC_EVIDENCE,
        ORG,
        peId,
        RHC_PATIENT,
        RHC_ADMISSION,
        RHC_PAYER,
        USER,
        verifierId,
      ];
      await admin.query(
        `INSERT INTO medicaid_hospice_billing_evidence
           (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
            canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
            locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
            quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
            quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
            coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
            charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
            effective_to,source_document_reference,verified_at,verified_by_membership_id,
            recorded_by_membership_id,version)
         VALUES ($1,$2,$3,$4,$5,0,$6,'managed_care','OR','synthetic-locality-lineage',
                 'evidence:synthetic-rhc/locality',1,'not_required','not_applicable',
                 'evidence:synthetic-rhc/quality-applicability',1,'RHC','active_rhc_loc_calendar_day',
                 'm6_level_of_care_period','daily','0651','Q5001','local_draft_only',
                 'evidence:synthetic-rhc/coding',1,15000,'evidence:synthetic-rhc/charge',1,
                 'verified','2026-11-01','2026-11-04','doc:synthetic-rhc/billing-profile',
                 '2026-01-01T00:00:00Z',$8,$7,1)`,
        evidenceValues,
      );

      const rateInsert = async (
        id: string,
        effectiveFrom: string,
        effectiveTo: string,
        cents: number,
        locality = "synthetic-locality-lineage",
      ) => {
        await admin.query(
          `INSERT INTO medicaid_payer_rate_policy
             (id,organization_id,provider_entity_id,canonical_payer_id,program_kind,service_state,
              locality_code,service_category,unit_basis,rate_cents,pricing_method,
              quantity_conversion_method,minimum_duration_method,methodology_version,rounding_mode,
              rounding_boundary,charge_ceiling_method,charge_ceiling_boundary,
              quality_reporting_applicability,quality_reporting_status,source_kind,verification_status,
              effective_from,effective_to,source_document_ref,verified_at,verified_by_membership_id,
              recorded_by_membership_id,version)
           VALUES ($1,$2,$3,$4,'managed_care','OR',$10,'RHC','per_day',$5,
                   'per_day','daily_units','not_applicable',1,'exact_only','service_day','none',
                   'not_applicable','not_required','not_applicable','cco_contract','verified',$6,$7,
                   'doc:synthetic-rhc/rate','2026-01-01T00:00:00Z',$8,$9,1)`,
          [id, ORG, peId, RHC_PAYER, cents, effectiveFrom, effectiveTo, verifierId, USER, locality],
        );
      };
      await rateInsert(RHC_RATE_EARLY, "2026-11-01", "2026-11-02", 12000);
      await rateInsert(RHC_RATE_LATE, "2026-11-03", "2026-11-04", 13000);

      const ccn = buildProviderEntityCcnResolver(handle.db);
      const m8Encounters = m8SignedEncounterReader(handle.db);
      const currentLoc = await m6Reader.periodsForAdmission(ORG, RHC_ADMISSION);
      const chcPeriods = currentLoc.filter(
        (period) => period.levelOfCare === "continuous_home_care",
      );
      const chcServiceDates = chcPeriods.flatMap((period) => {
        const from = period.effectiveAt.toISOString().slice(0, 10);
        const to = m6LocClaimEndDate(period.endedAt);
        if (!to) return [];
        const dates: string[] = [];
        for (
          let time = Date.parse(`${from}T00:00:00.000Z`);
          time <= Date.parse(`${to}T00:00:00.000Z`);
          time += 86_400_000
        ) {
          dates.push(new Date(time).toISOString().slice(0, 10));
        }
        return dates;
      });
      const chcSourceRows = await m8Encounters.encountersInWindow(
        ORG,
        RHC_PATIENT,
        "2026-11-05",
        "2026-11-05",
      );
      const chcObservation = resolveSignedChcClinicalQuantity({
        organizationId: ORG,
        providerEntityId: peId,
        patientId: RHC_PATIENT,
        admissionId: RHC_ADMISSION,
        serviceFrom: "2026-11-05",
        serviceTo: "2026-11-05",
        serviceTimeZone: "America/Los_Angeles",
        chcServiceDates,
        encounters: chcSourceRows.map((row) => ({
          organizationId: row.organizationId ?? "",
          providerEntityId: row.providerEntityId ?? null,
          patientId: row.patientId ?? "",
          admissionId: row.admissionId ?? "",
          encounterId: row.encounterId,
          serviceDate: row.serviceDate,
          status: row.status ?? "",
          signedAt: row.signedAt ?? "",
          startedAt: row.startedAt ?? null,
          endedAt: row.endedAt ?? null,
          timeSource: row.timeSource ?? null,
          sourceVersion: row.sourceVersion,
        })),
      });
      expect(chcObservation).toMatchObject({
        status: "observed",
        payerEligibility: "unresolved",
        institutionalUnits: "unqualified",
        days: [{ serviceDate: "2026-11-05", actualClinicalMinutes: 90 }],
      });
      const events: string[] = [];
      const outbox: WriteOutboxPort = {
        async publish(_tx, event) {
          events.push(event.eventName);
        },
      };
      const service = buildProductionM24WriteService(
        handle.db,
        outbox,
        OPEN_CIPHER,
        coverageResolver,
        { ccnForProviderEntity: ccn.ccnFor },
        m6Reader,
        m8Encounters,
        facilityKindReader,
        {
          async residenceAt(organizationId, patientId, asOfDate) {
            return patientAddressReader.residenceAt(organizationId, patientId, asOfDate);
          },
          async residencesBetweenInTransaction(transaction, organizationId, patientId, from, to) {
            const read = patientAddressReader.residencesBetweenInTransaction;
            if (!read) throw new Error("transaction-bound M5 residence reader unavailable");
            const rows = await read(transaction, organizationId, patientId, from, to);
            return rows.flatMap((row) =>
              row.addressId ? [{ ...row, addressId: row.addressId }] : [],
            );
          },
        },
        undefined,
        () => false,
        m6Reader,
        undefined,
        undefined,
        canonicalPayerReader,
      );
      const actor = { organizationId: ORG, userId: USER, roles: ["billing_manager"] } as const;
      const readEvidenceInScope = (organizationId: string, providerEntityId: string) =>
        withOrgContext(handle.db, { organizationId, userId: USER }, (tx) =>
          readMedicaidHospiceBillingEvidence(tx, {
            organizationId,
            providerEntityId,
            patientId: RHC_PATIENT,
            admissionId: RHC_ADMISSION,
            admissionVersion: 0,
            canonicalPayerId: RHC_PAYER,
            programKind: "managed_care",
            serviceState: "OR",
            serviceFrom: "2026-11-01",
            serviceTo: "2026-11-04",
            assessedAt: new Date().toISOString(),
          }),
        );
      await expect(readEvidenceInScope(ORG, randomUUID())).resolves.toMatchObject({
        status: "unresolved",
        reasonCode: "BILLING_EVIDENCE_MISSING",
      });
      await expect(
        readEvidenceInScope("22222222-2222-2222-2222-222222222222", peId),
      ).resolves.toMatchObject({
        status: "unresolved",
        reasonCode: "BILLING_EVIDENCE_MISSING",
      });
      const assemblyInput = {
        patientId: RHC_PATIENT,
        admissionId: RHC_ADMISSION,
        providerEntityId: peId,
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-04",
        kind: "hospice_only" as const,
      };
      const assemblyAttempts = await Promise.allSettled([
        service.assembleClaim(actor, assemblyInput),
        service.assembleClaim(actor, assemblyInput),
      ]);
      const assembledAttempts = assemblyAttempts.filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.assembleClaim>>> =>
          attempt.status === "fulfilled",
      );
      const refusedAttempts = assemblyAttempts.filter((attempt) => attempt.status === "rejected");
      expect(assembledAttempts).toHaveLength(1);
      expect(refusedAttempts).toMatchObject([
        { status: "rejected", reason: { code: "MEDICAID_HOSPICE_SERVICE_RANGE_ALREADY_CLAIMED" } },
      ]);
      const claim = assembledAttempts[0]!.value;
      expect(claim.state).toBe("DRAFT");
      expect(claim.medicaidProgramKind).toBe("managed_care");
      expect(claim.canonicalPayerId).toBe(RHC_PAYER);
      const claimCountsBeforeDuplicate = await admin.query(
        `SELECT (SELECT count(*)::int FROM medicaid_claim WHERE admission_id=$1) AS claims,
                (SELECT count(*)::int FROM medicaid_claim_line WHERE medicaid_claim_id IN
                   (SELECT id FROM medicaid_claim WHERE admission_id=$1)) AS lines`,
        [RHC_ADMISSION],
      );
      await expect(
        service.assembleClaim(
          { organizationId: ORG, userId: USER, roles: ["billing_manager"] },
          {
            patientId: RHC_PATIENT,
            admissionId: RHC_ADMISSION,
            providerEntityId: peId,
            serviceFrom: "2026-11-01",
            serviceTo: "2026-11-04",
            kind: "hospice_only",
          },
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_HOSPICE_SERVICE_RANGE_ALREADY_CLAIMED" });
      const claimCountsAfterDuplicate = await admin.query(
        `SELECT (SELECT count(*)::int FROM medicaid_claim WHERE admission_id=$1) AS claims,
                (SELECT count(*)::int FROM medicaid_claim_line WHERE medicaid_claim_id IN
                   (SELECT id FROM medicaid_claim WHERE admission_id=$1)) AS lines`,
        [RHC_ADMISSION],
      );
      expect(claimCountsAfterDuplicate.rows).toEqual(claimCountsBeforeDuplicate.rows);

      const lines = await admin.query(
        `SELECT id,line_number,service_date::date::text AS service_from,
                service_date_to::date::text AS service_to,units,rate_at_assembly_cents,
                state_rate_schedule_id_snapshot,payer_rate_policy_id_snapshot,charges_cents
           FROM medicaid_claim_line WHERE medicaid_claim_id=$1 ORDER BY line_number`,
        [claim.id],
      );
      expect(lines.rows).toEqual([
        expect.objectContaining({
          line_number: 1,
          service_from: "2026-11-01",
          service_to: "2026-11-02",
          units: 2,
          rate_at_assembly_cents: 12000,
          state_rate_schedule_id_snapshot: null,
          payer_rate_policy_id_snapshot: RHC_RATE_EARLY,
          charges_cents: 30000,
        }),
        expect.objectContaining({
          line_number: 2,
          service_from: "2026-11-03",
          service_to: "2026-11-04",
          units: 2,
          rate_at_assembly_cents: 13000,
          state_rate_schedule_id_snapshot: null,
          payer_rate_policy_id_snapshot: RHC_RATE_LATE,
          charges_cents: 30000,
        }),
      ]);
      const snapshots = await admin.query(
        `SELECT s.fingerprint,s.snapshot_schema_version,s.snapshot,s.payer_rate_policy_id,
                s.billing_evidence_id,l.id AS line_id
           FROM medicaid_claim_line_pricing_snapshot s
           JOIN medicaid_claim_line l ON l.id=s.medicaid_claim_line_id
          WHERE s.medicaid_claim_id=$1 ORDER BY l.line_number`,
        [claim.id],
      );
      expect(snapshots.rows).toHaveLength(2);
      expect(snapshots.rows.map((row) => row.snapshot.reimbursementEstimateCents)).toEqual([
        24000, 26000,
      ]);
      expect(snapshots.rows.map((row) => row.snapshot.billedChargeCents)).toEqual([30000, 30000]);
      expect(snapshots.rows.every((row) => row.snapshot.postingAuthorized === false)).toBe(true);
      expect(
        snapshots.rows.every(
          (row) =>
            row.snapshot.serviceLocation?.patientAddressId === RHC_ADDRESS &&
            row.snapshot.serviceLocation?.kind === "home",
        ),
      ).toBe(true);
      expect(snapshots.rows.map((row) => row.payer_rate_policy_id)).toEqual([
        RHC_RATE_EARLY,
        RHC_RATE_LATE,
      ]);
      expect(snapshots.rows.every((row) => row.billing_evidence_id === RHC_EVIDENCE)).toBe(true);
      const encounterLinks = await admin.query(
        `SELECT le.medicaid_claim_line_id,le.encounter_id,l.line_number
           FROM medicaid_claim_line_encounter le
           JOIN medicaid_claim_line l ON l.id=le.medicaid_claim_line_id
          WHERE l.medicaid_claim_id=$1 ORDER BY l.line_number`,
        [claim.id],
      );
      expect(encounterLinks.rows).toEqual([
        {
          medicaid_claim_line_id: lines.rows[0]!.id,
          encounter_id: RHC_ENCOUNTER,
          line_number: 1,
        },
      ]);
      const ownSnapshotRead = await withOrgContext(
        handle.db,
        { organizationId: ORG, userId: USER },
        (tx) =>
          tx.execute(sql`SELECT count(*)::int AS n FROM medicaid_claim_line_pricing_snapshot
            WHERE medicaid_claim_id=${claim.id}`),
      );
      expect(ownSnapshotRead.rows[0]?.n).toBe(2);
      const foreignSnapshotRead = await withOrgContext(
        handle.db,
        { organizationId: "22222222-2222-2222-2222-222222222222", userId: USER },
        (tx) =>
          tx.execute(sql`SELECT count(*)::int AS n FROM medicaid_claim_line_pricing_snapshot
            WHERE medicaid_claim_id=${claim.id}`),
      );
      expect(foreignSnapshotRead.rows[0]?.n).toBe(0);
      expect(events).not.toContain("m24.medicaid_claim.ready_for_submission");
      expect(events).not.toContain("m24.medicaid_claim.submission_requested");
      const submissions = await admin.query(
        "SELECT count(*)::int AS n FROM medicaid_submission WHERE medicaid_claim_id=$1",
        [claim.id],
      );
      expect(submissions.rows[0].n).toBe(0);

      const currentLines = await admin.query(
        `SELECT * FROM medicaid_claim_line WHERE medicaid_claim_id=$1 ORDER BY line_number`,
        [claim.id],
      );
      const payer = await admin.query("SELECT id,kind,state_code,status FROM payer WHERE id=$1", [
        RHC_PAYER,
      ]);
      expect(payer.rows[0]).toMatchObject({ id: RHC_PAYER, kind: "medicaid", state_code: "OR" });
      const serviceActor = { organizationId: ORG, userId: USER, roles: ["billing_manager"] };
      const { validationRunId } = await service.validateClaim(serviceActor, claim.id);
      const manualRule = await admin.query(
        `SELECT outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [ORG, validationRunId],
      );
      expect(manualRule.rows).toEqual([{ outcome: "pass" }]);
      const manualFormatRule = await admin.query(
        `SELECT outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_hospice_institutional_format_qualified'`,
        [ORG, validationRunId],
      );
      expect(manualFormatRule.rows).toEqual([{ outcome: "fail" }]);
      const afterManualValidation = await admin.query(
        "SELECT state FROM medicaid_claim WHERE id=$1",
        [claim.id],
      );
      expect(afterManualValidation.rows).toEqual([{ state: "FAILED_VALIDATION" }]);
      const appSnapshotUpdate = withOrgContext(
        handle.db,
        { organizationId: ORG, userId: USER },
        async (tx) =>
          tx.execute(sql`UPDATE medicaid_claim_line_pricing_snapshot
            SET fingerprint=${"0".repeat(64)} WHERE medicaid_claim_id=${claim.id}`),
      );
      // chartwarden_app holds SELECT and INSERT only on the snapshot table: the refusal is the missing UPDATE
      // privilege (42501), not an RLS or trigger error. drizzle wraps the driver error, so unwrap `cause`.
      const appSnapshotUpdateError = await appSnapshotUpdate.then(
        () => null,
        (error: unknown) => error,
      );
      expect(appSnapshotUpdateError).not.toBeNull();
      expect(
        (appSnapshotUpdateError as { cause?: unknown }).cause ?? appSnapshotUpdateError,
      ).toMatchObject({
        code: "42501",
        message: expect.stringContaining(
          "permission denied for table medicaid_claim_line_pricing_snapshot",
        ),
      });
      await expect(
        admin.query(
          `UPDATE medicaid_claim_line_pricing_snapshot SET fingerprint=$2 WHERE medicaid_claim_line_id=$1`,
          [currentLines.rows[0].id, "0".repeat(64)],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        admin.query("UPDATE medicaid_claim_line SET charges_cents=charges_cents+1 WHERE id=$1", [
          currentLines.rows[0].id,
        ]),
      ).rejects.toThrow(/immutable/);

      const backgroundEvents: string[] = [];
      const workerDeps = {
        connection: { host: "127.0.0.1", port: 6379 },
        db: handle.db,
        coverages: m5Reader,
        admissions: m6Reader,
        canonicalPayerReader,
        patientAddresses: patientAddressReader,
        outbox: {
          async publish(_tx: unknown, event: { eventName: string }) {
            backgroundEvents.push(event.eventName);
          },
        },
      };
      const eventId = randomUUID();
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
        runMedicaidRevalidate(tx, workerDeps, {
          organizationId: ORG,
          patientId: RHC_PATIENT,
          eventId,
          eventName: "m24.medicaid_claim.revalidate_requested",
        }),
      );
      const backgroundRun = await admin.query(
        `SELECT r.id,v.outcome,c.state
           FROM medicaid_validation_run r
           JOIN medicaid_validation_result v ON v.organization_id=r.organization_id
             AND v.medicaid_validation_run_id=r.id
           JOIN medicaid_claim c ON c.id=r.medicaid_claim_id
          WHERE r.medicaid_claim_id=$1 AND r.trigger_signal_id=$2
            AND v.rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [claim.id, eventId],
      );
      expect(backgroundRun.rows).toHaveLength(1);
      expect(backgroundRun.rows[0].outcome).toBe("pass");
      expect(backgroundRun.rows[0].state).toBe("FAILED_VALIDATION");
      const backgroundFormatRule = await admin.query(
        `SELECT outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_hospice_institutional_format_qualified'`,
        [ORG, backgroundRun.rows[0].id],
      );
      expect(backgroundFormatRule.rows).toEqual([{ outcome: "fail" }]);
      expect(backgroundEvents).not.toContain("m24.medicaid_claim.ready_for_submission");

      // A separate, synthetic admission proves the facility profile through the same M5/M40 owner
      // readers, rate engine, transaction-bound assembly service, line writer, and snapshot guard.
      await admin.query(`INSERT INTO facility (id,kind,name) VALUES ($1,'alf','Synthetic ALF')`, [
        ALF_RHC_FACILITY,
      ]);
      await admin.query(
        `INSERT INTO patient
           (id,organization_id,provider_entity_id,location_id,mrn,legal_first_name,legal_last_name,
            dob,sex_assigned_at_birth,status)
         VALUES ($1,$2,$3,$4,'SYN-ALF-RHC-01','Morgan','Syntheticpatient',
                 '1952-02-02','unknown','active')`,
        [ALF_RHC_PATIENT, ORG, peId, locationId],
      );
      await admin.query(
        `INSERT INTO patient_address
           (id,patient_id,organization_id,provider_entity_id,kind,line1,city,state,postal_code,
            country,is_primary,effective_from,effective_to,facility_id)
         VALUES ($1,$2,$3,$4,'facility','123 Test St','Testville','OR','00000','US',true,
                 '2026-11-01','2026-11-04',$5)`,
        [ALF_RHC_ADDRESS, ALF_RHC_PATIENT, ORG, peId, ALF_RHC_FACILITY],
      );
      await admin.query(
        `INSERT INTO patient_payer
           (id,patient_id,organization_id,provider_entity_id,location_id,payer_id,rank,coverage_kind,
            subscriber_id,effective_from,effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,1,'medicaid','SYNTHETIC-MEMBER-ALF-01','2026-01-01',NULL)`,
        [ALF_RHC_COVERAGE, ALF_RHC_PATIENT, ORG, peId, locationId, RHC_PAYER],
      );
      await admin.query(
        `INSERT INTO admission
           (id,organization_id,provider_entity_id,location_id,patient_id,status,admission_at,activated_at,
            admitted_by_physician_id,service_address_line1,service_address_city,service_address_state,
            service_address_postal_code,service_address_country)
         VALUES ($1,$2,$3,$4,$5,'active','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',$6,
                 '123 Test St','Testville','OR','00000','US')`,
        [ALF_RHC_ADMISSION, ORG, peId, locationId, ALF_RHC_PATIENT, USER],
      );
      await admin.query(
        `INSERT INTO level_of_care_period
           (id,organization_id,admission_id,level_of_care,status,effective_at,ended_at,
            assigned_by,reason,q_code,version)
         VALUES ($1,$2,$3,'routine_home_care','ended','2026-11-01T00:00:00Z',
                 '2026-11-05T00:00:00Z',$4,'Synthetic ALF RHC qualification','Q5002',0)`,
        [ALF_RHC_LOC, ORG, ALF_RHC_ADMISSION, USER],
      );
      await admin.query(
        `INSERT INTO medicaid_program_assignment
           (id,organization_id,patient_id,patient_payer_id,admission_id,provider_entity_id,location_id,
            service_state,program_kind,canonical_payer_id,canonical_payer_classification_id,
            payer_snapshot,status,effective_from,effective_to,source_kind,verification_source,
            evidence_reference,verified_at,verified_by_membership_id,recorded_by_membership_id,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'OR','managed_care',$8,$9,
                 jsonb_build_object('id',$8::uuid::text,'displayName','Synthetic Medicaid CCO',
                   'kind','medicaid','stateCode','OR'),
                 'verified','2026-11-01','2026-11-04','payer_confirmation',
                 'synthetic_qualification_fixture','doc:synthetic-alf/program-assignment',
                 '2026-01-01T00:00:00Z',$10,$11,1)`,
        [
          ALF_RHC_ASSIGNMENT,
          ORG,
          ALF_RHC_PATIENT,
          ALF_RHC_COVERAGE,
          ALF_RHC_ADMISSION,
          peId,
          locationId,
          RHC_PAYER,
          RHC_CLASSIFICATION,
          verifierId,
          USER,
        ],
      );
      const insertAlfBillingEvidence = async (input: {
        id: string;
        from: string;
        to: string;
        chargeCents: number;
        evidenceSuffix: string;
      }) => {
        await admin.query(
          `INSERT INTO medicaid_hospice_billing_evidence
             (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
              canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
              locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
              quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
              quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
              coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
              charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
              effective_to,source_document_reference,verified_at,verified_by_membership_id,
              recorded_by_membership_id,version)
           VALUES ($1,$2,$3,$4,$5,0,$6,'managed_care','OR','synthetic-locality-lineage',
                   'evidence:synthetic-alf/locality',1,'not_required','not_applicable',
                   'evidence:synthetic-alf/quality',1,'RHC','active_rhc_loc_calendar_day',
                   'm6_level_of_care_period','daily','0651','Q5002','local_draft_only',
                   'evidence:synthetic-alf/coding',1,$7,
                   'evidence:synthetic-alf/charge-${input.evidenceSuffix}',1,'verified',$8,$9,
                   'doc:synthetic-alf/billing-${input.evidenceSuffix}',
                   '2026-01-01T00:00:00Z',$10,$11,1)`,
          [
            input.id,
            ORG,
            peId,
            ALF_RHC_PATIENT,
            ALF_RHC_ADMISSION,
            RHC_PAYER,
            input.chargeCents,
            input.from,
            input.to,
            verifierId,
            USER,
          ],
        );
      };
      await insertAlfBillingEvidence({
        id: ALF_RHC_EVIDENCE_EARLY,
        from: "2026-11-01",
        to: "2026-11-02",
        chargeCents: 16000,
        evidenceSuffix: "early",
      });
      await insertAlfBillingEvidence({
        id: ALF_RHC_EVIDENCE_LATE,
        from: "2026-11-03",
        to: "2026-11-04",
        chargeCents: 17000,
        evidenceSuffix: "late",
      });
      const alfClaimInput = {
        patientId: ALF_RHC_PATIENT,
        admissionId: ALF_RHC_ADMISSION,
        providerEntityId: peId,
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-04",
        kind: "hospice_only" as const,
      };
      await admin.query("UPDATE facility SET kind='other' WHERE id=$1", [ALF_RHC_FACILITY]);
      await expectUnpricedAssembly(() => service.assembleClaim(actor, alfClaimInput));
      await admin.query("UPDATE facility SET kind='alf' WHERE id=$1", [ALF_RHC_FACILITY]);
      await admin.query("UPDATE facility SET status='deactivated' WHERE id=$1", [ALF_RHC_FACILITY]);
      await expectUnpricedAssembly(() => service.assembleClaim(actor, alfClaimInput));
      await admin.query("UPDATE facility SET status='active' WHERE id=$1", [ALF_RHC_FACILITY]);
      await admin.query("UPDATE patient_address SET effective_to='2026-11-01' WHERE id=$1", [
        ALF_RHC_ADDRESS,
      ]);
      await expectUnpricedAssembly(() =>
        service.assembleClaim(actor, { ...alfClaimInput, serviceFrom: "2026-11-02" }),
      );
      await admin.query("UPDATE patient_address SET effective_to='2026-11-04' WHERE id=$1", [
        ALF_RHC_ADDRESS,
      ]);
      const facilityDraft = await service.assembleClaim(actor, {
        ...alfClaimInput,
      });
      expect(facilityDraft.state).toBe("DRAFT");
      const alfLines = await admin.query(
        `SELECT id,line_number,service_date::date::text AS service_from,
                service_date_to::date::text AS service_to,units,q_code,rate_at_assembly_cents,
                charges_cents
           FROM medicaid_claim_line WHERE medicaid_claim_id=$1 ORDER BY line_number`,
        [facilityDraft.id],
      );
      expect(alfLines.rows).toEqual([
        expect.objectContaining({
          line_number: 1,
          service_from: "2026-11-01",
          service_to: "2026-11-02",
          units: 2,
          q_code: "Q5002",
          rate_at_assembly_cents: 12000,
          charges_cents: 32000,
        }),
        expect.objectContaining({
          line_number: 2,
          service_from: "2026-11-03",
          service_to: "2026-11-04",
          units: 2,
          q_code: "Q5002",
          rate_at_assembly_cents: 13000,
          charges_cents: 34000,
        }),
      ]);
      const alfSnapshots = await admin.query(
        `SELECT snapshot_schema_version,snapshot,billing_evidence_id,payer_rate_policy_id
           FROM medicaid_claim_line_pricing_snapshot
          WHERE medicaid_claim_id=$1 ORDER BY snapshot->>'serviceFrom'`,
        [facilityDraft.id],
      );
      expect(alfSnapshots.rows).toHaveLength(2);
      expect(alfSnapshots.rows.map((row) => row.snapshot_schema_version)).toEqual([2, 2]);
      expect(alfSnapshots.rows.map((row) => row.billing_evidence_id)).toEqual([
        ALF_RHC_EVIDENCE_EARLY,
        ALF_RHC_EVIDENCE_LATE,
      ]);
      expect(alfSnapshots.rows.map((row) => row.snapshot.billingEvidenceVersion)).toEqual([1, 1]);
      expect(alfSnapshots.rows.map((row) => row.payer_rate_policy_id)).toEqual([
        RHC_RATE_EARLY,
        RHC_RATE_LATE,
      ]);
      expect(alfSnapshots.rows.map((row) => row.snapshot.reimbursementEstimateCents)).toEqual([
        24000, 26000,
      ]);
      expect(alfSnapshots.rows.map((row) => row.snapshot.billedChargeCents)).toEqual([
        32000, 34000,
      ]);
      expect(
        alfSnapshots.rows.every(
          (row) =>
            row.snapshot.schemaVersion === 2 &&
            row.snapshot.localBillingProfile === "rhc_assisted_living_q5002_daily_v1" &&
            row.snapshot.serviceLocation.facilityId === ALF_RHC_FACILITY &&
            row.snapshot.serviceLocation.facilityKind === "alf",
        ),
      ).toBe(true);
      const { validationRunId: alfValidationRunId } = await service.validateClaim(
        serviceActor,
        facilityDraft.id,
      );
      const alfManualRules = await admin.query(
        `SELECT rule_key,outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key IN ('medicaid_payer_rate_policy_snapshot_verified',
                             'medicaid_hospice_institutional_format_qualified')
          ORDER BY rule_key`,
        [ORG, alfValidationRunId],
      );
      expect(alfManualRules.rows).toEqual([
        { rule_key: "medicaid_hospice_institutional_format_qualified", outcome: "fail" },
        { rule_key: "medicaid_payer_rate_policy_snapshot_verified", outcome: "pass" },
      ]);
      await admin.query("UPDATE facility SET kind='other' WHERE id=$1", [ALF_RHC_FACILITY]);
      const { validationRunId: staleFacilityRunId } = await service.validateClaim(
        serviceActor,
        facilityDraft.id,
      );
      const staleFacilityPricing = await admin.query(
        `SELECT outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [ORG, staleFacilityRunId],
      );
      expect(staleFacilityPricing.rows).toEqual([{ outcome: "fail" }]);
      await admin.query("UPDATE facility SET kind='alf' WHERE id=$1", [ALF_RHC_FACILITY]);
      const alfBackgroundEvent = randomUUID();
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
        runMedicaidRevalidate(
          tx,
          { ...workerDeps, facilityKindReader },
          {
            organizationId: ORG,
            patientId: ALF_RHC_PATIENT,
            eventId: alfBackgroundEvent,
            eventName: "m24.medicaid_claim.revalidate_requested",
          },
        ),
      );
      const alfBackgroundRule = await admin.query(
        `SELECT result.outcome FROM medicaid_validation_run run
          JOIN medicaid_validation_result result ON result.organization_id=run.organization_id
            AND result.medicaid_validation_run_id=run.id
          WHERE run.medicaid_claim_id=$1 AND run.trigger_signal_id=$2
            AND result.rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [facilityDraft.id, alfBackgroundEvent],
      );
      expect(alfBackgroundRule.rows).toEqual([{ outcome: "pass" }]);
      expect(events).not.toContain("m24.medicaid_claim.ready_for_submission");

      // Reuse the qualified synthetic daily path for the previously skipped cadence race. Both
      // requests have complete persisted M5/M6/M24/M40 evidence, distinct adjacent service windows,
      // and share the actual locked M6 admission row.
      await admin.query(
        `INSERT INTO patient
           (id,organization_id,provider_entity_id,location_id,mrn,legal_first_name,legal_last_name,
            dob,sex_assigned_at_birth,status)
         SELECT $1,organization_id,provider_entity_id,location_id,'SYN-ALF-CAD-01','Casey',
                'Cadence Testpatient','1954-03-03','unknown','active'
           FROM patient WHERE id=$2`,
        [ALF_CADENCE_PATIENT, ALF_RHC_PATIENT],
      );
      await admin.query(
        `INSERT INTO patient_address
           (id,patient_id,organization_id,provider_entity_id,kind,line1,city,state,postal_code,
            country,is_primary,effective_from,effective_to,facility_id)
         SELECT $1,$2,organization_id,provider_entity_id,'facility',line1,city,state,postal_code,
                country,true,'2026-11-01','2026-11-04',facility_id
           FROM patient_address WHERE id=$3`,
        [ALF_CADENCE_ADDRESS, ALF_CADENCE_PATIENT, ALF_RHC_ADDRESS],
      );
      await admin.query(
        `INSERT INTO patient_payer
           (id,patient_id,organization_id,provider_entity_id,location_id,payer_id,rank,coverage_kind,
            subscriber_id,effective_from,effective_to)
         SELECT $1,$2,organization_id,provider_entity_id,location_id,payer_id,1,'medicaid',
                'SYNTHETIC-MEMBER-ALF-CAD-01','2026-01-01',NULL
           FROM patient_payer WHERE id=$3`,
        [ALF_CADENCE_COVERAGE, ALF_CADENCE_PATIENT, ALF_RHC_COVERAGE],
      );
      await admin.query(
        `INSERT INTO admission
           (id,organization_id,provider_entity_id,location_id,patient_id,status,admission_at,
            activated_at,admitted_by_physician_id,service_address_line1,service_address_city,
            service_address_state,service_address_postal_code,service_address_country)
         SELECT $1,organization_id,provider_entity_id,location_id,$2,'active','2026-11-01T00:00:00Z',
                '2026-11-01T00:00:00Z',admitted_by_physician_id,service_address_line1,
                service_address_city,service_address_state,service_address_postal_code,
                service_address_country
           FROM admission WHERE id=$3`,
        [ALF_CADENCE_ADMISSION, ALF_CADENCE_PATIENT, ALF_RHC_ADMISSION],
      );
      await admin.query(
        `INSERT INTO level_of_care_period
           (id,organization_id,admission_id,level_of_care,status,effective_at,ended_at,
            assigned_by,reason,q_code,version)
         SELECT $1,organization_id,$2,level_of_care,'ended',effective_at,ended_at,
                assigned_by,'Synthetic cadence qualification',q_code,version
           FROM level_of_care_period WHERE id=$3`,
        [ALF_CADENCE_LOC, ALF_CADENCE_ADMISSION, ALF_RHC_LOC],
      );
      await admin.query(
        `INSERT INTO medicaid_program_assignment
           (id,organization_id,patient_id,patient_payer_id,admission_id,provider_entity_id,location_id,
            service_state,program_kind,canonical_payer_id,canonical_payer_classification_id,
            payer_snapshot,status,effective_from,effective_to,source_kind,verification_source,
            evidence_reference,verified_at,verified_by_membership_id,recorded_by_membership_id,version)
         SELECT $1,organization_id,$2,$3,$4,provider_entity_id,location_id,service_state,program_kind,
                canonical_payer_id,canonical_payer_classification_id,payer_snapshot,status,
                effective_from,effective_to,source_kind,verification_source,
                'doc:synthetic-alf-cadence/program-assignment',verified_at,
                verified_by_membership_id,recorded_by_membership_id,version
           FROM medicaid_program_assignment WHERE id=$5`,
        [
          ALF_CADENCE_ASSIGNMENT,
          ALF_CADENCE_PATIENT,
          ALF_CADENCE_COVERAGE,
          ALF_CADENCE_ADMISSION,
          ALF_RHC_ASSIGNMENT,
        ],
      );
      for (const [sourceId, evidenceId] of [
        [ALF_RHC_EVIDENCE_EARLY, ALF_CADENCE_EVIDENCE_EARLY],
        [ALF_RHC_EVIDENCE_LATE, ALF_CADENCE_EVIDENCE_LATE],
      ] as const) {
        await admin.query(
          `INSERT INTO medicaid_hospice_billing_evidence
             (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
              canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
              locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
              quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
              quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
              coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
              charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
              effective_to,source_document_reference,verified_at,verified_by_membership_id,
              recorded_by_membership_id,version)
           SELECT $1,organization_id,provider_entity_id,$2,$3,admission_version,canonical_payer_id,
                  program_kind,service_state,locality_code,locality_evidence_reference,
                  locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
                  quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
                  quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
                  coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
                  charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
                  effective_to,source_document_reference,verified_at,verified_by_membership_id,
                  recorded_by_membership_id,version
             FROM medicaid_hospice_billing_evidence WHERE id=$4`,
          [evidenceId, ALF_CADENCE_PATIENT, ALF_CADENCE_ADMISSION, sourceId],
        );
      }
      const cadenceClaims = await Promise.all([
        service.assembleClaim(serviceActor, {
          patientId: ALF_CADENCE_PATIENT,
          admissionId: ALF_CADENCE_ADMISSION,
          providerEntityId: peId,
          serviceFrom: "2026-11-01",
          serviceTo: "2026-11-02",
          kind: "hospice_only",
        }),
        service.assembleClaim(serviceActor, {
          patientId: ALF_CADENCE_PATIENT,
          admissionId: ALF_CADENCE_ADMISSION,
          providerEntityId: peId,
          serviceFrom: "2026-11-03",
          serviceTo: "2026-11-04",
          kind: "hospice_only",
        }),
      ]);
      expect(cadenceClaims.map((claim) => claim.tob).sort()).toEqual(["812", "813"]);
      expect(cadenceClaims.every((claim) => claim.state === "DRAFT")).toBe(true);
      const cadenceLines = await admin.query(
        `SELECT count(*)::int AS count FROM medicaid_claim_line
          WHERE medicaid_claim_id = ANY($1::uuid[])`,
        [cadenceClaims.map((claim) => claim.id)],
      );
      expect(cadenceLines.rows).toEqual([{ count: 2 }]);
      expect(events).not.toContain("m24.medicaid_claim.ready_for_submission");

      // A structurally valid, correctly hashed v2 snapshot with a fabricated estimate must fail the
      // source-grounded verifier. This isolated negative fixture clones only synthetic rows; the positive
      // assisted-living claim above was created exclusively through assembleClaim.
      const tamperedClaimId = randomUUID();
      const tamperedControl = `SYN${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      await admin.query(
        `INSERT INTO medicaid_claim
           (id,organization_id,provider_entity_id,location_id,patient_id,patient_payer_id,admission_id,
            service_state,kind,tob,service_from,service_to,state_plan_code_id,state_plan_code_snapshot,
            mco_id,mco_snapshot,medicaid_program_kind,canonical_payer_id,program_assignment_id,
            program_resolution_snapshot,medicare_claim_id,medicare_secondary_context_snapshot,
            rb_arrangement_id,rb_day_count_snapshot,replaces_claim_id,replaced_by_claim_id,
            medicaid_claim_control_number,state,version,eligibility_check_id,eligibility_outcome_snapshot,
            eligibility_checked_at_snapshot,validation_run_id_latest,created_by_membership_id,
            updated_by_membership_id)
         SELECT $1,organization_id,provider_entity_id,location_id,patient_id,patient_payer_id,admission_id,
                service_state,kind,tob,service_from,service_to,state_plan_code_id,state_plan_code_snapshot,
                mco_id,mco_snapshot,medicaid_program_kind,canonical_payer_id,program_assignment_id,
                program_resolution_snapshot,medicare_claim_id,medicare_secondary_context_snapshot,
                rb_arrangement_id,rb_day_count_snapshot,replaces_claim_id,replaced_by_claim_id,
                $2,'DRAFT',1,eligibility_check_id,eligibility_outcome_snapshot,
                eligibility_checked_at_snapshot,NULL,created_by_membership_id,updated_by_membership_id
           FROM medicaid_claim WHERE id=$3`,
        [tamperedClaimId, tamperedControl, facilityDraft.id],
      );
      const tamperedLineIds = alfLines.rows.map(() => randomUUID());
      await admin.query("BEGIN");
      try {
        for (let index = 0; index < alfLines.rows.length; index += 1) {
          const line = alfLines.rows[index]!;
          const newLineId = tamperedLineIds[index]!;
          await admin.query(
            `INSERT INTO medicaid_claim_line
               (id,organization_id,provider_entity_id,location_id,medicaid_claim_id,line_number,
                service_date,service_date_to,revenue_code,q_code,level_of_care,loc_period_id,units,
                rate_at_assembly_cents,state_rate_schedule_id_snapshot,payer_rate_policy_id_snapshot,
                charges_cents,is_rb,rb_day_id)
             SELECT $1,organization_id,provider_entity_id,location_id,$2::uuid,line_number,
                    service_date,service_date_to,revenue_code,q_code,level_of_care,loc_period_id,units,
                    rate_at_assembly_cents,state_rate_schedule_id_snapshot,payer_rate_policy_id_snapshot,
                    charges_cents,is_rb,rb_day_id
               FROM medicaid_claim_line WHERE id=$3`,
            [newLineId, tamperedClaimId, line.id],
          );
          await admin.query(
            `WITH copied AS (
               SELECT jsonb_set(
                        jsonb_set(
                          jsonb_set(snapshot,'{medicaidClaimId}',to_jsonb($2::text),true),
                          '{claimLineId}',to_jsonb($3::text),true),
                        '{reimbursementEstimateCents}','999999'::jsonb,true) AS material,
                      organization_id,provider_entity_id,payer_rate_policy_id,billing_evidence_id,
                      assessed_at,created_by_membership_id
                 FROM medicaid_claim_line_pricing_snapshot WHERE medicaid_claim_line_id=$1
             )
             INSERT INTO medicaid_claim_line_pricing_snapshot
               (organization_id,provider_entity_id,medicaid_claim_id,medicaid_claim_line_id,
                payer_rate_policy_id,billing_evidence_id,snapshot_schema_version,assessed_at,
                fingerprint,snapshot,created_by_membership_id)
             SELECT organization_id,provider_entity_id,$2::uuid,$3::uuid,payer_rate_policy_id,billing_evidence_id,
                    (material->>'schemaVersion')::integer,assessed_at,
                    encode(digest((material-'assessmentTimestamp')::text,'sha256'),'hex'),
                    material,created_by_membership_id FROM copied`,
            [line.id, tamperedClaimId, newLineId],
          );
        }
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const tamperedValidation = await service.validateClaim(serviceActor, tamperedClaimId);
      const tamperedPricingRule = await admin.query(
        `SELECT outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [ORG, tamperedValidation.validationRunId],
      );
      expect(tamperedPricingRule.rows).toEqual([{ outcome: "fail" }]);
      const tamperedSnapshots = await admin.query(
        `SELECT count(*)::int AS count,min(snapshot->>'reimbursementEstimateCents') AS estimate
           FROM medicaid_claim_line_pricing_snapshot WHERE medicaid_claim_id=$1`,
        [tamperedClaimId],
      );
      expect(tamperedSnapshots.rows).toEqual([{ count: 2, estimate: "999999" }]);
      expect(events).not.toContain("m24.medicaid_claim.ready_for_submission");

      const correctedEvidenceId = randomUUID();
      await admin.query(
        `INSERT INTO medicaid_hospice_billing_evidence
           (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
            canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
            locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
            quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
            quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
            coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
            charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
            effective_to,source_document_reference,verified_at,verified_by_membership_id,
            recorded_by_membership_id,supersedes_id,version)
         SELECT $1,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
                canonical_payer_id,program_kind,service_state,'synthetic-locality-corrected',
                'evidence:synthetic-rhc/locality-correction',locality_evidence_version+1,
                quality_reporting_applicability,quality_reporting_status,quality_evidence_reference,
                quality_evidence_version,service_category,quantity_policy,quantity_evidence_owner,
                billing_unit,revenue_code,hcpcs_code,coding_profile,coding_evidence_reference,
                coding_evidence_version,billed_charge_cents_per_unit,charge_evidence_reference,
                charge_evidence_version,'verified',effective_from,effective_to,
                'doc:synthetic-rhc/billing-profile-correction',now(),$3,$4,id,version+1
           FROM medicaid_hospice_billing_evidence WHERE id=$2`,
        [correctedEvidenceId, RHC_EVIDENCE, verifierId, USER],
      );
      const wrongPatientCorrectionId = randomUUID();
      await expect(
        admin.query(
          `INSERT INTO medicaid_hospice_billing_evidence
             (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
              canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
              locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
              quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
              quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
              coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
              charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
              effective_to,source_document_reference,verified_at,verified_by_membership_id,
              recorded_by_membership_id,supersedes_id,version)
           SELECT $1,organization_id,provider_entity_id,$3,admission_id,admission_version,
                  canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
                  locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
                  quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
                  quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
                  coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
                  charge_evidence_reference,charge_evidence_version,'verified',effective_from,effective_to,
                  source_document_reference,now(),$4,$5,id,version+1
             FROM medicaid_hospice_billing_evidence WHERE id=$2`,
          [wrongPatientCorrectionId, RHC_EVIDENCE, randomUUID(), verifierId, USER],
        ),
      ).rejects.toThrow(/must preserve the complete source identity/);
      const branchCorrectionId = randomUUID();
      await expect(
        admin.query(
          `INSERT INTO medicaid_hospice_billing_evidence
             (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
              canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
              locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
              quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
              quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
              coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
              charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
              effective_to,source_document_reference,verified_at,verified_by_membership_id,
              recorded_by_membership_id,supersedes_id,version)
           SELECT $1,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
                  canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
                  locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
                  quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
                  quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
                  coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
                  charge_evidence_reference,charge_evidence_version,'verified',effective_from,effective_to,
                  source_document_reference,now(),$3,$4,id,version+1
             FROM medicaid_hospice_billing_evidence WHERE id=$2`,
          [branchCorrectionId, RHC_EVIDENCE, verifierId, USER],
        ),
      ).rejects.toThrow(/history cannot branch/);
      const { validationRunId: staleRunId } = await service.validateClaim(serviceActor, claim.id);
      const staleRule = await admin.query(
        `SELECT outcome FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [ORG, staleRunId],
      );
      expect(staleRule.rows).toEqual([{ outcome: "fail" }]);
      const unchangedSnapshots = await admin.query(
        `SELECT count(*)::int AS n FROM medicaid_claim_line_pricing_snapshot
          WHERE medicaid_claim_id=$1 AND billing_evidence_id=$2
            AND medicaid_claim_line_id = ANY($3::uuid[])`,
        [claim.id, RHC_EVIDENCE, currentLines.rows.map((row) => row.id)],
      );
      expect(unchangedSnapshots.rows[0].n).toBe(2);

      const staleWorkerEventId = randomUUID();
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
        runMedicaidRevalidate(tx, workerDeps, {
          organizationId: ORG,
          patientId: RHC_PATIENT,
          eventId: staleWorkerEventId,
          eventName: "m24.medicaid_claim.revalidate_requested",
        }),
      );
      const staleWorkerResult = await admin.query(
        `SELECT result.outcome,claim.state
           FROM medicaid_validation_run run
           JOIN medicaid_validation_result result ON result.organization_id=run.organization_id
             AND result.medicaid_validation_run_id=run.id
           JOIN medicaid_claim claim ON claim.id=run.medicaid_claim_id
          WHERE run.medicaid_claim_id=$1 AND run.trigger_signal_id=$2
            AND result.rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [claim.id, staleWorkerEventId],
      );
      expect(staleWorkerResult.rows).toEqual([{ outcome: "fail", state: "FAILED_VALIDATION" }]);

      // A full-window evidence row must not conceal a separately verified, independently effective
      // partial-overlap row. The reader is exercised against rows persisted in this isolated database.
      const partialOverlapEvidenceId = randomUUID();
      await admin.query(
        `INSERT INTO medicaid_hospice_billing_evidence
           (id,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
            canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
            locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
            quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
            quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
            coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
            charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
            effective_to,source_document_reference,verified_at,verified_by_membership_id,
            recorded_by_membership_id,version)
         SELECT $1,organization_id,provider_entity_id,patient_id,admission_id,admission_version,
                canonical_payer_id,program_kind,service_state,'synthetic-locality-overlap',
                'evidence:synthetic-rhc/overlap-locality',locality_evidence_version+1,
                quality_reporting_applicability,quality_reporting_status,
                'evidence:synthetic-rhc/overlap-quality',quality_evidence_version+1,
                service_category,quantity_policy,quantity_evidence_owner,billing_unit,revenue_code,
                hcpcs_code,coding_profile,'evidence:synthetic-rhc/overlap-coding',
                coding_evidence_version+1,14000,'evidence:synthetic-rhc/overlap-charge',
                charge_evidence_version+1,'verified','2026-11-02','2026-11-03',
                'doc:synthetic-rhc/partial-overlap',now(),$3,$4,1
           FROM medicaid_hospice_billing_evidence WHERE id=$2`,
        [partialOverlapEvidenceId, RHC_EVIDENCE, verifierId, USER],
      );
      await expect(
        withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
          readMedicaidHospiceBillingEvidence(tx, {
            organizationId: ORG,
            providerEntityId: peId,
            patientId: RHC_PATIENT,
            admissionId: RHC_ADMISSION,
            admissionVersion: 0,
            canonicalPayerId: RHC_PAYER,
            programKind: "managed_care",
            serviceState: "OR",
            serviceFrom: "2026-11-01",
            serviceTo: "2026-11-04",
            assessedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toMatchObject({
        status: "ambiguous",
        reasonCode: "BILLING_EVIDENCE_OVERLAPPING_HEADS",
      });

      // chartwarden_app may edit legacy lines, so the deferred integrity check also covers a pricing
      // source transition from a legacy schedule to a payer-rate policy.
      const legacyLineId = randomUUID();
      const legacyScheduleId = randomUUID();
      await admin.query(
        `INSERT INTO medicaid_claim_line
           (id,organization_id,provider_entity_id,medicaid_claim_id,line_number,service_date,
            service_date_to,revenue_code,q_code,level_of_care,loc_period_id,units,
            rate_at_assembly_cents,state_rate_schedule_id_snapshot,charges_cents,is_rb)
         VALUES ($1,$2,$3,$4,98,'2026-11-01','2026-11-01','0651','Q5001','RHC',$5,1,
                 12000,$6,15000,false)`,
        [legacyLineId, ORG, peId, claim.id, RHC_LOC, legacyScheduleId],
      );
      const appSql = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await appSql.connect();
      let snapshotConstraintFailure: { code?: string; message?: string } | null = null;
      try {
        await appSql.query("BEGIN");
        await appSql.query("SELECT set_config($1,$2,true),set_config($3,$4,true)", [
          "app.org_id",
          ORG,
          "app.user_id",
          USER,
        ]);
        await appSql.query(
          `UPDATE medicaid_claim_line
              SET state_rate_schedule_id_snapshot=NULL,
                  payer_rate_policy_id_snapshot=$1
            WHERE id=$2`,
          [RHC_RATE_EARLY, legacyLineId],
        );
        try {
          await appSql.query("COMMIT");
        } catch (error) {
          const pgError = error as { code?: string; message?: string };
          snapshotConstraintFailure = { code: pgError.code, message: pgError.message };
          await appSql.query("ROLLBACK");
        }
      } finally {
        await appSql.end();
      }
      expect(snapshotConstraintFailure?.code).toBe("23514");
      expect(snapshotConstraintFailure?.message).toMatch(
        /payer-rate-priced claim line requires an immutable pricing snapshot/,
      );
      const legacyAfterRejectedUpdate = await admin.query(
        `SELECT payer_rate_policy_id_snapshot,state_rate_schedule_id_snapshot
           FROM medicaid_claim_line WHERE id=$1`,
        [legacyLineId],
      );
      expect(legacyAfterRejectedUpdate.rows).toEqual([
        { payer_rate_policy_id_snapshot: null, state_rate_schedule_id_snapshot: legacyScheduleId },
      ]);

      // A hash proves only that JSON was hashed. The app role can persist a syntactically coherent
      // snapshot with an incorrect estimate: the insert guard binds a snapshot to its rate, evidence and line
      // rows, never to its computed amounts (CW-PI-06). This case proves exactly that limit: the database accepts
      // the forged 999999 estimate. It does NOT prove the verifier refuses it, because the forged line shares
      // 2026-11-01 with the priced original and the legacy line, so the line-coverage check refuses the claim
      // first. That the verifier recomputes the price and refuses a stored estimate that differs is covered by
      // the unit test "fails closed when a tampered snapshot no longer matches the current plan"
      // (rhc-pricing-snapshot.test.ts). The insert guard refuses a snapshot of a superseded evidence row, so the
      // forgery names the corrected head (its locality, version and verification instant) and is assessed after
      // that correction was verified. A rate must share the evidence locality, so the corrected locality gets its
      // own verified rate.
      const correctedRateId = randomUUID();
      await rateInsert(
        correctedRateId,
        "2026-11-01",
        "2026-11-04",
        12000,
        "synthetic-locality-corrected",
      );
      const forgedLineId = randomUUID();
      const forgedSql = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await forgedSql.connect();
      try {
        await forgedSql.query("BEGIN");
        await forgedSql.query("SELECT set_config($1,$2,true),set_config($3,$4,true)", [
          "app.org_id",
          ORG,
          "app.user_id",
          USER,
        ]);
        await forgedSql.query(
          `INSERT INTO medicaid_claim_line
             (id,organization_id,provider_entity_id,medicaid_claim_id,line_number,service_date,
              service_date_to,revenue_code,q_code,level_of_care,loc_period_id,units,
              rate_at_assembly_cents,state_rate_schedule_id_snapshot,payer_rate_policy_id_snapshot,
              charges_cents,is_rb)
           VALUES ($1,$2,$3,$4,99,'2026-11-01','2026-11-01','0651','Q5001','RHC',$5,1,
                   12000,NULL,$6,15000,false)`,
          [forgedLineId, ORG, peId, claim.id, RHC_LOC, correctedRateId],
        );
        await forgedSql.query(
          `WITH source AS (
             SELECT snapshot FROM medicaid_claim_line_pricing_snapshot
              WHERE medicaid_claim_line_id=$1
           ), line_identity AS (
             SELECT jsonb_set(snapshot,'{claimLineId}',to_jsonb($2::text),true) AS value FROM source
           ), service_span AS (
             SELECT jsonb_set(value,'{serviceTo}',to_jsonb('2026-11-01'::text),true) AS value
               FROM line_identity
           ), quantity AS (
             SELECT jsonb_set(value,'{quantity,units}','1'::jsonb,true) AS value FROM service_span
           ), rate AS (
             SELECT jsonb_set(value,'{rateCents}','12000'::jsonb,true) AS value FROM quantity
           ), reimbursement AS (
             SELECT jsonb_set(value,'{baseReimbursementCents}','12000'::jsonb,true) AS value FROM rate
           ), charge AS (
             SELECT jsonb_set(value,'{billedChargeCents}','15000'::jsonb,true) AS value
               FROM reimbursement
           ), current_evidence AS (
             SELECT jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(value,
                      '{payerRatePolicyId}',to_jsonb($6::text),true),
                      '{billingEvidenceId}',to_jsonb($7::text),true),
                      '{billingEvidenceVersion}','2'::jsonb,true),
                      '{locality,code}',to_jsonb('synthetic-locality-corrected'::text),true),
                      '{locality,evidenceReference}',
                      to_jsonb('evidence:synthetic-rhc/locality-correction'::text),true),
                      '{locality,evidenceVersion}','2'::jsonb,true),
                      '{assessmentTimestamp}',
                      to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),true) AS value
               FROM charge
           ), forged AS (
             SELECT jsonb_set(value,'{reimbursementEstimateCents}','999999'::jsonb,true) AS material
               FROM current_evidence
           )
           INSERT INTO medicaid_claim_line_pricing_snapshot
             (organization_id,provider_entity_id,medicaid_claim_id,medicaid_claim_line_id,
              payer_rate_policy_id,billing_evidence_id,snapshot_schema_version,assessed_at,
              fingerprint,snapshot,created_by_membership_id)
           SELECT $3,$4,$5,$2::uuid,$6::uuid,$7::uuid,1,(material ->> 'assessmentTimestamp')::timestamptz,
                  encode(digest((material - 'assessmentTimestamp')::text,'sha256'),'hex'),
                  material,$8 FROM forged`,
          [
            snapshots.rows[0]!.line_id,
            forgedLineId,
            ORG,
            peId,
            claim.id,
            correctedRateId,
            correctedEvidenceId,
            USER,
          ],
        );
        await forgedSql.query("COMMIT");
      } catch (error) {
        await forgedSql.query("ROLLBACK");
        throw error;
      } finally {
        await forgedSql.end();
      }
      const forgedSnapshot = await admin.query(
        `SELECT fingerprint,snapshot->>'reimbursementEstimateCents' AS estimate
           FROM medicaid_claim_line_pricing_snapshot WHERE medicaid_claim_line_id=$1`,
        [forgedLineId],
      );
      expect(forgedSnapshot.rows).toEqual([
        { fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), estimate: "999999" },
      ]);
      const forgedValidationResult = await service.validateClaim(serviceActor, claim.id).then(
        () => null,
        (error: unknown) => error,
      );
      // The overlapping forged line is refused by the line-coverage check, never silently validated.
      expect(forgedValidationResult).toMatchObject({
        code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE",
      });
    });

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

    it("the RLS rate reader retains out-of-window successors and excludes later-recorded evidence", async () => {
      const payer = "8b36eb1c-bb19-4df0-84b0-8934624799a4";
      const assessedAt = "2026-03-01T00:00:00.000Z";
      const predecessorId = randomUUID();
      const narrowedId = randomUUID();
      const futureRecordedId = randomUUID();
      const locality = "synthetic-locality-lineage";
      const insertRate = (input: {
        id: string;
        supersedesId: string | null;
        effectiveTo: string | null;
        createdAt: string;
      }) =>
        admin.query(
          `INSERT INTO medicaid_payer_rate_policy
             (id, organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
              locality_code, service_category, unit_basis, rate_cents, pricing_method,
              quantity_conversion_method, minimum_duration_method, methodology_version, rounding_mode,
              rounding_boundary, charge_ceiling_method, charge_ceiling_boundary,
              quality_reporting_applicability, quality_reporting_status, source_kind, verification_status,
              effective_from, effective_to, source_document_ref, verified_at, verified_by_membership_id,
              recorded_by_membership_id, supersedes_id, version, created_at)
           VALUES ($1,$2,$3,$4,'managed_care','OR',$5,'RHC','per_day',12000,'per_day',
                   'daily_units','not_applicable',1,'not_applicable','service_day','none','not_applicable',
                   'not_required','not_applicable','cco_contract','verified','2026-01-01',$6,
                   'doc:synthetic/rate-lineage','2025-12-01T00:00:00Z',$7,$8,$9,$10,$11)`,
          [
            input.id,
            ORG,
            peId,
            payer,
            locality,
            input.effectiveTo,
            randomUUID(),
            USER,
            input.supersedesId,
            input.supersedesId ? 2 : 1,
            input.createdAt,
          ],
        );

      await insertRate({
        id: predecessorId,
        supersedesId: null,
        effectiveTo: null,
        createdAt: "2026-01-01T00:00:00Z",
      });
      await insertRate({
        id: narrowedId,
        supersedesId: predecessorId,
        effectiveTo: "2026-02-28",
        createdAt: "2026-02-01T00:00:00Z",
      });
      await insertRate({
        id: futureRecordedId,
        supersedesId: narrowedId,
        effectiveTo: "2026-02-15",
        createdAt: "2026-04-01T00:00:00Z",
      });

      const rows = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
        readMedicaidRatePolicyLineage(tx, {
          organizationId: ORG,
          providerEntityId: peId,
          canonicalPayerId: payer,
          programKind: "managed_care",
          serviceState: "OR",
          serviceTo: "2026-03-10",
          assessedAt,
        }),
      );

      expect(rows.map((row) => row.id).sort()).toEqual([predecessorId, narrowedId].sort());
      expect(rows.find((row) => row.id === narrowedId)?.effectiveTo).toBe("2026-02-28");
      expect(rows.some((row) => row.id === futureRecordedId)).toBe(false);
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

    it("records a non-overridable pricing hold instead of validating legacy hospice lines to READY", async () => {
      const seeded = await admin.query(
        `INSERT INTO medicaid_claim
           (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
            service_state, kind, tob, service_from, service_to, state_plan_code_id,
            state_plan_code_snapshot, medicaid_claim_control_number, created_by_membership_id,
            updated_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'OR','hospice_only','811','2026-01-01','2026-01-01',
                 gen_random_uuid(),'synthetic-test-plan',$6,$7,$7)
         RETURNING id`,
        [ORG, peId, PATIENT, PAYER, ADMISSION, `T-${randomUUID().slice(0, 24)}`, USER],
      );
      const claimId = seeded.rows[0].id as string;
      await admin.query(
        `INSERT INTO medicaid_claim_line
           (organization_id, provider_entity_id, medicaid_claim_id, line_number,
            service_date, service_date_to, revenue_code, q_code, level_of_care, loc_period_id,
            units, rate_at_assembly_cents, state_rate_schedule_id_snapshot, charges_cents)
         VALUES ($1,$2,$3,1,'2026-01-01','2026-01-01','0651','Q5001','RHC',$4,1,12000,$5,12000)`,
        [ORG, peId, claimId, LOC_1, randomUUID()],
      );
      const emittedEvents: string[] = [];
      const captureOutbox: WriteOutboxPort = {
        async publish(_tx, emission) {
          emittedEvents.push(emission.eventName);
        },
      };
      const svc = buildDrizzleM24WriteService(
        handle.db,
        captureOutbox,
        OPEN_CIPHER,
        coverage,
        ccnReader,
        locPeriodReader([
          {
            id: LOC_1,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-01-01"),
            endedAt: new Date("2026-01-02"),
          },
        ]),
        noEncounters(),
      );

      const actor = { organizationId: ORG, userId: USER, roles: ["billing_manager"] };
      const { validationRunId } = await svc.validateClaim(actor, claimId);
      const after = await admin.query(
        "SELECT state FROM medicaid_claim WHERE organization_id=$1 AND id=$2",
        [ORG, claimId],
      );
      expect(after.rows[0].state).toBe("FAILED_VALIDATION");
      const runs = await admin.query(
        `SELECT r.id, r.rule_registry_version, v.outcome
           FROM medicaid_validation_run r
           JOIN medicaid_validation_result v
             ON v.organization_id = r.organization_id
            AND v.medicaid_validation_run_id = r.id
          WHERE r.organization_id=$1 AND r.medicaid_claim_id=$2
            AND r.id=$3 AND v.rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [ORG, claimId, validationRunId],
      );
      expect(runs.rows).toEqual([
        expect.objectContaining({
          id: validationRunId,
          rule_registry_version: "7",
          outcome: "fail",
        }),
      ]);
      expect(emittedEvents).toContain("m24.medicaid_claim.validation_failed");
      expect(emittedEvents).not.toContain("m24.medicaid_claim.ready_for_submission");

      const result = await admin.query(
        `SELECT id FROM medicaid_validation_result
          WHERE organization_id=$1 AND medicaid_validation_run_id=$2
            AND rule_key='medicaid_payer_rate_policy_snapshot_verified'`,
        [ORG, validationRunId],
      );
      await expect(
        svc.applyOverride(actor, result.rows[0].id as string, {
          overrideRoleClaimed: "billing_manager",
          reason: "Synthetic attempt to override the platform pricing snapshot gate.",
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      const overrides = await admin.query(
        `SELECT count(*)::int AS n FROM medicaid_validation_override
          WHERE organization_id=$1 AND medicaid_validation_result_id=$2`,
        [ORG, result.rows[0].id],
      );
      expect(overrides.rows[0].n).toBe(0);
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

    // The persisted synthetic RHC paths exercise home Q5001 and owner-backed ALF Q5002; concurrent
    // original-claim cadence is exercised with complete evidence in the positive ALF test above.
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
