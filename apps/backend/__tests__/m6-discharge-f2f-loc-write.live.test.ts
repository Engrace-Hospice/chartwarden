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
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  ResourceNotFoundError,
  SYSTEM_F2F_ACTOR,
} from "../src/modules/06-admission/routes/service";
import {
  buildDrizzleLcpAdmissionLookup,
  buildM37LcpActivatedConsumer,
} from "../src/modules/37-ipu/consumers/m6-lcp-activated";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import { buildDrizzleIpuRouteService } from "../src/modules/37-ipu/routes/service-drizzle";
import { buildIpuSeams } from "../src/modules/37-ipu/seams";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams, seedM5Patient } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";
const F2F_ATTESTATION_NARRATIVE =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (GAP-022 fixture).";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

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
      // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
        organizationId: ORG_A,
        actorUserId: USER,
        patientId,
      });
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
          ...CTI_CLINICAL,
          isRecert: false,
        },
        USER,
      );
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
      // 42 CFR 418.26(b) — the live discharges below are dated today, so they carry a physician order.
      await seedPhysicianRole(admin, ORG_A, MD);
      await admin.query(
        `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'CCN-M6T4','M6 T4 Hospice','NPI-M6T4','enc','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({
        connectionString: appRoleUrl(DB_URL as string),
      });
      registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult
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

    /**
     * F-226 - a PENDING period 2 whose expected start is 10 days out (the prior period is about to end), so a
     * visit yesterday is a real in-window encounter. (Right after activation period 1 still has ~89 days to run
     * and `completeF2f` correctly refuses an encounter that far before the window opens.)
     */
    async function pendingPeriodStartingSoon(): Promise<{ periodId: string; admissionId: string }> {
      const { admissionId } = await activeAdmission(randomUUID());
      const p = await svc.createElectionPeriod(ORG_A, admissionId);
      await admin.query(
        "UPDATE election_period SET expected_start = current_date + 10 WHERE id=$1",
        [p.id],
      );
      return { periodId: p.id, admissionId };
    }
    const daysFromNow = (n: number) =>
      new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    it("F2F: schedule → complete (real date, in window) → attest (performer is the actor)", async () => {
      const { periodId, admissionId } = await pendingPeriodStartingSoon();
      const f2f = await svc.scheduleF2f(ORG_A, {
        admissionId,
        electionPeriodId: periodId,
        scheduledClinicianId: USER,
        clinicianRole: "hospice_md",
        actor: SYSTEM_F2F_ACTOR,
      });
      expect(f2f.state).toBe("scheduled");
      const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version, daysFromNow(-1));
      expect(done.state).toBe("completed");
      const row = await admin.query(
        "SELECT encounter_date::text AS d, within_window FROM face_to_face_encounter WHERE id=$1",
        [f2f.id],
      );
      expect(row.rows[0]).toEqual({ d: daysFromNow(-1), within_window: true });
      // The attesting user must be the performer — a stranger is rejected (F2F_INVALID_PERFORMER → 422).
      await expect(
        svc.attestF2f(ORG_A, f2f.id, done.version, OTHER, F2F_ATTESTATION_NARRATIVE),
      ).rejects.toMatchObject({
        statusCode: 422,
      });
      const attested = await svc.attestF2f(
        ORG_A,
        f2f.id,
        done.version,
        USER,
        F2F_ATTESTATION_NARRATIVE,
      );
      expect(attested.state).toBe("attested");
    });

    describe("GAP-022 — F2F performer role + attestation narrative are server-enforced (real DB)", () => {
      /** A role port standing in for the M3 grants: USER holds `np`, OTHER holds only RN roles. */
      const roleKeys: Record<string, readonly string[]> = { [USER]: ["np"], [OTHER]: ["rn"] };
      let guarded: ReturnType<typeof createDbAdmissionRouteService>;
      beforeAll(() => {
        guarded = createDbAdmissionRouteService(
          handle.db,
          validatingM6Outbox(),
          undefined,
          undefined,
          undefined,
          undefined,
          { roleKeysForUser: async (_org, userId) => roleKeys[userId] ?? null },
        );
      });

      it("derives hospice_np from the clinician's grants; refuses an RN performer and a claim not held", async () => {
        const { periodId, admissionId } = await pendingPeriodStartingSoon();
        const base = {
          admissionId,
          electionPeriodId: periodId,
          actor: { kind: "user", userId: MD } as const,
        };
        await expect(
          guarded.scheduleF2f(ORG_A, {
            ...base,
            scheduledClinicianId: OTHER,
            clinicianRole: "hospice_md",
          }),
        ).rejects.toMatchObject({ code: "F2F_INVALID_PERFORMER", statusCode: 422 });
        await expect(
          guarded.scheduleF2f(ORG_A, {
            ...base,
            scheduledClinicianId: USER,
            clinicianRole: "hospice_md",
          }),
        ).rejects.toMatchObject({ code: "F2F_INVALID_PERFORMER", statusCode: 422 });
        const ok = await guarded.scheduleF2f(ORG_A, {
          ...base,
          scheduledClinicianId: USER,
          clinicianRole: "hospice_np",
        });
        const row = await admin.query(
          "SELECT performer_role FROM face_to_face_encounter WHERE id=$1",
          [ok.id],
        );
        expect(row.rows[0].performer_role).toBe("hospice_np");
      });

      it("a human-driven schedule with no role source bound fails closed (503), never trusting the body", async () => {
        const { periodId, admissionId } = await pendingPeriodStartingSoon();
        await expect(
          svc.scheduleF2f(ORG_A, {
            admissionId,
            electionPeriodId: periodId,
            scheduledClinicianId: USER,
            clinicianRole: "hospice_md",
            actor: { kind: "user", userId: MD },
          }),
        ).rejects.toMatchObject({ statusCode: 503 });
      });

      it("GAP-024: a period of another admission is 404 for both F2F schedule and election-statement draft (nothing written)", async () => {
        const mine = await pendingPeriodStartingSoon();
        const other = await pendingPeriodStartingSoon();
        const before = await admin.query(
          "SELECT count(*)::int AS n FROM face_to_face_encounter WHERE election_period_id=$1",
          [other.periodId],
        );
        await expect(
          svc.scheduleF2f(ORG_A, {
            admissionId: mine.admissionId,
            electionPeriodId: other.periodId,
            scheduledClinicianId: USER,
            clinicianRole: "hospice_np",
            actor: SYSTEM_F2F_ACTOR,
          }),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        await expect(
          svc.draftElectionStatement(ORG_A, mine.admissionId, other.periodId, DRAFT),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        const after = await admin.query(
          "SELECT count(*)::int AS n FROM face_to_face_encounter WHERE election_period_id=$1",
          [other.periodId],
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
      });

      it("attest: a 20-char narrative is refused 422 (row stays completed); the real narrative is persisted", async () => {
        const { periodId, admissionId } = await pendingPeriodStartingSoon();
        const f2f = await svc.scheduleF2f(ORG_A, {
          admissionId,
          electionPeriodId: periodId,
          scheduledClinicianId: USER,
          clinicianRole: "hospice_np",
          actor: SYSTEM_F2F_ACTOR,
        });
        const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version, daysFromNow(-1));
        await expect(
          svc.attestF2f(ORG_A, f2f.id, done.version, USER, "x".repeat(20)),
        ).rejects.toMatchObject({ code: "F2F_ATTESTATION_TOO_SHORT", statusCode: 422 });
        // An empty actor id is not a bypass of the performer check.
        await expect(
          svc.attestF2f(ORG_A, f2f.id, done.version, "", F2F_ATTESTATION_NARRATIVE),
        ).rejects.toMatchObject({ code: "F2F_INVALID_PERFORMER", statusCode: 422 });
        const pending = await admin.query(
          "SELECT status, attestation_narrative FROM face_to_face_encounter WHERE id=$1",
          [f2f.id],
        );
        expect(pending.rows[0]).toEqual({ status: "completed", attestation_narrative: null });
        await svc.attestF2f(ORG_A, f2f.id, done.version, USER, F2F_ATTESTATION_NARRATIVE);
        const after = await admin.query(
          "SELECT status, attestation_narrative FROM face_to_face_encounter WHERE id=$1",
          [f2f.id],
        );
        expect(after.rows[0]).toEqual({
          status: "attested",
          attestation_narrative: F2F_ATTESTATION_NARRATIVE,
        });
      });
    });

    it("F2F: complete → medical-director window override (stays completed)", async () => {
      const { periodId, admissionId } = await pendingPeriodStartingSoon();
      const f2f = await svc.scheduleF2f(ORG_A, {
        admissionId,
        electionPeriodId: periodId,
        scheduledClinicianId: USER,
        clinicianRole: "hospice_np",
        actor: SYSTEM_F2F_ACTOR,
      });
      const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version, daysFromNow(-1));
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

    it("M6 -> M37 handshake: confirm-bed publishes m6.level_of_care.activated and M37's consumer activates the bed_assigned admission (idempotent on redelivery)", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const assigning = await svc.changeLoc(
        ORG_A,
        admissionId,
        "inpatient_respite_care",
        randomUUID(),
        undefined,
        "caregiver respite stay arranged for the coming week",
      );
      // A REAL M37 chain at `bed_assigned`: unit -> room -> reserved bed -> ipu_admission (irc, this
      // period) -> active bed assignment. IRC so no GIP-criteria row is needed to activate.
      const unitId = (
        await admin.query(
          `INSERT INTO inpatient_unit (organization_id, facility_id, display_name, bed_count)
           VALUES ($1,$2,'Unit H',4) RETURNING id`,
          [ORG_A, randomUUID()],
        )
      ).rows[0].id as string;
      const roomId = (
        await admin.query(
          `INSERT INTO ipu_room (organization_id, unit_id, room_number, kind, bed_count)
           VALUES ($1,$2,'201','private',1) RETURNING id`,
          [ORG_A, unitId],
        )
      ).rows[0].id as string;
      const bedId = (
        await admin.query(
          `INSERT INTO ipu_bed (organization_id, room_id, unit_id, bed_label, cleaning_status)
           VALUES ($1,$2,$3,'A','reserved') RETURNING id`,
          [ORG_A, roomId, unitId],
        )
      ).rows[0].id as string;
      const ipuAdmissionId = (
        await admin.query(
          `INSERT INTO ipu_admission
             (organization_id, provider_entity_id, patient_id, admission_id, level_of_care_period_id,
              unit_id, kind, state, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'irc','bed_assigned',$7) RETURNING id`,
          [ORG_A, PROVIDER_ENTITY, randomUUID(), admissionId, assigning.id, unitId, USER],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO ipu_bed_assignment (organization_id, ipu_admission_id, bed_id, assigned_by)
         VALUES ($1,$2,$3,$4)`,
        [ORG_A, ipuAdmissionId, bedId, USER],
      );

      // M6 half: the activation publishes the acknowledgement in the same transaction.
      await svc.confirmLocBedAssignment(ORG_A, assigning.id, assigning.version);
      const emitted = await admin.query(
        `SELECT payload FROM outbox_event
          WHERE organization_id=$1 AND event_type='m6.level_of_care.activated' AND aggregate_id=$2`,
        [ORG_A, assigning.id],
      );
      expect(emitted.rows).toHaveLength(1);
      expect(emitted.rows[0].payload).toMatchObject({
        levelOfCarePeriodId: assigning.id,
        admissionId,
        newLevel: "inpatient_respite_care",
      });

      // M37 half: the real consumer over the real service, the real catalog-validating m37 publisher.
      const m37Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M37_OUTBOX_EVENTS]));
      const consumer = buildM37LcpActivatedConsumer({
        service: buildDrizzleIpuRouteService(handle.db, {
          outbox: {
            publish: (tx, e) => m37Publisher.publish(tx as never, { ...e, callerModule: "m37" }),
          },
        }),
        lookup: buildDrizzleLcpAdmissionLookup(handle.db),
      });
      const event = { id: randomUUID(), organizationId: ORG_A, payload: emitted.rows[0].payload };
      await consumer.handle(event);
      const after = await admin.query("SELECT state, activated_at FROM ipu_admission WHERE id=$1", [
        ipuAdmissionId,
      ]);
      expect(after.rows[0].state).toBe("active");
      expect(after.rows[0].activated_at).not.toBeNull();
      const bed = await admin.query("SELECT cleaning_status FROM ipu_bed WHERE id=$1", [bedId]);
      expect(bed.rows[0].cleaning_status).toBe("occupied");

      // Redelivery is a no-op: still one activation event, one IRC episode.
      await consumer.handle(event);
      const activated = await admin.query(
        "SELECT 1 FROM outbox_event WHERE event_type='m37.ipu_admission.activated' AND aggregate_id=$1",
        [ipuAdmissionId],
      );
      expect(activated.rows).toHaveLength(1);
      const episodes = await admin.query("SELECT 1 FROM irc_episode WHERE ipu_admission_id=$1", [
        ipuAdmissionId,
      ]);
      expect(episodes.rows).toHaveLength(1);

      // Fail closed: an event naming a period no ipu_admission carries is refused, never guessed at.
      await expect(
        consumer.handle({
          ...event,
          payload: { ...event.payload, levelOfCarePeriodId: randomUUID() },
        }),
      ).rejects.toThrow(/no ipu_admission/);
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
          dischargeOrder: dischargeOrderBy(MD),
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
          placeOfDeath: "home",
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
            placeOfDeath: "home",
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
        {
          cosignerName: "Dr. Med Director",
          cosignerNpi: "1234567893",
          actorRoleKeys: ["medical_director"],
        },
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
          {
            cosignerName: "Dr. Med Director",
            cosignerNpi: "1234567893",
            actorRoleKeys: ["medical_director"],
          },
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
          receivingCareSetting: "home",
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
            receivingCareSetting: "home",
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
      // Direct intake confirms the patient belongs to the org (readmission security review).
      await seedM5Patient(admin, ORG_A, patientId);
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
      // F-226 - the pending period starts the day after the inherited one ends (2026-01-01 + 60d - 1 = 2026-03-01).
      const pendingStart = await admin.query(
        "SELECT expected_start::text AS s FROM election_period WHERE id=$1",
        [seqs.rows[1].id],
      );
      expect(pendingStart.rows[0].s).toBe("2026-03-02");
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
                                             performer_role, encounter_date, within_window, status,
                                             attestation_signed_at, attestation_narrative)
         SELECT $1, ep.id, $3, 'hospice_md', ep.expected_start - 10, true, 'attested', now(), $4
           FROM election_period ep WHERE ep.id = $2 AND ep.expected_start IS NOT NULL`,
        [ORG_A, seqs.rows[1].id, MD, "x".repeat(120)],
      );
      // F-217 — the F2F is now in place, but the skeleton CTI `transferIn` drafts carries NO narrative
      // (and no route edits one), so the adequacy gate refuses it: 42 CFR 418.22(b)(3) requires the
      // narrative on every recertification. The refusal is typed and rolls the signature back.
      await expect(
        svc.signCtiHospiceMd(ORG_A, ctis.rows[0].id, Number(ctis.rows[0].version), USER),
      ).rejects.toMatchObject({
        code: "ELECTION_PERIOD_ADEQUACY_FAILED",
        statusCode: 409,
        details: [{ code: "CTI_NARRATIVE_MISSING" }],
      });
      // Correction path: void the skeleton and draft the real CTI (with its narrative) for the period.
      const skeleton = await admin.query(
        "SELECT version FROM certification_of_terminal_illness WHERE id=$1",
        [ctis.rows[0].id],
      );
      await svc.voidCti(
        ORG_A,
        ctis.rows[0].id,
        "redraft with narrative",
        Number(skeleton.rows[0].version),
      );
      const redraft = await svc.draftCti(
        ORG_A,
        {
          electionPeriodId: seqs.rows[1].id,
          hospiceMedicalDirectorId: MD,
          ...CTI_CLINICAL,
          isRecert: true,
        },
        USER,
      );
      // Now the same call signs AND activates the period.
      const signed = await svc.signCtiHospiceMd(ORG_A, redraft.id, redraft.version, USER);
      expect(signed.state).toBe("signed");
      const nextStatus = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        seqs.rows[1].id,
      ]);
      expect(nextStatus.rows[0].status).toBe("active");
    });
  },
);
