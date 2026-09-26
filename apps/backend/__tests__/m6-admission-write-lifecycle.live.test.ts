/**
 * M6L-T02 — the Drizzle referral + admission WRITE lifecycle, proven against real Postgres.
 *
 * Drives the production `createDbAdmissionRouteService` writes as the NOBYPASSRLS `wardenx_app` role,
 * asserting the referral intake state machine (received → under_review → qualified → converted, which
 * mints the admission draft) and the admission's (pending → NOR ack → activate), optimistic concurrency (stale `ifVersion` → 409), the §2.5 side effects (the 4 compliance
 * windows the createAdmission cascade opens, the NOR window it closes, `activated_at`), the R-AC-01
 * activation gate, and cross-tenant denial through the service.
 *
 * Gated on a live DB: WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:write:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const PATIENT2 = "66666666-6666-6666-6666-666666666666"; // distinct: one open admission per patient (§2.3.1)
const PHYSICIAN = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M6 Drizzle write lifecycle — LIVE Postgres (M6L-T02)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let providerEntityId: string;
  let locationId: string;

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

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6w@x.test')`, [USER]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-M6W','M6W Hospice','NPI-M6W','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    locationId = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc-M6W','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id as string;
    // Real M5 patients: conversion confirms the referral's resolved patient through M5's
    // PatientIntakeResolver, and activation readiness asks M5's PatientAdmissionClearanceReader.
    for (const [id, mrn] of [
      [PATIENT, "MRN-M6W-1"],
      [PATIENT2, "MRN-M6W-2"],
    ]) {
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
           legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,$5,'Test','Patient','1950-01-01','F','active')`,
        [id, ORG_A, providerEntityId, locationId, mrn],
      );
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    // The M5 seams production boot registers (src/index.ts → registerPatientSeams) over the same
    // Drizzle adapters: PatientIntakeResolver (convertReferral) + PatientAdmissionClearanceReader
    // (activation readiness's privacy gate).
    registerPatientSeams({ db: handle.db });
    svc = createDbAdmissionRouteService(handle.db); // NOOP outbox — this suite asserts state + effects
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  /**
   * Drive a referral to `qualified` (version 2): triage(eligible) → under_review, then qualifyReferral.
   * Qualification requires a resolved patient plus a clinical indication and referral-source info
   * (qualificationBlockers), so the referral is created already matched to an M5 patient.
   */
  async function qualifiedReferral(
    source: string,
    patientNameAtReceipt: string,
    patientId: string,
  ): Promise<string> {
    const ref = await svc.createReferral(
      ORG_A,
      {
        source,
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt,
        patientId,
        referrerName: "Dr. Referrer",
        referringDxText: "Metastatic NSCLC",
      } as never,
      USER,
    );
    await svc.triageReferral(ORG_A, ref.id, "eligible", 0); // → under_review, v1
    const qualified = await svc.qualifyReferral(ORG_A, ref.id, 1, USER);
    expect(qualified.state).toBe("qualified");
    expect(qualified.version).toBe(2);
    return ref.id;
  }

  it("createReferral → triageReferral(eligible): received → under_review with version bumps", async () => {
    const ref = await svc.createReferral(
      ORG_A,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "Doe, Jane",
      },
      USER,
    );
    expect(ref.state).toBe("received");
    expect(ref.version).toBe(0);
    // An eligible triage opens the clinical review (triageReferral: eligible → `under_review`,
    // `m6.referral.review_started`); qualification is a separate, blocker-gated step.
    const triaged = await svc.triageReferral(ORG_A, ref.id, "eligible", 0);
    expect(triaged.state).toBe("under_review");
    expect(triaged.version).toBe(1);
  });

  it("a stale ifVersion is a 409 VERSION_MISMATCH (optimistic lock)", async () => {
    const ref = await svc.createReferral(
      ORG_A,
      {
        source: "fax",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "Stale, Sam",
      },
      USER,
    );
    await svc.triageReferral(ORG_A, ref.id, "eligible", 0); // → version 1
    await expect(svc.triageReferral(ORG_A, ref.id, "eligible", 0)).rejects.toMatchObject({
      statusCode: 409,
      code: "VERSION_MISMATCH",
    });
  });

  it("acceptReferral mints a draft admission + benefit period + the 4 §2.5 compliance windows", async () => {
    const refId = await qualifiedReferral("portal", "Accept, Ann", PATIENT);
    // acceptReferral is convertReferral: only a `qualified` referral converts, and it lands `converted`.
    const accepted = await svc.acceptReferral(
      ORG_A,
      refId,
      { primaryDiagnosisIcd10: "C34.90", patientId: PATIENT },
      2,
      USER,
    );
    expect(accepted.state).toBe("converted");
    expect(accepted.admissionId).toBeTruthy();
    const adm = await svc.getAdmission(ORG_A, accepted.admissionId);
    expect(adm?.state).toBe("pending");
    const windows = await admin.query(
      "SELECT window_kind FROM compliance_window WHERE admission_id=$1 ORDER BY window_kind",
      [accepted.admissionId],
    );
    expect(windows.rows.map((r) => r.window_kind).sort()).toEqual([
      "care_plan_5d",
      "comprehensive_assessment_5d",
      "initial_assessment_48h",
      "notice_of_rights",
    ]);
    const periods = await svc.listElectionPeriods(ORG_A, accepted.admissionId);
    expect(periods?.length).toBe(1);
  });

  it("acknowledgeNor → notice_of_rights_acknowledged, closes the NOR window; then activate enforces R-AC-01", async () => {
    const refId = await qualifiedReferral("walk_in", "Flow, Fred", PATIENT2);
    const { admissionId } = await svc.acceptReferral(
      ORG_A,
      refId,
      { primaryDiagnosisIcd10: "C34.90", patientId: PATIENT2 },
      2,
      USER,
    );
    // Admission details step (updateAdmission): the admission date is the R-AC-01 `admission_details`
    // blocker (activation-gate.ts); provider entity + location are capture siting, not blockers, but a
    // real admission carries them.
    const draftAdm = await svc.getAdmission(ORG_A, admissionId);
    await svc.updateAdmission(
      ORG_A,
      admissionId,
      { providerEntityId, locationId, admissionAt: new Date().toISOString() },
      draftAdm!.version,
    );
    // Pre-existing bug found while verifying an unrelated M6 fix: this call was missing the
    // NorAcknowledgeInput object (USER was landing in the `input` param, `actorUserId` was undefined) —
    // __tests__ is outside apps/backend/tsconfig.json's rootDir so tsc never typechecks this file, and
    // vitest's esbuild transform doesn't typecheck either, so the arity mismatch was invisible until it
    // actually ran against live Postgres (`set_config('app.user_id', undefined, true)` — malformed SQL).
    const norRes = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    expect(norRes.state).toBe("notice_of_rights_acknowledged");
    const norWin = await admin.query(
      "SELECT status FROM compliance_window WHERE admission_id=$1 AND window_kind='notice_of_rights'",
      [admissionId],
    );
    expect(norWin.rows[0].status).toBe("closed");

    // Activation gate: no signed election/CTI yet → blocked (412). activateAdmission now gates on the
    // full readiness evaluation and raises ActivationPreconditionError WITH its requirements, which the
    // error class codes `ADMISSION_NOT_READY` (PRECONDITION_FAILED is the requirements-less form); the
    // R-AC-01 gaps still live in `.missing`. R-AC-01 (intake/activation-gate.ts computeActivationGate):
    // election signed + NOR acknowledged + CTI signed by the hospice physician; "the attending-physician
    // CTI signature is not an activation prerequisite", so `attending_signed` is no longer an ActivationGap.
    await expect(svc.activateAdmission(ORG_A, admissionId, norRes.version)).rejects.toMatchObject({
      code: "ADMISSION_NOT_READY",
      statusCode: 412,
      missing: ["election_signed", "cti_signed"],
    });

    // Seed a signed election statement + hospice-MD-signed CTI on period 1 (as superuser), then activate.
    const [period] = (
      await admin.query("SELECT id FROM election_period WHERE admission_id=$1", [admissionId])
    ).rows;
    // A SIGNED statement is `status = 'signed'` (migration 0124's drafted → signed → voided lifecycle);
    // only that status yields election-signature evidence (backfillLegacyEvidenceForAdmission / 0220).
    await admin.query(
      `INSERT INTO election_statement (organization_id, election_period_id, patient_id, signer_kind,
         patient_name_at_signing, hospice_name_at_signing, curative_care_acknowledgment, signed_at,
         signature_method, status)
       VALUES ($1,$2,$3,'patient','Fred Flow','A Hospice',true, now()::date, 'electronic_witnessed', 'signed')`,
      [ORG_A, period.id, PATIENT2],
    );
    // The hospice physician's signature is the CTI activation prerequisite (R-AC-01); the attending's
    // is not, so it is deliberately left unsigned here.
    await admin.query(
      `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id,
         terminal_diagnosis_icd10, narrative, period_start, period_end, hospice_md_signed_at)
       VALUES ($1,$2,$3,'C34.90','Terminal', now()::date, now()::date + 90, now())`,
      [ORG_A, period.id, PHYSICIAN],
    );
    const active = await svc.activateAdmission(ORG_A, admissionId, norRes.version);
    expect(active.state).toBe("active");
    const at = await admin.query("SELECT activated_at FROM admission WHERE id=$1", [admissionId]);
    expect(at.rows[0].activated_at).not.toBeNull();

    // hold ⇄ resume over the state machine.
    const held = await svc.holdAdmission(ORG_A, admissionId, "family request", active.version);
    expect(held.state).toBe("on_hold");
    const resumed = await svc.resumeAdmission(ORG_A, admissionId, held.version);
    expect(resumed.state).toBe("active");
  });

  it("RLS: org B cannot triage org A's referral through the service (cross-tenant → 404)", async () => {
    const ref = await svc.createReferral(
      ORG_A,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "Iso, Ivy",
      },
      USER,
    );
    await expect(svc.triageReferral(ORG_B, ref.id, "eligible", 0)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
