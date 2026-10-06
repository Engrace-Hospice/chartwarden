/**
 * FY2027 hospice CoP — LIVE Postgres proof (real NOBYPASSRLS `wardenx_app` role, real catalog-validating
 * outbox) of the face-to-face changes (docs/research/FY2027_HOSPICE_COP_RESEARCH.md §3–4):
 *
 *   · R-F2F-05 — `completeF2f` persists `encounter_location` and, for telehealth, the § 418.22(a)(4)(ii)(A)–(C)
 *     attestation (`telehealth_eligibility`, migration 0390); telehealth without the attestation and a
 *     disqualifying attestation are refused 422 and the row stays `scheduled`; the 0390 CHECK refuses an
 *     attestation on an in-person row.
 *   · R-F2F-06 — `attestF2f` accepts a linked M8 note signed by the performer on the encounter date (bound
 *     over M8's real `signedEncounterNoteForOrg`), persists `encounter_id` with no narrative; a note signed by
 *     someone else / unsigned / on another date is refused 422.
 *   · CR 14495 — `claimAssemblyRangeContextForOrg` returns a PENDING period's telehealth F2F (modality
 *     `telehealth`) for a claim range that covers the encounter date but not the period.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:f2f-fy2027:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";
import { claimAssemblyRangeContextForOrg } from "../src/modules/06-admission/seams/drizzle-store";
import { signedEncounterNoteForOrg } from "../src/modules/08-encounters/seams/drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
const F2F_ATTESTATION_NARRATIVE =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (GAP-022 fixture).";

const NARRATIVE_OK =
  "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.";
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: NARRATIVE_OK,
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111112027";
const ORG_B = "22222222-2222-2222-2222-222222222027";
const USER = "33333333-3333-3333-3333-333333332027";
const MD = "55555555-5555-5555-5555-555555552027";
const ATTENDING = "77777777-7777-7777-7777-777777772027";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-888888882027";

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

const dayOffset = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!DB_URL)(
  "FY2027 R-F2F-05/06 + CR 14495 range facts — LIVE Postgres (wardenx_app role)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbAdmissionRouteService>;

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
      const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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

    /** Period-1 activation ceremony through production writes only. */
    async function activate(patientId = randomUUID()) {
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
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
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: ATTENDING,
          ...CTI_CLINICAL,
          isRecert: false,
        },
        USER,
      );
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await svc.activateAdmission(ORG_A, admissionId, nor.version);
      return { admissionId, periodId, patientId };
    }

    /** Activate period 2 through production (recert, no F2F needed), then open PENDING period 3. */
    async function pending3() {
      const a = await activate();
      const p2 = await svc.createElectionPeriod(ORG_A, a.admissionId);
      const cti2 = await svc.draftCti(
        ORG_A,
        { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
        USER,
      );
      await svc.signCtiHospiceMd(ORG_A, cti2.id, cti2.version, USER);
      const p3 = await svc.createElectionPeriod(ORG_A, a.admissionId);
      const cti3 = await svc.draftCti(
        ORG_A,
        { electionPeriodId: p3.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
        USER,
      );
      return { ...a, p2Id: p2.id, periodId: p3.id, cti: cti3 };
    }

    const schedule = async (periodId: string) =>
      svc.scheduleF2f(ORG_A, {
        admissionId: (
          await admin.query("SELECT admission_id FROM election_period WHERE id=$1", [periodId])
        ).rows[0].admission_id,
        electionPeriodId: periodId,
        scheduledClinicianId: USER,
        clinicianRole: "hospice_md",
        actor: SYSTEM_F2F_ACTOR,
      });
    const setStart = (periodId: string, start: string | null) =>
      admin.query("UPDATE election_period SET expected_start = $2 WHERE id=$1", [periodId, start]);
    const f2fRow = async (id: string) =>
      (
        await admin.query(
          `SELECT status, encounter_location::text AS loc, telehealth_eligibility AS te,
                encounter_id, attestation_narrative
           FROM face_to_face_encounter WHERE id=$1`,
          [id],
        )
      ).rows[0] as {
        status: string;
        loc: string | null;
        te: Record<string, unknown> | null;
        encounter_id: string | null;
        attestation_narrative: string | null;
      };
    const ELIGIBLE = {
      patientInMoratoriumArea: false,
      hospiceUnderEnhancedOversight: false,
      performerMedicareEnrolledOrOptedOut: true,
    } as const;

    let membershipUser = "";
    let membershipOther = "";
    async function seedNote(
      patientId: string,
      admissionId: string,
      membershipId: string,
      serviceDate: string,
      signed: boolean,
    ): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO encounter (organization_id, patient_id, admission_id, encounter_type, discipline,
           authored_by_membership_id, service_date, status, signed_at, vocab_version_id)
         VALUES ($1,$2,$3,'face_to_face','md',$4,$5,$6::encounter_status,$7,
                 CASE WHEN $6 = 'draft' THEN NULL ELSE gen_random_uuid() END) RETURNING id`,
          [
            ORG_A,
            patientId,
            admissionId,
            membershipId,
            serviceDate,
            signed ? "signed" : "draft",
            signed ? new Date() : null,
          ],
        )
      ).rows[0].id as string;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'org-fy27a','A','A'), ($2,'org-fy27b','B','B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'fy27@x.test'), ($2,'fy27-md@x.test'), ($3,'fy27-att@x.test')`,
        [USER, MD, ATTENDING],
      );
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','342027','2222222027','\\x00','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      membershipUser = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG_A],
        )
      ).rows[0].id;
      membershipOther = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [MD, ORG_A],
        )
      ).rows[0].id;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      registerM5IntakeSeams(handle.db);
      svc = createDbAdmissionRouteService(
        handle.db,
        validatingM6Outbox(),
        undefined,
        {
          async belongsToOrg(organizationId: string, providerEntityId: string) {
            const { rows } = await admin.query(
              "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
              [providerEntityId, organizationId],
            );
            return rows.length > 0;
          },
        },
        undefined,
        undefined,
        undefined,
        {
          signedNoteFor: (orgId, encounterId) =>
            signedEncounterNoteForOrg(handle.db, orgId, encounterId),
        },
      );
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    describe("R-F2F-05 — telehealth modality on completion", () => {
      it("persists encounter_location + the (A)-(C) attestation for an eligible telehealth encounter", async () => {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
          encounterLocation: "telehealth",
          telehealthEligibility: ELIGIBLE,
        });
        const row = await f2fRow(f.id);
        expect(row.status).toBe("completed");
        expect(row.loc).toBe("telehealth");
        expect(row.te).toMatchObject(ELIGIBLE);
        expect(typeof row.te?.attestedAt).toBe("string");
      });

      it("persists an in-person location with no attestation", async () => {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
          encounterLocation: "patient_home",
          telehealthEligibility: null,
        });
        expect(await f2fRow(f.id)).toMatchObject({
          status: "completed",
          loc: "patient_home",
          te: null,
        });
      });

      it("refuses telehealth without the attestation, and with a disqualifying answer; row stays scheduled", async () => {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        await expect(
          svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
            encounterLocation: "telehealth",
            telehealthEligibility: null,
          }),
        ).rejects.toMatchObject({ code: "F2F_TELEHEALTH_ATTESTATION_REQUIRED", statusCode: 422 });
        await expect(
          svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
            encounterLocation: "telehealth",
            telehealthEligibility: { ...ELIGIBLE, hospiceUnderEnhancedOversight: true },
          }),
        ).rejects.toMatchObject({ code: "F2F_TELEHEALTH_NOT_PERMITTED", statusCode: 422 });
        expect((await f2fRow(f.id)).status).toBe("scheduled");
      });

      it("migration 0390's CHECK refuses an attestation on an in-person encounter", async () => {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
          encounterLocation: "patient_home",
          telehealthEligibility: null,
        });
        await expect(
          admin.query(
            `UPDATE face_to_face_encounter SET telehealth_eligibility = '{"x":1}'::jsonb WHERE id=$1`,
            [f.id],
          ),
        ).rejects.toThrow(/f2f_telehealth_eligibility_ck/);
      });
    });

    describe("R-F2F-06 — attestation via a linked signed clinical note", () => {
      async function completed() {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        const done = await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
          encounterLocation: "patient_home",
          telehealthEligibility: null,
        });
        return { ...p, f2fId: f.id, version: done.version };
      }

      it("a note signed by the performer on the encounter date attests with no narrative", async () => {
        const c = await completed();
        const note = await seedNote(
          c.patientId,
          c.admissionId,
          membershipUser,
          dayOffset(-1),
          true,
        );
        const r = await svc.attestF2f(ORG_A, c.f2fId, c.version, USER, null, note);
        expect(r.state).toBe("attested");
        expect(await f2fRow(c.f2fId)).toMatchObject({
          status: "attested",
          encounter_id: note,
          attestation_narrative: null,
        });
      });

      it.each([
        ["signed by someone other than the performer", "other", -1, true],
        ["unsigned", "user", -1, false],
        ["dated on another day", "user", -2, true],
      ] as const)("refuses a note %s", async (_label, who, day, signed) => {
        const c = await completed();
        const note = await seedNote(
          c.patientId,
          c.admissionId,
          who === "user" ? membershipUser : membershipOther,
          dayOffset(day),
          signed,
        );
        await expect(
          svc.attestF2f(ORG_A, c.f2fId, c.version, USER, null, note),
        ).rejects.toMatchObject({ code: "F2F_ATTESTATION_NOTE_INVALID", statusCode: 422 });
        expect((await f2fRow(c.f2fId)).status).toBe("completed");
      });

      it("refuses both or neither attestation source", async () => {
        const c = await completed();
        await expect(
          svc.attestF2f(ORG_A, c.f2fId, c.version, USER, null, null),
        ).rejects.toMatchObject({
          code: "F2F_ATTESTATION_SOURCE_REQUIRED",
        });
        const note = await seedNote(
          c.patientId,
          c.admissionId,
          membershipUser,
          dayOffset(-1),
          true,
        );
        await expect(
          svc.attestF2f(ORG_A, c.f2fId, c.version, USER, F2F_ATTESTATION_NARRATIVE, note),
        ).rejects.toMatchObject({ code: "F2F_ATTESTATION_SOURCE_REQUIRED" });
      });
    });

    describe("CR 14495 — the claim range context carries the telehealth F2F of a PENDING period", () => {
      it("reports the pending period's telehealth F2F (modality) for a range covering the encounter date", async () => {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
          encounterLocation: "telehealth",
          telehealthEligibility: ELIGIBLE,
        });
        const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_A, p.patientId, {
          from: dayOffset(-5),
          to: dayOffset(0),
        });
        expect(ctx).not.toBeNull();
        expect(ctx?.electionPeriods.map((e) => e.sequence)).not.toContain(3);
        expect(ctx?.faceToFace).toContainEqual({
          electionPeriodSequence: 3,
          attested: false,
          encounterDate: dayOffset(-1),
          modality: "telehealth",
        });
      });

      it("does not report a pending period's IN-PERSON F2F outside the period", async () => {
        const p = await pending3();
        await setStart(p.periodId, dayOffset(10));
        const f = await schedule(p.periodId);
        await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1), {
          encounterLocation: "patient_home",
          telehealthEligibility: null,
        });
        const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_A, p.patientId, {
          from: dayOffset(-5),
          to: dayOffset(0),
        });
        expect(ctx?.faceToFace.some((x) => x.electionPeriodSequence === 3)).toBe(false);
      });
    });
  },
);
