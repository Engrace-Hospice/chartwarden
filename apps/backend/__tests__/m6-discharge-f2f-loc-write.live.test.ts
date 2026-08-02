/**
 * M6L-T04 — the Drizzle F2F / LOC / discharge / transfer / revocation write lifecycle, proven against
 * real Postgres.
 *
 * Drives the production writes as the NOBYPASSRLS `wardenx_app` role: F2F schedule → complete → attest
 * (performer-is-actor gate) and the completed → window-override self-loop; LOC change (RHC → active) →
 * a second change that ends the prior open period → patch; discharge immediate (moved) → discharged;
 * death → bereavement (+ bereavement_eligible); the D11 for-cause file → `pending_cosign` (admission
 * stays active) → medical-director cosign → discharged; revocation → discharged; transfer-out →
 * discharged; transfer-in → inherited active + next pending period. Optimistic concurrency throughout.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";
const MD = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M6 F2F/LOC/discharge/transfer write lifecycle — LIVE Postgres (M6L-T04)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Full activation via the real write path → an ACTIVE, period-1 admission ready to discharge. */
  async function activeAdmission(patientId: string): Promise<{ admissionId: string; periodId: string }> {
    const ref = await svc.createReferral(
      ORG_A,
      { source: "phone", receivedAt: new Date().toISOString(), receivingUserId: USER, patientNameAtReceipt: "P" },
      USER,
    );
    await svc.triageReferral(ORG_A, ref.id, "eligible", 0);
    const { admissionId } = await svc.acceptReferral(ORG_A, ref.id, { primaryDiagnosisIcd10: "C34.90", patientId }, 1, USER);
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    const periodId = periods![0].id;
    const nor = await svc.acknowledgeNor(ORG_A, admissionId, USER);
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId);
    await svc.signElection(ORG_A, es.id, es.version, USER);
    const cti = await svc.draftCti(ORG_A, { electionPeriodId: periodId, hospiceMedicalDirectorId: MD, isRecert: false }, USER);
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
    return { admissionId, periodId };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query("INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')", [ORG_A]);
    // USER/OTHER/MD are all real M1 users — every write's actor_user_id (app.user_id) is an FK the M4
    // write-audit trigger dereferences, so the medical director who cosigns/overrides must exist too.
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m6t4a@x.test'),($2,'m6t4b@x.test'),($3,'m6t4md@x.test')`,
      [USER, OTHER, MD],
    );
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({ connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@") });
    svc = createDbAdmissionRouteService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("F2F: schedule → complete → attest (performer is the actor)", async () => {
    const { periodId } = await activeAdmission(randomUUID());
    const f2f = await svc.scheduleF2f(ORG_A, {
      admissionId: "ignored",
      electionPeriodId: periodId,
      scheduledClinicianId: USER,
      clinicianRole: "hospice_md",
    });
    expect(f2f.state).toBe("scheduled");
    const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version);
    expect(done.state).toBe("completed");
    // The attesting user must be the performer — a stranger is rejected (F2F_INVALID_PERFORMER → 422).
    await expect(svc.attestF2f(ORG_A, f2f.id, done.version, OTHER)).rejects.toMatchObject({ statusCode: 422 });
    const attested = await svc.attestF2f(ORG_A, f2f.id, done.version, USER);
    expect(attested.state).toBe("attested");
  });

  it("F2F: complete → medical-director window override (stays completed)", async () => {
    const { periodId } = await activeAdmission(randomUUID());
    const f2f = await svc.scheduleF2f(ORG_A, {
      admissionId: "x",
      electionPeriodId: periodId,
      scheduledClinicianId: USER,
      clinicianRole: "hospice_np",
    });
    const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version);
    const over = await svc.overrideF2fWindow(ORG_A, f2f.id, "out-of-window: patient hospitalized for two weeks", done.version, MD);
    expect(over.state).toBe("completed");
    const row = await admin.query("SELECT window_override FROM face_to_face_encounter WHERE id=$1", [f2f.id]);
    expect(row.rows[0].window_override).toBe(true);
  });

  it("LOC: change (RHC → active) → second change ends the prior → patch", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const first = await svc.changeLoc(ORG_A, admissionId, "routine_home_care");
    expect(first.state).toBe("active");
    const second = await svc.changeLoc(ORG_A, admissionId, "continuous_home_care");
    expect(second.state).toBe("active");
    // Exactly one open (ended_at IS NULL) LOC survives — the partial unique holds.
    const open = await admin.query("SELECT count(*)::int n FROM level_of_care_period WHERE admission_id=$1 AND ended_at IS NULL", [admissionId]);
    expect(open.rows[0].n).toBe(1);
    const patched = await svc.patchLoc(ORG_A, second.id, "titrating symptoms", second.version);
    expect(patched.version).toBe(second.version + 1);
  });

  it("discharge (moved) → admission discharged, event completed", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const res = await svc.discharge(
      ORG_A,
      admissionId,
      { reason: "moved_out_of_service_area", dischargeDate: new Date().toISOString().slice(0, 10), narrative: "relocated out of the service area" },
      USER,
    );
    expect(res.state).toBe("completed");
    expect(res.requiresMedicalDirectorCosign).toBe(false);
    const adm = await svc.getAdmission(ORG_A, admissionId);
    expect(adm!.state).toBe("discharged");
  });

  it("discharge (death) → bereavement + bereavement_eligible", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const res = await svc.discharge(
      ORG_A,
      admissionId,
      { reason: "death", dischargeDate: new Date().toISOString().slice(0, 10), narrative: "expired peacefully" },
      USER,
    );
    expect(res.state).toBe("completed");
    const adm = await svc.getAdmission(ORG_A, admissionId);
    expect(adm!.state).toBe("bereavement");
    const de = await admin.query("SELECT bereavement_eligible FROM discharge_event WHERE admission_id=$1", [admissionId]);
    expect(de.rows[0].bereavement_eligible).toBe(true);
  });

  it("discharge (for_cause) → pending_cosign (admission stays active) → cosign → discharged", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const filed = await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "for_cause",
        dischargeDate: new Date().toISOString().slice(0, 10),
        narrative: "documented safety threat to staff",
        forCauseReason: "repeated credible threats of violence to visiting nurses",
      },
      USER,
    );
    expect(filed.state).toBe("pending_cosign");
    expect(filed.requiresMedicalDirectorCosign).toBe(true);
    // The admission is NOT discharged yet (D11).
    expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("active");
    const cosigned = await svc.cosignDischarge(ORG_A, filed.id, filed.version, MD);
    expect(cosigned.state).toBe("completed");
    expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("discharged");
    // A second cosign is a no-op conflict (state is no longer pending_cosign).
    await expect(svc.cosignDischarge(ORG_A, filed.id, cosigned.version, MD)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("revocation → admission discharged, benefit periods completed", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const rev = await svc.createRevocation(ORG_A, admissionId, USER);
    expect(rev.state).toBe("created");
    expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("discharged");
    const ep = await admin.query("SELECT status FROM election_period WHERE admission_id=$1", [admissionId]);
    expect(ep.rows.every((r: { status: string }) => r.status === "completed")).toBe(true);
  });

  it("transfer-out → admission discharged", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const xfer = await svc.transferOut(ORG_A, admissionId, USER);
    expect(xfer.state).toBe("created");
    expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("discharged");
    const row = await admin.query("SELECT direction FROM transfer_event WHERE id=$1", [xfer.id]);
    expect(row.rows[0].direction).toBe("out");
  });

  it("transfer-in → inherited active + next pending period (no counter restart)", async () => {
    const patientId = randomUUID();
    const adm = await svc.createAdmission(
      ORG_A,
      { patientId, intakeMethod: "transfer", hospiceMedicalDirectorId: MD },
      USER,
    );
    const res = await svc.transferIn(
      ORG_A,
      adm.id,
      { priorBenefitPeriodSequence: 3, priorElectionStartDate: "2026-01-01" },
      USER,
    );
    expect(res.currentElectionPeriodSequence).toBe(3);
    const periods = await svc.listElectionPeriods(ORG_A, adm.id);
    const seqs = await admin.query("SELECT sequence_number, status FROM election_period WHERE admission_id=$1 ORDER BY sequence_number", [adm.id]);
    expect(periods!.length).toBe(2);
    expect(seqs.rows.map((r: { sequence_number: number }) => r.sequence_number)).toEqual([3, 4]);
    expect(seqs.rows[0].status).toBe("active");
    expect(seqs.rows[1].status).toBe("pending");
  });
});
