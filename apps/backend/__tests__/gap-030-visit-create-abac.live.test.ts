/**
 * GAP-030 — `POST /api/v1/visits` was permanently unreachable in production: 3 of its 4 §4.7 D8
 * pre-schedule ABAC predicates (`discipline_matches_visit`, `within_caseload_or_unassigned_pool`,
 * plus `clinician_credentials_active`) were backed by unconditional deny stubs in the DB-backed
 * `SchedulingAbacResolver` (`resolveDiscipline` always returned `null`, `isInCaseload`/
 * `allowsUnassignedPool` always returned `false`) — the route's own preHandler chain was correctly
 * wired, but every real caller was denied regardless of RBAC/role, because the underlying facts
 * were fake. Fixed in `scheduling-route-service-db.ts` by resolving real M3 `membership_role`/
 * `role` data (discipline) and the real M5 `CaseloadProvider` seam (caseload) — which itself needed
 * a Drizzle-backed store wired at boot (`createDrizzleCaseloadStore`, previously registered ONLY
 * with the empty in-memory default in production, a separate platform-wide finding this fix also
 * closes).
 *
 * `clinician_credentials_active` (the 4th predicate) is now ALSO real (GAP-093: the new M17
 * `CredentialReader` seam over `membership_credential`) and re-attached to `POST /visits` — every
 * clinician `bootApp` grants a role to is ALSO granted a matching credential here, so these tests
 * keep isolating discipline/caseload the way they did before GAP-093 landed (the credential gate
 * passing is a fixture precondition, not what these 3 scenarios are about; GAP-093's own live test
 * covers the credential gate itself, including revoke-denies-again).
 *
 * Proves it end-to-end through the REAL `mountSchedulingRoutes` (not the in-memory slice) against
 * real Postgres — the exact seam boundary (predicate → SchedulingAbacResolver → M3 tables / M5
 * CaseloadProvider seam) GAP-030's fix crosses, so the test crosses it too rather than stubbing past
 * it (GAP-013's precedent).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-030-visit-create-abac.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createDrizzleCaseloadStore } from "../src/modules/05-patient/seams/drizzle-stores";
import {
  buildSchedulingAbacPredicates,
  createDbSchedulingBackend,
  registerSchedulingRoutes,
  registerSchedulingSeams,
} from "../src/modules/17-scheduling/index";
import { createDrizzleCredentialStore } from "../src/modules/17-scheduling/seams/credentials-drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
}

describe.skipIf(!DB_URL)("GAP-030 — M17 visit-create ABAC — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let org: string;
  let pe: string;
  let location: string;
  let rnRoleId: string;

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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    org = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('gap030','GAP030','GAP030') RETURNING id",
      )
    ).rows[0].id as string;
    pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-G30','G30','NPI-G30','enc','12-31') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    rnRoleId = (
      await admin.query(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'rn','Registered Nurse','clinical_staff') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  /** A patient scoped to just one test — avoids `patient_assignment_primary_rn_unique` collisions
   *  across the independent scenarios below. */
  async function seedPatient(suffix: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,$2,'Case','Load','1990-01-01','F','active') RETURNING id`,
        [org, `MRN-G30-${suffix}`],
      )
    ).rows[0].id as string;
  }

  /** A user + membership (sited to org/pe/location) + optional 'rn' role grant (the shared role row). */
  async function seedClinician(opts: { rn: boolean }): Promise<{
    userId: string;
    membershipId: string;
  }> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `g30-${suffix}@x.test`,
      ])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
         VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
        [userId, org, pe, JSON.stringify([location])],
      )
    ).rows[0].id as string;
    if (opts.rn) {
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
        [org, membershipId, rnRoleId],
      );
      // GAP-093 — ABAC_CREDENTIALS now runs alongside discipline/caseload; grant a matching credential
      // so these tests keep isolating discipline/caseload rather than tripping the (separately-tested)
      // credential gate.
      await admin.query(
        `INSERT INTO membership_credential (organization_id, membership_id, credential_type, effective_at, granted_by_membership_id)
         VALUES ($1,$2,'rn','2020-01-01',$2)`,
        [org, membershipId],
      );
    }
    return { userId, membershipId };
  }

  async function assignToCaseload(patientId: string, clinicianUserId: string): Promise<void> {
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
      [patientId, org, clinicianUserId],
    );
  }

  /** Boots a real server over the REAL DB-backed route service + a fresh ABAC registry manually loaded
   *  with M17's real predicate FUNCTIONS (the GAP-013 pattern) — `registerPredicateIdempotent` (what
   *  `mountSchedulingRoutes`'s internal `_registerM17Abac` calls) always writes to the platform's fixed
   *  singleton registry, not whichever registry `registerAbacRegistry` last swapped in, so a fresh
   *  per-test registry must be populated directly via the exported pure `buildSchedulingAbacPredicates`
   *  factory or `requireAbac` finds nothing registered and fails closed regardless of this fix. */
  function bootApp(grantedUserId: string) {
    resetAuthorizationContract();
    resetRbacEngine();
    const { store: grantStore } = createInMemoryEffectivePermissionStore([
      {
        orgId: org,
        userId: grantedUserId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["visit.create"] },
        ],
      },
    ]);
    registerEffectivePermissionResolver(grantStore);
    registerPatientSeams({
      db: handle.db,
      caseload: { store: createDrizzleCaseloadStore(handle.db) },
    });
    registerSchedulingSeams({ credentials: { store: createDrizzleCredentialStore(handle.db) } });

    const backend = createDbSchedulingBackend(handle.db);
    const registry = createPredicateRegistry();
    const predicates = buildSchedulingAbacPredicates({ resolver: backend });
    for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
    registerAbacRegistry(registry);

    const app = buildServer({
      db: handle.db as never,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerSchedulingRoutes(app, { service: backend });
    return app;
  }

  function visitPayload(patientId: string, assignedMembershipId: string) {
    const start = new Date(Date.now() + 10 * 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    return {
      patientId,
      admissionId: patientId, // app-validated, no cross-module FK — any uuid is legal
      patientAddressId: null,
      externalFacilityId: null,
      assignedMembershipId,
      visitPurpose: "routine_visit",
      visitSetting: "patient_home",
      scheduledStartedAt: start.toISOString(),
      scheduledEndedAt: end.toISOString(),
    };
  }

  it("201: RN in the patient's caseload — discipline_matches_visit + within_caseload_or_unassigned_pool both resolve real data", async () => {
    const patientId = await seedPatient("a");
    const rn = await seedClinician({ rn: true });
    await assignToCaseload(patientId, rn.userId);
    const app = bootApp(rn.userId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: {
        "x-test-user": rn.userId,
        "x-test-membership": rn.membershipId,
        "x-test-org": org,
      },
      payload: visitPayload(patientId, rn.membershipId),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignedMembershipId).toBe(rn.membershipId);
    await app.close();
  });

  it("403: no role grant at all — resolveDiscipline correctly resolves null, discipline_matches_visit denies", async () => {
    const patientId = await seedPatient("b");
    const noDiscipline = await seedClinician({ rn: false });
    await assignToCaseload(patientId, noDiscipline.userId);
    const app = bootApp(noDiscipline.userId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: {
        "x-test-user": noDiscipline.userId,
        "x-test-membership": noDiscipline.membershipId,
        "x-test-org": org,
      },
      payload: visitPayload(patientId, noDiscipline.membershipId),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("403: RN NOT in the patient's caseload, pool closed — isInCaseload correctly resolves false", async () => {
    const patientId = await seedPatient("c");
    const rn = await seedClinician({ rn: true });
    // deliberately no assignToCaseload() call — the clinician holds no patient_assignment row.
    const app = bootApp(rn.userId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: {
        "x-test-user": rn.userId,
        "x-test-membership": rn.membershipId,
        "x-test-org": org,
      },
      payload: visitPayload(patientId, rn.membershipId),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
