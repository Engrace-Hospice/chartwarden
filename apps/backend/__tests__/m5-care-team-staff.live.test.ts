/**
 * Care-team staff lookup (GET /api/v1/orgs/:id/care-team-staff) against REAL Postgres as the
 * NOBYPASSRLS `wardenx_app` role. Proves through the real route + Drizzle port:
 *   - a holder of patient.assign gets active members of ITS org only (suspended and other-tenant users
 *     absent), name-ordered, with role labels, and no email / username in the payload;
 *   - `q` is a literal display-name substring (LIKE wildcards do not match everything) and never
 *     matches an email; `limit` bounds the result;
 *   - a patient.read-only caller is refused (403), as is a path org other than the bound org.
 *
 * WARDENX_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m5-care-team-staff.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbCareTeamStaffPort } from "../src/modules/05-patient/care-team-staff-db";
import { registerCareTeamStaffRoutes } from "../src/modules/05-patient/routes/care-team-staff-routes";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const DB_ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const U = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;
const ASSIGNER = U(1);
const READER = U(2);
const NORA = U(3);
const SUSPENDED = U(4);
const OTHER_ORG = U(5);
const PERCENT = U(6);

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  request.context.roles = [];
}
const asAssigner = { "x-test-user": ASSIGNER, "x-test-org": ORG_A };
const asReader = { "x-test-user": READER, "x-test-org": ORG_A };

describe.skipIf(!DB_URL)("care-team staff lookup — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const get = (url: string, headers: Record<string, string> = asAssigner) =>
    app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of DB_ROLES) {
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
      [ORG_A, "org-cts-a"],
      [ORG_B, "org-cts-b"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    const users: [string, string, string][] = [
      [ASSIGNER, "Dana Director", "dana@cts.test"],
      [READER, "Rita Reader", "rita@cts.test"],
      [NORA, "Nora Visit", "nora-secret@cts.test"],
      [SUSPENDED, "Sam Suspended", "sam@cts.test"],
      [OTHER_ORG, "Olga Elsewhere", "olga@cts.test"],
      [PERCENT, "100% Pat", "pat@cts.test"],
    ];
    for (const [id, name, email] of users)
      await admin.query(`INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)`, [id, name, email]);
    const members: [string, string, string][] = [
      [ASSIGNER, ORG_A, "active"],
      [READER, ORG_A, "active"],
      [NORA, ORG_A, "active"],
      [SUSPENDED, ORG_A, "suspended"],
      [PERCENT, ORG_A, "active"],
      [OTHER_ORG, ORG_B, "active"],
    ];
    for (const [user, org, status] of members)
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3)",
        [user, org, status],
      );
    const role = await admin.query(
      `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'cts_rn','Registered Nurse','clinical_staff') RETURNING id`,
      [ORG_A],
    );
    await admin.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id)
       SELECT $1, id, $2 FROM membership WHERE user_id=$3 AND organization_id=$1`,
      [ORG_A, role.rows[0].id, NORA],
    );

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const grants = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG_A,
        userId: ASSIGNER,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["patient.read", "patient.assign"],
          },
        ],
      },
      {
        orgId: ORG_A,
        userId: READER,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["patient.read"] },
        ],
      },
    ]);
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(grants.store);
    registerAbacRegistry();
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerCareTeamStaffRoutes(app, { staff: createDbCareTeamStaffPort(handle.db) });
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close?.();
    await admin?.end();
  });

  it("lists only this org's active members with role labels and no email/username", async () => {
    const res = await get(`/api/v1/orgs/${ORG_A}/care-team-staff`);
    expect(res.statusCode).toBe(200);
    const staff = res.json().staff as {
      userId: string;
      displayName: string;
      roleLabels: string[];
    }[];
    expect(staff.map((s) => s.displayName)).toEqual([
      "100% Pat",
      "Dana Director",
      "Nora Visit",
      "Rita Reader",
    ]);
    expect(staff.find((s) => s.userId === NORA)?.roleLabels).toEqual(["Registered Nurse"]);
    expect(res.body).not.toContain("cts.test");
    expect(res.body).not.toContain("Sam Suspended");
    expect(res.body).not.toContain("Olga Elsewhere");
    expect(Object.keys(staff[0] as object).sort()).toEqual([
      "displayName",
      "membershipId",
      "roleLabels",
      "userId",
    ]);
  });

  it("filters by literal display-name substring, not by email or LIKE wildcards", async () => {
    const byName = (await get(`/api/v1/orgs/${ORG_A}/care-team-staff?q=nora`)).json().staff;
    expect(byName).toHaveLength(1);
    expect((await get(`/api/v1/orgs/${ORG_A}/care-team-staff?q=secret`)).json().staff).toEqual([]);
    expect((await get(`/api/v1/orgs/${ORG_A}/care-team-staff?q=%25`)).json().staff).toHaveLength(1);
    expect((await get(`/api/v1/orgs/${ORG_A}/care-team-staff?q=_`)).json().staff).toEqual([]);
  });

  it("bounds the result with limit", async () => {
    const res = await get(`/api/v1/orgs/${ORG_A}/care-team-staff?limit=2`);
    expect(res.json().staff).toHaveLength(2);
  });

  it("refuses a patient.read-only caller and a path org that is not the bound org (403)", async () => {
    expect((await get(`/api/v1/orgs/${ORG_A}/care-team-staff`, asReader)).statusCode).toBe(403);
    expect((await get(`/api/v1/orgs/${ORG_B}/care-team-staff`)).statusCode).toBe(403);
  });
});
