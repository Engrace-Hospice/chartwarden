/**
 * ADR-0104 — the M5 patient code-status routes against REAL Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 * Proves end to end through the real routes and the real Drizzle port:
 *   - a set is current; the newest entry wins; retracting the newest makes the previous current; retracting all
 *     leaves NOTHING current (never a default Full Code);
 *   - the table is append-only for the app role: a raw UPDATE of `code_status` / DELETE is refused by the database;
 *   - another tenant sees the patient as absent (404) — RLS, not a superuser connection;
 *   - the M4 write-audit row lands with the free-text `reason` scrubbed;
 *   - the chart read leaves a `patient.viewed` read-audit row with a non-empty resource id;
 *   - a source document the seam check refuses is a 422 and writes nothing.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run apps/backend/__tests__/m5-code-status.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbCodeStatusPort } from "../src/modules/05-patient/code-status-db";
import { registerPatientCodeStatusRoutes } from "../src/modules/05-patient/routes/code-status-routes";
import { createDrizzleCaseloadStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000c1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000c2";
const MD_A = "d0000000-0000-4000-8000-0000000000c1";
const MD_B = "d0000000-0000-4000-8000-0000000000c2";
const MEMBERSHIP_A = "e0000000-0000-4000-8000-0000000000c1";
const MEMBERSHIP_B = "e0000000-0000-4000-8000-0000000000c2";
const GOOD_DOC = "f0000000-0000-4000-8000-0000000000c1";
const BAD_DOC = "f0000000-0000-4000-8000-0000000000c2";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["director_of_nursing"];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string") {
    request.context.attributes = { ...request.context.attributes, membershipId: membership };
  }
}
const asA = { "x-test-user": MD_A, "x-test-org": ORG_A, "x-test-membership": MEMBERSHIP_A };
const asB = { "x-test-user": MD_B, "x-test-org": ORG_B, "x-test-membership": MEMBERSHIP_B };

describe.skipIf(!DB_URL)("ADR-0104 patient code status — LIVE Postgres", () => {
  let admin: Client;
  let appConn: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let patientId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    for (const [id, slug] of [
      [ORG_A, "org-adr0104-a"],
      [ORG_B, "org-adr0104-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [id, n] of [
      [MD_A, "mda"],
      [MD_B, "mdb"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, `${n}@adr0104.test`]);
    }

    const appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
    appConn = new Client({ connectionString: appUrl });
    await appConn.connect();

    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [[MD_A, ORG_A] as const, [MD_B, ORG_B] as const].map(([userId, orgId]) => ({
          orgId,
          userId,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["patient.read", "patient.edit_code_status"],
            },
          ],
        })),
      ).store,
    );
    registerAbacRegistry();
    const caseload = createDrizzleCaseloadStore(handle.db);
    const predicates = buildCarePlanAbacPredicates({
      resolver: {
        async loadPlan() {
          return null;
        },
        async loadProblem() {
          return null;
        },
        async loadVersion() {
          return null;
        },
      },
      isInCaseload: ({ organizationId, userId, patientId: pid }) =>
        caseload.isAssigned(organizationId, userId, pid),
    });
    registerPredicateIdempotent("caseload_or_scope", predicates.caseload_or_scope);

    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      readAuditPrefixes: ["/api/v1/patients"],
      security: { rateLimitEnabled: false },
    });
    registerPatientCodeStatusRoutes(app, {
      codeStatus: createDbCodeStatusPort(
        handle.db,
        async (_org, _patient, doc) => doc === GOOD_DOC,
      ),
    });
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    await appConn?.end();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    const { rows } = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Pat', 'Code', '1950-01-01', 'female', 'active') RETURNING id`,
      [ORG_A, `mrn-${Math.random().toString(36).slice(2)}`],
    );
    patientId = rows[0].id as string;
  });

  afterEach(async () => {
    await admin.query("DELETE FROM patient_code_status");
    await admin.query(
      "DELETE FROM audit_event WHERE resource_kind IN ('patient_code_status','patient')",
    );
    await admin.query("DELETE FROM patient");
  });

  const set = (codeStatus: string, extra: object = {}, headers = asA, pid = patientId) =>
    app.inject({
      method: "POST",
      url: `/api/v1/patients/${pid}/code-status`,
      headers,
      payload: { codeStatus, reason: "Goals-of-care conversation with family", ...extra },
    });
  const list = (headers = asA, pid = patientId) =>
    app.inject({ method: "GET", url: `/api/v1/patients/${pid}/code-status`, headers });
  const retract = (entryId: string, headers = asA, pid = patientId) =>
    app.inject({
      method: "POST",
      url: `/api/v1/patients/${pid}/code-status/${entryId}/entered-in-error`,
      headers,
      payload: { reason: "recorded on the wrong chart" },
    });

  it("nothing recorded reads as current: null, never a default", async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ current: null, history: [] });
  });

  it("the newest entry is current; retracting it restores the previous one; retracting all leaves none", async () => {
    const first = (await set("full_code")).json();
    await new Promise((r) => setTimeout(r, 15));
    const second = (await set("dnr_dni")).json();
    expect((await list()).json().current.codeStatus).toBe("dnr_dni");

    expect((await retract(second.id)).statusCode).toBe(200);
    expect((await list()).json().current.codeStatus).toBe("full_code");
    expect((await retract(second.id)).statusCode).toBe(409);

    await retract(first.id);
    const after = (await list()).json();
    expect(after.current).toBeNull();
    expect(after.history).toHaveLength(2);
  });

  it("the database refuses to edit a recorded value or delete a row (append-only grant)", async () => {
    const { id } = (await set("dnr")).json();
    await appConn.query("SELECT set_config('app.org_id', $1, false)", [ORG_A]);
    await expect(
      appConn.query("UPDATE patient_code_status SET code_status = 'full_code' WHERE id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appConn.query("DELETE FROM patient_code_status WHERE id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
  });

  it("the database freezes a retracted entry (its entered-in-error fields cannot be rewritten)", async () => {
    const { id } = (await set("dnr")).json();
    await retract(id);
    await appConn.query("SELECT set_config('app.org_id', $1, false)", [ORG_A]);
    await expect(
      appConn.query(
        "UPDATE patient_code_status SET entered_in_error_reason = 'rewritten' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      appConn.query(
        "UPDATE patient_code_status SET entered_in_error_at = NULL, entered_in_error_by_membership_id = NULL, entered_in_error_reason = NULL WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/cannot be changed/);
  });

  it("another tenant sees the patient as absent", async () => {
    await set("dnr");
    expect((await list(asB)).statusCode).toBe(404);
    expect((await set("full_code", {}, asB)).statusCode).toBe(404);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM patient_code_status");
    expect(rows[0].n).toBe(1);
  });

  it("writes a scrubbed M4 audit row (the reason text never lands in audit_event)", async () => {
    const { id } = (await set("dnr")).json();
    const { rows } = await admin.query(
      "SELECT event_type, after::text AS after FROM audit_event WHERE resource_kind = 'patient_code_status' AND resource_id = $1",
      [id],
    );
    expect(rows.map((r) => r.event_type)).toContain("patient_code_status.insert");
    expect(rows[0].after).not.toContain("Goals-of-care");
    expect(rows[0].after).toContain("<changed>");
  });

  it("the chart read leaves a read-audit row with a resource id", async () => {
    await list();
    const { rows } = await admin.query(
      "SELECT resource_id FROM audit_event WHERE event_type = 'patient.viewed' AND resource_kind = 'patient'",
    );
    expect(rows.map((r) => r.resource_id)).toContain(patientId);
  });

  it("a source document the seam refuses is a 422 and writes nothing", async () => {
    expect((await set("dnr", { sourceDocumentId: BAD_DOC })).statusCode).toBe(422);
    expect((await set("dnr", { sourceDocumentId: GOOD_DOC })).statusCode).toBe(201);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM patient_code_status");
    expect(rows[0].n).toBe(1);
  });
});
