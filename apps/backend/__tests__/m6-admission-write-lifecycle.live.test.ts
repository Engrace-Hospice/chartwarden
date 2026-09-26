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
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { validatingM6Outbox } from "./_m6-outbox";

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
    // F-100 — was `createDbAdmissionRouteService(handle.db)`, i.e. NOOP_OUTBOX. A suite that asserts
    // "state + effects" and validates no payload asserts half an effect.
    svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox());
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
    // F-062: `status` is spelled out on the statement. R-AC-01's `election_signed` precondition used to
    // ask only whether a statement EXISTED, so this fixture — which sets `signed_at` but leaves the
    // default `drafted` status — satisfied "signed" without being it.
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

  // ── #50 — activation SITES the admission at a service location ──────────────────────────────────
  //
  // `admission.location_id` was never written by ANY code path: no route accepted a location, no
  // transition assigned one, nothing backfilled it. Every admission in every org carried NULL, which is
  // the second half of the #44 siting gap. M10 refuses to create a HOPE timepoint schedule for an
  // unsited admission (`hope_timepoint_schedule.location_id` is NOT NULL), so no capture window existed.
  describe("#50 — activation sites the admission at a location", () => {
    // A service WITH the M1 location port bound, exactly as the composition root binds it. The suite's
    // main `svc` deliberately leaves it unbound (the port is optional), which is what keeps every test
    // above unaffected.
    let sited: ReturnType<typeof createDbAdmissionRouteService>;
    const PE_ONE = "aa000000-0000-4000-8000-000000000001"; // one active location
    const PE_MANY = "aa000000-0000-4000-8000-000000000002"; // two active locations
    const PE_NONE = "aa000000-0000-4000-8000-000000000003"; // one location, not active
    const PE_ORG_B = "aa000000-0000-4000-8000-000000000004"; // another tenant's
    const locOf: Record<string, string[]> = {};
    let admSeq = 0x66000000;
    const nextPatient = (): string => {
      admSeq += 1;
      return `66000000-0000-4000-8000-${admSeq.toString(16).padStart(12, "0")}`;
    };
    // The suite-level org-A provider entity + location (shadowed inside `seedActivatable` by its params).
    const patientHome = (): [string, string] => [providerEntityId, locationId];

    async function seedProviderEntity(org: string, id: string, tag: string): Promise<void> {
      await admin.query(
        `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,$5,'enc','12-31') ON CONFLICT (id) DO NOTHING`,
        [id, org, `CCN-${tag}`, `PE ${tag}`, `NPI-${tag}`],
      );
    }
    async function seedLocation(pe: string, name: string, status: string): Promise<string> {
      const id = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
           VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles',$3) RETURNING id`,
          [pe, name, status],
        )
      ).rows[0].id as string;
      const bucket = locOf[pe] ?? [];
      bucket.push(id);
      locOf[pe] = bucket;
      return id;
    }

    /**
     * An admission parked at `notice_of_rights_acknowledged` with the whole R-AC-01 gate satisfied,
     * seeded as superuser. The full referral ceremony is exercised by the test above; repeating it per
     * case would test the ceremony, not the siting.
     */
    async function seedActivatable(
      org: string,
      providerEntityId: string | null,
      locationId: string | null = null,
    ): Promise<string> {
      const patientId = nextPatient();
      // A real M5 patient: activation's readiness gate asks M5's PatientAdmissionClearanceReader first,
      // and it refuses an unknown patient (PATIENT_NOT_FOUND → 412 ADMISSION_NOT_READY) — which would
      // mask the siting rule every case below is about.
      const [homePe, homeLoc] = patientHome();
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
           legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,$5,'Sited','Patient','1950-01-01','F','active')`,
        [patientId, org, homePe, homeLoc, `MRN-SITED-${admSeq.toString(16)}`],
      );
      const admissionId = (
        await admin.query(
          `INSERT INTO admission (organization_id, patient_id, provider_entity_id, location_id,
             admitted_by_physician_id, status, admission_at)
           VALUES ($1,$2,$3,$4,$5,'notice_of_rights_acknowledged', now()) RETURNING id`,
          [org, patientId, providerEntityId, locationId, PHYSICIAN],
        )
      ).rows[0].id as string;
      const periodId = (
        await admin.query(
          `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind)
           VALUES ($1,$2,1,'ninety_day') RETURNING id`,
          [org, admissionId],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO election_statement (organization_id, election_period_id, patient_id, signer_kind,
           patient_name_at_signing, hospice_name_at_signing, curative_care_acknowledgment, signed_at, signature_method, status)
         VALUES ($1,$2,$3,'patient','Sited, Sam','A Hospice',true, now()::date, 'electronic_witnessed', 'signed')`,
        [org, periodId, patientId],
      );
      await admin.query(
        `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id,
           attending_md_id, terminal_diagnosis_icd10, narrative, period_start, period_end,
           hospice_md_signed_at, attending_md_signed_at)
         VALUES ($1,$2,$3,$3,'C34.90','Terminal', now()::date, now()::date + 90, now(), now())`,
        [org, periodId, PHYSICIAN],
      );
      await admin.query(
        `INSERT INTO notice_of_rights_acknowledgment (organization_id, admission_id, patient_id,
           signer_kind, acknowledged_at, acknowledgment_method)
         VALUES ($1,$2,$3,'patient', now()::date, 'electronic_witnessed')`,
        [org, admissionId, patientId],
      );
      return admissionId;
    }

    const locationOf = async (admissionId: string): Promise<string | null> =>
      (await admin.query("SELECT location_id FROM admission WHERE id=$1", [admissionId])).rows[0]
        .location_id as string | null;
    const statusOf = async (admissionId: string): Promise<string> =>
      (await admin.query("SELECT status FROM admission WHERE id=$1", [admissionId])).rows[0]
        .status as string;

    beforeAll(async () => {
      await seedProviderEntity(ORG_A, PE_ONE, "ONE");
      await seedProviderEntity(ORG_A, PE_MANY, "MANY");
      await seedProviderEntity(ORG_A, PE_NONE, "NONE");
      await seedProviderEntity(ORG_B, PE_ORG_B, "ORGB");
      await seedLocation(PE_ONE, "Sole Office", "active");
      await seedLocation(PE_MANY, "Main Office", "active");
      await seedLocation(PE_MANY, "Inpatient Unit", "active");
      await seedLocation(PE_NONE, "Not Open Yet", "created");
      await seedLocation(PE_ORG_B, "Other Tenant", "active");
      sited = createDbAdmissionRouteService(handle.db, validatingM6Outbox(), undefined, undefined, {
        activeLocationsFor: buildProviderEntityLocationLister(handle.db),
      });
    });

    // The admission-details step (`updateAdmission`) sites the admission, so activation-time siting is an
    // OVERRIDE of an already-sited admission, validated against the elected provider entity's ACTIVE
    // locations. Provider/location are NOT readiness blockers (activation-gate.ts): an unsited admission
    // passes readiness and is refused by `resolveActivationLocation` when the site is ambiguous.
    it("keeps the location the admission-details step sited when none is named", async () => {
      const sitedAt = locOf[PE_MANY]?.[0] as string;
      const id = await seedActivatable(ORG_A, PE_MANY, sitedAt);
      const res = await sited.activateAdmission(ORG_A, id, 0);
      expect(res.state).toBe("active");
      expect(await locationOf(id)).toBe(sitedAt);
    });

    it("refuses (422) an unsited admission with an ambiguous site, and leaves it un-activated", async () => {
      const id = await seedActivatable(ORG_A, PE_MANY);
      await expect(sited.activateAdmission(ORG_A, id, 0)).rejects.toMatchObject({
        code: "M6_LOCATION_REQUIRED",
        statusCode: 422,
      });
      expect(await statusOf(id)).toBe("notice_of_rights_acknowledged");
      expect(await locationOf(id)).toBeNull();
    });

    it("accepts an explicitly named location under that provider entity", async () => {
      const id = await seedActivatable(ORG_A, PE_MANY, locOf[PE_MANY]?.[0] as string);
      const chosen = locOf[PE_MANY]?.[1] as string;
      const res = await sited.activateAdmission(ORG_A, id, 0, { locationId: chosen });
      expect(res.state).toBe("active");
      expect(await locationOf(id)).toBe(chosen);
    });

    it("refuses a location belonging to a DIFFERENT provider entity", async () => {
      const id = await seedActivatable(ORG_A, PE_MANY, locOf[PE_MANY]?.[0] as string);
      await expect(
        sited.activateAdmission(ORG_A, id, 0, { locationId: locOf[PE_ONE]?.[0] as string }),
      ).rejects.toMatchObject({ code: "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY", statusCode: 422 });
      expect(await statusOf(id)).toBe("notice_of_rights_acknowledged");
    });

    it("refuses another tenant's location identically — absent and cross-tenant do not differ", async () => {
      const id = await seedActivatable(ORG_A, PE_MANY, locOf[PE_MANY]?.[0] as string);
      await expect(
        sited.activateAdmission(ORG_A, id, 0, { locationId: locOf[PE_ORG_B]?.[0] as string }),
      ).rejects.toMatchObject({ code: "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY", statusCode: 422 });
    });

    it("refuses a named location that is not yet active", async () => {
      const notActive = locOf[PE_NONE]?.[0] as string;
      const id = await seedActivatable(ORG_A, PE_NONE, notActive);
      await expect(
        sited.activateAdmission(ORG_A, id, 0, { locationId: notActive }),
      ).rejects.toMatchObject({ code: "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY", statusCode: 422 });
    });

    it("migration 0216 backfills the unambiguous rows and leaves the rest, idempotently", async () => {
      const BACKFILL_SQL = readFileSync(
        join(MIGRATIONS_DIR, "0218_admission_location_backfill.sql"),
        "utf8",
      );
      const one = await seedActivatable(ORG_A, PE_ONE); // resolvable
      const many = await seedActivatable(ORG_A, PE_MANY); // ambiguous — must be left
      const none = await seedActivatable(ORG_A, PE_NONE); // no active site — must be left
      const noPe = await seedActivatable(ORG_A, null); // nothing to scope to — must be left

      await admin.query(BACKFILL_SQL);
      expect(await locationOf(one)).toBe(locOf[PE_ONE]?.[0]);
      expect(await locationOf(many)).toBeNull();
      expect(await locationOf(none)).toBeNull();
      expect(await locationOf(noPe)).toBeNull();

      // Re-running touches nothing: a sited row no longer matches `location_id IS NULL`.
      const before = (
        await admin.query("SELECT location_id, updated_at FROM admission WHERE id=$1", [one])
      ).rows[0];
      await admin.query(BACKFILL_SQL);
      const after = (
        await admin.query("SELECT location_id, updated_at FROM admission WHERE id=$1", [one])
      ).rows[0];
      expect(after.location_id).toBe(before.location_id);
      expect(after.updated_at).toEqual(before.updated_at);
    });
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
