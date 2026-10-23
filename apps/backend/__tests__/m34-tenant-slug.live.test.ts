/**
 * ADR-0049 phase 6 — an operator-chosen tenant slug through the REAL provisioning path, LIVE Postgres.
 *
 * `POST /api/v1/platform/tenants` accepts an optional `slug`. The database owns the rules (migration 1144: a
 * label trigger raising 23514, a never-reused alias table raising 23505); the app only translates them. This drives
 * `TenantPlatformRouteService.provisionTenant` over `createTenantOrgCreationProvider` (M2's real org writer). Both run on
 * the BYPASSRLS `chartwarden_platform_login` that `scripts/db/provision-runtime-roles.ts` builds (executed here), because
 * that is the credential production binds as `organizationDb`; a missing grant fails here, not in a provisioning. The
 * plain `chartwarden_app` role cannot insert an organization at all (RLS), which the first test pins. This proves:
 *   - a free slug is the organization's slug and is audited in the ledger's `side_effects_recorded`;
 *   - a taken slug, a former (aliased) slug and a slug the label rules refuse are all 409 TENANT_SLUG_UNAVAILABLE, and
 *     a refused request leaves no tenant account behind;
 *   - a re-provision naming a DIFFERENT slug is 409 (never a silent ignore); naming the same one is accepted;
 *   - no slug still yields a valid generated label.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… (SUPERUSER, THROWAWAY db) bun run test:m34:tenant-slug:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { validateTenantSlug } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createTenantOrgCreationProvider } from "../src/modules/02-identity/tenant-org-creation-provider";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  type DrizzleTenantPlatformDeps,
  createDrizzleTenantPlatformBackend,
} from "../src/modules/34-saas-tenant-platform/routes/platform/service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_platform_login",
  "chartwarden_platform",
  "chartwarden_destruction_login",
  "chartwarden_destruction",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "tenant_platform_writer",
];
const PLATFORM_PASSWORD = "slug34_platform_live_test";
const PLATFORM_JOB_ID = "test-m34-tenant-slug";
const ACTOR_MEMBERSHIP = "44444444-4444-4444-8444-44440034ab04";
const BASE_ARGS = {
  billingContactEmail: "billing@slug.example",
  breachNotificationContactEmail: "privacy@slug.example",
  firstAdminEmail: "ada@slug.example",
  firstAdminFullName: "Ada Admin",
  planLabel: "standard",
} as const;

describe.skipIf(!DB_URL)("M34 tenant slug provisioning — LIVE Postgres, real platform role", () => {
  let admin: Client;
  let platformDb: ReturnType<typeof createDbClient>;
  let appDb: ReturnType<typeof createDbClient>;
  let seq = 0;

  const nextId = (): string => `7${String(++seq).padStart(7, "0")}-0000-4000-8000-00000034ab00`;

  async function applyMigrations(): Promise<void> {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
    // The REAL provisioning script: the carrier role with its enumerated grants + the BYPASSRLS login.
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
    registerPlatformJob(PLATFORM_JOB_ID);
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "chartwarden_platform_login";
    platformUrl.password = PLATFORM_PASSWORD;
    platformDb = createDbClient({ connectionString: platformUrl.toString() });
    appDb = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 600_000);

  afterAll(async () => {
    await appDb?.close();
    await platformDb?.close();
    await admin?.end();
  });

  function service() {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    const provider = createTenantOrgCreationProvider(platformDb.db);
    const unused = async (): Promise<never> => {
      throw new Error("not used by this suite");
    };
    const deps: DrizzleTenantPlatformDeps = {
      platformDb: platformDb.db,
      enqueue: { enqueue: async (queue, jobKey) => ({ jobId: `${queue}-${jobKey}` }) },
      legalHoldClear: async () => true,
      invitationDelivery: { acceptBaseUrl: "http://localhost/tenant-invite", send: unused },
      provisionJobs: { status: unused, retry: unused },
      auditBypass: async () => {},
      outbox: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
      },
      organizations: {
        async ensure(input) {
          const result = await provider.createOrganizationForTenant(input);
          if (result.kind !== "available")
            throw new Error(`org creation unavailable: ${result.reason}`);
          return { organizationId: result.organizationId };
        },
      },
      featureFlags: { list: unused, upsert: unused, setKillSwitch: unused },
      lifecycleAlerts: {
        emit: async () => ({ alertId: "none", resolvedRecipientCount: 0 }),
      } as AlertEmitter,
      supportSessionPorts: {
        audit: { async emitCriticalAudit() {} },
        outbox: { async publish() {} },
        alerts: { async emitAlert() {} },
        now: () => new Date(),
      },
      platformJobId: PLATFORM_JOB_ID,
    };
    return createDrizzleTenantPlatformBackend(deps).service;
  }

  const provision = (legalBusinessName: string, slug?: string, signupIntentId?: string) =>
    service().provisionTenant(ACTOR_MEMBERSHIP, {
      signupIntentId: signupIntentId ?? null,
      legalBusinessName,
      ...(slug !== undefined ? { slug } : {}),
      ...BASE_ARGS,
    });

  /** The refusal the route would turn into a 409 envelope. */
  async function refusal(
    run: () => Promise<unknown>,
  ): Promise<{ code?: string; statusCode?: number } | null> {
    try {
      await run();
    } catch (e) {
      return e as { code?: string; statusCode?: number };
    }
    return null;
  }

  const orgBySlug = async (slug: string) =>
    (await admin.query("SELECT id FROM organization WHERE slug = $1", [slug])).rows;
  const accountsNamed = async (name: string) =>
    (await admin.query("SELECT id FROM tenant_account WHERE legal_business_name = $1", [name]))
      .rows;

  it("runs on the BYPASSRLS platform login, not a superuser; the plain app role cannot create an organization", async () => {
    const who = await platformDb.pool.query(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
    );
    expect(who.rows[0]).toMatchObject({
      current_user: "chartwarden_platform_login",
      rolsuper: false,
      rolbypassrls: true,
    });

    const appInsert = appDb.pool.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'app-role-probe','L','D')",
      [nextId()],
    );
    await expect(appInsert).rejects.toMatchObject({ code: "42501" });
  });

  it("a free slug becomes the organization's slug and is audited on the ledger", async () => {
    await provision("Cedar Ridge Hospice LLC", "cedar-ridge");

    expect(await orgBySlug("cedar-ridge")).toHaveLength(1);
    const ledger = await admin.query(
      `SELECT e.side_effects_recorded
         FROM tenant_account_status_event e JOIN tenant_account a ON a.id = e.tenant_account_id
        WHERE a.legal_business_name = 'Cedar Ridge Hospice LLC'`,
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].side_effects_recorded).toMatchObject({
      queue: "tenant.provision",
      slug: "cedar-ridge",
    });
  });

  it("a slug another organization holds is 409 and leaves no tenant account behind", async () => {
    const err = await refusal(() => provision("Copycat Hospice LLC", "cedar-ridge"));

    expect(err).toMatchObject({ code: "TENANT_SLUG_UNAVAILABLE", statusCode: 409 });
    expect(await accountsNamed("Copycat Hospice LLC")).toHaveLength(0);
    expect(await orgBySlug("cedar-ridge")).toHaveLength(1);
  });

  it("a slug an organization used to have is never reused: 409", async () => {
    const id = nextId();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'old-name','Old','Old')",
      [id],
    );
    await admin.query("UPDATE organization SET slug = 'new-name' WHERE id = $1", [id]);
    expect(
      (
        await admin.query("SELECT alias FROM organization_slug_alias WHERE organization_id=$1", [
          id,
        ])
      ).rows,
    ).toEqual([{ alias: "old-name" }]);

    const err = await refusal(() => provision("Latecomer Hospice LLC", "old-name"));

    expect(err).toMatchObject({ code: "TENANT_SLUG_UNAVAILABLE", statusCode: 409 });
    expect(await accountsNamed("Latecomer Hospice LLC")).toHaveLength(0);
  });

  // The route validates these first (422); the database is the backstop and its refusal must still read as a 409.
  it.each(["ab", "admin", "xn--nxasmq6b", "Mixed-Case", "-leading", "trailing-", "under_score"])(
    "the database's own label rule refuses %s as 409, not a 500",
    async (slug) => {
      expect(validateTenantSlug(slug).ok).toBe(false);
      const name = `Rules Hospice ${slug} LLC`;

      const err = await refusal(() => provision(name, slug));

      expect(err).toMatchObject({ code: "TENANT_SLUG_UNAVAILABLE", statusCode: 409 });
      expect(await accountsNamed(name)).toHaveLength(0);
    },
  );

  it("re-provisioning the same tenant with a DIFFERENT slug is 409; with the same slug it is accepted", async () => {
    const intent = nextId();
    await provision("Harbor Hospice LLC", "harbor-hospice", intent);

    const different = await refusal(() => provision("Harbor Hospice LLC", "harbor-two", intent));
    expect(different).toMatchObject({ code: "TENANT_SLUG_UNAVAILABLE", statusCode: 409 });
    expect(await orgBySlug("harbor-two")).toHaveLength(0);

    await expect(provision("Harbor Hospice LLC", "harbor-hospice", intent)).resolves.toBeDefined();
    expect(await accountsNamed("Harbor Hospice LLC")).toHaveLength(1);
  });

  it("with no slug a valid label is generated", async () => {
    await provision("Maple & Pine Hospice, Inc.");

    const { rows } = await admin.query(
      `SELECT o.slug FROM organization o JOIN tenant_account a ON a.organization_id = o.id
        WHERE a.legal_business_name = 'Maple & Pine Hospice, Inc.'`,
    );
    expect(rows).toHaveLength(1);
    expect(validateTenantSlug(rows[0].slug).ok).toBe(true);
    expect(rows[0].slug).toMatch(/^maple-pine-hospice-inc-[0-9a-f]{8}$/);
  });
});
