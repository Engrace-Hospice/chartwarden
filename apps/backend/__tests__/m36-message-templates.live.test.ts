/**
 * M36 WP 2.8 - message templates and saved replies, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack mounted by `mountMessagingRoutes` (so the composition wiring is proved, not assumed) over the
 * Drizzle TemplateService: personal replies private to their owner, shared templates, the platform floor and a tenant
 * overlay that can never loosen it, the PHI lint (nothing stored on a refusal), RLS (a tenant reads the platform scope
 * and can never write it; no cross-tenant read or write), the audit trail with the body scrubbed, and the read audit.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:templates:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
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
import { type DbClient, createDbClient } from "@chartwarden/db";
import { PLATFORM_MESSAGE_TEMPLATES, lintTemplateText } from "@chartwarden/messaging";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { mountMessagingRoutes } from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-1111000f0028";
const ORG_B = "22222222-2222-4222-8222-2222000f0028";
const emergency = PLATFORM_MESSAGE_TEMPLATES.find((t) => t.requiredPhrases.length > 0)!;
const ok = {
  title: "Running late",
  body: "I am running a few minutes behind.",
  category: "scheduling",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
  request.context.locationIds = [];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VOLATILE = new Set(["requestId", "correlationId", "timestamp", "traceId"]);
/** Status + body with ids and per-request fields masked, so a real id and a random id compare exactly. */
function shape(res: { statusCode: number; body: string }): string {
  const scrub = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(scrub)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !VOLATILE.has(k))
              .map(([k, x]) => [k, scrub(x)]),
          )
        : typeof v === "string"
          ? v.replace(UUID, "<id>")
          : v;
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // compared verbatim
  }
  return `${res.statusCode} ${JSON.stringify(scrub(body))}`;
}

