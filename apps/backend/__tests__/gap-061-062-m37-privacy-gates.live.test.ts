/**
 * GAP-061 + GAP-062 — M37's two fail-OPEN privacy gates, proven against real Postgres.
 *
 * Both gates lived in `37-ipu/routes/service-drizzle.ts` as constants: `roomOccupancyAllowed: true`
 * on every `assignBed`, and `consentEvaluatorResult: {}` on every visitor check-in. Neither refused
 * anything, ever. This suite drives the production route service as the NOBYPASSRLS `wardenx_app`
 * role, over the REAL M5 `PatientPrivacyFlagReader` (Drizzle) and the REAL M39 `ConsentEvaluator`
 * (Drizzle store) — no stubs on either side of the seams under test.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m37:privacy-gates:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPatientPrivacyFlagReader } from "../src/modules/05-patient/privacy-flag-reader";
import { buildDrizzleIpuRouteService } from "../src/modules/37-ipu/routes/service-drizzle";
import { createDbConsentEvaluator } from "../src/modules/39-consent/consent-store-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";
const PE = "66666666-6666-6666-6666-666666666666";

// Four patients: an M/F pair to collide, a second male to pair, and one with an UNRECORDED sex.
const P_MALE = "aaaaaaaa-0000-4000-8000-000000000001";
const P_FEMALE = "aaaaaaaa-0000-4000-8000-000000000002";
const P_MALE_2 = "aaaaaaaa-0000-4000-8000-000000000003";
const P_UNKNOWN = "aaaaaaaa-0000-4000-8000-000000000004";
const P_ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";

const actor = {
  organizationId: ORG_A,
  userId: USER,
  roles: [] as string[],
  membershipId: MEMBER,
  stepUpRecent: true,
};

describe.skipIf(!DB_URL)("M37 privacy gates — LIVE Postgres (GAP-061 + GAP-062)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof buildDrizzleIpuRouteService>;
  /** The same service with NO M5 seam bound — the unbound-seam posture check. */
  let svcUnbound: ReturnType<typeof buildDrizzleIpuRouteService>;
  let unitId: string;

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

  async function seedPatient(id: string, org: string, sex: string, mrn: string) {
    await admin.query(
      `INSERT INTO patient (id,organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
       VALUES ($1,$2,$3,'Test','Patient','1950-01-01',$4,'active')`,
      [id, org, mrn, sex],
    );
  }

  /** A room + one bed per requested label, returning the bed ids. */
  async function seedRoom(kind: string, roomNumber: string, bedLabels: string[]) {
    const roomId = (
      await admin.query(
        "INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [ORG_A, unitId, roomNumber, kind, bedLabels.length],
      )
    ).rows[0].id;
    const bedIds: string[] = [];
    for (const label of bedLabels) {
      bedIds.push(
        (
          await admin.query(
            "INSERT INTO ipu_bed (organization_id,room_id,unit_id,bed_label,cleaning_status) VALUES ($1,$2,$3,$4,'ready') RETURNING id",
            [ORG_A, roomId, unitId, label],
          )
        ).rows[0].id,
      );
    }
    return { roomId, bedIds };
  }

  let lcpSeq = 0;
  /** Open an admission and walk it to `bed_pending` (the state `assignBed` acts from). */
  async function admissionAwaitingBed(patientId: string) {
    lcpSeq += 1;
    const adm = await svc.openAdmission(actor, {
      patientId,
      admissionId: `77777777-0000-4000-8000-${String(lcpSeq).padStart(12, "0")}`,
      levelOfCarePeriodId: `88888888-0000-4000-8000-${String(lcpSeq).padStart(12, "0")}`,
      providerEntityId: PE,
      unitId,
      kind: "gip",
    });
    await svc.requestBed(actor, adm.id, { unitId });
    return adm;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    for (const [org, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ]) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m37-gates@x.test')`, [USER]);
    await seedPatient(P_MALE, ORG_A, "M", "MRN-M1");
    await seedPatient(P_FEMALE, ORG_A, "F", "MRN-F1");
    await seedPatient(P_MALE_2, ORG_A, "M", "MRN-M2");
    await seedPatient(P_UNKNOWN, ORG_A, "UNK", "MRN-U1");
    await seedPatient(P_ORG_B, ORG_B, "F", "MRN-B1");
    // M39's platform-floor catalog rows the visitor gate's two consent types FK to.
    await admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES
         ('hipaa_release','HIPAA Release','per_recipient',31536000,31536000,
          ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'hipaa_release',
          true,false,false,false,false,true,'consent_record','v1'),
         ('family_caregiver_access','Family Caregiver Access','per_recipient',31536000,31536000,
          ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'family_caregiver',
          true,false,false,false,false,true,'consent_record','v1')`,
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    svc = buildDrizzleIpuRouteService(handle.db, {
      rooming: buildPatientPrivacyFlagReader(handle.db),
      consent: createDbConsentEvaluator(handle.db),
    });
    svcUnbound = buildDrizzleIpuRouteService(handle.db);

    const unit = await svc.createUnit(actor, { facilityId: PE, displayName: "IPU 1", bedCount: 8 });
    unitId = unit.id;
    await admin.query(
      "INSERT INTO ipu_rn_coverage_window (organization_id,unit_id,hour_start_at,is_covered,rn_assignment_ids) VALUES ($1,$2,date_trunc('hour', now()),true,'{}')",
      [ORG_A, unitId],
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── GAP-061 — the shared-room occupancy gate ───────────────────────────────────────────────────

  it("REFUSES a semi-private bed whose room already holds an opposite-sex patient", async () => {
    const { bedIds } = await seedRoom("semi_private", "201", ["A", "B"]);
    const first = await admissionAwaitingBed(P_MALE);
    expect((await svc.assignBed(actor, first.id, { bedId: bedIds[0]! })).state).toBe(
      "bed_assigned",
    );

    const second = await admissionAwaitingBed(P_FEMALE);
    await expect(svc.assignBed(actor, second.id, { bedId: bedIds[1]! })).rejects.toThrow(
      /different recorded sex/i,
    );
    // The refusal is total: no assignment row, no state change, the bed stays ready.
    const assigned = await admin.query(
      "SELECT 1 FROM ipu_bed_assignment WHERE bed_id=$1 AND ended_at IS NULL",
      [bedIds[1]],
    );
    expect(assigned.rowCount).toBe(0);
    const state = await admin.query("SELECT state FROM ipu_admission WHERE id=$1", [second.id]);
    expect(state.rows[0].state).toBe("bed_pending");
    const bed = await admin.query("SELECT cleaning_status FROM ipu_bed WHERE id=$1", [bedIds[1]]);
    expect(bed.rows[0].cleaning_status).toBe("ready");
  });

  it("ADMITS the same-sex roommate into the same room (the gate is not a blanket refusal)", async () => {
    const { bedIds } = await seedRoom("semi_private", "202", ["A", "B"]);
    const first = await admissionAwaitingBed(P_MALE_2);
    await svc.assignBed(actor, first.id, { bedId: bedIds[0]! });

    // A second MALE patient — a fresh admission for P_MALE is not possible (its earlier one is live),
    // so pair the two males across the two rooms by using this room for P_MALE's next admission.
    const second = await admissionAwaitingBed(P_MALE);
    const assigned = await svc.assignBed(actor, second.id, { bedId: bedIds[1]! });
    expect(assigned.state).toBe("bed_assigned");
  });

  it("ADMITS an opposite-sex patient into a PRIVATE room (the room kind is the escape hatch)", async () => {
    const { bedIds } = await seedRoom("private", "203", ["A"]);
    const adm = await admissionAwaitingBed(P_FEMALE);
    expect((await svc.assignBed(actor, adm.id, { bedId: bedIds[0]! })).state).toBe("bed_assigned");
  });

  it("ADMITS into an EMPTY semi-private room without consulting M5 at all", async () => {
    // Same service with the M5 seam UNBOUND: an empty shared room is decided from M37's own rows, so
    // this must still succeed — the gate is not a hard dependency on M5 for the common case.
    const { bedIds } = await seedRoom("semi_private", "204", ["A", "B"]);
    const adm = await admissionAwaitingBed(P_MALE_2);
    expect((await svcUnbound.assignBed(actor, adm.id, { bedId: bedIds[0]! })).state).toBe(
      "bed_assigned",
    );
  });

  it("REFUSES an occupied shared room when the M5 seam is UNBOUND (never reads as an empty room)", async () => {
    const { bedIds } = await seedRoom("semi_private", "205", ["A", "B"]);
    const first = await admissionAwaitingBed(P_MALE);
    await svc.assignBed(actor, first.id, { bedId: bedIds[0]! });
    const second = await admissionAwaitingBed(P_MALE_2);
    await expect(svcUnbound.assignBed(actor, second.id, { bedId: bedIds[1]! })).rejects.toThrow(
      /could not be read/i,
    );
  });

  it("REFUSES a shared room when a patient's sex is UNRECORDED (`UNK` is not a match)", async () => {
    const { bedIds } = await seedRoom("semi_private", "206", ["A", "B"]);
    const first = await admissionAwaitingBed(P_MALE);
    await svc.assignBed(actor, first.id, { bedId: bedIds[0]! });
    const second = await admissionAwaitingBed(P_UNKNOWN);
    await expect(svc.assignBed(actor, second.id, { bedId: bedIds[1]! })).rejects.toThrow(
      /recorded sex/i,
    );
  });

  it("does not count a DISCHARGED roommate as an occupant (an ended assignment frees the room)", async () => {
    const { bedIds } = await seedRoom("semi_private", "207", ["A", "B"]);
    const first = await admissionAwaitingBed(P_MALE);
    await svc.assignBed(actor, first.id, { bedId: bedIds[0]! });
    await admin.query(
      "UPDATE ipu_bed_assignment SET ended_at=now() WHERE bed_id=$1 AND ended_at IS NULL",
      [bedIds[0]],
    );
    const second = await admissionAwaitingBed(P_FEMALE);
    expect((await svc.assignBed(actor, second.id, { bedId: bedIds[1]! })).state).toBe(
      "bed_assigned",
    );
  });

  it("cannot read another tenant's patient through the seam (RLS)", async () => {
    const facts = await buildPatientPrivacyFlagReader(handle.db).roomingFactsFor({
      organizationId: ORG_A,
      patientIds: [P_MALE, P_ORG_B],
    });
    expect(facts.map((f) => f.patientId)).toEqual([P_MALE]);
    expect(facts[0]?.sexClass).toBe("male");
  });

  // ── GAP-062 — the visitor consent gate ─────────────────────────────────────────────────────────

  it("admits an IMMEDIATE-FAMILY visitor with no consent record, and says so on the row", async () => {
    const { bedIds } = await seedRoom("private", "301", ["A"]);
    const adm = await admissionAwaitingBed(P_MALE_2);
    await svc.assignBed(actor, adm.id, { bedId: bedIds[0]! });

    const visitor = await svc.checkInVisitor(actor, {
      ipuAdmissionId: adm.id,
      visitorName: "A Spouse",
      relationship: "spouse",
      screeningOutcome: { feverPresent: false },
    });
    const row = await admin.query("SELECT consent_evaluator_result FROM ipu_visitor WHERE id=$1", [
      visitor.id,
    ]);
    expect(row.rows[0].consent_evaluator_result).toMatchObject({
      evaluated: false,
      reason: "immediate_family",
    });
  });

  it("REFUSES a non-immediate-family visitor with no consent on file", async () => {
    const { bedIds } = await seedRoom("private", "302", ["A"]);
    const adm = await admissionAwaitingBed(P_FEMALE);
    await svc.assignBed(actor, adm.id, { bedId: bedIds[0]! });

    await expect(
      svc.checkInVisitor(actor, {
        ipuAdmissionId: adm.id,
        visitorName: "A Friend",
        relationship: "friend",
        screeningOutcome: { feverPresent: false },
      }),
    ).rejects.toThrow(/consent/i);
    // Fail-closed means no row at all — a refused visitor is not checked in and then flagged.
    const rows = await admin.query("SELECT 1 FROM ipu_visitor WHERE ipu_admission_id=$1", [adm.id]);
    expect(rows.rowCount).toBe(0);
  });

  it("ADMITS the same visitor once an ACTIVE hipaa_release with a live recipient exists", async () => {
    const [adm] = (
      await admin.query(
        "SELECT id FROM ipu_admission WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 1",
        [P_FEMALE],
      )
    ).rows;
    const consentId = (
      await admin.query(
        `INSERT INTO consent_record (organization_id,patient_id,type_key,scope_descriptor,grantor_kind,
           effective_at,status,capture_method,capture_evidence_jsonb,created_by_id,version,
           signed_at,signed_by_id)
         VALUES ($1,$2,'hipaa_release','{}'::jsonb,'patient_self',now() - interval '1 day','active',
           'typed_signature_in_app','{}'::jsonb,$3,1,now() - interval '1 day',$3) RETURNING id`,
        [ORG_A, P_FEMALE, USER],
      )
    ).rows[0].id;
    await admin.query(
      `INSERT INTO consent_record_recipient (organization_id,consent_record_id,recipient_kind,
         recipient_free_text,recipient_resolved_display_name,added_by_id)
       VALUES ($1,$2,'free_text','A Friend','A Friend',$3)`,
      [ORG_A, consentId, USER],
    );

    const visitor = await svc.checkInVisitor(actor, {
      ipuAdmissionId: adm.id,
      visitorName: "A Friend",
      relationship: "friend",
      screeningOutcome: { feverPresent: false },
    });
    const row = await admin.query("SELECT consent_evaluator_result FROM ipu_visitor WHERE id=$1", [
      visitor.id,
    ]);
    // The stored evidence names the type that satisfied the gate and the record it resolved to —
    // `{}` was the whole artifact before GAP-062.
    expect(row.rows[0].consent_evaluator_result).toMatchObject({
      evaluated: true,
      allowed: true,
      satisfiedByConsentType: "hipaa_release",
      consentRecordId: consentId,
    });
  });

  it("REFUSES again once that consent EXPIRES (the gate reads live state, not a one-time stamp)", async () => {
    // Expiry rather than revocation: revocation needs a `consent_revocation` row for M39's own
    // `cr_revoked_consistent` CHECK, and its lifecycle is M39's suite to prove. What matters here is
    // that M37 re-asks on every check-in — a visitor admitted yesterday is not admitted forever.
    await admin.query(
      "UPDATE consent_record SET expires_at = now() - interval '1 hour' WHERE patient_id=$1",
      [P_FEMALE],
    );
    const [adm] = (
      await admin.query(
        "SELECT id FROM ipu_admission WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 1",
        [P_FEMALE],
      )
    ).rows;
    await expect(
      svc.checkInVisitor(actor, {
        ipuAdmissionId: adm.id,
        visitorName: "A Friend",
        relationship: "friend",
        screeningOutcome: { feverPresent: false },
      }),
    ).rejects.toThrow(/consent_expired/i);
  });

  it("REFUSES a non-family visitor when the M39 evaluator is UNBOUND (unreadable denies too)", async () => {
    const [adm] = (
      await admin.query(
        "SELECT id FROM ipu_admission WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 1",
        [P_FEMALE],
      )
    ).rows;
    await expect(
      svcUnbound.checkInVisitor(actor, {
        ipuAdmissionId: adm.id,
        visitorName: "A Friend",
        relationship: "friend",
        screeningOutcome: { feverPresent: false },
      }),
    ).rejects.toThrow(/consent_evaluator_unavailable/i);
  });

  it("keeps the §2.7 restriction gate ahead of the consent gate (a full block still blocks family)", async () => {
    const { bedIds } = await seedRoom("private", "303", ["A"]);
    const adm = await admissionAwaitingBed(P_UNKNOWN);
    await svc.assignBed(actor, adm.id, { bedId: bedIds[0]! });
    await svc.applyVisitorRestriction(actor, {
      scope: "patient",
      patientId: P_UNKNOWN,
      restrictionKind: "full_block",
      rationale: "active TB",
      sourceKind: "infection_preventionist",
    });
    await expect(
      svc.checkInVisitor(actor, {
        ipuAdmissionId: adm.id,
        visitorName: "A Spouse",
        relationship: "spouse",
        screeningOutcome: { feverPresent: false },
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("cannot check a visitor into another tenant's admission (RLS hides the row entirely)", async () => {
    const [adm] = (
      await admin.query(
        "SELECT id FROM ipu_admission WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 1",
        [P_FEMALE],
      )
    ).rows;
    await expect(
      svc.checkInVisitor(
        { ...actor, organizationId: ORG_B },
        {
          ipuAdmissionId: adm.id,
          visitorName: "A Spouse",
          relationship: "spouse",
          screeningOutcome: { feverPresent: false },
        },
      ),
    ).rejects.toThrow(/not found/i);
  });
});
