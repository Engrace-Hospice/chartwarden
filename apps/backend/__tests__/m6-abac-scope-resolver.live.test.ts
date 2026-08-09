/**
 * GAP-011 — the five NEW child-resource `admission.scope` loaders (deceased-db.ts's sibling in
 * admission-route-service-db.ts: `loadElectionPeriodScope`/`loadElectionStatementScope`/
 * `loadCtiScope`/`loadF2fScope`/`loadLocScope`), proven against real Postgres. Each does a real join
 * (election_period/level_of_care_period → admission directly; election_statement/certification_of_
 * terminal_illness/face_to_face_encounters → election_period → admission) — provable only against a
 * live cluster, not the in-memory slice admission-routes.test.ts already covers.
 *
 * WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run \
 *   apps/backend/__tests__/m6-abac-scope-resolver.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "../src/modules/06-admission/admission-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MD = "55555555-5555-5555-5555-555555555555";
const ATTENDING = "77777777-7777-7777-7777-777777777777";

describe.skipIf(!DB_URL)("M6 admission.scope child-resource resolvers — LIVE Postgres (GAP-011)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let resolver: ReturnType<typeof createDbAdmissionAbacResolver>;

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

  /**
   * Referral → triage → accept → NOR ack → election sign → CTI hospice+attending sign → activate: a
   * FULLY ACTIVE admission (the `changeLoc` write below requires active/on_hold — the m6-discharge-
   * f2f-loc-write.live.test.ts `activeAdmission` precedent, condensed to what THIS suite needs: the
   * election-statement/CTI/LOC ids to resolve scope through, not a fresh CTI/F2F/LOC state-machine
   * proof of its own).
   */
  async function activeAdmission(
    patientId: string,
  ): Promise<{ admissionId: string; periodId: string; electionStatementId: string }> {
    const ref = await svc.createReferral(
      ORG_A,
      { source: "phone", receivedAt: new Date().toISOString(), receivingUserId: USER, patientNameAtReceipt: "P" },
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
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId);
    await svc.signElection(ORG_A, es.id, es.version, USER);
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: periodId, hospiceMedicalDirectorId: MD, attendingPhysicianId: ATTENDING, isRecert: false },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await svc.signCtiAttending(ORG_A, cti.id, cti.version + 1, USER);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
    return { admissionId, periodId, electionStatementId: es.id };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6gap011@x.test')`, [USER]);
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    svc = createDbAdmissionRouteService(handle.db);
    resolver = createDbAdmissionAbacResolver(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("resolves the SAME {patientId, providerEntityId} as loadAdmission for every child resource kind", async () => {
    const { admissionId, periodId, electionStatementId } = await activeAdmission(randomUUID());
    // The CTI activation used above is voided/superseded by nothing — draft a SECOND (recert) CTI on a
    // fresh period so this test also proves the cti/f2f/loc loaders independently of the activation CTI.
    const p2 = await svc.createElectionPeriod(ORG_A, admissionId);
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, isRecert: true },
      USER,
    );
    const f2f = await svc.scheduleF2f(ORG_A, {
      admissionId: "ignored-by-the-write-service",
      electionPeriodId: periodId,
      scheduledClinicianId: USER,
      clinicianRole: "hospice_md",
    });
    const loc = await svc.changeLoc(ORG_A, admissionId, "routine_home_care");

    const admissionFacts = await resolver.loadAdmission(ORG_A, admissionId);
    expect(admissionFacts).not.toBeNull();

    await expect(resolver.loadElectionPeriodScope(ORG_A, periodId)).resolves.toEqual(admissionFacts);
    await expect(resolver.loadElectionStatementScope(ORG_A, electionStatementId)).resolves.toEqual(
      admissionFacts,
    );
    await expect(resolver.loadCtiScope(ORG_A, cti.id)).resolves.toEqual(admissionFacts);
    await expect(resolver.loadF2fScope(ORG_A, f2f.id)).resolves.toEqual(admissionFacts);
    await expect(resolver.loadLocScope(ORG_A, loc.id)).resolves.toEqual(admissionFacts);
  });

  it("fails closed (null) for an absent id and for a cross-tenant id (RLS-backstopped)", async () => {
    const { admissionId } = await activeAdmission(randomUUID());
    const p2 = await svc.createElectionPeriod(ORG_A, admissionId);
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, isRecert: true },
      USER,
    );

    const missing = randomUUID();
    await expect(resolver.loadElectionPeriodScope(ORG_A, missing)).resolves.toBeNull();
    await expect(resolver.loadElectionStatementScope(ORG_A, missing)).resolves.toBeNull();
    await expect(resolver.loadCtiScope(ORG_A, missing)).resolves.toBeNull();
    await expect(resolver.loadF2fScope(ORG_A, missing)).resolves.toBeNull();
    await expect(resolver.loadLocScope(ORG_A, missing)).resolves.toBeNull();

    // A real CTI id, but resolved under ORG_B's tenant context — RLS hides it, same as absent.
    await expect(resolver.loadCtiScope(ORG_B, cti.id)).resolves.toBeNull();
  });
});
