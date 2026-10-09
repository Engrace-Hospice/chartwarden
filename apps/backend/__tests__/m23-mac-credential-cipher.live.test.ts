/**
 * M23 MAC-portal credential secret cipher — LIVE Postgres proof (the `SEAM_UNBOUND` 503 fix).
 *
 * `POST /api/v1/billing/mac-credentials` answered 503 "the secret-cipher port is not bound" because the composition root
 * never bound `ports.secretCipher`. This drives the REAL route (Fastify + the real guards, a stand-in only for the M3
 * provider-scope and step-up predicates, as in m23-visit-charge-routes.test.ts) over the REAL write/read services on the
 * NOBYPASSRLS `wardenx_app` role and the REAL cipher built from the same env factory the composition root uses, and proves:
 *   - 201 on create, the stored column is an AES-GCM envelope (not the plaintext, not recoverable without the key),
 *     `client_secret_dek_version` is stamped, and neither the response, a re-read, nor the audit trail carry the secret;
 *   - the stored value round-trips through the cipher's decrypt (what the MAC submit worker will call) and only under
 *     the owning org;
 *   - a second POST without If-Match is 428 and with If-Match re-seals (new ciphertext, version bumped);
 *   - without a bound cipher the route is still a fail-closed 503 (never plaintext at rest).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:mac-credential-cipher:live
 */
import { randomBytes } from "node:crypto";
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
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerMacCredentialRoutes } from "../src/modules/23-billing-medicare/routes/mac-credentials.routes";
import { buildDrizzleM23ReadService } from "../src/modules/23-billing-medicare/routes/read-service-drizzle";
import { buildMacSecretCipherFromEnv } from "../src/modules/23-billing-medicare/routes/secret-cipher";
import { buildDrizzleM23WriteService } from "../src/modules/23-billing-medicare/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const PE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "live-test-mac-client-secret-9f3a";
const KEK_B64 = randomBytes(32).toString("base64");

function headerAuth(request: FastifyRequest): void {
  if (request.headers["x-test-user"] !== "admin") return;
  request.context.userId = USER;
  request.context.organizationId = ORG;
  request.context.roles = ["org_admin"];
  request.context.attributes.membershipId = MEMBERSHIP;
  request.context.attributes.stepUpRecent = true;
}

const BODY = {
  providerEntityId: PE,
  macJurisdiction: "cgs_j15",
  submitterId: "SUB-1",
  tradingPartnerId: "TP-1",
  clientId: "client-1",
  clientSecret: SECRET,
};
let idem = 0;
const headers = (extra: Record<string, string> = {}) => ({
  "x-test-user": "admin",
  "idempotency-key": `mac-${++idem}`,
  ...extra,
});

describe.skipIf(!DB_URL)("M23 MAC credential cipher — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  const servers: FastifyInstance[] = [];

  function serverWith(env: Record<string, string | undefined>): FastifyInstance {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: USER,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.mac_credential.read", "billing.mac_credential.admin"],
            },
          ],
        },
      ]).store,
    );
    const reg = createPredicateRegistry();
    reg.register("provider_entity_billing_scope", async () => true);
    reg.register("step_up_recent", async () => true);
    registerAbacRegistry(reg);
    const secretCipher = buildMacSecretCipherFromEnv(env);
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerMacCredentialRoutes(app, {
      readService: buildDrizzleM23ReadService(handle.db),
      writeService: buildDrizzleM23WriteService(handle.db, secretCipher ? { secretCipher } : {}),
    });
    servers.push(app);
    return app;
  }

  const stored = async () =>
    (
      await admin.query(
        "SELECT client_secret_cipher, client_secret_dek_version, version FROM mac_submitter_credential WHERE provider_entity_id=$1",
        [PE],
      )
    ).rows;

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    for (const [id, slug] of [
      [ORG, "org-a"],
      [OTHER_ORG, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [id, slug, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'mc@x.test')`, [USER]);
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 240_000);

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("503s fail-closed, storing nothing, when no cipher is bound", async () => {
    const app = serverWith({});
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/mac-credentials",
      headers: headers(),
      payload: BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(SECRET);
    expect(await stored()).toHaveLength(0);
  });

  it("201s, stores only ciphertext, and never returns or logs the secret", async () => {
    const env = { M24_CREDENTIAL_ENCRYPTION_KEY: KEK_B64 };
    const app = serverWith(env);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/mac-credentials",
      headers: headers(),
      payload: BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toMatch(/cipher/i);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    const { client_secret_cipher: sealed, client_secret_dek_version: dekVersion } = rows[0];
    expect(dekVersion).toBe(1);
    expect(sealed).not.toContain(SECRET);
    expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain(SECRET);

    // The read-back that a worker will perform: openable by the same key for the owning org only.
    const cipher = buildMacSecretCipherFromEnv(env);
    expect(await cipher?.decrypt(ORG, sealed)).toBe(SECRET);
    await expect(cipher?.decrypt(OTHER_ORG, sealed)).rejects.toThrow();
    await expect(
      buildMacSecretCipherFromEnv({
        M24_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      })?.decrypt(ORG, sealed),
    ).rejects.toThrow();

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/billing/mac-credentials/${PE}`,
      headers: { "x-test-user": "admin" },
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(SECRET);
    expect(get.body).not.toContain(sealed);

    const audit = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE before::text LIKE $1 OR after::text LIKE $1 OR context::text LIKE $1",
      [`%${SECRET}%`],
    );
    expect(audit.rows[0].n).toBe(0);
    const outbox = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE payload::text LIKE $1",
      [`%${SECRET}%`],
    );
    expect(outbox.rows[0].n).toBe(0);
  });

  it("re-seals on update (428 without If-Match, then a fresh ciphertext with it)", async () => {
    const env = { M24_CREDENTIAL_ENCRYPTION_KEY: KEK_B64 };
    const app = serverWith(env);
    const before = (await stored())[0];
    const noMatch = await app.inject({
      method: "POST",
      url: "/api/v1/billing/mac-credentials",
      headers: headers(),
      payload: BODY,
    });
    expect(noMatch.statusCode).toBe(428);
    const rotated = "rotated-secret-7c1d";
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/billing/mac-credentials",
      headers: headers({ "if-match": String(before.version) }),
      payload: { ...BODY, clientSecret: rotated },
    });
    expect(ok.statusCode).toBeLessThan(300);
    const after = (await stored())[0];
    expect(after.client_secret_cipher).not.toBe(before.client_secret_cipher);
    expect(await buildMacSecretCipherFromEnv(env)?.decrypt(ORG, after.client_secret_cipher)).toBe(
      rotated,
    );
  });
});
