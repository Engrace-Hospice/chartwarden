/**
 * M3 role-template materialization (GAP-006) and role-grant scope (GAP-007), LIVE Postgres, as the RLS-enforced
 * `wardenx_app` role.
 *
 * Before: nothing in production created `role` rows, so a freshly provisioned tenant had none, the first-admin
 * acceptance threw "org_admin role template is unavailable", and `GET /me/permissions` was empty.
 *
 * What it proves (assertions on database rows):
 *   - migration 0600 mirrors the whole permission catalog, so the FK-backed grants can exist;
 *   - the M2 TenantOrgCreationProvider confirm (the M34 provisioning step) materializes the org's roles, with
 *     org_admin holding the non-platform catalog and NO cross-tenant `platform` key;
 *   - re-running is a no-op, and a tenant's edit (a removed grant) is never reverted;
 *   - the first administrator's role grant (the acceptor's membership_role insert) resolves a NON-EMPTY effective
 *     permission set through the real store;
 *   - tenant isolation: materializing org A creates nothing in org B, and org B cannot read org A's roles;
 *   - a materializer failure makes the provisioning confirm resolve `unavailable` (the worker retries).
 *
 *   GAP-007: a grant's `scope` is no longer write-only - the actor's stamped location reach is the union of the live
 *   roles' reach (never wider than the membership defaults), so `location_scope` denies a location outside every
 *   scoped grant; an expired scoped grant stops narrowing; an unscoped role restores the defaults.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m3:role-templates:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  allPermissionMirrorRows,
  createDbActorEnrichmentReader,
  createDbEffectivePermissionStore,
  locationScope,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantOrgCreationProvider } from "../src/modules/02-identity/tenant-org-creation-provider";
import {
  materializeRoleTemplatesForOrg,
  materializeRoleTemplatesInTx,
} from "../src/modules/03-authorization/role-template-materializer";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG_A = "44444444-4444-4444-8444-444444441001";
const ORG_B = "55555555-5555-4555-8555-555555551002";
const ORG_C = "66666666-6666-4666-8666-666666661003";

describe.skipIf(!DB_URL)("M3 role-template materialization, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  /** The org-spine credential (production: DATABASE_PLATFORM_URL); the spine is RLS-hidden from `wardenx_app`. */
  let spineHandle: ReturnType<typeof createDbClient>;

  const roleCount = async (org: string) =>
    (await admin.query("SELECT count(*)::int AS n FROM role WHERE organization_id=$1", [org]))
      .rows[0].n as number;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [id, slug] of [
      [ORG_A, "m3rt-a"],
      [ORG_B, "m3rt-b"],
      [ORG_C, "m3rt-c"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [id, slug],
      );
    }
    spineHandle = createDbClient({ connectionString: DB_URL as string });
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    await spineHandle?.close();
    await admin?.end();
  });

  it("migration 0600 mirrors the whole permission catalog (the FK target of every grant)", async () => {
    const mirrored = new Set(
      (await admin.query("SELECT key FROM permission")).rows.map((r) => r.key as string),
    );
    const missing = allPermissionMirrorRows().filter((r) => !mirrored.has(r.key));
    expect(missing.map((r) => r.key)).toEqual([]);
  });

  it("a fresh tenant starts with no roles (the defect), and the provisioning confirm materializes them", async () => {
    expect(await roleCount(ORG_A)).toBe(0);
    const provider = createTenantOrgCreationProvider(spineHandle.db, {
      onOrganizationAvailable: async (organizationId) => {
        await materializeRoleTemplatesForOrg(handle.db, organizationId);
      },
    });
    const result = await provider.createOrganizationForTenant({
      organizationId: ORG_A,
      legalBusinessName: "M3 Role Templates A",
    } as never);
    expect(result).toEqual({ kind: "available", organizationId: ORG_A });

    const keys = (
      await admin.query("SELECT key FROM role WHERE organization_id=$1 ORDER BY key", [ORG_A])
    ).rows.map((r) => r.key as string);
    expect(keys).toEqual(
      expect.arrayContaining(["org_admin", "administrator", "medical_director"]),
    );
    expect(keys.some((k) => k.startsWith("platform_"))).toBe(false);

    const granted = await admin.query(
      `SELECT p.category, count(*)::int AS n
         FROM role_permission rp JOIN role r ON r.id=rp.role_id JOIN permission p ON p.key=rp.permission_key
        WHERE r.organization_id=$1 AND r.key='org_admin' GROUP BY p.category`,
      [ORG_A],
    );
    const byCategory = new Map(granted.rows.map((r) => [r.category as string, r.n as number]));
    expect([...byCategory.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    expect(byCategory.has("platform")).toBe(false);
  });

  it("is idempotent and never reverts a tenant's edit", async () => {
    await admin.query(
      `DELETE FROM role_permission WHERE role_id=(SELECT id FROM role WHERE organization_id=$1 AND key='org_admin')
          AND permission_key='role.read'`,
      [ORG_A],
    );
    const before = await roleCount(ORG_A);
    const again = await materializeRoleTemplatesForOrg(handle.db, ORG_A);
    expect(again.rolesCreated).toEqual([]);
    expect(again.grantsCreated).toBe(0);
    expect(await roleCount(ORG_A)).toBe(before);
    const stillRemoved = await admin.query(
      `SELECT 1 FROM role_permission rp JOIN role r ON r.id=rp.role_id
        WHERE r.organization_id=$1 AND r.key='org_admin' AND rp.permission_key='role.read'`,
      [ORG_A],
    );
    expect(stillRemoved.rowCount).toBe(0);
  });

  it("the first administrator's org_admin grant resolves a non-empty effective permission set", async () => {
    const email = `first-admin-${randomUUID().slice(0, 8)}@m3-role-templates.test`;
    const userId = (
      await admin.query(
        `INSERT INTO "user" (email, email_verified, name) VALUES ($1,true,'First Admin') RETURNING id`,
        [email],
      )
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, ORG_A],
      )
    ).rows[0].id as string;
    // What the first-admin acceptance does: take the org's OWN org_admin row and grant it.
    const inTx = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      materializeRoleTemplatesInTx(tx, ORG_A),
    );
    expect(inTx.rolesCreated).toEqual([]); // already materialized by the provisioning confirm
    const roleId = (
      await admin.query("SELECT id FROM role WHERE organization_id=$1 AND key='org_admin'", [ORG_A])
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [ORG_A, membershipId, roleId],
    );
    const grants = await createDbEffectivePermissionStore(handle.db).loadGrants(ORG_A, userId);
    const permissions = new Set(grants.flatMap((g) => g.permissionKeys));
    expect(grants.map((g) => g.roleKey)).toContain("org_admin");
    expect(permissions.size).toBeGreaterThan(100);
    expect(permissions.has("member.invite")).toBe(true);
  });

  it("tenant isolation: org B has no roles until materialized, and cannot read org A's", async () => {
    expect(await roleCount(ORG_B)).toBe(0);
    const seenFromB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM role WHERE organization_id = ${ORG_A}::uuid`),
    );
    expect(JSON.stringify(seenFromB)).toContain('"n":0');
    await materializeRoleTemplatesForOrg(handle.db, ORG_B);
    expect(await roleCount(ORG_B)).toBeGreaterThan(0);
    expect(await roleCount(ORG_A)).toBe(await roleCount(ORG_B));
  });

  it("a materializer failure makes the provisioning confirm unavailable (the worker retries)", async () => {
    const provider = createTenantOrgCreationProvider(spineHandle.db, {
      onOrganizationAvailable: async () => {
        throw new Error("materializer down");
      },
    });
    const result = await provider.createOrganizationForTenant({
      organizationId: ORG_C,
      legalBusinessName: "M3 Role Templates C",
    } as never);
    expect(result.kind).toBe("unavailable");
    expect(await roleCount(ORG_C)).toBe(0);
  });

  it("GAP-007 a scoped grant narrows the actor's stamped location reach, and location_scope denies outside it", async () => {
    const LOC_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const LOC_Y = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const email = `scoped-${randomUUID().slice(0, 8)}@m3-role-templates.test`;
    const userId = (
      await admin.query(
        `INSERT INTO "user" (email, email_verified, name) VALUES ($1,true,'Scoped') RETURNING id`,
        [email],
      )
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status, default_location_ids) VALUES ($1,$2,'active',$3::jsonb) RETURNING id",
        [userId, ORG_B, JSON.stringify([LOC_X, LOC_Y])],
      )
    ).rows[0].id as string;
    const roleOf = async (key: string) =>
      (await admin.query("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [ORG_B, key]))
        .rows[0].id as string;
    const grant = (roleId: string, scope: object, expiresAt: string | null = null) =>
      admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id,scope,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5)",
        [ORG_B, membershipId, roleId, JSON.stringify(scope), expiresAt],
      );
    const read = () =>
      createDbActorEnrichmentReader(handle.db).read({ orgId: ORG_B }, userId) as Promise<{
        locationIds: string[];
      }>;
    const ctx = (locationIds: readonly string[]) =>
      ({ locationIds, providerEntityIds: [] }) as never;

    // Unscoped: the membership defaults, exactly as before.
    await grant(await roleOf("compliance_officer"), {});
    expect([...(await read()).locationIds].sort()).toEqual([LOC_X, LOC_Y]);
    await admin.query("DELETE FROM membership_role WHERE membership_id=$1", [membershipId]);

    // Scoped to X: the only reach is X; location_scope allows X and denies Y.
    await grant(await roleOf("compliance_officer"), { locationIds: [LOC_X] });
    const narrowed = await read();
    expect(narrowed.locationIds).toEqual([LOC_X]);
    expect(await locationScope(ctx(narrowed.locationIds), { locationId: LOC_X })).toBe(true);
    expect(await locationScope(ctx(narrowed.locationIds), { locationId: LOC_Y })).toBe(false);

    // An unscoped second role restores the defaults (a grant narrows only its own role).
    await grant(await roleOf("hipaa_privacy_officer"), {});
    expect([...(await read()).locationIds].sort()).toEqual([LOC_X, LOC_Y]);
    await admin.query("DELETE FROM membership_role WHERE membership_id=$1", [membershipId]);

    // An EXPIRED scoped grant stops narrowing (and confers nothing): back to the defaults.
    await grant(
      await roleOf("compliance_officer"),
      { locationIds: [LOC_X] },
      "2020-01-01T00:00:00Z",
    );
    expect([...(await read()).locationIds].sort()).toEqual([LOC_X, LOC_Y]);
  });
});
