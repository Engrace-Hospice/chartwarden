/**
 * CW-AC-22 - the platform console's address allowlist and the split of the platform_ops role, LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:platform-console:live   (SUPERUSER url, THROWAWAY database)
 *
 * Every request runs through the REAL `buildServer` chain on the NOBYPASSRLS `chartwarden_app` pool, the REAL guard, the REAL M34
 * predicates and the REAL DB grants and roles (read through the production enrichment reader and effective-permission store, not an
 * in-memory list). What a unit test cannot prove, and this does:
 *   - a request for a console route from an address outside PLATFORM_CONSOLE_ALLOWED_CIDRS is refused 403 and leaves ONE platform-scoped
 *     audit row written through the SECURITY DEFINER platform writer as chartwarden_app (organization_id NULL, system actor, denied,
 *     warn, compliance retention), naming the address, the method, the matched route template and the operator's ids, and no header or body;
 *     an allowlisted address and a non-console route leave none; a tenant's RLS scope cannot read it;
 *   - the address is the trusted-proxy-aware one: X-Forwarded-For from a peer that is not a trusted proxy is ignored, and a forged
 *     left-hand entry behind the trusted proxy does not count;
 *   - a list that is set but unusable refuses every console request (and says so in the row), never opens it;
 *   - migration 1559 (expand) points each key's default predicate at its new role and removes nothing, a second run changes nothing, and
 *     the runbook's clean-up statement then takes the four keys off platform_ops and nothing else; each new role holds exactly its
 *     template keys, and exactly one role holds each key;
 *   - the routes behind the split: the go-live approver approves with its DB grant, platform_ops (which no longer holds the key) and the
 *     BAA steward are refused, the approver reads the wizard but cannot write a step;
 *   - `db:platform-role grant` refuses to put the go-live approver beside another onboarding role on one account, across memberships, and
 *     the migration's trigger refuses the same pair (every pair in PLATFORM_ROLE_CONFLICTS, both orders) for ad-hoc SQL, an UPDATE and
 *     two concurrent grants, ignoring an expired grant.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PLATFORM_OPS_ROLE_GRANTS,
  PLATFORM_ROLE_CONFLICTS,
  createDbActorEnrichmentReader,
  createDbEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  resolveActorPermissions,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoPlatformRoleConflict,
  grantPlatformRole,
  platformRoleLabel,
  revokePlatformRole,
  withPlatformRoleAudit,
} from "../../../scripts/db/lib/platform-role";
import { buildServer } from "../src/bootstrap/index";
import {
  PLATFORM_AUTHORITY_STRIPPED_EVENT,
  PLATFORM_CONSOLE_REFUSED_EVENT,
  createPlatformConsoleGuard,
  parsePlatformConsolePolicy,
  platformConsoleRefusalAuditor,
} from "../src/bootstrap/platform-console-allowlist";
import { registerOrgAdminRoutes } from "../src/modules/02-identity/routes/org-admin-routes";
import {
  buildM33AbacPredicates,
  denyStubReportingAbacResolver,
} from "../src/modules/33-reporting/abac-predicates";
import { registerReportingAdminRoutes } from "../src/modules/33-reporting/routes/admin.routes";
import { buildTenantPlatformAbacPredicates } from "../src/modules/34-saas-tenant-platform/abac-predicates";
import type { OnboardingWizard } from "../src/modules/34-saas-tenant-platform/onboarding/wizard-service";
import { registerOnboardingWizardRoutes } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-wizard-routes";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SPLIT_MIGRATION = "1559_m34_platform_ops_role_split.sql";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const SECOND_ORG = "a0000000-0000-4000-8000-0000000000a2"; // a second org one operator also holds a membership in
const TENANT_ORG = "b0000000-0000-4000-8000-0000000000b1";

// Synthetic accounts: one per onboarding role, and one holding two memberships for the conflict rule.
const U_OPS = "c0000000-0000-4000-8000-000000000001";
const U_APPROVER = "c0000000-0000-4000-8000-000000000002";
const U_STEWARD = "c0000000-0000-4000-8000-000000000003";
const U_PRICER = "c0000000-0000-4000-8000-000000000004";
const U_DUAL = "c0000000-0000-4000-8000-000000000005";
// A second platform_ops account, never used before the key is handed out (the permission store caches a user's set for minutes).
const U_OPS_STALE = "c0000000-0000-4000-8000-000000000007";
const M_OPS = "d0000000-0000-4000-8000-000000000001";
const M_APPROVER = "d0000000-0000-4000-8000-000000000002";
const M_STEWARD = "d0000000-0000-4000-8000-000000000003";
const M_PRICER = "d0000000-0000-4000-8000-000000000004";
const M_DUAL_HOME = "d0000000-0000-4000-8000-000000000005";
const M_DUAL_SECOND = "d0000000-0000-4000-8000-000000000006";
const M_OPS_STALE = "d0000000-0000-4000-8000-000000000007";
// The shared-prefix routes (CW-AC-22 follow-up): a superadmin, an operator who also holds a tenant-style org_admin, and a plain tenant admin.
const U_SUPER = "c0000000-0000-4000-8000-000000000008";
const U_OPS_TENANT = "c0000000-0000-4000-8000-000000000009";
const U_TENANT_ADMIN = "c0000000-0000-4000-8000-00000000000a";
const M_SUPER = "d0000000-0000-4000-8000-000000000008";
const M_OPS_TENANT = "d0000000-0000-4000-8000-000000000009";
const M_TENANT_ADMIN = "d0000000-0000-4000-8000-00000000000a";

const MEMBERSHIP_OF: Record<string, string> = {
  [U_OPS]: M_OPS,
  [U_APPROVER]: M_APPROVER,
  [U_STEWARD]: M_STEWARD,
  [U_PRICER]: M_PRICER,
  [U_DUAL]: M_DUAL_HOME,
  [U_OPS_STALE]: M_OPS_STALE,
  [U_SUPER]: M_SUPER,
  [U_OPS_TENANT]: M_OPS_TENANT,
  [U_TENANT_ADMIN]: M_TENANT_ADMIN,
};

// RFC 5737 documentation addresses: synthetic.
const PROXY = "10.0.0.2";
const OPERATOR_NET = "203.0.113.0/24";
const OPERATOR_IP = "203.0.113.7";
const OUTSIDER_IP = "198.51.100.50";
const REFUSED = PLATFORM_CONSOLE_REFUSED_EVENT;
const STRIPPED = PLATFORM_AUTHORITY_STRIPPED_EVENT;

const MOVED_KEYS = [
  "tenant_baa_document.upload_platform",
  "platform_tenant_baa.write_platform",
  "go_live.approve_platform",
  "subscription.onboard_platform",
] as const;
const ROLE_OF_KEY: Record<(typeof MOVED_KEYS)[number], string> = {
  "tenant_baa_document.upload_platform": "platform_baa_steward",
  "platform_tenant_baa.write_platform": "platform_baa_steward",
  "go_live.approve_platform": "platform_go_live_approver",
  "subscription.onboard_platform": "platform_pricing_operator",
};
const ABAC_KEYS = [
  ...MOVED_KEYS,
  "onboarding.read_platform",
  "platform_tenant_baa.read_platform",
  "tenant_clearinghouse.read_platform",
] as const;

interface OrganizationRow {
  id: string;
  slug: string;
  legal_name: string;
  display_name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}
const ORG_SELECT =
  "SELECT id, slug, legal_name, display_name, status::text AS status, created_at, updated_at FROM organization";
const toOrgView = (r: OrganizationRow) => ({
  id: r.id,
  slug: r.slug,
  legalName: r.legal_name,
  displayName: r.display_name,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** What the wizard stub saw: the approve route must reach the service only for the approver. */
