/**
 * S10 — the M8 post-discharge authoring guard, proven against real Postgres.
 *
 * `validateAdmissionForService` (08-encounters/encounters-route-service-db.ts) is the only thing that
 * stops a clinician authoring a visit note onto a closed-out admission. It allows a late entry whose
 * service date is on or before `dischargedAt`, and refuses anything later. It runs at two entry points,
 * `createDraft` and `sign`; neither had a test. This suite drives both as the NOBYPASSRLS app role
 * through M6's REAL `AdmissionStatusReader`, with the real catalog-validating outbox publisher.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m8:post-discharge:live

 * The boundary compares the service date to the UTC date of `dischargedAt` (no tenant time zone), so the
 * 12:00Z and 20:00Z fixtures below do not exercise an evening discharge that is already tomorrow in UTC.
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInMemorySessionContextStore, createSessionContextResolver } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  type EncounterWriteOutboxPort,
  M8_OUTBOX_EVENTS,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/index";
import { requiredSectionSelections, requiredVitalsCapture } from "./_hearthnote-fixtures";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_RN_CM = "88888888-8888-8888-8888-888888888888";
const SESSION_A = "66666666-6666-6666-6666-666666666666";
const ACTIVATED = "2025-12-01";
/** The `encounter_service_date_not_future` CHECK forbids the future; the real clock is far past these. */
const LATE_DATE = "2026-01-15";
const LIVE_NOW = "2026-01-16T17:00:00Z";
const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 7) };
const CIPHERS = createHearthnoteCiphers({
  async dekForOrg() {
    return TEST_DEK;
  },
  async dekForOrgVersion(_org: string, version: string) {
    return { version, key: TEST_DEK.key };
  },
});

type AdmissionStatus = "active" | "discharged" | "bereavement" | "closed";

