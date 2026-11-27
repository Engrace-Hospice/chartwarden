/**
 * M9 longitudinal wounds — the LIVE Postgres proof (migrations 1530 + 1531, the Drizzle service, the routes' read-audit,
 * the WoundProvider seam, the patient eraser step).
 *
 * Everything that makes a wound record safe is a database property, so it is proven here as the NOBYPASSRLS
 * `chartwarden_app` role (a superuser bypasses RLS and would prove nothing): tenant and patient isolation, FORCEd RLS, the
 * write-audit trigger (and the read-audit the routes emit), every CHECK constraint, the append-only observation (no UPDATE
 * of a recorded value, no hidden observation, no delete), the correction chain, and the seam that returns only the current
 * observations of one encounter.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:wounds:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createDrizzlePatientReaderStore,
  createPatientReader,
} from "../src/modules/05-patient/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { createDrizzleEncounterDraftReader } from "../src/modules/08-encounters/encounter-draft-reader";
import {
  createDbWoundService,
  createDrizzleWoundProviderStore,
  createWoundProvider,
  eraseWoundSubtree,
  registerWoundRoutes,
  woundPatientReaderOver,
} from "../src/modules/09-assessments/index";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "33333333-3333-3333-3333-333333333331";
const USER_B = "33333333-3333-3333-3333-333333333332";
const PATIENT_1 = "44444444-4444-4444-4444-444444444441";
const PATIENT_2 = "44444444-4444-4444-4444-444444444442";
const PATIENT_DESTROYED = "44444444-4444-4444-4444-4444444444d1"; // the patient eraser step's subject, and a bystander of the same organisation
const PATIENT_BYSTANDER = "44444444-4444-4444-4444-4444444444b1";
const PATIENT_B = "44444444-4444-4444-4444-4444444444e1"; // ORG_B's patient
const PATIENT_MERGED = "44444444-4444-4444-4444-4444444444a5"; // merged into PATIENT_1
const GHOST_PATIENT = "44444444-4444-4444-4444-4444444444ff"; // a well-formed uuid that names no patient anywhere
const ENCOUNTER_1 = "55555555-5555-5555-5555-555555555551";
const ENCOUNTER_2 = "55555555-5555-5555-5555-555555555552";
const PG_CHECK_VIOLATION = "23514";
const PG_INSUFFICIENT_PRIVILEGE = "42501";
const PG_FK_VIOLATION = "23503";

type PgError = { code?: string; message?: string };
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return (e as PgError).code;
  }
}

describe.skipIf(!DB_URL)("M9 longitudinal wounds — LIVE Postgres", () => {
  let admin: Client;
  let appA: Client; // chartwarden_app, app.org_id = ORG_A
  let appB: Client; // chartwarden_app, app.org_id = ORG_B
  let handle: ReturnType<typeof createDbClient>;
  let adminHandle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbWoundService>;
  let membershipA = "";
  let membershipB = "";
  /** A second clinician of ORG_A, who writes visit notes the first may not tie an observation to. */
  let membershipA2 = "";
  const actorA = () => ({ organizationId: ORG_A, userId: USER_A, membershipId: membershipA });
  const actorB = () => ({ organizationId: ORG_B, userId: USER_B, membershipId: membershipB });

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  async function appClient(org: string): Promise<Client> {
    const client = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await client.connect();
    await client.query("SELECT set_config('app.org_id', $1, false)", [org]);
    return client;
  }
  /** One `encounter` row (M8's table; the wound record only holds its id). `finalized` needs the vocabulary pin its CHECK demands. */
  async function insertEncounter(
    id: string,
    patientId: string,
    authoredBy: string,
    status: "draft" | "finalized" = "draft",
    encounterType: "routine_visit" | "telephonic" = "routine_visit",
  ): Promise<void> {
    await admin.query(
      `INSERT INTO encounter (id, organization_id, patient_id, admission_id, encounter_type, discipline, authored_by_membership_id, service_date, status, vocab_version_id)
       VALUES ($1,$2,$3,$4,$8,'rn',$5,'2026-11-19',$6,$7)`,
      [
        id,
        ORG_A,
        patientId,
        randomUUID(),
        authoredBy,
        status,
        status === "draft" ? null : randomUUID(),
        encounterType,
      ],
    );
  }

  async function membership(org: string, user: string): Promise<string> {
    return (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [user, org],
      )
    ).rows[0].id as string;
  }

  /** A wound row straight through SQL as the app role (the CHECK / trigger proofs go below the service). */
  async function rawWound(
    client: Client,
    org: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      organization_id: org,
      patient_id: PATIENT_1,
      site_code: "heel",
      laterality: "left",
      etiology: "pressure_injury",
      created_by_membership_id: org === ORG_A ? membershipA : membershipB,
      ...over,
    };
    const cols = Object.keys(row);
    const { rows } = await client.query(
      `INSERT INTO wound (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
      Object.values(row),
    );
    return rows[0].id as string;
  }
  async function rawObservation(
    client: Client,
    org: string,
    woundId: string,
    over: Record<string, unknown> = {},
    patient = PATIENT_1,
  ): Promise<string> {
    const row = {
      organization_id: org,
      wound_id: woundId,
      patient_id: patient,
      observed_at: "2026-11-10T10:00:00Z",
      observed_by_membership_id: org === ORG_A ? membershipA : membershipB,
      ...over,
    };
    const cols = Object.keys(row);
    const { rows } = await client.query(
      `INSERT INTO wound_observation (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
      Object.values(row),
    );
    return rows[0].id as string;
  }
  const auditEvents = async (eventType: string, org = ORG_A) =>
    (
      await admin.query(
        `SELECT event_type, resource_id::text AS resource_id, actor_user_id::text AS actor_user_id, context, after
           FROM audit_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at`,
        [org, eventType],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wound-a','A','A'),($2,'wound-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'wound-a@x.test'),($2,'wound-b@x.test')`,
      [USER_A, USER_B],
    );
    membershipA = await membership(ORG_A, USER_A);
    membershipB = await membership(ORG_B, USER_B);
    membershipA2 = await membership(ORG_A, USER_B);
    // The patients the wounds below are registered for (CW-AC-54: a wound needs a patient of its own organisation), and one of the other tenant.
    for (const [id, org, mrn] of [
      [PATIENT_1, ORG_A, "WND-A1"],
      [PATIENT_2, ORG_A, "WND-A2"],
      [PATIENT_DESTROYED, ORG_A, "WND-A3"],
      [PATIENT_BYSTANDER, ORG_A, "WND-A4"],
      [PATIENT_B, ORG_B, "WND-B1"],
    ] as const) {
      await admin.query(
        "INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status) VALUES ($1,$2,$3,'Test','Patient','1950-01-01','F','active')",
        [id, org, mrn],
      );
    }
    // The visits the seam-bound observations below are tied to: the clinician's own open notes (M8's real reader answers for them).
    await insertEncounter(ENCOUNTER_1, PATIENT_2, membershipA);
    await insertEncounter(ENCOUNTER_2, PATIENT_2, membershipA);
    appA = await appClient(ORG_A);
    appB = await appClient(ORG_B);
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    adminHandle = createDbClient({ connectionString: DB_URL as string }); // privileged: the destruction path
    svc = createDbWoundService(handle.db, {
      now: () => new Date("2026-11-19T15:00:00.000Z"),
      // The REAL M8 reader over the app role, as the composition root registers it: every visit-tied write below is checked against `encounter`.
      visits: createDrizzleEncounterDraftReader(handle.db),
      // The REAL M5 reader over the app role, as the composition root registers it: a wound is registered only for a patient `patient` holds for the org.
      patients: woundPatientReaderOver(
        createPatientReader(createDrizzlePatientReaderStore(handle.db)),
      ),
    });
  }, 240_000);

  afterAll(async () => {
    await appA?.end();
    await appB?.end();
    await handle?.close();
    await adminHandle?.close();
    if (admin) await admin.end();
  });

  // ── structure ──────────────────────────────────────────────────────────────────────────────────────────────────
  describe("row-level security", () => {
    it("is enabled AND forced on both tables", async () => {
      const { rows } = await admin.query(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('wound','wound_observation') ORDER BY relname",
      );
      expect(rows).toEqual([
        { relname: "wound", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "wound_observation", relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });

    it("hides another organisation's rows, and refuses a write into one, as the app role", async () => {
      // Arrange
      const woundA = await rawWound(appA, ORG_A);
      const obsA = await rawObservation(appA, ORG_A, woundA);
      const woundB = await rawWound(appB, ORG_B);
      // Act
      const seenByB = {
        wounds: (await appB.query("SELECT id FROM wound")).rows.map((r) => r.id),
        observations: (await appB.query("SELECT id FROM wound_observation")).rows.map((r) => r.id),
      };
      const crossWrite = await pgCode(rawWound(appA, ORG_B));
      const crossObservation = await pgCode(rawObservation(appA, ORG_B, woundB));
      // Assert
      expect(seenByB.wounds).toEqual([woundB]);
      expect(seenByB.observations).not.toContain(obsA);
      expect(crossWrite).toBe(PG_INSUFFICIENT_PRIVILEGE);
      expect(crossObservation).toBe(PG_INSUFFICIENT_PRIVILEGE);
    });

    it("sees nothing at all without an organisation in scope", async () => {
      const bare = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await bare.connect();
      try {
        expect((await bare.query("SELECT id FROM wound")).rows).toEqual([]);
        expect((await bare.query("SELECT id FROM wound_observation")).rows).toEqual([]);
      } finally {
        await bare.end();
      }
    });

    it("lets an observation name only a wound of its own patient and organisation", async () => {
      const wound = await rawWound(appA, ORG_A);
      // another patient's id on an observation of this wound: the composite FK refuses it
      expect(await pgCode(rawObservation(appA, ORG_A, wound, {}, PATIENT_2))).toBe(PG_FK_VIOLATION);
    });
  });

  // ── the routes' read-audit and the trigger's write-audit ───────────────────────────────────────────────────────
  describe("audit", () => {
    it("records every write with the acting user, and the reads the routes make", async () => {
      // Arrange: the real middleware chain (permissions + caseload scope) over the Drizzle service, audit emission on
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          {
            orgId: ORG_A,
            userId: USER_A,
            grants: [
              {
                roleKey: "seed",
                enabled: true,
                expiresAt: null,
                permissionKeys: ["assessment.read", "assessment.author", "assessment.amend"],
              },
            ],
          },
        ]).store,
      );
      const registry = createPredicateRegistry();
      registry.register(
        "caseload_or_scope",
        buildCarePlanAbacPredicates({
          resolver: {
            loadPlan: async () => null,
            loadProblem: async () => null,
            loadVersion: async () => null,
          },
          isInCaseload: async () => true,
        }).caseload_or_scope,
      );
      registerAbacRegistry(registry);
      const headerAuth = (request: FastifyRequest): void => {
        request.context.userId = USER_A;
        request.context.organizationId = ORG_A;
        request.context.attributes.membershipId = membershipA;
        request.context.roles = ["rn"];
      };
      const app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerWoundRoutes(app, { service: svc });
      await app.ready();
      try {
        await admin.query("DELETE FROM audit_event WHERE organization_id=$1", [ORG_A]);
        const base = `/api/v1/patients/${PATIENT_2}/wounds`;
        // Act: create, observe, correct, resolve, then read the list and the detail
        const created = await app.inject({
          method: "POST",
          url: base,
          headers: { "idempotency-key": randomUUID() },
          payload: { siteCode: "sacrum", laterality: "midline", etiology: "pressure_injury" },
        });
        const woundId = created.json().id as string;
        const observed = await app.inject({
          method: "POST",
          url: `${base}/${woundId}/observations`,
          headers: { "idempotency-key": randomUUID() },
          payload: { lengthCm: 4, widthCm: 3, stage: "stage_2", painScore: 4 },
        });
        const corrected = await app.inject({
          method: "POST",
          url: `${base}/${woundId}/observations/${observed.json().id}/corrections`,
          headers: { "if-match": "1", "idempotency-key": randomUUID() },
          payload: {
            lengthCm: 4.5,
            widthCm: 3,
            stage: "stage_2",
            correctionReason: "measurement_error",
          },
        });
        const resolved = await app.inject({
          method: "POST",
          url: `${base}/${woundId}/resolve`,
          payload: { status: "healed" },
        });
        const list = await app.inject({ method: "GET", url: base });
        const detail = await app.inject({ method: "GET", url: `${base}/${woundId}` });
        // Assert: the requests worked
        expect([
          created.statusCode,
          observed.statusCode,
          corrected.statusCode,
          resolved.statusCode,
        ]).toEqual([201, 201, 201, 200]);
        expect([list.statusCode, detail.statusCode]).toEqual([200, 200]);
        // writes: the trigger audit rows, attributed to the user
        for (const type of ["wound.insert", "wound.update", "wound_observation.insert"]) {
          const events = await auditEvents(type);
          expect(events.length, type).toBeGreaterThan(0);
          for (const e of events) expect(e.actor_user_id, type).toBe(USER_A);
        }
        expect((await auditEvents("wound_observation.insert")).length).toBe(2); // the original and its correction
        expect((await auditEvents("wound_observation.update")).length).toBe(1); // the supersede flip
        // reads: the list names the patient, the detail names the wound (resourceIdParam) and the patient
        const listed = await auditEvents("wound.list_viewed");
        const viewed = await auditEvents("wound.viewed");
        expect(listed).toHaveLength(1);
        expect((listed[0]?.context as { patientId?: string }).patientId).toBe(PATIENT_2);
        expect(viewed).toHaveLength(1);
        expect(viewed[0]?.resource_id).toBe(woundId);
        expect((viewed[0]?.context as { patientId?: string }).patientId).toBe(PATIENT_2);
        // PHI discipline: the write-audit snapshot of an observation carries coded values only
        const snapshot = (await auditEvents("wound_observation.insert"))[0]?.after as Record<
          string,
          unknown
        >;
        expect(snapshot.stage).toBe("stage_2");
      } finally {
        await app.close();
        resetAuthorizationContract();
        resetRbacEngine();
        resetAbacRegistry();
      }
    });
  });

  // ── constraints ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("CHECK constraints", () => {
    it.each([
      ["a site outside the vocabulary", { site_code: "elbow_pit" }],
      ["a laterality outside the vocabulary", { laterality: "upper" }],
      ["an etiology outside the vocabulary", { etiology: "bedsore" }],
      ["an acquired value outside the vocabulary", { acquired: "maybe" }],
      ["a status outside the vocabulary", { status: "gone", closed_on: "2026-11-01" }],
      ["a closed wound with no close date", { status: "healed" }],
      ["an open wound with a close date", { closed_on: "2026-11-01" }],
      [
        "a close date before the onset",
        { onset_on: "2026-11-05", status: "healed", closed_on: "2026-11-01" },
      ],
    ])("wound: rejects %s", async (_name, over) => {
      expect(await pgCode(rawWound(appA, ORG_A, over))).toBe(PG_CHECK_VIOLATION);
    });

    it.each([
      ["a stage outside the vocabulary", { stage: "stage_5" }],
      ["a negative length", { length_cm: -0.1 }],
      ["a width past the bound", { width_cm: 100.1, length_cm: 1 }],
      ["a depth past the bound", { depth_cm: 30.1, length_cm: 1, width_cm: 1 }],
      ["a depth without a length and width", { depth_cm: 1 }],
      ["an unknown wound bed tissue", { wound_bed: ["granulation", "pus"] }],
      ["a repeated wound bed tissue", { wound_bed: ["slough", "slough"] }],
      ["a NULL wound bed element", { wound_bed: ["slough", null] }],
      ["an unknown exudate amount", { exudate_amount: "lots" }],
      ["an unknown exudate type", { exudate_type: "green" }],
      ["an unknown odor", { odor: "fruity" }],
      ["an unknown periwound condition", { periwound: ["red"] }],
      ["a repeated periwound condition", { periwound: ["warm", "warm"] }],
      ["intact periwound skin with another finding", { periwound: ["intact", "erythema"] }],
      ["a pain score of 11", { pain_score: 11 }],
      ["a negative pain score", { pain_score: -1 }],
      ["an unknown dressing", { dressing: "duct_tape" }],
      ["a dressing change with no dressing", { dressing_changed: true }],
      ["an unknown trend", { trend: "sideways" }],
      ["a status outside the vocabulary", { status: "deleted" }],
      ["a free-text correction reason", { correction_reason: "I typed the wrong number" }],
      ["a version of 0", { version: 0 }],
    ])("observation: rejects %s", async (_name, over) => {
      // Arrange: a pressure injury, so a stage alone would be legitimate
      const wound = await rawWound(appA, ORG_A);
      // Act + Assert
      expect(await pgCode(rawObservation(appA, ORG_A, wound, over))).toBe(PG_CHECK_VIOLATION);
    });

    it("observation: accepts the full coded shape", async () => {
      const wound = await rawWound(appA, ORG_A);
      await expect(
        rawObservation(appA, ORG_A, wound, {
          stage: "stage_3",
          length_cm: 4.2,
          width_cm: 3.1,
          depth_cm: 0.8,
          undermining: true,
          wound_bed: ["granulation", "slough"],
          exudate_amount: "moderate",
          exudate_type: "serous",
          odor: "mild",
          periwound: ["erythema", "warm"],
          pain_score: 4,
          dressing: "foam",
          dressing_changed: true,
          infection_signs: false,
          trend: "improving",
        }),
      ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it("observation: only a pressure injury carries a stage", async () => {
      const venous = await rawWound(appA, ORG_A, {
        site_code: "calf_shin",
        etiology: "venous_ulcer",
      });
      expect(await pgCode(rawObservation(appA, ORG_A, venous, { stage: "stage_2" }))).toBe(
        PG_CHECK_VIOLATION,
      );
      await expect(
        rawObservation(appA, ORG_A, venous, { length_cm: 2, width_cm: 1 }),
      ).resolves.toBeDefined();
    });

    it("observation: a new row is active, version 1", async () => {
      const wound = await rawWound(appA, ORG_A);
      expect(await pgCode(rawObservation(appA, ORG_A, wound, { status: "superseded" }))).toBe(
        PG_CHECK_VIOLATION,
      );
      expect(await pgCode(rawObservation(appA, ORG_A, wound, { version: 3 }))).toBe(
        PG_CHECK_VIOLATION,
      );
    });
  });

  // ── append-only ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("append-only observation", () => {
    it("refuses to UPDATE a recorded value, as the app role (no grant) and as a superuser (guard trigger)", async () => {
      const wound = await rawWound(appA, ORG_A);
      const obs = await rawObservation(appA, ORG_A, wound, { length_cm: 3, width_cm: 2 });
      expect(
        await pgCode(appA.query("UPDATE wound_observation SET length_cm = 1 WHERE id=$1", [obs])),
      ).toBe(PG_INSUFFICIENT_PRIVILEGE);
      expect(
        await pgCode(admin.query("UPDATE wound_observation SET length_cm = 1 WHERE id=$1", [obs])),
      ).toBe(PG_CHECK_VIOLATION);
      expect(
        await pgCode(admin.query("UPDATE wound_observation SET trend = 'new' WHERE id=$1", [obs])),
      ).toBe(PG_CHECK_VIOLATION);
      const { rows } = await admin.query(
        "SELECT length_cm::float AS length_cm, status, version FROM wound_observation WHERE id=$1",
        [obs],
      );
      expect(rows[0]).toEqual({ length_cm: 3, status: "active", version: 1 });
    });

    it("refuses to hide an observation: the supersede flip is only the correction's own trigger", async () => {
      const wound = await rawWound(appA, ORG_A);
      const obs = await rawObservation(appA, ORG_A, wound);
      const flip =
        "UPDATE wound_observation SET status='superseded', version=version+1 WHERE id=$1";
      expect(await pgCode(appA.query(flip, [obs]))).toBe(PG_CHECK_VIOLATION);
      expect(await pgCode(admin.query(flip, [obs]))).toBe(PG_CHECK_VIOLATION);
      expect(
        await pgCode(
          admin.query(
            "UPDATE wound_observation SET status='active', version=version+1 WHERE id=$1",
            [obs],
          ),
        ),
      ).toBe(PG_CHECK_VIOLATION);
    });

    it("has no DELETE for the app role", async () => {
      const wound = await rawWound(appA, ORG_A);
      const obs = await rawObservation(appA, ORG_A, wound);
      expect(await pgCode(appA.query("DELETE FROM wound_observation WHERE id=$1", [obs]))).toBe(
        PG_INSUFFICIENT_PRIVILEGE,
      );
      expect(await pgCode(appA.query("DELETE FROM wound WHERE id=$1", [wound]))).toBe(
        PG_INSUFFICIENT_PRIVILEGE,
      );
    });

    it("a correction row flips the one it corrects; the original keeps its values", async () => {
      // Arrange
      const wound = await rawWound(appA, ORG_A);
      const original = await rawObservation(appA, ORG_A, wound, { length_cm: 5, width_cm: 2 });
      // Act
      const correction = await rawObservation(appA, ORG_A, wound, {
        length_cm: 4.5,
        width_cm: 2,
        corrects_observation_id: original,
        correction_reason: "measurement_error",
      });
      // Assert
      const { rows } = await admin.query(
        "SELECT id, status, version, length_cm::float AS length_cm FROM wound_observation WHERE id = ANY($1) ORDER BY version DESC",
        [[original, correction]],
      );
      expect(rows).toEqual([
        { id: original, status: "superseded", version: 2, length_cm: 5 },
        { id: correction, status: "active", version: 1, length_cm: 4.5 },
      ]);
    });

    it("a correction needs an active target in the same wound", async () => {
      const wound = await rawWound(appA, ORG_A);
      const other = await rawWound(appA, ORG_A, { site_code: "knee" });
      const original = await rawObservation(appA, ORG_A, wound);
      const reason = { correction_reason: "other" };
      // another wound's observation
      expect(
        await pgCode(
          rawObservation(appA, ORG_A, other, { corrects_observation_id: original, ...reason }),
        ),
      ).toBe(PG_CHECK_VIOLATION);
      // an already corrected one
      await rawObservation(appA, ORG_A, wound, { corrects_observation_id: original, ...reason });
      expect(
        await pgCode(
          rawObservation(appA, ORG_A, wound, { corrects_observation_id: original, ...reason }),
        ),
      ).toBe(PG_CHECK_VIOLATION);
      // itself
      expect(
        await pgCode(
          admin.query(
            "INSERT INTO wound_observation (id, organization_id, wound_id, patient_id, observed_at, observed_by_membership_id, corrects_observation_id, correction_reason) VALUES ('99999999-9999-4999-8999-999999999999',$1,$2,$3,now(),$4,'99999999-9999-4999-8999-999999999999','other')",
            [ORG_A, wound, PATIENT_1, membershipA],
          ),
        ),
      ).toBe(PG_CHECK_VIOLATION);
    });
  });

  describe("wound lifecycle in the database", () => {
    it("closes one way only, and never changes identity", async () => {
      const wound = await rawWound(appA, ORG_A);
      expect(
        await pgCode(appA.query("UPDATE wound SET site_code='knee' WHERE id=$1", [wound])),
      ).toBe(PG_INSUFFICIENT_PRIVILEGE);
      expect(
        await pgCode(admin.query("UPDATE wound SET site_code='knee' WHERE id=$1", [wound])),
      ).toBe(PG_CHECK_VIOLATION);
      await appA.query("UPDATE wound SET status='healed', closed_on='2026-11-18' WHERE id=$1", [
        wound,
      ]);
      expect(
        await pgCode(
          appA.query("UPDATE wound SET status='open', closed_on=NULL WHERE id=$1", [wound]),
        ),
      ).toBe(PG_CHECK_VIOLATION);
      expect(
        await pgCode(appA.query("UPDATE wound SET status='resolved_other' WHERE id=$1", [wound])),
      ).toBe(PG_CHECK_VIOLATION);
    });
  });

  // ── the service as the app role ────────────────────────────────────────────────────────────────────────────────
  describe("service", () => {
    it("registers a wound, records and corrects observations, resolves it, and keeps tenants and patients apart", async () => {
      // Arrange
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "left",
        etiology: "pressure_injury",
        acquired: "acquired_in_care",
        onsetOn: "2026-11-01",
      });
      // Act
      const first = await svc.recordObservation(actorA(), PATIENT_1, wound.id, {
        observedAt: "2026-11-10T10:00:00.000Z",
        lengthCm: 4,
        widthCm: 2.5,
        stage: "stage_3",
        woundBed: ["slough"],
        periwound: ["erythema"],
      });
      const second = await svc.recordObservation(actorA(), PATIENT_1, wound.id, {
        observedAt: "2026-11-17T10:00:00.000Z",
        lengthCm: 3,
        widthCm: 2.5,
        stage: "stage_3",
      });
      const corrected = await svc.correctObservation(actorA(), PATIENT_1, wound.id, second.id, 1, {
        observedAt: "2026-11-17T10:00:00.000Z",
        lengthCm: 2.5,
        widthCm: 2.5,
        stage: "stage_3",
        correctionReason: "measurement_error",
      });
      const detail = await svc.getWound(ORG_A, PATIENT_1, wound.id, { includeSuperseded: false });
      const withHistory = await svc.getWound(ORG_A, PATIENT_1, wound.id, {
        includeSuperseded: true,
      });
      // Assert: ordering, computed measures, the correction chain
      expect(wound).toMatchObject({
        site: "left heel",
        status: "open",
        acquired: "acquired_in_care",
        onsetOn: "2026-11-01",
      });
      expect(first).toMatchObject({
        areaCm2: 10,
        areaChangePercent: null,
        status: "active",
        version: 1,
      });
      expect(corrected).toMatchObject({
        correctsObservationId: second.id,
        correctionReason: "measurement_error",
        areaCm2: 6.25,
        areaChangePercent: -37.5,
      });
      expect(detail.observations.map((o) => o.id)).toEqual([corrected.id, first.id]);
      // the correction keeps the corrected row's observed time, so the pair is ordered by id; the older one is last
      expect(withHistory.observations.map((o) => o.id).sort()).toEqual(
        [corrected.id, second.id, first.id].sort(),
      );
      expect(withHistory.observations.at(-1)?.id).toBe(first.id);
      expect(withHistory.observations.find((o) => o.id === second.id)).toMatchObject({
        status: "superseded",
        version: 2,
        lengthCm: 3,
      });
      // the chart list shows the latest current observation
      const listed = await svc.listWounds(ORG_A, PATIENT_1, "open");
      expect(listed.wounds.find((w) => w.id === wound.id)?.latestObservation?.id).toBe(
        corrected.id,
      );
      // isolation: another organisation and another patient see nothing of it
      await expect(
        svc.getWound(ORG_B, PATIENT_1, wound.id, { includeSuperseded: false }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        svc.getWound(ORG_A, PATIENT_2, wound.id, { includeSuperseded: false }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.recordObservation(actorB(), PATIENT_1, wound.id, {})).rejects.toMatchObject({
        statusCode: 404,
      });
      expect((await svc.listWounds(ORG_B, PATIENT_1, "all")).wounds.map((w) => w.id)).not.toContain(
        wound.id,
      );
      // stale and repeated corrections
      await expect(
        svc.correctObservation(actorA(), PATIENT_1, wound.id, first.id, 7, {
          correctionReason: "other",
        }),
      ).rejects.toMatchObject({ code: "STALE_VERSION", statusCode: 409 });
      await expect(
        svc.correctObservation(actorA(), PATIENT_1, wound.id, second.id, 2, {
          correctionReason: "other",
        }),
      ).rejects.toMatchObject({ code: "CORRECTION_TARGET_NOT_ACTIVE", statusCode: 409 });
      // resolve, then nothing more is observed
      const closed = await svc.resolveWound(actorA(), PATIENT_1, wound.id, {
        status: "healed",
        closedOn: "2026-11-18",
      });
      expect(closed).toMatchObject({ status: "healed", closedOn: "2026-11-18" });
      await expect(svc.recordObservation(actorA(), PATIENT_1, wound.id, {})).rejects.toMatchObject({
        code: "WOUND_NOT_OPEN",
        statusCode: 409,
      });
      await expect(
        svc.resolveWound(actorA(), PATIENT_1, wound.id, { status: "healed" }),
      ).rejects.toMatchObject({ code: "WOUND_NOT_OPEN" });
    });

    it("applies the domain rules before anything is written", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "calf_shin",
        laterality: "right",
        etiology: "venous_ulcer",
      });
      const before = Number(
        (await admin.query("SELECT count(*)::int AS n FROM wound_observation")).rows[0].n,
      );
      await expect(
        svc.recordObservation(actorA(), PATIENT_1, wound.id, { stage: "stage_2" }),
      ).rejects.toMatchObject({ code: "WOUND_STAGE_NOT_APPLICABLE", statusCode: 422 });
      await expect(
        svc.createWound(actorA(), PATIENT_1, {
          siteCode: "sacrum",
          laterality: "left",
          etiology: "surgical",
        }),
      ).rejects.toMatchObject({ code: "WOUND_SITE_LATERALITY_MISMATCH", statusCode: 422 });
      expect(
        Number((await admin.query("SELECT count(*)::int AS n FROM wound_observation")).rows[0].n),
      ).toBe(before);
    });

    // CW-AC-54: `wound.patient_id` has no foreign key and the route authorises on assessment.author + the caseload predicate alone, so the
    // service is what ties a wound to a patient that exists in the caller's own organisation (M5's PatientReader seam, the real reader here).
    describe("a wound is registered only for a patient of the caller's own organisation", () => {
      const WOUND = { siteCode: "heel", laterality: "left", etiology: "surgical" } as const;
      const woundCountFor = async (...patientIds: string[]): Promise<number> =>
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM wound WHERE patient_id = ANY($1::uuid[])",
              [patientIds],
            )
          ).rows[0].n,
        );

      it("refuses a uuid that names no patient and another tenant's patient with the same 404, and stores nothing", async () => {
        const before = await woundCountFor(GHOST_PATIENT, PATIENT_B, PATIENT_1);
        await expect(svc.createWound(actorA(), GHOST_PATIENT, WOUND)).rejects.toMatchObject({
          statusCode: 404,
          code: "NOT_FOUND",
        });
        // ORG_B's patient, asked for by ORG_A: RLS hides the row, so it answers exactly like the absent one
        await expect(svc.createWound(actorA(), PATIENT_B, WOUND)).rejects.toMatchObject({
          statusCode: 404,
          code: "NOT_FOUND",
        });
        // and the other way round: ORG_A's patient is nothing to ORG_B
        await expect(svc.createWound(actorB(), PATIENT_1, WOUND)).rejects.toMatchObject({
          statusCode: 404,
          code: "NOT_FOUND",
        });
        expect(await woundCountFor(GHOST_PATIENT, PATIENT_B, PATIENT_1)).toBe(before);
      });

      it("registers a wound for each organisation's own patient (the control for the refusals)", async () => {
        const mine = await svc.createWound(actorA(), PATIENT_1, WOUND);
        const theirs = await svc.createWound(actorB(), PATIENT_B, WOUND);
        const stored = await admin.query(
          "SELECT id::text, organization_id::text AS org, patient_id::text AS patient FROM wound WHERE id = ANY($1::uuid[]) ORDER BY organization_id",
          [[mine.id, theirs.id]],
        );
        expect(stored.rows).toEqual([
          { id: mine.id, org: ORG_A, patient: PATIENT_1 },
          { id: theirs.id, org: ORG_B, patient: PATIENT_B },
        ]);
      });

      it("registers a wound for an existing patient asked for under an uppercase id (the route's uuid format is case-insensitive): not a false 404, stored in lowercase", async () => {
        expect(PATIENT_B.toUpperCase()).not.toBe(PATIENT_B); // an id with hex letters, so the case really differs
        const wound = await svc.createWound(actorB(), PATIENT_B.toUpperCase(), WOUND);
        const stored = await admin.query(
          "SELECT patient_id::text AS patient FROM wound WHERE id = $1",
          [wound.id],
        );
        expect(stored.rows).toEqual([{ patient: PATIENT_B }]);
      });

      it("refuses a patient merged into another (M5 answers with the survivor): no wound is filed under the retired id", async () => {
        await admin.query(
          "INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status, merged_into_id) VALUES ($1,$2,'WND-A5','Test','Merged','1950-01-01','F','merged',$3)",
          [PATIENT_MERGED, ORG_A, PATIENT_1],
        );
        await expect(svc.createWound(actorA(), PATIENT_MERGED, WOUND)).rejects.toMatchObject({
          statusCode: 404,
        });
        expect(await woundCountFor(PATIENT_MERGED)).toBe(0);
        // the survivor itself is a patient like any other
        await expect(svc.createWound(actorA(), PATIENT_1, WOUND)).resolves.toMatchObject({
          patientId: PATIENT_1,
        });
      });

      it("an unbound PatientReader refuses the write with a server error (never the 404 of an absent patient, never a pass) and stores nothing", async () => {
        const unwired = createDbWoundService(handle.db, {
          now: () => new Date("2026-11-19T15:00:00.000Z"),
        });
        const before = await woundCountFor(PATIENT_1);
        // an existing patient, so only the unbound seam can refuse: a server error (never the 404 of an absent patient, never a pass)
        const failure = await unwired.createWound(actorA(), PATIENT_1, WOUND).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toMatchObject({ statusCode: 404 });
        expect(await woundCountFor(PATIENT_1)).toBe(before);
      });

      it("the refused patients' ids are not echoed beyond what the caller sent, and nothing about the other tenant leaks", async () => {
        const refusal = await svc.createWound(actorA(), PATIENT_B, WOUND).then(
          () => null,
          (error: unknown) => error as Error,
        );
        expect(refusal).not.toBeNull();
        expect(JSON.stringify(refusal?.message)).not.toContain("WND-B1");
        expect(JSON.stringify(refusal?.message)).not.toContain(ORG_B);
      });
    });
  });

  // ── the seam the visit note reads ──────────────────────────────────────────────────────────────────────────────
  describe("WoundProvider seam", () => {
    it("returns only the current observations recorded at the encounter, in order, within its organisation", async () => {
      // Arrange: two wounds of one patient, observed at two encounters
      const heel = await svc.createWound(actorA(), PATIENT_2, {
        siteCode: "heel",
        laterality: "left",
        etiology: "pressure_injury",
      });
      const sacrum = await svc.createWound(actorA(), PATIENT_2, {
        siteCode: "sacrum",
        laterality: "midline",
        etiology: "pressure_injury",
      });
      const lateHeel = await svc.recordObservation(actorA(), PATIENT_2, heel.id, {
        observedAt: "2026-11-19T14:00:00.000Z",
        sourceEncounterId: ENCOUNTER_1,
        lengthCm: 3,
        widthCm: 2,
        stage: "stage_2",
        dressing: "foam",
        dressingChanged: true,
      });
      const sacrumObs = await svc.recordObservation(actorA(), PATIENT_2, sacrum.id, {
        observedAt: "2026-11-19T13:00:00.000Z",
        sourceEncounterId: ENCOUNTER_1,
        stage: "stage_3",
        woundBed: ["granulation", "slough"],
        painScore: 5,
        trend: "worsening",
      });
      const wrongOne = await svc.recordObservation(actorA(), PATIENT_2, heel.id, {
        observedAt: "2026-11-19T12:00:00.000Z",
        sourceEncounterId: ENCOUNTER_1,
        lengthCm: 9,
        widthCm: 9,
      });
      const fixed = await svc.correctObservation(actorA(), PATIENT_2, heel.id, wrongOne.id, 1, {
        observedAt: "2026-11-19T12:00:00.000Z",
        lengthCm: 2,
        widthCm: 2,
        correctionReason: "measurement_error",
      });
      await svc.recordObservation(actorA(), PATIENT_2, heel.id, {
        observedAt: "2026-11-18T09:00:00.000Z",
        sourceEncounterId: ENCOUNTER_2,
        painScore: 1,
      });
      await svc.recordObservation(actorA(), PATIENT_2, heel.id, {
        observedAt: "2026-11-18T10:00:00.000Z",
        painScore: 2,
      }); // no encounter
      const provider = createWoundProvider(createDrizzleWoundProviderStore(handle.db));
      // Act
      const atOne = await provider.listObservationsForEncounter(ORG_A, ENCOUNTER_1, {
        userId: USER_A,
      });
      // Assert: current only (the corrected original is gone, its correction is in), ordered by observed time
      expect(atOne.map((o) => o.observationId)).toEqual([fixed.id, sacrumObs.id, lateHeel.id]);
      expect(atOne.map((o) => o.observedAt)).toEqual([
        "2026-11-19T12:00:00.000Z",
        "2026-11-19T13:00:00.000Z",
        "2026-11-19T14:00:00.000Z",
      ]);
      // the view mirrors the note contract, the site as its display phrase, numerics as numbers
      expect(atOne[2]).toEqual({
        observationId: lateHeel.id,
        woundId: heel.id,
        observedAt: "2026-11-19T14:00:00.000Z",
        site: "left heel",
        etiology: "pressure_injury",
        stage: "stage_2",
        lengthCm: 3,
        widthCm: 2,
        depthCm: null,
        undermining: null,
        woundBed: [],
        exudateAmount: null,
        exudateType: null,
        odor: null,
        periwound: [],
        painScore: null,
        dressing: "foam",
        dressingChanged: true,
        infectionSigns: null,
        trend: null,
      });
      expect(atOne[1]).toMatchObject({
        site: "sacrum",
        woundBed: ["granulation", "slough"],
        painScore: 5,
        trend: "worsening",
      });
      // the other encounter, an unknown one and another organisation get their own (or nothing)
      expect(
        (await provider.listObservationsForEncounter(ORG_A, ENCOUNTER_2, { userId: USER_A })).map(
          (o) => o.painScore,
        ),
      ).toEqual([1]);
      expect(
        await provider.listObservationsForEncounter(ORG_A, "55555555-5555-5555-5555-5555555555ff", {
          userId: USER_A,
        }),
      ).toEqual([]);
      expect(
        await provider.listObservationsForEncounter(ORG_B, ENCOUNTER_1, { userId: USER_B }),
      ).toEqual([]);
      // narrowed to the encounter's patient: another patient's id returns none
      expect(
        await provider.listObservationsForEncounter(
          ORG_A,
          ENCOUNTER_1,
          { userId: USER_A },
          { patientId: PATIENT_1 },
        ),
      ).toEqual([]);
      expect(
        (
          await provider.listObservationsForEncounter(
            ORG_A,
            ENCOUNTER_1,
            { userId: USER_A },
            { patientId: PATIENT_2 },
          )
        ).length,
      ).toBe(3);
      // fail closed on a blank scope
      await expect(
        provider.listObservationsForEncounter("", ENCOUNTER_1, { userId: USER_A }),
      ).rejects.toThrow();
      await expect(
        provider.listObservationsForEncounter(ORG_A, " ", { userId: USER_A }),
      ).rejects.toThrow();
    });
  });

  // ── the visit an observation is tied to, and the dates it may carry ───────────────────────────────────────────────
  describe("visit binding and observation dates", () => {
    const OPEN = "55555555-5555-5555-5555-5555555555a1";
    const ANOTHER_AUTHORS = "55555555-5555-5555-5555-5555555555a2";
    const CLOSED = "55555555-5555-5555-5555-5555555555a3";
    const TELEPHONIC = "55555555-5555-5555-5555-5555555555a4";
    const observedAtBound = async (woundId: string, patient: string, observedAt: string) =>
      svc.recordObservation(actorA(), patient, woundId, { observedAt });

    // The clinician's open note, a colleague's note and a closed note (all PATIENT_1); ENCOUNTER_1 is the clinician's note for PATIENT_2.
    beforeAll(async () => {
      await insertEncounter(OPEN, PATIENT_1, membershipA);
      await insertEncounter(ANOTHER_AUTHORS, PATIENT_1, membershipA2);
      await insertEncounter(CLOSED, PATIENT_1, membershipA, "finalized");
      await insertEncounter(TELEPHONIC, PATIENT_1, membershipA, "draft", "telephonic");
    });

    it("ties an observation to the caller's own open note for the patient, and to nothing else", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "right",
        etiology: "pressure_injury",
      });
      const tied = (sourceEncounterId: string) =>
        svc.recordObservation(actorA(), PATIENT_1, wound.id, { sourceEncounterId, painScore: 1 });
      // Act + Assert
      expect(await tied(OPEN)).toMatchObject({ sourceEncounterId: OPEN });
      await expect(tied(ENCOUNTER_1)).rejects.toMatchObject({ statusCode: 404 }); // another patient's note
      await expect(tied(ANOTHER_AUTHORS)).rejects.toMatchObject({ statusCode: 404 }); // another clinician's note
      await expect(tied("55555555-5555-5555-5555-5555555555ff")).rejects.toMatchObject({
        statusCode: 404,
      }); // no such note
      await expect(tied(CLOSED)).rejects.toMatchObject({
        statusCode: 409,
        code: "ENCOUNTER_NOT_DRAFT",
      });
      const stored = await admin.query(
        "SELECT source_encounter_id::text AS e FROM wound_observation WHERE wound_id=$1",
        [wound.id],
      );
      expect(stored.rows).toEqual([{ e: OPEN }]);
    });

    it("refuses an observation tied to the caller's own open telephonic note: its template has no wounds section", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "right",
        etiology: "pressure_injury",
      });
      await expect(
        svc.recordObservation(actorA(), PATIENT_1, wound.id, { sourceEncounterId: TELEPHONIC }),
      ).rejects.toMatchObject({ code: "WOUND_NOT_IN_NOTE", statusCode: 422 });
      // The reader reports it for the real row, and reports the routine visit's note as stating wounds.
      const reader = createDrizzleEncounterDraftReader(handle.db);
      expect(
        await reader.draftOf({ organizationId: ORG_A, encounterId: TELEPHONIC }),
      ).toMatchObject({
        status: "draft",
        authoredByMembershipId: membershipA,
        templateStatesWounds: false,
      });
      expect(await reader.draftOf({ organizationId: ORG_A, encounterId: OPEN })).toMatchObject({
        templateStatesWounds: true,
      });
      const stored = await admin.query("SELECT 1 FROM wound_observation WHERE wound_id=$1", [
        wound.id,
      ]);
      expect(stored.rowCount).toBe(0);
    });

    it("takes an observation out of a note that closed while it was being saved: a wrong_visit correction with no visit, never a 409 after the commit", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "left",
        etiology: "surgical",
      });
      // The real reader, except that the note is closed for every ask after the first (the check passes, the recheck sees it finalized).
      const real = createDrizzleEncounterDraftReader(handle.db);
      let asked = 0;
      const scripted = createDbWoundService(handle.db, {
        now: () => new Date("2026-11-19T15:00:00.000Z"),
        visits: {
          draftOf: async (input) => {
            const facts = await real.draftOf(input);
            return facts && asked++ > 0 ? { ...facts, status: "finalized" } : facts;
          },
        },
      });
      const result = await scripted.recordObservation(actorA(), PATIENT_1, wound.id, {
        sourceEncounterId: OPEN,
        painScore: 6,
      });
      expect(result).toMatchObject({
        sourceEncounterId: null,
        painScore: 6,
        correctionReason: "wrong_visit",
        status: "active",
      });
      const stored = await admin.query(
        "SELECT status, version, source_encounter_id::text AS e, correction_reason FROM wound_observation WHERE wound_id=$1 ORDER BY created_at, id",
        [wound.id],
      );
      expect(stored.rows).toEqual([
        { status: "superseded", version: 2, e: OPEN, correction_reason: null },
        { status: "active", version: 1, e: null, correction_reason: "wrong_visit" },
      ]);
      // The note reads current observations only: nothing of it remains on the closed visit.
      const atVisit = await createWoundProvider(
        createDrizzleWoundProviderStore(handle.db),
      ).listObservationsForEncounter(ORG_A, OPEN, { userId: USER_A }, { patientId: PATIENT_1 });
      expect(atVisit.filter((o) => o.woundId === wound.id)).toEqual([]);
    });

    it("answers a missing observation with its own 404 before it asks about the visit, and never reads another patient's observation", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "right",
        etiology: "surgical",
      });
      const obs = await svc.recordObservation(actorA(), PATIENT_1, wound.id, { painScore: 1 });
      const retag = {
        sourceEncounterId: "55555555-5555-5555-5555-5555555555fe",
        correctionReason: "wrong_visit" as const,
      };
      // A missing observation: its own 404, not the (unknown) visit's.
      await expect(
        svc.correctObservation(actorA(), PATIENT_1, wound.id, randomUUID(), 1, retag),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining("wound observation"),
      });
      // The same ids under another patient's path: the wound is not theirs, so it is a 404 for the wound.
      await expect(
        svc.correctObservation(actorA(), PATIENT_2, wound.id, obs.id, 1, retag),
      ).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining("wound") });
      // And with the observation found, the unknown visit is the refusal.
      await expect(
        svc.correctObservation(actorA(), PATIENT_1, wound.id, obs.id, 1, retag),
      ).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining("encounter") });
    });

    it("records two observations racing on one wound and one open note, and both land", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "right",
        etiology: "surgical",
      });
      const record = (painScore: number) =>
        svc.recordObservation(actorA(), PATIENT_1, wound.id, {
          sourceEncounterId: OPEN,
          painScore,
        });
      const [a, b] = await Promise.all([record(3), record(4)]);
      expect([a.sourceEncounterId, b.sourceEncounterId]).toEqual([OPEN, OPEN]);
      const stored = await admin.query(
        "SELECT pain_score FROM wound_observation WHERE wound_id=$1 AND status='active' ORDER BY pain_score",
        [wound.id],
      );
      expect(stored.rows.map((r) => r.pain_score)).toEqual([3, 4]);
    });

    it("never sees another organisation's note", async () => {
      const wound = await svc.createWound(actorB(), PATIENT_B, {
        siteCode: "heel",
        laterality: "left",
        etiology: "pressure_injury",
      });
      await expect(
        svc.recordObservation(actorB(), PATIENT_B, wound.id, { sourceEncounterId: OPEN }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("takes an observation out of its note on an explicit null, and keeps it when the correction is silent", async () => {
      const wound = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "left",
        etiology: "pressure_injury",
      });
      const first = await svc.recordObservation(actorA(), PATIENT_1, wound.id, {
        sourceEncounterId: OPEN,
        painScore: 1,
      });
      const silent = await svc.correctObservation(actorA(), PATIENT_1, wound.id, first.id, 1, {
        painScore: 2,
        correctionReason: "assessment_error",
      });
      expect(silent.sourceEncounterId).toBe(OPEN);
      const untagged = await svc.correctObservation(actorA(), PATIENT_1, wound.id, silent.id, 1, {
        painScore: 2,
        sourceEncounterId: null,
        correctionReason: "wrong_visit",
      });
      expect(untagged.sourceEncounterId).toBeNull();
      const stored = await admin.query(
        "SELECT source_encounter_id::text AS e FROM wound_observation WHERE id=$1",
        [untagged.id],
      );
      expect(stored.rows).toEqual([{ e: null }]);
    });

    it("refuses an observation dated before the wound's onset or before 2000, and stores nothing", async () => {
      const dated = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "right",
        etiology: "pressure_injury",
        onsetOn: "2026-11-01",
      });
      const undated = await svc.createWound(actorA(), PATIENT_1, {
        siteCode: "heel",
        laterality: "left",
        etiology: "surgical",
      });
      await expect(
        observedAtBound(dated.id, PATIENT_1, "2026-10-15T10:00:00.000Z"),
      ).rejects.toMatchObject({ code: "WOUND_OBSERVED_BEFORE_ONSET", statusCode: 422 });
      await expect(
        observedAtBound(undated.id, PATIENT_1, "1999-12-31T00:00:00.000Z"),
      ).rejects.toMatchObject({ code: "WOUND_OBSERVED_IMPLAUSIBLY_EARLY", statusCode: 422 });
      expect((await observedAtBound(dated.id, PATIENT_1, "2026-11-01T09:00:00.000Z")).id).toEqual(
        expect.any(String),
      );
      const n = await admin.query(
        "SELECT count(*)::int AS n FROM wound_observation WHERE wound_id = ANY($1)",
        [[dated.id, undated.id]],
      );
      expect(n.rows[0].n).toBe(1);
    });
  });

  // ── patient destruction ────────────────────────────────────────────────────────────────────────────────────────
  describe("patient eraser step", () => {
    it("deletes one patient's observations (both ends of a correction) and wounds, and nobody else's", async () => {
      // Arrange: a destroy-me patient and a bystander, in the same organisation
      const destroyed = PATIENT_DESTROYED;
      const bystander = PATIENT_BYSTANDER;
      const wound = await svc.createWound(actorA(), destroyed, {
        siteCode: "elbow",
        laterality: "right",
        etiology: "skin_tear",
      });
      const obs = await svc.recordObservation(actorA(), destroyed, wound.id, { painScore: 1 });
      await svc.correctObservation(actorA(), destroyed, wound.id, obs.id, 1, {
        painScore: 2,
        correctionReason: "assessment_error",
      });
      const kept = await svc.createWound(actorA(), bystander, {
        siteCode: "elbow",
        laterality: "left",
        etiology: "skin_tear",
      });
      await svc.recordObservation(actorA(), bystander, kept.id, { painScore: 3 });
      // Act: the destruction path runs privileged, inside a tenant context
      const { withOrgContext } = await import("@chartwarden/tenancy");
      const counts = await withOrgContext(
        adminHandle.db,
        { organizationId: ORG_A, userId: "" },
        (tx) => eraseWoundSubtree(tx as never, destroyed),
      );
      // Assert
      expect(counts).toEqual({ woundObservations: 2, wounds: 1 });
      const left = await admin.query(
        "SELECT patient_id::text AS p FROM wound WHERE patient_id = ANY($1)",
        [[destroyed, bystander]],
      );
      expect(left.rows).toEqual([{ p: bystander }]);
      expect(
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM wound_observation WHERE patient_id=$1",
              [bystander],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    });
  });
});