describe.skipIf(!DB_URL)("M36 WP 2.8 message templates - LIVE Postgres", () => {
  let admin: Client;
  let appClient: Client; // a raw wardenx_app connection for RLS assertions
  let handle: { db: DbClient; close: () => Promise<void> };
  let app: FastifyInstance;
  let alice: string; // org A sender
  let bob: string; // org A sender
  let boss: string; // org A template manager
  let carol: string; // org B sender
  let carolBoss: string; // org B template manager
  let capUser: string; // org A sender used for the per-user cap

  const as = (userId: string, org = ORG_A, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": org,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    userId: string,
    org = ORG_A,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: as(userId, org, method === "POST" ? randomUUID() : undefined),
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await admin.query(sql, params)).rows[0].n);

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  const seedUser = async (suffix: string, organizationId: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp28-${suffix}@x.test`,
        `WP28 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };

  /** Run SQL as wardenx_app with the tenant GUCs set, in a transaction that is always rolled back. */
  async function asApp<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
    await appClient.query("BEGIN");
    try {
      await appClient.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [orgId, userId],
      );
      return await fn();
    } finally {
      await appClient.query("ROLLBACK");
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
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp28-a','A','A'),($2,'wp28-b','B','B')`,
      [ORG_A, ORG_B],
    );
    alice = await seedUser("alice", ORG_A);
    bob = await seedUser("bob", ORG_A);
    boss = await seedUser("boss", ORG_A);
    carol = await seedUser("carol", ORG_B);
    carolBoss = await seedUser("carolboss", ORG_B);
    capUser = await seedUser("cap", ORG_A);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    appClient = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await appClient.connect();

    const grant = (orgId: string, userId: string, permissionKeys: string[]) => ({
      orgId,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(ORG_A, alice, ["messaging.send"]),
        grant(ORG_A, bob, ["messaging.send"]),
        grant(ORG_A, capUser, ["messaging.send"]),
        grant(ORG_A, boss, ["messaging.send", "messaging.template.manage"]),
        grant(ORG_B, carol, ["messaging.send"]),
        grant(ORG_B, carolBoss, ["messaging.send", "messaging.template.manage"]),
      ]).store,
    );
    registerAbacRegistry(createPredicateRegistry());
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    // The real composition-root mount: proves the template routes are wired, not just defined.
    mountMessagingRoutes(app, handle.db);
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await appClient?.end();
    await admin?.end();
  });

  describe("the platform floor", () => {
    it("the seeded rows are what the code says, in non-clinical categories, and every one passes the lint", async () => {
      const rows = (
        await admin.query(
          `SELECT id, template_key, category, title, body, required_phrases FROM message_template WHERE scope='platform'`,
        )
      ).rows;
      expect(rows).toHaveLength(PLATFORM_MESSAGE_TEMPLATES.length);
      for (const r of rows) {
        expect(lintTemplateText(r.title)).toEqual([]);
        expect(lintTemplateText(r.body)).toEqual([]);
        for (const phrase of r.required_phrases as string[]) {
          expect((r.body as string).toLowerCase()).toContain(phrase.toLowerCase());
        }
      }
      expect(rows.map((r) => r.category as string).sort()).not.toContain("sbar");
    });

    it("every tenant sees the platform scope through the picker", async () => {
      for (const [user, org] of [
        [alice, ORG_A],
        [carol, ORG_B],
      ] as const) {
        const res = await call("GET", "/api/v1/messaging/templates", user, org);
        expect(res.statusCode).toBe(200);
        expect(res.json().items).toHaveLength(PLATFORM_MESSAGE_TEMPLATES.length);
      }
    });

    it("as wardenx_app a tenant can READ platform rows but never insert, update or delete one (RLS)", async () => {
      await asApp(ORG_A, boss, async () => {
        const seen = await appClient.query(
          `SELECT count(*)::int AS n FROM message_template WHERE scope='platform'`,
        );
        expect(seen.rows[0].n).toBe(PLATFORM_MESSAGE_TEMPLATES.length);
        await expect(
          appClient.query(
            `INSERT INTO message_template (scope, template_key, category, title, body) VALUES ('platform','x.y','general','t','b')`,
          ),
        ).rejects.toThrow(/row-level security|violates/i);
      });
      await asApp(ORG_A, boss, async () => {
        const upd = await appClient.query(
          `UPDATE message_template SET body='hijacked' WHERE scope='platform'`,
        );
        expect(upd.rowCount).toBe(0);
      });
      await asApp(ORG_A, boss, async () => {
        const del = await appClient.query(`DELETE FROM message_template WHERE scope='platform'`);
        expect(del.rowCount).toBe(0);
      });
      expect(
        await count(
          `SELECT count(*) AS n FROM message_template WHERE scope='platform' AND body='hijacked'`,
        ),
      ).toBe(0);
    });

    it("a tenant cannot re-scope its own row to platform (WITH CHECK)", async () => {
      const created = await call("POST", "/api/v1/messaging/template-admin/shared", boss, ORG_A, {
        ...ok,
        title: "Rescope probe",
      });
      expect(created.statusCode).toBe(201);
      await asApp(ORG_A, boss, async () => {
        await expect(
          appClient.query(
            `UPDATE message_template SET scope='platform', organization_id=NULL, template_key='z.z' WHERE id=$1`,
            [created.json().id],
          ),
        ).rejects.toThrow(/row-level security|violates/i);
      });
    });
  });

  describe("shape constraints (as the superuser, so only the schema stands in the way)", () => {
    it("a personal row needs an owner, an org row must not have one, a platform row has neither org nor owner", async () => {
      const insert = (cols: string, vals: string) =>
        admin.query(
          `INSERT INTO message_template (${cols}, category, title, body) VALUES (${vals}, 'general', 't', 'b')`,
        );
      await expect(insert("scope, organization_id", `'personal', '${ORG_A}'`)).rejects.toThrow(
        /scope_shape/,
      );
      await expect(
        insert("scope, organization_id, owner_user_id", `'org', '${ORG_A}', '${alice}'`),
      ).rejects.toThrow(/scope_shape/);
      await expect(
        insert("scope, organization_id, template_key", `'platform', '${ORG_A}', 'a.b'`),
      ).rejects.toThrow(/scope_shape/);
      await expect(insert("scope, organization_id", `'org', NULL`)).rejects.toThrow(/scope_shape/);
    });

    it("an unknown category (including a clinical SBAR one) is refused by the database", async () => {
      await expect(
        admin.query(
          `INSERT INTO message_template (scope, organization_id, category, title, body) VALUES ('org','${ORG_A}','sbar','t','b')`,
        ),
      ).rejects.toThrow(/category_valid/);
    });

    it("an overlay can only point at a PLATFORM template: not an org template, not another tenant's", async () => {
      const orgTemplate = (
        await admin.query(
          `INSERT INTO message_template (scope, organization_id, category, title, body) VALUES ('org','${ORG_B}','general','Other tenant','b') RETURNING id`,
        )
      ).rows[0].id as string;
      await expect(
        admin.query(
          `INSERT INTO tenant_message_template_overlay (organization_id, template_id, configured_by_user_id) VALUES ($1,$2,$3)`,
          [ORG_A, orgTemplate, boss],
        ),
      ).rejects.toThrow(/template_fk|foreign key/i);
      await expect(
        admin.query(
          `INSERT INTO tenant_message_template_overlay (organization_id, target_scope, template_id, configured_by_user_id) VALUES ($1,'org',$2,$3)`,
          [ORG_A, orgTemplate, boss],
        ),
      ).rejects.toThrow(/target_platform|check/i);
    });
  });

  describe("personal saved replies", () => {
    it("are stored under the caller's org and user, private to them, and not visible to a colleague or another org", async () => {
      const created = await call("POST", "/api/v1/messaging/templates/personal", alice, ORG_A, ok);
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const row = (await admin.query(`SELECT * FROM message_template WHERE id=$1`, [id])).rows[0];
      expect(row).toMatchObject({
        organization_id: ORG_A,
        owner_user_id: alice,
        scope: "personal",
        created_by_user_id: alice,
      });

      const ids = async (user: string, org: string) =>
        (
          (await call("GET", "/api/v1/messaging/templates", user, org)).json().items as Array<{
            id: string;
          }>
        ).map((i) => i.id);
      expect(await ids(alice, ORG_A)).toContain(id);
      expect(await ids(bob, ORG_A)).not.toContain(id);
      expect(await ids(carol, ORG_B)).not.toContain(id);
    });

    it("a colleague, another org and a random id all get the same 404 on read, patch and delete", async () => {
      const id = (
        await call("POST", "/api/v1/messaging/templates/personal", alice, ORG_A, {
          ...ok,
          title: "Mine",
        })
      ).json().id as string;
      const randomId = randomUUID();
      const probes: Array<[string, string]> = [
        ["GET", `/api/v1/messaging/templates/`],
        ["PATCH", `/api/v1/messaging/templates/personal/`],
        ["DELETE", `/api/v1/messaging/templates/personal/`],
      ];
      for (const [method, base] of probes) {
        const payload = method === "PATCH" ? { body: "x" } : undefined;
        const real = shape(await call(method as never, `${base}${id}`, bob, ORG_A, payload));
        const random = shape(
          await call(method as never, `${base}${randomId}`, bob, ORG_A, payload),
        );
        const foreign = shape(await call(method as never, `${base}${id}`, carol, ORG_B, payload));
        expect(real, method).toBe(random);
        expect(foreign, method).toBe(random);
        expect(real.startsWith("404")).toBe(true);
      }
      expect(await count(`SELECT count(*) AS n FROM message_template WHERE id=$1`, [id])).toBe(1);
      const garbage = await call("GET", "/api/v1/messaging/templates/not-a-uuid", alice);
      expect(garbage.statusCode).toBe(404);
    });

    it("update and delete by the owner work; a duplicate title is a 409; the cap is a 409", async () => {
      const a = await call("POST", "/api/v1/messaging/templates/personal", bob, ORG_A, {
        ...ok,
        title: "Dup",
      });
      expect(a.statusCode).toBe(201);
      const dup = await call("POST", "/api/v1/messaging/templates/personal", bob, ORG_A, {
        ...ok,
        title: "dup",
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe("TEMPLATE_TITLE_TAKEN");
      const patched = await call(
        "PATCH",
        `/api/v1/messaging/templates/personal/${a.json().id}`,
        bob,
        ORG_A,
        { body: "Updated." },
      );
      expect(patched.json().body).toBe("Updated.");
      const del = await call(
        "DELETE",
        `/api/v1/messaging/templates/personal/${a.json().id}`,
        bob,
        ORG_A,
      );
      expect(del.statusCode).toBe(204);

      await admin.query(
        `INSERT INTO message_template (scope, organization_id, owner_user_id, category, title, body)
         SELECT 'personal', $1, $2, 'general', 'bulk ' || g, 'body' FROM generate_series(1, 50) g`,
        [ORG_A, capUser],
      );
      const over = await call("POST", "/api/v1/messaging/templates/personal", capUser, ORG_A, {
        ...ok,
        title: "one more",
      });
      expect(over.statusCode).toBe(409);
      expect(over.json().error.code).toBe("TEMPLATE_LIMIT_REACHED");
    });
  });

  describe("the PHI lint is enforced on save, and nothing is stored on a refusal", () => {
    it("rejects each identifier shape on every write path with a 422 that never echoes the text", async () => {
      const before = await count(
        `SELECT count(*) AS n FROM message_template WHERE scope <> 'platform'`,
      );
      const secrets = [
        "123-45-6789",
        "415-555-0134",
        "jane.doe@example.com",
        "03/14/2026",
        "MRN: AB12",
      ];
      for (const secret of secrets) {
        const body = `Reminder about ${secret} please`;
        const attempts = [
          await call("POST", "/api/v1/messaging/templates/personal", alice, ORG_A, {
            ...ok,
            title: `p ${secrets.indexOf(secret)}`,
            body,
          }),
          await call("POST", "/api/v1/messaging/template-admin/shared", boss, ORG_A, {
            ...ok,
            title: `s ${secrets.indexOf(secret)}`,
            body,
          }),
          await call(
            "PUT",
            `/api/v1/messaging/template-admin/platform/${PLATFORM_MESSAGE_TEMPLATES[0]!.id}/overlay`,
            boss,
            ORG_A,
            {
              title: null,
              body,
              isEnabled: true,
            },
          ),
        ];
        for (const res of attempts) {
          expect(res.statusCode, secret).toBe(422);
          expect(res.json().error.code).toBe("TEMPLATE_PHI_DETECTED");
          expect(res.body).not.toContain(secret);
        }
      }
      expect(
        await count(`SELECT count(*) AS n FROM message_template WHERE scope <> 'platform'`),
      ).toBe(before);
      expect(await count(`SELECT count(*) AS n FROM tenant_message_template_overlay`)).toBe(0);
    });

    it("an edit that adds PHI to a stored reply is refused and the stored text is unchanged", async () => {
      const created = await call("POST", "/api/v1/messaging/templates/personal", alice, ORG_A, {
        ...ok,
        title: "Edit probe",
      });
      const res = await call(
        "PATCH",
        `/api/v1/messaging/templates/personal/${created.json().id}`,
        alice,
        ORG_A,
        { body: "Call 415-555-0134" },
      );
      expect(res.statusCode).toBe(422);
      expect(
        (await call("GET", `/api/v1/messaging/templates/${created.json().id}`, alice)).json().body,
      ).toBe(ok.body);
    });

    it("a row that no longer passes the lint (written before a tightened rule) is not served", async () => {
      const id = (
        await admin.query(
          `INSERT INTO message_template (scope, organization_id, category, title, body) VALUES ('org',$1,'general','Legacy','Call 415-555-0134') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      const items = (await call("GET", "/api/v1/messaging/templates", alice)).json()
        .items as Array<{ id: string }>;
      expect(items.map((i) => i.id)).not.toContain(id);
    });
  });

  describe("shared templates and the platform overlay (messaging.template.manage)", () => {
    it("a sender cannot administer, and the shared template reaches colleagues but not another org", async () => {
      expect((await call("GET", "/api/v1/messaging/template-admin", alice)).statusCode).toBe(403);
      expect(
        (await call("POST", "/api/v1/messaging/template-admin/shared", alice, ORG_A, ok))
          .statusCode,
      ).toBe(403);
      const created = await call("POST", "/api/v1/messaging/template-admin/shared", boss, ORG_A, {
        ...ok,
        title: "Org wide",
      });
      expect(created.statusCode).toBe(201);
      const seen = async (user: string, org: string) =>
        (
          (await call("GET", "/api/v1/messaging/templates", user, org)).json().items as Array<{
            id: string;
          }>
        ).map((i) => i.id);
      expect(await seen(bob, ORG_A)).toContain(created.json().id);
      expect(await seen(carol, ORG_B)).not.toContain(created.json().id);
      // another org's manager cannot touch it either, and gets the answer a random id gets
      const real = shape(
        await call(
          "DELETE",
          `/api/v1/messaging/template-admin/shared/${created.json().id}`,
          carolBoss,
          ORG_B,
        ),
      );
      const random = shape(
        await call(
          "DELETE",
          `/api/v1/messaging/template-admin/shared/${randomUUID()}`,
          carolBoss,
          ORG_B,
        ),
      );
      expect(real).toBe(random);
      expect(
        await count(`SELECT count(*) AS n FROM message_template WHERE id=$1`, [created.json().id]),
      ).toBe(1);
    });

    it("a personal reply is not reachable through the shared path, and a shared one not through the personal path", async () => {
      const personal = (
        await call("POST", "/api/v1/messaging/templates/personal", boss, ORG_A, {
          ...ok,
          title: "Boss personal",
        })
      ).json().id;
      expect(
        (
          await call("PATCH", `/api/v1/messaging/template-admin/shared/${personal}`, boss, ORG_A, {
            body: "x",
          })
        ).statusCode,
      ).toBe(404);
      const shared = (
        await call("POST", "/api/v1/messaging/template-admin/shared", boss, ORG_A, {
          ...ok,
          title: "Boss shared",
        })
      ).json().id;
      expect(
        (
          await call("PATCH", `/api/v1/messaging/templates/personal/${shared}`, boss, ORG_A, {
            body: "x",
          })
        ).statusCode,
      ).toBe(404);
    });

    const overlayUrl = `/api/v1/messaging/template-admin/platform/${emergency.id}/overlay`;

    it("an overlay that keeps the required wording is applied for its own org only", async () => {
      const body = "Away. In an emergency call 911; for urgent needs use the on-call line.";
      const put = await call("PUT", overlayUrl, boss, ORG_A, {
        title: "Our after hours",
        body,
        isEnabled: true,
      });
      expect(put.statusCode).toBe(204);
      const mine = (
        await call("GET", `/api/v1/messaging/templates/${emergency.id}`, alice, ORG_A)
      ).json();
      expect(mine).toMatchObject({ title: "Our after hours", body, customized: true });
      const theirs = (
        await call("GET", `/api/v1/messaging/templates/${emergency.id}`, carol, ORG_B)
      ).json();
      expect(theirs).toMatchObject({
        title: emergency.title,
        body: emergency.body,
        customized: false,
      });
      // upsert, not duplicate
      await call("PUT", overlayUrl, boss, ORG_A, { title: null, body, isEnabled: true });
      expect(
        await count(
          `SELECT count(*) AS n FROM tenant_message_template_overlay WHERE organization_id=$1`,
          [ORG_A],
        ),
      ).toBe(1);
    });

    it("an overlay that drops a required phrase is refused (the floor is not loosened) and the stored overlay is unchanged", async () => {
      const stored = (
        await admin.query(
          `SELECT body FROM tenant_message_template_overlay WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0].body;
      const res = await call("PUT", overlayUrl, boss, ORG_A, {
        title: null,
        body: "Reply when you can.",
        isEnabled: true,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("TEMPLATE_FLOOR_VIOLATION");
      expect(
        (
          await admin.query(
            `SELECT body FROM tenant_message_template_overlay WHERE organization_id=$1`,
            [ORG_A],
          )
        ).rows[0].body,
      ).toBe(stored);
    });

    it("a stored overlay that no longer satisfies the floor is not served: the platform text is (fail closed at resolve time)", async () => {
      await admin.query(
        `UPDATE tenant_message_template_overlay SET body='Nothing about emergencies here.' WHERE organization_id=$1`,
        [ORG_A],
      );
      const view = (
        await call("GET", `/api/v1/messaging/templates/${emergency.id}`, alice, ORG_A)
      ).json();
      expect(view.body).toBe(emergency.body);
    });

    it("disabling hides a platform template from that org only; deleting the overlay brings it back", async () => {
      const loose = PLATFORM_MESSAGE_TEMPLATES.find((t) => t.requiredPhrases.length === 0)!;
      const looseUrl = `/api/v1/messaging/template-admin/platform/${loose.id}/overlay`;
      const put = await call("PUT", looseUrl, boss, ORG_A, {
        title: null,
        body: null,
        isEnabled: false,
      });
      expect(put.statusCode).toBe(204);
      const ids = async (user: string, org: string) =>
        (
          (await call("GET", "/api/v1/messaging/templates", user, org)).json().items as Array<{
            id: string;
          }>
        ).map((i) => i.id);
      expect(await ids(alice, ORG_A)).not.toContain(loose.id);
      expect(await ids(carol, ORG_B)).toContain(loose.id);
      expect((await call("DELETE", looseUrl, boss, ORG_A)).statusCode).toBe(204);
      expect(await ids(alice, ORG_A)).toContain(loose.id);
    });

    it("the emergency template (required wording) cannot be switched off", async () => {
      const put = await call("PUT", overlayUrl, boss, ORG_A, {
        title: null,
        body: null,
        isEnabled: false,
      });
      expect(put.statusCode).toBe(422);
    });

    it("an overlay can only target a platform template; the answer for any other id is a random id's 404", async () => {
      const sharedId = (
        await call("POST", "/api/v1/messaging/template-admin/shared", boss, ORG_A, {
          ...ok,
          title: "Not platform",
        })
      ).json().id;
      const base = (id: string) => `/api/v1/messaging/template-admin/platform/${id}/overlay`;
      const body = { title: null, body: null, isEnabled: false };
      const a = shape(await call("PUT", base(sharedId), boss, ORG_A, body));
      const b = shape(await call("PUT", base(randomUUID()), boss, ORG_A, body));
      expect(a).toBe(b);
      expect(a.startsWith("404")).toBe(true);
    });

    it("tenant isolation of the overlay: as wardenx_app, org B sees and changes none of org A's overlays", async () => {
      await call("PUT", overlayUrl, boss, ORG_A, { title: "A only", body: null, isEnabled: true });
      await asApp(ORG_B, carolBoss, async () => {
        expect(
          (await appClient.query(`SELECT count(*)::int AS n FROM tenant_message_template_overlay`))
            .rows[0].n,
        ).toBe(0);
        expect(
          (await appClient.query(`UPDATE tenant_message_template_overlay SET title='pwned'`))
            .rowCount,
        ).toBe(0);
        expect(
          (await appClient.query(`DELETE FROM tenant_message_template_overlay`)).rowCount,
        ).toBe(0);
        await expect(
          appClient.query(
            `INSERT INTO tenant_message_template_overlay (organization_id, template_id, configured_by_user_id) VALUES ($1,$2,$3)`,
            [ORG_A, emergency.id, carolBoss],
          ),
        ).rejects.toThrow(/row-level security|violates/i);
      });
      expect(
        (
          await admin.query(
            `SELECT title FROM tenant_message_template_overlay WHERE organization_id=$1`,
            [ORG_A],
          )
        ).rows[0].title,
      ).toBe("A only");
    });

    it("tenant isolation of templates: as wardenx_app, org B sees none of org A's shared or personal rows and changes none", async () => {
      await asApp(ORG_B, carolBoss, async () => {
        expect(
          (
            await appClient.query(
              `SELECT count(*)::int AS n FROM message_template WHERE organization_id=$1`,
              [ORG_A],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await appClient.query(
              `UPDATE message_template SET title='pwned' WHERE organization_id=$1`,
              [ORG_A],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (await appClient.query(`DELETE FROM message_template WHERE organization_id=$1`, [ORG_A]))
            .rowCount,
        ).toBe(0);
        await expect(
          appClient.query(
            `INSERT INTO message_template (scope, organization_id, category, title, body) VALUES ('org',$1,'general','forged','b')`,
            [ORG_A],
          ),
        ).rejects.toThrow(/row-level security|violates/i);
      });
    });
  });

  describe("audit", () => {
    it("tenant writes are audited with the body scrubbed; platform seed rows are not audited", async () => {
      const created = await call("POST", "/api/v1/messaging/templates/personal", alice, ORG_A, {
        ...ok,
        title: "Audit probe",
        body: "Distinctive audit probe body.",
      });
      const events = (
        await admin.query(
          `SELECT event_type, after FROM audit_event WHERE organization_id=$1 AND resource_kind='message_template' AND resource_id=$2`,
          [ORG_A, created.json().id],
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("message_template.insert");
      expect(events[0].after.title).toBe("Audit probe");
      expect(events[0].after.body).toBe("<changed>");
      expect(JSON.stringify(events[0].after)).not.toContain("Distinctive audit probe body");
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_event WHERE resource_kind='message_template' AND event_type <> 'message_template.viewed' AND resource_id = ANY($1::uuid[])`,
          [PLATFORM_MESSAGE_TEMPLATES.map((t) => t.id)],
        ),
      ).toBe(0);
    });

    it("overlay writes are audited with the body scrubbed", async () => {
      await call(
        "PUT",
        `/api/v1/messaging/template-admin/platform/${emergency.id}/overlay`,
        boss,
        ORG_A,
        {
          title: null,
          body: "Marker overlay body. call 911 and the on-call line.",
          isEnabled: true,
        },
      );
      const rows = (
        await admin.query(
          `SELECT after FROM audit_event WHERE organization_id=$1 AND resource_kind='tenant_message_template_overlay' ORDER BY created_at DESC LIMIT 1`,
          [ORG_A],
        )
      ).rows;
      expect(rows[0].after.body).toBe("<changed>");
    });
  });

  describe("read audit (WP 1.8 ratchet)", () => {
    it("a single-template read lands a viewed event that carries the template id", async () => {
      const created = await call("POST", "/api/v1/messaging/templates/personal", bob, ORG_A, {
        ...ok,
        title: "Read audit probe",
      });
      const id = created.json().id as string;
      const read = () =>
        admin.query(
          `SELECT resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type='message_template.viewed' AND actor_user_id=$2 AND resource_id=$3`,
          [ORG_A, bob, id],
        );
      const before = (await read()).rows.length;
      expect((await call("GET", `/api/v1/messaging/templates/${id}`, bob)).statusCode).toBe(200);
      const after = (await read()).rows;
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)?.rid).toBe(id);
    });
  });

  describe("tenant erase (wardenx_destruction)", () => {
    it("removes the tenant's saved replies, shared templates and overlays, and never a platform row or another tenant's", async () => {
      const { createDrizzleMessagingEraseStore } = await import(
        "../src/modules/36-messaging/erasers/messaging-eraser"
      );
      const orgC = "33333333-3333-4333-8333-3333000f0028";
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp28-c','C','C')`,
        [orgC],
      );
      const cUser = await seedUser("erase-c", orgC);
      await admin.query(
        `INSERT INTO message_template (scope, organization_id, category, title, body) VALUES ('org',$1,'general','C shared','b')`,
        [orgC],
      );
      await admin.query(
        `INSERT INTO message_template (scope, organization_id, owner_user_id, category, title, body) VALUES ('personal',$1,$2,'general','C mine','b')`,
        [orgC, cUser],
      );
      await admin.query(
        `INSERT INTO tenant_message_template_overlay (organization_id, template_id, configured_by_user_id, is_enabled) VALUES ($1,$2,$3,false)`,
        [orgC, emergency.id, cUser],
      );
      const aBefore = await count(
        `SELECT count(*) AS n FROM message_template WHERE organization_id=$1`,
        [ORG_A],
      );
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp28_destroyer') THEN
           CREATE ROLE wp28_destroyer LOGIN PASSWORD 'wp28_destroyer_pw' IN ROLE wardenx_destruction; END IF; END $$;`,
      );
      const url = new URL(DB_URL as string);
      url.username = "wp28_destroyer";
      url.password = "wp28_destroyer_pw";
      const destroyer = createDbClient({ connectionString: url.toString() });
      try {
        await createDrizzleMessagingEraseStore(destroyer.db).deleteStructuralRows(orgC);
      } finally {
        await destroyer.close();
      }
      expect(
        await count(`SELECT count(*) AS n FROM message_template WHERE organization_id=$1`, [orgC]),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*) AS n FROM tenant_message_template_overlay WHERE organization_id=$1`,
          [orgC],
        ),
      ).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM message_template WHERE scope='platform'`)).toBe(
        PLATFORM_MESSAGE_TEMPLATES.length,
      );
      expect(
        await count(`SELECT count(*) AS n FROM message_template WHERE organization_id=$1`, [ORG_A]),
      ).toBe(aBefore);
    });
  });

  describe("wiring (bound is not computing)", () => {
    it("the composition mount registers the template routes", () => {
      const src = readFileSync(join(__dirname, "../src/modules/36-messaging/index.ts"), "utf8");
      expect(src).toContain(
        "_registerTemplateRoutes(app, { service: _createDbTemplateService(db) })",
      );
    });
  });
});
