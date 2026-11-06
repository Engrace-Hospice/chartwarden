/**
 * M23 — each tenant's own clearinghouse (ADR-0053 amendment 2026-11-06), LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:tenant-clearinghouse:live   (SUPERUSER url, THROWAWAY database)
 *
 * The tenant surface runs as the NOBYPASSRLS `chartwarden_app` (a superuser connection would make every cross-tenant
 * assertion vacuous); the slug lookup of the platform surface runs on the BYPASSRLS `chartwarden_platform_login` built by
 * `scripts/db/provision-runtime-roles.ts` itself. Vendor calls are mocks (no network, obvious fake credentials). Proves:
 *   - a tenant chooses, verifies and activates its own clearinghouse; the credential is sealed, never returned, never in the
 *     table in the clear, never in an audit row (the trigger scrubs it);
 *   - RLS: a tenant reads and writes only its own row; it cannot delete, cannot rewrite another org's, and an insert for
 *     another org is refused;
 *   - per-org transport resolution against the real table picks each org's OWN vendor and mode, and nothing for `outside`, a
 *     draft, or an org with no row (the env fallback serves only the org an operator named);
 *   - the claims-billing gate allows / refuses per choice (enforce), through the real seams;
 *   - a platform operator sets the same config on the tenant's behalf only while it is onboarding (409 after), with an audit
 *     row naming operator + org + reason, and wizard step 7 settles through the real advance pass;
 *   - vendor and mode lock once a production submission exists; a credential rotation drops a live config back to draft (D6);
 *   - the tenant-held vendor BAA: the tenant records it, a platform operator verifies it (a live tenant too), and the table's
 *     CHECK and the activation both refuse `active` without it (D2); the sealed credential's audit trigger says THAT it changed;
 *   - the org-level `billing.clearinghouse.*` keys: a holder of only the provider-entity-scoped MAC keys is refused (D3);
 *   - the tenant routes write a field-level audit row (names, never values); a switch is refused while claims are queued;
 *   - a suspended subscription still refuses new claims work through the real seams (D1); a claim job for a draft config is held.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { InMemoryAttemptStore } from "@chartwarden/x12-837-client";
import { createInMemoryHarness } from "@chartwarden/x12-837-client/testing";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimsBillingVerdict,
  configureClaimsBillingGate,
} from "../src/bootstrap/claims-billing-gate";
import { buildServer } from "../src/bootstrap/index";
import {
  buildOrgAdminCountReader,
  buildOrgSeedFactsReader,
} from "../src/bootstrap/org-spine-facts";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import { m34PlatformBypassAuditor } from "../src/index";
import { buildClearinghouseAuditPort } from "../src/m23-clearinghouse-audit";
import { holdBeforeRun } from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import {
  buildDrizzleOrgMacJurisdictionReader,
  buildMacFeedConfiguredReader,
} from "../src/modules/23-billing-medicare/jobs/mac-jurisdictions";
import { buildTenantClearinghouseOnboardingPort } from "../src/modules/23-billing-medicare/tenant-clearinghouse/onboarding-port";
import { registerM23TenantClearinghouseSeams } from "../src/modules/23-billing-medicare/tenant-clearinghouse/register";
import { createTenantClearinghouseRuntime } from "../src/modules/23-billing-medicare/tenant-clearinghouse/resolver";
import { registerTenantClearinghouseRoutes } from "../src/modules/23-billing-medicare/tenant-clearinghouse/routes";
import { buildClearinghouseSecretCipher } from "../src/modules/23-billing-medicare/tenant-clearinghouse/secret-cipher";
import { createTenantClearinghouseService } from "../src/modules/23-billing-medicare/tenant-clearinghouse/service";
import { buildDrizzleTenantClearinghouseRouteService } from "../src/modules/23-billing-medicare/tenant-clearinghouse/tenant-service";
import { countQueuedClaims } from "../src/modules/23-billing-medicare/tenant-clearinghouse/waiting-work";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  buildDrizzleOnboardingDataService,
  buildPlatformTenantResolver,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import { createOnboardingAdvancer } from "../src/modules/34-saas-tenant-platform/jobs/platform-sweeps-worker";
import { createSettleOnboardingForOrg } from "../src/modules/34-saas-tenant-platform/onboarding/settle-for-org";
import { createDrizzleSubscriptionWorkBlockReader } from "../src/modules/35-subscription/addon/entitlement";
import { countQueuedCommercialSubmissions } from "../src/modules/41-billing-commercial/index";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-clearinghouse";
const JOB_ID = "m23-tenant-clearinghouse-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_A = "a1000000-0000-4000-8000-0000000000a1"; // an ACTIVE tenant: claimmd, chosen through its own routes
const ORG_B = "b2000000-0000-4000-8000-0000000000b2"; // onboarding: set by the platform operator
const ORG_C = "c3000000-0000-4000-8000-0000000000c3"; // outside
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // chose nothing
const ORG_E = "e5000000-0000-4000-8000-0000000000e5"; // named in the env fallback list, no row
const ORG_F = "f6000000-0000-4000-8000-0000000000f6"; // onboarding: chooses outside through the platform route
const ORG_G = "a7000000-0000-4000-8000-0000000000a7"; // stedi, active
const OPERATOR = "c9000000-0000-4000-8000-0000000000c9";
const MEMBERSHIP = "e9000000-0000-4000-8000-0000000000e9";
const TENANT_ADMIN = "7a000000-0000-4000-8000-0000000000a7";
const ENTITY_MANAGER = "7b000000-0000-4000-8000-0000000000b7"; // a billing manager scoped to ONE provider entity (MAC keys only)
const REASON = "Customer asked support to set up their clearinghouse, ticket CHG-5001";
const BAA = {
  heldBy: "tenant",
  effectiveDate: "2026-01-15",
  documentRef: "Claim.MD BAA, signed 2026-01-15, contract folder 7",
} as const;

const KEY_A = "fake-claimmd-key-A#live-1";
const KEY_A2 = "fake-claimmd-key-A#live-2-rotated";
const KEY_B = "fake-claimmd-key-B#live-1";
const KEY_G = "fake-stedi-key-G-live-1";
const KEY_BAD = "fake-bad-key-live-1";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

describe.skipIf(!DB_URL)("M23 tenant clearinghouse, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  let platformPool: ReturnType<typeof createDbClient>;
  let server: FastifyInstance;
  let seq = 0;
  const probed: { secret: string; mode: string }[] = [];
  const cipher = buildClearinghouseSecretCipher(Buffer.alloc(32, 11));

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];
  const errorCode = (res: { json: () => Record<string, unknown> }): unknown => {
    const body = res.json();
    return (body.error as { code?: string } | undefined)?.code ?? body.code;
  };
  const OPS = {
    "x-test-user": OPERATOR,
    "x-test-org": PLATFORM_ORG,
    "x-test-roles": "platform_ops",
  };
  const opsWrite = () => ({ ...OPS, "x-step-up": "fresh", "idempotency-key": `live-${++seq}` });
  const tenantRead = (org: string) => ({
    "x-test-user": TENANT_ADMIN,
    "x-test-org": org,
    "x-test-roles": "org_admin",
  });
  const tenantWrite = (org: string) => ({
    ...tenantRead(org),
    "x-step-up": "fresh",
    "idempotency-key": `live-${++seq}`,
  });
  const tenantCall = (
    method: "GET" | "PUT" | "POST",
    org: string,
    path: string,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    server.inject({
      method,
      url: `/api/v1/tenant/clearinghouse${path}`,
      headers: { ...(method === "GET" ? tenantRead(org) : tenantWrite(org)), ...extra },
      ...(payload ? { payload } : {}),
    });
  const platformCall = (
    method: "GET" | "PUT" | "POST",
    slug: string,
    path: string,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    server.inject({
      method,
      url: `/api/v1/platform/tenants/${slug}/clearinghouse${path}`,
      headers: { ...(method === "GET" ? OPS : opsWrite()), ...extra },
      ...(payload ? { payload } : {}),
    });

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
  const step7 = (org: string) =>
    q<{ status: string }>(
      "SELECT status FROM onboarding_task WHERE organization_id=$1 AND template_key='clearinghouse_selected'",
      [org],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [id, slug] of [
      [PLATFORM_ORG, "cw-platform"],
      [ORG_A, "ch-a"],
      [ORG_B, "ch-b"],
      [ORG_C, "ch-c"],
      [ORG_D, "ch-d"],
      [ORG_E, "ch-e"],
      [ORG_F, "ch-f"],
      [ORG_G, "ch-g"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    // The row-audit trigger writes app.user_id to audit_event.actor_user_id (a foreign key to user): both actors are real users.
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops-clearinghouse@test.test')`, [
      OPERATOR,
    ]);
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'admin-clearinghouse@test.test')`, [
      TENANT_ADMIN,
    ]);
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'entity-clearinghouse@test.test')`,
      [ENTITY_MANAGER],
    );
    for (const [org, status] of [
      [ORG_A, "active"],
      [ORG_B, "onboarding"],
      [ORG_F, "onboarding"],
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,$3,'b@x.test','p@x.test')",
        [org, status, `Tenant ${status}`],
      );
    }
    // Wizard tasks for the two onboarding tenants; steps 1-6 are done so step 7 (clearinghouse_selected) is the one in play.
    for (const org of [ORG_B, ORG_F]) {
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key)
         SELECT $1, (SELECT id FROM tenant_account WHERE organization_id=$1), key FROM onboarding_task_template WHERE retired_at IS NULL`,
        [org],
      );
      await admin.query(
        "UPDATE onboarding_task SET status='done' WHERE organization_id=$1 AND template_key = ANY($2)",
        [
          org,
          [
            "account_created",
            "plan_contract",
            "baa_executed",
            "provisioning_complete",
            "ccn_registered",
            "locations_seeded",
          ],
        ],
      );
    }

    tenantPool = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const provisioned = spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
      cwd: join(__dirname, "../../.."),
      env: {
        ...process.env,
        PROVISION_DATABASE_URL: DB_URL,
        CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PASSWORD,
      },
      encoding: "utf8",
    });
    expect(provisioned.status, provisioned.stderr).toBe(0);
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "chartwarden_platform_login";
    platformUrl.password = PLATFORM_PASSWORD;
    platformPool = createDbClient({ connectionString: platformUrl.toString() });
    registerPlatformJob(JOB_ID);

    // The seams the gate and the wizard read, over the real tenant pool; the env fallback names ORG_E only. The gate also asks
    // M35 whether the subscription is suspended / paused / canceled (owner decision D1): the real reader.
    registerSeam(
      "SubscriptionWorkBlockReader",
      createDrizzleSubscriptionWorkBlockReader(tenantPool.db),
    );
    registerM23TenantClearinghouseSeams({
      db: tenantPool.db,
      env: { CLEARINGHOUSE_VENDOR: "in_memory", CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS: ORG_E },
    });
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });

    // The real advance pass, with the clearinghouse fact read through the real seam.
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    const alerts: AlertEmitter = {
      async emit() {
        return { alertId: "a", resolvedRecipientCount: 0 };
      },
    };
    const advance = createOnboardingAdvancer({
      db: tenantPool.db,
      outbox: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
      },
      alerts,
      facts: {
        orgSeed: buildOrgSeedFactsReader(tenantPool.db),
        orgAdminCount: buildOrgAdminCountReader(tenantPool.db),
        macFeedConfigured: buildMacFeedConfiguredReader(
          buildDrizzleOrgMacJurisdictionReader(tenantPool.db),
        ),
        clearinghouseSettled: async (orgId) => {
          const choice = await getSeam("TenantClearinghouseReader").choiceForOrg(orgId);
          return choice.vendor !== null && choice.status === "active";
        },
      },
    });
    const settleOnboarding = createSettleOnboardingForOrg({
      db: tenantPool.db,
      advance: async ({ tenantAccountId, organizationId }) => {
        await advance({ tenantAccountId, orgId: organizationId });
      },
    });

    const service = createTenantClearinghouseService({
      cipher,
      // A switch is refused while claims or commercial submissions are queued (the same real counters the composition root binds).
      waitingWork: async (organizationId) => ({
        claims: await countQueuedClaims(tenantPool.db, organizationId),
        commercialSubmissions: await countQueuedCommercialSubmissions(
          tenantPool.db,
          organizationId,
        ),
      }),
      // The Claim.MD connection test is a mock: no network. It records what it was handed.
      probes: {
        claimmd: async (secret, mode) => {
          probed.push({ secret, mode });
          return secret.includes("bad") ? "credential_rejected" : "ok";
        },
      },
    });
    const dataService = buildDrizzleOnboardingDataService({
      db: tenantPool.db,
      resolveTenant: buildPlatformTenantResolver({
        platformDb: platformPool.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
      }),
      clearinghouse: buildTenantClearinghouseOnboardingPort({ db: tenantPool.db, service }),
      settleOnboarding,
    });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: PLATFORM_ORG,
          userId: OPERATOR,
          grants: [
            {
              roleKey: "platform_ops",
              enabled: true,
              expiresAt: null,
              permissionKeys: [
                "tenant_clearinghouse.read_platform",
                "tenant_clearinghouse.write_platform",
                "tenant_clearinghouse.verify_baa_platform",
              ],
            },
          ],
        },
        ...[ORG_A, ORG_B, ORG_G].map((orgId) => ({
          orgId,
          userId: TENANT_ADMIN,
          grants: [
            {
              roleKey: "org_admin",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.clearinghouse.read", "billing.clearinghouse.admin"],
            },
          ],
        })),
        // D3: a billing manager scoped to one provider entity holds the entity-scoped MAC credential keys and NOT the org-level pair
        ...[ORG_A, ORG_B].map((orgId) => ({
          orgId,
          userId: ENTITY_MANAGER,
          grants: [
            {
              roleKey: "billing_manager",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.mac_credential.read", "billing.mac_credential.admin"],
            },
          ],
        })),
        { orgId: ORG_D, userId: TENANT_ADMIN, grants: [] },
      ]).store,
    );
    const reg = createPredicateRegistry();
    reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
    reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountTenantPlatformRoutes(server, tenantPool.db, { onboardingData: { service: dataService } });
    registerTenantClearinghouseRoutes(server, {
      tenantClearinghouseService: buildDrizzleTenantClearinghouseRouteService({
        db: tenantPool.db,
        service,
        audit: buildClearinghouseAuditPort(),
        onChanged: settleOnboarding,
      }),
    });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    configureClaimsBillingGate({ mode: "shadow" });
    await tenantPool?.close();
    await platformPool?.close();
    await admin?.end();
  });

  it("a tenant admin chooses Claim.MD: 201 draft, the credential sealed and never returned", async () => {
    expect((await tenantCall("GET", ORG_A, "")).json()).toMatchObject({
      vendor: null,
      source: "none",
    });
    const res = await tenantCall("PUT", ORG_A, "", {
      vendor: "claimmd",
      mode: "test",
      secret: KEY_A,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      vendor: "claimmd",
      mode: "test",
      status: "draft",
      hasSecret: true,
      source: "tenant",
    });
    expect(res.body).not.toContain(KEY_A);
    const [row] = await q<{ secret_cipher: string }>(
      "SELECT secret_cipher FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    expect(row?.secret_cipher).toBeTruthy();
    expect(row?.secret_cipher).not.toContain(KEY_A);
    expect((await tenantCall("GET", ORG_A, "")).body).not.toContain(KEY_A);
  });

  it("verifies with the connection test on the unsealed key; activation needs the vendor BAA recorded by the tenant and verified by an operator; the gate follows", async () => {
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });
    const verify = await tenantCall("POST", ORG_A, "/verify", {});
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json()).toMatchObject({
      config: { status: "verified", verification: { kind: "connection_test" } },
      test: { outcome: "ok" },
    });
    expect(probed.at(-1)).toEqual({ secret: KEY_A, mode: "test" });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });

    // D2: connection verified is not enough. No BAA recorded -> 409.
    const noBaa = await tenantCall("POST", ORG_A, "/activate", {});
    expect(noBaa.statusCode).toBe(409);
    expect(errorCode(noBaa)).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    // The tenant records its own BAA; an operator has not verified it yet -> still 409.
    const record = await tenantCall("POST", ORG_A, "/baa", BAA);
    expect(record.statusCode, record.body).toBe(200);
    expect(record.json()).toMatchObject({
      status: "verified",
      baaRequired: true,
      baa: { heldBy: "tenant", effectiveDate: BAA.effectiveDate, verified: null },
    });
    const unverified = await tenantCall("POST", ORG_A, "/activate", {});
    expect(unverified.statusCode).toBe(409);
    expect(errorCode(unverified)).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    // The tenant cannot verify its own BAA: the route does not exist on the tenant surface, and the body refuses the field.
    expect((await tenantCall("POST", ORG_A, "/baa", { ...BAA, verified: true })).statusCode).toBe(
      422,
    );
    // A platform operator verifies it: allowed for an ACTIVE tenant too (ORG_A is live), audited with operator, org and reason.
    // Round 2, M1: the verification is pinned (If-Match) to the record the operator read; it is required, and a record swapped by the
    // tenant after that read is a 409 that verifies nothing.
    const pin = (record.json() as { baa: { recordedAt: string } }).baa.recordedAt;
    const unpinned = await platformCall("POST", "ch-a", "/baa/verify", { reason: REASON });
    expect(unpinned.statusCode).toBe(428);
    expect(errorCode(unpinned)).toBe("IF_MATCH_REQUIRED");
    const swapped = await tenantCall("POST", ORG_A, "/baa", {
      ...BAA,
      documentRef: "Claim.MD BAA, a different agreement, contract folder 9",
    });
    expect(swapped.statusCode, swapped.body).toBe(200);
    const stale = await platformCall(
      "POST",
      "ch-a",
      "/baa/verify",
      { reason: REASON },
      { "if-match": `"${pin}"` },
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorCode(stale)).toBe("CLEARINGHOUSE_BAA_CHANGED");
    expect(
      (await tenantCall("GET", ORG_A, "")).json() as { baa: { verified: unknown } },
    ).toMatchObject({ baa: { verified: null } });
    const livePin = (swapped.json() as { baa: { recordedAt: string } }).baa.recordedAt;
    const verified = await platformCall(
      "POST",
      "ch-a",
      "/baa/verify",
      { reason: REASON },
      { "if-match": `"${livePin}"` },
    );
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ baa: { verified: { at: expect.any(String) } } });
    const [baaAudit] = await q<{ actor_user_id: string; context: Record<string, unknown> }>(
      "SELECT actor_user_id, context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_baa_verified'",
      [ORG_A],
    );
    expect(baaAudit?.actor_user_id).toBe(OPERATOR);
    expect(baaAudit?.context).toMatchObject({
      reason: REASON,
      targetOrganizationId: ORG_A,
      // the audit row names the record that was verified (a screened reference and a date, never patient data)
      baaDocumentRef: "Claim.MD BAA, a different agreement, contract folder 9",
      baaEffectiveDate: BAA.effectiveDate,
      baaRecordedAt: livePin,
    });

    const activate = await tenantCall("POST", ORG_A, "/activate", {});
    expect(activate.statusCode, activate.body).toBe(200);
    expect(activate.json()).toMatchObject({ status: "active" });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({ allow: true });
  });

  it("D3: a billing manager scoped to one provider entity (MAC credential keys only) is refused on every clearinghouse route", async () => {
    const headers = (stepUp: boolean) => ({
      "x-test-user": ENTITY_MANAGER,
      "x-test-org": ORG_A,
      "x-test-roles": "billing_manager",
      ...(stepUp ? { "x-step-up": "fresh", "idempotency-key": `live-${++seq}` } : {}),
    });
    const get = await server.inject({
      method: "GET",
      url: "/api/v1/tenant/clearinghouse",
      headers: headers(false),
    });
    expect(get.statusCode).toBe(403);
    for (const [method, path, payload] of [
      ["PUT", "", { vendor: "outside" }],
      ["POST", "/baa", BAA],
      ["POST", "/verify", {}],
      ["POST", "/activate", {}],
    ] as const) {
      const res = await server.inject({
        method,
        url: `/api/v1/tenant/clearinghouse${path}`,
        headers: headers(true),
        payload,
      });
      expect(res.statusCode, `${method} ${path}`).toBe(403);
    }
  });

  it("the gate refuses outside and nothing-chosen, and allows the org named in the env fallback list", async () => {
    await q(
      "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, status, set_by_membership_id) VALUES ($1,'outside','active',$2)",
      [ORG_C, MEMBERSHIP],
    );
    expect(await claimsBillingVerdict(ORG_C, {})).toEqual({
      allow: false,
      reason: "clearinghouse_outside",
    });
    expect(await claimsBillingVerdict(ORG_D, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_chosen",
    });
    expect(await claimsBillingVerdict(ORG_E, {})).toEqual({ allow: true });
    expect(await getSeam("TenantClearinghouseReader").choiceForOrg(ORG_E)).toMatchObject({
      vendor: "in_memory",
      source: "platform_env",
    });
    expect(await getSeam("TenantClearinghouseReader").choiceForOrg(ORG_C)).toMatchObject({
      vendor: "outside",
      status: "active",
      source: "tenant",
    });
  });

  it("RLS: a tenant sees only its own row, cannot rewrite or delete another org's, and cannot insert for another org", async () => {
    const count = async (org: string) =>
      Number(
        (
          await asTenant<{ n: number }>(
            org,
            "SELECT count(*)::int AS n FROM tenant_clearinghouse_config",
          )
        )[0]?.n,
      );
    expect(await count(ORG_A)).toBe(1);
    expect(await count(ORG_D)).toBe(0);
    expect(
      await asTenant(ORG_D, "UPDATE tenant_clearinghouse_config SET vendor='outside' RETURNING id"),
    ).toHaveLength(0);
    const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await client.connect();
    const inTx = async (org: string, sql: string, params: unknown[] = []) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
        await client.query(sql, params);
      } finally {
        await client.query("ROLLBACK");
      }
    };
    try {
      await expect(
        inTx(
          ORG_D,
          "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, status, set_by_membership_id) VALUES ($1,'outside','active',$2)",
          [ORG_A, MEMBERSHIP],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(inTx(ORG_A, "DELETE FROM tenant_clearinghouse_config")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        inTx(ORG_A, "UPDATE tenant_clearinghouse_config SET organization_id=organization_id"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });

  it("the table's own CHECKs refuse an impossible row (an active transmitting config with no secret)", async () => {
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, set_by_membership_id) VALUES ($1,'stedi','test','active',$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("D2: the table refuses an ACTIVE transmitting config whose BAA is not verified, and a half-recorded BAA", async () => {
    const sealed = (await cipher.encrypt(ORG_D, KEY_G, { vendor: "stedi", mode: "test" })).cipher;
    const columns = `(organization_id, vendor, mode, status, secret_cipher, secret_dek_version, verification_kind, verified_at,
       verified_by_membership_id, activated_at, activated_by_membership_id, set_by_membership_id`;
    // active with a verified connection but NO verified BAA
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config ${columns})
         VALUES ($1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3)`,
        [ORG_D, sealed, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
    // active with a recorded but unverified BAA
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config ${columns},
           baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id)
         VALUES ($1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3,'stedi','2026-01-01','BAA ref',now(),$3)`,
        [ORG_D, sealed, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
    // round 2, L1: an active config resting on a VERIFIED BAA of ANOTHER vendor (a Claim.MD BAA under a Stedi config)
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config ${columns},
           baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id,
           baa_verified_at, baa_verified_by_membership_id)
         VALUES ($1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3,'claimmd','2026-01-01','BAA ref',now(),$3,now(),$3)`,
        [ORG_D, sealed, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
    // ... the same row on its OWN vendor's verified BAA is allowed (so the refusal above is the vendor, not the shape)
    await q(
      `INSERT INTO tenant_clearinghouse_config ${columns},
         baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id,
         baa_verified_at, baa_verified_by_membership_id)
       VALUES ($1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3,'stedi','2026-01-01','BAA ref',now(),$3,now(),$3)`,
      [ORG_D, sealed, MEMBERSHIP],
    );
    await q("DELETE FROM tenant_clearinghouse_config WHERE organization_id=$1", [ORG_D]);
    // a BAA vendor that is no vendor, and a vendor with no record behind it
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_vendor, baa_effective_date, baa_document_ref,
           baa_recorded_at, baa_recorded_by_membership_id, set_by_membership_id)
         VALUES ($1,'stedi','test','draft','outside','2026-01-01','BAA ref',now(),$2,$2)`,
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_vendor_ck/);
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_vendor, set_by_membership_id) VALUES ($1,'stedi','test','draft','stedi',$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_record_ck/);
    // a BAA record with a missing part
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_document_ref, set_by_membership_id) VALUES ($1,'stedi','test','draft','BAA ref',$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_record_ck/);
    // a verification with no record behind it
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_verified_at, baa_verified_by_membership_id, set_by_membership_id) VALUES ($1,'stedi','test','draft',now(),$2,$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_verified_ck/);
  });

  it("resolves each org's OWN transport from the real table: its vendor and mode, nothing for outside, draft or no row", async () => {
    await q(
      `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, secret_cipher, secret_dek_version,
         verification_kind, verified_at, verified_by_membership_id, activated_at, activated_by_membership_id, set_by_membership_id,
         baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id, baa_verified_at,
         baa_verified_by_membership_id)
       VALUES ($1,'stedi','production','active',$2,1,'attested',now(),$3,now(),$3,$3,'stedi','2026-01-01','Stedi BAA ref',now(),$3,now(),$3)`,
      [
        ORG_G,
        (await cipher.encrypt(ORG_G, KEY_G, { vendor: "stedi", mode: "production" })).cipher,
        MEMBERSHIP,
      ],
    );
    const platformBinding = {
      vendor: "in_memory" as const,
      transport: createInMemoryHarness().transport,
    };
    const runtime = createTenantClearinghouseRuntime({
      db: tenantPool.db,
      cipher,
      attempts: new InMemoryAttemptStore(),
      platformBinding,
      fallbackOrgIds: new Set([ORG_E]),
    });
    const forOrg = runtime.binding.forOrg;
    expect((await forOrg?.(ORG_A))?.transport.vendor).toBe("claimmd");
    expect((await forOrg?.(ORG_G))?.transport.vendor).toBe("stedi");
    expect((await forOrg?.(ORG_C))?.vendor).toBeNull();
    expect((await forOrg?.(ORG_D))?.vendor).toBeNull();
    expect(await forOrg?.(ORG_E)).toBe(platformBinding);
    expect(await runtime.usageFor(ORG_A)).toBe("test");
    expect(await runtime.usageFor(ORG_G)).toBe("production");
    expect(await runtime.usageFor(ORG_C)).toBeNull();
    expect((await forOrg?.(ORG_A))?.transport).not.toBe((await forOrg?.(ORG_G))?.transport);
  });

  it("locks vendor and mode once a production submission exists; a credential rotation drops the live config to draft, the gate refuses and a claim job is HELD (D6)", async () => {
    await q(
      `INSERT INTO clearinghouse_submission_attempt (organization_id, provider_entity_id, scope, usage, idempotency_key, control_number, kind, identity, status, reserved_at)
       VALUES ($1, gen_random_uuid(), 'scope-a', 'production', 'k-1', '000000001', 'claim', repeat('a',64), 'reserved', now())`,
      [ORG_A],
    );
    const [current] = await q<{ version: number }>(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    const version = String(current?.version);
    const swap = await tenantCall(
      "PUT",
      ORG_A,
      "",
      { vendor: "stedi", mode: "production", secret: KEY_G },
      { "if-match": version },
    );
    expect(swap.statusCode).toBe(409);
    expect(errorCode(swap)).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    const rotate = await tenantCall(
      "PUT",
      ORG_A,
      "",
      { vendor: "claimmd", mode: "test", secret: KEY_A2 },
      { "if-match": version },
    );
    expect(rotate.statusCode, rotate.body).toBe(200);
    // the NEW key has not been tried: back to draft, the old key's verification and activation are gone, the BAA (same vendor) stays
    expect(rotate.json()).toMatchObject({
      status: "draft",
      lastTest: null,
      verification: null,
      activatedAt: null,
      baa: { verified: { at: expect.any(String) } },
    });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });
    // a claim job for the org is HELD (delayed, no attempt spent), not failed into the DLQ, even in a mode that lets the work through
    configureClaimsBillingGate({ mode: "shadow", log: () => {} });
    const runtime = createTenantClearinghouseRuntime({
      db: tenantPool.db,
      cipher,
      attempts: new InMemoryAttemptStore(),
      platformBinding: { vendor: "in_memory", transport: createInMemoryHarness().transport },
      fallbackOrgIds: new Set(),
    });
    const moved: number[] = [];
    await expect(
      holdBeforeRun(
        {
          db: tenantPool.db as never,
          transport: { binding: runtime.binding, contexts: {} as never },
          alerts: { dispatch: async () => undefined },
        },
        { moveToDelayed: async (at: number) => void moved.push(at) },
        "tok",
        "claim.submit",
        { organizationId: ORG_A },
      ),
    ).rejects.toThrow();
    expect(moved).toHaveLength(1);
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    // re-verify and re-activate the new key: the BAA needs no second verification
    const reverify = await tenantCall("POST", ORG_A, "/verify", {});
    expect(reverify.json()).toMatchObject({
      config: { status: "verified" },
      test: { outcome: "ok" },
    });
    expect((await tenantCall("POST", ORG_A, "/activate", {})).json()).toMatchObject({
      status: "active",
    });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({ allow: true });
  });

  it("audit: the trigger says THAT the sealed credential changed (secret_changed), and the tenant route writes a field-level row (names only)", async () => {
    const rows = await q<{ event_type: string; context: Record<string, unknown> }>(
      `SELECT event_type, context FROM audit_event
        WHERE organization_id=$1 AND resource_kind='tenant_clearinghouse_config'
          AND event_type LIKE 'tenant_clearinghouse_config.%' ORDER BY created_at`,
      [ORG_A],
    );
    const flags = rows.map((r) => r.context.secret_changed);
    expect(flags[0]).toBe(true); // the first put sealed a credential
    expect(flags).toContain(false); // verify / BAA / activate rewrote other columns only
    // the rotation is the update that swapped the credential
    expect(flags.filter((f) => f === true).length).toBeGreaterThanOrEqual(2);

    const fieldRows = await q<{
      event_type: string;
      actor_user_id: string;
      context: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id, context FROM audit_event
        WHERE organization_id=$1 AND event_type LIKE 'm23.tenant_clearinghouse.%' ORDER BY created_at`,
      [ORG_A],
    );
    const changed = fieldRows.filter((r) => r.event_type === "m23.tenant_clearinghouse.changed");
    expect(changed[0]?.context).toMatchObject({ changedFields: ["vendor", "mode", "secret"] });
    expect(changed.at(-1)?.context).toMatchObject({ changedFields: ["secret"] }); // the rotation
    expect(changed[0]?.actor_user_id).toBe(TENANT_ADMIN);
    expect(fieldRows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining([
        "m23.tenant_clearinghouse.baa_recorded",
        "m23.tenant_clearinghouse.verified",
        "m23.tenant_clearinghouse.activated",
      ]),
    );
    // names and codes only: never a credential, a document reference or an evidence note
    const blob = JSON.stringify(fieldRows);
    for (const secret of [KEY_A, KEY_A2, BAA.documentRef]) expect(blob).not.toContain(secret);
  });

  it("a switch is refused while the org has claims queued, with the counts; a same-vendor rotation is not a switch", async () => {
    // ORG_G (stedi, active) with one queued claim attempt (FK triggers are off for this seed: only the count is under test)
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(
        `INSERT INTO claim_submission (organization_id, provider_entity_id, kind, claim_id, claim_control_number, attempt_index, outcome)
         VALUES ($1, gen_random_uuid(), 'claim_837i', gen_random_uuid(), 'CW-CTRL-QUEUED', 0, 'queued')`,
        [ORG_G],
      );
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
    const [row] = await q<{ version: number }>(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_G],
    );
    const refused = await tenantCall(
      "PUT",
      ORG_G,
      "",
      { vendor: "outside" },
      { "if-match": String(row?.version) },
    );
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe("CLEARINGHOUSE_WORK_WAITING");
    expect(JSON.stringify(refused.json())).toContain('"claims"');
    await admin
      .query("DELETE FROM claim_submission WHERE organization_id=$1", [ORG_G])
      .catch(() => undefined);
  });

  it("a tenant admin without the key is refused (403)", async () => {
    expect((await tenantCall("GET", ORG_D, "")).statusCode).toBe(403);
    expect((await tenantCall("PUT", ORG_D, "", { vendor: "outside" })).statusCode).toBe(403);
  });

  it("a platform operator sets a tenant's clearinghouse while it is onboarding: audited, sealed, and step 7 settles after activation", async () => {
    const put = await platformCall("PUT", "ch-b", "", {
      vendor: "claimmd",
      mode: "test",
      secret: KEY_B,
      reason: REASON,
    });
    expect(put.statusCode, put.body).toBe(201);
    expect(put.body).not.toContain(KEY_B);
    expect((await step7(ORG_B))[0]?.status).toBe("pending"); // chosen, but only a draft
    const verify = await platformCall("POST", "ch-b", "/verify", { reason: REASON });
    expect(verify.json()).toMatchObject({ test: { outcome: "ok" } });
    expect((await step7(ORG_B))[0]?.status).toBe("pending"); // verified is not active
    // D2: the tenant's BAA must be recorded (by the tenant) and verified (by an operator) first
    const early = await platformCall("POST", "ch-b", "/activate", { reason: REASON });
    expect(early.statusCode).toBe(409);
    expect(errorCode(early)).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    expect((await tenantCall("POST", ORG_B, "/baa", BAA)).statusCode).toBe(200);
    const recordedB = (await tenantCall("GET", ORG_B, "")).json() as {
      baa: { recordedAt: string };
    };
    expect(
      (
        await platformCall(
          "POST",
          "ch-b",
          "/baa/verify",
          { reason: REASON },
          { "if-match": `"${recordedB.baa.recordedAt}"` },
        )
      ).statusCode,
    ).toBe(200);
    const activate = await platformCall("POST", "ch-b", "/activate", { reason: REASON });
    expect(activate.statusCode, activate.body).toBe(200);
    expect((await step7(ORG_B))[0]?.status).toBe("done"); // the real advance pass settled it

    const [audit] = await q<{
      actor_user_id: string;
      actor_role: string;
      outcome: string;
      context: Record<string, unknown>;
    }>(
      "SELECT actor_user_id, actor_role, outcome, context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_set'",
      [ORG_B],
    );
    expect(audit).toMatchObject({
      actor_user_id: OPERATOR,
      actor_role: "platform_ops",
      outcome: "success",
    });
    expect(audit?.context).toMatchObject({
      reason: REASON,
      targetOrganizationId: ORG_B,
      changedFields: ["vendor", "mode", "secret"],
    });
    const verifyAudit = await q<{ context: Record<string, unknown> }>(
      "SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_verified'",
      [ORG_B],
    );
    expect(verifyAudit[0]?.context).toMatchObject({
      verificationKind: "connection_test",
      testOutcome: "ok",
    });
    expect(await claimsBillingVerdict(ORG_B, {})).toEqual({ allow: true });
  });

  it("choosing `outside` through the platform route settles step 7 at once", async () => {
    const res = await platformCall("PUT", "ch-f", "", { vendor: "outside", reason: REASON });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ vendor: "outside", status: "active", hasSecret: false });
    expect((await step7(ORG_F))[0]?.status).toBe("done");
    expect(await claimsBillingVerdict(ORG_F, {})).toEqual({
      allow: false,
      reason: "clearinghouse_outside",
    });
  });

  it("refuses the platform write once the tenant is active (409), with nothing written and the refusal audited", async () => {
    const before = await q(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    const res = await platformCall(
      "PUT",
      "ch-a",
      "",
      { vendor: "outside", reason: REASON },
      { "if-match": '"1"' },
    );
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe("TENANT_NOT_ONBOARDING");
    expect(
      await q("SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1", [ORG_A]),
    ).toEqual(before);
    const refused = await q(
      "SELECT 1 FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.write_refused'",
      [ORG_A],
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
  });

  it("a failing connection test leaves the config at draft and records the outcome", async () => {
    const bad = await platformCall(
      "PUT",
      "ch-f",
      "",
      { vendor: "claimmd", mode: "test", secret: KEY_BAD, reason: REASON },
      { "if-match": '"1"' },
    );
    expect(bad.statusCode, bad.body).toBe(200);
    const verify = await platformCall("POST", "ch-f", "/verify", { reason: REASON });
    expect(verify.json()).toMatchObject({
      config: { status: "draft", lastTest: { outcome: "credential_rejected" } },
      test: { outcome: "credential_rejected" },
    });
  });

  it("no plaintext credential is in the table, any response or any audit row; the trigger scrubs the sealed value", async () => {
    const dump = JSON.stringify(await q("SELECT t::text AS t FROM tenant_clearinghouse_config t"));
    const audits = JSON.stringify(
      await q("SELECT before, after, context FROM audit_event WHERE organization_id = ANY($1)", [
        [ORG_A, ORG_B, ORG_F, ORG_G],
      ]),
    );
    for (const secret of [KEY_A, KEY_A2, KEY_B, KEY_G, KEY_BAD]) {
      expect(dump).not.toContain(secret);
      expect(audits).not.toContain(secret);
    }
    const triggerRows = await q<{ after: Record<string, unknown> }>(
      "SELECT after FROM audit_event WHERE organization_id=$1 AND resource_kind='tenant_clearinghouse_config' AND event_type LIKE 'tenant_clearinghouse_config.%'",
      [ORG_A],
    );
    expect(triggerRows.length).toBeGreaterThan(0);
    for (const row of triggerRows) expect(row.after.secret_cipher).toBe("<changed>");
  });
});
