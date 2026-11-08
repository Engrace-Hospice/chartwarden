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
 *     registration is `active`;
 *   - the enrolment claim on the real row lock and unique index (two concurrent enrolments: one vendor call, the loser a 409), the
 *     own-marker release, a revoked or suspended member never enrolled or linked;
 *   - migration 1383 over real org-admin / administrator / clinical / platform-level role rows;
 *   - the operator port's `assertTxScopedToOrg` guard, and a slug never reaching another tenant's registration or roster;
 *   - `DOSESPOT_SANDBOX_ENABLED`: an active sandbox row stops being live with the flag off, and activation is refused;
 *   - every vendor request of the suite (token mint, clinician add) ran with no transaction open (per async call chain).
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
import { createMdmEntityProvider } from "@chartwarden/mdm";
import { __resetModule34SeamsForTest } from "@chartwarden/saas-tenant-platform";
import { registerPlatformJob, withOrgContext } from "@chartwarden/tenancy";
import { Value } from "@sinclair/typebox/value";
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
import { createDbDoseSpotBackend } from "../src/modules/12-dosespot/dosespot-route-service-db";
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
  createPractitionerLinkService,
  createPractitionerProfileSource,
  createPrescriberEnrollmentService,
  createTransmissionGate,
} from "../src/modules/12-dosespot/index";
import { isValidNpi } from "../src/modules/12-dosespot/tenant-config/practitioner-profile";
import { EnrollPrescriberVendorBodySchema } from "../src/modules/12-dosespot/tenant-config/typebox";
import {
  createDrizzleM29PublishedSeamStore,
  createNppesProviderReader,
} from "../src/modules/29-external-interfaces/seams/index";
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
import { createDbMdmStore } from "../src/modules/40-mdm/index";
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
    let enrollBehaviour: "ok" | "rejected" | "no_id" = "ok";
    let enrollDelayMs = 0;
    // EVERY vendor request (token mint, clinician add) that is made while a transaction on the tenant pool is open is
    // counted here; the final case asserts it never happened. `tdb` is the tenant pool with its `transaction` counted.
    // The flag follows the async call chain (AsyncLocalStorage), so a vendor call made by one concurrent request is not blamed on a
    // transaction another request holds open.
    let vendorCallsInsideTx = 0;
    let txOpen = 0;
    const inTransaction = new AsyncLocalStorage<boolean>();
    const vendorTraffic = { tokenMints: 0, clinicianAdds: 0 };
    let tdb: typeof tenantPool.db;
    const countingDb = (db: typeof tenantPool.db): typeof tenantPool.db =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === "transaction") {
            return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
              (target as any).transaction(
                async (tx: unknown) => {
                  txOpen += 1;
                  try {
                    return await inTransaction.run(true, () => fn(tx));
                  } finally {
                    txOpen -= 1;
                  }
                },
                ...rest,
              );
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    let vendorSeq = 700;

    const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) =>
      (await admin.query(text, params)).rows as T[];

    const fakeFetch: DoseSpotFetch = async (url, init) => {
      if (inTransaction.getStore() === true) vendorCallsInsideTx += 1;
      if (url.endsWith("/connect/token")) vendorTraffic.tokenMints += 1;
      if (url.endsWith("/api/clinicians")) vendorTraffic.clinicianAdds += 1;
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
        if (enrollDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, enrollDelayMs));
        if (enrollBehaviour === "no_id") return { status: 200, text: async () => "{}" };
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

    // ── practitioner records: the roster-linked M40 physician (NPPES-sourced) and NPPES's own row ──────────────────────────
    interface SeededPhysician {
      readonly id: string;
      readonly npi: string | null;
      readonly firstName: string;
      readonly lastName: string;
    }
    const physicianOfMember = new Map<string, SeededPhysician>();
    let physicianSeq = 0;
    /** A synthetic NPI that passes the check digit (never a real provider's: the 9-digit base is a fixed invented prefix). */
    const syntheticNpi = (n: number): string => {
      const base = `19${String(n).padStart(7, "0")}`;
      const digit = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => isValidNpi(`${base}${d}`));
      return `${base}${digit}`;
    };
    const INVENTED_NAMES: ReadonlyArray<readonly [string, string]> = [
      ["Tamsin", "Wexford"],
      ["Orrin", "Delacroix-Voss"],
      ["Priya", "Nandakumar"],
      ["Basil", "Quillfeather"],
      ["Marisol", "Thorne"],
      ["Ignatius", "Pemberton"],
      ["Odalys", "Brightwater"],
      ["Ferris", "Caldecott"],
    ];
    /**
     * An M40 canonical physician record with a fresh synthetic NPI and invented name. `nppes` says what NPPES's public directory
     * holds for the NPI: its matching row (default), no row, or a row that contradicts the record.
     */
    async function seedPhysician(
      opts: {
        npi?: string | null;
        status?: string;
        nppes?: "match" | "none" | "other_surname" | "organization" | "deactivated";
      } = {},
    ): Promise<SeededPhysician> {
      const n = ++physicianSeq;
      const [firstName, lastName] = INVENTED_NAMES[n % INVENTED_NAMES.length] as readonly [
        string,
        string,
      ];
      const npi = opts.npi === undefined ? syntheticNpi(n) : opts.npi;
      const id = `77000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
      await admin.query(
        "INSERT INTO external_physician (id, npi, first_name, last_name, status) VALUES ($1,$2,$3,$4,$5::mdm_entity_status)",
        [id, npi, firstName, lastName, opts.status ?? "active"],
      );
      const nppes = opts.nppes ?? "match";
      if (npi !== null && nppes !== "none") {
        await admin.query(
          "INSERT INTO nppes_provider (npi, enumeration_type, status, basic) VALUES ($1,$2::nppes_enumeration_type,$3::nppes_provider_status,$4::jsonb)",
          [
            npi,
            nppes === "organization" ? "NPI-2" : "NPI-1",
            nppes === "deactivated" ? "deactivated" : "active",
            JSON.stringify({
              firstName: firstName.toUpperCase(),
              lastName: (nppes === "other_surname" ? "NOTTHESAMEPERSON" : lastName)
                .replace(/[^A-Za-z]/g, "")
                .toUpperCase(),
            }),
          ],
        );
      }
      return { id, npi, firstName, lastName };
    }
    /** One statement on the admin connection with `app.user_id` declared as `userId` for its transaction (what `withOrgContext` does). */
    async function asDeclaredUser(userId: string, text: string, params: unknown[] = []) {
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        await admin.query(text, params);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
    /**
     * Put `membershipId` on `org`'s roster, linked to a fresh practitioner record (what the roster `enroll` route does). By default the
     * PRESCRIBER has already confirmed the link (the state an enrolment needs, written directly so the enrolment cases stay about
     * enrolment); `confirmed: false` leaves it as a roster administrator left it. The real confirmation path has its own cases.
     */
    async function rosterWithPhysician(
      org: string,
      membershipId: string,
      physician?: SeededPhysician,
      opts: { confirmed?: boolean } = {},
    ): Promise<SeededPhysician> {
      const linked = physician ?? (await seedPhysician());
      await admin.query(
        "INSERT INTO dosespot_prescriber (organization_id, membership_id, external_physician_mdm_id, enrolled_at) VALUES ($1,$2,$3,now())",
        [org, membershipId, linked.id],
      );
      if (opts.confirmed !== false && linked.npi !== null) {
        // the trigger wants the declared actor to be the member's own user, whoever writes: so the seed declares it
        const userId = (await q("SELECT user_id FROM membership WHERE id=$1", [membershipId]))[0]
          ?.user_id as string;
        await asDeclaredUser(
          userId,
          `UPDATE dosespot_prescriber SET link_confirmed_mdm_id=$2, link_confirmed_npi=$3, link_confirmed_at=now(),
             link_confirmed_by_membership_id=membership_id WHERE membership_id=$1`,
          [membershipId, linked.id, linked.npi],
        );
      }
      physicianOfMember.set(membershipId, linked);
      return linked;
    }

    let service: ReturnType<typeof createDoseSpotClinicService>;
    let route: ReturnType<typeof buildDrizzleDoseSpotClinicRouteService>;
    let enrollment: ReturnType<typeof createPrescriberEnrollmentService>;
    let linkService: ReturnType<typeof createPractitionerLinkService>;
    let onboardingData: ReturnType<typeof buildDrizzleOnboardingDataService>;
    let dosespotPort: ReturnType<typeof buildDoseSpotClinicOnboardingPort>;
    let mdmDirectoryForList: ReturnType<typeof createMdmEntityProvider>;
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
      platformEnv.DOSESPOT_SANDBOX_ENABLED = "true"; // the platform enables sandbox registrations to go live (the flag has its own cases below)
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
      tdb = countingDb(tenantPool.db);
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
        db: tdb,
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
        db: tdb,
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
          source: createDrizzleTenantConfigSource({ db: tdb, cipher, platformEnv }),
          fallback: envConfig,
        }),
        fetch: fakeFetch,
        sleep: async () => undefined,
      });
      enrollment = createPrescriberEnrollmentService({
        inTx: (organizationId, userId, fn) =>
          withOrgContext(tdb, { organizationId, userId }, (tx) =>
            fn(createDrizzleRosterStore(tx as unknown as DbClient), tx as unknown as DbClient),
          ),
        client,
        // WHO the prescriber is: the REAL M40 provider (the NPPES-sourced physician record the roster links the member to) and the REAL
        // M29 NPPES reader (the public directory), both over the tenant pool as in production.
        profiles: createPractitionerProfileSource({
          directory: createMdmEntityProvider(createDbMdmStore(tdb)),
          nppes: createNppesProviderReader(createDrizzleM29PublishedSeamStore(tdb)),
        }),
        outbox,
        audit: buildClinicAuditPort(),
        afterWrite,
        warn: (fields, message) => warnings.push(`${message} ${JSON.stringify(fields)}`),
      });
      // the prescriber's OWN confirmation of the linked record, over the same real M40 provider and NPPES reader
      const mdmDirectory = createMdmEntityProvider(createDbMdmStore(tdb));
      mdmDirectoryForList = mdmDirectory;
      linkService = createPractitionerLinkService({
        inTx: (organizationId, userId, fn) =>
          withOrgContext(tdb, { organizationId, userId }, (tx) =>
            fn(createDrizzleRosterStore(tx as unknown as DbClient), tx as unknown as DbClient),
          ),
        directory: mdmDirectory,
        profiles: createPractitionerProfileSource({
          directory: mdmDirectory,
          nppes: createNppesProviderReader(createDrizzleM29PublishedSeamStore(tdb)),
        }),
        audit: buildClinicAuditPort(),
      });
      registerPlatformJob(JOB_ID);
      dosespotPort = buildDoseSpotClinicOnboardingPort({
        db: tdb,
        service,
        outbox,
        enrollment,
        directory: mdmDirectory,
        alerts: alertPort,
      });
      onboardingData = buildDrizzleOnboardingDataService({
        db: tdb,
        advance: async (tenant) => {
          advanced.push(tenant);
        },
        warn: (message) => warnings.push(message),
        resolveTenant: buildPlatformTenantResolver({
          platformDb: platformPool.db,
          auditBypass: m34PlatformBypassAuditor,
          platformJobId: JOB_ID,
        }),
        dosespot: dosespotPort,
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
      const gate = createTransmissionGate({
        platformEnv,
        envFallbackFor: async (org) => org === ORG_D,
      });
      const decide = (org: string, member: string) =>
        withOrgContext(tdb, { organizationId: org, userId: "" }, (tx) =>
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
      let physician1: SeededPhysician;
      beforeAll(async () => {
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000a9','rx2@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000a9',$2,'active') ON CONFLICT DO NOTHING",
          [M1, ORG_A],
        );
        physician1 = await rosterWithPhysician(ORG_A, M1); // on the roster, linked to an NPPES-sourced practitioner record
      });
      const clinicianCalls = () => fetchLog.filter((c) => c.url.endsWith("/api/clinicians")).length;

      it("is refused until the registration is verified or active (409 DOSESPOT_NOT_READY), and nothing is created", async () => {
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_C), M1))).toBe(
          "DOSESPOT_NOT_READY",
        );
        expect(
          await q(
            "SELECT 1 FROM dosespot_prescriber WHERE organization_id=$1 AND revoked_at IS NULL",
            [ORG_C],
          ),
        ).toHaveLength(0);
      });

      it("a typed NPI, first name or last name is rejected by the request schema: identity is never taken from the caller", () => {
        expect(Value.Check(EnrollPrescriberVendorBodySchema, {})).toBe(true);
        for (const typed of [
          { npi: "1234567893" },
          { firstName: "Tamsin" },
          { lastName: "Wexford" },
          { npi: "1234567893", firstName: "Tamsin", lastName: "Wexford" },
        ]) {
          expect(Value.Check(EnrollPrescriberVendorBodySchema, typed)).toBe(false);
        }
      });

      it("calls the vendor with NO transaction open, with the PROFILE's NPI and name, records the vendor id and publishes it", async () => {
        enrollBehaviour = "ok";
        const out = await enrollment.enroll(tenantActor(ORG_A), M1);
        expect(out).toEqual({ membershipId: M1, enrolledWithDoseSpot: true });
        expect(vendorCallsInsideTx).toBe(0);
        // the vendor was told the practitioner record's NPI and legal name (nothing in the call came from the caller)
        const sent = fetchLog.filter((c) => c.url.endsWith("/api/clinicians")).at(-1)?.body ?? "";
        expect(sent).toContain(physician1.npi as string);
        expect(sent).toContain(physician1.firstName);
        expect(sent).toContain(physician1.lastName);
        const row = (await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [M1]))[0];
        expect(row?.npi).toBe(physician1.npi); // the profile's NPI is the one recorded
        expect(row?.dosespot_prescriber_id).toMatch(/^7\d{2}$/);
        expect(row?.vendor_enrollment_requested_at).not.toBeNull();
        const events = await eventsOf("m12.prescriber_enrolled", ORG_A);
        expect(events.at(-1)?.payload).toEqual({
          membershipId: M1,
          dosespotPrescriberId: row?.dosespot_prescriber_id,
        });
        const audit = (await auditRows(ORG_A, "m12.dosespot_clinic.prescriber_enrolled")).at(-1);
        expect(audit?.context.changedFields).toEqual(["dosespotPrescriberId", "npi"]);
        expect(audit?.context.nppesVerified).toBe(true); // NPPES's row agreed with the record
        expect(JSON.stringify(audit)).not.toContain(physician1.npi as string);
      });

      it("never reinstates a revoked prescriber, and refuses a membership that is not in this organization", async () => {
        const MR = "99000000-0000-4000-8000-0000000000a3";
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000ab','rx2c@ds.test')`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000ab',$2,'active')",
          [MR, ORG_A],
        );
        await admin.query(
          "INSERT INTO dosespot_prescriber (organization_id, membership_id, dosespot_prescriber_id, enrolled_at, revoked_at) VALUES ($1,$2,'778',now(),now())",
          [ORG_A, MR],
        );
        const calls = fetchLog.length;
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), MR))).toBe(
          "DOSESPOT_PRESCRIBER_REVOKED",
        );
        expect(
          (await q("SELECT revoked_at FROM dosespot_prescriber WHERE membership_id=$1", [MR]))[0]
            ?.revoked_at,
        ).not.toBeNull();
        // a membership of ANOTHER organization is not found under this org's scope (the FK alone is not tenant-scoped)
        const FOREIGN = "99000000-0000-4000-8000-0000000000f1";
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000ac','rx2d@ds.test')`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000ac',$2,'active')",
          [FOREIGN, ORG_B],
        );
        const before = (await q("SELECT count(*)::int AS n FROM dosespot_prescriber"))[0]?.n;
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), FOREIGN))).toBe("NOT_FOUND");
        expect((await q("SELECT count(*)::int AS n FROM dosespot_prescriber"))[0]?.n).toBe(before);
        expect(fetchLog.slice(calls).filter((c) => c.url.endsWith("/api/clinicians"))).toHaveLength(
          0,
        );
      });

      it("is idempotent: a linked prescriber is not enrolled twice", async () => {
        const calls = fetchLog.length;
        await enrollment.enroll(tenantActor(ORG_A), M1);
        expect(fetchLog.slice(calls).filter((c) => c.url.endsWith("/api/clinicians"))).toHaveLength(
          0,
        );
      });

      it("a vendor refusal releases the request claim and records no vendor id", async () => {
        const M2 = "99000000-0000-4000-8000-0000000000a2";
        // one active membership per user per org: this prescriber is a different person
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000aa','rx2b@ds.test')`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000aa',$2,'active')",
          [M2, ORG_A],
        );
        await rosterWithPhysician(ORG_A, M2);
        enrollBehaviour = "rejected";
        const refused = await errorCode(enrollment.enroll(tenantActor(ORG_A), M2));
        enrollBehaviour = "ok"; // reset before asserting, so a failure here cannot cascade into later cases
        expect(refused).toBe("DOSESPOT_ENROLLMENT_REJECTED");
        const row = (await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [M2]))[0];
        expect(row?.dosespot_prescriber_id).toBeNull();
        // the claim is released on a vendor failure: a corrected retry need not wait out the window
        expect(row?.vendor_enrollment_requested_at).toBeNull();
        enrollBehaviour = "ok";
      });

      // ── who the prescriber is: derived from the roster-linked practitioner record, cross-checked against NPPES ──────────────
      let memberSeq = 0;
      /** A fresh member of ORG_A (one active membership per user per org); `onRoster` links them to a fresh practitioner record. */
      const newMember = async (
        opts: { onRoster?: boolean; status?: string; confirmed?: boolean } = {},
      ) => {
        const n = ++memberSeq;
        const suffix = n.toString(16).padStart(2, "0");
        const userId = `99000000-0000-4000-8000-0000000001${suffix}`;
        const membershipId = `99000000-0000-4000-8000-0000000002${suffix}`;
        await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
          userId,
          `claim${n}@ds.test`,
        ]);
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,$4)",
          [membershipId, userId, ORG_A, opts.status ?? "active"],
        );
        if (opts.onRoster) {
          await rosterWithPhysician(
            ORG_A,
            membershipId,
            undefined,
            opts.confirmed === undefined ? {} : { confirmed: opts.confirmed },
          );
        }
        return membershipId;
      };
      /** `ORG_A`'s roster row for a fresh member, linked to `physician` (or to nothing). */
      const memberOf = async (physician: SeededPhysician | null) => {
        const member = await newMember();
        if (physician) {
          await rosterWithPhysician(ORG_A, member, physician);
        } else {
          await admin.query(
            "INSERT INTO dosespot_prescriber (organization_id, membership_id, enrolled_at) VALUES ($1,$2,now())",
            [ORG_A, member],
          );
        }
        return member;
      };
      /** Enrolment refused with `code`: no vendor call, and the roster row neither claimed nor linked. */
      const expectRefused = async (member: string, code: string) => {
        const calls = clinicianCalls();
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), member))).toBe(code);
        expect(clinicianCalls()).toBe(calls);
        const row = (
          await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [member])
        )[0];
        expect(row?.vendor_enrollment_requested_at ?? null).toBeNull();
        expect(row?.dosespot_prescriber_id ?? null).toBeNull();
      };

      it("a member who is not on the roster has no practitioner record to derive from: 409, and no roster row is created", async () => {
        const member = await newMember();
        const calls = clinicianCalls();
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), member))).toBe(
          "DOSESPOT_PRACTITIONER_NOT_LINKED",
        );
        expect(clinicianCalls()).toBe(calls);
        expect(
          await q("SELECT 1 FROM dosespot_prescriber WHERE membership_id=$1", [member]),
        ).toHaveLength(0);
      });

      it("a roster row that links no physician record is refused the same way", async () => {
        await expectRefused(await memberOf(null), "DOSESPOT_PRACTITIONER_NOT_LINKED");
      });

      it("a linked record with no NPI on file is refused (409), and one with an invalid NPI is refused (422)", async () => {
        await expectRefused(
          await memberOf(await seedPhysician({ npi: null })),
          "DOSESPOT_PRACTITIONER_NPI_MISSING",
        );
        await expectRefused(
          await memberOf(await seedPhysician({ npi: "1234567890", nppes: "none" })),
          "DOSESPOT_NPI_INVALID",
        );
      });

      it("a linked record that is not active (deactivated, provisional) is refused", async () => {
        for (const status of ["deactivated", "provisional"]) {
          await expectRefused(
            await memberOf(await seedPhysician({ status })),
            "DOSESPOT_PRACTITIONER_NOT_ACTIVE",
          );
        }
      });

      it("an NPI that NPPES contradicts is refused: another surname, an organization (NPI-2), a deactivated provider", async () => {
        for (const nppes of ["other_surname", "organization", "deactivated"] as const) {
          await expectRefused(
            await memberOf(await seedPhysician({ nppes })),
            "DOSESPOT_NPPES_MISMATCH",
          );
        }
      });

      it("NPPES with no row for the NPI: a sandbox registration proceeds FLAGGED, a production one is refused", async () => {
        const unlisted = await seedPhysician({ nppes: "none" });
        const production = await memberOf(await seedPhysician({ nppes: "none" }));
        await admin.query(
          "UPDATE dosespot_clinic_registration SET environment='production' WHERE organization_id=$1",
          [ORG_A],
        );
        try {
          await expectRefused(production, "DOSESPOT_NPPES_UNVERIFIED");
        } finally {
          await admin.query(
            "UPDATE dosespot_clinic_registration SET environment='sandbox' WHERE organization_id=$1",
            [ORG_A],
          );
        }
        const member = await memberOf(unlisted);
        expect(await enrollment.enroll(tenantActor(ORG_A), member)).toMatchObject({
          enrolledWithDoseSpot: true,
        });
        const audit = (await auditRows(ORG_A, "m12.dosespot_clinic.prescriber_enrolled")).at(-1);
        expect(audit?.context.nppesVerified).toBe(false); // linked, but NPPES had not confirmed the NPI
      });

      it("a roster re-link between deriving the profile and claiming the row is refused at the row lock (409 DOSESPOT_ROSTER_CHANGED)", async () => {
        const member = await newMember({ onRoster: true });
        const other = await seedPhysician();
        const code = await errorCode(
          inOrgA((store) =>
            store.ensureRequested(ORG_A, member, new Date(), 5 * 60_000, {
              physicianMdmId: other.id,
              confirmedNpi: other.npi as string,
            }),
          ),
        );
        expect(code).toBe("DOSESPOT_ROSTER_CHANGED"); // the profile belonged to `other`, the row now links someone else
        expect(
          (
            await q(
              "SELECT vendor_enrollment_requested_at AS at FROM dosespot_prescriber WHERE membership_id=$1",
              [member],
            )
          )[0]?.at,
        ).toBeNull();
      });

      // ── the claim, the release and the record, on the real row locks ──────────────────────────────
      /**
       * Open several pooled connections BEFORE a race: a cold pool makes the second request wait for a new connection while the first
       * runs to completion, which serialises the two and proves nothing about the row lock.
       */
      const warmPool = async (connections = 4) => {
        await Promise.all(
          Array.from({ length: connections }, () => tdb.execute(sql`SELECT pg_sleep(0.1)`)),
        );
      };
      const inOrgA = <T>(fn: (store: ReturnType<typeof createDrizzleRosterStore>) => Promise<T>) =>
        withOrgContext(tdb, { organizationId: ORG_A, userId: TENANT_ADMIN }, (tx) =>
          fn(createDrizzleRosterStore(tx as unknown as DbClient)),
        );

      it("a suspended or revoked membership is not enrolled with the vendor (404): nothing is created and nothing is sent", async () => {
        const calls = clinicianCalls();
        for (const status of ["suspended", "revoked"]) {
          const member = await newMember({ status });
          expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), member))).toBe("NOT_FOUND");
          expect(
            await q("SELECT 1 FROM dosespot_prescriber WHERE membership_id=$1", [member]),
          ).toHaveLength(0);
        }
        expect(clinicianCalls()).toBe(calls);
      });

      it("two concurrent enrolments of a rostered prescriber: the row lock lets one reach the vendor, the other is 409 IN_PROGRESS", async () => {
        const member = await newMember({ onRoster: true });
        const calls = clinicianCalls();
        enrollDelayMs = 300; // the winner is still inside the vendor call when the loser claims
        await warmPool();
        let outcomes: PromiseSettledResult<unknown>[];
        try {
          outcomes = await Promise.allSettled([
            enrollment.enroll(tenantActor(ORG_A), member),
            enrollment.enroll(tenantActor(ORG_A), member),
          ]);
        } finally {
          enrollDelayMs = 0;
        }
        const refused = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect((refused[0]?.reason as { code?: string }).code).toBe(
          "DOSESPOT_ENROLLMENT_IN_PROGRESS",
        );
        expect(clinicianCalls() - calls).toBe(1); // ONE vendor clinician, not two
        expect(
          (
            await q(
              "SELECT dosespot_prescriber_id FROM dosespot_prescriber WHERE membership_id=$1",
              [member],
            )
          )[0]?.dosespot_prescriber_id,
        ).toMatch(/^7\d{2}$/);
      });

      it("two concurrent enrolments of a member who is NOT on the roster are both refused (409): the roster is the only way in", async () => {
        const member = await newMember();
        const calls = clinicianCalls();
        await warmPool();
        const outcomes = await Promise.allSettled([
          enrollment.enroll(tenantActor(ORG_A), member),
          enrollment.enroll(tenantActor(ORG_A), member),
        ]);
        expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
        for (const o of outcomes as PromiseRejectedResult[]) {
          expect((o.reason as { code?: string }).code).toBe("DOSESPOT_PRACTITIONER_NOT_LINKED");
        }
        expect(clinicianCalls()).toBe(calls);
        expect(
          await q("SELECT 1 FROM dosespot_prescriber WHERE membership_id=$1", [member]),
        ).toHaveLength(0);
      });

      it("the claim is released only by the attempt that made it: a vendor refusal never clears a newer claim", async () => {
        const member = await newMember({ onRoster: true });
        const linkedTo = {
          physicianMdmId: physicianOfMember.get(member)?.id as string,
          confirmedNpi: physicianOfMember.get(member)?.npi as string,
        };
        const marker = async () =>
          (
            await q(
              "SELECT vendor_enrollment_requested_at AS at FROM dosespot_prescriber WHERE membership_id=$1",
              [member],
            )
          )[0]?.at as Date | null;
        // at the store: a release naming a DIFFERENT claim leaves the marker; the claim's own release clears it
        const at = new Date(Date.now() - 1_000);
        const claim = await inOrgA((store) =>
          store.ensureRequested(ORG_A, member, at, 5 * 60_000, linkedTo),
        );
        expect(claim.inProgress).toBe(false);
        await inOrgA((store) => store.releaseRequest(ORG_A, member, new Date(at.getTime() + 5)));
        expect((await marker())?.getTime()).toBe(at.getTime());
        await inOrgA((store) => store.releaseRequest(ORG_A, member, at));
        expect(await marker()).toBeNull();
        // through the real flow: attempt 1 claims, another administrator re-stamps the marker (the first claim aged out), then
        // attempt 1's vendor call is REFUSED: its release is conditional on its own marker, so the newer claim stands
        const plan = await enrollment.prepare(tenantActor(ORG_A), member);
        expect(plan.claimedAt).not.toBeNull();
        const restamped = new Date(Date.now() + 60_000);
        await admin.query(
          "UPDATE dosespot_prescriber SET vendor_enrollment_requested_at=$2 WHERE membership_id=$1",
          [member, restamped],
        );
        enrollBehaviour = "rejected";
        const refused = await errorCode(enrollment.callVendor(plan));
        enrollBehaviour = "ok";
        expect(refused).toBe("DOSESPOT_ENROLLMENT_REJECTED");
        expect((await marker())?.getTime()).toBe(restamped.getTime());
      });

      it("a prescriber re-linked to ANOTHER physician while the vendor call was in flight is never linked (409): the NPI sent was not theirs now", async () => {
        const member = await newMember({ onRoster: true });
        const published = (await eventsOf("m12.prescriber_enrolled", ORG_A)).length;
        const plan = await enrollment.prepare(tenantActor(ORG_A), member);
        const other = await seedPhysician();
        await admin.query(
          "UPDATE dosespot_prescriber SET external_physician_mdm_id=$2 WHERE membership_id=$1",
          [member, other.id],
        );
        const vendorId = await enrollment.callVendor(plan);
        expect(vendorId).toMatch(/^7\d{2}$/); // the vendor created the clinician under the OLD physician's NPI...
        const actor = tenantActor(ORG_A);
        const code = await errorCode(
          withOrgContext(tdb, { organizationId: ORG_A, userId: TENANT_ADMIN }, (tx) =>
            enrollment.complete(
              createDrizzleRosterStore(tx as unknown as DbClient),
              tx as unknown as DbClient,
              actor,
              plan,
              vendorId as string,
            ),
          ),
        );
        expect(code).toBe("DOSESPOT_ROSTER_CHANGED"); // ...so the row now linking someone else is not linked to it
        const row = (
          await q(
            "SELECT dosespot_prescriber_id, npi FROM dosespot_prescriber WHERE membership_id=$1",
            [member],
          )
        )[0];
        expect(row?.dosespot_prescriber_id).toBeNull();
        expect(row?.npi).toBeNull();
        expect((await eventsOf("m12.prescriber_enrolled", ORG_A)).length).toBe(published);
      });

      it("a 2xx the vendor client cannot use (no clinician id) keeps the claim (502) instead of releasing it for a duplicate", async () => {
        const member = await newMember({ onRoster: true });
        enrollBehaviour = "no_id";
        const refused = await errorCode(enrollment.enroll(tenantActor(ORG_A), member));
        enrollBehaviour = "ok";
        expect(refused).toBe("DOSESPOT_ENROLLMENT_UNCONFIRMED");
        const row = (
          await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [member])
        )[0];
        expect(row?.dosespot_prescriber_id).toBeNull();
        expect(row?.vendor_enrollment_requested_at).not.toBeNull(); // the claim stands: the clinician may exist
        const calls = clinicianCalls();
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), member))).toBe(
          "DOSESPOT_ENROLLMENT_IN_PROGRESS",
        );
        expect(clinicianCalls()).toBe(calls); // and a retry inside the window does not create a second one
      });

      it("a prescriber revoked while the vendor call was in flight is never linked (409), and nothing is published", async () => {
        const member = await newMember({ onRoster: true });
        const published = (await eventsOf("m12.prescriber_enrolled", ORG_A)).length;
        const plan = await enrollment.prepare(tenantActor(ORG_A), member);
        await admin.query(
          "UPDATE dosespot_prescriber SET revoked_at=now() WHERE membership_id=$1",
          [member],
        );
        const vendorId = await enrollment.callVendor(plan);
        expect(vendorId).toMatch(/^7\d{2}$/); // the vendor DID create the clinician...
        const actor = tenantActor(ORG_A);
        const code = await errorCode(
          withOrgContext(tdb, { organizationId: ORG_A, userId: TENANT_ADMIN }, (tx) =>
            enrollment.complete(
              createDrizzleRosterStore(tx as unknown as DbClient),
              tx as unknown as DbClient,
              actor,
              plan,
              vendorId as string,
            ),
          ),
        );
        expect(code).toBe("DOSESPOT_PRESCRIBER_REVOKED"); // ...but the revoked roster row is not linked to it
        const row = (
          await q(
            "SELECT dosespot_prescriber_id, revoked_at FROM dosespot_prescriber WHERE membership_id=$1",
            [member],
          )
        )[0];
        expect(row?.dosespot_prescriber_id).toBeNull();
        expect(row?.revoked_at).not.toBeNull();
        expect((await eventsOf("m12.prescriber_enrolled", ORG_A)).length).toBe(published);
      });
    });

    // ── the prescriber's own confirmation of the physician record the roster linked them to ──────────────────────────────────────
    describe("the prescriber must confirm the linked physician record themself before the vendor enrolment", () => {
      let memberSeq = 0;
      const clinicianCalls = () => fetchLog.filter((c) => c.url.endsWith("/api/clinicians")).length;
      /** A member of ORG_A on the roster, linked to a fresh record, NOT yet confirmed by the prescriber; and their user id. */
      const unconfirmedMember = async (org = ORG_A) => {
        const n = ++memberSeq;
        const suffix = n.toString(16).padStart(2, "0");
        const userId = `99000000-0000-4000-8000-0000000003${suffix}`;
        const membershipId = `99000000-0000-4000-8000-0000000004${suffix}`;
        await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
          userId,
          `link${n}@ds.test`,
        ]);
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
          [membershipId, userId, org],
        );
        const physician = await rosterWithPhysician(org, membershipId, undefined, {
          confirmed: false,
        });
        return { membershipId, userId, physician };
      };
      const asMember = (m: { membershipId: string; userId: string }, org = ORG_A) => ({
        organizationId: org,
        userId: m.userId,
        membershipId: m.membershipId,
        request: { correlationId: `live-link-${++seq}`, requestId: `req-link-${seq}` },
      });
      const confirmationOf = async (membershipId: string) =>
        (
          await q(
            `SELECT link_confirmed_mdm_id AS mdm, link_confirmed_npi AS npi, link_confirmed_by_membership_id AS by
               FROM dosespot_prescriber WHERE membership_id=$1`,
            [membershipId],
          )
        )[0];

      it("an enrolment is refused (409) until the prescriber confirms, with nothing claimed or sent", async () => {
        const m = await unconfirmedMember();
        const calls = clinicianCalls();
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), m.membershipId))).toBe(
          "DOSESPOT_PRACTITIONER_UNCONFIRMED",
        );
        expect(clinicianCalls()).toBe(calls);
        const row = (
          await q("SELECT * FROM dosespot_prescriber WHERE membership_id=$1", [m.membershipId])
        )[0];
        expect(row?.vendor_enrollment_requested_at).toBeNull();
        expect(row?.dosespot_prescriber_id).toBeNull();
      });

      it("the prescriber is shown their record's name and NPI, confirms it, and then the enrolment goes through", async () => {
        const m = await unconfirmedMember();
        const shown = await linkService.view(asMember(m));
        expect(shown).toEqual({
          membershipId: m.membershipId,
          linked: true,
          externalPhysicianMdmId: m.physician.id,
          physician: {
            firstName: m.physician.firstName,
            lastName: m.physician.lastName,
            npi: m.physician.npi,
          },
          confirmed: false,
        });
        const out = await linkService.confirm(asMember(m), {
          externalPhysicianMdmId: m.physician.id,
          npi: m.physician.npi as string,
        });
        expect(out.confirmed).toBe(true);
        // the confirmer is the roster row's own member (the table's CHECK also says so)
        expect(await confirmationOf(m.membershipId)).toEqual({
          mdm: m.physician.id,
          npi: m.physician.npi,
          by: m.membershipId,
        });
        // audited with ids only: the row id, the physician record's id, the actor: never the NPI or the name
        const audit = (await auditRows(ORG_A, "m12.dosespot_clinic.prescriber_link_confirmed")).at(
          -1,
        );
        expect(audit?.actor_user_id).toBe(m.userId);
        expect(audit?.context).toMatchObject({
          actorMembershipId: m.membershipId,
          changedFields: ["linkConfirmation"],
          physicianMdmId: m.physician.id,
        });
        const logged = JSON.stringify(audit);
        expect(logged).not.toContain(m.physician.npi as string);
        expect(logged).not.toContain(m.physician.lastName);
        // and now the vendor enrolment (by an administrator) proceeds, with the confirmed record's NPI
        const calls = clinicianCalls();
        expect(await enrollment.enroll(tenantActor(ORG_A), m.membershipId)).toEqual({
          membershipId: m.membershipId,
          enrolledWithDoseSpot: true,
        });
        expect(clinicianCalls()).toBe(calls + 1);
        expect(
          (
            await q("SELECT npi FROM dosespot_prescriber WHERE membership_id=$1", [m.membershipId])
          )[0]?.npi,
        ).toBe(m.physician.npi);
      });

      it("a re-link voids the confirmation: enrolment is refused again until the prescriber confirms the NEW record", async () => {
        const m = await unconfirmedMember();
        await linkService.confirm(asMember(m), {
          externalPhysicianMdmId: m.physician.id,
          npi: m.physician.npi as string,
        });
        const other = await seedPhysician();
        // an administrator points the row at another record (the roster upsert clears the columns: m12-dosespot-write.live proves
        // that; here the link moves under a confirmation that was never cleared, and the pin alone must refuse)
        await admin.query(
          "UPDATE dosespot_prescriber SET external_physician_mdm_id=$2 WHERE membership_id=$1",
          [m.membershipId, other.id],
        );
        const calls = clinicianCalls();
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), m.membershipId))).toBe(
          "DOSESPOT_PRACTITIONER_UNCONFIRMED",
        );
        expect(clinicianCalls()).toBe(calls);
        // even a write that raced the re-link (it read the OLD link) cannot confirm: the update is pinned to the link it was shown
        expect(
          await withOrgContext(tdb, { organizationId: ORG_A, userId: m.userId }, (tx) =>
            createDrizzleRosterStore(tx as unknown as DbClient).confirmLink(ORG_A, m.membershipId, {
              mdmId: m.physician.id,
              npi: m.physician.npi as string,
              at: new Date(),
            }),
          ),
        ).toBeNull();
        // the view agrees, and confirming the old record they were shown is refused: the link moved
        expect((await linkService.view(asMember(m))).confirmed).toBe(false);
        expect(
          await errorCode(
            linkService.confirm(asMember(m), {
              externalPhysicianMdmId: m.physician.id,
              npi: m.physician.npi as string,
            }),
          ),
        ).toBe("DOSESPOT_ROSTER_CHANGED");
        // confirming the NEW record re-opens the enrolment
        await linkService.confirm(asMember(m), {
          externalPhysicianMdmId: other.id,
          npi: other.npi as string,
        });
        expect(await enrollment.enroll(tenantActor(ORG_A), m.membershipId)).toMatchObject({
          enrolledWithDoseSpot: true,
        });
      });

      it("a record whose NPI changed since the prescriber confirmed it is no longer confirmed: they confirm what they are shown NOW", async () => {
        const m = await unconfirmedMember();
        await linkService.confirm(asMember(m), {
          externalPhysicianMdmId: m.physician.id,
          npi: m.physician.npi as string,
        });
        const newNpi = syntheticNpi(9_000 + memberSeq);
        await admin.query("UPDATE external_physician SET npi=$2 WHERE id=$1", [
          m.physician.id,
          newNpi,
        ]);
        const calls = clinicianCalls();
        expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), m.membershipId))).toBe(
          "DOSESPOT_PRACTITIONER_UNCONFIRMED",
        );
        expect(clinicianCalls()).toBe(calls);
        expect((await linkService.view(asMember(m))).confirmed).toBe(false);
        await linkService.confirm(asMember(m), {
          externalPhysicianMdmId: m.physician.id,
          npi: newNpi,
        });
        expect(await enrollment.enroll(tenantActor(ORG_A), m.membershipId)).toMatchObject({
          enrolledWithDoseSpot: true,
        });
      });

      it("only the member can confirm their own link: another member's confirmation attempt changes nothing", async () => {
        const mine = await unconfirmedMember();
        const theirs = await unconfirmedMember();
        // `mine` tries to confirm THEIR record (pinned to what `theirs` was shown): their own row links something else
        expect(
          await errorCode(
            linkService.confirm(asMember(mine), {
              externalPhysicianMdmId: theirs.physician.id,
              npi: theirs.physician.npi as string,
            }),
          ),
        ).toBe("DOSESPOT_ROSTER_CHANGED");
        expect((await confirmationOf(theirs.membershipId))?.mdm).toBeNull();
        expect((await confirmationOf(mine.membershipId))?.mdm).toBeNull();
        // a member who is not on the roster at all has no row to confirm
        const stranger = `99000000-0000-4000-8000-0000000005${(++memberSeq).toString(16).padStart(2, "0")}`;
        expect(
          await errorCode(
            linkService.confirm(
              { ...asMember(mine), membershipId: stranger },
              {
                externalPhysicianMdmId: theirs.physician.id,
                npi: theirs.physician.npi as string,
              },
            ),
          ),
        ).toBe("DOSESPOT_PRACTITIONER_NOT_LINKED");
        expect((await confirmationOf(theirs.membershipId))?.mdm).toBeNull();
      });

      const errText = (e: unknown) =>
        [(e as Error).message, ((e as Error).cause as Error | undefined)?.message].join(" ");
      const directConfirm = (
        declared: { userId: string; systemActor?: true },
        m: { membershipId: string; physician: SeededPhysician },
      ) =>
        withOrgContext(tdb, { organizationId: ORG_A, ...declared }, (tx) =>
          (tx as unknown as DbClient).execute(
            sql`UPDATE dosespot_prescriber SET link_confirmed_mdm_id=${m.physician.id}, link_confirmed_npi=${m.physician.npi},
                  link_confirmed_at=now(), link_confirmed_by_membership_id=${m.membershipId}
                WHERE membership_id=${m.membershipId}`,
          ),
        );

      it("the database refuses a confirmation written under ANOTHER declared user (a direct UPDATE as the application role), and accepts the member acting as themself", async () => {
        const m = await unconfirmedMember();
        // the application role, declared as a tenant administrator, as the platform operator, and as the empty system actor
        for (const declared of [
          { userId: TENANT_ADMIN },
          { userId: OPERATOR },
          { userId: "", systemActor: true as const },
        ]) {
          const err = await directConfirm(declared, m).then(
            () => "",
            (e: unknown) => errText(e),
          );
          expect(err, JSON.stringify(declared)).toContain(
            "a link confirmation can only be set by the member it belongs to",
          );
          expect((await confirmationOf(m.membershipId))?.mdm).toBeNull();
        }
        // the member, declared as themself, may: that is the route's own path
        await directConfirm({ userId: m.userId }, m);
        expect(await confirmationOf(m.membershipId)).toEqual({
          mdm: m.physician.id,
          npi: m.physician.npi,
          by: m.membershipId,
        });
        // ADR-0110 D9 / CW-AC-21 say the table's write-audit row records the confirmed NPI (public provider data, and the evidence of WHAT
        // the prescriber attested): pinned here so a denylist entry for that column cannot appear without those texts being revisited
        const auditedWith = (npi: string) =>
          q(
            `SELECT 1 FROM audit_event WHERE organization_id=$1 AND resource_kind='dosespot_prescriber'
                AND after->>'link_confirmed_npi' = $2`,
            [ORG_A, npi],
          );
        expect(m.physician.npi).not.toBeNull();
        expect(await auditedWith(m.physician.npi as string)).toHaveLength(1);
        expect(await auditedWith("0000000000")).toHaveLength(0);
        // an UNRELATED update of the confirmed row (any actor) is not a confirmation and is not refused
        await withOrgContext(tdb, { organizationId: ORG_A, userId: TENANT_ADMIN }, (tx) =>
          (tx as unknown as DbClient).execute(
            sql`UPDATE dosespot_prescriber SET dea_authorized_schedules = ARRAY['II']::text[] WHERE membership_id=${m.membershipId}`,
          ),
        );
        expect((await confirmationOf(m.membershipId))?.mdm).toBe(m.physician.id);
        // and CLEARING it is open to any actor: a re-link or a revoke does that
        await withOrgContext(tdb, { organizationId: ORG_A, userId: TENANT_ADMIN }, (tx) =>
          (tx as unknown as DbClient).execute(
            sql`UPDATE dosespot_prescriber SET link_confirmed_mdm_id=NULL, link_confirmed_npi=NULL, link_confirmed_at=NULL,
                  link_confirmed_by_membership_id=NULL WHERE membership_id=${m.membershipId}`,
          ),
        );
        expect((await confirmationOf(m.membershipId))?.mdm).toBeNull();
      });

      it("the registration's SECURITY DEFINER audit trigger pins its search_path with pg_temp last and names its objects by schema", async () => {
        const [fn] = await q<{ secdef: boolean; config: string[] | null; src: string }>(
          `SELECT prosecdef AS secdef, proconfig AS config, prosrc AS src FROM pg_proc
            WHERE proname = 'audit_phi_write_dosespot_clinic_registration'`,
        );
        expect(fn?.secdef).toBe(true);
        expect(fn?.config).toContain("search_path=pg_catalog, public, pg_temp");
        expect(fn?.src).toContain("INSERT INTO public.audit_event");
        expect(fn?.src).not.toMatch(/[^.]audit_scrub\(/);
      });

      it("the guard function is SECURITY INVOKER with a pinned search_path (it cannot be shadowed from a caller-controlled schema)", async () => {
        const [fn] = await q<{ secdef: boolean; config: string[] | null }>(
          `SELECT prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE proname = 'dosespot_prescriber_link_confirmation_guard'`,
        );
        expect(fn?.secdef).toBe(false);
        expect(fn?.config).toContain("search_path=pg_catalog, public, pg_temp");
      });

      it("the CHECK refuses, even with the trigger off, a confirmer who is not the row's member and a NULL confirmer, NPI or timestamp", async () => {
        const a = await unconfirmedMember();
        const b = await unconfirmedMember();
        const attempt = async (setClause: string, params: unknown[]) => {
          await admin.query("BEGIN");
          try {
            await admin.query("SET LOCAL session_replication_role = replica"); // triggers off: only the CHECK is left
            await admin.query(
              `UPDATE dosespot_prescriber SET ${setClause} WHERE membership_id=$1`,
              [a.membershipId, ...params],
            );
            await admin.query("COMMIT");
            return "";
          } catch (e) {
            await admin.query("ROLLBACK");
            return (e as Error).message;
          }
        };
        const base = "link_confirmed_mdm_id=$2, link_confirmed_npi=$3, link_confirmed_at=now()";
        const id = a.physician.id;
        const npi = a.physician.npi;
        const cases: ReadonlyArray<readonly [string, string, unknown[]]> = [
          [
            "a confirmer who is another member",
            `${base}, link_confirmed_by_membership_id=$4`,
            [id, npi, b.membershipId],
          ],
          ["a NULL confirmer", `${base}, link_confirmed_by_membership_id=NULL`, [id, npi]],
          [
            "a NULL NPI",
            "link_confirmed_mdm_id=$2, link_confirmed_npi=NULL, link_confirmed_at=now(), link_confirmed_by_membership_id=membership_id",
            [id],
          ],
          [
            "a NULL timestamp",
            "link_confirmed_mdm_id=$2, link_confirmed_npi=$3, link_confirmed_at=NULL, link_confirmed_by_membership_id=membership_id",
            [id, npi],
          ],
          [
            "a malformed NPI",
            "link_confirmed_mdm_id=$2, link_confirmed_npi='12345', link_confirmed_at=now(), link_confirmed_by_membership_id=membership_id",
            [id],
          ],
          ["only some of the four", "link_confirmed_mdm_id=$2", [id]],
        ];
        for (const [name, setClause, params] of cases) {
          expect(await attempt(setClause, params), name).toContain(
            "dosespot_prescriber_link_confirmation_ck",
          );
        }
        // the one well-formed confirmation by the row's own member passes the CHECK (the trigger, off here, is what asks who declared it)
        expect(
          await attempt(`${base}, link_confirmed_by_membership_id=membership_id`, [id, npi]),
        ).toBe("");
        expect((await confirmationOf(a.membershipId))?.by).toBe(a.membershipId);
      });

      it("recording the vendor id is refused (409) when the prescriber's confirmation was cleared while the vendor call was in flight", async () => {
        const m = await unconfirmedMember();
        await linkService.confirm(asMember(m), {
          externalPhysicianMdmId: m.physician.id,
          npi: m.physician.npi as string,
        });
        const plan = await enrollment.prepare(tenantActor(ORG_A), m.membershipId);
        await admin.query(
          `UPDATE dosespot_prescriber SET link_confirmed_mdm_id=NULL, link_confirmed_npi=NULL, link_confirmed_at=NULL,
             link_confirmed_by_membership_id=NULL WHERE membership_id=$1`,
          [m.membershipId],
        );
        const vendorId = await enrollment.callVendor(plan);
        const actor = tenantActor(ORG_A);
        const code = await errorCode(
          withOrgContext(tdb, { organizationId: ORG_A, userId: TENANT_ADMIN }, (tx) =>
            enrollment.complete(
              createDrizzleRosterStore(tx as unknown as DbClient),
              tx as unknown as DbClient,
              actor,
              plan,
              vendorId as string,
            ),
          ),
        );
        expect(code).toBe("DOSESPOT_ROSTER_CHANGED");
        expect(
          (
            await q(
              "SELECT dosespot_prescriber_id FROM dosespot_prescriber WHERE membership_id=$1",
              [m.membershipId],
            )
          )[0]?.dosespot_prescriber_id,
        ).toBeNull();
      });

      // Review of slice 4 (separation of duties): an org administrator holds the roster key AND may sign, so one person could link their own
      // membership to any physician record, confirm it and enrol under that NPI. The roster link (the REAL roster service, as the route calls
      // it) now records who made it, and the member who made it can neither confirm it nor be enrolled under a link they also confirmed.
      describe("linker != confirmer", () => {
        let linkSeq = 0;
        /** A member of ORG_A NOT yet on the roster, and a fresh physician record for them. */
        const newMember = async () => {
          const n = ++linkSeq;
          const suffix = n.toString(16).padStart(2, "0");
          const userId = `99000000-0000-4000-8000-0000000006${suffix}`;
          const membershipId = `99000000-0000-4000-8000-0000000007${suffix}`;
          await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
            userId,
            `sod${n}@ds.test`,
          ]);
          await admin.query(
            "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
            [membershipId, userId, ORG_A],
          );
          return { membershipId, userId, physician: await seedPhysician() };
        };
        /** The roster link exactly as `POST /admin/dosespot-prescribers/:id/enroll` makes it, with `linker` as the acting membership. */
        const link = (m: { membershipId: string; physician: SeededPhysician }, linker: string) =>
          createDbDoseSpotBackend(tdb as unknown as DbClient, outbox).enrollPrescriber(
            ORG_A,
            m.membershipId,
            [],
            m.physician.id,
            linker,
          );
        const linkerOf = async (membershipId: string) =>
          (
            await q(
              "SELECT linked_by_membership_id AS by FROM dosespot_prescriber WHERE membership_id=$1",
              [membershipId],
            )
          )[0]?.by;
        const pin = (m: { physician: SeededPhysician }) => ({
          externalPhysicianMdmId: m.physician.id,
          npi: m.physician.npi as string,
        });

        it("a member who linked THEMSELF cannot confirm it (409 DOSESPOT_LINK_SELF_CONFIRM), and a confirmation written around the service does not enrol", async () => {
          const m = await newMember();
          await link(m, m.membershipId);
          expect(await linkerOf(m.membershipId)).toBe(m.membershipId);
          expect(await errorCode(linkService.confirm(asMember(m), pin(m)))).toBe(
            "DOSESPOT_LINK_SELF_CONFIRM",
          );
          expect((await confirmationOf(m.membershipId))?.mdm).toBeNull();
          // even a confirmation the member writes directly (as themself, which the trigger allows): the gate refuses it, nothing is sent
          await asDeclaredUser(
            m.userId,
            `UPDATE dosespot_prescriber SET link_confirmed_mdm_id=$2, link_confirmed_npi=$3, link_confirmed_at=now(),
               link_confirmed_by_membership_id=membership_id WHERE membership_id=$1`,
            [m.membershipId, m.physician.id, m.physician.npi],
          );
          expect((await linkService.view(asMember(m))).confirmed).toBe(false);
          const calls = clinicianCalls();
          expect(await errorCode(enrollment.enroll(tenantActor(ORG_A), m.membershipId))).toBe(
            "DOSESPOT_PRACTITIONER_UNCONFIRMED",
          );
          expect(clinicianCalls()).toBe(calls);
        });

        it("a link made by ANOTHER member (the tenant administrator) is confirmed by the prescriber and enrolled", async () => {
          const m = await newMember();
          await link(m, MEMBERSHIP);
          expect(await linkerOf(m.membershipId)).toBe(MEMBERSHIP);
          expect((await linkService.confirm(asMember(m), pin(m))).confirmed).toBe(true);
          expect(await enrollment.enroll(tenantActor(ORG_A), m.membershipId)).toMatchObject({
            enrolledWithDoseSpot: true,
          });
        });

        it("a link recorded under a platform operator's membership counts as another linker: the prescriber's own confirmation is accepted", async () => {
          const m = await newMember();
          await link(m, OPS_MEMBERSHIP);
          expect(await linkerOf(m.membershipId)).toBe(OPS_MEMBERSHIP);
          expect((await linkService.confirm(asMember(m), pin(m))).confirmed).toBe(true);
          expect((await linkService.view(asMember(m))).confirmed).toBe(true);
        });

        it("a member who re-links themself to another record after an administrator's link cannot confirm the new one", async () => {
          const m = await newMember();
          await link(m, MEMBERSHIP);
          const other = await seedPhysician();
          await createDbDoseSpotBackend(tdb as unknown as DbClient, outbox).enrollPrescriber(
            ORG_A,
            m.membershipId,
            [],
            other.id,
            m.membershipId,
          );
          expect(await linkerOf(m.membershipId)).toBe(m.membershipId);
          expect(
            await errorCode(
              linkService.confirm(asMember(m), {
                externalPhysicianMdmId: other.id,
                npi: other.npi as string,
              }),
            ),
          ).toBe("DOSESPOT_LINK_SELF_CONFIRM");
        });
      });

      it("a platform operator cannot confirm on a member's behalf: there is no operator route, and their own membership selects no one else's row", async () => {
        const m = await unconfirmedMember();
        // the operator lane (the port and the data service) offers no confirmation at all
        for (const surface of [dosespotPort, onboardingData] as object[]) {
          expect(Object.keys(surface).filter((k) => /confirm/i.test(k))).toEqual([]);
        }
        // the one confirmation entry point keys on the session's OWN membership: an operator's has no roster row in the tenant
        for (const org of [PLATFORM_ORG, ORG_A]) {
          expect(
            await errorCode(
              linkService.confirm(
                { organizationId: org, userId: OPERATOR, membershipId: OPS_MEMBERSHIP },
                { externalPhysicianMdmId: m.physician.id, npi: m.physician.npi as string },
              ),
            ),
          ).toBe("DOSESPOT_PRACTITIONER_NOT_LINKED");
        }
        expect((await confirmationOf(m.membershipId))?.mdm).toBeNull();
        // and the operator's enrolment of an unconfirmed prescriber is refused the same way (the operator lane describe: ORG_B)
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
        const rosterNpis = (
          await q(
            "SELECT npi FROM dosespot_prescriber WHERE organization_id=$1 AND npi IS NOT NULL",
            [ORG_A],
          )
        ).map((r) => r.npi as string);
        expect(rosterNpis.length).toBeGreaterThan(0); // there ARE NPIs on this roster, and none reaches the operator's list
        for (const npi of rosterNpis) expect(dump).not.toContain(npi);
        expect(roster.items.length).toBeGreaterThan(0);
      });

      it("an operator's NO-OP save does not void a pending go-live attestation; a changing save does", async () => {
        await admin.query(
          `INSERT INTO tenant_go_live_attestation (organization_id, tenant_account_id, attested_by_membership_id, attested_by_user_id)
           SELECT $1, id, 'e5000000-0000-4000-8000-0000000000f1', 'c3000000-0000-4000-8000-0000000000f2' FROM tenant_account WHERE organization_id=$1`,
          [ORG_B],
        );
        const attestation = async () =>
          (
            await q("SELECT status FROM tenant_go_live_attestation WHERE organization_id=$1", [
              ORG_B,
            ])
          )[0]?.status;
        expect(await attestation()).toBe("pending");
        const same = (await rowOf(ORG_B)) as Record<string, any>;
        const noop = await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE },
          REASON,
          same.version,
        );
        expect(noop).toMatchObject({ created: false });
        expect((await rowOf(ORG_B))?.version).toBe(same.version); // nothing changed...
        expect(await attestation()).toBe("pending"); // ...so the attestation stands
        await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE, serviceClinicianId: "902" },
          REASON,
          same.version,
        );
        expect(await attestation()).toBe("revoked"); // a real change makes it stale
        expect((await rowOf(ORG_B))?.status).toBe("registered"); // a change clears what the old values earned
        probeStatus = 200;
        await onboardingData.verifyDoseSpot(operator(), "ds-b", REASON);
        await onboardingData.activateDoseSpot(operator(), "ds-b", REASON);
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
        const physician = await rosterWithPhysician(ORG_B, M3); // the operator names no NPI: it comes from the linked record
        const out = await onboardingData.enrollDoseSpotPrescriber(operator(), "ds-b", M3, REASON);
        expect(out).toEqual({ membershipId: M3, enrolledWithDoseSpot: true });
        expect(vendorCallsInsideTx).toBe(0);
        expect(
          (await q("SELECT npi FROM dosespot_prescriber WHERE membership_id=$1", [M3]))[0]?.npi,
        ).toBe(physician.npi);
        expect(
          (
            await q(
              "SELECT dosespot_prescriber_id FROM dosespot_prescriber WHERE membership_id=$1",
              [M3],
            )
          )[0]?.dosespot_prescriber_id,
        ).toMatch(/^7\d{2}$/);
        expect(
          (await auditRows(ORG_B, "m34.tenant_onboarding.dosespot_prescriber_enrolled")).length,
        ).toBe(1);
      });

      it("an operator's enrolment of a prescriber who has not confirmed the link is refused (409), and the roster list says so", async () => {
        const M4 = "99000000-0000-4000-8000-0000000000b4";
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000bc','rx5@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000bc',$2,'active')",
          [M4, ORG_B],
        );
        await rosterWithPhysician(ORG_B, M4, undefined, { confirmed: false });
        const calls = fetchLog.length;
        expect(
          await errorCode(onboardingData.enrollDoseSpotPrescriber(operator(), "ds-b", M4, REASON)),
        ).toBe("DOSESPOT_PRACTITIONER_UNCONFIRMED");
        expect(fetchLog.slice(calls).filter((c) => c.url.endsWith("/api/clinicians"))).toHaveLength(
          0,
        );
        const roster = (await onboardingData.listDoseSpotPrescribers(operator(), "ds-b")) as {
          items: { membershipId: string; linkConfirmed: boolean }[];
        };
        expect(roster.items.find((i) => i.membershipId === M4)?.linkConfirmed).toBe(false);
        expect(roster.items.some((i) => i.linkConfirmed)).toBe(true); // the one the prescriber confirmed (M3)
      });

      // Review of slice 4, LOW-3: the list's `linkConfirmed` compared the record id only, so after the physician record's NPI changed it said
      // "confirmed" while the enrolment (which also compares the NPI the prescriber was shown) answered 409. It now asks the same question.
      it("the operator's roster list never says confirmed while the enrolment answers 409: a record whose NPI changed since the confirmation is unconfirmed in both", async () => {
        const M5 = "99000000-0000-4000-8000-0000000000b5";
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000bd','rx6@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000bd',$2,'active')",
          [M5, ORG_B],
        );
        const physician = await rosterWithPhysician(ORG_B, M5); // confirmed by the member, for this record and NPI
        const listed = async () =>
          (
            (await onboardingData.listDoseSpotPrescribers(operator(), "ds-b")) as {
              items: { membershipId: string; linkConfirmed: boolean }[];
            }
          ).items.find((i) => i.membershipId === M5)?.linkConfirmed;
        expect(await listed()).toBe(true);
        // the master-data record's NPI changes to another valid NPI (same record id, same link)
        const changed = syntheticNpi(990);
        await admin.query("UPDATE external_physician SET npi=$2 WHERE id=$1", [
          physician.id,
          changed,
        ]);
        const calls = fetchLog.length;
        expect(
          await errorCode(onboardingData.enrollDoseSpotPrescriber(operator(), "ds-b", M5, REASON)),
        ).toBe("DOSESPOT_PRACTITIONER_UNCONFIRMED");
        expect(fetchLog.slice(calls).filter((c) => c.url.endsWith("/api/clinicians"))).toHaveLength(
          0,
        );
        expect(await listed()).toBe(false);
      });

      // One directory failure must not fail the operator's roster list: that row is simply not shown as confirmed, and the others still are.
      it("the operator's roster list survives a directory failure on one row: that row reports unconfirmed, the others are unaffected, and the failure is logged without values", async () => {
        const seed = async (n: number) => {
          const userId = `9a000000-0000-4000-8000-00000000000${n}`;
          const membershipId = `9b000000-0000-4000-8000-00000000000${n}`;
          await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
            userId,
            `rxlist${n}@ds.test`,
          ]);
          await admin.query(
            "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
            [membershipId, userId, ORG_B],
          );
          return { membershipId, physician: await rosterWithPhysician(ORG_B, membershipId) };
        };
        const good = await seed(1);
        const flaky = await seed(2);
        const warned: { fields: Record<string, string | number>; message: string }[] = [];
        const directory = {
          resolvePhysician: (organizationId: string, mdmId: string) => {
            if (mdmId === flaky.physician.id)
              return Promise.reject(new Error("directory unavailable"));
            return mdmDirectoryForList.resolvePhysician(organizationId, mdmId);
          },
        };
        const port = buildDoseSpotClinicOnboardingPort({
          db: tdb,
          service,
          outbox,
          enrollment,
          directory,
          warn: (fields, message) => warned.push({ fields, message }),
        });
        const items = (await port.listPrescribers({
          organizationId: ORG_B,
          operatorUserId: OPERATOR,
          operatorMembershipId: OPS_MEMBERSHIP,
          operatorRoles: ["platform_ops"],
          stepUpRecent: true,
          request: { correlationId: "live-list-flaky", requestId: "req-list-flaky" },
        })) as { membershipId: string; linkConfirmed: boolean }[];
        expect(items.find((i) => i.membershipId === good.membershipId)?.linkConfirmed).toBe(true);
        expect(items.find((i) => i.membershipId === flaky.membershipId)?.linkConfirmed).toBe(false);
        expect(warned).toHaveLength(1);
        expect(warned[0]?.fields).toMatchObject({ organizationId: ORG_B, cause: "Error" });
        expect(JSON.stringify(warned)).not.toContain(flaky.physician.npi ?? "no-npi");
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
        // enrol and verify refuse BEFORE any work: no roster write, no vendor call, no token mint, and the refusal is audited
        const REVOKED = "99000000-0000-4000-8000-0000000000c1";
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000c9','rx4@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000c9',$2,'active')",
          [REVOKED, ORG_C],
        );
        await admin.query(
          "INSERT INTO dosespot_prescriber (organization_id, membership_id, dosespot_prescriber_id, enrolled_at, revoked_at) VALUES ($1,$2,'777',now(),now())",
          [ORG_C, REVOKED],
        );
        const refusedBefore = (await auditRows(ORG_C, "m34.tenant_onboarding.write_refused"))
          .length;
        fetchLog.length = 0;
        expect(
          await errorCode(
            onboardingData.enrollDoseSpotPrescriber(operator(), "ds-c", REVOKED, REASON),
          ),
        ).toBe("TENANT_NOT_ONBOARDING");
        expect(await errorCode(onboardingData.verifyDoseSpot(operator(), "ds-c", REASON))).toBe(
          "TENANT_NOT_ONBOARDING",
        );
        expect(fetchLog).toHaveLength(0);
        const stillRevoked = (
          await q(
            "SELECT revoked_at, vendor_enrollment_requested_at FROM dosespot_prescriber WHERE membership_id=$1",
            [REVOKED],
          )
        )[0];
        expect(stillRevoked?.revoked_at).not.toBeNull();
        expect(stillRevoked?.vendor_enrollment_requested_at).toBeNull();
        expect((await auditRows(ORG_C, "m34.tenant_onboarding.write_refused")).length).toBe(
          refusedBefore + 2,
        );
        // the safety down-shift is not status-gated
        alerts.length = 0;
        const out = await onboardingData.deactivateDoseSpot(operator(), "ds-c", REASON);
        expect(out).toMatchObject({ status: "verified" });
        expect(alerts.filter((a) => a.organizationId === ORG_C)).toHaveLength(1);
      });

      it("an unknown slug is a 404", async () => {
        expect(await errorCode(onboardingData.getDoseSpot(operator(), "no-such-tenant"))).toBe(
          "NOT_FOUND",
        );
        expect(
          await errorCode(
            onboardingData.putDoseSpot(
              operator(),
              "no-such-tenant",
              { ...BASE },
              REASON,
              undefined,
            ),
          ),
        ).toBe("NOT_FOUND");
      });

      it("a slug names its own tenant only: another tenant's member is not found, and another tenant's version is a stale If-Match", async () => {
        const a = (await rowOf(ORG_A)) as Record<string, any>;
        const b = (await rowOf(ORG_B)) as Record<string, any>;
        expect(b.status).toBe("active"); // ORG_B can take an enrolment, so a refusal below is the TENANT check and not "not ready"
        // a membership of ORG_A named under slug `ds-b` is not found under ORG_B's scope: no roster row, no vendor call
        const ROSTERED_IN_A = "99000000-0000-4000-8000-0000000000a1";
        const rosterBefore = (await q("SELECT count(*)::int AS n FROM dosespot_prescriber"))[0]?.n;
        const calls = fetchLog.length;
        expect(
          await errorCode(
            onboardingData.enrollDoseSpotPrescriber(operator(), "ds-b", ROSTERED_IN_A, REASON),
          ),
        ).toBe("NOT_FOUND");
        expect((await q("SELECT count(*)::int AS n FROM dosespot_prescriber"))[0]?.n).toBe(
          rosterBefore,
        );
        expect(fetchLog.slice(calls).filter((c) => c.url.endsWith("/api/clinicians"))).toHaveLength(
          0,
        );
        // ORG_A's version, sent as If-Match through slug `ds-b`, is stale for ORG_B: 412, and neither registration moved
        await admin.query(
          "UPDATE dosespot_clinic_registration SET version=$2 WHERE organization_id=$1",
          [ORG_A, b.version + 7],
        );
        const aVersion = b.version + 7;
        expect(
          await errorCode(
            onboardingData.putDoseSpot(
              operator(),
              "ds-b",
              { ...BASE, serviceClinicianId: "909" },
              REASON,
              aVersion,
            ),
          ),
        ).toBe("VERSION_CONFLICT");
        expect((await rowOf(ORG_B))?.version).toBe(b.version);
        expect((await rowOf(ORG_B))?.service_clinician_id).toBe(b.service_clinician_id);
        const aAfter = (await rowOf(ORG_A)) as Record<string, any>;
        expect(aAfter.version).toBe(aVersion);
        expect(aAfter.service_clinician_id).toBe(a.service_clinician_id);
        // ORG_B's own version is accepted, through its own slug
        await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE, serviceClinicianId: "901" },
          REASON,
          b.version,
        );
        expect((await rowOf(ORG_A))?.version).toBe(aVersion);
      });

      it("platform repair: a registration whose stored credential cannot be opened is re-sealed from the clinic key ALONE when the operator attests the clinic uses the platform's Subscription-Key; the tenant lane cannot, and a partial change is a 503", async () => {
        const NEW_CLINIC_KEY = "clinic-key-plaintext-REPAIRED-6d2f90a1";
        const sealed = async () => (await rowOf(ORG_B))?.secret_cipher as string;
        // the clinic uses the platform's Subscription-Key (it never had its own): drop the own one set earlier, on the real key ring
        await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE, clinicKey: CLINIC_KEY, usePlatformSubscriptionKey: true },
          REASON,
          (await rowOf(ORG_B))?.version,
        );
        // the sealed envelope is damaged: nothing can open it, so nobody can tell what it held
        await admin.query(
          "UPDATE dosespot_clinic_registration SET secret_cipher='v1.AAAA.AAAA.AAAA' WHERE organization_id=$1",
          [ORG_B],
        );
        const broken = (await rowOf(ORG_B)) as Record<string, any>;
        // a partial change would silently drop whatever the other half was: refused, row untouched
        expect(
          await errorCode(
            onboardingData.putDoseSpot(
              operator(),
              "ds-b",
              { ...BASE, clinicKey: NEW_CLINIC_KEY },
              REASON,
              broken.version,
            ),
          ),
        ).toBe("DOSESPOT_CREDENTIAL_UNREADABLE");
        // the tenant's own administrator cannot attest it
        const refused = await route
          .put(
            tenantActor(ORG_B),
            { ...BASE, clinicKey: NEW_CLINIC_KEY, usePlatformSubscriptionKey: true },
            broken.version,
          )
          .catch((e) => e);
        expect(refused.details?.[0]?.code).toBe("DOSESPOT_SUBSCRIPTION_KEY_PLATFORM_ONLY");
        expect(await sealed()).toBe("v1.AAAA.AAAA.AAAA");
        expect((await rowOf(ORG_B))?.version).toBe(broken.version);
        // the operator's attestation re-seals the clinic key alone: registered, re-testable, and served the PLATFORM's key
        await onboardingData.putDoseSpot(
          operator(),
          "ds-b",
          { ...BASE, clinicKey: NEW_CLINIC_KEY, usePlatformSubscriptionKey: true },
          REASON,
          broken.version,
        );
        expect(await rowOf(ORG_B)).toMatchObject({ status: "registered" });
        expect(await sealed()).not.toBe("v1.AAAA.AAAA.AAAA");
        probeStatus = 200;
        const verified = await onboardingData.verifyDoseSpot(operator(), "ds-b", REASON);
        expect(verified).toMatchObject({ test: { outcome: "ok" } });
        const mint = fetchLog.filter((c) => c.url.endsWith("/connect/token")).at(-1);
        expect(mint?.headers["Subscription-Key"]).toBe("platform-sandbox-sub-key");
        expect(mint?.headers.Authorization).toBe(
          `Basic ${Buffer.from(`${BASE.clinicId}:${NEW_CLINIC_KEY}`).toString("base64")}`,
        );
        // the audit row names what changed (field names only): the attestation is the `subscriptionKey` field, never a value
        const audit = (await auditRows(ORG_B, "m34.tenant_onboarding.dosespot_set")).at(-1);
        expect(audit?.context.changedFields).toEqual(["clinicKey", "subscriptionKey"]);
        expect(JSON.stringify(audit)).not.toContain(NEW_CLINIC_KEY);
        // leave ORG_B live and ready, as the cases after this one expect
        await onboardingData.activateDoseSpot(operator(), "ds-b", REASON);
      });

      describe("the port refuses a transaction that is not scoped to the scope's organization", () => {
        const scopeFor = (organizationId: string) => ({
          organizationId,
          operatorUserId: OPERATOR,
          operatorMembershipId: OPS_MEMBERSHIP,
          operatorRoles: ["platform_ops"],
          stepUpRecent: true,
          request: { correlationId: "live-scope", requestId: "req-scope" },
        });
        // a transaction scoped to ORG_B, a scope naming ORG_A: the shape of a wiring bug in the platform write wrapper
        const underB = <T>(fn: (tx: DbClient) => Promise<T>) =>
          withOrgContext(tdb, { organizationId: ORG_B, userId: OPERATOR }, (tx) =>
            fn(tx as unknown as DbClient),
          );

        it.each([
          ["put", (tx: DbClient) => dosespotPort.put(tx, scopeFor(ORG_A), { ...BASE }, undefined)],
          [
            "completeVerify",
            (tx: DbClient) => dosespotPort.completeVerify(tx, scopeFor(ORG_A), {}, {}),
          ],
          ["activate", (tx: DbClient) => dosespotPort.activate(tx, scopeFor(ORG_A))],
          ["deactivate", (tx: DbClient) => dosespotPort.deactivate(tx, scopeFor(ORG_A))],
          [
            "completeEnroll",
            (tx: DbClient) => dosespotPort.completeEnroll(tx, scopeFor(ORG_A), {}, "799"),
          ],
        ] as const)("%s", async (_name, call) => {
          const before = [await rowOf(ORG_A), await rowOf(ORG_B)];
          expect(await errorCode(underB(call))).toBe("TENANT_SCOPE_MISMATCH");
          expect([await rowOf(ORG_A), await rowOf(ORG_B)]).toEqual(before); // nothing was written to either org
        });

        it("the same call on a transaction scoped to its own organization is not refused", async () => {
          const version = (await rowOf(ORG_B))?.version as number;
          const out = await withOrgContext(tdb, { organizationId: ORG_B, userId: OPERATOR }, (tx) =>
            dosespotPort.put(
              tx as unknown as DbClient,
              scopeFor(ORG_B),
              { ...BASE, serviceClinicianId: "901" },
              version,
            ),
          );
          expect(out.created).toBe(false);
        });
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
        // The tenant side, with rows that make it non-vacuous: org-wide admin roles in two orgs, a clinical role, a role that is
        // only named like an admin, and a PLATFORM-level (no organization) `administrator`. The migration is re-run over them.
        const seedRole = async (org: string | null, key: string, category: string) =>
          (
            await admin.query(
              "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,$3,true) RETURNING id",
              [org, key, category],
            )
          ).rows[0].id as string;
        const orgAdminA = await seedRole(ORG_A, "org_admin", "admin_executive");
        const administratorB = await seedRole(ORG_B, "administrator", "admin_executive");
        const nurseA = await seedRole(ORG_A, "bind-nurse", "clinical_staff");
        const lookalikeA = await seedRole(ORG_A, "org_admin_assistant", "admin_executive");
        const platformAdministrator = await seedRole(null, "administrator", "platform_staff");
        const migrationSql = readFileSync(
          join(MIGRATIONS_DIR, "1383_m12_tenant_dosespot_permissions.sql"),
          "utf8",
        );
        await admin.query(migrationSql);
        await admin.query(migrationSql); // idempotent over a live role table
        const holders = async (roleId: string) =>
          (
            await q<{ permission_key: string }>(
              "SELECT permission_key FROM role_permission WHERE role_id=$1 ORDER BY permission_key",
              [roleId],
            )
          ).map((r) => r.permission_key);
        const TENANT_KEYS = ["prescribing.clinic.admin", "prescribing.clinic.read"];
        expect(await holders(orgAdminA)).toEqual(TENANT_KEYS);
        expect(await holders(administratorB)).toEqual(TENANT_KEYS);
        expect(await holders(nurseA)).toEqual([]);
        expect(await holders(lookalikeA)).toEqual([]);
        expect(await holders(platformAdministrator)).toEqual([]); // a platform-level role is not a tenant admin
        // and across the whole table: only org-scoped org_admin / administrator rows hold a tenant key
        const everyHolder = await q<{ key: string; organization_id: string | null }>(
          "SELECT DISTINCT r.key, r.organization_id FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE rp.permission_key IN ('prescribing.clinic.read','prescribing.clinic.admin')",
        );
        expect(everyHolder.length).toBeGreaterThanOrEqual(2);
        for (const holder of everyHolder) {
          expect(["org_admin", "administrator"]).toContain(holder.key);
          expect(holder.organization_id).not.toBeNull();
        }
        const catalog = await q<{ key: string }>(
          "SELECT key FROM permission WHERE key IN ('prescribing.clinic.read','prescribing.clinic.admin','tenant_dosespot.read_platform','tenant_dosespot.write_platform')",
        );
        expect(catalog).toHaveLength(4);
      });
    });

    // ── the sandbox flag (H1) ───────────────────────────────────────────────────────────────────────
    describe("DOSESPOT_SANDBOX_ENABLED gates a sandbox registration going live and staying live", () => {
      const gate = createTransmissionGate({ platformEnv, envFallbackFor: async () => false });
      const settledReader = () => buildDoseSpotSettledReader(tdb, platformEnv);
      const SBX_MEMBER = "99000000-0000-4000-8000-0000000000e1";

      it("with the flag off an ACTIVE sandbox row stops transmitting: resolver, sign gate and wizard fact all say not live", async () => {
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES ('99000000-0000-4000-8000-0000000000e9','sbx@ds.test') ON CONFLICT DO NOTHING`,
        );
        await admin.query(
          "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,'99000000-0000-4000-8000-0000000000e9',$2,'active') ON CONFLICT DO NOTHING",
          [SBX_MEMBER, ORG_A],
        );
        await admin.query(
          "INSERT INTO dosespot_prescriber (organization_id, membership_id, dosespot_prescriber_id, enrolled_at) VALUES ($1,$2,'791',now()) ON CONFLICT DO NOTHING",
          [ORG_A, SBX_MEMBER],
        );
        const decide = () =>
          withOrgContext(tdb, { organizationId: ORG_A, userId: "" }, (tx) =>
            gate(tx as unknown as DbClient, ORG_A, SBX_MEMBER),
          );
        // flag ON (the suite default): live everywhere
        expect((await rowOf(ORG_A))?.status).toBe("active");
        expect(await decide()).toBe(true);
        expect(await settledReader()(ORG_A)).toBe(true);
        // flag OFF: the row is still `active`, but nothing serves it
        platformEnv.DOSESPOT_SANDBOX_ENABLED = undefined;
        try {
          expect((await rowOf(ORG_A))?.status).toBe("active");
          fetchLog.length = 0;
          const denied = await client.getPrescriptionStatus(ORG_A, "501", "77").catch((e) => e);
          expect(denied.name).toBe("NotEnabledError");
          expect(fetchLog).toHaveLength(0);
          expect(await decide()).toBe(false); // the order activates locally instead of stalling in `queued`
          expect(await settledReader()(ORG_A)).toBe(false);
        } finally {
          platformEnv.DOSESPOT_SANDBOX_ENABLED = "true";
        }
        // flag back ON: it serves again, with no change to the row
        expect(await decide()).toBe(true);
        expect(await settledReader()(ORG_A)).toBe(true);
      });

      it("a verified sandbox row cannot be activated while the flag is off (409 DOSESPOT_SANDBOX_NOT_ENABLED), but verifies and deactivates", async () => {
        await route.deactivate(tenantActor(ORG_A));
        platformEnv.DOSESPOT_SANDBOX_ENABLED = undefined;
        try {
          probeStatus = 200;
          expect((await route.verify(tenantActor(ORG_A))).view.status).toBe("verified"); // verify is open anywhere
          expect(await errorCode(route.activate(tenantActor(ORG_A)))).toBe(
            "DOSESPOT_SANDBOX_NOT_ENABLED",
          );
          expect((await rowOf(ORG_A))?.status).toBe("verified");
        } finally {
          platformEnv.DOSESPOT_SANDBOX_ENABLED = "true";
        }
        await route.activate(tenantActor(ORG_A));
        expect((await rowOf(ORG_A))?.status).toBe("active");
      });
    });

    // ── the wizard fact ──────────────────────────────────────────────────────────────────────────────
    describe("wizard step 10 settles from the registration", () => {
      const readerFor = (db: typeof tdb) => buildDoseSpotSettledReader(db, platformEnv);
      const advancer = () =>
        createOnboardingAdvancer({
          db: tdb,
          outbox: { publish: async () => undefined } as never,
          facts: { dosespotSettled: readerFor(tdb) },
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
        expect(await readerFor(tdb)(ORG_A)).toBe(true);
        await advancer()({ tenantAccountId: accountOf[ORG_A] as string, orgId: ORG_A });
        expect(await taskStatus(ORG_A)).toBe("done");
      });

      it("an org with no registration row never has the fact", async () => {
        expect(await readerFor(tdb)(ORG_D)).toBe(false);
      });

      it("the prescriber count does not gate: the fact is true with no prescriber enrolled", async () => {
        expect(
          await q(
            "SELECT 1 FROM dosespot_prescriber WHERE organization_id=$1 AND revoked_at IS NULL",
            [ORG_C],
          ),
        ).toHaveLength(0);
        probeStatus = 200;
        await route.verify(tenantActor(ORG_C));
        await route.activate(tenantActor(ORG_C));
        expect(await readerFor(tdb)(ORG_C)).toBe(true);
      });
    });

    // ── the whole suite: no vendor request ever ran inside a transaction ──────────────────────────
    describe("the vendor boundary, over every case above", () => {
      it("no token mint or clinician add ran while a tenant-pool transaction was open (the only vendor requests this suite makes)", () => {
        // the suite made real vendor traffic of every kind, on both lanes, so a zero below is a measurement and not an absence
        expect(vendorTraffic.tokenMints).toBeGreaterThan(5);
        expect(vendorTraffic.clinicianAdds).toBeGreaterThan(5);
        expect(txOpen).toBe(0);
        expect(vendorCallsInsideTx).toBe(0);
      });

      it("the instrument itself works: a vendor request inside a counted transaction IS counted", async () => {
        const before = vendorCallsInsideTx;
        await tdb.transaction(async () => {
          await fakeFetch("https://sandbox.dosespot.com/webapi/v2/connect/token", {
            method: "POST",
            headers: {},
          });
        });
        expect(vendorCallsInsideTx).toBe(before + 1);
        vendorCallsInsideTx = before; // un-count the deliberate probe
        expect(txOpen).toBe(0);
      });
    });
  },
);
