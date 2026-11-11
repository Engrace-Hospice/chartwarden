import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  resetAuthorizationContract,
  setAbacEvaluator,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { registerPlatformJob, resetPlatformJobRegistry } from "@chartwarden/tenancy";
import Fastify, { type FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerOpsClaimMdObservabilityRoute } from "../src/bootstrap/routes/ops-claimmd-observability";
import { registerOpsClaimMdRecoveryReadinessRoutes } from "../src/bootstrap/routes/ops-claimmd-recovery-readiness";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  CLAIMMD_RESPONSE_METRICS_JOB_ID,
  createClaimMdOperationalReader,
} from "../src/modules/23-billing-medicare/claimmd-capture/operational-reader";
import {
  CLAIMMD_ERA_METRICS_JOB_ID,
  CLAIMMD_ERA_RECOVERY_JOB_ID,
  createClaimMdEraStore,
} from "../src/modules/25-remittance/ingest/claimmd-era-store";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS = join(__dirname, "../../../packages/db/migrations");
const ACCOUNT = "synthetic-bil55";
const PLATFORM_PASSWORD = "bil55-platform-password";
const OPERATOR = "10000000-0000-4000-8000-000000005501";
const TENANT_USER = "10000000-0000-4000-8000-000000005502";
const ERA = "20000000-0000-4000-8000-000000005501";