const approvals: { orgSlug: string; membershipId: string }[] = [];
const wizardStub = {
  getPlatform: async () => ({ currentStepKey: "business_associate_agreement", steps: [] }),
  approveGoLive: async (orgSlug: string, actor: { membershipId: string }) => {
    approvals.push({ orgSlug, membershipId: actor.membershipId });
    return { approved: true };
  },
  revokeGoLive: async () => ({ revoked: true }),
  setComplianceOfficerPlatform: async () => ({ complianceOfficerMembershipId: null }),
} as unknown as OnboardingWizard;

describe.skipIf(!DB_URL)("CW-AC-22 platform console, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  const servers: FastifyInstance[] = [];
  let correlation = 0;
  const savedTrusted = process.env.TRUSTED_PROXY_CIDRS;

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  /** One query on the REAL `chartwarden_app` role, scoped to `org` exactly as a tenant request is. */
  const asTenant = async <T>(org: string, sql: string): Promise<T[]> => {
    const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const { rows } = await client.query(sql);
      await client.query("ROLLBACK");
      return rows as T[];
    } finally {
      await client.end();
    }
  };

  const refusalRows = () =>
    q<{
      organization_id: string | null;
      actor_user_id: string | null;
      actor_kind: string;
      outcome: string;
      severity: string;
      retention_class: string;
      resource_kind: string;
      correlation_id: string;
      context: Record<string, unknown>;
    }>(
      `SELECT organization_id, actor_user_id, actor_kind, outcome, severity, retention_class, resource_kind, correlation_id, context
         FROM audit_event WHERE event_type = $1 ORDER BY created_at`,
      [REFUSED],
    );

  /** The org store behind `/api/v1/orgs`, over the real `organization` table (read as the superuser: what is judged is the route's guards). */
  const orgStore = {
    listOrganizations: async ({ limit, offset }: { limit: number; offset: number }) =>
      (
        await q<OrganizationRow>(`${ORG_SELECT} ORDER BY slug LIMIT $1 OFFSET $2`, [limit, offset])
      ).map(toOrgView),
    getOrganization: async (id: string) => {
      const [row] = await q<OrganizationRow>(`${ORG_SELECT} WHERE id = $1`, [id]);
      return row ? toOrgView(row) : null;
    },
  };

  /** A server over the real chain with the console guard built from `rawList` (the PLATFORM_CONSOLE_ALLOWED_CIDRS value). */
  async function makeServer(rawList: string | undefined): Promise<FastifyInstance> {
    const enrichment = createDbActorEnrichmentReader(tenantPool.db as never);
    const authenticate = async (request: FastifyRequest): Promise<void> => {
      const user = request.headers["x-test-user"];
      if (typeof user !== "string" || user.length === 0) return;
      const org = String(request.headers["x-test-org"] ?? PLATFORM_ORG);
      request.context.userId = user;
      request.context.organizationId = org;
      // The roles come from the REAL membership_role -> role join, the way the session enrichment reads them.
      request.context.roles = [...((await enrichment.read({ orgId: org }, user))?.roles ?? [])];
      request.context.attributes.membershipId = MEMBERSHIP_OF[user] ?? M_OPS;
      if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
    };
    const platformConsole = createPlatformConsoleGuard({
      policy: parsePlatformConsolePolicy(rawList),
      onRefused: platformConsoleRefusalAuditor(tenantPool.db as never),
    });
    const app = buildServer({
      authenticate,
      platformConsole,
      db: tenantPool.db as never,
      security: { rateLimitEnabled: false },
    });
    registerOnboardingWizardRoutes(app, { wizard: wizardStub });
    // The two shared-prefix routes the console prefixes cannot refuse (REAL route files, REAL guards and predicates; the store and the
    // service behind them are stubs, because what is proved is who gets through the guards, not what the store returns).
    registerOrgAdminRoutes(app, {
      actors: { resolve: () => null },
      audit: {} as never,
      store: orgStore as never,
      orgWriteScope: (() => {
        throw new Error("not used by a read");
      }) as never,
    });
    registerReportingAdminRoutes(app, {
      service: { getReplicaLag: async () => ({ replicaLagSeconds: 0 }) } as never,
    });
    // A service that asks "may this user ...?" with only ids (resolveActorPermissions({ organizationId, userId })): the ambient request decides.
    app.get("/api/v1/ping-secondary-permission-check", async (request) => ({
      has: (
        await resolveActorPermissions({
          organizationId: request.context.organizationId,
          userId: request.context.userId,
        })
      ).has(String((request.query as { key?: string }).key ?? "")),
    }));
    app.get("/api/v1/ping-outside-the-console", async () => ({ ok: true }));
    await app.ready();
    servers.push(app);
    return app;
  }

  const asOperator = (user: string, extra: Record<string, string> = {}) => ({
    "x-test-user": user,
    "x-test-org": PLATFORM_ORG,
    "x-step-up": "fresh",
    "x-correlation-id": `cw-ac-22-live-${++correlation}`,
    ...extra,
  });

  const grant = (
    membershipId: string,
    organizationId: string,
    key: Parameters<typeof platformRoleLabel>[0],
  ) =>
    withPlatformRoleAudit(admin, { correlationId: `cw-ac-22-grant-${key}`, organizationId }, () =>
      grantPlatformRole(admin, { organizationId, membershipId, key, ...platformRoleLabel(key) }),
    );

  beforeAll(async () => {
    process.env.TRUSTED_PROXY_CIDRS = PROXY;
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort();
    for (const f of migrations) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    for (const [id, slug] of [
      [PLATFORM_ORG, "cw-platform"],
      [SECOND_ORG, "cw-platform-two"],
      [TENANT_ORG, "tenant-live"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [id, email] of [
      [U_OPS, "ops-live@test.test"],
      [U_APPROVER, "approver-live@test.test"],
      [U_STEWARD, "steward-live@test.test"],
      [U_PRICER, "pricer-live@test.test"],
      [U_DUAL, "dual-live@test.test"],
      [U_OPS_STALE, "ops-stale-live@test.test"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, email]);
    }
    for (const [membership, user, org] of [
      [M_OPS, U_OPS, PLATFORM_ORG],
      [M_APPROVER, U_APPROVER, PLATFORM_ORG],
      [M_STEWARD, U_STEWARD, PLATFORM_ORG],
      [M_PRICER, U_PRICER, PLATFORM_ORG],
      [M_DUAL_HOME, U_DUAL, PLATFORM_ORG],
      [M_DUAL_SECOND, U_DUAL, SECOND_ORG],
      [M_OPS_STALE, U_OPS_STALE, PLATFORM_ORG],
    ] as const) {
      await admin.query(
        "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
        [membership, user, org],
      );
    }
    // The real grant path: the platform-owned role row, its TEMPLATE permissions, and the membership binding.
    await grant(M_OPS, PLATFORM_ORG, "platform_ops");
    await grant(M_APPROVER, PLATFORM_ORG, "platform_go_live_approver");
    await grant(M_STEWARD, PLATFORM_ORG, "platform_baa_steward");
    await grant(M_PRICER, PLATFORM_ORG, "platform_pricing_operator");
    await grant(M_DUAL_HOME, PLATFORM_ORG, "platform_ops");
    await grant(M_OPS_STALE, PLATFORM_ORG, "platform_ops");

    tenantPool = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerEffectivePermissionResolver(createDbEffectivePermissionStore(tenantPool.db as never));
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildTenantPlatformAbacPredicates({
        resolver: {
          async hasActiveConsentedSupportSession() {
            return false;
          },
          async loadConsentGrant() {
            return null;
          },
          async loadFeatureFlag() {
            return null;
          },
          async loadOnboardingTask() {
            return null;
          },
        },
        isInCaseload: async () => false,
      }),
    )) {
      reg.register(name, predicate);
    }
    // M33's `platform_admin_scope` is the predicate of /api/v1/reporting/admin (deny-stub resolver: this route's predicate reads roles only).
    for (const [name, predicate] of Object.entries(
      buildM33AbacPredicates({ resolver: denyStubReportingAbacResolver }),
    )) {
      reg.register(name, predicate);
    }
    reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
  }, 600_000);

  afterAll(async () => {
    for (const app of servers) await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    if (savedTrusted === undefined) Reflect.deleteProperty(process.env, "TRUSTED_PROXY_CIDRS");
    else process.env.TRUSTED_PROXY_CIDRS = savedTrusted;
    await tenantPool?.pool.end();
    await admin?.end();
  });

  describe("the address allowlist on the real chain", () => {
    const GO_LIVE = "/api/v1/platform/tenants/tenant-live/go-live/approve";
    const WIZARD = "/api/v1/platform/tenants/tenant-live/onboarding";

    it("serves an allowlisted address (through the trusted proxy) and leaves no refusal row", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await refusalRows()).length;
      const res = await app.inject({
        method: "GET",
        url: WIZARD,
        remoteAddress: PROXY,
        headers: { ...asOperator(U_APPROVER), "x-forwarded-for": OPERATOR_IP },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await refusalRows()).length).toBe(before);
    });

    it("refuses an address outside the list with 403 and writes ONE platform-scoped audit row as chartwarden_app", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await refusalRows()).length;
      const headers = { ...asOperator(U_APPROVER), "x-forwarded-for": OUTSIDER_IP };
      const res = await app.inject({
        method: "POST",
        url: GO_LIVE,
        remoteAddress: PROXY,
        headers,
        payload: { reason: "reviewed twice over" },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe("PLATFORM_CONSOLE_ADDRESS_NOT_ALLOWED");
      expect(JSON.stringify(res.json())).not.toContain(OUTSIDER_IP);
      expect(approvals).toEqual([]); // the route handler never ran

      const rows = (await refusalRows()).slice(before);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        organization_id: null, // a refusal has no tenant: the SECURITY DEFINER platform writer
        actor_user_id: null,
        actor_kind: "system",
        outcome: "denied",
        severity: "warn",
        retention_class: "compliance",
        resource_kind: "platform_console",
        correlation_id: headers["x-correlation-id"],
      });
      expect(row?.context).toMatchObject({
        reason: "address_not_allowed",
        sourceIp: OUTSIDER_IP,
        method: "POST",
        route: "/api/v1/platform/tenants/:orgSlug/go-live/approve", // the template, never the concrete URL
        userId: U_APPROVER, // the signed-in operator who tried it
        organizationId: PLATFORM_ORG,
      });
      // ids and the address only: no header, cookie, token, body or reason text
      const flat = JSON.stringify(row?.context).toLowerCase();
      for (const secret of [
        "reviewed twice over",
        "authorization",
        "cookie",
        "x-step-up",
        "tenant-live",
      ]) {
        expect(flat).not.toContain(secret);
      }
    });

    it("is not readable from a tenant's RLS scope (the row is platform-scoped), as the real chartwarden_app", async () => {
      expect((await refusalRows()).length).toBeGreaterThan(0);
      const seen = await asTenant<{ n: string }>(
        TENANT_ORG,
        `SELECT count(*)::text AS n FROM audit_event WHERE event_type = '${REFUSED}'`,
      );
      expect(seen[0]?.n).toBe("0");
    });

    it("ignores X-Forwarded-For from a peer that is not the trusted proxy, and a forged left-hand entry behind it", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await refusalRows()).length;
      const direct = await app.inject({
        method: "GET",
        url: WIZARD,
        remoteAddress: OUTSIDER_IP, // not the proxy
        headers: {
          ...asOperator(U_APPROVER),
          "x-forwarded-for": OPERATOR_IP,
          "x-real-ip": OPERATOR_IP,
        },
      });
      expect(direct.statusCode).toBe(403);
      const forged = await app.inject({
        method: "GET",
        url: WIZARD,
        remoteAddress: PROXY,
        headers: {
          // another operator: refusals are held to one row per user, address and reason a minute
          ...asOperator(U_STEWARD),
          "x-forwarded-for": `${OPERATOR_IP}, ${OUTSIDER_IP}`,
        },
      });
      expect(forged.statusCode).toBe(403);
      const rows = (await refusalRows()).slice(before);
      expect(rows.map((r) => r.context.sourceIp)).toEqual([OUTSIDER_IP, OUTSIDER_IP]);
    });

    it("leaves a route outside the console alone, from any address, with no refusal row", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await refusalRows()).length;
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/ping-outside-the-console",
        remoteAddress: OUTSIDER_IP,
      });
      expect(res.statusCode).toBe(200);
      expect((await refusalRows()).length).toBe(before);
    });

    it("refuses EVERY console request when the list is set but unusable, and the row says why", async () => {
      const app = await makeServer(`${OPERATOR_NET},0.0.0.0/0`);
      const before = (await refusalRows()).length;
      const res = await app.inject({
        method: "GET",
        url: WIZARD,
        remoteAddress: PROXY,
        headers: { ...asOperator(U_APPROVER), "x-forwarded-for": OPERATOR_IP },
      });
      expect(res.statusCode).toBe(403);
      const rows = (await refusalRows()).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.context.reason).toBe("allowlist_unusable");
    });

    it("with the variable unset there is no gate at all (an unconfigured deployment is unchanged)", async () => {
      const app = await makeServer(undefined);
      const before = (await refusalRows()).length;
      const res = await app.inject({
        method: "GET",
        url: WIZARD,
        remoteAddress: OUTSIDER_IP,
        headers: asOperator(U_APPROVER),
      });
      expect(res.statusCode).toBe(200);
      expect((await refusalRows()).length).toBe(before);
    });
  });

  describe("migration 1559 and the role templates in the real database", () => {
    const keysOf = async (role: string) =>
      (
        await q<{ permission_key: string }>(
          `SELECT rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id
            WHERE r.organization_id IS NULL AND r.key = $1 ORDER BY rp.permission_key`,
          [role],
        )
      ).map((r) => r.permission_key);
    const abacOf = async () =>
      Object.fromEntries(
        (
          await q<{ key: string; default_abac: string }>(
            "SELECT key, default_abac FROM permission WHERE key = ANY($1::text[]) ORDER BY key",
            [[...ABAC_KEYS]],
          )
        ).map((r) => [r.key, r.default_abac]),
      );

    it("each new role is materialized with exactly its template keys; exactly one role holds each moved key", async () => {
      for (const role of [
        "platform_baa_steward",
        "platform_go_live_approver",
        "platform_pricing_operator",
      ] as const) {
        const inCatalog = await q<{ key: string }>(
          "SELECT key FROM permission WHERE key = ANY($1::text[])",
          [[...PLATFORM_OPS_ROLE_GRANTS[role]]],
        );
        expect(inCatalog.length, `${role}: every template key is in the permission catalog`).toBe(
          PLATFORM_OPS_ROLE_GRANTS[role].length,
        );
        expect(await keysOf(role), role).toEqual([...PLATFORM_OPS_ROLE_GRANTS[role]].sort());
      }
      for (const key of MOVED_KEYS) {
        const holders = await q<{ key: string }>(
          `SELECT DISTINCT r.key FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE rp.permission_key = $1`,
          [key],
        );
        expect(
          holders.map((h) => h.key),
          key,
        ).toEqual([ROLE_OF_KEY[key]]);
      }
    });

    it("re-points the recorded default predicates, removes nothing from platform_ops, and a second run changes nothing; the runbook's clean-up then takes the four keys off and nothing else", async () => {
      // A database from before the split: platform_ops holds the four keys and the old default predicate.
      await admin.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key)
         SELECT NULL, r.id, k FROM role r, unnest($1::text[]) AS k
          WHERE r.organization_id IS NULL AND r.key = 'platform_ops'
         ON CONFLICT (role_id, permission_key) DO NOTHING`,
        [[...MOVED_KEYS]],
      );
      await admin.query(
        "UPDATE permission SET default_abac = 'tenant_lifecycle_platform_ops' WHERE key = ANY($1::text[])",
        [[...ABAC_KEYS]],
      );
      const before = await keysOf("platform_ops");
      for (const key of MOVED_KEYS) expect(before).toContain(key);
      const kept = before.filter((k) => !(MOVED_KEYS as readonly string[]).includes(k));
      expect(kept).toEqual(
        expect.arrayContaining([
          "onboarding.manage_platform",
          "tenant_onboarding_data.write_platform",
          "support_session.start",
        ]),
      );

      const sql = readFileSync(join(MIGRATIONS_DIR, SPLIT_MIGRATION), "utf8");
      await admin.query(sql);

      // Expand-only: it deletes nothing, so it can run beside the previous release, and the four keys stay (inert) until the clean-up.
      expect(await keysOf("platform_ops")).toEqual(before);
      expect(await keysOf("platform_go_live_approver")).toEqual(
        [...PLATFORM_OPS_ROLE_GRANTS.platform_go_live_approver].sort(),
      );
      const abac = await abacOf();
      expect(abac).toEqual({
        "go_live.approve_platform": "tenant_platform_go_live_approver",
        "onboarding.read_platform": "tenant_platform_onboarding_staff",
        "platform_tenant_baa.read_platform": "tenant_platform_onboarding_staff",
        "platform_tenant_baa.write_platform": "tenant_platform_baa_steward",
        "subscription.onboard_platform": "tenant_platform_pricing_operator",
        "tenant_baa_document.upload_platform": "tenant_platform_baa_steward",
        "tenant_clearinghouse.read_platform": "tenant_platform_onboarding_staff",
      });

      await admin.query(sql);
      expect(await keysOf("platform_ops")).toEqual(before);
      expect(await abacOf()).toEqual(abac);

      // The clean-up statement of docs/runbooks/m34-platform-console-hardening.md: the four keys, off the platform-owned platform_ops row only.
      await admin.query(`DELETE FROM role_permission rp USING role r
         WHERE rp.role_id = r.id AND r.organization_id IS NULL AND r.key = 'platform_ops'
           AND rp.permission_key IN ('tenant_baa_document.upload_platform', 'platform_tenant_baa.write_platform',
                                     'go_live.approve_platform', 'subscription.onboard_platform')`);
      expect(await keysOf("platform_ops")).toEqual(kept);
      expect(await keysOf("platform_baa_steward")).toEqual(
        [...PLATFORM_OPS_ROLE_GRANTS.platform_baa_steward].sort(),
      );
    });
  });

  describe("the routes behind the split, on real DB grants", () => {
    const APPROVE = "/api/v1/platform/tenants/tenant-live/go-live/approve";
    const post = (app: FastifyInstance, user: string) =>
      app.inject({
        method: "POST",
        url: APPROVE,
        headers: asOperator(user),
        payload: { reason: "reviewed everything twice" },
      });

    it("the go-live approver approves with its DB grant; platform_ops, the BAA steward and the pricing operator are refused", async () => {
      const app = await makeServer(undefined);
      approvals.length = 0;
      expect((await post(app, U_APPROVER)).statusCode).toBe(200);
      expect(approvals).toEqual([{ orgSlug: "tenant-live", membershipId: M_APPROVER }]);
      for (const user of [U_OPS, U_STEWARD, U_PRICER]) {
        expect((await post(app, user)).statusCode, user).toBe(403);
      }
      expect(approvals).toHaveLength(1);
    });

    it("platform_ops cannot approve even when handed the key: the predicate admits the approver role alone", async () => {
      await admin.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key)
         SELECT NULL, r.id, 'go_live.approve_platform' FROM role r WHERE r.organization_id IS NULL AND r.key = 'platform_ops'`,
      );
      try {
        const app = await makeServer(undefined);
        approvals.length = 0;
        const res = await post(app, U_OPS_STALE);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.body).toContain("tenant_platform_go_live_approver"); // refused by the predicate, not for a missing key
        expect(approvals).toEqual([]);
      } finally {
        await admin.query(
          `DELETE FROM role_permission WHERE permission_key = 'go_live.approve_platform'
             AND role_id IN (SELECT id FROM role WHERE organization_id IS NULL AND key = 'platform_ops')`,
        );
      }
    });

    it("the approver reads the wizard it acts in but cannot write a step", async () => {
      const app = await makeServer(undefined);
      const read = await app.inject({
        method: "GET",
        url: "/api/v1/platform/tenants/tenant-live/onboarding",
        headers: asOperator(U_APPROVER),
      });
      expect(read.statusCode, read.body).toBe(200);
      const write = await app.inject({
        method: "PUT",
        url: "/api/v1/platform/tenants/tenant-live/compliance-officer",
        headers: asOperator(U_APPROVER),
        payload: { membershipId: M_OPS, reason: "customer named a new officer" },
      });
      expect(write.statusCode).toBe(403);
    });
  });

  describe("db:platform-role grant refuses a conflicting pair on one account", () => {
    const rolesOf = async (user: string) =>
      (
        await q<{ key: string }>(
          `SELECT DISTINCT r.key FROM membership_role mr JOIN role r ON r.id = mr.role_id JOIN membership m ON m.id = mr.membership_id
            WHERE m.user_id = $1 AND r.organization_id IS NULL ORDER BY r.key`,
          [user],
        )
      ).map((r) => r.key);

    it("refuses the approver beside platform_ops held on ANOTHER membership of the same user, and writes nothing", async () => {
      expect(await rolesOf(U_DUAL)).toEqual(["platform_ops"]);
      await expect(grant(M_DUAL_SECOND, SECOND_ORG, "platform_go_live_approver")).rejects.toThrow(
        /already holds platform_ops.*one account may not hold both/,
      );
      expect(await rolesOf(U_DUAL)).toEqual(["platform_ops"]);
      await expect(
        assertNoPlatformRoleConflict(admin, M_DUAL_SECOND, "platform_go_live_approver"),
      ).rejects.toThrow(/platform_ops/);
    });

    it("allows the roles that may sit together, then refuses the approver in the other direction too", async () => {
      await grant(M_DUAL_SECOND, SECOND_ORG, "platform_baa_steward");
      expect(await rolesOf(U_DUAL)).toEqual(["platform_baa_steward", "platform_ops"]);
      await expect(grant(M_DUAL_SECOND, SECOND_ORG, "platform_go_live_approver")).rejects.toThrow(
        /one account may not hold both/,
      );
      // the approver account cannot be given platform_ops or the steward role either
      await expect(grant(M_APPROVER, PLATFORM_ORG, "platform_ops")).rejects.toThrow(
        /platform_go_live_approver/,
      );
      await expect(grant(M_APPROVER, PLATFORM_ORG, "platform_baa_steward")).rejects.toThrow(
        /platform_go_live_approver/,
      );
    });

    it("a revoke lifts the conflict, and the grant is idempotent", async () => {
      await withPlatformRoleAudit(
        admin,
        { correlationId: "cw-ac-22-revoke", organizationId: SECOND_ORG },
        () =>
          revokePlatformRole(admin, { membershipId: M_DUAL_SECOND, key: "platform_baa_steward" }),
      );
      await withPlatformRoleAudit(
        admin,
        { correlationId: "cw-ac-22-revoke-2", organizationId: PLATFORM_ORG },
        () => revokePlatformRole(admin, { membershipId: M_DUAL_HOME, key: "platform_ops" }),
      );
      expect(await rolesOf(U_DUAL)).toEqual([]);
      await grant(M_DUAL_SECOND, SECOND_ORG, "platform_go_live_approver");
      await grant(M_DUAL_SECOND, SECOND_ORG, "platform_go_live_approver");
      expect(await rolesOf(U_DUAL)).toEqual(["platform_go_live_approver"]);
    });
  });

  describe("migration 1559's trigger refuses the same pair for ad-hoc SQL, a seed or a concurrent grant (what the CLI check cannot see)", () => {
    let account = 0;
    const newAccount = async () => {
      const tag = `trigger-${++account}`;
      const user = (
        await q<{ id: string }>(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `${tag}@test.test`,
        ])
      )[0]?.id as string;
      const membership = (
        await q<{ id: string }>(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, PLATFORM_ORG],
        )
      )[0]?.id as string;
      return { user, membership };
    };
    /** A raw binding, the way ad-hoc SQL or a seed writes it: no CLI check in front of it. */
    const bind = (
      client: Client,
      membership: string,
      role: string,
      expiresAt: string | null = null,
    ) =>
      client.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at)
         SELECT $1, $2, id, $4::timestamptz FROM role WHERE organization_id IS NULL AND key = $3`,
        [PLATFORM_ORG, membership, role, expiresAt],
      );
    const REFUSED_PAIR = /may not share one account/;

    it("refuses every pair in PLATFORM_ROLE_CONFLICTS, in either order (pins the SQL list to the TypeScript one)", async () => {
      for (const [a, b] of PLATFORM_ROLE_CONFLICTS) {
        for (const [first, second] of [
          [a, b],
          [b, a],
        ] as const) {
          const { membership } = await newAccount();
          await bind(admin, membership, first);
          await expect(bind(admin, membership, second), `${first} then ${second}`).rejects.toThrow(
            REFUSED_PAIR,
          );
        }
      }
    });

    it("sees the other memberships of the same user, and lets the roles that may sit together do so", async () => {
      const { user, membership } = await newAccount();
      const second = (
        await q<{ id: string }>(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, SECOND_ORG],
        )
      )[0]?.id as string;
      await bind(admin, membership, "platform_ops");
      await bind(admin, membership, "platform_baa_steward");
      await bind(admin, membership, "platform_pricing_operator");
      await expect(bind(admin, second, "platform_go_live_approver")).rejects.toThrow(REFUSED_PAIR);
    });

    it("does not count a grant that has expired, on either side", async () => {
      const { membership } = await newAccount();
      await bind(admin, membership, "platform_ops", "2020-01-01T00:00:00Z");
      await bind(admin, membership, "platform_go_live_approver");
      const other = await newAccount();
      await bind(admin, other.membership, "platform_go_live_approver", "2020-01-01T00:00:00Z");
      await bind(admin, other.membership, "platform_ops");
    });

    it("refuses moving a binding onto an account it would conflict on (the UPDATE path)", async () => {
      const holder = await newAccount();
      await bind(admin, holder.membership, "platform_baa_steward");
      const approver = await newAccount();
      await bind(admin, approver.membership, "platform_go_live_approver");
      await expect(
        admin.query(
          `UPDATE membership_role SET membership_id = $1
            WHERE membership_id = $2 AND role_id IN (SELECT id FROM role WHERE organization_id IS NULL AND key = 'platform_go_live_approver')`,
          [holder.membership, approver.membership],
        ),
      ).rejects.toThrow(REFUSED_PAIR);
    });

    it("lets exactly one of two concurrent grants of a conflicting pair to one account commit", async () => {
      const { membership } = await newAccount();
      const other = new Client({ connectionString: DB_URL });
      await other.connect();
      try {
        // The first grant is open (uncommitted) and holds the user's advisory lock. The second must WAIT for it rather than pass its own
        // check against a snapshot that cannot see the first, and is refused once the first commits.
        await admin.query("BEGIN");
        await bind(admin, membership, "platform_ops");
        await other.query("BEGIN");
        let settled = false;
        const blocked = bind(other, membership, "platform_go_live_approver");
        blocked.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled, "the second grant waits on the first's lock").toBe(false);
        await admin.query("COMMIT");
        await expect(blocked).rejects.toThrow(REFUSED_PAIR);
        await other.query("ROLLBACK");
      } finally {
        await admin.query("ROLLBACK").catch(() => undefined);
        await other.end();
      }
    });

    it("leaves superadmin outside the rule, as ADR-0112 has it", async () => {
      const { membership } = await newAccount();
      await bind(admin, membership, "platform_ops");
      const created = await q<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, scope_level, enabled)
         VALUES (NULL, 'superadmin', 'Superadmin', 'platform_staff'::role_category, 'organization', true)
         ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET enabled = true RETURNING id`,
      );
      // bound to the platform org (no tenant_account there): the 1501 trigger lets it in, and so does this one
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
        [PLATFORM_ORG, membership, created[0]?.id],
      );
    });
  });

  // Last on purpose: the earlier blocks count rows per key and per role, and this one adds a superadmin and two roles.
  describe("platform authority outside the allowlist, on the routes the console prefixes do not cover (/api/v1/orgs, /api/v1/reporting/admin)", () => {
    const strippedRows = () =>
      q<{
        organization_id: string | null;
        actor_user_id: string | null;
        actor_kind: string;
        outcome: string;
        severity: string;
        retention_class: string;
        resource_kind: string;
        context: Record<string, unknown>;
      }>(
        `SELECT organization_id, actor_user_id, actor_kind, outcome, severity, retention_class, resource_kind, context
           FROM audit_event WHERE event_type = $1 ORDER BY created_at`,
        [STRIPPED],
      );

    /** A request that reaches the API through the trusted proxy, as the real operator and from the client address `ip`. */
    const from = (user: string, ip: string, org = PLATFORM_ORG) => ({
      remoteAddress: PROXY,
      headers: { ...asOperator(user), "x-test-org": org, "x-forwarded-for": ip },
    });
    const slugs = (res: { json(): unknown }) =>
      (res.json() as { items: { slug: string }[] }).items.map((i) => i.slug).sort();
    const holds = async (app: FastifyInstance, user: string, ip: string, key: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/ping-secondary-permission-check?key=${key}`,
          ...from(user, ip),
        })
      ).json().has as boolean;

    beforeAll(async () => {
      for (const [id, email] of [
        [U_SUPER, "super-live@test.test"],
        [U_OPS_TENANT, "ops-tenant-live@test.test"],
        [U_TENANT_ADMIN, "tenant-admin-live@test.test"],
      ] as const) {
        await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, email]);
      }
      for (const [membership, user, org] of [
        [M_SUPER, U_SUPER, PLATFORM_ORG],
        [M_OPS_TENANT, U_OPS_TENANT, PLATFORM_ORG],
        [M_TENANT_ADMIN, U_TENANT_ADMIN, TENANT_ORG],
      ] as const) {
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
          [membership, user, org],
        );
      }
      // The platform-owned superadmin (its permissions come from the code catalog, never from stored rows).
      const [superadmin] = await q<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, scope_level, enabled)
         VALUES (NULL, 'superadmin', 'Superadmin', 'platform_staff'::role_category, 'organization', true)
         ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET enabled = true RETURNING id`,
      );
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [PLATFORM_ORG, M_SUPER, superadmin?.id],
      );
      // The operator: the real platform_ops grant AND a tenant-style org_admin that holds org.manage and the reporting-admin read.
      await grant(M_OPS_TENANT, PLATFORM_ORG, "platform_ops");
      const tenantAdminRole = async (org: string, keys: readonly string[], membership: string) => {
        const [role] = await q<{ id: string }>(
          `INSERT INTO role (organization_id, key, name, category, enabled)
           VALUES ($1, 'org_admin', 'Org admin', 'admin_executive', true) RETURNING id`,
          [org],
        );
        for (const key of keys) {
          await admin.query(
            "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
            [org, role?.id, key],
          );
        }
        await admin.query(
          "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
          [org, membership, role?.id],
        );
      };
      await tenantAdminRole(PLATFORM_ORG, ["org.manage", "report.admin.lag_read"], M_OPS_TENANT);
      await tenantAdminRole(TENANT_ORG, ["org.manage"], M_TENANT_ADMIN);
    }, 120_000);

    it("INSIDE the list the operator keeps the cross-tenant powers on both routes, and no strip is recorded", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await strippedRows()).length;

      const orgs = await app.inject({
        method: "GET",
        url: "/api/v1/orgs",
        ...from(U_OPS_TENANT, OPERATOR_IP),
      });
      expect(orgs.statusCode, orgs.body).toBe(200);
      expect(slugs(orgs)).toEqual(
        expect.arrayContaining(["cw-platform", "cw-platform-two", "tenant-live"]),
      ); // every organization: the platform operator's cross-tenant read
      const other = await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${TENANT_ORG}`,
        ...from(U_OPS_TENANT, OPERATOR_IP),
      });
      expect(other.statusCode, other.body).toBe(200); // another tenant's organization
      const lag = await app.inject({
        method: "GET",
        url: "/api/v1/reporting/admin/lag",
        ...from(U_OPS_TENANT, OPERATOR_IP),
      });
      expect(lag.statusCode, lag.body).toBe(200); // platform_admin_scope admits the platform role

      // The superadmin: the permission AND the role come only from the platform-owned row.
      for (const url of ["/api/v1/orgs", "/api/v1/reporting/admin/lag"]) {
        const res = await app.inject({ method: "GET", url, ...from(U_SUPER, OPERATOR_IP) });
        expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      }
      // A service that asks with ids only still sees the platform key; this also fills the permission cache with the full set.
      expect(await holds(app, U_OPS, OPERATOR_IP, "support_session.start")).toBe(true);

      expect((await strippedRows()).length).toBe(before);
    });

    it("OUTSIDE the list the same operator is judged as the tenant user: own organization only, nothing cross-tenant, the platform-scoped read refused", async () => {
      const app = await makeServer(OPERATOR_NET);
      const asOps = (url: string) =>
        app.inject({ method: "GET", url, ...from(U_OPS_TENANT, OUTSIDER_IP) });

      const orgs = await asOps("/api/v1/orgs");
      expect(orgs.statusCode, orgs.body).toBe(200);
      expect(slugs(orgs)).toEqual(["cw-platform"]); // the tenant-level answer: its own organization
      expect((await asOps(`/api/v1/orgs/${TENANT_ORG}`)).statusCode).toBe(403); // not another tenant's
      expect((await asOps(`/api/v1/orgs/${PLATFORM_ORG}`)).statusCode).toBe(200); // its own
      // The permission is still held (through the tenant role); what is gone is the platform role the predicate demands.
      expect((await asOps("/api/v1/reporting/admin/lag")).statusCode).toBe(403);

      // The superadmin held nothing else: once the platform row is withheld, neither the permission nor the role is there.
      for (const url of ["/api/v1/orgs", "/api/v1/reporting/admin/lag"]) {
        const res = await app.inject({ method: "GET", url, ...from(U_SUPER, OUTSIDER_IP) });
        expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
      }

      // Ids only: the cache holds the full set from the first test, and a stripped request must not be served from it.
      expect(await holds(app, U_OPS, OUTSIDER_IP, "support_session.start")).toBe(false);
      // ... and what it computed was not cached: the same operator from the list still holds the key.
      expect(await holds(app, U_OPS, OPERATOR_IP, "support_session.start")).toBe(true);
    });

    it("a tenant admin (no platform role) gets the same answer from every address, and leaves no row: tenant access is neither widened nor narrowed", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await strippedRows()).length;
      for (const ip of [OPERATOR_IP, OUTSIDER_IP]) {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/orgs",
          ...from(U_TENANT_ADMIN, ip, TENANT_ORG),
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(slugs(res)).toEqual(["tenant-live"]);
        const foreign = await app.inject({
          method: "GET",
          url: `/api/v1/orgs/${PLATFORM_ORG}`,
          ...from(U_TENANT_ADMIN, ip, TENANT_ORG),
        });
        expect(foreign.statusCode).toBe(403);
      }
      expect((await strippedRows()).length).toBe(before);
    });

    it("audits the strip as a platform-scoped row written through the platform writer as chartwarden_app: one per operator and address a minute, ids and role keys only, unreadable from a tenant", async () => {
      const app = await makeServer(OPERATOR_NET);
      const before = (await strippedRows()).length;
      const headers = (user: string) => from(user, OUTSIDER_IP);
      // Three requests by one operator inside one minute, one by the superadmin: two rows, not four.
      for (const url of ["/api/v1/orgs", "/api/v1/orgs", "/api/v1/reporting/admin/lag"]) {
        await app.inject({ method: "GET", url, ...headers(U_OPS_TENANT) });
      }
      await app.inject({ method: "GET", url: "/api/v1/orgs", ...headers(U_SUPER) });

      const rows = (await strippedRows()).slice(before);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          organization_id: null, // a strip has no tenant: the SECURITY DEFINER platform writer
          actor_user_id: null,
          actor_kind: "system",
          outcome: "denied",
          severity: "warn",
          retention_class: "compliance",
          resource_kind: "platform_console",
        });
        expect(row.context).toMatchObject({
          reason: "platform_authority_stripped",
          sourceIp: OUTSIDER_IP,
          method: "GET",
          route: "/api/v1/orgs",
          organizationId: PLATFORM_ORG,
        });
      }
      const byUser = Object.fromEntries(rows.map((r) => [String(r.context.userId), r.context]));
      expect(byUser[U_OPS_TENANT]?.strippedRoleKeys).toEqual(["platform_ops"]);
      expect(byUser[U_SUPER]?.strippedRoleKeys).toEqual(
        expect.arrayContaining(["superadmin", "platform_ops", "platform_go_live_approver"]),
      );
      const flat = JSON.stringify(rows.map((r) => r.context)).toLowerCase();
      for (const secret of [
        "authorization",
        "cookie",
        "x-step-up",
        "x-test-user",
        "support_session",
      ]) {
        expect(flat).not.toContain(secret);
      }
      const seen = await asTenant<{ n: string }>(
        TENANT_ORG,
        `SELECT count(*)::text AS n FROM audit_event WHERE event_type = '${STRIPPED}'`,
      );
      expect(seen[0]?.n).toBe("0");
    });

    it("with the variable unset nothing is stripped (an unconfigured deployment is unchanged)", async () => {
      const app = await makeServer(undefined);
      const before = (await strippedRows()).length;
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs",
        ...from(U_OPS_TENANT, OUTSIDER_IP),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(slugs(res)).toEqual(
        expect.arrayContaining(["cw-platform", "cw-platform-two", "tenant-live"]),
      );
      expect((await strippedRows()).length).toBe(before);
    });

    it("fails closed on a list that is set but unusable: the operator is stripped even from the operator's own address", async () => {
      const app = await makeServer(`${OPERATOR_NET},0.0.0.0/0`);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs",
        ...from(U_OPS_TENANT, OPERATOR_IP),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(slugs(res)).toEqual(["cw-platform"]);
    });

    it("keeps the 403 on a console route from outside the list (the strip is for every other route)", async () => {
      const app = await makeServer(OPERATOR_NET);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/platform/tenants/tenant-live/onboarding",
        ...from(U_APPROVER, OUTSIDER_IP),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("PLATFORM_CONSOLE_ADDRESS_NOT_ALLOWED");
    });
  });
});
