/**
 * GAP-034 - the two M23 eligibility PHI reads (`/hospice-periods`, `/latest`) leave a real `audit_event` row,
 * LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Before: both declared `auditRead` with no patient / resource id, so the audit insert bound an empty string to
 * the uuid `resource_id` column, failed, and the best-effort wrapper swallowed it - the read left no trail. The
 * routes now name `?patientId=` and the read is accounted against that patient (45 CFR 164.528).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:eligibility-read-audit:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerEligibilityRoutes } from "../src/modules/23-billing-medicare/routes/eligibility.routes";
import type { M23ReadRouteService } from "../src/modules/23-billing-medicare/routes/read-service";
import type { M23WriteRouteService } from "../src/modules/23-billing-medicare/routes/write-service";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { installPermissiveConsentAbac } from "./consent-abac-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";

function headerAuth(request: FastifyRequest): void {
  request.context.userId = USER;
  request.context.organizationId = ORG;
  request.context.roles = ["billing_manager"];
}

const readService = {
  getLatestEligibility: async () => ({ patientId: PATIENT, status: "active" }),
  getHospicePeriods: async () => ({ patientId: PATIENT, periods: [] }),
} as unknown as M23ReadRouteService;

describe.skipIf(!DB_URL)("GAP-034 eligibility read-audit - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  const events = async () =>
    (
      await admin.query(
        `SELECT event_type, resource_id::text, context FROM audit_event
          WHERE organization_id = $1 ORDER BY created_at`,
        [ORG],
      )
    ).rows as Array<{
      event_type: string;
      resource_id: string | null;
      context: Record<string, unknown>;
    }>;

  function makeApp() {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: USER,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.eligibility.read"],
            },
          ],
        },
      ]).store,
    );
    installPermissiveConsentAbac();
    const app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerEligibilityRoutes(app, { readService, writeService: {} as M23WriteRouteService });
    return app;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'gap034@x.test')`, [USER]);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await admin.query("DELETE FROM audit_event WHERE organization_id = $1", [ORG]);
  });

  it.each([
    ["/api/v1/billing/eligibility/latest", "eligibility_check.viewed"],
    ["/api/v1/billing/eligibility/hospice-periods", "eligibility_check.viewed"],
  ])("GET %s writes a read event attributed to the patient", async (path, eventType) => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: `${path}?patientId=${PATIENT}` });
    expect(res.statusCode).toBe(200);
    await app.close();

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe(eventType);
    expect(rows[0]?.resource_id).toBe(PATIENT);
    expect(rows[0]?.context.patientId).toBe(PATIENT);
  });
});