describe.skipIf(!DB_URL)("BIL-5.5 central Claim.MD HTTP/PostgreSQL boundary", () => {
  let admin: Client;
  let platform: ReturnType<typeof createDbClient>;
  let tenant: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS, file), "utf8"));

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
    await admin.query(
      "INSERT INTO claimmd_response_stream(account_reference,usage,cursor,last_attempt_at,last_success_at) VALUES ($1,'test','41',now(),now())",
      [ACCOUNT],
    );
    const stream = await admin.query<{ id: string }>(
      "INSERT INTO claimmd_era_stream(account_reference,usage,cursor,last_attempt_at,last_success_at) VALUES ($1,'test','19',now(),now()) RETURNING id",
      [ACCOUNT],
    );
    await admin.query(
      `INSERT INTO claimmd_era_inbox
       (id,stream_id,account_reference,usage,era_id,source_metadata_cipher,source_metadata_key_id,
        source_metadata_digest,discovery_page_digest,capture_state,retry_count,last_error_code)
       VALUES ($1,$2,$3,'test','5501','synthetic-cipher','test-key',$4,$4,'retryable_failure',5,'VENDOR_UNAVAILABLE')`,
      [ERA, stream.rows[0]?.id, ACCOUNT, "a".repeat(64)],
    );

    platform = createDbClient({
      connectionString: roleUrl("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    tenant = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerPlatformJob(CLAIMMD_RESPONSE_METRICS_JOB_ID);
    registerPlatformJob(CLAIMMD_ERA_METRICS_JOB_ID);
    registerPlatformJob(CLAIMMD_ERA_RECOVERY_JOB_ID);
    const responses = createClaimMdOperationalReader({
      platformDb: platform.db,
      auditBypass: m34PlatformBypassAuditor,
      accountReference: ACCOUNT,
      usage: "test",
    });
    const eras = createClaimMdEraStore({
      platformDb: platform.db,
      auditBypass: m34PlatformBypassAuditor,
      keyRing: { activeId: "test-key", byId: new Map([["test-key", Buffer.alloc(32, 7)]]) },
    });
    app = Fastify();
    app.addHook("onRequest", async (request: FastifyRequest) => {
      const principal = request.headers["x-test-principal"];
      if (principal !== "platform" && principal !== "tenant-admin") return;
      request.context = {
        correlationId: crypto.randomUUID(),
        userId: principal === "platform" ? OPERATOR : TENANT_USER,
        organizationId: "30000000-0000-4000-8000-000000005501",
        providerEntityIds: [],
        locationIds: [],
        roles: principal === "platform" ? ["platform_ops"] : ["org_admin"],
        attributes: {},
        ip: "127.0.0.1",
        userAgent: "synthetic-bil55-live-test",
        startTime: Date.now(),
      };
    });
    setEffectivePermissionResolver(
      (context) =>
        new Set(context.userId === OPERATOR ? ["billing.rule_config.platform_admin"] : []),
    );
    setAbacEvaluator((_predicate, context) => context.userId === OPERATOR);
    registerOpsClaimMdObservabilityRoute(app, {
      usage: "test",
      responseSnapshot: () => responses.snapshot(),
      eraSnapshot: () => eras.operationalSnapshot(ACCOUNT, "test"),
    });
    registerOpsClaimMdRecoveryReadinessRoutes(app, {
      accountReference: ACCOUNT,
      usage: "test",
      preflight: (query) => eras.recoveryPreflight(query),
    });
  }, 300_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetPlatformJobRegistry();
    await app?.close();
    await platform?.close();
    await tenant?.close();
    await admin?.end();
  });

  it("serves real central aggregates only to a platform-authorized request", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/ops/claimmd/observability",
      headers: { "x-test-principal": "platform" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      scope: "central_claimmd_account",
      accountReferenceExposed: false,
      responses: { cursor: { present: true, valueExposed: false } },
      eras: { backlog: { retryableFailure: 1 } },
    });
    expect(JSON.stringify(ok.json())).not.toContain(ACCOUNT);
    expect(ok.json().responses.cursor).not.toHaveProperty("value");
    for (const [principal, expectedStatus] of [
      ["tenant-admin", 403],
      ["missing", 401],
    ] as const) {
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/ops/claimmd/observability",
        headers: { "x-test-principal": principal },
      });
      expect(denied.statusCode).toBe(expectedStatus);
    }
  });

  it("keeps central tables outside the tenant runtime role", async () => {
    await expect(tenant.pool.query("select id from claimmd_era_inbox")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("preflights and dry-runs concurrently without changing durable processing state", async () => {
    const before = await state();
    const url = `/api/v1/ops/claimmd/eras/${ERA}/recovery-preflight?usage=test&stage=capture`;
    const preflight = await app.inject({
      method: "GET",
      url,
      headers: { "x-test-principal": "platform" },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      disposition: "eligible_for_simulation",
      simulation: {
        available: true,
        mutatesSource: false,
        callsVendor: false,
        authorizesExecution: false,
      },
    });
    const dryUrl = url.replace("recovery-preflight", "recovery-dry-run");
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: dryUrl, headers: { "x-test-principal": "platform" } }),
      app.inject({ method: "POST", url: dryUrl, headers: { "x-test-principal": "platform" } }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(await state()).toEqual(before);
    const mismatch = await app.inject({
      method: "GET",
      url: `/api/v1/ops/claimmd/eras/${ERA}/recovery-preflight?usage=production&stage=capture`,
      headers: { "x-test-principal": "platform" },
    });
    expect(mismatch.statusCode).toBe(422);
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/ops/claimmd/eras/99999999-9999-4999-8999-999999999999/recovery-preflight?usage=test&stage=capture",
      headers: { "x-test-principal": "platform" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("reports an active processing lease as a hard blocker", async () => {
    await admin.query(
      "UPDATE claimmd_era_stream SET lease_owner=$1,lease_until=now()+interval '5 minutes' WHERE account_reference=$2 AND usage='test'",
      ["40000000-0000-4000-8000-000000005501", ACCOUNT],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ops/claimmd/eras/${ERA}/recovery-preflight?usage=test&stage=capture`,
      headers: { "x-test-principal": "platform" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      disposition: "blocked",
      leaseActive: true,
      blockers: expect.arrayContaining(["ACTIVE_LEASE"]),
    });
    await admin.query(
      "UPDATE claimmd_era_stream SET lease_owner=NULL,lease_until=NULL WHERE account_reference=$1 AND usage='test'",
      [ACCOUNT],
    );
  });

  async function state() {
    const result = await admin.query(
      `SELECT s.cursor,s.generation,s.lease_owner,s.lease_until,i.capture_state,i.retry_count,i.last_error_code,
        (SELECT count(*)::int FROM remittance_line) AS payment_lines,
        (SELECT count(*)::int FROM outbox_event WHERE event_type LIKE 'm25.%') AS financial_events
       FROM claimmd_era_inbox i JOIN claimmd_era_stream s ON s.id=i.stream_id WHERE i.id=$1`,
      [ERA],
    );
    return result.rows[0];
  }

  function roleUrl(role: string, password: string): string {
    const url = new URL(DB_URL as string);
    url.username = role;
    url.password = password;
    return url.toString();
  }
});
