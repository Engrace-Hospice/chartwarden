/**
 * M2 — POST /provider-entities seals the EIN through the real tax-id cipher, LIVE Postgres, real NOBYPASSRLS
 * `chartwarden_app`. The unit suite (`tax-id-cipher.test.ts`, `gap-115-m2-org-admin.test.ts`) proves the cipher and the
 * route against an in-memory store and a stub cipher; this proves what only a real catalog can:
 *   - `provider_entity.tax_id_encrypted` holds a `v2.` envelope, never the EIN, and it opens back to the EIN;
 *   - a failing tenant key answers 503 and writes NO row (the NOT NULL column is never filled with a placeholder);
 *   - org B's session cannot read org A's provider entity, and A's envelope refuses to open under B (AAD binds the org);
 *   - an envelope moved to another provider_entity row of the SAME org refuses to open (AAD binds the row id).
 * The key ring itself (KEK unwrap, wrapped-DEK table) is proven by `m34-tenant-key-provider.live.test.ts`; here a
 * per-org in-test provider stands in for it.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m2:tax-id-cipher:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountOrgAdminRoutes } from "../src/modules/02-identity/index";
import { type TaxIdKeyProvider, createTaxIdCipher } from "../src/modules/02-identity/tax-id-cipher";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-1111f2060101";
const ORG_B = "22222222-2222-4222-8222-2222f2060102";
const ADMIN_A = "33333333-3333-4333-8333-3333f2060103";
const ADMIN_B = "44444444-4444-4444-8444-4444f2060104";
const NEW_PE = {
  ccn: "444444",
  npi: "1679576722",
  legalName: "Sierra Hospice",
  taxId: "12-3456789",
  fiscalYearEnd: "0630",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.sessionId = "sess";
  request.context.attributes.membershipId = `m_${user}`;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["org_admin"];
}

const AS_A = { "x-test-user": ADMIN_A, "x-test-org": ORG_A };
const AS_B = { "x-test-user": ADMIN_B, "x-test-org": ORG_B };

/** A per-org DEK ring with one version; `failing()` simulates a destroyed/missing tenant key. */
function keyRing(failing: () => boolean): TaxIdKeyProvider {
  const deks = new Map<string, Buffer>();
  const dek = async (orgId: string) => {
    if (failing()) throw new Error("TenantKeyMissing: simulated");
    if (!deks.has(orgId)) deks.set(orgId, randomBytes(32));
    return { version: "1", key: deks.get(orgId) as Buffer };
  };
  return { dekForOrg: dek, dekForOrgVersion: (orgId) => dek(orgId) };
}

describe.skipIf(!DB_URL)("M2 tax-id cipher — LIVE Postgres, real chartwarden_app role", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof buildServer>;
  let keysFail = false;
  const cipher = createTaxIdCipher(keyRing(() => keysFail));

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
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let ddl = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        ddl = ddl.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(ddl);
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f2060-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f2060-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES
         ($1,'f2060-a@example.test','Admin A'),($2,'f2060-b@example.test','Admin B')`,
      [ADMIN_A, ADMIN_B],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [
          { orgId: ORG_A, userId: ADMIN_A },
          { orgId: ORG_B, userId: ADMIN_B },
        ].map(({ orgId, userId }) => ({
          orgId,
          userId,
          grants: [
            {
              roleKey: "org_admin",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["org.manage"],
            },
          ],
        })),
      ).store,
    );
    registerAbacRegistry(createPredicateRegistry({}));
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountOrgAdminRoutes(app, handle.db, { taxIdCipher: cipher });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  const rowsFor = (orgId: string) =>
    admin.query(
      "SELECT id, ccn, tax_id_encrypted FROM provider_entity WHERE organization_id = $1",
      [orgId],
    );

  it("stores a v2 envelope, never the EIN, and the envelope opens back to the EIN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: AS_A,
      payload: NEW_PE,
    });
    expect(res.statusCode).toBe(201);

    const { rows } = await rowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    const sealed = rows[0].tax_id_encrypted as string;
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(sealed).not.toContain("123456789");
    expect(res.body).not.toContain("123456789");
    expect(
      await cipher.decrypt({ organizationId: ORG_A, providerEntityId: rows[0].id, sealed }),
    ).toBe("123456789");
  });

  it("answers 503 and writes no row when the tenant key is unavailable", async () => {
    keysFail = true;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-entities",
        headers: AS_B,
        payload: { ...NEW_PE, ccn: "555555", npi: "1003000126" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain("TAX_ID_KEY_UNAVAILABLE");
      expect(res.body).not.toContain("TenantKeyMissing");
    } finally {
      keysFail = false;
    }
    expect((await rowsFor(ORG_B)).rows).toHaveLength(0);
  });

  it("org B cannot read org A's provider entity, and A's envelope refuses to open under B", async () => {
    const [row] = (await rowsFor(ORG_A)).rows;

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/provider-entities/${row.id}`,
      headers: AS_B,
    });
    expect(read.statusCode).toBe(404);

    await expect(
      cipher.decrypt({
        organizationId: ORG_B,
        providerEntityId: row.id,
        sealed: row.tax_id_encrypted as string,
      }),
    ).rejects.toThrow();
  });

  it("an envelope moved to another provider entity of the same org refuses to open", async () => {
    const [first] = (await rowsFor(ORG_A)).rows;
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: AS_A,
      payload: { ...NEW_PE, ccn: "666666", npi: "1003000126", taxId: "98-7654321" },
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json().id as string;

    // Simulate the lift: copy row 1's sealed EIN into row 2 (admin connection, bypassing RLS).
    await admin.query("UPDATE provider_entity SET tax_id_encrypted = $1 WHERE id = $2", [
      first.tax_id_encrypted,
      secondId,
    ]);
    const { rows } = await admin.query(
      "SELECT tax_id_encrypted FROM provider_entity WHERE id = $1",
      [secondId],
    );

    await expect(
      cipher.decrypt({
        organizationId: ORG_A,
        providerEntityId: secondId,
        sealed: rows[0].tax_id_encrypted as string,
      }),
    ).rejects.toThrow();
    // ...while row 1's own id still opens it.
    expect(
      await cipher.decrypt({
        organizationId: ORG_A,
        providerEntityId: first.id,
        sealed: first.tax_id_encrypted as string,
      }),
    ).toBe("123456789");
  });
});
