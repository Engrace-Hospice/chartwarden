/**
 * §11 D19 — M2's org activate/suspend/close capability, LIVE Postgres, real NOBYPASSRLS `wardenx_app`.
 *
 * Closes the M2 "hard half" (#205): `organization.status` had NO UPDATE anywhere in the codebase before
 * `organization-lifecycle.ts` — the four `m2.organization.*` / `m2.session.created` events M35's §4.12
 * per-seat billing is specified against had no producer at all. This suite proves, against a real
 * NOBYPASSRLS connection (not the in-memory slice, not a superuser):
 *   - a legal transition (activate/suspend/close) writes `organization.status`, lands the correct
 *     `m2.organization.*` outbox row, and audits the transition;
 *   - suspend/close revoke every session ALREADY bound to the org, in the same transaction;
 *   - an illegal transition (e.g. `activate` from `closed`) is refused and changes nothing;
 *   - `select-organization`'s OTHER half of §11 D19 enforcement — refusing to bind a FRESH session to a
 *     non-active org — via `OrganizationStatusReader.getStatus`.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m2:organization-lifecycle:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createDbActorEnrichmentReader,
  createPredicateRegistry,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { userLifecyclePlatformOpsPredicate } from "../src/modules/02-identity/abac-predicates";
import {
  createContextActorResolver,
  createOrgScopedAuditExecutor,
  createOrgScopedIdentityOutbox,
} from "../src/modules/02-identity/identity-ports";
import { createDbUserDirectory } from "../src/modules/02-identity/identity-stores-db";
import { M2_OUTBOX_EVENTS } from "../src/modules/02-identity/index";
import {
  type OrganizationLifecycleOutboxPort,
  createDrizzleOrganizationLifecycleWriter,
} from "../src/modules/02-identity/organization-lifecycle";
import { registerPlatformUserRoutes } from "../src/modules/02-identity/routes/platform-user-routes";
import { createDbSessionWriter } from "../src/modules/02-identity/session-writer-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f2050101";
const ORG_B = "22222222-2222-4222-8222-2222f2050102";
const USER = "33333333-3333-4333-8333-3333f2050103";
const ACTOR_MEMBERSHIP = "44444444-4444-4444-8444-4444f2050104";

describe.skipIf(!DB_URL)("M2 organization-lifecycle — LIVE Postgres, real wardenx_app role", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

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
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f11d19-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f11d19-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'f11d19@example.test','F11D19 User')`,
      [USER],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  function writer() {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
    const rawPublisher: OrganizationLifecycleOutboxPort = {
      publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m2" }),
    };
    return createDrizzleOrganizationLifecycleWriter(handle.db, rawPublisher);
  }

  it("suspend: writes status, revokes bound sessions, lands the outbox row, audits the transition", async () => {
    const boundSessionId = "sess-org-a-bound-1";
    await admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      [boundSessionId, USER, ORG_A, `tok-${boundSessionId}`],
    );

    const result = await writer().transition(ORG_A, "suspend", {
      reason: "non-payment 60d",
      actorUserId: USER,
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
    expect(result).toMatchObject({ status: "suspended", sessionsRevoked: 1 });

    const org = await admin.query("SELECT status FROM organization WHERE id = $1", [ORG_A]);
    expect(org.rows[0].status).toBe("suspended");

    const sessions = await admin.query('SELECT id FROM "session" WHERE id = $1', [boundSessionId]);
    expect(sessions.rows).toHaveLength(0);

    const outbox = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm2.organization.suspended'",
      [ORG_A],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      organizationId: ORG_A,
      reason: "non-payment 60d",
      actorMembershipId: ACTOR_MEMBERSHIP,
    });

    const audit = await admin.query(
      "SELECT event_type, before, after FROM audit_event WHERE resource_id = $1 AND event_type = 'm2.organization.suspended'",
      [ORG_A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before).toMatchObject({ status: "active" });
    expect(audit.rows[0].after).toMatchObject({ status: "suspended", sessionsRevoked: 1 });
  });

  it("an illegal transition (suspend again, from suspended) is refused and changes nothing", async () => {
    await expect(
      writer().transition(ORG_A, "suspend", {
        reason: "n/a",
        actorUserId: USER,
        actorMembershipId: ACTOR_MEMBERSHIP,
      }),
    ).rejects.toThrow(/cannot 'suspend' from 'suspended'|ILLEGAL_ORGANIZATION_TRANSITION/);

    const org = await admin.query("SELECT status FROM organization WHERE id = $1", [ORG_A]);
    expect(org.rows[0].status).toBe("suspended"); // unchanged
  });

  it("activate: reactivates a suspended org and publishes m2.organization.activated", async () => {
    const result = await writer().transition(ORG_A, "activate", {
      reason: "cause resolved",
      actorUserId: USER,
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
    expect(result.status).toBe("active");

    const outbox = await admin.query(
      "SELECT id FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm2.organization.activated'",
      [ORG_A],
    );
    expect(outbox.rows).toHaveLength(1);
  });

  it("close: terminal, revokes sessions, publishes m2.organization.closed; org B is untouched", async () => {
    await admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      ["sess-org-a-bound-2", USER, ORG_A, "tok-sess-org-a-bound-2"],
    );
    await admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      ["sess-org-b-bound-1", USER, ORG_B, "tok-sess-org-b-bound-1"],
    );

    const result = await writer().transition(ORG_A, "close", {
      reason: "customer offboarded",
      actorUserId: USER,
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
    expect(result).toMatchObject({ status: "closed", sessionsRevoked: 1 });

    const orgBSession = await admin.query('SELECT id FROM "session" WHERE id = $1', [
      "sess-org-b-bound-1",
    ]);
    expect(orgBSession.rows).toHaveLength(1); // untouched

    await expect(
      writer().transition(ORG_A, "suspend", {
        reason: "n/a",
        actorUserId: USER,
        actorMembershipId: ACTOR_MEMBERSHIP,
      }),
    ).rejects.toThrow(); // closed is terminal
  });

  it("getStatus (the select-organization enforcement reader) reads the real status, org-scoped", async () => {
    const reader = writer();
    expect(await reader.getStatus(ORG_A)).toBe("closed");
    expect(await reader.getStatus(ORG_B)).toBe("active");
    expect(await reader.getStatus("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  // §4.7 `user.deactivate` "platform_ops (any)" — POST /api/v1/platform/users/:id/deactivate, driven
  // through the route with the REAL directory / session writer / org-scoped audit + outbox, and the REAL
  // RBAC store + actor-enrichment reader, all as `wardenx_app`. Only session authentication (a header
  // shim naming the user + bound org) and the step-up ceremony are stood in for.
  describe("platform user deactivate (§4.7 platform_ops any)", () => {
    const ORG_OPS = "55555555-5555-4555-8555-5555f2050105";
    const OPERATOR = "66666666-6666-4666-8666-6666f2050106";
    const SPOOFER = "77777777-7777-4777-8777-7777f2050107";
    const TARGET = "88888888-8888-4888-8888-8888f2050108";

    async function bindRole(input: {
      roleOrg: string | null;
      key: string;
      category: string;
      membershipId: string;
      membershipOrg: string;
    }): Promise<void> {
      const role = await admin.query<{ id: string }>(
        `INSERT INTO role (organization_id,key,name,category) VALUES ($1,$2,$2,$3) RETURNING id`,
        [input.roleOrg, input.key, input.category],
      );
      const roleId = role.rows[0]?.id;
      await admin.query(
        `INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'user.deactivate')`,
        [input.roleOrg, roleId],
      );
      await admin.query(
        `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)`,
        [input.membershipOrg, input.membershipId, roleId],
      );
    }

    beforeAll(async () => {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
           ($1,'f11d19-ops','Platform Ops LLC','Platform Ops','active')`,
        [ORG_OPS],
      );
      await admin.query(
        `INSERT INTO "user" (id,email,name) VALUES
           ($1,'operator@f11d19.test','Op Erator'),($2,'spoofer@f11d19.test','Spoo Fer'),
           ($3,'target@f11d19.test','Tar Get')`,
        [OPERATOR, SPOOFER, TARGET],
      );
      const m = await admin.query<{ id: string; user_id: string; organization_id: string }>(
        `INSERT INTO membership (user_id,organization_id,status) VALUES
           ($1,$4,'active'),($2,$5,'active'),($3,$5,'active'),($3,$4,'active')
         RETURNING id,user_id,organization_id`,
        [OPERATOR, SPOOFER, TARGET, ORG_OPS, ORG_B],
      );
      const membershipOf = (user: string, org: string) =>
        m.rows.find((r) => r.user_id === user && r.organization_id === org)?.id as string;
      await admin.query(
        `INSERT INTO permission (key,resource,action,category) VALUES ('user.deactivate','user','deactivate','admin')
         ON CONFLICT (key) DO NOTHING`,
      );
      // The operator: a PLATFORM-OWNED platform_ops row (organization_id NULL), as scripts/db/platform-role.ts grants it.
      await bindRole({
        roleOrg: null,
        key: "platform_ops",
        category: "platform_staff",
        membershipId: membershipOf(OPERATOR, ORG_OPS),
        membershipOrg: ORG_OPS,
      });
      // The spoofer is ORG_B's org_admin and so legitimately holds `user.deactivate` there — RBAC passes and
      // the platform-role ABAC predicate is what must refuse.
      await bindRole({
        roleOrg: ORG_B,
        key: "org_admin",
        category: "admin_executive",
        membershipId: membershipOf(SPOOFER, ORG_B),
        membershipOrg: ORG_B,
      });
      // ...plus a TENANT-owned `platform_ops` row in ORG_B. Migration 0318's CHECK refuses writing one
      // now, so it is staged the way a pre-0318 legacy row exists: with the constraint briefly lifted.
      const reserved = await admin.query<{ name: string; def: string }>(
        `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'role'::regclass AND contype = 'c' AND conname LIKE 'role_platform%'`,
      );
      for (const c of reserved.rows)
        await admin.query(`ALTER TABLE role DROP CONSTRAINT ${c.name}`);
      await bindRole({
        roleOrg: ORG_B,
        key: "platform_ops",
        category: "admin_executive",
        membershipId: membershipOf(SPOOFER, ORG_B),
        membershipOrg: ORG_B,
      });
      // Restored verbatim (pg_get_constraintdef keeps NOT VALID), so later suites see the real backstop.
      for (const c of reserved.rows)
        await admin.query(`ALTER TABLE role ADD CONSTRAINT ${c.name} ${c.def}`);
      for (const [id, org] of [
        ["sess-target-b", ORG_B],
        ["sess-target-ops", ORG_OPS],
      ]) {
        await admin.query(
          `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
          [id, TARGET, org, `tok-${id}`],
        );
      }
    });

    afterAll(() => {
      resetAuthorizationContract();
      resetRbacEngine();
    });

    function server() {
      resetAuthorizationContract();
      resetRbacEngine();
      registerDbEffectivePermissionResolver(handle.db);
      const registry = createPredicateRegistry();
      registry.register("user_lifecycle_platform_ops", userLifecyclePlatformOpsPredicate);
      registry.register("step_up_recent", async () => true); // the ceremony is not under test here
      registerAbacRegistry(registry);
      const enrichment = createDbActorEnrichmentReader(handle.db);
      const app = buildServer({
        authenticate: async (request: FastifyRequest) => {
          const user = request.headers["x-test-user"];
          const org = request.headers["x-test-org"];
          if (typeof user !== "string" || typeof org !== "string") return;
          request.context.userId = user;
          request.context.organizationId = org;
          request.context.roles = [...((await enrichment.read({ orgId: org }, user))?.roles ?? [])];
        },
        security: { rateLimitEnabled: false },
      });
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
      registerPlatformUserRoutes(app, {
        actors: createContextActorResolver(),
        users: createDbUserDirectory(handle.db),
        sessions: createDbSessionWriter(handle.db),
        audit: createOrgScopedAuditExecutor(handle.db),
        outbox: createOrgScopedIdentityOutbox(handle.db, {
          publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m2" }),
        }),
      });
      return app;
    }

    const deactivate = (app: ReturnType<typeof server>, actor: string, actorOrg: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/platform/users/${TARGET}/deactivate`,
        headers: { "x-test-user": actor, "x-test-org": actorOrg },
        payload: { reason: "platform offboard — compromised credential" },
      });

    async function targetStatus(): Promise<string | undefined> {
      const r = await admin.query<{ status: string }>(`SELECT status FROM "user" WHERE id=$1`, [
        TARGET,
      ]);
      return r.rows[0]?.status;
    }

    it("a tenant org_admin with a tenant-owned platform_ops (legacy spoof row) → 403 at the ABAC gate, nothing touched", async () => {
      const app = server();
      const res = await deactivate(app, SPOOFER, ORG_B);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain("user_lifecycle_platform_ops");
      expect(await targetStatus()).toBe("active");
      const s = await admin.query(`SELECT id FROM "session" WHERE user_id=$1`, [TARGET]);
      expect(s.rows).toHaveLength(2);
      await app.close();
    });

    it("a platform-owned platform_ops deactivates a member of TWO orgs: status, memberships, sessions, audit, outbox", async () => {
      const app = server();
      const res = await deactivate(app, OPERATOR, ORG_OPS);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        deactivated: true,
        alreadyDeactivated: false,
        sessionsRevoked: 2,
        membershipsRevoked: 2,
      });
      expect(await targetStatus()).toBe("deactivated");
      // §2.2.1 "All memberships revoked" — in BOTH orgs, written as wardenx_app (RLS re-pointed per org);
      // the operator's own membership in ORG_OPS is untouched.
      const ms = await admin.query<{ organization_id: string; status: string }>(
        `SELECT organization_id, status FROM membership WHERE user_id=$1 ORDER BY organization_id`,
        [TARGET],
      );
      expect(ms.rows.map((r) => r.status)).toEqual(["revoked", "revoked"]);
      const op = await admin.query<{ status: string }>(
        `SELECT status FROM membership WHERE user_id=$1`,
        [OPERATOR],
      );
      expect(op.rows.map((r) => r.status)).toEqual(["active"]);
      const s = await admin.query(`SELECT id FROM "session" WHERE user_id=$1`, [TARGET]);
      expect(s.rows).toHaveLength(0);

      const audit = await admin.query(
        `SELECT organization_id, context FROM audit_event WHERE resource_id=$1 AND event_type='m2.user.deactivated'`,
        [TARGET],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].organization_id).toBe(ORG_OPS);
      expect(audit.rows[0].context).toMatchObject({
        scope: "platform",
        memberOrganizationIds: [ORG_B, ORG_OPS].sort(),
      });
      expect(audit.rows[0].context.revokedMembershipIds).toHaveLength(2);
      const outbox = await admin.query(
        `SELECT organization_id, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m2.user.deactivated'`,
        [TARGET],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].payload).toMatchObject({ userId: TARGET, scope: "platform" });
      await app.close();
    });

    it("a repeat call is idempotent: 200 alreadyDeactivated, no second audit row or event", async () => {
      const app = server();
      const res = await deactivate(app, OPERATOR, ORG_OPS);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        alreadyDeactivated: true,
        sessionsRevoked: 0,
        membershipsRevoked: 0,
      });
      const audit = await admin.query(
        `SELECT id FROM audit_event WHERE resource_id=$1 AND event_type='m2.user.deactivated'`,
        [TARGET],
      );
      expect(audit.rows).toHaveLength(1);
      await app.close();
    });

    it("the tenant path (deactivateFromOrg) revokes the sole membership too, as wardenx_app", async () => {
      const SOLE = "99999999-9999-4999-8999-9999f2050109";
      await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,'sole@f11d19.test','So Le')`, [
        SOLE,
      ]);
      await admin.query(
        `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active')`,
        [SOLE, ORG_A],
      );
      const outcome = await createDbUserDirectory(handle.db).deactivateFromOrg({
        userId: SOLE,
        organizationId: ORG_A,
        reason: "left the agency",
      });
      expect(outcome).toBe("deactivated");
      const u = await admin.query<{ status: string }>(`SELECT status FROM "user" WHERE id=$1`, [SOLE]);
      expect(u.rows[0]?.status).toBe("deactivated");
      const m = await admin.query<{ status: string }>(
        `SELECT status FROM membership WHERE user_id=$1`,
        [SOLE],
      );
      expect(m.rows.map((r) => r.status)).toEqual(["revoked"]);
    });

    it("an unknown user → 404", async () => {
      const app = server();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/platform/users/99999999-9999-4999-8999-9999f20501ff/deactivate",
        headers: { "x-test-user": OPERATOR, "x-test-org": ORG_OPS },
        payload: { reason: "nobody" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
