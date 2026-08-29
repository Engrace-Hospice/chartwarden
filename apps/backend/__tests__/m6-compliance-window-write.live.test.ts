import { randomUUID } from "node:crypto";
/**
 * M6L-T05 — the Drizzle compliance-window close / override write lifecycle, proven against real
 * Postgres. This is the last M6 write slice: with it, no admission route is left at 501.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: an admission's compliance windows are opened
 * by the T02 createAdmission cascade (initial_assessment_48h / comprehensive_assessment_5d / care_plan_5d
 * / notice_of_rights); we close one, override another (capturing the reason + the overriding user), and
 * assert the §7.1 optimistic lock (stale ifVersion → 409) plus the already-closed guard.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const MD = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M6 compliance-window write lifecycle — LIVE Postgres (M6L-T05)", () => {
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

  /** Referral → triage → accept: an admission whose createAdmission cascade opened its compliance windows. */
  async function admissionWithWindows(): Promise<string> {
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
      { primaryDiagnosisIcd10: "C34.90", patientId: randomUUID() },
      1,
      USER,
    );
    return admissionId;
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
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m6t5@x.test'),($2,'m6t5md@x.test')`,
      [USER, MD],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox()); // F-100
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("createAdmission opens the §2.5 compliance windows", async () => {
    const admissionId = await admissionWithWindows();
    const windows = await svc.listComplianceWindowsForAdmission(ORG_A, admissionId);
    expect(windows!.length).toBeGreaterThanOrEqual(4);
    expect(windows!.every((w) => w.state === "open")).toBe(true);
  });

  it("closeComplianceWindow → closed (stale ifVersion → 409, second close → 409)", async () => {
    const admissionId = await admissionWithWindows();
    const windows = await svc.listComplianceWindowsForAdmission(ORG_A, admissionId);
    const w = windows![0];
    await expect(svc.closeComplianceWindow(ORG_A, w.id, w.version + 99)).rejects.toMatchObject({
      statusCode: 409,
    });
    const closed = await svc.closeComplianceWindow(ORG_A, w.id, w.version);
    expect(closed.state).toBe("closed");
    await expect(svc.closeComplianceWindow(ORG_A, w.id, closed.version)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("overrideComplianceWindow → closed, capturing the reason + overriding user", async () => {
    const admissionId = await admissionWithWindows();
    const windows = await svc.listComplianceWindowsForAdmission(ORG_A, admissionId);
    const w = windows![0];
    const reason = "assessment completed on paper during EHR outage; scanned to chart";
    const over = await svc.overrideComplianceWindow(ORG_A, w.id, reason, w.version, MD);
    expect(over.state).toBe("closed");
    const row = await admin.query(
      "SELECT override_reason, closed_by FROM compliance_window WHERE id=$1",
      [w.id],
    );
    expect(row.rows[0].override_reason).toBe(reason);
    expect(row.rows[0].closed_by).toBe(MD);
  });
});
