/**
 * `GET /api/v1/discipline-plans/:planId/aide-supervision-roster` — the staff pickers of the Aide POC
 * supervisory-visit modal, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The modal used to ask an RN to type two membership uuids, and the only staff list the platform has needs
 * org-admin rights. The route is plan-scoped and minimum-necessary: it must (a) work for an RN holding only
 * `discipline_plan.read`, (b) offer exactly the ACTIVE aides (`chha`) and RN supervisors (`rn`,
 * `rn_case_manager`) whose effective reach covers the plan's location, (c) never cross a tenant — an unknown or
 * another tenant's plan is one 404 — and (d) return nothing but `{ membershipId, displayName, roleKey }`.
 *
 * The same suite proves `PUT .../aide-assignment`: the RN picks the plan's aide and supervising RN from that roster and the
 * write service re-checks both against it (an off-site, suspended, expired, narrowed, wrong-role or other-tenant member is
 * refused 422 and nothing is written), is version-checked, kind-checked and caseload-scoped, and the plan row change lands in
 * the row audit trail.
 *
 * The real Drizzle read and write services and the real M3 staff reader run over the real RLS policies; only the caseload
 * seam (M5) and the permission store are in-memory, as in every route-level live suite.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m15:aide-roster:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { staffAtLocationForOrg } from "../src/modules/03-authorization/staff-at-location-for-org";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";
import {
  buildDrizzleM15ReadService,
  buildDrizzleM15WriteService,
  mountM15Routes,
} from "../src/modules/15-discipline-care-plans/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

// Synthetic staff and patients only (no real identifiers).
const U_CALLER = "a0000000-0000-4000-8000-000000000001"; // the RN making the request
const U_OFF_CASELOAD = "a0000000-0000-4000-8000-000000000002"; // an RN not on the patient's caseload
const U_NO_PERMISSION = "a0000000-0000-4000-8000-000000000003";
const U_AIDE = "a0000000-0000-4000-8000-000000000011";
const U_AIDE_OFFSITE = "a0000000-0000-4000-8000-000000000012";
const U_AIDE_SUSPENDED_MEMBER = "a0000000-0000-4000-8000-000000000013";
const U_AIDE_SUSPENDED_USER = "a0000000-0000-4000-8000-000000000014";
const U_AIDE_EXPIRED_GRANT = "a0000000-0000-4000-8000-000000000015";
const U_AIDE_NARROWED = "a0000000-0000-4000-8000-000000000016";
const U_CASE_MANAGER = "a0000000-0000-4000-8000-000000000021";
const U_LPN = "a0000000-0000-4000-8000-000000000031";
const U_B_AIDE = "a0000000-0000-4000-8000-000000000041";

const PATIENT = "c0000000-0000-4000-8000-000000000001";
const PATIENT_B = "c0000000-0000-4000-8000-000000000002";
const UNKNOWN_PLAN = "99999999-9999-4999-8999-999999999999";

/** userId → patients on that user's caseload (the M5 seam, in-memory). */
const CASELOAD: Record<string, readonly string[]> = {
  [U_CALLER]: [PATIENT],
  [U_NO_PERMISSION]: [PATIENT],
  [U_OFF_CASELOAD]: [],
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG_A;
  request.context.roles = ["rn"]; // no org-admin, no org-wide scope role
}

