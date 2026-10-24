/**
 * Demo golden path — `POST /referrals/:id/create-patient`, proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role.
 *
 *  1. A duplicate MBI inside one org is a typed 409 (not a 500), says "possible duplicate patient", and
 *     reveals neither the existing patient nor the MBI; the same MBI in ANOTHER org still succeeds
 *     (`patient_identifier_mbi_unique` is per org).
 *  2. The actor who runs create-patient is put on the new patient's caseload (a real, audited
 *     `patient_assignment`), so the chart (`caseload_or_scope`) and the admission (`admission.scope`) open
 *     for them afterwards; a user with no assignment and no org-wide role, and another tenant, still do not.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:create-patient:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Value } from "@sinclair/typebox/value";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  ADMITTING_GRANT_MAX_AGE_DAYS,
  runAdmittingGrantExpiry,
} from "../src/modules/05-patient/jobs/admitting-grant-expiry";
import { buildM5AdmissionSitingConsumer } from "../src/modules/05-patient/outbox-consumers/m6-admission-activated";
import { applyAdmissionDischarged } from "../src/modules/05-patient/outbox-consumers/m6-admission-discharged";
import { buildM5ReferralClosedConsumer } from "../src/modules/05-patient/outbox-consumers/m6-referral-closed";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import { PatientCareTeamResponseSchema } from "../src/modules/05-patient/routes/patient-typebox";
import { createCaseloadProvider } from "../src/modules/05-patient/seams/caseload-provider";
import {
  createDrizzleCareTeamStore,
  createDrizzleCaseloadStore,
} from "../src/modules/05-patient/seams/drizzle-stores";
import { buildAdmissionAbacPredicates } from "../src/modules/06-admission/abac-predicates";
import {
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "../src/modules/06-admission/admission-route-service-db";
import { registerAdmissionSeams } from "../src/modules/06-admission/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const BYSTANDER = "44444444-4444-4444-4444-444444444444";
const ORG_B_USER = "55555555-5555-5555-5555-555555555555";
const NURSE = "66666666-6666-6666-6666-666666666666";
// A CMS-format MBI (`isValidMedicareNumber`), unique to this suite.
const MBI = "1EG4TE5MK73";

// org_admin and administrator read every chart org-wide (ADR-0090), which would mask the creator grant under test.
const NON_ORG_WIDE_ROLES = ["intake_coordinator"] as const;

const ctx = (organizationId: string, userId: string, roles: readonly string[]) => ({
  organizationId,
  userId,
  roles,
  providerEntityIds: [] as string[],
  locationIds: [] as string[],
  attributes: {} as Record<string, unknown>,
});

describe.skipIf(!DB_URL)("create-patient — duplicate MBI + creator access — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let caseloadOrScope: (c: ReturnType<typeof ctx>, patientId: string) => Promise<boolean>;
  let siteLocationId: string;
  let otherProviderEntityId: string;
  let activated: ReturnType<typeof buildM5AdmissionSitingConsumer>;
  let providerEntityId: string;
  let outboxPort: Parameters<typeof applyAdmissionDischarged>[0]["outbox"];
  let admissionScope: (c: ReturnType<typeof ctx>, admissionId: string) => Promise<boolean>;

  async function applyMigrations() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const [id, email] of [
      [CREATOR, "creator@x.test"],
      [BYSTANDER, "bystander@x.test"],
      [ORG_B_USER, "orgb@x.test"],
      [NURSE, "nurse@x.test"],
    ])
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, email]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-CPA','CPA Hospice','NPI-CPA','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    siteLocationId = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc-CPA','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id as string;
    otherProviderEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-CPB','CPB Hospice','NPI-CPB','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The REAL CaseloadProvider over `patient_assignment`, as production boot registers it.
    const caseloadStore = createDrizzleCaseloadStore(handle.db);
    registerPatientSeams({ db: handle.db, caseload: { store: caseloadStore } });
    registerAdmissionSeams({
      store: (await import("../src/modules/06-admission/index")).createDrizzleAdmissionReaderStore(
        handle.db,
      ),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
    outboxPort = {
      publish: (tx, input) => txPublisher.publish(tx, { ...input, callerModule: "m5" }),
    };
    activated = buildM5AdmissionSitingConsumer({ db: handle.db, outbox: outboxPort });
    svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox());

    const isInCaseload = createCaseloadProvider(caseloadStore).isInCaseload;
    const carePlan = buildCarePlanAbacPredicates({
      resolver: {
        loadPlan: async () => null,
        loadProblem: async () => null,
        loadVersion: async () => null,
      },
      isInCaseload,
    });
    caseloadOrScope = (c, patientId) => carePlan.caseload_or_scope!(c, { patientId });
    const admissionPredicates = buildAdmissionAbacPredicates({
      resolver: createDbAdmissionAbacResolver(handle.db),
      isInCaseload,
    });
    admissionScope = (c, admissionId) =>
      admissionPredicates["admission.scope"]!(c, { id: admissionId });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  /** A triaged referral carrying a DOB (and optionally an MBI), ready for create-patient. */
  async function triagedReferral(
    organizationId: string,
    name: string,
    medicareNumberAtReceipt?: string,
  ): Promise<{ id: string; version: number }> {
    const ref = await svc.createReferral(
      organizationId,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: CREATOR,
        patientNameAtReceipt: name,
        patientDobAtReceipt: "1950-01-01",
        ...(medicareNumberAtReceipt ? { medicareNumberAtReceipt } : {}),
        referrerName: "Dr. Referrer",
        referringDxText: "Metastatic NSCLC",
      } as never,
      CREATOR,
    );
    const triaged = await svc.triageReferral(organizationId, ref.id, "eligible", ref.version);
    return { id: ref.id, version: triaged.version };
  }

  const openAssignments = async (patientId: string) =>
    (
      await admin.query(
        "SELECT clinician_user_id, role FROM patient_assignment WHERE patient_id=$1 AND unassigned_at IS NULL",
        [patientId],
      )
    ).rows as { clinician_user_id: string; role: string }[];

  describe("duplicate MBI", () => {
    it("a second patient with the same MBI in the same org is a 409 conflict, not a 500", async () => {
      const first = await triagedReferral(ORG_A, "Alpha, Ann", MBI);
      const created = await svc.createReferralPatient(ORG_A, first.id, first.version, CREATOR);
      expect(created.patientId).toBeTruthy();

      const second = await triagedReferral(ORG_A, "Beta, Bob", MBI);
      const err = await svc
        .createReferralPatient(ORG_A, second.id, second.version, CREATOR)
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ statusCode: 409, code: "CONFLICT" });
      const message = (err as Error).message;
      expect(message.toLowerCase()).toContain("possible duplicate patient");
      // No PHI and no raw database text: not the MBI, not the existing patient's name or id.
      for (const leaked of [
        MBI,
        "Alpha",
        "Ann",
        created.patientId,
        "patient_identifier",
        "duplicate key",
      ])
        expect(message).not.toContain(leaked);
      // Nothing half-written: the loser referral has no patient, the org still has exactly one.
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM patient_identifier WHERE organization_id=$1 AND kind='mbi' AND value=$2",
        [ORG_A, MBI],
      );
      expect(rows[0].n).toBe(1);
    });

    it("the same MBI in a different org still creates a patient", async () => {
      const ref = await triagedReferral(ORG_B, "Gamma, Gus", MBI);
      const created = await svc.createReferralPatient(ORG_B, ref.id, ref.version, ORG_B_USER);
      expect(created.patientId).toBeTruthy();
    });
  });

  describe("creator access", () => {
    it("puts the creating actor on the new patient's caseload (audited, org-scoped)", async () => {
      const ref = await triagedReferral(ORG_A, "Delta, Dee");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);

      const rows = await openAssignments(patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ clinician_user_id: CREATOR, role: "admitting_staff" });
      const audited = await admin.query(
        "SELECT actor_user_id FROM audit_event WHERE resource_kind='patient_assignment' AND resource_id IS NOT NULL AND after->>'patient_id'=$1 LIMIT 1",
        [patientId],
      );
      expect(audited.rows).toHaveLength(1);
      expect(audited.rows[0]?.actor_user_id).toBe(CREATOR);
    });

    it("the creator can open the chart and the admission afterwards; a bystander and another tenant cannot", async () => {
      const ref = await triagedReferral(ORG_A, "Epsilon, Eve");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);

      // A role with no org-wide chart scope (org_admin/administrator now have it, ADR-0090) — only the grant opens the chart.
      const adminRoles = NON_ORG_WIDE_ROLES;
      expect(await caseloadOrScope(ctx(ORG_A, CREATOR, adminRoles), patientId)).toBe(true);
      expect(await caseloadOrScope(ctx(ORG_A, BYSTANDER, adminRoles), patientId)).toBe(false);
      expect(await caseloadOrScope(ctx(ORG_B, ORG_B_USER, adminRoles), patientId)).toBe(false);
      // …even a creator-id presented under the wrong tenant.
      expect(await caseloadOrScope(ctx(ORG_B, CREATOR, adminRoles), patientId)).toBe(false);

      const qualified = await svc.qualifyReferral(ORG_A, ref.id, ref.version + 1, CREATOR);
      expect(qualified.state).toBe("qualified");
      const { admissionId } = await svc.acceptReferral(
        ORG_A,
        ref.id,
        { primaryDiagnosisIcd10: "C34.90", patientId },
        qualified.version,
        CREATOR,
      );
      // `clinical_supervisor` may open an UNSITED admission without an assignment (the widened allowlist);
      // an RN with no assignment may not; the creator's assignment still opens it for any role.
      const supervisor = ["clinical_supervisor"];
      expect(await admissionScope(ctx(ORG_A, CREATOR, ["rn"]), admissionId)).toBe(true);
      expect(await admissionScope(ctx(ORG_A, BYSTANDER, supervisor), admissionId)).toBe(true);
      expect(await admissionScope(ctx(ORG_A, BYSTANDER, ["rn"]), admissionId)).toBe(false);
      expect(await admissionScope(ctx(ORG_A, BYSTANDER, ["compliance_officer"]), admissionId)).toBe(
        false,
      );
      expect(await admissionScope(ctx(ORG_B, ORG_B_USER, supervisor), admissionId)).toBe(false);
    });

    it("the clinician who starts the admission is put on the caseload too, even when someone else created the patient", async () => {
      const ref = await triagedReferral(ORG_A, "Kappa, Kai");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      const qualified = await svc.qualifyReferral(ORG_A, ref.id, ref.version + 1, CREATOR);
      expect(await caseloadOrScope(ctx(ORG_A, NURSE, ["rn"]), patientId)).toBe(false);

      const { admissionId } = await svc.acceptReferral(
        ORG_A,
        ref.id,
        { primaryDiagnosisIcd10: "C34.90", patientId },
        qualified.version,
        NURSE,
      );

      const holders = (await openAssignments(patientId)).map((r) => r.clinician_user_id).sort();
      expect(holders).toEqual([CREATOR, NURSE].sort());
      expect(await caseloadOrScope(ctx(ORG_A, NURSE, ["rn"]), patientId)).toBe(true);
      expect(await admissionScope(ctx(ORG_A, NURSE, ["rn"]), admissionId)).toBe(true);
      expect(await caseloadOrScope(ctx(ORG_A, BYSTANDER, ["rn"]), patientId)).toBe(false);
      expect(await caseloadOrScope(ctx(ORG_B, NURSE, ["rn"]), patientId)).toBe(false);
    });

    it("a conversion that is refused grants nothing", async () => {
      const ref = await triagedReferral(ORG_A, "Lambda, Lou");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);

      // The referral is triaged but not qualified, so conversion throws.
      await expect(
        svc.acceptReferral(
          ORG_A,
          ref.id,
          { primaryDiagnosisIcd10: "C34.90", patientId },
          ref.version + 1,
          NURSE,
        ),
      ).rejects.toThrow();

      expect((await openAssignments(patientId)).map((r) => r.clinician_user_id)).toEqual([CREATOR]);
    });

    it("converting a referral bound to an EXISTING patient grants nothing (confirm-patient is not a way into a chart)", async () => {
      const first = await triagedReferral(ORG_A, "Mu, Mae");
      const victim = await svc.createReferralPatient(ORG_A, first.id, first.version, CREATOR);
      const ref = await triagedReferral(ORG_A, "Nu, Nell");
      const bound = await svc.confirmReferralPatient(
        ORG_A,
        ref.id,
        victim.patientId,
        ref.version,
        NURSE,
      );
      const qualified = await svc.qualifyReferral(ORG_A, ref.id, bound.version, NURSE);

      await svc.acceptReferral(
        ORG_A,
        ref.id,
        { primaryDiagnosisIcd10: "C34.90", patientId: victim.patientId },
        qualified.version,
        NURSE,
      );

      expect((await openAssignments(victim.patientId)).map((r) => r.clinician_user_id)).toEqual([
        CREATOR,
      ]);
      expect(await caseloadOrScope(ctx(ORG_A, NURSE, ["rn"]), victim.patientId)).toBe(false);
    });

    it("admitting_staff is an access grant only: excluded from the care-team roster, still in the caseload", async () => {
      const ref = await triagedReferral(ORG_A, "Theta, Tia");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,'rn',CURRENT_DATE)`,
        [patientId, ORG_A, BYSTANDER],
      );

      const roster = await createDrizzleCareTeamStore(handle.db).listMembers(ORG_A, patientId);

      expect(roster).toEqual([BYSTANDER]);
      expect(await caseloadOrScope(ctx(ORG_A, CREATOR, NON_ORG_WIDE_ROLES), patientId)).toBe(true);
    });

    it("activation ends the grant: a non-clinical creator loses the chart, an assigned RN keeps it", async () => {
      const ref = await triagedReferral(ORG_A, "Iota, Ivy");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,'rn',CURRENT_DATE)`,
        [patientId, ORG_A, BYSTANDER],
      );
      const admissionId = (
        await admin.query(
          `INSERT INTO admission (organization_id, patient_id, provider_entity_id, status, activated_at)
           VALUES ($1,$2,$3,'active',now()) RETURNING id`,
          [ORG_A, patientId, providerEntityId],
        )
      ).rows[0].id as string;
      expect(await caseloadOrScope(ctx(ORG_A, CREATOR, NON_ORG_WIDE_ROLES), patientId)).toBe(true);

      const event = {
        organizationId: ORG_A,
        payload: { admissionId, patientId },
      };
      await activated.handle(event);
      await activated.handle(event); // redelivery: no-op

      expect(await caseloadOrScope(ctx(ORG_A, CREATOR, NON_ORG_WIDE_ROLES), patientId)).toBe(false);
      expect(await caseloadOrScope(ctx(ORG_A, BYSTANDER, ["rn"]), patientId)).toBe(true);
      const open = await openAssignments(patientId);
      expect(open.map((r) => r.role)).toEqual(["rn"]);
    });

    it("the grant also ends when the admission siting cannot be resolved (early-return path)", async () => {
      const ref = await triagedReferral(ORG_A, "Lambda, Lou");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      expect(await caseloadOrScope(ctx(ORG_A, CREATOR, NON_ORG_WIDE_ROLES), patientId)).toBe(true);

      // No such admission: the reader finds no siting row, and the consumer used to return before ending it.
      await activated.handle({
        organizationId: ORG_A,
        payload: { admissionId: "99999999-9999-4999-8999-999999999999", patientId },
      });

      expect(await caseloadOrScope(ctx(ORG_A, CREATOR, NON_ORG_WIDE_ROLES), patientId)).toBe(false);
    });

    it("the care-team read names each member and hides the access grant", async () => {
      const ref = await triagedReferral(ORG_A, "Kappa, Kim");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      await admin.query(
        `INSERT INTO membership (organization_id, user_id, status) VALUES ($1,$2,'suspended')
         ON CONFLICT DO NOTHING`,
        [ORG_A, BYSTANDER],
      );
      await admin.query(`UPDATE "user" SET name='Bea Bystander' WHERE id=$1`, [BYSTANDER]);
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,'rn',CURRENT_DATE)`,
        [patientId, ORG_A, BYSTANDER],
      );
      const routeSvc = createDbPatientRouteService(handle.db);

      const team = await routeSvc.getCareTeam(ORG_A, patientId);

      expect(team?.assignments).toHaveLength(1);
      expect(team?.assignments[0]).toMatchObject({
        clinicianUserId: BYSTANDER,
        displayName: "Bea Bystander",
      });
      expect(Value.Check(PatientCareTeamResponseSchema, team)).toBe(true);
      expect(JSON.stringify(team)).not.toContain("bystander@x.test");
    });

    it("the grant is idempotent: re-granting an already-assigned actor adds no second row", async () => {
      const ref = await triagedReferral(ORG_A, "Zeta, Zed");
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      const { ensureAdmittingAssignment } = await import(
        "../src/modules/05-patient/assignments-db"
      );
      await withOrgContext<DbClient, void>(
        handle.db,
        { organizationId: ORG_A, userId: CREATOR },
        async (tx) => {
          await ensureAdmittingAssignment(tx, {
            organizationId: ORG_A,
            patientId,
            userId: CREATOR,
          });
          await ensureAdmittingAssignment(tx, {
            organizationId: ORG_A,
            patientId,
            userId: CREATOR,
          });
        },
      );
      expect(await openAssignments(patientId)).toHaveLength(1);
    });
  });

  describe("site stamped at creation", () => {
    const admissionFor = async (
      site: { providerEntityId: string; locationId: string | null } | undefined,
    ) => {
      const ref = await triagedReferral(ORG_A, `Site, ${Math.random().toString(36).slice(2, 7)}`);
      const { patientId } = await svc.createReferralPatient(
        ORG_A,
        ref.id,
        ref.version,
        CREATOR,
        site,
      );
      const qualified = await svc.qualifyReferral(ORG_A, ref.id, ref.version + 1, CREATOR);
      const { admissionId } = await svc.acceptReferral(
        ORG_A,
        ref.id,
        { primaryDiagnosisIcd10: "C34.90", patientId },
        qualified.version,
        CREATOR,
      );
      return { patientId, admissionId };
    };
    const supervisorAt = (providerEntityIds: string[], locationIds: string[]) => ({
      ...ctx(ORG_A, BYSTANDER, ["clinical_supervisor"]),
      providerEntityIds,
      locationIds,
    });

    it("stamps the creator's single site on the patient and a same-site supervisor can open the admission", async () => {
      const { patientId, admissionId } = await admissionFor({
        providerEntityId: providerEntityId,
        locationId: siteLocationId,
      });

      const chart = await admin.query(
        "SELECT provider_entity_id, location_id FROM patient WHERE id=$1",
        [patientId],
      );
      expect(chart.rows[0]).toEqual({
        provider_entity_id: providerEntityId,
        location_id: siteLocationId,
      });
      expect(
        await admissionScope(supervisorAt([providerEntityId], [siteLocationId]), admissionId),
      ).toBe(true);
    });

    it("a supervisor scoped to another site cannot open it", async () => {
      const { admissionId } = await admissionFor({
        providerEntityId: providerEntityId,
        locationId: siteLocationId,
      });
      expect(await admissionScope(supervisorAt([otherProviderEntityId], []), admissionId)).toBe(
        false,
      );
    });

    it("an org-wide creator leaves the patient unsited, so a site-scoped supervisor cannot open it", async () => {
      const { patientId, admissionId } = await admissionFor(undefined);
      const chart = await admin.query(
        "SELECT provider_entity_id, location_id FROM patient WHERE id=$1",
        [patientId],
      );
      expect(chart.rows[0]).toEqual({ provider_entity_id: null, location_id: null });
      expect(
        await admissionScope(supervisorAt([providerEntityId], [siteLocationId]), admissionId),
      ).toBe(false);
    });
  });

  describe("the grant ends on every terminal path", () => {
    const createGrantedPatient = async (name: string): Promise<string> => {
      const ref = await triagedReferral(ORG_A, name);
      const { patientId } = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,'rn',CURRENT_DATE)`,
        [patientId, ORG_A, BYSTANDER],
      );
      return patientId;
    };
    const expectOnlyRnOpen = async (patientId: string) =>
      expect((await openAssignments(patientId)).map((r) => r.role)).toEqual(["rn"]);

    it("a discharge ends it (and leaves the RN's assignment alone)", async () => {
      const patientId = await createGrantedPatient("Mu, Max");
      const admissionId = (
        await admin.query(
          `INSERT INTO admission (organization_id, patient_id, provider_entity_id, status)
           VALUES ($1,$2,$3,'discharged') RETURNING id`,
          [ORG_A, patientId, providerEntityId],
        )
      ).rows[0].id as string;

      await applyAdmissionDischarged(
        { db: handle.db, outbox: outboxPort },
        { organizationId: ORG_A, payload: { admissionId, reason: "other" } },
      );

      await expectOnlyRnOpen(patientId);
    });

    it("a referral decline / duplicate / withdrawal event ends it; one without a patient is a no-op", async () => {
      const consumer = buildM5ReferralClosedConsumer({ db: handle.db });
      expect(consumer.eventTypes).toEqual([
        "m6.referral.declined",
        "m6.referral.duplicate",
        "m6.referral.withdrawn",
      ]);
      const patientId = await createGrantedPatient("Nu, Ned");

      await consumer.handle({ organizationId: ORG_A, payload: { referralId: "r1" } });
      expect(await openAssignments(patientId)).toHaveLength(2);
      await consumer.handle({ organizationId: ORG_A, payload: { referralId: "r1", patientId } });
      await consumer.handle({ organizationId: ORG_A, payload: { referralId: "r1", patientId } });

      await expectOnlyRnOpen(patientId);
    });

    it("M6 puts the patient id on the declined / duplicate / withdrawn events it emits", async () => {
      const eventPayload = async (referralId: string, type: string) =>
        (
          await admin.query(
            "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
            [referralId, type],
          )
        ).rows[0]?.payload as { patientId?: string } | undefined;
      const withPatient = async (name: string) => {
        const ref = await triagedReferral(ORG_A, name);
        const created = await svc.createReferralPatient(ORG_A, ref.id, ref.version, CREATOR);
        return { id: ref.id, version: created.version, patientId: created.patientId };
      };

      const declined = await withPatient("Xi, Xan");
      await svc.declineReferral(ORG_A, declined.id, "capacity", declined.version);
      const dup = await withPatient("Omicron, Oz");
      await svc.markReferralDuplicate(ORG_A, dup.id, "same", dup.version, CREATOR);
      const withdrawn = await withPatient("Pi, Pat");
      await svc.withdrawReferral(ORG_A, withdrawn.id, "family request", withdrawn.version, CREATOR);

      expect((await eventPayload(declined.id, "m6.referral.declined"))?.patientId).toBe(
        declined.patientId,
      );
      expect((await eventPayload(dup.id, "m6.referral.duplicate"))?.patientId).toBe(dup.patientId);
      expect((await eventPayload(withdrawn.id, "m6.referral.withdrawn"))?.patientId).toBe(
        withdrawn.patientId,
      );
    });

    it("withdrawing an already withdrawn or declined referral is refused and emits nothing more", async () => {
      const countWithdrawn = async (referralId: string) =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m6.referral.withdrawn'",
            [referralId],
          )
        ).rows[0].n as number;
      const w = await triagedReferral(ORG_A, "Sigma, Sol");
      const first = await svc.withdrawReferral(ORG_A, w.id, "family request", w.version, CREATOR);

      await expect(
        svc.withdrawReferral(ORG_A, w.id, "again", first.version, CREATOR),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await countWithdrawn(w.id)).toBe(1);

      const d = await triagedReferral(ORG_A, "Tau, Tia");
      const declined = await svc.declineReferral(ORG_A, d.id, "capacity", d.version);
      await expect(
        svc.withdrawReferral(ORG_A, d.id, "late", declined.version, CREATOR),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await countWithdrawn(d.id)).toBe(0);
    });

    it("expiry ends a grant older than 14 days, keeps a younger one, and leaves RN assignments alone", async () => {
      const patientId = await createGrantedPatient("Rho, Rae");
      const orgs = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
      const dayMs = 24 * 3600 * 1000;

      await runAdmittingGrantExpiry({
        db: handle.db,
        activeOrgs: orgs,
        now: () => new Date(Date.now() + 3 * dayMs),
      });
      expect(await openAssignments(patientId)).toHaveLength(2);

      const later = new Date(Date.now() + (ADMITTING_GRANT_MAX_AGE_DAYS + 1) * dayMs);
      await runAdmittingGrantExpiry({ db: handle.db, activeOrgs: orgs, now: () => later });
      await runAdmittingGrantExpiry({ db: handle.db, activeOrgs: orgs, now: () => later });

      await expectOnlyRnOpen(patientId);
    });
  });
});
