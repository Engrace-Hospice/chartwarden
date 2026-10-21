/**
 * 42 CFR 418.26(b) discharge order (FY 2027, effective 2026-10-01) + 42 CFR 418.25(a) admission recommendation
 * (FY 2026, effective 2025-10-01), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Proves the PRODUCTION PhysicianAuthorityPort (`createDbPhysicianAuthority` — M3 role grants through the GAP-022
 * reader, M5 `patient_assignment` through M5's care-team reader) decides the signer matrix against real rows:
 * the medical director, the physician designee (`hospice_physician`) and THIS patient's IDG physician (MD/DO with
 * an open `md` assignment) sign; another team's IDG physician, the attending (`attending_clinician`) and an NP
 * (even seated `md`) do not. Also: the order and the for-cause cosigner name/NPI are persisted (migration 0388),
 * the all-or-none CHECK holds, the recommendation lands on `admission` (0389) and completes the readiness item,
 * the legacy pre-2026-10-01 rule, and cross-tenant RLS on the new read.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-1111111126b0";
const ORG_B = "22222222-2222-2222-2222-2222222226b0";
const USER = "33333333-3333-3333-3333-3333333326b0"; // intake / filing user (no physician role)
const MED_DIRECTOR = "55555555-5555-5555-5555-5555555526b1";
const DESIGNEE = "55555555-5555-5555-5555-5555555526b2";
const IDG_MD = "55555555-5555-5555-5555-5555555526b3";
const OTHER_TEAM_MD = "55555555-5555-5555-5555-5555555526b4";
const ATTENDING = "55555555-5555-5555-5555-5555555526b5";
const NP = "55555555-5555-5555-5555-5555555526b6";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-8888888826b0";

const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};
const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;
const today = (): string => new Date().toISOString().slice(0, 10);

describe.skipIf(!DB_URL)("418.25(a) / 418.26(b) physician signer set, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  const otherPatient = randomUUID();

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "report_writer"])
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  /** Seat `userId` on `patientId`'s care team in `role` (an open M5 assignment). */
  async function assign(patientId: string, userId: string, role: string) {
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,current_date)`,
      [patientId, ORG_A, userId, role],
    );
  }

  /** The full §418 activation ceremony through production writes; returns the active admission. */
  async function activeAdmission(patientId = randomUUID()) {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MED_DIRECTOR,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periodId = (await svc.listElectionPeriods(ORG_A, admissionId))?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MED_DIRECTOR,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    // The 418.25(a) item is advisory (D19): activation proceeds without it.
    await svc.activateAdmission(ORG_A, admissionId, nor.version);
    // Care team: this patient's IDG physician, its attending, and an NP seated in the `md` role.
    await assign(patientId, IDG_MD, "md");
    await assign(patientId, ATTENDING, "attending_clinician");
    await assign(patientId, NP, "md");
    return { admissionId, patientId };
  }

  const moved = (signer?: string, dischargeDate = today()) => ({
    reason: "moved_out_of_service_area" as const,
    dischargeDate,
    narrative: "relocated out of the service area",
    ...(signer ? { dischargeOrder: dischargeOrderBy(signer) } : {}),
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'org-pa-a','A','A'), ($2,'org-pa-b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES
         ($1,'pa-user@x.test','Intake User'), ($2,'pa-md@x.test','Dr. Director'),
         ($3,'pa-des@x.test','Dr. Designee'), ($4,'pa-idg@x.test','Dr. Team'),
         ($5,'pa-oth@x.test','Dr. Other'),    ($6,'pa-att@x.test','Dr. Attending'),
         ($7,'pa-np@x.test','Nurse Practitioner')`,
      [USER, MED_DIRECTOR, DESIGNEE, IDG_MD, OTHER_TEAM_MD, ATTENDING, NP],
    );
    await seedPhysicianRole(admin, ORG_A, MED_DIRECTOR, "medical_director");
    await seedPhysicianRole(admin, ORG_A, DESIGNEE, "hospice_physician");
    await seedPhysicianRole(admin, ORG_A, IDG_MD, "md");
    await seedPhysicianRole(admin, ORG_A, OTHER_TEAM_MD, "md");
    await seedPhysicianRole(admin, ORG_A, ATTENDING, "md");
    await seedPhysicianRole(admin, ORG_A, NP, "np");
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);
    svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox(), undefined, {
      async belongsToOrg(organizationId: string, providerEntityId: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    });
    // OTHER_TEAM_MD is the IDG physician of a DIFFERENT patient.
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1,$2,'MRN-OTHER-PA','Other','Patient','1950-01-01','F','active')`,
      [otherPatient, ORG_A],
    );
    await assign(otherPatient, OTHER_TEAM_MD, "md");
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("418.26(b) — route 39 discharge order", () => {
    it("refuses a live discharge dated today without an order", async () => {
      const { admissionId } = await activeAdmission();
      await expect(svc.discharge(ORG_A, admissionId, moved(), USER)).rejects.toMatchObject({
        code: "DISCHARGE_ORDER_REQUIRED",
      });
    });

    it.each([
      ["medical director", MED_DIRECTOR, "medical_director"],
      ["physician designee", DESIGNEE, "physician_designee"],
      ["this patient's IDG physician", IDG_MD, "idg_physician_member"],
    ])("accepts an order signed by the %s and persists it", async (_label, signer, capacity) => {
      const { admissionId } = await activeAdmission();
      const res = await svc.discharge(ORG_A, admissionId, moved(signer), USER);
      expect(res.state).toBe("completed");
      const { rows } = await admin.query(
        `SELECT discharge_order_signed_by_user_id AS by, discharge_order_signer_capacity AS cap,
                discharge_order_signed_at AS at, discharge_order_text AS text
           FROM discharge_event WHERE id=$1`,
        [res.id],
      );
      expect(rows[0]).toMatchObject({ by: signer, cap: capacity });
      expect(rows[0].at).not.toBeNull();
      const read = await svc.getDischargeOrder(ORG_A, admissionId);
      expect(read?.discharge?.order?.capacity).toBe(capacity);
    });

    it.each([
      ["another team's IDG physician", OTHER_TEAM_MD],
      ["the attending", ATTENDING],
      ["an NP seated in the md role", NP],
      ["a user with no physician role", USER],
    ])("rejects an order signed by %s", async (_label, signer) => {
      const { admissionId } = await activeAdmission();
      await expect(svc.discharge(ORG_A, admissionId, moved(signer), USER)).rejects.toMatchObject({
        code: "PHYSICIAN_SIGNER_INVALID",
      });
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM discharge_event WHERE admission_id=$1",
        [admissionId],
      );
      expect(rows[0].n).toBe(0);
    });

    it("keeps the legacy rule for a discharge dated before 2026-10-01", async () => {
      const { admissionId } = await activeAdmission();
      const res = await svc.discharge(ORG_A, admissionId, moved(undefined, "2026-09-15"), USER);
      expect(res.state).toBe("completed");
      const read = await svc.getDischargeOrder(ORG_A, admissionId);
      expect(read?.discharge).toMatchObject({ orderRequired: false, order: null });
    });

    it("the all-or-none CHECK refuses a half-recorded order", async () => {
      const { admissionId } = await activeAdmission();
      await expect(
        admin.query(
          `INSERT INTO discharge_event (organization_id, admission_id, discharge_type, effective_at,
             discharge_order_signed_by_user_id)
           VALUES ($1,$2,'other',current_date,$3)`,
          [ORG_A, admissionId, MED_DIRECTOR],
        ),
      ).rejects.toThrow(/discharge_event_order_all_or_none/);
    });
  });

  describe("418.26(b) — the for-cause cosign is the order", () => {
    it("persists the IDG physician cosigner's name/NPI and the order capacity", async () => {
      const { admissionId } = await activeAdmission();
      const filed = await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "for_cause",
          dischargeDate: today(),
          narrative: "documented safety threat to staff",
          forCauseReason: "repeated credible threats of violence to visiting nurses",
        },
        USER,
      );
      const done = await svc.cosignDischarge(
        ORG_A,
        filed.id,
        { cosignerName: "Dr. Team", cosignerNpi: "1234567893", actorRoleKeys: ["md"] },
        filed.version,
        IDG_MD,
      );
      expect(done.state).toBe("completed");
      const read = await svc.getDischargeOrder(ORG_A, admissionId);
      expect(read?.discharge?.cosigner).toMatchObject({ name: "Dr. Team", npi: "1234567893" });
      expect(read?.discharge?.order).toMatchObject({
        signedByUserId: IDG_MD,
        capacity: "idg_physician_member",
        signedByName: "Dr. Team",
      });
    });

    it("rejects the attending as cosigner", async () => {
      const { admissionId } = await activeAdmission();
      const filed = await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "for_cause",
          dischargeDate: today(),
          narrative: "documented safety threat to staff",
          forCauseReason: "repeated credible threats of violence to visiting nurses",
        },
        USER,
      );
      await expect(
        svc.cosignDischarge(
          ORG_A,
          filed.id,
          { cosignerName: "Dr. Attending", cosignerNpi: "1234567893", actorRoleKeys: ["md"] },
          filed.version,
          ATTENDING,
        ),
      ).rejects.toMatchObject({ code: "PHYSICIAN_SIGNER_INVALID" });
    });
  });

  describe("418.25(a) — admission recommendation", () => {
    it("records the IDG physician's recommendation and completes the readiness item", async () => {
      const { admissionId } = await activeAdmission();
      const before = await svc.getAdmission(ORG_A, admissionId);
      expect(
        before?.readiness?.requirements.find((r) => r.code === "admission_recommendation"),
      ).toMatchObject({ status: "action_required", blocking: false });
      await svc.recordAdmissionRecommendation(
        ORG_A,
        admissionId,
        {
          recommendedByUserId: IDG_MD,
          recommendedAt: new Date(Date.now() - 60_000).toISOString(),
          attendingConsulted: true,
        },
        Number(before?.version),
        USER,
      );
      const after = await svc.getAdmission(ORG_A, admissionId);
      expect(after?.admissionRecommendation).toMatchObject({
        recommendedByUserId: IDG_MD,
        capacity: "idg_physician_member",
        attendingConsulted: true,
      });
      expect(
        after?.readiness?.requirements.find((r) => r.code === "admission_recommendation")?.status,
      ).toBe("complete");
    });

    it("rejects the attending and an NP as recommenders", async () => {
      const { admissionId } = await activeAdmission();
      const adm = await svc.getAdmission(ORG_A, admissionId);
      for (const by of [ATTENDING, NP]) {
        await expect(
          svc.recordAdmissionRecommendation(
            ORG_A,
            admissionId,
            {
              recommendedByUserId: by,
              recommendedAt: new Date().toISOString(),
              attendingConsulted: true,
            },
            Number(adm?.version),
            USER,
          ),
        ).rejects.toMatchObject({ code: "PHYSICIAN_SIGNER_INVALID" });
      }
    });

    it("lists only this patient's eligible signers, with capacities", async () => {
      const { admissionId } = await activeAdmission();
      const list = await svc.listPhysicianSigners(ORG_A, admissionId);
      const byId = new Map(list?.items.map((c) => [c.userId, c.capacities]));
      expect(byId.get(MED_DIRECTOR)).toEqual(["medical_director"]);
      expect(byId.get(DESIGNEE)).toEqual(["physician_designee"]);
      expect(byId.get(IDG_MD)).toEqual(["idg_physician_member"]);
      expect(byId.has(OTHER_TEAM_MD)).toBe(false);
      expect(byId.has(ATTENDING)).toBe(false);
      expect(byId.has(NP)).toBe(false);
    });
  });

  it("cross-tenant: org B cannot read org A's discharge order (RLS)", async () => {
    const { admissionId } = await activeAdmission();
    await svc.discharge(ORG_A, admissionId, moved(MED_DIRECTOR), USER);
    expect(await svc.getDischargeOrder(ORG_B, admissionId)).toBeNull();
    expect(await svc.listPhysicianSigners(ORG_B, admissionId)).toBeNull();
  });
});
