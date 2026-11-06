/**
 * M12 / M34 — a tenant's DoseSpot clinic registration (tenant onboarding slice 4, ADR-0110), LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m12:tenant-dosespot:live   (SUPERUSER url, THROWAWAY database)
 *
 * Everything runs on the NOBYPASSRLS `chartwarden_app` tenant pool; the platform login is used only for the slug lookup and to read
 * the tenant key ring (as in production). The sealing runs through the REAL M34 key ring (a wrapped DEK minted by the platform KEK,
 * stored by the SECURITY DEFINER provisioning function, resolved back through `TenantKeyProvider`), the events through the REAL
 * catalog-validating publisher, and the vendor is a fake `fetch` (never a real DoseSpot host). What a unit test cannot prove, and
 * this does:
 *   - RLS: another org cannot read, update, delete or insert for this org; the app role has no DELETE and cannot rewrite the id or the
 *     organization; the CHECKs refuse every impossible state; there is no EPCS column to set;
 *   - the clinic key is sealed (not in any column, audit row or outbox payload in the clear) and opens ONLY through the key ring, bound
 *     to its organization, environment and clinic; the audit trigger records THAT it changed (`secret_changed`), never what it was;
 *   - the tenant lane and the operator lane run the SAME rules under the target org's scope: save -> verify -> activate -> deactivate,
 *     a rotation lands on `registered` and clears what the old key earned, a failed test never promotes, production is refused until
 *     the platform enables it, the tenant lane may rotate but not introduce a Subscription-Key;
 *   - the layered resolver and the REAL adapter: an active row is served with the tenant's own clinic credentials, a row that is not
 *     active is never served from the env map, an org with no row still is, a rotation never reuses the old key's token;
 *   - the sign gate reads the signing transaction: live registration AND a linked prescriber;
 *   - a prescriber's vendor enrolment is create-then-record (the vendor call has no transaction open), records the vendor id,
 *     publishes it, and is idempotent;
 *   - the operator lane: only while the tenant is provisioning / onboarding (409 TENANT_NOT_ONBOARDING otherwise, audited), a
 *     deactivation excepted; every success leaves an audit row naming operator, org and reason;
 *   - the wizard fact: the migration-seeded precondition of step 10 is `context.dosespotSettled == true`, true exactly while the
 *     registration is `active`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import {
  type DoseSpotFetch,
  createEnvTenantConfigResolver,
  createHttpDoseSpotClient,
  createHttpDoseSpotConnectionProbe,
  createLayeredTenantConfigResolver,
} from "@chartwarden/dosespot";
import { __resetModule34SeamsForTest } from "@chartwarden/saas-tenant-platform";
import { registerPlatformJob, withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  ACTIVE_KEK_ENV,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";
import { m34PlatformBypassAuditor } from "../src/index";
import { buildClinicAuditPort } from "../src/m12-dosespot-clinic-audit";
import {
  type DoseSpotWriteOutboxPort,
  M12_OUTBOX_EVENTS,
  buildClinicSecretCipher,
  buildDoseSpotClinicOnboardingPort,
  buildDoseSpotSettledReader,
  buildDrizzleDoseSpotClinicRouteService,
  createDoseSpotClinicService,
  createDrizzleRosterStore,
  createDrizzleTenantConfigSource,
  createPrescriberEnrollmentService,
  createTransmissionGate,
} from "../src/modules/12-dosespot/index";
import {
  type OnboardingOperator,
  buildDrizzleOnboardingDataService,
  buildPlatformTenantResolver,
  createOnboardingAdvancer,
  getTenantKeyProvider,
  registerLiveM34Seams,
  validateModule34Seams,
} from "../src/modules/34-saas-tenant-platform/index";
import { voidPendingGoLiveForDataChange } from "../src/modules/34-saas-tenant-platform/onboarding/go-live-void";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-dosespot";
const JOB_ID = "m12-tenant-dosespot-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_A = "a1000000-0000-4000-8000-0000000000a1"; // onboarding: the tenant under test
const ORG_B = "b2000000-0000-4000-8000-0000000000b2"; // onboarding: a bystander (isolation)
const ORG_C = "c3000000-0000-4000-8000-0000000000c3"; // active tenant (the operator lane is closed to it, deactivate aside)
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // no registration row, served by the env fallback
const TENANT_ADMIN = "e5000000-0000-4000-8000-0000000000e5";
const OPERATOR = "f6000000-0000-4000-8000-0000000000f6";
const MEMBERSHIP = "e7000000-0000-4000-8000-0000000000e7";
const OPS_MEMBERSHIP = "f8000000-0000-4000-8000-0000000000f8";
const KEK = Buffer.alloc(32, 0x42).toString("base64");

const CLINIC_KEY = "clinic-key-plaintext-LIVE-7f3a91c2";
const SUB_KEY = "sub-key-plaintext-LIVE-5b8e0d14";
const ROTATED_KEY = "clinic-key-plaintext-ROTATED-2c9d4e68";
const REASON = "Customer asked support to register their DoseSpot clinic, ticket CHG-8841";
const NPI = "1234567893";
const BASE = {
  environment: "sandbox",
  clinicId: "clinic-live-1",
  serviceClinicianId: "900",
} as const;

describe.skipIf(!DB_URL)(
  "M12 tenant DoseSpot registration, LIVE Postgres on the real roles",
  () => {
    let admin: Client;
    let tenantPool: ReturnType<typeof createDbClient>;
    let platformPool: ReturnType<typeof createDbClient>;
    const accountOf: Record<string, string> = {};
    const platformEnv: Record<string, string | undefined> = {};
    const alerts: {
      alertCode: string;
      organizationId: string;
      payload: Record<string, unknown>;
    }[] = [];
    const settled: string[] = [];
    const advanced: { tenantAccountId: string; organizationId: string }[] = [];
    const warnings: string[] = [];
    let probeStatus = 200;
    let tokenSeq = 0;
    const fetchLog: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [];
    let enrollBehaviour: "ok" | "rejected" = "ok";
    let vendorCallsInsideTx = 0;
    let txOpen = 0;
    let vendorSeq = 700;

    const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) =>
      (await admin.query(text, params)).rows as T[];

    const fakeFetch: DoseSpotFetch = async (url, init) => {
      fetchLog.push({
        url,
        method: init.method,
        headers: { ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      if (url.endsWith("/connect/token")) {
        return {
          status: probeStatus,
          text: async () =>
            probeStatus === 200
              ? JSON.stringify({ access_token: `tok-${++tokenSeq}`, expires_in: 3600 })
              : "",
        };
      }
      if (url.endsWith("/api/clinicians")) {
        if (txOpen > 0) vendorCallsInsideTx += 1;
        return enrollBehaviour === "ok"
          ? { status: 200, text: async () => JSON.stringify({ Id: ++vendorSeq }) }
          : { status: 422, text: async () => "" };
      }
      return {
        status: 200,
        text: async () => JSON.stringify({ Items: [{ PrescriptionId: 77, Status: "eRxSent" }] }),
      };
    };

    /** One query on the REAL `chartwarden_app` role, scoped to `org` exactly as a tenant request is. */
    const asTenant = async <T>(org: string, text: string, params: unknown[] = []): Promise<T[]> => {
      const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
        const { rows } = await client.query(text, params);
        await client.query("ROLLBACK");
        return rows as T[];
      } finally {
        await client.end();
      }
    };
    /** A statement the app role must be REFUSED, as its Postgres error text. */
    const asTenantError = async (
      org: string,
      text: string,
      params: unknown[] = [],
    ): Promise<string> => {
      const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
        await client.query(text, params);
        await client.query("ROLLBACK");
        return "";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await client.end();
      }
    };

    let service: ReturnType<typeof createDoseSpotClinicService>;
    let route: ReturnType<typeof buildDrizzleDoseSpotClinicRouteService>;
    let enrollment: ReturnType<typeof createPrescriberEnrollmentService>;
    let onboardingData: ReturnType<typeof buildDrizzleOnboardingDataService>;
    let outbox: DoseSpotWriteOutboxPort;
    let client: ReturnType<typeof createHttpDoseSpotClient>;
    let seq = 0;

    const tenantActor = (organizationId: string) => ({
      organizationId,
      userId: TENANT_ADMIN,
      membershipId: MEMBERSHIP,
      request: { correlationId: `live-${++seq}`, requestId: `req-${seq}` },
    });
    const operator = (): OnboardingOperator => ({
      userId: OPERATOR,
      membershipId: OPS_MEMBERSHIP,
      organizationId: PLATFORM_ORG,
      roles: ["platform_ops"],
      stepUpRecent: true,
      request: { correlationId: `live-op-${++seq}`, requestId: `req-op-${seq}`, route: "TEST" },
    });
    const rowOf = async (org: string) =>
      (await q("SELECT * FROM dosespot_clinic_registration WHERE organization_id=$1", [org]))[0];
    const eventsOf = (type: string, org: string) =>
      q(
        "SELECT payload, aggregate_id FROM outbox_event WHERE event_type=$1 AND organization_id=$2 ORDER BY created_at",
        [type, org],
      );
    const auditRows = (org: string, eventType: string) =>
      q(
        "SELECT actor_user_id, outcome, resource_id, context FROM audit_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at",
        [org, eventType],
      );
    const errorCode = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return "";
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };

    /** A fully verified registration for `org`, through the tenant lane. */
    async function verifiedFor(org: string, extra: Record<string, unknown> = {}) {
      await route.put(tenantActor(org), { ...BASE, clinicKey: CLINIC_KEY, ...extra }, undefined);
      probeStatus = 200;
      await route.verify(tenantActor(org));
    }

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
        [ORG_A, "ds-a"],
        [ORG_B, "ds-b"],
        [ORG_C, "ds-c"],
        [ORG_D, "ds-d"],
      ] as const) {
        await admin.query(
          "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
          [id, slug],
        );
      }
      for (const [id, email] of [
        [TENANT_ADMIN, "tenant-admin@ds.test"],
        [OPERATOR, "ops@ds.test"],
      ] as const) {
        await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, email]);
      }
      for (const [org, status] of [
        [ORG_A, "onboarding"],
        [ORG_B, "onboarding"],
        [ORG_C, "active"],
        [ORG_D, "onboarding"],
      ] as const) {
        accountOf[org] = (
          await admin.query(
            "INSERT INTO tenant_account (organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,$3,'b@x.test','p@x.test') RETURNING id",
            [org, status, `Tenant ${status}`],
          )
        ).rows[0].id as string;
      }
      await admin.query(
        "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
        [MEMBERSHIP, TENANT_ADMIN, ORG_A],
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

      // The REAL key ring: a wrapped DEK per tenant minted by the platform KEK, stored by the provisioning function, resolved
      // through the D5 `TenantKeyProvider` seam on the platform credential.
      const ring = loadPlatformKekRing({ [ACTIVE_KEK_ENV]: `kek-1:${KEK}` } as NodeJS.ProcessEnv);
      if (!ring) throw new Error("expected a KEK ring");
      const adapter = createPlatformKekAdapter(ring);
      __resetModule34SeamsForTest();
      registerLiveM34Seams({
        db: tenantPool.db,
        auditBypass: m34PlatformBypassAuditor,
        kekUnwrap: adapter,
        keyRingDb: platformPool.db,
      });
      validateModule34Seams();
      for (const org of [ORG_A, ORG_B, ORG_C, ORG_D]) {
        const wrapped = await adapter.mintAndWrapDek({ organizationId: org });
        await platformPool.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.dek_kek_wrapped_ciphertext_b64', ${wrapped.wrappedCiphertextB64}, true), set_config('app.dek_kek_id', ${wrapped.kekId}, true)`,
          );
          await tx.execute(sql`SELECT m34_provision_tenant_key_ring(${accountOf[org]})`);
        });
      }

      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
      outbox = {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m12" }),
      };
      const cipher = buildClinicSecretCipher({
        dekForOrg: (org) => getTenantKeyProvider().dekForOrg(org),
        dekForOrgVersion: (org, version) => getTenantKeyProvider().dekForOrgVersion(org, version),
      });
      const envConfig = createEnvTenantConfigResolver({
        DOSESPOT_TENANT_CONFIGS: JSON.stringify({
          [ORG_A]: {
            baseUrl: "https://env.dosespot.com/webapi/v2",
            subscriptionKey: "env-sub",
            clinicId: "env-clinic",
            clinicKey: "env-key-plaintext",
            serviceClinicianId: "1",
          },
          [ORG_D]: {
            baseUrl: "https://env.dosespot.com/webapi/v2",
            subscriptionKey: "env-sub",
            clinicId: "env-clinic-d",
            clinicKey: "env-key-plaintext-d",
            serviceClinicianId: "1",
          },
        }),
      });
      service = createDoseSpotClinicService({
        cipher,
        probe: createHttpDoseSpotConnectionProbe({ fetch: fakeFetch }),
        env: platformEnv,
        envFallbackFor: (org) => envConfig.configuredOrganizationIds().includes(org.toLowerCase()),
      });
      const alertPort = {
        dispatch: async (a: {
          alertCode: string;
          organizationId: string;
          payload: Record<string, unknown>;
        }) => {
          alerts.push(a);
        },
      };
      const afterWrite = async (
        tx: DbClient,
        scope: { organizationId: string; userId: string; membershipId: string | null },
      ) => {
        await voidPendingGoLiveForDataChange(tx, {
          organizationId: scope.organizationId,
          revokedByUserId: scope.userId,
          revokedByMembershipId: scope.membershipId,
        });
      };
      route = buildDrizzleDoseSpotClinicRouteService({
        db: tenantPool.db,
        service,
        audit: buildClinicAuditPort(),
        outbox,
        afterWrite,
        alerts: alertPort,
        onChanged: async (org) => {
          settled.push(org);
        },
        logError: (cause) => warnings.push(String(cause)),
      });
      client = createHttpDoseSpotClient({
        resolver: createLayeredTenantConfigResolver({
          source: createDrizzleTenantConfigSource({ db: tenantPool.db, cipher, platformEnv }),
          fallback: envConfig,
        }),
        fetch: fakeFetch,
        sleep: async () => undefined,
      });
      enrollment = createPrescriberEnrollmentService({
        inTx: (organizationId, userId, fn) =>
          withOrgContext(tenantPool.db, { organizationId, userId }, async (tx) => {
            txOpen += 1;
            try {
              return await fn(
                createDrizzleRosterStore(tx as unknown as DbClient),
                tx as unknown as DbClient,
              );
            } finally {
              txOpen -= 1;
            }
          }),
        client,
        outbox,
        audit: buildClinicAuditPort(),
        afterWrite,
      });
      registerPlatformJob(JOB_ID);
      onboardingData = buildDrizzleOnboardingDataService({
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
        dosespot: buildDoseSpotClinicOnboardingPort({
          db: tenantPool.db,
          service,
          outbox,
          enrollment,
          alerts: alertPort,
        }),
        settleOnboarding: async (org) => {
          settled.push(org);
        },
      });
    }, 300_000);

    afterAll(async () => {
      await tenantPool?.close();
      await platformPool?.close();
      await admin?.end();
      __resetModule34SeamsForTest();
    });

    // ── the table: RLS, grants, CHECKs, audit ─────────────────────────────────────────────────────────
    describe("dosespot_clinic_registration on the real app role", () => {
      it("a registration is visible to its own org's scope and to no other", async () => {
        await route.put(tenantActor(ORG_B), { ...BASE, clinicKey: CLINIC_KEY }, undefined);
        expect(
          await asTenant(ORG_B, "SELECT organization_id FROM dosespot_clinic_registration"),
        ).toHaveLength(1);
        expect(
          await asTenant(ORG_A, "SELECT organization_id FROM dosespot_clinic_registration"),
        ).toHaveLength(0);
        expect(
          await asTenant(ORG_D, "SELECT organization_id FROM dosespot_clinic_registration"),
        ).toHaveLength(0);
      });

      it("another org cannot update or delete it, and cannot insert a row for it (WITH CHECK)", async () => {
        const upd = await asTenant<{ n: number }>(
          ORG_A,
          `WITH u AS (UPDATE dosespot_clinic_registration SET status='draft' WHERE organization_id='${ORG_B}' RETURNING 1) SELECT count(*)::int AS n FROM u`,
        );
        expect(upd[0]?.n).toBe(0);
        expect(
          await asTenantError(
            ORG_A,
            `DELETE FROM dosespot_clinic_registration WHERE organization_id='${ORG_B}'`,
          ),
        ).toMatch(/permission denied/);
        expect(
          await asTenantError(
            ORG_A,
            `INSERT INTO dosespot_clinic_registration (organization_id, environment, set_by_membership_id) VALUES ('${ORG_B}','sandbox','${MEMBERSHIP}')`,
          ),
        ).toMatch(/row-level security|violates/);
      });

      it("the app role has no DELETE, cannot rewrite the id or the organization, and there is no EPCS column", async () => {
        expect(await asTenantError(ORG_B, "DELETE FROM dosespot_clinic_registration")).toMatch(
          /permission denied/,
        );
        expect(
          await asTenantError(
            ORG_B,
            `UPDATE dosespot_clinic_registration SET organization_id='${ORG_A}'`,
          ),
        ).toMatch(/permission denied/);
        expect(
          await asTenantError(
            ORG_B,
            "UPDATE dosespot_clinic_registration SET id=gen_random_uuid()",
          ),
        ).toMatch(/permission denied/);
        const cols = await q<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_name='dosespot_clinic_registration'",
        );
        expect(cols.some((c) => /epcs/i.test(c.column_name))).toBe(false);
        expect(cols.some((c) => /url/i.test(c.column_name))).toBe(false);
      });

      it("the CHECKs refuse every impossible state", async () => {
        const refused = (set: string) =>
          asTenantError(
            ORG_B,
            `UPDATE dosespot_clinic_registration SET ${set} WHERE organization_id='${ORG_B}'`,
          );
        expect(await refused("status='active'")).toMatch(/check constraint/);
        expect(await refused("status='verified'")).toMatch(/check constraint/);
        expect(await refused("secret_dek_ref=NULL")).toMatch(/check constraint/);
        expect(await refused("environment='staging'")).toMatch(/check constraint/);
        expect(await refused("clinic_id='has space'")).toMatch(/check constraint/);
        expect(await refused("last_test_outcome='great'")).toMatch(/check constraint/);
        expect(await refused("status='draft'")).toMatch(/check constraint/); // a draft carries no registered_at
      });

      it("the audit trigger scrubs the sealed secret and records THAT it changed", async () => {
        const row = await rowOf(ORG_B);
        const audits = await q<{
          before: unknown;
          after: unknown;
          context: { secret_changed?: boolean };
          event_type: string;
        }>(
          "SELECT before, after, context, event_type FROM audit_event WHERE organization_id=$1 AND resource_kind='dosespot_clinic_registration' ORDER BY created_at",
          [ORG_B],
        );
        expect(audits.length).toBeGreaterThan(0);
        expect(audits[0]?.context.secret_changed).toBe(true);
        const dump = JSON.stringify(audits);
        expect(dump).not.toContain(row?.secret_cipher);
        expect(dump).not.toContain(CLINIC_KEY);
      });
    });

    // ── sealing through the real key ring ─────────────────────────────────────────────────────────────
    describe("the clinic key is sealed under the tenant key ring", () => {
      it("is in no column, audit row or outbox payload in the clear, and opens only through the ring", async () => {
        await route.put(tenantActor(ORG_A), { ...BASE, clinicKey: CLINIC_KEY }, undefined);
        const row = await rowOf(ORG_A);
        expect(row?.secret_cipher).toMatch(/^v1\./);
        expect(row?.secret_dek_ref).toBe("v1");
        const everything = JSON.stringify([
          row,
          await q("SELECT * FROM audit_event WHERE organization_id=$1", [ORG_A]),
          await q("SELECT payload FROM outbox_event WHERE organization_id=$1", [ORG_A]),
        ]);
        expect(everything).not.toContain(CLINIC_KEY);
        // it opens through the REAL key ring, bound to its organization, environment and clinic
        const cipher = buildClinicSecretCipher({
          dekForOrg: (org) => getTenantKeyProvider().dekForOrg(org),
          dekForOrgVersion: (org, v) => getTenantKeyProvider().dekForOrgVersion(org, v),
        });
        const ctx = { environment: "sandbox", clinicId: "clinic-live-1" } as const;
        expect(
          (await cipher.decrypt(ORG_A, ctx, row?.secret_cipher, row?.secret_dek_ref)).clinicKey,
        ).toBe(CLINIC_KEY);
        await expect(
          cipher.decrypt(ORG_B, ctx, row?.secret_cipher, row?.secret_dek_ref),
        ).rejects.toThrow(/did not open/);
        await expect(
          cipher.decrypt(
            ORG_A,
            { ...ctx, environment: "production" },
            row?.secret_cipher,
            row?.secret_dek_ref,
          ),
        ).rejects.toThrow(/did not open/);
        await expect(
          cipher.decrypt(
            ORG_A,
            { ...ctx, clinicId: "other" },
            row?.secret_cipher,
            row?.secret_dek_ref,
          ),
        ).rejects.toThrow(/did not open/);
      });

      it("a tenant's view never carries the key", async () => {
        const view = await route.get(ORG_A, TENANT_ADMIN);
        expect(view).toMatchObject({ source: "tenant", status: "registered", hasSecret: true });
        expect(JSON.stringify(view)).not.toContain(CLINIC_KEY);
      });
    });

    // ── the tenant lane: save -> verify -> activate -> rotate -> deactivate ───────────────────────────
    describe("the tenant lane over the real stack", () => {
      it("a failed test is recorded and never promotes; a passing one makes it verified", async () => {
        platformEnv.DOSESPOT_SUBSCRIPTION_KEY_SANDBOX = "platform-sandbox-sub-key";
        fetchLog.length = 0;
        probeStatus = 401;
        const bad = await route.verify(tenantActor(ORG_A));
        expect(bad.test.outcome).toBe("credential_rejected");
        expect(bad.view.status).toBe("registered");
        probeStatus = 200;
        const ok = await route.verify(tenantActor(ORG_A));
        expect(ok.view).toMatchObject({ status: "verified", lastTest: { outcome: "ok" } });
        const mint = fetchLog.find((c) => c.url.endsWith("/connect/token"));
        expect(mint?.url).toBe("https://my.staging.dosespot.com/webapi/v2/connect/token");
        expect(mint?.headers["Subscription-Key"]).toBe("platform-sandbox-sub-key");
        expect(mint?.headers.Authorization).toBe(
          `Basic ${Buffer.from(`clinic-live-1:${CLINIC_KEY}`).toString("base64")}`,
        );
        expect(fetchLog.every((c) => c.url.endsWith("/connect/token"))).toBe(true); // no clinical endpoint was touched
        expect((await rowOf(ORG_A))?.verified_by_membership_id).toBe(MEMBERSHIP);
      });

      it("activating publishes m12.dosespot_config.activated through the real catalog and writes a field-level audit row", async () => {
        const view = await route.activate(tenantActor(ORG_A));
        expect(view.status).toBe("active");
        const events = await eventsOf("m12.dosespot_config.activated", ORG_A);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({
          registrationId: (await rowOf(ORG_A))?.id,
          environment: "sandbox",
        });
        const audits = await auditRows(ORG_A, "m12.dosespot_clinic.activated");
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ actor_user_id: TENANT_ADMIN, outcome: "success" });
        expect(audits[0]?.context.changedFields).toEqual(["status"]);
        expect(settled).toContain(ORG_A);
        // activating again is idempotent: no second event
        await route.activate(tenantActor(ORG_A));
        expect(await eventsOf("m12.dosespot_config.activated", ORG_A)).toHaveLength(1);
      });

      it("a rotation lands on `registered`, clears what the old key earned, publishes `deactivated` and alerts the tenant admins", async () => {
        const before = (await rowOf(ORG_A))?.version;
        alerts.length = 0;
        const out = await route.put(
          tenantActor(ORG_A),
          { ...BASE, clinicKey: ROTATED_KEY },
          before,
        );
        expect(out.view).toMatchObject({
          status: "registered",
          lastTest: null,
          verifiedAt: null,
          activatedAt: null,
        });
        const row = await rowOf(ORG_A);
        expect(row).toMatchObject({
          status: "registered",
          verified_at: null,
          activated_at: null,
          last_test_outcome: null,
        });
        const deactivated = await eventsOf("m12.dosespot_config.deactivated", ORG_A);
        expect(deactivated.at(-1)?.payload).toMatchObject({
          cause: "credential_changed",
          environment: "sandbox",
        });
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          alertCode: "m12.dosespot_config.deactivated",
          organizationId: ORG_A,
        });
        expect(JSON.stringify(alerts)).not.toContain(ROTATED_KEY);
        const audit = (await auditRows(ORG_A, "m12.dosespot_clinic.changed")).at(-1);
        expect(audit?.context.changedFields).toEqual(["clinicKey"]);
        expect(JSON.stringify(audit)).not.toContain(ROTATED_KEY);
      });

      it("needs a fresh test and activation after a rotation, and a plain deactivation goes to `verified`", async () => {
        expect((await route.activate(tenantActor(ORG_A)).catch((e) => e)).code).toBe(
          "DOSESPOT_NOT_VERIFIED",
        );
        probeStatus = 200;
        await route.verify(tenantActor(ORG_A));
        await route.activate(tenantActor(ORG_A));
        const out = await route.deactivate(tenantActor(ORG_A));
        expect(out).toMatchObject({ status: "verified", activatedAt: null });
        expect(out.verifiedAt).not.toBeNull();
        expect(
          (await eventsOf("m12.dosespot_config.deactivated", ORG_A)).at(-1)?.payload,
        ).toMatchObject({ cause: "deactivated" });
        await route.activate(tenantActor(ORG_A)); // no new test owed
        expect((await rowOf(ORG_A))?.status).toBe("active");
      });

      it("a stale If-Match is a 412 and a missing one a 428; the tenant lane cannot introduce a Subscription-Key", async () => {
        expect(await errorCode(route.put(tenantActor(ORG_A), { ...BASE }, 1))).toBe(
          "VERSION_CONFLICT",
        );
        expect(await errorCode(route.put(tenantActor(ORG_A), { ...BASE }, undefined))).toBe(
          "IF_MATCH_REQUIRED",
        );
        const version = (await rowOf(ORG_A))?.version;
        const err = await route
          .put(tenantActor(ORG_A), { ...BASE, subscriptionKey: SUB_KEY }, version)
          .catch((e) => e);
        expect(err.details?.[0]?.code).toBe("DOSESPOT_SUBSCRIPTION_KEY_PLATFORM_ONLY");
      });

      it("production is refused (verify and activate) until the platform enables it; sandbox never needed a flag", async () => {
        const version = (await rowOf(ORG_A))?.version;
        // switching environment drops the key, so a production row starts as a draft
        await route.put(
          tenantActor(ORG_A),
          {
            environment: "production",
            clinicId: "clinic-live-1",
            serviceClinicianId: "900",
            clinicKey: CLINIC_KEY,
          },
          version,
        );
        expect(await errorCode(route.verify(tenantActor(ORG_A)))).toBe(
          "DOSESPOT_PRODUCTION_NOT_ENABLED",
        );
        platformEnv.DOSESPOT_PRODUCTION_ENABLED = "true";
        expect(await errorCode(route.verify(tenantActor(ORG_A)))).toBe(
          "DOSESPOT_PRODUCTION_URL_UNSET",
        );
        platformEnv.DOSESPOT_PRODUCTION_ENABLED = undefined;
        // back to sandbox for the rest of the suite
        const v2 = (await rowOf(ORG_A))?.version;
        await route.put(tenantActor(ORG_A), { ...BASE, clinicKey: CLINIC_KEY }, v2);
        probeStatus = 200;
        await route.verify(tenantActor(ORG_A));
        await route.activate(tenantActor(ORG_A));
        expect((await rowOf(ORG_A))?.status).toBe("active");
      });
    });

    // ── the layered resolver and the real adapter ─────────────────────────────────────────────────────
    describe("the layered resolver and the real adapter", () => {
      it("an active row is served with the tenant's OWN clinic credentials and the tenant's Subscription-Key fallback", async () => {
        fetchLog.length = 0;
        await client.getPrescriptionStatus(ORG_A, "501", "77");
        const mint = fetchLog.find((c) => c.url.endsWith("/connect/token"));
        expect(mint?.headers.Authorization).toBe(
          `Basic ${Buffer.from(`clinic-live-1:${CLINIC_KEY}`).toString("base64")}`,
        );
        expect(mint?.url.startsWith("https://my.staging.dosespot.com")).toBe(true); // the row's environment, never the env URL
        expect(fetchLog.some((c) => c.url.includes("env.dosespot.com"))).toBe(false);
      });

      it("a row that is NOT active is never served from the env map; an org with no row still is", async () => {
        await route.deactivate(tenantActor(ORG_A));
        fetchLog.length = 0;
        const denied = await client.getPrescriptionStatus(ORG_A, "501", "77").catch((e) => e);
        expect(denied.retryable).toBe(false);
        expect(fetchLog).toHaveLength(0); // ORG_A also has an env entry: it must NOT have served
        await client.getPrescriptionStatus(ORG_D, "501", "77");
        expect(fetchLog.some((c) => c.url.includes("env.dosespot.com"))).toBe(true);
        await route.activate(tenantActor(ORG_A));
      });

      it("a rotated key never reuses the old key's token", async () => {
        fetchLog.length = 0;
        await client.getPrescriptionStatus(ORG_A, "501", "77");
        await client.getPrescriptionStatus(ORG_A, "501", "77");
        expect(fetchLog.filter((c) => c.url.endsWith("/connect/token"))).toHaveLength(1); // cached per credential generation
        const version = (await rowOf(ORG_A))?.version;
        await route.put(tenantActor(ORG_A), { ...BASE, clinicKey: ROTATED_KEY }, version);
        probeStatus = 200;
        await route.verify(tenantActor(ORG_A));
        await route.activate(tenantActor(ORG_A));
        fetchLog.length = 0;
        await client.getPrescriptionStatus(ORG_A, "501", "77");
        const mint = fetchLog.find((c) => c.url.endsWith("/connect/token"));
        expect(mint?.headers.Authorization).toBe(
          `Basic ${Buffer.from(`clinic-live-1:${ROTATED_KEY}`).toString("base64")}`,
        );
      });
    });

    // ── the sign gate ────────────────────────────────────────────────────────────────────────────────
    describe("the sign gate reads the signing transaction", () => {
      const gate = createTransmissionGate({ envFallbackFor: async (org) => org === ORG_D });
      const decide = (org: string, member: string) =>
        withOrgContext(tenantPool.db, { organizationId: org, userId: "" }, (tx) =>
          gate(tx as unknown as DbClient, org, member),
        );
      const PRESCRIBER_MEMBERSHIP = "99000000-0000-4000-8000-000000000001";

      it("needs a LIVE registration AND a prescriber linked to DoseSpot", async () => {
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-000000000009','rx@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-000000000009',$2,'active') ON CONFLICT DO NOTHING",
          [PRESCRIBER_MEMBERSHIP, ORG_A],
        );
        // ORG_A is active, the prescriber is not on the roster yet
        expect(await decide(ORG_A, PRESCRIBER_MEMBERSHIP)).toBe(false);
        await admin.query(
          "INSERT INTO dosespot_prescriber (organization_id, membership_id, enrolled_at) VALUES ($1,$2,now())",
          [ORG_A, PRESCRIBER_MEMBERSHIP],
        );
        expect(await decide(ORG_A, PRESCRIBER_MEMBERSHIP)).toBe(false); // on the roster, not linked
        await admin.query(
          "UPDATE dosespot_prescriber SET dosespot_prescriber_id='700' WHERE membership_id=$1",
          [PRESCRIBER_MEMBERSHIP],
        );
        expect(await decide(ORG_A, PRESCRIBER_MEMBERSHIP)).toBe(true);
        await route.deactivate(tenantActor(ORG_A));
        expect(await decide(ORG_A, PRESCRIBER_MEMBERSHIP)).toBe(false); // not live: the env entry does not stand in for a row
        await route.activate(tenantActor(ORG_A));
        expect(await decide(ORG_A, PRESCRIBER_MEMBERSHIP)).toBe(true);
        await admin.query(
          "UPDATE dosespot_prescriber SET revoked_at=now() WHERE membership_id=$1",
          [PRESCRIBER_MEMBERSHIP],
        );
        expect(await decide(ORG_A, PRESCRIBER_MEMBERSHIP)).toBe(false);
      });

      it("an org with no row transmits only through the env fallback (and only for a linked prescriber)", async () => {
        const dMember = "99000000-0000-4000-8000-0000000000d1";
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-000000000009',$2,'active')",
          [dMember, ORG_D],
        );
        expect(await decide(ORG_D, dMember)).toBe(false); // env fallback, prescriber not linked
        await admin.query(
          "INSERT INTO dosespot_prescriber (organization_id, membership_id, dosespot_prescriber_id, enrolled_at) VALUES ($1,$2,'701',now())",
          [ORG_D, dMember],
        );
        expect(await decide(ORG_D, dMember)).toBe(true);
        expect(await decide(ORG_C, dMember)).toBe(false); // an org with neither a row nor an env entry
      });
    });

    // ── a prescriber's vendor enrolment ──────────────────────────────────────────────────────────────
    describe("a prescriber's vendor enrolment", () => {
      const M1 = "99000000-0000-4000-8000-0000000000a1";
      beforeAll(async () => {
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000a9','rx2@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000a9',$2,'active') ON CONFLICT DO NOTHING",
          [M1, ORG_A],
        );
      });
      const body = { npi: NPI, firstName: "Ada", lastName: "Lovelace" };

      it("is refused until the registration is verified or active (409 DOSESPOT_NOT_READY), and nothing is created", async () => {
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_C), M1, body))).toBe(
          "DOSESPOT_NOT_READY",
        );
        expect(
          await q("SELECT 1 FROM dosespot_prescriber WHERE organization_id=$1", [ORG_C]),
        ).toHaveLength(0);
      });

      it("creates the roster row, calls the vendor with NO transaction open, records the vendor id and publishes it", async () => {
        vendorCallsInsideTx = 0;
        enrollBehaviour = "ok";
        const out = await enrollment.enroll(tenantActor(ORG_A), M1, body);
        expect(out).toEqual({ membershipId: M1, enrolledWithDoseSpot: true });
        expect(vendorCallsInsideTx).toBe(0);
        const row = (await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [M1]))[0];
        expect(row).toMatchObject({ npi: NPI });
        expect(row?.dosespot_prescriber_id).toMatch(/^70\d$/);
        expect(row?.vendor_enrollment_requested_at).not.toBeNull();
        const events = await eventsOf("m12.prescriber_enrolled", ORG_A);
        expect(events.at(-1)?.payload).toEqual({
          membershipId: M1,
          dosespotPrescriberId: row?.dosespot_prescriber_id,
        });
        const audit = (await auditRows(ORG_A, "m12.dosespot_clinic.prescriber_enrolled")).at(-1);
        expect(audit?.context.changedFields).toEqual(["dosespotPrescriberId", "npi"]);
        expect(JSON.stringify(audit)).not.toContain(NPI);
      });

      it("is idempotent: a linked prescriber is not enrolled twice", async () => {
        const calls = fetchLog.length;
        await enrollment.enroll(tenantActor(ORG_A), M1, body);
        expect(fetchLog.slice(calls).filter((c) => c.url.endsWith("/api/clinicians"))).toHaveLength(
          0,
        );
      });

      it("a vendor refusal leaves the committed request marker and no vendor id", async () => {
        const M2 = "99000000-0000-4000-8000-0000000000a2";
        // one active membership per user per org: this prescriber is a different person
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000aa','rx2b@ds.test')`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000aa',$2,'active')",
          [M2, ORG_A],
        );
        enrollBehaviour = "rejected";
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), M2, body))).toBe(
          "DOSESPOT_ENROLLMENT_REJECTED",
        );
        const row = (await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [M2]))[0];
        expect(row?.dosespot_prescriber_id).toBeNull();
        expect(row?.vendor_enrollment_requested_at).not.toBeNull();
        enrollBehaviour = "ok";
      });
    });

    // ── the operator lane ────────────────────────────────────────────────────────────────────────────
    describe("the operator lane (M34 onboarding data) runs the same rules under the target org's scope", () => {
      beforeAll(async () => {
        // ORG_B's row from the RLS cases is superseded: the operator lane starts from a tenant with no registration.
        await admin.query("DELETE FROM dosespot_clinic_registration WHERE organization_id=$1", [
          ORG_B,
        ]);
      });

      it("registers, tests and activates a tenant that is onboarding; every success leaves an audit row naming operator, org and reason", async () => {
        platformEnv.DOSESPOT_SUBSCRIPTION_KEY_SANDBOX = "platform-sandbox-sub-key";
        const saved = await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE, clinicKey: CLINIC_KEY, subscriptionKey: SUB_KEY },
          REASON,
          undefined,
        );
        expect(saved.created).toBe(true);
        expect(JSON.stringify(saved)).not.toContain(CLINIC_KEY);
        expect(JSON.stringify(saved)).not.toContain(SUB_KEY);
        expect(await asTenant(ORG_B, "SELECT 1 FROM dosespot_clinic_registration")).toHaveLength(1);
        probeStatus = 200;
        const verified = await onboardingData.verifyDoseSpot(operator(), "ds-b", REASON);
        expect(verified).toMatchObject({ config: { status: "verified" }, test: { outcome: "ok" } });
        const mint = fetchLog.filter((c) => c.url.endsWith("/connect/token")).at(-1);
        expect(mint?.headers["Subscription-Key"]).toBe(SUB_KEY); // ops set the clinic's own Subscription-Key
        const active = await onboardingData.activateDoseSpot(operator(), "ds-b", REASON);
        expect(active).toMatchObject({ status: "active" });
        for (const event of [
          "m34.tenant_onboarding.dosespot_set",
          "m34.tenant_onboarding.dosespot_verified",
          "m34.tenant_onboarding.dosespot_activated",
        ]) {
          const rows = await auditRows(ORG_B, event);
          expect(rows.length, event).toBeGreaterThanOrEqual(1);
          expect(rows.at(-1)).toMatchObject({ actor_user_id: OPERATOR, outcome: "success" });
          expect(rows.at(-1)?.context.reason).toBe(REASON);
        }
        expect(await eventsOf("m12.dosespot_config.activated", ORG_B)).toHaveLength(1);
        expect(settled).toContain(ORG_B);
        // the row trigger attributes the write to the OPERATOR, not to a NULL actor
        const trig = await q(
          "SELECT actor_user_id FROM audit_event WHERE organization_id=$1 AND event_type='dosespot_clinic_registration.update' ORDER BY created_at DESC LIMIT 1",
          [ORG_B],
        );
        expect(trig[0]?.actor_user_id).toBe(OPERATOR);
      });

      it("the operator's read is masked and audited, and the roster lists only whether each prescriber is linked", async () => {
        const view = await onboardingData.getDoseSpot(operator(), "ds-b");
        expect(view).toMatchObject({ status: "active", hasSecret: true });
        expect(JSON.stringify(view)).not.toContain(CLINIC_KEY);
        expect(
          (await auditRows(ORG_B, "m34.tenant_onboarding.data_read")).length,
        ).toBeGreaterThanOrEqual(1);
        const roster = await onboardingData.listDoseSpotPrescribers(operator(), "ds-a");
        const dump = JSON.stringify(roster);
        expect(dump).not.toContain(NPI);
        expect(roster.items.length).toBeGreaterThan(0);
      });

      it("an operator enrols a prescriber on the tenant's behalf (the vendor call outside any transaction)", async () => {
        const M3 = "99000000-0000-4000-8000-0000000000b1";
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000b9','rx3@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000b9',$2,'active')",
          [M3, ORG_B],
        );
        vendorCallsInsideTx = 0;
        const out = await onboardingData.enrollDoseSpotPrescriber(
          operator(),
          "ds-b",
          M3,
          { npi: NPI, firstName: "Grace", lastName: "Hopper" },
          REASON,
        );
        expect(out).toEqual({ membershipId: M3, enrolledWithDoseSpot: true });
        expect(vendorCallsInsideTx).toBe(0);
        expect(
          (
            await q(
              "SELECT dosespot_prescriber_id FROM dosespot_prescriber WHERE membership_id=$1",
              [M3],
            )
          )[0]?.dosespot_prescriber_id,
        ).toMatch(/^70\d$/);
        expect(
          (await auditRows(ORG_B, "m34.tenant_onboarding.dosespot_prescriber_enrolled")).length,
        ).toBe(1);
      });

      it("an active tenant is closed to the operator (409 TENANT_NOT_ONBOARDING, audited, nothing written) but a deactivation is allowed", async () => {
        await admin.query(
          "UPDATE tenant_account SET status='onboarding' WHERE organization_id=$1",
          [ORG_C],
        );
        await onboardingData.putDoseSpot(
          operator(),
          "ds-c",
          { ...BASE, clinicKey: CLINIC_KEY },
          REASON,
          undefined,
        );
        probeStatus = 200;
        await onboardingData.verifyDoseSpot(operator(), "ds-c", REASON);
        await onboardingData.activateDoseSpot(operator(), "ds-c", REASON);
        await admin.query("UPDATE tenant_account SET status='active' WHERE organization_id=$1", [
          ORG_C,
        ]);
        const before = await rowOf(ORG_C);
        expect(
          await errorCode(
            onboardingData.putDoseSpot(
              operator(),
              "ds-c",
              { ...BASE, clinicKey: ROTATED_KEY },
              REASON,
              before?.version,
            ),
          ),
        ).toBe("TENANT_NOT_ONBOARDING");
        expect(await errorCode(onboardingData.activateDoseSpot(operator(), "ds-c", REASON))).toBe(
          "TENANT_NOT_ONBOARDING",
        );
        expect((await rowOf(ORG_C))?.version).toBe(before?.version);
        expect(
          (await auditRows(ORG_C, "m34.tenant_onboarding.write_refused")).length,
        ).toBeGreaterThanOrEqual(2);
        // the safety down-shift is not status-gated
        alerts.length = 0;
        const out = await onboardingData.deactivateDoseSpot(operator(), "ds-c", REASON);
        expect(out).toMatchObject({ status: "verified" });
        expect(alerts.filter((a) => a.organizationId === ORG_C)).toHaveLength(1);
      });

      it("an unknown slug is a 404 and an operator never reaches another tenant's registration through a slug", async () => {
        expect(await errorCode(onboardingData.getDoseSpot(operator(), "no-such-tenant"))).toBe(
          "NOT_FOUND",
        );
        const a = await rowOf(ORG_A);
        await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE, serviceClinicianId: "901" },
          REASON,
          (await rowOf(ORG_B))?.version,
        );
        expect((await rowOf(ORG_A))?.version).toBe(a?.version);
      });

      it("the permission keys migration 1383 binds are on the platform_ops role row, and on the tenant org-wide admin roles only", async () => {
        // A fresh database has no platform-owned `platform_ops` row yet (an operator creates it); migration 1383 binds the keys to it
        // WHERE IT EXISTS. Create the row, then re-run the migration's own idempotent binding, as a deploy over a live row does.
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES (NULL,'platform_ops','Platform ops','platform_staff',true) ON CONFLICT DO NOTHING",
        );
        await admin.query(
          readFileSync(join(MIGRATIONS_DIR, "1383_m12_tenant_dosespot_permissions.sql"), "utf8"),
        );
        const platformOps = await q<{ permission_key: string }>(
          "SELECT rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.organization_id IS NULL AND r.key='platform_ops'",
        );
        const keys = platformOps.map((r) => r.permission_key);
        expect(keys).toContain("tenant_dosespot.read_platform");
        expect(keys).toContain("tenant_dosespot.write_platform");
        expect(keys).not.toContain("prescribing.clinic.admin"); // the tenant keys are not an operator's
        const tenantHolders = await q<{ key: string }>(
          "SELECT DISTINCT r.key FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE rp.permission_key IN ('prescribing.clinic.read','prescribing.clinic.admin')",
        );
        for (const holder of tenantHolders)
          expect(["org_admin", "administrator"]).toContain(holder.key);
        const catalog = await q<{ key: string }>(
          "SELECT key FROM permission WHERE key IN ('prescribing.clinic.read','prescribing.clinic.admin','tenant_dosespot.read_platform','tenant_dosespot.write_platform')",
        );
        expect(catalog).toHaveLength(4);
      });
    });

    // ── the wizard fact ──────────────────────────────────────────────────────────────────────────────
    describe("wizard step 10 settles from the registration", () => {
      const readerFor = buildDoseSpotSettledReader;
      const advancer = () =>
        createOnboardingAdvancer({
          db: tenantPool.db,
          outbox: { publish: async () => undefined } as never,
          facts: { dosespotSettled: readerFor(tenantPool.db) },
          alerts: { emit: async () => undefined } as never,
        });
      const taskStatus = async (org: string) =>
        (
          await q<{ status: string }>(
            "SELECT status FROM onboarding_task WHERE organization_id=$1 AND template_key='dosespot_kickoff_initiated'",
            [org],
          )
        )[0]?.status;

      it("the migration-seeded precondition is `context.dosespotSettled == true`, a step a human may still attest", async () => {
        const [tpl] = await q<{
          precondition_dsl: string;
          completion_mode: string;
          canonical_order: number;
        }>(
          "SELECT precondition_dsl, completion_mode, canonical_order FROM onboarding_task_template WHERE key='dosespot_kickoff_initiated'",
        );
        expect(tpl).toMatchObject({
          precondition_dsl: "context.dosespotSettled == true",
          completion_mode: "either",
          canonical_order: 10,
        });
      });

      it("the advance pass settles the step when the registration is active, and not before", async () => {
        await admin.query(
          `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status, due_at)
         SELECT $1, $2, t.key, 'pending', now() FROM onboarding_task_template t WHERE t.retired_at IS NULL
         ON CONFLICT DO NOTHING`,
          [ORG_A, accountOf[ORG_A]],
        );
        // the walk stops at the first unsettled attestation step: settle steps 1-9 so it reaches step 10
        await admin.query(
          `UPDATE onboarding_task SET status='done', completed_at=now() WHERE organization_id=$1 AND template_key IN
             (SELECT key FROM onboarding_task_template WHERE canonical_order < 10 AND retired_at IS NULL)`,
          [ORG_A],
        );
        await route.deactivate(tenantActor(ORG_A));
        await advancer()({ tenantAccountId: accountOf[ORG_A] as string, orgId: ORG_A });
        expect(await taskStatus(ORG_A)).toBe("pending");
        await route.activate(tenantActor(ORG_A));
        expect(await readerFor(tenantPool.db)(ORG_A)).toBe(true);
        await advancer()({ tenantAccountId: accountOf[ORG_A] as string, orgId: ORG_A });
        expect(await taskStatus(ORG_A)).toBe("done");
      });

      it("an org with no registration row never has the fact", async () => {
        expect(await readerFor(tenantPool.db)(ORG_D)).toBe(false);
      });

      it("the prescriber count does not gate: the fact is true with no prescriber enrolled", async () => {
        expect(
          await q("SELECT 1 FROM dosespot_prescriber WHERE organization_id=$1", [ORG_C]),
        ).toHaveLength(0);
        probeStatus = 200;
        await route.verify(tenantActor(ORG_C));
        await route.activate(tenantActor(ORG_C));
        expect(await readerFor(tenantPool.db)(ORG_C)).toBe(true);
      });
    });
  },
);
