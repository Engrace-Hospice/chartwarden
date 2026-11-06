/**
 * M34 — a platform operator enters a tenant's onboarding data on its behalf, LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:onboarding-data:live   (SUPERUSER url, THROWAWAY database)
 *
 * The routes are mounted over the REAL services on the NOBYPASSRLS `chartwarden_app` tenant pool (the platform bypass
 * login is used only to prove the #952 NPI-verification screen lists what the operator created), behind the REAL
 * guards (permission, the `tenant_lifecycle_platform_ops` predicate, step-up, AI-actor block, Idempotency-Key).
 * What a unit test cannot prove, and this does:
 *   - the operator's rows land in the TARGET org (provider entity, location, MAC credential + its outbox event), are
 *     visible to that org's RLS scope and to no other, and the write-audit trigger attributes each to the OPERATOR;
 *   - while the tenant is `provisioning` / `onboarding` the write is accepted; once `active` it is refused with
 *     409 TENANT_NOT_ONBOARDING, nothing is written, and the refusal is audited;
 *   - no step-up (403 STEP_UP_REQUIRED), an AI actor (403), a missing / short / whitespace reason (422), a missing
 *     Idempotency-Key (400), a tenant administrator (403) and a non-platform_ops role (403) are all refused;
 *   - every success leaves ONE audit row naming operator + target org + reason, and no EIN or MAC secret appears in a
 *     response, a list, a database column in the clear, an audit row or the outbox payload;
 *   - an operator cannot hang a credential on another tenant's provider entity, nor PATCH or POST against another
 *     tenant's provider-entity / location ids through his slug (404, nothing written there);
 *   - a duplicate CCN / NPI is a 409 (the savepoint inside the operator's transaction rolls back cleanly);
 *   - every FAILED attempt (404, 409, ...) leaves a `denied` write_failed audit row beside the rolled-back write;
 *   - an activation in flight holds a write back (advisory lock) and the write then sees `active` (409);
 *   - the keys migration 1330 binds to `platform_ops` are what authorise the route (real DB permission store);
 *   - an Idempotency-Key retry replays one write, and the same key aimed at another tenant is a 409.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createDbEffectivePermissionStore,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { registerPlatformJob } from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { m34PlatformBypassAuditor } from "../src/index";
import { createTaxIdCipher } from "../src/modules/02-identity/tax-id-cipher";
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23ReadService,
  buildDrizzleM23WriteService,
  buildDrizzleNpiVerificationService,
  buildMacOnboardingCredentialPort,
  buildMacSecretCipherFromEnv,
} from "../src/modules/23-billing-medicare/index";
import {
  M24_OUTBOX_EVENTS,
  buildCredentialCipherPort,
  buildDrizzleM24ReadService,
  buildDrizzleM24WriteService,
  buildMedicaidOnboardingCredentialPort,
} from "../src/modules/24-billing-medicaid/index";
import {
  buildDrizzleOnboardingDataService,
  buildPlatformTenantResolver,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-onboarding";
const JOB_ID = "m34-onboarding-data-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_A = "a1000000-0000-4000-8000-0000000000a1"; // active tenant that already owns a provider entity
const ORG_B = "b2000000-0000-4000-8000-0000000000b2"; // the tenant being onboarded
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // still provisioning
const ORG_E = "e6000000-0000-4000-8000-0000000000e6"; // onboarding; idempotency + activation-lock cases
const ORG_F = "f8000000-0000-4000-8000-0000000000f8"; // onboarding; attestation-void, advance and reason-screen cases
const OPERATOR = "c3000000-0000-4000-8000-0000000000c3";
const MEMBERSHIP = "e5000000-0000-4000-8000-0000000000e5";
const A_PE = "f6000000-0000-4000-8000-0000000000f6";
const A_LOC = "f7000000-0000-4000-8000-0000000000f7";
const GRANT_USER = "c3000000-0000-4000-8000-0000000000c4"; // holds only platform_admin in the DB
const GRANT_MEMBERSHIP = "e5000000-0000-4000-8000-0000000000e6";

const EIN_DIGITS = "123456789";
const MAC_SECRET = "mac-client-secret-live-7f3a91";
const MEDICAID_SECRET = "medicaid-client-secret-live-c41e08";
const REASON = "Customer asked support to enter their CMS identity, ticket CHG-4521";

const OPS_HEADERS = {
  "x-test-user": OPERATOR,
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
  const kind = request.headers["x-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

const PE_BODY = {
  ccn: "444444",
  npi: "1679576722",
  legalName: "Beta Hospice of the Valley",
  taxId: "12-3456789",
  fiscalYearEnd: "0630",
  reason: REASON,
};
const MAC_BODY = {
  macJurisdiction: "noridian_jf",
  submitterId: "SUB123",
  tradingPartnerId: "TP123",
  clientId: "client-live",
  clientSecret: MAC_SECRET,
  reason: REASON,
};

describe.skipIf(!DB_URL)("M34 platform onboarding data, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  let platformPool: ReturnType<typeof createDbClient>;
  let server: FastifyInstance;
  let seq = 0;
  const advanced: { tenantAccountId: string; organizationId: string }[] = [];
  const warnings: string[] = [];
  let peId = "";
  let locationId = "";
  let credentialId = "";
  let medicaidId = "";

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  const writeHeaders = (extra: Record<string, string> = {}) => ({
    ...OPS_HEADERS,
    "x-step-up": "fresh",
    "idempotency-key": `live-${++seq}`,
    ...extra,
  });
  const call = (
    method: "GET" | "POST" | "PATCH",
    slug: string,
    path: string,
    payload?: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) =>
    server.inject({
      method,
      url: `/api/v1/platform/tenants/${slug}/${path}`,
      headers: method === "GET" ? { ...OPS_HEADERS, ...extra } : writeHeaders(extra),
      ...(payload ? { payload } : {}),
    });
  const errorCode = (res: { json: () => Record<string, unknown> }): unknown => {
    const body = res.json();
    return (body.error as { code?: string } | undefined)?.code ?? body.code;
  };

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
  const countAsTenant = async (org: string, from: string): Promise<number> =>
    Number((await asTenant<{ n: number }>(org, `SELECT count(*)::int AS n FROM ${from}`))[0]?.n);

  const auditRows = (org: string, eventType: string) =>
    q<{
      actor_user_id: string | null;
      actor_role: string | null;
      outcome: string;
      resource_id: string | null;
      context: Record<string, unknown>;
    }>(
      "SELECT actor_user_id, actor_role, outcome, resource_id, context FROM audit_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at",
      [org, eventType],
    );

  /** The suite's default grants: explicit keys for the operator, none for a tenant admin. */
  const useInMemoryPermissions = () =>
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
                "tenant_onboarding_data.read_platform",
                "tenant_onboarding_data.write_platform",
              ],
            },
          ],
        },
        { orgId: ORG_A, userId: "tenant-a-admin", grants: [] },
      ]).store,
    );

  const failedRows = (org: string) => auditRows(org, "m34.tenant_onboarding.write_failed");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      [ORG_A, "onb-a"],
      [ORG_B, "onb-b"],
      [ORG_D, "onb-d"],
      [ORG_E, "onb-e"],
      [ORG_F, "onb-f"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops-onboarding@test.test')`, [
      OPERATOR,
    ]);
    for (const [org, status] of [
      [ORG_A, "active"],
      [ORG_B, "onboarding"],
      [ORG_D, "provisioning"],
      [ORG_E, "onboarding"],
      [ORG_F, "onboarding"],
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,$3,'b@x.test','p@x.test')",
        [org, status, `Tenant ${status}`],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops-admin-only@test.test')`, [
      GRANT_USER,
    ]);
    // Tenant A already owns a provider entity and a location; the operator must never reach them from tenant B's slug.
    await admin.query(
      `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'111111','Alpha Hospice','1234567893','sealed-elsewhere','1231')`,
      [A_PE, ORG_A],
    );
    await admin.query(
      `INSERT INTO location (id, provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,$2,'Alpha Main','1 Alpha Way','Reno','NV','89501','America/Los_Angeles')`,
      [A_LOC, A_PE],
    );

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

    // The real catalog-validating publisher: the MAC upsert's `m23.mac_credential.updated` is checked against its schema.
    const publisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M24_OUTBOX_EVENTS]),
    );
    const macCipher = buildMacSecretCipherFromEnv({
      M24_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(macCipher).not.toBeNull();
    const dek = { version: "1", key: Buffer.alloc(32, 9) };
    registerPlatformJob(JOB_ID);
    const service = buildDrizzleOnboardingDataService({
      db: tenantPool.db,
      advance: async (tenant) => {
        advanced.push(tenant);
      },
      warn: (message) => warnings.push(message),
      resolveTenant: buildPlatformTenantResolver({
        platformDb: platformPool.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
      }),
      taxIdCipher: createTaxIdCipher({
        dekForOrg: async () => dek,
        dekForOrgVersion: async () => dek,
      }),
      macCredentials: buildMacOnboardingCredentialPort({
        writeService: buildDrizzleM23WriteService(tenantPool.db, {
          outbox: {
            publish: (tx, e) =>
              publisher.publish(tx as never, { ...e, callerModule: "m23" } as never),
          },
          ...(macCipher ? { secretCipher: macCipher } : {}),
        }),
        readService: buildDrizzleM23ReadService(tenantPool.db),
      }),
      medicaidCredentials: buildMedicaidOnboardingCredentialPort({
        writeService: buildDrizzleM24WriteService(
          tenantPool.db,
          {
            publish: (tx, e) =>
              publisher.publish(tx as never, { ...e, callerModule: "m24" } as never),
          },
          buildCredentialCipherPort(Buffer.alloc(32, 5)),
        ),
        readService: buildDrizzleM24ReadService(tenantPool.db),
      }),
    });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    useInMemoryPermissions();
    const reg = createPredicateRegistry();
    reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
    reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountTenantPlatformRoutes(server, tenantPool.db, { onboardingData: { service } });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await tenantPool?.close();
    await platformPool?.close();
    await admin?.end();
  });

  it("creates a provider entity for the onboarding tenant: 201, the row lands in B, the EIN is sealed and never returned", async () => {
    const res = await call("POST", "onb-b", "provider-entities", PE_BODY);
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    peId = created.id;
    expect(created).toMatchObject({
      organizationId: ORG_B,
      ccn: "444444",
      legalName: "Beta Hospice of the Valley",
      status: "created",
    });
    expect(res.body).not.toContain(EIN_DIGITS);
    expect(Object.keys(created)).not.toContain("taxId");

    const [row] = await q<{ organization_id: string; tax_id_encrypted: string }>(
      "SELECT organization_id, tax_id_encrypted FROM provider_entity WHERE id=$1",
      [peId],
    );
    expect(row?.organization_id).toBe(ORG_B);
    expect(row?.tax_id_encrypted.startsWith("v2.")).toBe(true);
    expect(row?.tax_id_encrypted).not.toContain(EIN_DIGITS);
  });

  it("creates a service location under it and a MAC credential whose secret is write-only", async () => {
    const loc = await call("POST", "onb-b", "locations", {
      providerEntityId: peId,
      name: "Valley Main Office",
      addressLine1: "100 Main St",
      city: "Fresno",
      state: "CA",
      postalCode: "93701",
      timezone: "America/Los_Angeles",
      reason: REASON,
    });
    expect(loc.statusCode, loc.body).toBe(201);
    locationId = loc.json().id;

    const mac = await call("POST", "onb-b", "mac-credentials", {
      ...MAC_BODY,
      providerEntityId: peId,
    });
    expect(mac.statusCode, mac.body).toBe(201);
    credentialId = mac.json().credentialId;
    expect(mac.json()).toMatchObject({
      organizationId: ORG_B,
      providerEntityId: peId,
      hasSecret: true,
    });
    expect(mac.body).not.toContain(MAC_SECRET);

    const [cred] = await q<{ organization_id: string; client_secret_cipher: string }>(
      "SELECT organization_id, client_secret_cipher FROM mac_submitter_credential WHERE id=$1",
      [credentialId],
    );
    expect(cred?.organization_id).toBe(ORG_B);
    expect(cred?.client_secret_cipher).not.toContain(MAC_SECRET);

    // The credential write emitted its event through the REAL catalog-validating publisher, on tenant B.
    const events = await q<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE event_type='m23.mac_credential.updated' AND organization_id=$1",
      [ORG_B],
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.payload)).not.toContain(MAC_SECRET);
  });

  it("creates a state Medicaid trading-partner credential through M24's own service; the secret and key are write-only", async () => {
    const res = await call("POST", "onb-b", "state-medicaid-credentials", {
      providerEntityId: peId,
      serviceState: "CA",
      channel: "sftp",
      tradingPartnerId: "TP-CA-1",
      clientId: "medi-client",
      clientSecret: MEDICAID_SECRET,
      sftpHost: "sftp.example.test",
      sftpUser: "tenant-b",
      sftpKey: `sftp-key-${MEDICAID_SECRET}`,
      activeFrom: "2026-01-01",
      reason: REASON,
    });
    expect(res.statusCode, res.body).toBe(201);
    medicaidId = res.json().id;
    expect(res.body).not.toContain(MEDICAID_SECRET);

    const [row] = await q<{
      organization_id: string;
      client_secret_cipher: string;
      sftp_key_cipher: string;
    }>(
      "SELECT organization_id, client_secret_cipher, sftp_key_cipher FROM state_medicaid_trading_partner_credential WHERE id=$1",
      [medicaidId],
    );
    expect(row?.organization_id).toBe(ORG_B);
    expect(row?.client_secret_cipher).not.toContain(MEDICAID_SECRET);
    expect(row?.sftp_key_cipher).not.toContain(MEDICAID_SECRET);

    const events = await q<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE event_type='m24.medicaid_trading_partner.updated' AND organization_id=$1",
      [ORG_B],
    );
    expect(events).toHaveLength(1);

    const list = await call("GET", "onb-b", "state-medicaid-credentials");
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      id: medicaidId,
      hasClientSecret: true,
      hasSftpKey: true,
    });
    expect(list.body).not.toContain(MEDICAID_SECRET);

    const [audit] = await auditRows(ORG_B, "m34.tenant_onboarding.medicaid_credential_upserted");
    expect(audit).toMatchObject({
      actor_user_id: OPERATOR,
      outcome: "success",
      resource_id: medicaidId,
      context: expect.objectContaining({ reason: REASON, targetOrganizationId: ORG_B }),
    });
    expect(
      await countAsTenant(
        ORG_A,
        `state_medicaid_trading_partner_credential WHERE id = '${medicaidId}'`,
      ),
    ).toBe(0);
    expect(
      await countAsTenant(
        ORG_B,
        `state_medicaid_trading_partner_credential WHERE id = '${medicaidId}'`,
      ),
    ).toBe(1);
    // ...nor another tenant's provider entity
    const foreign = await call("POST", "onb-b", "state-medicaid-credentials", {
      providerEntityId: A_PE,
      serviceState: "CA",
      channel: "portal",
      tradingPartnerId: "TP-X",
      activeFrom: "2026-01-01",
      reason: REASON,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("the rows are visible to tenant B's RLS scope and to no other (real chartwarden_app)", async () => {
    for (const from of [
      `provider_entity WHERE id = '${peId}'`,
      `location WHERE id = '${locationId}'`,
      `mac_submitter_credential WHERE id = '${credentialId}'`,
    ]) {
      expect(await countAsTenant(ORG_B, from), `B sees ${from}`).toBe(1);
      expect(await countAsTenant(ORG_A, from), `A must not see ${from}`).toBe(0);
    }
    // ...and tenant A still sees only its own provider entity.
    expect(await countAsTenant(ORG_A, "provider_entity")).toBe(1);
  });

  it("the write-audit trigger attributes the tenant's rows to the OPERATOR, not to a NULL actor", async () => {
    const rows = await q<{ resource_kind: string; actor_user_id: string | null }>(
      `SELECT resource_kind, actor_user_id FROM audit_event
        WHERE organization_id=$1 AND event_type NOT LIKE 'm34.%'
          AND resource_kind IN ('provider_entity','location','mac_submitter_credential')`,
      [ORG_B],
    );
    expect([...new Set(rows.map((r) => r.resource_kind))].sort()).toEqual([
      "location",
      "mac_submitter_credential",
      "provider_entity",
    ]);
    // `location` still carries the foundation-era trigger, which records NO actor for ANY writer (a tenant admin's own
    // write too); its operator attribution is the explicit m34 audit row asserted below. The other two tables'
    // triggers read `app.user_id`, which the nested site-repository scope must keep set to the operator.
    const attributed = rows.filter((r) => r.resource_kind !== "location");
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed.every((r) => r.actor_user_id === OPERATOR)).toBe(true);
  });

  it("every success left ONE audit row naming operator + target org + reason, with no EIN or secret in it", async () => {
    const expectations: [string, string, string][] = [
      ["m34.tenant_onboarding.provider_entity_created", "provider_entity", peId],
      ["m34.tenant_onboarding.location_created", "location", locationId],
      ["m34.tenant_onboarding.mac_credential_upserted", "mac_submitter_credential", credentialId],
    ];
    for (const [eventType, , resourceId] of expectations) {
      const rows = await auditRows(ORG_B, eventType);
      expect(rows, eventType).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: OPERATOR,
        actor_role: "platform_ops",
        outcome: "success",
        resource_id: resourceId,
        context: expect.objectContaining({
          reason: REASON,
          targetOrganizationId: ORG_B,
          targetOrgSlug: "onb-b",
          operatorUserId: OPERATOR,
          operatorMembershipId: MEMBERSHIP,
          operatorOrganizationId: PLATFORM_ORG,
        }),
      });
    }
    const all = JSON.stringify(
      await q("SELECT * FROM audit_event WHERE organization_id=$1", [ORG_B]),
    );
    expect(all).not.toContain(EIN_DIGITS);
    expect(all).not.toContain(MAC_SECRET);
    expect(all).not.toContain(MEDICAID_SECRET);
  });

  it("reads are masked and audited: no EIN or secret in any list, the other tenant's rows never appear", async () => {
    const pes = await call("GET", "onb-b", "provider-entities");
    expect(pes.statusCode, pes.body).toBe(200);
    expect(pes.json().items.map((p: { id: string }) => p.id)).toEqual([peId]);
    const locs = await call("GET", "onb-b", "locations");
    expect(locs.json().items.map((l: { id: string }) => l.id)).toEqual([locationId]);
    const macs = await call("GET", "onb-b", "mac-credentials");
    expect(macs.statusCode, macs.body).toBe(200);
    expect(macs.json().items).toHaveLength(1);
    expect(macs.json().items[0]).toMatchObject({ credentialId, hasSecret: true });
    for (const res of [pes, locs, macs]) {
      expect(res.body).not.toContain(EIN_DIGITS);
      expect(res.body).not.toContain(MAC_SECRET);
      expect(res.body).not.toContain("client_secret_cipher");
    }
    // Slug A is a different tenant: its own list, none of B's rows.
    const aPes = await call("GET", "onb-a", "provider-entities");
    expect(aPes.json().items.map((p: { id: string }) => p.id)).toEqual([A_PE]);

    // The only cross-tenant step, the slug lookup, entered the audited platform context each time.
    const bypass = await q<{ context: { jobId?: string; reason?: string } }>(
      "SELECT context FROM audit_event WHERE event_type='platform.bypass_invoked'",
    );
    expect(bypass.length).toBeGreaterThan(0);
    expect(bypass.every((r) => r.context.jobId === JOB_ID)).toBe(true);

    const reads = await auditRows(ORG_B, "m34.tenant_onboarding.data_read");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads[0]).toMatchObject({ actor_user_id: OPERATOR, outcome: "success" });
  });

  it("patches while onboarding through the tenant's own rules: names are editable, the CMS identity is not", async () => {
    const ok = await call("PATCH", "onb-b", `provider-entities/${peId}`, {
      doingBusinessAs: "Valley Hospice",
      reason: REASON,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().doingBusinessAs).toBe("Valley Hospice");
    const rows = await auditRows(ORG_B, "m34.tenant_onboarding.provider_entity_updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.context).toMatchObject({ changedFields: ["doingBusinessAs"], reason: REASON });

    const immutable = await call("PATCH", "onb-b", `provider-entities/${peId}`, {
      ccn: "999999",
      reason: REASON,
    });
    expect(immutable.statusCode).toBe(422);
  });

  it("refuses a credential hung on another tenant's provider entity, writing nothing", async () => {
    const res = await call("POST", "onb-b", "mac-credentials", {
      ...MAC_BODY,
      providerEntityId: A_PE,
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(
      await q("SELECT 1 FROM mac_submitter_credential WHERE provider_entity_id=$1", [A_PE]),
    ).toEqual([]);
    // The rolled-back attempt is still on the target tenant's trail, and only there.
    const failed = (await failedRows(ORG_B)).filter(
      (r) => r.context.attemptedEvent === "m34.tenant_onboarding.mac_credential_upserted",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      outcome: "denied",
      context: expect.objectContaining({ errorCode: "NOT_FOUND", reason: REASON }),
    });
    expect(await failedRows(ORG_A)).toEqual([]);
  });

  it("a duplicate CCN or NPI is a 409 CCN_TAKEN / NPI_TAKEN, not a 500 from an aborted savepoint", async () => {
    // The platform path runs the tenant's own repository inside the operator's transaction (a nested savepoint): a
    // unique violation caught INSIDE that savepoint would leave it aborted and fail its RELEASE (25P02).
    const dupCcn = await call("POST", "onb-b", "provider-entities", {
      ...PE_BODY,
      npi: "1245319599",
    });
    expect(dupCcn.statusCode, dupCcn.body).toBe(409);
    expect(errorCode(dupCcn)).toBe("CCN_TAKEN");
    const dupNpi = await call("POST", "onb-b", "provider-entities", { ...PE_BODY, ccn: "666555" });
    expect(dupNpi.statusCode, dupNpi.body).toBe(409);
    expect(errorCode(dupNpi)).toBe("NPI_TAKEN");
    // ...also against ANOTHER tenant's identity (the unique index is global), and the transaction is still usable.
    const dupOther = await call("POST", "onb-b", "provider-entities", {
      ...PE_BODY,
      ccn: "111111",
      npi: "1245319599",
    });
    expect(dupOther.statusCode, dupOther.body).toBe(409);
    expect(errorCode(dupOther)).toBe("CCN_TAKEN");

    expect(await q("SELECT 1 FROM provider_entity WHERE organization_id=$1", [ORG_B])).toHaveLength(
      1,
    );
    expect(await auditRows(ORG_B, "m34.tenant_onboarding.provider_entity_created")).toHaveLength(1);

    // Each rolled-back attempt left a `denied` write_failed row in a follow-up transaction: who, which tenant, why,
    // which route and which error code; no EIN and no other body value.
    const failed = (await failedRows(ORG_B)).filter((r) =>
      String(r.context.errorCode).endsWith("_TAKEN"),
    );
    expect(failed.map((r) => r.context.errorCode)).toEqual(["CCN_TAKEN", "NPI_TAKEN", "CCN_TAKEN"]);
    expect(failed[0]).toMatchObject({
      actor_user_id: OPERATOR,
      actor_role: "platform_ops",
      outcome: "denied",
      context: expect.objectContaining({
        reason: REASON,
        targetOrganizationId: ORG_B,
        operatorMembershipId: MEMBERSHIP,
        route: "POST /api/v1/platform/tenants/:orgSlug/provider-entities",
        attemptedEvent: "m34.tenant_onboarding.provider_entity_created",
      }),
    });
    const trail = JSON.stringify(await failedRows(ORG_B));
    expect(trail).not.toContain(EIN_DIGITS);
    expect(trail).not.toContain(PE_BODY.legalName);
  });

  it("through slug onb-b, tenant A's provider-entity and location ids are 404s that write nothing in A", async () => {
    const snapshotA = async () => ({
      pe: await q("SELECT legal_name, status, updated_at FROM provider_entity WHERE id=$1", [A_PE]),
      loc: await q("SELECT name, status, updated_at FROM location WHERE id=$1", [A_LOC]),
      locCount: await q("SELECT 1 FROM location WHERE provider_entity_id=$1", [A_PE]),
    });
    const before = await snapshotA();
    const failedBefore = (await failedRows(ORG_B)).length;

    const attempts = [
      await call("PATCH", "onb-b", `provider-entities/${A_PE}`, {
        legalName: "Hijacked",
        reason: REASON,
      }),
      await call("PATCH", "onb-b", `locations/${A_LOC}`, { name: "Hijacked", reason: REASON }),
      await call("POST", "onb-b", "locations", {
        providerEntityId: A_PE,
        name: "Planted",
        addressLine1: "9 Plant St",
        city: "Reno",
        state: "NV",
        postalCode: "89501",
        timezone: "America/Los_Angeles",
        reason: REASON,
      }),
    ];
    for (const res of attempts) {
      expect(res.statusCode, res.body).toBe(404);
      expect(errorCode(res)).toBe("NOT_FOUND");
    }

    expect(await snapshotA()).toEqual(before);
    const writeEventsInA = await q(
      `SELECT event_type FROM audit_event
        WHERE organization_id=$1 AND event_type LIKE 'm34.tenant_onboarding.%'
          AND event_type <> 'm34.tenant_onboarding.data_read'`,
      [ORG_A],
    );
    expect(writeEventsInA).toEqual([]);
    // The attempts are on the target tenant's own trail, as failed attempts.
    const failed = (await failedRows(ORG_B)).slice(failedBefore);
    expect(failed.map((r) => r.context.errorCode)).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
  });

  describe("migration 1330's grants are what authorise the routes (real DB permission store)", () => {
    const rolePermissionRows = () =>
      q<{ key: string; permission_key: string }>(
        `SELECT r.key, rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id
          WHERE rp.permission_key LIKE 'tenant_onboarding_data.%' ORDER BY r.key, rp.permission_key`,
      );
    const WRITE_KEYS = [
      "tenant_onboarding_data.read_platform",
      "tenant_onboarding_data.write_platform",
    ];
    let migration1330 = "";

    beforeAll(async () => {
      migration1330 = readFileSync(
        join(
          MIGRATIONS_DIR,
          readdirSync(MIGRATIONS_DIR).find((f) =>
            f.startsWith("1330_m34_platform_onboarding_data_permissions"),
          ) as string,
        ),
        "utf8",
      );
      // A fresh database has no platform-owned role rows (`db:platform-role grant` creates them), so the migration
      // bound nothing. Create all three and re-apply the migration, as a deploy does once they exist.
      for (const key of ["platform_ops", "platform_admin", "platform_owner"]) {
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category, scope_level, enabled)
           VALUES (NULL, $1, $1, 'platform_staff'::role_category, 'organization', true)`,
          [key],
        );
      }
      await admin.query(migration1330);
      for (const [membership, user, role] of [
        [MEMBERSHIP, OPERATOR, "platform_ops"],
        [GRANT_MEMBERSHIP, GRANT_USER, "platform_admin"],
      ] as const) {
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
          [membership, user, PLATFORM_ORG],
        );
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id)
           SELECT $1, $2, id FROM role WHERE organization_id IS NULL AND key = $3`,
          [PLATFORM_ORG, membership, role],
        );
      }
    });

    it("binds both keys to platform_ops and to no other role (the predicate denies admin/owner)", async () => {
      const rows = await rolePermissionRows();
      expect(rows.map((r) => `${r.key}:${r.permission_key}`)).toEqual(
        WRITE_KEYS.map((k) => `platform_ops:${k}`),
      );
    });

    it("lets the platform_ops operator list and write, and refuses a platform_admin who holds neither key", async () => {
      registerEffectivePermissionResolver(createDbEffectivePermissionStore(tenantPool.db));
      try {
        const read = await call("GET", "onb-e", "provider-entities");
        expect(read.statusCode, read.body).toBe(200);
        // The role HEADER claims platform_ops, so the predicate passes: only the DB grant is under test.
        const adminOnly = await call("GET", "onb-e", "provider-entities", undefined, {
          "x-test-user": GRANT_USER,
        });
        expect(adminOnly.statusCode, adminOnly.body).toBe(403);
        const adminWrite = await call(
          "POST",
          "onb-e",
          "provider-entities",
          { ...PE_BODY, ccn: "999100", npi: "1003000159" },
          { "x-test-user": GRANT_USER },
        );
        expect(adminWrite.statusCode, adminWrite.body).toBe(403);
        expect(await q("SELECT 1 FROM provider_entity WHERE ccn='999100'")).toEqual([]);
      } finally {
        useInMemoryPermissions();
      }
    });
  });

  describe("an Idempotency-Key retry (tenant E)", () => {
    let ePe = "";
    const locationBody = () => ({
      providerEntityId: ePe,
      name: "Echo Main",
      addressLine1: "5 Echo Rd",
      city: "Fresno",
      state: "CA",
      postalCode: "93701",
      timezone: "America/Los_Angeles",
      reason: REASON,
    });
    const locationsOfE = () => q("SELECT 1 FROM location WHERE provider_entity_id=$1", [ePe]);

    it("replays the first response: ONE location row, ONE audit row, the same body", async () => {
      const pe = await call("POST", "onb-e", "provider-entities", {
        ...PE_BODY,
        ccn: "999111",
        npi: "1003000134",
      });
      expect(pe.statusCode, pe.body).toBe(201);
      ePe = pe.json().id;

      const key = { "idempotency-key": "live-replay-location" };
      const first = await call("POST", "onb-e", "locations", locationBody(), key);
      const replay = await call("POST", "onb-e", "locations", locationBody(), key);
      expect(first.statusCode, first.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await locationsOfE()).toHaveLength(1);
      expect(await auditRows(ORG_E, "m34.tenant_onboarding.location_created")).toHaveLength(1);
    });

    it("the same key and body aimed at ANOTHER tenant slug is a 409, never tenant E's response", async () => {
      const res = await call("POST", "onb-d", "locations", locationBody(), {
        "idempotency-key": "live-replay-location",
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("IDEMPOTENCY_CONFLICT");
      expect(res.body).not.toContain("Echo Main");
      expect(await locationsOfE()).toHaveLength(1);
    });
  });

  it("an activation in flight holds a write back (advisory lock): it waits, then sees `active` and answers 409", async () => {
    // Stand in for the go-live approval: take the EXCLUSIVE onboarding lock and flip the status, uncommitted.
    const activator = new Client({ connectionString: DB_URL });
    await activator.connect();
    try {
      await activator.query("BEGIN");
      await activator.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('tenant-onboarding:' || $1::text, 0))",
        [ORG_E],
      );
      await activator.query("UPDATE tenant_account SET status='active' WHERE organization_id=$1", [
        ORG_E,
      ]);

      let settled = false;
      const attempt = call("POST", "onb-e", "provider-entities", {
        ...PE_BODY,
        ccn: "999222",
        npi: "1003000142",
      }).then((res) => {
        settled = true;
        return res;
      });
      await sleep(750);
      // Without the lock the write would read the still-committed `onboarding` status and succeed within milliseconds.
      expect(settled, "the write must wait for the activation").toBe(false);

      await activator.query("COMMIT");
      const res = await attempt;
      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("TENANT_NOT_ONBOARDING");
      expect(await q("SELECT 1 FROM provider_entity WHERE ccn='999222'")).toEqual([]);
      expect(await auditRows(ORG_E, "m34.tenant_onboarding.write_refused")).toHaveLength(1);
    } finally {
      await activator.query("ROLLBACK").catch(() => undefined);
      await activator.end();
    }
  });

  it("a provisioning tenant accepts the write too", async () => {
    const res = await call("POST", "onb-d", "provider-entities", {
      ...PE_BODY,
      ccn: "555555",
      npi: "1003000126",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().organizationId).toBe(ORG_D);
  });

  it("makes the new provider entity visible to the #952 NPI-verification screen, unverified, on the platform credential", async () => {
    const service = buildDrizzleNpiVerificationService({
      runner: (fn) => platformPool.db.transaction((tx) => fn(tx as unknown as DbClient)),
    });
    const list = await service.list();
    const mine = list.find((e) => e.providerEntityId === peId);
    expect(mine).toMatchObject({
      organizationId: ORG_B,
      npi: "1679576722",
      state: "unverified",
    });
  });

  describe("refusals (nothing is written)", () => {
    const refused = async (res: { statusCode: number }, status: number) => {
      expect(res.statusCode).toBe(status);
      expect(await q("SELECT 1 FROM provider_entity WHERE ccn='777777'")).toEqual([]);
    };
    const body777 = { ...PE_BODY, ccn: "777777", npi: "1245319599" };

    it("without a fresh step-up: 403 STEP_UP_REQUIRED", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/platform/tenants/onb-b/provider-entities",
        headers: { ...OPS_HEADERS, "idempotency-key": `live-${++seq}` },
        payload: body777,
      });
      await refused(res, 403);
      expect(errorCode(res)).toBe("STEP_UP_REQUIRED");
    });

    it("for an AI actor, even with a fresh step-up: 403", async () => {
      await refused(
        await call("POST", "onb-b", "provider-entities", body777, { "x-actor-kind": "ai_agent" }),
        403,
      );
    });

    it("with no, short, padded or empty reason: 422", async () => {
      const { reason: _omit, ...noReason } = body777;
      for (const payload of [
        noReason,
        { ...body777, reason: "short" },
        { ...body777, reason: "abcd         " },
        { ...body777, reason: " ".repeat(30) },
      ]) {
        await refused(await call("POST", "onb-b", "provider-entities", payload), 422);
      }
    });

    it("without an Idempotency-Key: 400", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/platform/tenants/onb-b/provider-entities",
        headers: { ...OPS_HEADERS, "x-step-up": "fresh" },
        payload: body777,
      });
      await refused(res, 400);
      expect(errorCode(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("for a tenant administrator and for a platform role that is not platform_ops: 403", async () => {
      await refused(
        await call("POST", "onb-b", "provider-entities", body777, {
          "x-test-user": "tenant-a-admin",
          "x-test-org": ORG_A,
          "x-test-roles": "org_admin",
        }),
        403,
      );
      await refused(
        await call("POST", "onb-b", "provider-entities", body777, {
          "x-test-roles": "platform_support_t2",
        }),
        403,
      );
      const read = await call("GET", "onb-b", "provider-entities", undefined, {
        "x-test-user": "tenant-a-admin",
        "x-test-org": ORG_A,
        "x-test-roles": "org_admin",
      });
      expect(read.statusCode).toBe(403);
    });

    it("an unknown tenant slug is a 404, not a hint", async () => {
      await refused(await call("POST", "no-such-tenant", "provider-entities", body777), 404);
    });
  });

  describe("review fixes: a write voids a stale attestation, settles at once, and screens its reason", () => {
    const F_LOCATION = (peIdF: string, name: string) => ({
      providerEntityId: peIdF,
      name,
      addressLine1: "9 Elm St",
      city: "Fresno",
      state: "CA",
      postalCode: "93701",
      timezone: "America/Los_Angeles",
      reason: REASON,
    });
    let peF = "";
    const pendingAttestation = () =>
      q(
        `INSERT INTO tenant_go_live_attestation (organization_id, tenant_account_id, attested_by_membership_id, attested_by_user_id)
         SELECT $1, id, 'e5000000-0000-4000-8000-0000000000f1', 'c3000000-0000-4000-8000-0000000000f2' FROM tenant_account WHERE organization_id=$1
         RETURNING id`,
        [ORG_F],
      );
    const attestationStatus = async () =>
      (
        await q<{
          status: string;
          revoke_reason: string | null;
          revoked_by_user_id: string | null;
          revoked_by_membership_id: string | null;
        }>(
          "SELECT status, revoke_reason, revoked_by_user_id, revoked_by_membership_id FROM tenant_go_live_attestation WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1",
          [ORG_F],
        )
      )[0];

    it("an operator write settles at once: the advance runs for the tenant after the commit, not for a refused write", async () => {
      advanced.length = 0;
      const created = await call("POST", "onb-f", "provider-entities", {
        ...PE_BODY,
        ccn: "666661",
        npi: "1245319599",
      });
      expect(created.statusCode, created.body).toBe(201);
      peF = created.json().id;
      const tenantF = (
        await q<{ id: string }>("SELECT id FROM tenant_account WHERE organization_id=$1", [ORG_F])
      )[0]?.id;
      expect(advanced).toEqual([{ tenantAccountId: tenantF, organizationId: ORG_F }]);

      advanced.length = 0;
      const refused = await call("POST", "onb-a", "provider-entities", {
        ...PE_BODY,
        ccn: "666662",
        npi: "1245319599",
      });
      expect(refused.statusCode).toBe(409); // tenant A is active
      expect(advanced).toEqual([]);
    });

    it("an advance failure is warned, never thrown: the write stays", async () => {
      warnings.length = 0;
      const original = advanced.push.bind(advanced);
      advanced.push = () => {
        throw new Error("advance pass unavailable");
      };
      try {
        const res = await call(
          "POST",
          "onb-f",
          "locations",
          F_LOCATION(peF, "Advance Fails Annex"),
        );
        expect(res.statusCode, res.body).toBe(201);
      } finally {
        advanced.push = original;
      }
      expect(warnings).toHaveLength(1);
      expect((await q("SELECT 1 FROM location WHERE name='Advance Fails Annex'")).length).toBe(1);
    });

    it("a write voids the pending go-live attestation in the same transaction, attributed to the operator", async () => {
      await pendingAttestation();
      const res = await call("POST", "onb-f", "locations", F_LOCATION(peF, "Main Campus"));
      expect(res.statusCode, res.body).toBe(201);
      expect(await attestationStatus()).toMatchObject({
        status: "revoked",
        revoke_reason: "onboarding data changed after attestation",
        revoked_by_user_id: OPERATOR,
        revoked_by_membership_id: MEMBERSHIP,
      });
    });

    it("a write that FAILS rolls the void back: the attestation stays pending", async () => {
      await pendingAttestation();
      const dup = await call("POST", "onb-f", "provider-entities", {
        ...PE_BODY,
        ccn: "666661", // the CCN created above
        npi: "1679576722",
      });
      expect(dup.statusCode).toBe(409);
      expect(await attestationStatus()).toMatchObject({ status: "pending" });
      await q("DELETE FROM tenant_go_live_attestation WHERE organization_id=$1", [ORG_F]);
    });

    it("a reason that holds a patient identifier is refused (422) and writes nothing", async () => {
      const before = (
        await q(
          "SELECT 1 FROM location l JOIN provider_entity p ON p.id=l.provider_entity_id WHERE p.organization_id=$1",
          [ORG_F],
        )
      ).length;
      const res = await call("POST", "onb-f", "locations", {
        ...F_LOCATION(peF, "Should Not Exist"),
        reason: "Customer asked support to enter this, patient 900-12-3456 on the call",
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(errorCode(res)).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(res.body).not.toContain("900-12-3456");
      expect(
        (
          await q(
            "SELECT 1 FROM location l JOIN provider_entity p ON p.id=l.provider_entity_id WHERE p.organization_id=$1",
            [ORG_F],
          )
        ).length,
      ).toBe(before);
    });
  });

  it("LOCKED ONCE ACTIVE: the same writes now answer 409 TENANT_NOT_ONBOARDING, change nothing, and the refusal is audited", async () => {
    const before = {
      pe: (await q("SELECT 1 FROM provider_entity WHERE organization_id=$1", [ORG_B])).length,
      loc: (
        await q(
          "SELECT 1 FROM location l JOIN provider_entity p ON p.id=l.provider_entity_id WHERE p.organization_id=$1",
          [ORG_B],
        )
      ).length,
      mac: (await q("SELECT 1 FROM mac_submitter_credential WHERE organization_id=$1", [ORG_B]))
        .length,
    };
    await q("UPDATE tenant_account SET status='active' WHERE organization_id=$1", [ORG_B]);

    const attempts = await Promise.all([
      call("POST", "onb-b", "provider-entities", { ...PE_BODY, ccn: "888888", npi: "1245319599" }),
      call("PATCH", "onb-b", `provider-entities/${peId}`, { legalName: "Renamed", reason: REASON }),
      call("POST", "onb-b", "locations", {
        providerEntityId: peId,
        name: "Second",
        addressLine1: "1 Elm",
        city: "Fresno",
        state: "CA",
        postalCode: "93701",
        timezone: "America/Los_Angeles",
        reason: REASON,
      }),
      call("POST", "onb-b", "mac-credentials", { ...MAC_BODY, providerEntityId: peId }, {}),
      call("POST", "onb-b", "state-medicaid-credentials", {
        providerEntityId: peId,
        serviceState: "CA",
        channel: "portal",
        tradingPartnerId: "TP-LATE",
        activeFrom: "2026-01-01",
        reason: REASON,
      }),
    ]);
    for (const res of attempts) {
      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("TENANT_NOT_ONBOARDING");
    }

    expect({
      pe: (await q("SELECT 1 FROM provider_entity WHERE organization_id=$1", [ORG_B])).length,
      loc: (
        await q(
          "SELECT 1 FROM location l JOIN provider_entity p ON p.id=l.provider_entity_id WHERE p.organization_id=$1",
          [ORG_B],
        )
      ).length,
      mac: (await q("SELECT 1 FROM mac_submitter_credential WHERE organization_id=$1", [ORG_B]))
        .length,
    }).toEqual(before);
    expect(
      (
        await q<{ legal_name: string }>("SELECT legal_name FROM provider_entity WHERE id=$1", [
          peId,
        ])
      )[0]?.legal_name,
    ).toBe("Beta Hospice of the Valley");

    const denied = await auditRows(ORG_B, "m34.tenant_onboarding.write_refused");
    expect(denied).toHaveLength(5);
    expect(denied[0]).toMatchObject({
      actor_user_id: OPERATOR,
      actor_role: "platform_ops",
      outcome: "denied",
      context: expect.objectContaining({
        reason: REASON,
        targetOrganizationId: ORG_B,
        tenantStatus: "active",
      }),
    });

    // Reads stay open: the operator can still see the (masked) data of an active tenant.
    expect((await call("GET", "onb-b", "provider-entities")).statusCode).toBe(200);
  });
});
