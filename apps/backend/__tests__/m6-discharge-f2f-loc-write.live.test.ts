import { randomUUID } from "node:crypto";
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
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { buildIpuSeams } from "../src/modules/37-ipu/seams";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";
const MD = "55555555-5555-5555-5555-555555555555";
// #44 — the elected hospice + attending the setup helper's election statement names. The draft now
// PERSISTS these (it used to validate seven fields and forward one), and the org check below refuses an
// id that is not this org's, so both have to be real rows rather than free-floating uuids.
const PROVIDER_ENTITY = "77777777-7777-4777-8777-777777777777";
const ATTENDING = "88888888-8888-4888-8888-888888888888";
const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)(
  "M6 F2F/LOC/discharge/transfer write lifecycle — LIVE Postgres (M6L-T04)",
  () => {
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
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    /** Full activation via the real write path → an ACTIVE, period-1 admission ready to discharge. */
    async function activeAdmission(
      patientId: string,
    ): Promise<{ admissionId: string; periodId: string }> {
      const ref = await svc.createReferral(
        ORG_A,
        {
          source: "phone",
          receivedAt: new Date().toISOString(),
          receivingUserId: USER,
          patientNameAtReceipt: "P",
        },
        USER,
      );
      await svc.triageReferral(ORG_A, ref.id, "eligible", 0);
      const { admissionId } = await svc.acceptReferral(
        ORG_A,
        ref.id,
        { primaryDiagnosisIcd10: "C34.90", patientId },
        1,
        USER,
      );
      const periods = await svc.listElectionPeriods(ORG_A, admissionId);
      const periodId = periods![0].id;
      // Pre-existing bug found while verifying the confirm-handshake fix: this call was missing the
      // NorAcknowledgeInput object (USER was landing in the `input` param, `actorUserId` was undefined) —
      // __tests__ is outside apps/backend/tsconfig.json's rootDir so tsc never typechecks this file, and
      // vitest's esbuild transform doesn't typecheck either, so the arity mismatch was invisible until it
      // actually ran against live Postgres (`set_config('app.user_id', undefined, true)` — malformed SQL).
      const nor = await svc.acknowledgeNor(
        ORG_A,
        admissionId,
        { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
        USER,
      );
      const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
      await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
      // Second pre-existing gap found the same way: R-AC-01 (intake/activation-gate.ts) requires the
      // ATTENDING physician's CTI signature for period 1, not just the hospice medical director's — this
      // helper only ever called signCtiHospiceMd, so activation always threw ELECTION_STATEMENT_REQUIRED/
      // attending_signed once the NOR bug above stopped masking it.
      const cti = await svc.draftCti(
        ORG_A,
        {
          electionPeriodId: periodId,
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: OTHER,
          isRecert: false,
        },
        USER,
      );
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await svc.signCtiAttending(ORG_A, cti.id, cti.version + 1, OTHER);
      const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
      expect(active.state).toBe("active");
      return { admissionId, periodId };
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
        [ORG_A],
      );
      // USER/OTHER/MD are all real M1 users — every write's actor_user_id (app.user_id) is an FK the M4
      // write-audit trigger dereferences, so the medical director who cosigns/overrides must exist too.
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'m6t4a@x.test'),($2,'m6t4b@x.test'),($3,'m6t4md@x.test')`,
        [USER, OTHER, MD],
      );
      await admin.query(
        `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'CCN-M6T4','M6 T4 Hospice','NPI-M6T4','enc','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({
        connectionString: appRoleUrl(DB_URL as string),
      });
      // The 3rd arg is the REAL M37 `IpuBedAssignmentProvider` seam (not a fake) — proves the confirm
      // handshake's cross-module read works end-to-end, not just that the M6 side compiles.
      //
      // The 4th is #44's provider-entity org check. This suite drafts election statements as SETUP for
      // its F2F/LOC/discharge cases, and `draftElectionStatement` now fails CLOSED (503) with the port
      // unbound rather than persisting an unverified hospice — so an unbound port turned every test in
      // this file red. Bound to the real predicate over the rows seeded above, exactly as the sibling
      // T3 suite does; the deliberately-unbound case is asserted there.
      svc = createDbAdmissionRouteService(
        handle.db,
        validatingM6Outbox(), // F-100 — not `undefined`; see ./_m6-outbox.ts
        buildIpuSeams(handle.db).IpuBedAssignmentProvider,
        {
          async belongsToOrg(organizationId, providerEntityId) {
            const { rows } = await admin.query(
              "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
              [providerEntityId, organizationId],
            );
            return rows.length > 0;
          },
        },
      );
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
      await expect(svc.attestF2f(ORG_A, f2f.id, done.version, OTHER)).rejects.toMatchObject({
        statusCode: 422,
      });
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
      const over = await svc.overrideF2fWindow(
        ORG_A,
        f2f.id,
        "out-of-window: patient hospitalized for two weeks",
        done.version,
        MD,
      );
      expect(over.state).toBe("completed");
      const row = await admin.query(
        "SELECT window_override FROM face_to_face_encounter WHERE id=$1",
        [f2f.id],
      );
      expect(row.rows[0].window_override).toBe(true);
    });

    it("LOC: change (RHC → active) → second change ends the prior → patch", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const first = await svc.changeLoc(ORG_A, admissionId, "routine_home_care");
      expect(first.state).toBe("active");
      const second = await svc.changeLoc(ORG_A, admissionId, "continuous_home_care");
      expect(second.state).toBe("active");
      // Exactly one open (ended_at IS NULL) LOC survives — the partial unique holds.
      const open = await admin.query(
        "SELECT count(*)::int n FROM level_of_care_period WHERE admission_id=$1 AND ended_at IS NULL",
        [admissionId],
      );
      expect(open.rows[0].n).toBe(1);
      const patched = await svc.patchLoc(ORG_A, second.id, "titrating symptoms", second.version);
      expect(patched.version).toBe(second.version + 1);
    });

    it("LOC: GIP requires a real facility_id + ≥30-char documentation, lands in 'assigning'", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const gipReason = "uncontrolled symptoms requiring inpatient management now";
      await expect(
        svc.changeLoc(ORG_A, admissionId, "general_inpatient_care", null, undefined, gipReason),
      ).rejects.toMatchObject({ code: "IPU_FACILITY_REQUIRED" });
      const facilityId = randomUUID();
      const assigning = await svc.changeLoc(
        ORG_A,
        admissionId,
        "general_inpatient_care",
        facilityId,
        undefined,
        gipReason,
      );
      expect(assigning.state).toBe("assigning");
      const row = await admin.query(
        "SELECT status, facility_id, ended_at FROM level_of_care_period WHERE id=$1",
        [assigning.id],
      );
      expect(row.rows[0].status).toBe("assigning");
      expect(row.rows[0].facility_id).toBe(facilityId);
      // Still open (ended_at IS NULL) but MUST NOT surface as the admission's current level of care —
      // getCurrentLevelOfCare excludes 'assigning' (confirm-handshake fix).
      expect(row.rows[0].ended_at).toBeNull();
    });

    it("LOC: confirm-bed handshake fails until a REAL M37 bed assignment exists, then activates", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const facilityId = randomUUID();
      const assigning = await svc.changeLoc(
        ORG_A,
        admissionId,
        "general_inpatient_care",
        facilityId,
        undefined,
        "uncontrolled symptoms requiring inpatient management now",
      );
      // No M37 bed exists yet — must fail closed, never silently confirm.
      await expect(
        svc.confirmLocBedAssignment(ORG_A, assigning.id, assigning.version),
      ).rejects.toMatchObject({ code: "IPU_FACILITY_REQUIRED" });

      // Seed a REAL M37 chain: unit → room → bed → ipu_admission (kind=gip, linked to THIS LOC period)
      // → an active bed assignment — proving the cross-module read, not a fake.
      const unit = await admin.query(
        `INSERT INTO inpatient_unit (organization_id, facility_id, display_name, bed_count)
         VALUES ($1,$2,'Unit A',4) RETURNING id`,
        [ORG_A, randomUUID()],
      );
      const unitId = unit.rows[0].id;
      const room = await admin.query(
        `INSERT INTO ipu_room (organization_id, unit_id, room_number, kind, bed_count)
         VALUES ($1,$2,'101','private',1) RETURNING id`,
        [ORG_A, unitId],
      );
      const roomId = room.rows[0].id;
      const bed = await admin.query(
        `INSERT INTO ipu_bed (organization_id, room_id, unit_id, bed_label)
         VALUES ($1,$2,$3,'A') RETURNING id`,
        [ORG_A, roomId, unitId],
      );
      const bedId = bed.rows[0].id;
      const ipuAdmission = await admin.query(
        `INSERT INTO ipu_admission
           (organization_id, provider_entity_id, patient_id, admission_id, level_of_care_period_id,
            unit_id, kind, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'gip',$7) RETURNING id`,
        [ORG_A, randomUUID(), randomUUID(), admissionId, assigning.id, unitId, USER],
      );
      const ipuAdmissionId = ipuAdmission.rows[0].id;
      await admin.query(
        `INSERT INTO ipu_bed_assignment (organization_id, ipu_admission_id, bed_id, assigned_by)
         VALUES ($1,$2,$3,$4)`,
        [ORG_A, ipuAdmissionId, bedId, USER],
      );

      const confirmed = await svc.confirmLocBedAssignment(ORG_A, assigning.id, assigning.version);
      expect(confirmed.state).toBe("active");
      const row = await admin.query(
        "SELECT status, ipu_bed_assignment_id FROM level_of_care_period WHERE id=$1",
        [assigning.id],
      );
      expect(row.rows[0].status).toBe("active");
      expect(row.rows[0].ipu_bed_assignment_id).not.toBeNull();
      // A second confirm is now ILLEGAL_TRANSITION (already active, not assigning).
      await expect(
        svc.confirmLocBedAssignment(ORG_A, assigning.id, confirmed.version),
      ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    });

    it("discharge (moved) → admission discharged, event completed", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const res = await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "relocated out of the service area",
        },
        USER,
      );
      expect(res.state).toBe("completed");
      expect(res.requiresMedicalDirectorCosign).toBe(false);
      const adm = await svc.getAdmission(ORG_A, admissionId);
      expect(adm!.state).toBe("discharged");
    });

    it("discharge (death) → bereavement + bereavement_eligible, death certifier persisted", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const res = await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "death",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "expired peacefully",
          deathCertifierId: MD,
        },
        USER,
      );
      expect(res.state).toBe("completed");
      const adm = await svc.getAdmission(ORG_A, admissionId);
      expect(adm!.state).toBe("bereavement");
      const de = await admin.query(
        "SELECT bereavement_eligible, death_certifier_id FROM discharge_event WHERE admission_id=$1",
        [admissionId],
      );
      expect(de.rows[0].bereavement_eligible).toBe(true);
      expect(de.rows[0].death_certifier_id).toBe(MD);
    });

    it("a death discharge with no certifier identity is rejected (checkDischargeNarrative's R-DC-01 identity gate)", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      await expect(
        svc.discharge(
          ORG_A,
          admissionId,
          {
            reason: "death",
            dischargeDate: new Date().toISOString().slice(0, 10),
            narrative: "expired peacefully",
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: "DEATH_CERTIFIER_INVALID", statusCode: 422 });
      const de = await admin.query("SELECT id FROM discharge_event WHERE admission_id=$1", [
        admissionId,
      ]);
      expect(de.rows).toHaveLength(0);
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("active");
    });

    it("a death discharge dated in the future is rejected (planDischarge's R-DC-01 real-clock guard)", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const future = new Date(Date.now() + 30 * 24 * 3600_000).toISOString().slice(0, 10);
      await expect(
        svc.discharge(
          ORG_A,
          admissionId,
          {
            reason: "death",
            dischargeDate: future,
            narrative: "expired peacefully",
            deathCertifierId: MD,
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: "DEATH_CERTIFIER_INVALID", statusCode: 422 });
      // The guard fired before any write — no discharge_event row, admission stayed active.
      const de = await admin.query("SELECT id FROM discharge_event WHERE admission_id=$1", [
        admissionId,
      ]);
      expect(de.rows).toHaveLength(0);
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("active");
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
      const cosigned = await svc.cosignDischarge(
        ORG_A,
        filed.id,
        { cosignerName: "Dr. Med Director", cosignerNpi: "1234567893" },
        filed.version,
        MD,
      );
      expect(cosigned.state).toBe("completed");
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("discharged");
      // A second cosign is a no-op conflict (state is no longer pending_cosign).
      await expect(
        svc.cosignDischarge(
          ORG_A,
          filed.id,
          { cosignerName: "Dr. Med Director", cosignerNpi: "1234567893" },
          cosigned.version,
          MD,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("revocation → admission discharged, benefit periods completed, revocation facts persisted", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const rev = await svc.createRevocation(
        ORG_A,
        admissionId,
        {
          revocationDate: "2026-06-10",
          narrative: "patient elected to revoke hospice care to pursue curative treatment",
          signingPatientName: "Pat Test",
          signingRole: "legal_representative",
          revocationReason: "seek_curative_treatment",
        },
        USER,
      );
      expect(rev.state).toBe("created");
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("discharged");
      const ep = await admin.query("SELECT status FROM election_period WHERE admission_id=$1", [
        admissionId,
      ]);
      expect(ep.rows.every((r: { status: string }) => r.status === "completed")).toBe(true);
      const row = await admin.query(
        `SELECT signer_kind, effective_at::text, signed_at::text, revocation_reason, narrative
           FROM revocation_event WHERE id=$1`,
        [rev.id],
      );
      // "legal_representative" (route vocabulary) maps to the DB enum's "representative".
      expect(row.rows[0].signer_kind).toBe("representative");
      expect(row.rows[0].effective_at).toBe("2026-06-10");
      expect(row.rows[0].signed_at).toBe("2026-06-10");
      expect(row.rows[0].revocation_reason).toBe("seek_curative_treatment");
      expect(row.rows[0].narrative).toMatch(/pursue curative treatment/);
    });

    it("revocation is rejected when the latest election period is not active (planRevocation's R-RV-01 guard)", async () => {
      const { admissionId, periodId } = await activeAdmission(randomUUID());
      // Superuser-bypass the period straight to `completed` — simulates the state a second revocation
      // attempt would find (latestPeriod alone would have let this through pre-fix and hit the
      // `revocation_period_idx` unique constraint, or worse, silently completed an already-completed
      // period a second time).
      await admin.query("UPDATE election_period SET status = 'completed' WHERE id = $1", [
        periodId,
      ]);
      await expect(
        svc.createRevocation(
          ORG_A,
          admissionId,
          {
            revocationDate: "2026-06-10",
            narrative: "patient elected to revoke hospice care",
            signingPatientName: "Pat Test",
            signingRole: "patient",
            revocationReason: "other",
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION", statusCode: 409 });
      // No revocation_event row was created, and the admission stayed active — the guard fired BEFORE
      // any write, not after a failed insert.
      const revs = await admin.query("SELECT id FROM revocation_event WHERE admission_id=$1", [
        admissionId,
      ]);
      expect(revs.rows).toHaveLength(0);
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("active");
    });

    it("transfer-out → admission discharged, with the counterparty hospice + narrative persisted", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const xfer = await svc.transferOut(
        ORG_A,
        admissionId,
        {
          effectiveDate: "2026-06-15",
          otherHospiceName: "Sunrise Hospice",
          otherHospiceCcn: "391234",
          narrative: "patient relocated closer to family; care transferred by mutual agreement",
        },
        USER,
      );
      expect(xfer.state).toBe("created");
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("discharged");
      const row = await admin.query(
        `SELECT direction, effective_at::text, receiving_or_sending_ccn, receiving_or_sending_name, narrative
           FROM transfer_event WHERE id=$1`,
        [xfer.id],
      );
      expect(row.rows[0].direction).toBe("out");
      expect(row.rows[0].effective_at).toBe("2026-06-15");
      expect(row.rows[0].receiving_or_sending_ccn).toBe("391234");
      expect(row.rows[0].receiving_or_sending_name).toBe("Sunrise Hospice");
      expect(row.rows[0].narrative).toMatch(/relocated closer to family/);
    });

    it("a second transfer-out for the same benefit period is rejected (planTransferOut's R-XFR-01 guard)", async () => {
      const { admissionId, periodId } = await activeAdmission(randomUUID());
      const seq = (
        await admin.query("SELECT sequence_number FROM election_period WHERE id=$1", [periodId])
      ).rows[0].sequence_number;
      // Superuser-seed a prior transfer-out for this SAME period — simulates the state a genuine
      // double-call would find (today the admission-graph transition to `discharged` blocks an
      // obvious double API call, but nothing DB-level enforces R-XFR-01 directly).
      await admin.query(
        `INSERT INTO transfer_event (organization_id, admission_id, direction, effective_at,
           period_sequence_at_transfer)
         VALUES ($1,$2,'out','2026-05-01',$3)`,
        [ORG_A, admissionId, seq],
      );
      await expect(
        svc.transferOut(
          ORG_A,
          admissionId,
          {
            effectiveDate: "2026-06-15",
            otherHospiceName: "Sunrise Hospice",
            narrative: "second attempt for the same period",
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: "TRANSFER_LIMIT_EXCEEDED", statusCode: 409 });
      const rows = await admin.query(
        "SELECT id FROM transfer_event WHERE admission_id=$1 AND direction='out'",
        [admissionId],
      );
      expect(rows.rows).toHaveLength(1); // only the seeded row — the guard fired before the 2nd insert
      expect((await svc.getAdmission(ORG_A, admissionId))!.state).toBe("active");
    });

    it("transfer-in → inherited active + next pending period (no counter restart)", async () => {
      const patientId = randomUUID();
      const adm = await svc.createAdmission(
        ORG_A,
        { patientId, intakeMethod: "transfer_in", hospiceMedicalDirectorId: MD },
        USER,
      );
      const res = await svc.transferIn(
        ORG_A,
        adm.id,
        {
          priorBenefitPeriodSequence: 3,
          priorElectionStartDate: "2026-01-01",
          hospiceMedicalDirectorId: MD,
          effectiveDate: "2026-04-01",
          otherHospiceName: "Prior Hospice Inc",
          otherHospiceCcn: "381588",
          narrative: "patient transferred in mid-benefit-period from Prior Hospice Inc",
        },
        USER,
      );
      expect(res.currentElectionPeriodSequence).toBe(3);
      const xferRow = await admin.query(
        `SELECT effective_at::text, receiving_or_sending_ccn, receiving_or_sending_name, narrative
           FROM transfer_event WHERE id=$1`,
        [res.id],
      );
      expect(xferRow.rows[0].effective_at).toBe("2026-04-01");
      expect(xferRow.rows[0].receiving_or_sending_ccn).toBe("381588");
      expect(xferRow.rows[0].receiving_or_sending_name).toBe("Prior Hospice Inc");
      expect(xferRow.rows[0].narrative).toMatch(/transferred in mid-benefit-period/);
      const periods = await svc.listElectionPeriods(ORG_A, adm.id);
      const seqs = await admin.query(
        "SELECT id, sequence_number, status FROM election_period WHERE admission_id=$1 ORDER BY sequence_number",
        [adm.id],
      );
      expect(periods!.length).toBe(2);
      expect(seqs.rows.map((r: { sequence_number: number }) => r.sequence_number)).toEqual([3, 4]);
      expect(seqs.rows[0].status).toBe("active");
      expect(seqs.rows[1].status).toBe("pending");
      // D9 — the inherited (active) period runs on the SENDING hospice's certification, so we draft NO
      // CTI against it; the next (pending) period DOES require our own CTI.
      const ctis = await admin.query(
        `SELECT id, election_period_id, hospice_md_id, status, version
           FROM certification_of_terminal_illness WHERE election_period_id = ANY($1)`,
        [seqs.rows.map((r: { id: string }) => r.id)],
      );
      expect(ctis.rows).toHaveLength(1);
      expect(ctis.rows[0].election_period_id).toBe(seqs.rows[1].id);
      expect(ctis.rows[0].hospice_md_id).toBe(MD);
      expect(ctis.rows[0].status).toBe("drafted");
      // F-089 — sequence 4 is a third-or-later benefit period, so 42 CFR 418.22(a)(4) requires an
      // attested face-to-face encounter before the recertification. This assertion used to read
      // "signing it (hospice-MD alone, since sequence 4 !== 1) fully signs AND activates the period",
      // which was true until F-062 (#143) reached `transitionElectionPeriod` for real and its
      // R-F2F-04 guard started running. Transferring in does not exempt the receiving hospice: it is
      // the one recertifying for the next period, so the encounter is ITS obligation.
      await expect(
        svc.signCtiHospiceMd(ORG_A, ctis.rows[0].id, Number(ctis.rows[0].version), USER),
      ).rejects.toMatchObject({ code: "F2F_REQUIRED_FOR_RECERT" });

      await admin.query(
        `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
                                             performer_role, encounter_date, status,
                                             attestation_signed_at, attestation_narrative)
         VALUES ($1,$2,$3,'hospice_md', now()::date, 'attested', now(), $4)`,
        [ORG_A, seqs.rows[1].id, MD, "x".repeat(120)],
      );
      // Now the same call signs AND activates the period.
      const signed = await svc.signCtiHospiceMd(
        ORG_A,
        ctis.rows[0].id,
        Number(ctis.rows[0].version),
        USER,
      );
      expect(signed.state).toBe("signed");
      const nextStatus = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        seqs.rows[1].id,
      ]);
      expect(nextStatus.rows[0].status).toBe("active");
    });
  },
);
