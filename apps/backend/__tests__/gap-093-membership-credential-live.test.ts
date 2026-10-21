/**
 * GAP-093 — M17's `clinician_credentials_active` (§1.1 D8 predicate) was a permanent deny stub: no
 * clinical-license/credential data model existed anywhere in the platform (M17's own spec assumes an
 * `m2.credential-reader` seam M2 never built), so `ABAC_CREDENTIALS` was deliberately OMITTED from
 * `POST /api/v1/visits`'s preHandler chain (GAP-030) rather than left wired-but-fake — wiring it back
 * in without real data would have 100%-denied the route again.
 *
 * Fixed by building the real thing: M5-style `CredentialProvider` (M17's own `CredentialReader` seam)
 * over a new `membership_credential` table, plus the management surface that makes it satisfiable —
 * `POST/GET/DELETE /api/v1/memberships/:membershipId/credentials` — so `ABAC_CREDENTIALS` could be
 * re-attached to the create route for real.
 *
 * Proves the full loop against REAL Postgres: no credential granted ⇒ 403; grant an 'rn' credential ⇒
 * 201; revoke it ⇒ 403 again; the grant/revoke/list routes themselves round-trip through the real
 * `membership_credential` table.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-093-membership-credential-live.test.ts
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
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

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

describe.skipIf(!DB_URL)("GAP-093 — M17 membership_credential + D8 gate — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let org: string;
  let rnRoleId: string;
  let patientId: string;
  let rn: { userId: string; membershipId: string };

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
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('gap093','GAP093','GAP093') RETURNING id",
      )
    ).rows[0].id as string;
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-G93','G93','NPI-G93','enc','12-31') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const location = (
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
    patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-G93','Cred','Ential','1990-01-01','F','active') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('g93-rn@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
         VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
        [userId, org, pe, JSON.stringify([location])],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
      [org, membershipId, rnRoleId],
    );
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
      [patientId, org, userId],
    );
    rn = { userId, membershipId };

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
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

  /** The GAP-030 `bootApp` pattern, extended to also register the GAP-093 CredentialReader seam
   *  (`registerSchedulingSeams`) — `credentialsActiveForPurpose` resolves through `getSeam` now. */
  function bootApp(grantedUserId: string) {
    resetAuthorizationContract();
    resetRbacEngine();
    const { store: grantStore } = createInMemoryEffectivePermissionStore([
      {
        orgId: org,
        userId: grantedUserId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [
              "visit.create",
              "membership_credential.grant",
              "membership_credential.revoke",
              "membership_credential.read",
            ],
          },
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

  function visitPayload() {
    const start = new Date(Date.now() + 10 * 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    return {
      patientId,
      admissionId: patientId,
      patientAddressId: null,
      externalFacilityId: null,
      assignedMembershipId: rn.membershipId,
      visitPurpose: "routine_visit",
      visitSetting: "patient_home",
      scheduledStartedAt: start.toISOString(),
      scheduledEndedAt: end.toISOString(),
    };
  }

  it("403: RN role granted, in caseload, but NO credential ever granted — clinician_credentials_active denies", async () => {
    const app = bootApp(rn.userId);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: {
        "x-test-user": rn.userId,
        "x-test-membership": rn.membershipId,
        "x-test-org": org,
      },
      payload: visitPayload(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("grant → 201 create → revoke → 403 again, round-tripping through the real membership_credential table", async () => {
    const app = bootApp(rn.userId);
    const headers = {
      "x-test-user": rn.userId,
      "x-test-membership": rn.membershipId,
      "x-test-org": org,
    };

    // grant an 'rn' credential, effective well in the past, non-expiring
    const grantRes = await app.inject({
      method: "POST",
      url: `/api/v1/memberships/${rn.membershipId}/credentials`,
      headers,
      payload: { credentialType: "rn", effectiveAt: "2020-01-01", issuingBody: "Oregon BON" },
    });
    expect(grantRes.statusCode).toBe(201);
    const credentialId = grantRes.json().id as string;
    expect(grantRes.json().status).toBe("active");

    // list reflects the real row
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/memberships/${rn.membershipId}/credentials`,
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toHaveLength(1);
    expect(listRes.json()[0].id).toBe(credentialId);

    // NOW the D8 gate passes for real
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers,
      payload: visitPayload(),
    });
    expect(createRes.statusCode).toBe(201);

    // revoke it
    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/memberships/${rn.membershipId}/credentials/${credentialId}`,
      headers,
      payload: { reason: "license lapsed per state board notice" },
    });
    expect(revokeRes.statusCode).toBe(204);

    // and the gate denies again — a revoked credential must not silently keep working
    const deniedRes = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers,
      payload: visitPayload(),
    });
    expect(deniedRes.statusCode).toBe(403);

    // raw-row check: revoked_at/reason landed for real, status flipped
    const row = await admin.query(
      `SELECT status, revoked_at, revoked_reason FROM membership_credential WHERE id=$1`,
      [credentialId],
    );
    expect(row.rows[0].status).toBe("revoked");
    expect(row.rows[0].revoked_at).not.toBeNull();
    expect(row.rows[0].revoked_reason).toBe("license lapsed per state board notice");

    await app.close();
  });
});
