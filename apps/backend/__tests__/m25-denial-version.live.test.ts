/**
 * M25 denial `version` on the read routes, proven against real Postgres through the REAL Fastify routes +
 * the REAL Drizzle read/write services, connected as the NOBYPASSRLS `wardenx_app` role.
 *
 * Every denial transition is optimistic-concurrency (`If-Match: <version>`), but the read routes did not
 * return `version`, so a client had nothing to send. `toDenialItem` now projects it. This suite proves the
 * whole loop live: GET detail + worklist return the persisted `version` (not stripped on the wire, and valid
 * against the published `DenialWorklistItemSchema`); `PATCH …/start` with that exact value succeeds, bumps the
 * version and moves the case to `in_progress`; a stale value is refused with 409 VERSION_CONFLICT (the code
 * the route uses) and writes nothing; a missing If-Match is a 400; another tenant's denial id is a 404 for
 * read AND transition (RLS), and the same id stays untouched.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m25:denial-version:live
 * (SUPERUSER to a THROWAWAY db — this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM25AbacPredicates } from "../src/modules/25-remittance/abac-predicates";
import { runDenialAgingCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { registerDenialRoutes } from "../src/modules/25-remittance/routes/denials.routes";
import { DenialWorklistItemSchema } from "../src/modules/25-remittance/routes/m25-typebox";
import { buildDrizzleM25ReadService } from "../src/modules/25-remittance/routes/read-service-drizzle";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PERMISSIONS = ["denial.worklist.read", "denial.read"];

describe.skipIf(!DB_URL)(
  "M25 denial version on read + If-Match transitions — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const user: Record<string, string> = {};
    const membership: Record<string, string> = {};
    const pe: Record<string, string> = {};

    function headerAuth(request: FastifyRequest): void {
      const u = request.headers["x-test-user"];
      if (typeof u !== "string" || u.length === 0) return;
      request.context.userId = u;
      const org = request.headers["x-test-org"];
      request.context.organizationId = typeof org === "string" ? org : "";
      // `billing_manager` is a broad denial-oversight role: it passes `claim_assigned_to_actor`, so this suite
      // isolates the version contract + tenancy rather than the worklist-ownership axis.
      request.context.roles = ["billing_manager"];
      const m = request.headers["x-test-membership"];
      request.context.attributes.membershipId = typeof m === "string" ? m : u;
    }

    const as = (org: string, key: string) => ({
      "x-test-user": user[key],
      "x-test-org": org,
      "x-test-membership": membership[key],
    });

    async function seedUser(key: string, org: string): Promise<void> {
      user[key] = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m25ver-${key}@x.test`,
        ])
      ).rows[0].id as string;
      membership[key] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user[key], org],
        )
      ).rows[0].id as string;
    }

    /** A denial case at an explicit (state, version); subject is an EVV submission id (no FK) per the xor CHECK. */
    async function seedDenial(org: string, version: number, state = "open"): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO denial_case (organization_id, provider_entity_id, source_evv_aggregator_submission_id,
           carc_code, category, source, state, dollar_value, taxonomy_status, version)
         VALUES ($1,$2,$3,'45','denial','evv_aggregator_rejection',$4,125.50,'mapped',$5) RETURNING id`,
          [org, pe[org], randomUUID(), state, version],
        )
      ).rows[0].id as string;
    }

    const rowOf = async (id: string) =>
      (await admin.query("SELECT state, version FROM denial_case WHERE id=$1", [id])).rows[0] as {
        state: string;
        version: number;
      };

    const start = (org: string, key: string, id: string, ifMatch?: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/denials/${id}/start`,
        headers: {
          ...as(org, key),
          "idempotency-key": randomUUID(),
          ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
        },
      });

    const getDenial = (org: string, key: string, id: string) =>
      app.inject({ method: "GET", url: `/api/v1/denials/${id}`, headers: as(org, key) });

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
      const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      await seedUser("a", ORG_A);
      await seedUser("b", ORG_B);
      for (const [org, tag] of [
        [ORG_A, "A"],
        [ORG_B, "B"],
      ] as const) {
        pe[org] = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
            [org, `CCN-M25V-${tag}`, `M25V ${tag}`, `NPI-M25V-${tag}`],
          )
        ).rows[0].id as string;
      }

      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });

      resetAuthorizationContract();
      resetRbacEngine();
      const { store } = createInMemoryEffectivePermissionStore([
        {
          orgId: ORG_A,
          userId: user.a,
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: PERMISSIONS },
          ],
        },
        {
          orgId: ORG_B,
          userId: user.b,
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: PERMISSIONS },
          ],
        },
      ]);
      registerEffectivePermissionResolver(store);
      const registry = createPredicateRegistry();
      for (const [name, fn] of Object.entries(buildM25AbacPredicates({ db: handle.db }))) {
        registry.register(name, fn);
      }
      registerAbacRegistry(registry);

      app = buildServer({
        db: handle.db as never,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerDenialRoutes(app, {
        readService: buildDrizzleM25ReadService(handle.db),
        writeService: buildDrizzleM25WriteService(handle.db),
      });
    }, 180_000);

    afterAll(async () => {
      if (app) await app.close();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle?.close();
      if (admin) await admin.end();
    });

    it("GET /denials/:id returns the persisted version, un-stripped and schema-valid", async () => {
      const id = await seedDenial(ORG_A, 7);
      const res = await getDenial(ORG_A, "a", id);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(id);
      expect(body.version).toBe(7);
      expect(body.state).toBe("open");
      expect(Value.Check(DenialWorklistItemSchema, body)).toBe(true);
    });

    it("GET /denials (worklist) carries the version on every item", async () => {
      const id = await seedDenial(ORG_A, 4);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/denials",
        headers: as(ORG_A, "a"),
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ id: string; version: number }>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(Number.isInteger(item.version)).toBe(true);
      expect(items.find((i) => i.id === id)?.version).toBe(4);
    });

    it("start with If-Match = the read version succeeds and bumps the version by one", async () => {
      const id = await seedDenial(ORG_A, 1);
      const read = (await getDenial(ORG_A, "a", id)).json();
      const res = await start(ORG_A, "a", id, String(read.version));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, version: read.version + 1 });
      expect(await rowOf(id)).toEqual({ state: "in_progress", version: read.version + 1 });
      // The next read hands the client the NEW version to chain the following transition off.
      expect((await getDenial(ORG_A, "a", id)).json().version).toBe(read.version + 1);
    });

    it("a stale If-Match is refused with 409 VERSION_CONFLICT and writes nothing", async () => {
      const id = await seedDenial(ORG_A, 5);
      const res = await start(ORG_A, "a", id, "4");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("VERSION_CONFLICT");
      expect(await rowOf(id)).toEqual({ state: "open", version: 5 });
    });

    it("replaying a consumed version is a conflict (the second writer loses)", async () => {
      const id = await seedDenial(ORG_A, 2);
      expect((await start(ORG_A, "a", id, "2")).statusCode).toBe(200);
      // Same If-Match again: the case is now in_progress at version 3 — in_progress→in_progress is not a legal
      // edge, so the route refuses it as a transition conflict (409) rather than writing twice.
      const replay = await start(ORG_A, "a", id, "2");
      expect(replay.statusCode).toBe(409);
      expect(await rowOf(id)).toEqual({ state: "in_progress", version: 3 });
    });

    it("a missing If-Match is a 400 and writes nothing", async () => {
      const id = await seedDenial(ORG_A, 1);
      const res = await start(ORG_A, "a", id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("IF_MATCH_REQUIRED");
      expect(await rowOf(id)).toEqual({ state: "open", version: 1 });
    });

    it("RLS: another tenant's denial id is a 404 for read and for transition, and stays untouched", async () => {
      const foreign = await seedDenial(ORG_B, 3);
      const readAsA = await getDenial(ORG_A, "a", foreign);
      expect(readAsA.statusCode).toBe(404);
      expect(JSON.stringify(readAsA.json())).not.toContain('"version":3');
      const startAsA = await start(ORG_A, "a", foreign, "3");
      expect(startAsA.statusCode).toBe(404);
      expect(await rowOf(foreign)).toEqual({ state: "open", version: 3 });

      // The owning tenant still reads and transitions it normally.
      expect((await getDenial(ORG_B, "b", foreign)).json().version).toBe(3);
      expect((await start(ORG_B, "b", foreign, "3")).statusCode).toBe(200);
      expect(await rowOf(foreign)).toEqual({ state: "in_progress", version: 4 });
    });

    it("the denial-aging cron rebuckets under the NULL (system) audit actor, not a sentinel uuid", async () => {
      // Before the fix the cron stamped `00000000-…-0000000000e5` into `app.user_id`; the `denial_case`
      // write-audit trigger copied it into `audit_event.actor_user_id` (FK to `user`) → 23503 every night.
      const id = await seedDenial(ORG_A, 1);
      await admin.query(
        "UPDATE denial_case SET opened_at = now() - interval '40 days', aging_bucket_days = 0 WHERE id=$1",
        [id],
      );
      const dispatched: string[] = [];
      await runDenialAgingCron({
        connection: {} as never,
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        alerts: { dispatch: async (a) => void dispatched.push(a.alertCode) },
        now: () => new Date(),
      });
      const row = (await admin.query("SELECT aging_bucket_days FROM denial_case WHERE id=$1", [id]))
        .rows[0] as { aging_bucket_days: number };
      expect(row.aging_bucket_days).toBeGreaterThanOrEqual(40);
      expect(dispatched).toContain("denial.aging_threshold_breached");
      const audit = await admin.query(
        "SELECT actor_user_id FROM audit_event WHERE resource_id=$1 AND event_type='denial_case.update'",
        [id],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows.every((r) => r.actor_user_id === null)).toBe(true);
    });

    it("the worklist never lists another tenant's denials", async () => {
      const foreign = await seedDenial(ORG_B, 9);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/denials",
        headers: as(ORG_A, "a"),
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(foreign);
    });
  },
);
