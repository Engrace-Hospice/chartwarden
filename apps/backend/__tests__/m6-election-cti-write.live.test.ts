import { randomUUID } from "node:crypto";
/**
 * M6L-T03 — the Drizzle election-statement + CTI write lifecycle, proven against real Postgres.
 *
 * Drives the production writes as the NOBYPASSRLS `wardenx_app` role: election statement draft → sign →
 * void; CTI draft → hospice-MD sign (§7.3 W-CTI-03/04: period-1-with-attending → awaiting_attending →
 * attending sign → signed; recert → signed on the MD alone + activates its period); void; mark-late. Then
 * the FULL activation prerequisites are satisfied through the real write path (no superuser-seeded ES/CTI)
 * → activateAdmission succeeds. Optimistic concurrency (stale ifVersion → 409) throughout.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MD = "55555555-5555-5555-5555-555555555555";
const ATTENDING = "77777777-7777-7777-7777-777777777777";

describe.skipIf(!DB_URL)("M6 election + CTI write lifecycle — LIVE Postgres (M6L-T03)", () => {
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

  /** Referral → triage → accept → NOR-ack: returns a period-1 admission ready for election/CTI. */
  async function admitFor(patientId: string): Promise<{ admissionId: string; periodId: string }> {
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
    return { admissionId, periodId: periods![0].id };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6t3@x.test')`, [USER]);
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    svc = createDbAdmissionRouteService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("election statement: draft → sign → (stale 409)", async () => {
    const { admissionId, periodId } = await admitFor(randomUUID());
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId);
    expect(es.state).toBe("drafted");
    const signed = await svc.signElection(ORG_A, es.id, es.version, USER);
    expect(signed.state).toBe("signed");
    await expect(svc.signElection(ORG_A, es.id, 0, USER)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("CTI (period 1, no attending): draft → hospice-MD sign → signed", async () => {
    const { periodId } = await admitFor(randomUUID());
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: periodId, hospiceMedicalDirectorId: MD, isRecert: false },
      USER,
    );
    expect(cti.state).toBe("drafted");
    const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    expect(signed.state).toBe("signed");
  });

  it("CTI (period 1, with attending): hospice sign → awaiting_attending → attending sign → signed", async () => {
    const { periodId } = await admitFor(randomUUID());
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        isRecert: false,
      },
      USER,
    );
    const h = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    expect(h.state).toBe("awaiting_attending");
    const a = await svc.signCtiAttending(ORG_A, cti.id, h.version, USER);
    expect(a.state).toBe("signed");
  });

  it("recert (period 2): hospice sign fully signs + activates the period", async () => {
    const { admissionId } = await admitFor(randomUUID());
    const p2 = await svc.createElectionPeriod(ORG_A, admissionId);
    expect(p2.state).toBe("pending");
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, isRecert: true },
      USER,
    );
    const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    expect(signed.state).toBe("signed");
    const status = await admin.query("SELECT status FROM election_period WHERE id=$1", [p2.id]);
    expect(status.rows[0].status).toBe("active"); // §7.3 recert activates the period
  });

  it("full activation via the real write path (no superuser-seeded ES/CTI)", async () => {
    const { admissionId, periodId } = await admitFor(randomUUID());
    // Pre-existing bug found while fixing the transfer-in period-count bug: this call was missing the
    // NorAcknowledgeInput object entirely (USER was landing in the `input` param, `actorUserId` was
    // undefined) — __tests__ sits outside apps/backend/tsconfig.json's rootDir so tsc never typechecks
    // this file, and vitest's esbuild transform doesn't typecheck either, so the arity mismatch compiled
    // clean and only broke at runtime against a real DB (a malformed `set_config('app.user_id', , true)`).
    // Same class of bug already fixed in m6-admission-write-lifecycle.live.test.ts and
    // m6-discharge-f2f-loc-write.live.test.ts this session — this file was never touched in that pass.
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId);
    await svc.signElection(ORG_A, es.id, es.version, USER);
    // Second pre-existing gap, same class: R-AC-01 (intake/activation-gate.ts) requires the ATTENDING
    // physician's CTI signature for period 1, not just the hospice medical director's — this test only
    // ever signed the hospice-MD side, so activation always threw PRECONDITION_FAILED/attending_signed
    // once the NOR bug above stopped masking it.
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await svc.signCtiAttending(ORG_A, cti.id, cti.version + 1, ATTENDING);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
  });

  it("voidCti and markCtiLate", async () => {
    const { periodId } = await admitFor(randomUUID());
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: periodId, hospiceMedicalDirectorId: MD, isRecert: false },
      USER,
    );
    const late = await svc.markCtiLate(ORG_A, cti.id, cti.version);
    expect(late.writtenCertDeadlineAt).toBeTruthy();
    const voided = await svc.voidCti(ORG_A, cti.id, "entered in error", late.version);
    expect(voided.state).toBe("voided");
  });
});
