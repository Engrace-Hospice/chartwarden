/**
 * GAP-015 — the M5 §4.3 care-team assignment routes against REAL Postgres, as the NOBYPASSRLS
 * `wardenx_app` role. `patient_assignment` had NO production writer: `caseload_or_scope` and the
 * CareTeamProvider could only ever be fed by dev seeds. Proves, end to end through the real routes and
 * the real Drizzle port:
 *   - POST /patients/:id/assignments writes the row, and the PRODUCTION CaseloadProvider store
 *     (`createDrizzleCaseloadStore.isAssigned`) then returns true for that clinician;
 *   - POST …/:assignmentId/end sets `unassigned_at` and `isAssigned` flips to false;
 *   - 409 PRIMARY_RN_ALREADY_ASSIGNED / ASSIGNMENT_ALREADY_OPEN / ASSIGNMENT_ALREADY_ENDED;
 *   - a clinician who is not an active member of the org is refused (422);
 *   - `m5.patient.assignment_created` / `.assignment_ended` publish through the real catalog-validating
 *     outbox publisher;
 *   - another tenant sees the patient as absent (404) — RLS, not a superuser connection.
 *
 * WARDENX_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m5-assignment-routes.live.test.ts
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
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbAssignmentsPort } from "../src/modules/05-patient/assignments-db";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import { registerPatientAssignmentRoutes } from "../src/modules/05-patient/routes/assignment-routes";
import { createDrizzleCaseloadStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const DON = "d0000000-0000-4000-8000-000000000001"; // org-wide oversight (director_of_nursing)
const RN_1 = "d0000000-0000-4000-8000-000000000002"; // active member of ORG_A
const RN_2 = "d0000000-0000-4000-8000-000000000003"; // active member of ORG_A
const OUTSIDER = "d0000000-0000-4000-8000-000000000004"; // no membership in ORG_A
const DON_B = "d0000000-0000-4000-8000-000000000005";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}
const asDon = { "x-test-user": DON, "x-test-org": ORG_A, "x-test-roles": "director_of_nursing" };
const asDonB = { "x-test-user": DON_B, "x-test-org": ORG_B, "x-test-roles": "director_of_nursing" };

describe.skipIf(!DB_URL)("GAP-015 patient assignment routes — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let patientId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
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
      [ORG_A, "org-gap015-a"],
      [ORG_B, "org-gap015-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [id, n] of [
      [DON, "don"],
      [RN_1, "rn1"],
      [RN_2, "rn2"],
      [OUTSIDER, "outsider"],
      [DON_B, "donb"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, `${n}@gap015.test`]);
    }
    for (const [user, org] of [
      [DON, ORG_A],
      [RN_1, ORG_A],
      [RN_2, ORG_A],
      [DON_B, ORG_B],
    ] as const) {
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
        [user, org],
      );
    }

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    const outbox = {
      publish: (tx: Parameters<typeof txPublisher.publish>[0], input: never) =>
        txPublisher.publish(tx, { ...(input as object), callerModule: "m5" } as never),
    };

    const permissions = createInMemoryEffectivePermissionStore(
      [[DON, ORG_A] as const, [DON_B, ORG_B] as const].map(([userId, orgId]) => ({
        orgId,
        userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["patient.read", "patient.assign"],
          },
        ],
      })),
    );
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(permissions.store);
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

    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerPatientAssignmentRoutes(app, {
      assignments: createDbAssignmentsPort(handle.db, outbox as never),
    });
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    const { rows } = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Pat', 'Assign', '1950-01-01', 'female', 'active') RETURNING id`,
      [ORG_A, `mrn-${Math.random().toString(36).slice(2)}`],
    );
    patientId = rows[0].id as string;
  });

  afterEach(async () => {
    await admin.query("DELETE FROM patient_assignment");
    await admin.query("DELETE FROM outbox_event");
    await admin.query("DELETE FROM patient");
  });

  const assign = (clinicianUserId: string, role: string, headers = asDon, pid = patientId) =>
    app.inject({
      method: "POST",
      url: `/api/v1/patients/${pid}/assignments`,
      headers,
      payload: { clinicianUserId, role },
    });
  const end = (assignmentId: string, headers = asDon, pid = patientId) =>
    app.inject({
      method: "POST",
      url: `/api/v1/patients/${pid}/assignments/${assignmentId}/end`,
      headers,
    });
  const eventTypes = async (): Promise<string[]> =>
    (await admin.query("SELECT event_type FROM outbox_event ORDER BY created_at")).rows.map(
      (r) => r.event_type as string,
    );

  it("assigning through the route feeds the REAL CaseloadProvider store, and ending removes it", async () => {
    const store = createDrizzleCaseloadStore(handle.db);
    expect(await store.isAssigned(ORG_A, RN_1, patientId)).toBe(false);

    const created = await assign(RN_1, "primary_rn");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      clinicianUserId: RN_1,
      role: "primary_rn",
      current: true,
    });
    expect(await store.isAssigned(ORG_A, RN_1, patientId)).toBe(true);
    expect(await store.assignedPatientIds(ORG_A, RN_1)).toContain(patientId);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}/assignments`,
      headers: asDon,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().assignments).toHaveLength(1);

    const ended = await end(created.json().id);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().current).toBe(false);
    expect(ended.json().unassignedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await store.isAssigned(ORG_A, RN_1, patientId)).toBe(false);

    expect(await eventTypes()).toEqual([
      "m5.patient.assignment_created",
      "m5.patient.assignment_ended",
    ]);
  });

  it("refuses a second open primary_rn (409) but allows a new one after the first ends", async () => {
    const first = await assign(RN_1, "primary_rn");
    expect(first.statusCode).toBe(201);
    const second = await assign(RN_2, "primary_rn");
    expect(second.statusCode).toBe(409);
    expect(JSON.stringify(second.json())).toContain("PRIMARY_RN_ALREADY_ASSIGNED");

    expect((await end(first.json().id)).statusCode).toBe(200);
    expect((await assign(RN_2, "primary_rn")).statusCode).toBe(201);
  });

  it("allows several open additional RNs (`rn`) beside the one primary_rn (v0.6.1)", async () => {
    expect((await assign(RN_1, "primary_rn")).statusCode).toBe(201);
    const second = await assign(RN_2, "rn");
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ clinicianUserId: RN_2, role: "rn", current: true });
    // DON is also an active ORG_A member: a second open `rn` on the same patient is fine.
    expect((await assign(DON, "rn")).statusCode).toBe(201);
    // The open-duplicate guard still applies per (patient, clinician, role).
    const dup = await assign(RN_2, "rn");
    expect(dup.statusCode).toBe(409);
    expect(JSON.stringify(dup.json())).toContain("ASSIGNMENT_ALREADY_OPEN");
    // An `rn` is never the RN case manager: primary_rn stays single.
    const secondPrimary = await assign(RN_2, "primary_rn");
    expect(secondPrimary.statusCode).toBe(409);
    expect(JSON.stringify(secondPrimary.json())).toContain("PRIMARY_RN_ALREADY_ASSIGNED");
    const { rows } = await admin.query(
      "SELECT role::text AS role, count(*)::int AS n FROM patient_assignment WHERE patient_id=$1 AND unassigned_at IS NULL GROUP BY role ORDER BY role",
      [patientId],
    );
    expect(rows).toEqual([
      { role: "primary_rn", n: 1 },
      { role: "rn", n: 2 },
    ]);
  });

  it("refuses a duplicate open (patient, clinician, role) with 409 ASSIGNMENT_ALREADY_OPEN", async () => {
    expect((await assign(RN_1, "np")).statusCode).toBe(201);
    const dup = await assign(RN_1, "np");
    expect(dup.statusCode).toBe(409);
    expect(JSON.stringify(dup.json())).toContain("ASSIGNMENT_ALREADY_OPEN");
    // A different role for the same clinician is a distinct assignment.
    expect((await assign(RN_1, "chaplain")).statusCode).toBe(201);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM patient_assignment WHERE patient_id=$1",
      [patientId],
    );
    expect(rows[0].n).toBe(2);
  });

  it("serialises concurrent identical assigns: exactly one wins", async () => {
    const results = await Promise.all([assign(RN_1, "md"), assign(RN_1, "md"), assign(RN_1, "md")]);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
  });

  it("ending twice is 409 ASSIGNMENT_ALREADY_ENDED; an end before the start is 422", async () => {
    const created = (await assign(RN_1, "aide")).json();
    const early = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/assignments/${created.id}/end`,
      headers: asDon,
      payload: { unassignedAt: "1999-01-01" },
    });
    expect(early.statusCode).toBe(422);
    expect((await end(created.id)).statusCode).toBe(200);
    const again = await end(created.id);
    expect(again.statusCode).toBe(409);
    expect(JSON.stringify(again.json())).toContain("ASSIGNMENT_ALREADY_ENDED");
  });

  it("refuses a clinician who is not an active member of the organization (422)", async () => {
    const res = await assign(OUTSIDER, "np");
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain("CLINICIAN_NOT_IN_ORG");
    expect(await eventTypes()).toEqual([]);
  });

  it("another tenant cannot see, assign to, or end on this patient (RLS)", async () => {
    const created = (await assign(RN_1, "volunteer")).json();
    const get = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}/assignments`,
      headers: asDonB,
    });
    expect(get.statusCode).toBe(404);
    expect((await assign(DON_B, "np", asDonB)).statusCode).toBe(404);
    expect((await end(created.id, asDonB)).statusCode).toBe(404);
    // …and the row is untouched.
    const { rows } = await admin.query("SELECT unassigned_at FROM patient_assignment WHERE id=$1", [
      created.id,
    ]);
    expect(rows[0].unassigned_at).toBeNull();
  });
});
