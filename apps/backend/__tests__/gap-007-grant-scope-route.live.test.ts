/**
 * GAP-007 — `membership_role.scope` against a REAL database: the 422 through the real route and the real
 * `createDbMembershipRoleStore`, the CHECK that bounds every other writer, the quarantine of legacy blobs, the
 * fail-closed reader through the real actor enrichment, and tenant isolation as `wardenx_app` (NOBYPASSRLS).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:gap007:grant-scope:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite DROPs the wardenx_* roles. For a local PG without
 * pgvector also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  NO_REACH_ID,
  createDbActorEnrichmentReader,
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import {
  type RoleView,
  createFixedPermissionResolver,
  createInMemoryAuditorSessionMinter,
  createInMemoryBreakGlassStore,
  createInMemoryComplianceNotifier,
  createInMemoryEngagementStore,
  createInMemoryRoleStore,
  registerAuthorizationRoutes,
} from "../src/modules/03-authorization/index";
import { createDbMembershipRoleStore } from "../src/modules/03-authorization/membership-role-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const SHAPE_MIGRATION = "1050_m3_membership_role_scope_shape.sql";

const ORG_A = "11111111-1111-4111-8111-1111000a0007";
const ORG_B = "22222222-2222-4222-8222-2222000b0007";
const ADMIN_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER_USER = "aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER_B_USER = "bbbbbbbb-0000-4000-8000-000000000002";
const LOC_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LOC_Y = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PATIENT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

const roleView = (
  r: Pick<RoleView, "roleId" | "organizationId" | "key"> & Partial<RoleView>,
): RoleView => ({
  name: r.key,
  category: "operations",
  scopeLevel: "organization",
  systemDefault: false,
  systemLocked: false,
  enabled: true,
  customized: false,
  permissionKeys: [],
  ...r,
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
}

describe.skipIf(!DB_URL)("GAP-007 membership_role.scope — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const ids: Record<string, string> = {};

  async function applyMigrations(include: (file: string) => boolean) {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql") && include(x))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  const seedOrg = async (org: string, slug: string) => {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
      [org, slug],
    );
  };
  const seedUser = async (id: string, email: string) => {
    await admin.query(
      `INSERT INTO "user" (id,email,name,email_verified) VALUES ($1,$2,$2,true)`,
      [id, email],
    );
  };
  const seedMembership = async (user: string, org: string, locations: string[] = []) =>
    (
      await admin.query(
        `INSERT INTO membership (user_id,organization_id,status,default_location_ids)
         VALUES ($1,$2,'active',$3::jsonb) RETURNING id`,
        [user, org, JSON.stringify(locations)],
      )
    ).rows[0].id as string;
  const seedRole = async (org: string, key: string, scopeLevel = "organization") =>
    (
      await admin.query(
        `INSERT INTO role (organization_id,key,name,category,enabled,scope_level)
         VALUES ($1,$2,$2,'operations',true,$3) RETURNING id`,
        [org, key, scopeLevel],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    // Everything BEFORE the shape migration, so legacy blobs can be seeded and then quarantined by replaying it.
    await applyMigrations((f) => f < SHAPE_MIGRATION);
    await seedOrg(ORG_A, "gap007-a");
    await seedOrg(ORG_B, "gap007-b");
    await seedUser(ADMIN_USER, "gap007-admin@example.test");
    await seedUser(MEMBER_USER, "gap007-member@example.test");
    await seedUser(MEMBER_B_USER, "gap007-member-b@example.test");
    ids.adminMembership = await seedMembership(ADMIN_USER, ORG_A);
    ids.memberMembership = await seedMembership(MEMBER_USER, ORG_A, [LOC_X, LOC_Y]);
    ids.memberBMembership = await seedMembership(MEMBER_B_USER, ORG_B);
    ids.roleOrgWide = await seedRole(ORG_A, "gap007_ops");
    ids.roleLegacy = await seedRole(ORG_A, "gap007_legacy");
    ids.roleGood = await seedRole(ORG_A, "gap007_good");
    ids.roleBadShape = await seedRole(ORG_A, "gap007_badshape");
    ids.roleB = await seedRole(ORG_B, "gap007_b_ops");
    // Legacy blobs written before the CHECK existed: an unknown key, patient ids, a bare array, empty list, non-uuid.
    const legacyBlobs: [string, string, unknown][] = [
      [ids.memberMembership, ids.roleLegacy, { patientIds: [PATIENT] }],
      [ids.adminMembership, ids.roleLegacy, [LOC_X]],
      [ids.adminMembership, ids.roleBadShape, { locationIds: [] }],
      [ids.memberMembership, ids.roleBadShape, { locationIds: ["not-a-uuid"] }],
    ];
    for (const [membership, role, scope] of legacyBlobs) {
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id,scope) VALUES ($1,$2,$3,$4::jsonb)",
        [ORG_A, membership, role, JSON.stringify(scope)],
      );
    }
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id,scope) VALUES ($1,$2,$3,$4::jsonb)",
      [ORG_A, ids.memberMembership, ids.roleGood, JSON.stringify({ locationIds: [LOC_X] })],
    );
    await applyMigrations((f) => f >= SHAPE_MIGRATION);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  describe("migration replay: legacy blobs are quarantined, never widened", () => {
    it("moves each non-conforming blob to scope_legacy, resets scope and expires the grant", async () => {
      const { rows } = await admin.query(
        `SELECT membership_id, role_id, scope, scope_legacy, expires_at <= now() AS expired
           FROM membership_role WHERE organization_id = $1 AND role_id = ANY($2)`,
        [ORG_A, [ids.roleLegacy, ids.roleBadShape]],
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.scope).toEqual({});
        expect(row.scope_legacy).not.toBeNull();
        expect(row.expired).toBe(true);
      }
      const patientBlob = rows.find((r) => r.scope_legacy && "patientIds" in r.scope_legacy);
      expect(patientBlob?.scope_legacy).toEqual({ patientIds: [PATIENT] });
    });

    it("leaves a conforming grant untouched", async () => {
      const { rows } = await admin.query(
        "SELECT scope, scope_legacy, expires_at FROM membership_role WHERE role_id = $1",
        [ids.roleGood],
      );
      expect(rows[0]).toEqual({
        scope: { locationIds: [LOC_X] },
        scope_legacy: null,
        expires_at: null,
      });
    });

    it("is idempotent: replaying the migration changes nothing", async () => {
      const before = await admin.query("SELECT id, scope, scope_legacy, expires_at FROM membership_role ORDER BY id");
      await applyMigrations((f) => f === SHAPE_MIGRATION);
      const after = await admin.query("SELECT id, scope, scope_legacy, expires_at FROM membership_role ORDER BY id");
      expect(after.rows).toEqual(before.rows);
    });

    it("the quarantined grants no longer confer their role through the real actor enrichment", async () => {
      const reader = createDbActorEnrichmentReader(handle.db);
      const enriched = await reader.read({ orgId: ORG_A }, MEMBER_USER);
      expect(enriched?.roles).toEqual(["gap007_good"]);
    });
  });

  describe("the CHECK bounds every writer, as wardenx_app", () => {
    const tryInsert = async (scope: unknown): Promise<string | null> => {
      const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app.connect();
      try {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
        await app.query(
          "INSERT INTO membership_role (organization_id,membership_id,role_id,scope) VALUES ($1,$2,$3,$4::jsonb)",
          [ORG_A, ids.adminMembership, ids.roleOrgWide, JSON.stringify(scope)],
        );
        await app.query("ROLLBACK");
        return null;
      } catch (err) {
        await app.query("ROLLBACK").catch(() => undefined);
        return (err as { code?: string }).code ?? "unknown";
      } finally {
        await app.end();
      }
    };

    it.each([
      ["patientIds", { patientIds: [PATIENT] }],
      ["an unknown key", { floor: "3" }],
      ["a bare array", []],
      ["an empty location list", { locationIds: [] }],
      ["a non-uuid id", { providerEntityIds: ["nope"] }],
      ["a non-array dimension", { locationIds: LOC_X }],
      ["a scalar", "x"],
    ])("rejects %s with 23514", async (_label, scope) => {
      expect(await tryInsert(scope)).toBe("23514");
    });

    it.each([
      ["an empty object", {}],
      ["location ids", { locationIds: [LOC_X, LOC_Y] }],
      ["the auditor grant's engagement provenance", { engagementId: PATIENT }],
    ])("accepts %s", async (_label, scope) => {
      expect(await tryInsert(scope)).toBeNull();
    });
  });

  describe("the real route returns 422 with the stable code, over the real DB-backed store", () => {
    function makeServer() {
      resetAuthorizationContract();
      resetRbacEngine();
      const roles = createInMemoryRoleStore();
      const perms = [
        {
          organizationId: ORG_A,
          userId: ADMIN_USER,
          permissions: ["role.read", "role.assign"],
        },
      ];
      const grantStore = createInMemoryEffectivePermissionStore(
        perms.map((s) => ({
          orgId: s.organizationId,
          userId: s.userId,
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
          ],
        })),
      );
      registerEffectivePermissionResolver(grantStore.store);
      const extra = new Map(
        [
          roleView({ roleId: ids.roleOrgWide, organizationId: ORG_A, key: "gap007_ops" }),
          roleView({
            roleId: ids.roleLegacy,
            organizationId: ORG_A,
            key: "gap007_legacy",
            scopeLevel: "location",
          }),
          roleView({
            roleId: ids.roleGood,
            organizationId: ORG_A,
            key: "gap007_good",
            category: "temporary_special",
          }),
        ].map((r) => [r.roleId, r]),
      );
      const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
      registerAuthorizationRoutes(app, {
        roles: { ...roles.store, get: (id: string) => extra.get(id) ?? roles.store.get(id) },
        membershipRoles: createDbMembershipRoleStore(handle.db),
        breakGlass: createInMemoryBreakGlassStore().store,
        engagements: createInMemoryEngagementStore().store,
        auditorSessions: createInMemoryAuditorSessionMinter().minter,
        notifier: createInMemoryComplianceNotifier().notifier,
        effectivePermissions: createFixedPermissionResolver(perms).resolver,
        audit: createInMemoryAuditExecutor().executor,
        cosignPolicy: async () => false,
      });
      return app;
    }
    const headers = { "x-test-user": ADMIN_USER, "x-test-org": ORG_A };
    const post = (app: ReturnType<typeof makeServer>, membership: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/v1/memberships/${membership}/roles`,
        headers,
        payload: payload as never,
      });
    const codes = (res: { json(): { error: { details?: { code: string }[] } } }) =>
      (res.json().error.details ?? []).map((d) => d.code);

    it("refuses patientIds with PATIENT_SCOPE_UNSUPPORTED and stores nothing", async () => {
      const app = makeServer();
      // the member already holds gap007_good; use the admin membership + the org-wide role
      const res = await post(app, ids.adminMembership, {
        roleId: ids.roleOrgWide,
        scope: { patientIds: [PATIENT] },
      });
      expect(res.statusCode).toBe(422);
      expect(codes(res)).toEqual(["PATIENT_SCOPE_UNSUPPORTED"]);
      const { rows } = await admin.query(
        "SELECT 1 FROM membership_role WHERE membership_id = $1 AND role_id = $2",
        [ids.adminMembership, ids.roleOrgWide],
      );
      expect(rows).toHaveLength(0);
      await app.close();
    });

    it("refuses a scope wider than the membership, a location role org-wide, a missing and a past expiry", async () => {
      const app = makeServer();
      const wider = await post(app, ids.memberMembership, {
        roleId: ids.roleOrgWide,
        scope: { locationIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9"] },
      });
      expect(codes(wider)).toEqual(["SCOPE_OUTSIDE_MEMBERSHIP"]);
      const orgWideLocationRole = await post(app, ids.adminMembership, { roleId: ids.roleLegacy });
      expect(codes(orgWideLocationRole)).toEqual(["ROLE_REQUIRES_NARROWING"]);
      const noExpiry = await post(app, ids.adminMembership, { roleId: ids.roleGood });
      expect(codes(noExpiry)).toEqual(["EXPIRY_REQUIRED"]);
      const past = await post(app, ids.adminMembership, {
        roleId: ids.roleOrgWide,
        expiresAt: "2020-01-01T00:00:00Z",
      });
      expect(codes(past)).toEqual(["EXPIRY_NOT_FUTURE"]);
      await app.close();
    });

    it("accepts a conforming grant and the stored row satisfies the CHECK", async () => {
      const app = makeServer();
      const res = await post(app, ids.memberMembership, {
        roleId: ids.roleOrgWide,
        scope: { locationIds: [LOC_Y] },
      });
      expect(res.statusCode).toBe(201);
      const { rows } = await admin.query(
        "SELECT scope FROM membership_role WHERE membership_id = $1 AND role_id = $2",
        [ids.memberMembership, ids.roleOrgWide],
      );
      expect(rows[0].scope).toEqual({ locationIds: [LOC_Y] });
      await app.close();
    });
  });

  describe("the reader fails closed through the real enrichment", () => {
    it("a live grant whose stored scope is unreadable (bypassing the CHECK) reaches NOTHING, not everything", async () => {
      // Simulate pre-CHECK damage: drop the constraint, store a patientIds blob on a live grant, read, restore.
      await admin.query("ALTER TABLE membership_role DROP CONSTRAINT membership_role_scope_shape");
      const reports: unknown[] = [];
      try {
        await admin.query(
          "DELETE FROM membership_role WHERE membership_id = $1",
          [ids.memberBMembership],
        );
        await admin.query(
          "INSERT INTO membership_role (organization_id,membership_id,role_id,scope) VALUES ($1,$2,$3,$4::jsonb)",
          [ORG_B, ids.memberBMembership, ids.roleB, JSON.stringify({ patientIds: [PATIENT] })],
        );
        const reader = createDbActorEnrichmentReader(handle.db, {
          onMalformedGrantScope: (report) => reports.push(report),
        });
        const enriched = await reader.read({ orgId: ORG_B }, MEMBER_B_USER);
        expect(enriched?.roles).toEqual(["gap007_b_ops"]);
        expect(enriched?.locationIds).toEqual([NO_REACH_ID]);
        expect(enriched?.providerEntityIds).toEqual([NO_REACH_ID]);
        expect(reports).toEqual([
          { membershipId: ids.memberBMembership, malformedGrantCount: 1, liveGrantCount: 1 },
        ]);
      } finally {
        await admin.query("DELETE FROM membership_role WHERE membership_id = $1", [
          ids.memberBMembership,
        ]);
        await admin.query(
          `ALTER TABLE membership_role ADD CONSTRAINT membership_role_scope_shape CHECK (membership_role_scope_conforms(scope))`,
        );
      }
    });

    it("a healthy scoped grant narrows reach to its location (and never reports malformed)", async () => {
      const reports: unknown[] = [];
      const reader = createDbActorEnrichmentReader(handle.db, {
        onMalformedGrantScope: (report) => reports.push(report),
      });
      const enriched = await reader.read({ orgId: ORG_A }, MEMBER_USER);
      expect([...(enriched?.locationIds ?? [])].sort()).toEqual([LOC_X, LOC_Y]);
      expect(reports).toEqual([]);
    });
  });

  describe("tenant isolation as wardenx_app", () => {
    it("org B cannot read org A's membership_role scope, and cannot write into it", async () => {
      const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app.connect();
      try {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id',$1,true)", [ORG_B]);
        const visible = await app.query(
          "SELECT count(*)::int AS n FROM membership_role WHERE organization_id = $1",
          [ORG_A],
        );
        expect(visible.rows[0].n).toBe(0);
        await expect(
          app.query(
            "INSERT INTO membership_role (organization_id,membership_id,role_id,scope) VALUES ($1,$2,$3,'{}'::jsonb)",
            [ORG_A, ids.adminMembership, ids.roleGood],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await app.query("ROLLBACK").catch(() => undefined);
        await app.end();
      }
    });
  });
});