describe.skipIf(!DB_URL)("aide-supervision roster — LIVE Postgres, NOBYPASSRLS app role", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const memberOf: Record<string, string> = {};
  const roleOf: Record<string, string> = {};
  const locOf: Record<string, string> = {};
  let planA: string;
  let planB: string;
  let mswPlanA: string;

  async function user(id: string, name: string | null, status = "active"): Promise<void> {
    await admin.query(`INSERT INTO "user" (id, email, name, status) VALUES ($1,$2,$3,$4)`, [
      id,
      `${id.slice(-4)}-roster@x.test`,
      name,
      status,
    ]);
  }
  async function member(
    userId: string,
    org: string,
    locations: readonly string[],
    status = "active",
  ): Promise<void> {
    const { rows } = await admin.query(
      `INSERT INTO membership (user_id, organization_id, status, default_location_ids)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
      [userId, org, status, JSON.stringify(locations)],
    );
    memberOf[userId] = rows[0].id as string;
  }
  async function grant(
    userId: string,
    org: string,
    roleKey: string,
    opts: { expiresAt?: string | null; scope?: object } = {},
  ): Promise<void> {
    await admin.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id, scope, expires_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [
        org,
        memberOf[userId],
        roleOf[`${org}:${roleKey}`],
        opts.scope ?? {},
        opts.expiresAt ?? null,
      ],
    );
  }
  async function plan(org: string, kind: string, patientId: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO discipline_care_plan
         (organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status)
       VALUES ($1,$2,gen_random_uuid(),$3,$4,$5,'active') RETURNING id`,
      [org, patientId, peOf(org), locOf[`${org}:main`], kind],
    );
    return rows[0].id as string;
  }
  const peByOrg: Record<string, string> = {};
  const peOf = (org: string): string => peByOrg[org] as string;

  const get = (planId: string, asUser: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/discipline-plans/${planId}/aide-supervision-roster`,
      headers: { "x-test-user": asUser },
    });

  type Member = { membershipId: string; displayName: string; roleKey: string };
  type Body = { aides: Member[]; supervisors: Member[] };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const org of [ORG_A, ORG_B]) {
      peByOrg[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `PE ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      for (const site of ["main", "other"]) {
        locOf[`${org}:${site}`] = (
          await admin.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
               VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [peByOrg[org], `Loc ${site}`],
          )
        ).rows[0].id as string;
      }
      for (const key of ["chha", "rn", "rn_case_manager", "lpn"]) {
        roleOf[`${org}:${key}`] = (
          await admin.query(
            `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
               VALUES ($1,$2,$3,'clinical_staff','organization',true,'roster live suite') RETURNING id`,
            [org, key, key],
          )
        ).rows[0].id as string;
      }
    }
    const main = locOf[`${ORG_A}:main`] as string;
    const other = locOf[`${ORG_A}:other`] as string;

    await user(U_CALLER, "Riley Reader");
    await user(U_OFF_CASELOAD, "Olive Offcaseload");
    await user(U_NO_PERMISSION, "Nat Noperm");
    await user(U_AIDE, "Avery Aide");
    await user(U_AIDE_OFFSITE, "Orin Offsite");
    await user(U_AIDE_SUSPENDED_MEMBER, "Sam Suspended");
    await user(U_AIDE_SUSPENDED_USER, "Uma Userlocked", "suspended");
    await user(U_AIDE_EXPIRED_GRANT, "Eli Expired");
    await user(U_AIDE_NARROWED, "Nell Narrowed");
    await user(U_CASE_MANAGER, null); // no name on file -> labelled by a short id, never the email
    await user(U_LPN, "Lee Practical");
    await user(U_B_AIDE, "Bea Otherorg");

    await member(U_CALLER, ORG_A, [main]);
    await member(U_OFF_CASELOAD, ORG_A, [main]);
    await member(U_NO_PERMISSION, ORG_A, [main]);
    await member(U_AIDE, ORG_A, [main]);
    await member(U_AIDE_OFFSITE, ORG_A, [other]);
    await member(U_AIDE_SUSPENDED_MEMBER, ORG_A, [main], "suspended");
    await member(U_AIDE_SUSPENDED_USER, ORG_A, [main]);
    await member(U_AIDE_EXPIRED_GRANT, ORG_A, [main]);
    await member(U_AIDE_NARROWED, ORG_A, [main, other]);
    await member(U_CASE_MANAGER, ORG_A, [main]);
    await member(U_LPN, ORG_A, [main]);
    await member(U_B_AIDE, ORG_B, [locOf[`${ORG_B}:main`] as string]);

    await grant(U_CALLER, ORG_A, "rn");
    await grant(U_OFF_CASELOAD, ORG_A, "rn");
    await grant(U_NO_PERMISSION, ORG_A, "rn");
    await grant(U_AIDE, ORG_A, "chha");
    await grant(U_AIDE_OFFSITE, ORG_A, "chha");
    await grant(U_AIDE_SUSPENDED_MEMBER, ORG_A, "chha");
    await grant(U_AIDE_SUSPENDED_USER, ORG_A, "chha");
    await grant(U_AIDE_EXPIRED_GRANT, ORG_A, "chha", { expiresAt: "2020-01-01T00:00:00Z" });
    // Sited at both locations, but the aide grant itself is narrowed to the OTHER one.
    await grant(U_AIDE_NARROWED, ORG_A, "chha", { scope: { locationIds: [other] } });
    await grant(U_CASE_MANAGER, ORG_A, "rn_case_manager");
    await grant(U_LPN, ORG_A, "lpn");
    await grant(U_B_AIDE, ORG_B, "chha");

    planA = await plan(ORG_A, "aide_poc", PATIENT);
    mswPlanA = await plan(ORG_A, "msw_plan", PATIENT);
    planB = await plan(ORG_B, "aide_poc", PATIENT_B);

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
    resetAbacRegistry();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [U_CALLER, U_OFF_CASELOAD]
          .map((userId) => ({
            orgId: ORG_A,
            userId,
            grants: [
              {
                roleKey: "seed",
                enabled: true,
                expiresAt: null,
                // Read and author only: no org-admin, no member-list permission.
                permissionKeys: ["discipline_plan.read", "discipline_plan.author"],
              },
            ],
          }))
          .concat([{ orgId: ORG_A, userId: U_NO_PERMISSION, grants: [] }]),
      ).store,
    );
    const isInCaseload = async ({ userId, patientId }: { userId: string; patientId: string }) =>
      (CASELOAD[userId] ?? []).includes(patientId);
    const aideRoster = {
      listStaffAtLocation: (query: Parameters<typeof staffAtLocationForOrg>[1]) =>
        staffAtLocationForOrg(handle.db, query),
    };
    // The shared patient-scope guard the write routes bind by name, over the in-memory caseload.
    registerAbacRegistry();
    registerPredicateIdempotent(
      "caseload_or_scope",
      buildCarePlanAbacPredicates({
        resolver: {
          loadPlan: async () => null,
          loadProblem: async () => null,
          loadVersion: async () => null,
        },
        isInCaseload,
      }).caseload_or_scope,
    );
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    mountM15Routes(app, {
      readService: buildDrizzleM15ReadService(handle.db, {
        caseload: { isInCaseload },
        aideRoster,
      }),
      writeService: buildDrizzleM15WriteService(handle.db, { isInCaseload, aideRoster }),
    });
    await admin.query("DELETE FROM audit_event WHERE organization_id = $1", [ORG_A]);
  });

  afterEach(async () => {
    await app.close();
    await admin.query("UPDATE role SET enabled = true WHERE organization_id = $1", [ORG_A]);
  });

  it("connects as the real NOBYPASSRLS app role, which cannot read another tenant's memberships", async () => {
    const [who] = (
      await handle.pool.query<{ current_user: string; rolbypassrls: boolean }>(
        "SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls",
      )
    ).rows;
    expect(who).toEqual({ current_user: "chartwarden_app", rolbypassrls: false });
    const crossTenant = await withOrgContext(
      handle.db,
      { organizationId: ORG_A, userId: "" },
      (tx) =>
        tx.select().from(schema.memberships).where(eq(schema.memberships.organizationId, ORG_B)),
    );
    expect(crossTenant).toEqual([]);
  });

  it("an RN holding only discipline_plan.read gets the plan location's aides and supervisors", async () => {
    const res = await get(planA, U_CALLER);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    // Only the active aide sited at the plan's location: not the off-site, suspended, expired or narrowed ones.
    expect(body.aides).toEqual([
      { membershipId: memberOf[U_AIDE], displayName: "Avery Aide", roleKey: "chha" },
    ]);
    // RNs and RN case managers at the location; a member with no name on file is labelled by a short id.
    expect(body.supervisors).toEqual(
      expect.arrayContaining([
        { membershipId: memberOf[U_CALLER], displayName: "Riley Reader", roleKey: "rn" },
        { membershipId: memberOf[U_OFF_CASELOAD], displayName: "Olive Offcaseload", roleKey: "rn" },
        {
          membershipId: memberOf[U_CASE_MANAGER],
          displayName: `Member ${(memberOf[U_CASE_MANAGER] as string).slice(0, 8)}`,
          roleKey: "rn_case_manager",
        },
      ]),
    );
    expect(body.supervisors.map((m) => m.membershipId)).not.toContain(memberOf[U_LPN]);
    expect(body.supervisors.map((m) => m.displayName)).toEqual(
      [...body.supervisors.map((m) => m.displayName)].sort((a, b) => a.localeCompare(b, "en")),
    );
  });

  it("excludes suspended, deactivated, expired, narrowed, off-site and other-tenant staff", async () => {
    const body = (await get(planA, U_CALLER)).json() as Body;
    const listed = new Set([...body.aides, ...body.supervisors].map((m) => m.membershipId));
    for (const excluded of [
      U_AIDE_OFFSITE,
      U_AIDE_SUSPENDED_MEMBER,
      U_AIDE_SUSPENDED_USER,
      U_AIDE_EXPIRED_GRANT,
      U_AIDE_NARROWED,
      U_LPN,
      U_B_AIDE,
    ]) {
      expect(listed.has(memberOf[excluded] as string), excluded).toBe(false);
    }
  });

  it("drops a member whose role the tenant has disabled", async () => {
    await admin.query(
      "UPDATE role SET enabled = false WHERE organization_id = $1 AND key = 'chha'",
      [ORG_A],
    );
    const body = (await get(planA, U_CALLER)).json() as Body;
    expect(body.aides).toEqual([]);
  });

  it("returns nothing beyond membershipId, displayName and roleKey — no email, no user id, no patient data", async () => {
    const res = await get(planA, U_CALLER);
    const body = res.json() as Body;
    expect(Object.keys(body).sort()).toEqual(["aides", "supervisors"]);
    for (const m of [...body.aides, ...body.supervisors]) {
      expect(Object.keys(m).sort()).toEqual(["displayName", "membershipId", "roleKey"]);
    }
    expect(res.body).not.toContain("@x.test");
    expect(res.body).not.toContain(PATIENT);
    expect(res.body).not.toContain(U_AIDE); // the user id, as distinct from the membership id
  });

  it("answers another tenant's plan, an unknown plan and a non-aide plan with the same 404", async () => {
    for (const planId of [planB, UNKNOWN_PLAN, mswPlanA]) {
      const res = await get(planId, U_CALLER);
      expect(res.statusCode, planId).toBe(404);
      expect(res.body).not.toContain("Bea Otherorg");
      expect(res.json()).not.toHaveProperty("aides");
    }
  });

  it("answers an RN off the patient's caseload with a 404, and a caller without the read key with a 403", async () => {
    expect((await get(planA, U_OFF_CASELOAD)).statusCode).toBe(404);
    expect((await get(planA, U_NO_PERMISSION)).statusCode).toBe(403);
  });

  it("emits no plan-viewed read event: the body is a staff roster, and the route's audit is a reasoned waiver", async () => {
    expect((await get(planA, U_CALLER)).statusCode).toBe(200);
    const { rows } = await admin.query(
      "SELECT event_type, resource_id::text FROM audit_event WHERE organization_id = $1",
      [ORG_A],
    );
    expect(rows).toEqual([]);
  });
  describe("PUT .../aide-assignment", () => {
    let keySeq = 0;
    const planRow = async (planId: string) => {
      const row = (
        await admin.query(
          `SELECT aide_membership_id, supervising_rn_membership_id, version FROM discipline_care_plan WHERE id=$1`,
          [planId],
        )
      ).rows[0] as {
        aide_membership_id: string | null;
        supervising_rn_membership_id: string | null;
        version: string | number;
      };
      return { ...row, version: Number(row.version) };
    };
    const put = async (planId: string, asUser: string, body: object, ifMatch?: number) => {
      const version = ifMatch ?? (await planRow(planId)).version;
      keySeq += 1;
      return app.inject({
        method: "PUT",
        url: `/api/v1/discipline-plans/${planId}/aide-assignment`,
        headers: {
          "x-test-user": asUser,
          "if-match": String(version),
          "idempotency-key": `assign-${keySeq}`,
        },
        payload: body,
      });
    };
    const pick = (aide: string, rn: string) => ({
      aideMembershipId: memberOf[aide],
      supervisingRnMembershipId: memberOf[rn],
    });

    afterEach(async () => {
      await admin.query(
        `UPDATE discipline_care_plan SET aide_membership_id=NULL, supervising_rn_membership_id=NULL WHERE id=$1`,
        [planA],
      );
    });

    it("binds the picked aide and RN from the roster, bumps the version and leaves a row-audit entry", async () => {
      const before = (await planRow(planA)).version;
      const res = await put(planA, U_CALLER, pick(U_AIDE, U_CASE_MANAGER));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        planId: planA,
        aideMembershipId: memberOf[U_AIDE],
        supervisingRnMembershipId: memberOf[U_CASE_MANAGER],
        version: before + 1,
      });
      expect(await planRow(planA)).toEqual({
        aide_membership_id: memberOf[U_AIDE],
        supervising_rn_membership_id: memberOf[U_CASE_MANAGER],
        version: before + 1,
      });
      const { rows } = await admin.query(
        `SELECT event_type FROM audit_event WHERE organization_id=$1 AND resource_id::text=$2`,
        [ORG_A, planA],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it("refuses an aide who is off-site, suspended, expired, narrowed, the wrong role or in another tenant (422, nothing written)", async () => {
      for (const aide of [
        U_AIDE_OFFSITE,
        U_AIDE_SUSPENDED_MEMBER,
        U_AIDE_SUSPENDED_USER,
        U_AIDE_EXPIRED_GRANT,
        U_AIDE_NARROWED,
        U_LPN,
        U_CASE_MANAGER,
        U_B_AIDE,
      ]) {
        const res = await put(planA, U_CALLER, pick(aide, U_CASE_MANAGER));
        expect(res.statusCode, aide).toBe(422);
        expect(res.json().error?.code ?? res.json().code, aide).toBe("AIDE_NOT_ELIGIBLE");
      }
      expect(await planRow(planA)).toMatchObject({
        aide_membership_id: null,
        supervising_rn_membership_id: null,
      });
    });

    it("refuses a supervising RN who is an aide, an LPN or in another tenant (422)", async () => {
      for (const rn of [U_AIDE, U_LPN, U_B_AIDE]) {
        const res = await put(planA, U_CALLER, pick(U_AIDE, rn));
        expect(res.statusCode, rn).toBe(422);
        expect(res.json().error?.code ?? res.json().code, rn).toBe("SUPERVISING_RN_NOT_ELIGIBLE");
      }
      expect(await planRow(planA)).toMatchObject({ aide_membership_id: null });
    });

    it("is version-checked, aide-plan-only and caseload-scoped, and answers another tenant's plan with a 404", async () => {
      const { version } = await planRow(planA);
      expect(
        (await put(planA, U_CALLER, pick(U_AIDE, U_CASE_MANAGER), version + 5)).statusCode,
      ).toBe(409);
      const msw = await put(mswPlanA, U_CALLER, pick(U_AIDE, U_CASE_MANAGER));
      expect(msw.statusCode).toBe(422);
      expect(msw.json().error?.code ?? msw.json().code).toBe("NOT_AN_AIDE_POC");
      expect((await put(planA, U_OFF_CASELOAD, pick(U_AIDE, U_CASE_MANAGER))).statusCode).toBe(404);
      expect((await put(planB, U_CALLER, pick(U_AIDE, U_CASE_MANAGER), 0)).statusCode).toBe(404);
      expect((await put(UNKNOWN_PLAN, U_CALLER, pick(U_AIDE, U_CASE_MANAGER), 0)).statusCode).toBe(
        404,
      );
      expect((await put(planA, U_NO_PERMISSION, pick(U_AIDE, U_CASE_MANAGER))).statusCode).toBe(
        403,
      );
      expect(await planRow(planA)).toMatchObject({ aide_membership_id: null });
    });
  });
});