describe.skipIf(!DB_URL)("M8 post-discharge authoring guard — LIVE Postgres (S10)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEncounterRouteService>;
  let membership: string;
  let siting: { providerEntityId: string; locationId: string };

  let patientSeq = 0;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped)");
      }
      await admin.query(sql);
    }
  }

  /** A fresh patient (one open admission per patient) plus an admission in the given state. */
  async function seedAdmission(
    status: AdmissionStatus,
    dischargedAt: string | null,
  ): Promise<{ patientId: string; admissionId: string }> {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    patientSeq += 1;
    await admin.query(
      `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
                            legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,$4,$5,'Test','Patient','1950-01-01','F','active')`,
      [patientId, ORG_A, siting.providerEntityId, siting.locationId, `MRN-S10-${patientSeq}`],
    );
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id,
                                       clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,$5,'primary_rn',CURRENT_DATE)`,
      [patientId, ORG_A, siting.providerEntityId, siting.locationId, USER_RN_CM],
    );
    await admin.query(
      `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id,
                              status, admission_at, activated_at, discharged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
      [
        admissionId,
        ORG_A,
        siting.providerEntityId,
        siting.locationId,
        patientId,
        status,
        ACTIVATED,
        dischargedAt,
      ],
    );
    return { patientId, admissionId };
  }

  function draftOn(
    a: { patientId: string; admissionId: string },
    serviceDate: string,
    org = ORG_A,
  ) {
    return svc.createDraft(org, membership, {
      patientId: a.patientId,
      admissionId: a.admissionId,
      encounterType: "routine_visit" as never,
      discipline: "rn" as never,
      serviceDate: serviceDate as never,
    });
  }

  async function encounterCount(admissionId: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM encounter WHERE admission_id=$1",
      [admissionId],
    );
    return rows[0].n as number;
  }
  async function createdEventCount(): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m8.encounter.created'",
    );
    return rows[0].n as number;
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
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'s10a@x.test'),($2,'s10cm@x.test')`,
      [USER, USER_RN_CM],
    );
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [USER_RN_CM, ORG_A],
    );
    const pe = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, '01-1234', 'S10 PE', '1234567890', 'enc', '12-31') RETURNING id`,
      [ORG_A],
    );
    const loc = await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1, 'S10 Loc', '1 Main St', 'Town', 'NY', '10001', 'America/New_York') RETURNING id`,
      [pe.rows[0].id],
    );
    siting = { providerEntityId: pe.rows[0].id as string, locationId: loc.rows[0].id as string };

    const sessions = createInMemorySessionContextStore([
      {
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: SESSION_A,
        userId: USER,
        membershipId: membership,
        organizationId: ORG_A,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "webauthn",
      },
    ]);
    registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));
    registerSeam("CarePlanReader", {
      relevantElementsForEncounter: async () => null,
      isReviewOverdue: async () => null,
      fifteenDayCycleCountsForOrg: async () => ({ numerator: 0, denominator: 0 }),
      terminologyCodeUsageForOrg: async () => [],
      linkSummary: async () => null,
    } as never);
    registerSeam("LatestAssessmentProvider", {
      latest: async () => null,
      latestBatch: async () => [],
    } as never);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    registerSeam("CareTeamProvider", createCareTeamProvider(createDrizzleCareTeamStore(handle.db)));
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M8_OUTBOX_EVENTS]));
    const outbox: EncounterWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m8" }),
    };
    svc = createDbEncounterRouteService(handle.db, outbox, CIPHERS, () => new Date(LIVE_NOW));
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("createDraft", () => {
    it("an active admission accepts a draft", async () => {
      const a = await seedAdmission("active", null);
      const d = await draftOn(a, LATE_DATE);
      expect(d.status).toBe("draft");
      expect(await encounterCount(a.admissionId)).toBe(1);
    });

    it.each(["discharged", "bereavement", "closed"] as const)(
      "a %s admission accepts a late entry dated on or before the discharge day, and refuses a later one",
      async (status) => {
        const a = await seedAdmission(status, "2026-01-20T12:00:00Z");
        // Strictly earlier and the boundary day itself are both legitimate late entries.
        await draftOn(a, "2026-01-15");
        await draftOn(a, "2026-01-20");
        expect(await encounterCount(a.admissionId)).toBe(2);

        const events = await createdEventCount();
        await expect(draftOn(a, "2026-01-21")).rejects.toMatchObject({ statusCode: 403 });
        // The refusal is atomic: no row, no m8.encounter.created.
        expect(await encounterCount(a.admissionId)).toBe(2);
        expect(await createdEventCount()).toBe(events);
      },
    );

    it("a non-active admission with no discharge instant refuses every date", async () => {
      // `discharged` with a NULL discharged_at has no late-entry window to measure against.
      const a = await seedAdmission("discharged", null);
      await expect(draftOn(a, LATE_DATE)).rejects.toMatchObject({ statusCode: 403 });
      expect(await encounterCount(a.admissionId)).toBe(0);
    });

    it("a service date before the admission was activated is a 422, on any status", async () => {
      const active = await seedAdmission("active", null);
      await expect(draftOn(active, "2025-11-30")).rejects.toMatchObject({ statusCode: 422 });
      const discharged = await seedAdmission("discharged", "2026-01-20T12:00:00Z");
      await expect(draftOn(discharged, "2025-11-30")).rejects.toMatchObject({ statusCode: 422 });
    });

    it("another tenant cannot author onto this admission", async () => {
      const a = await seedAdmission("active", null);
      const before = await encounterCount(a.admissionId);
      // RLS hides the row from org B, so M6's reader answers "not found" (it carries no HTTP status itself).
      await expect(draftOn(a, LATE_DATE, ORG_B)).rejects.toMatchObject({
        name: "AdmissionNotFoundError",
      });
      expect(await encounterCount(a.admissionId)).toBe(before);
    });
  });

  describe("sign", () => {
    /** A finalized encounter authored while the admission was still active, dated LATE_DATE. */
    async function finalizedWhileActive() {
      const a = await seedAdmission("active", null);
      const d = await draftOn(a, LATE_DATE);
      await svc.updateSelections(
        ORG_A,
        d.id,
        0,
        requiredSectionSelections("routine_visit" as never, "rn" as never),
      );
      const vitals = requiredVitalsCapture("routine_visit" as never, "rn" as never);
      if (vitals) await svc.captureVitals(ORG_A, d.id, vitals);
      await svc.finalize(ORG_A, d.id, LATE_DATE as never);
      return { a, id: d.id };
    }
    const actor = () => ({ membershipId: membership, sessionId: SESSION_A });

    it("a note finalized before discharge still signs when its service date is on or before the discharge day", async () => {
      const { a, id } = await finalizedWhileActive();
      await admin.query("UPDATE admission SET status='discharged', discharged_at=$2 WHERE id=$1", [
        a.admissionId,
        "2026-01-15T20:00:00Z",
      ]);
      const signed = await svc.sign(ORG_A, id, actor(), { at: LATE_DATE as never });
      expect(signed.status).toBe("signed");
    });

    it("a note whose service date is after the discharge day cannot be signed, and stays finalized", async () => {
      const { a, id } = await finalizedWhileActive();
      await admin.query("UPDATE admission SET status='discharged', discharged_at=$2 WHERE id=$1", [
        a.admissionId,
        "2026-01-10T20:00:00Z",
      ]);
      await expect(svc.sign(ORG_A, id, actor(), { at: LATE_DATE as never })).rejects.toMatchObject({
        statusCode: 403,
      });
      const { rows } = await admin.query("SELECT status FROM encounter WHERE id=$1", [id]);
      expect(rows[0].status).toBe("finalized");
      const sigs = await admin.query(
        "SELECT count(*)::int AS n FROM encounter_signature WHERE encounter_id=$1",
        [id],
      );
      expect(sigs.rows[0].n).toBe(0);
    });
  });
});
