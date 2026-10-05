/**
 * GAP-007 — the Postgres IdempotencyStore must CLAIM atomically.
 *
 * `putPending` used to be `INSERT ... ON CONFLICT DO NOTHING` returning void, and the middleware never
 * checked whether it had won: two concurrent requests with one Idempotency-Key both ran the handler,
 * and because nothing ever removed an expired row, every retry of an expired key re-executed.
 * `putPending` now returns the claim (`ON CONFLICT DO UPDATE ... WHERE expires_at <= now() RETURNING id`).
 *
 * LIVE by necessity: the claim is decided by the unique index and row locking, which the in-memory
 * store only imitates. Runs as the NOBYPASSRLS `wardenx_app` role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:gap007:idempotency-claim:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import type { IdempotencyStore } from "@wardenx/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { applyIdempotency } from "../src/bootstrap/plugins/idempotency";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111100070001";
const ORG_B = "22222222-2222-4222-8222-222200070002";

describe.skipIf(!DB_URL)("GAP-007 idempotency claim — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: IdempotencyStore;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'gap007-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'gap007-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDbIdempotencyStore(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  const rowFor = async (org: string, key: string) =>
    (
      await admin.query<{ state: string; request_hash: string; status: string | null }>(
        `SELECT state::text AS state, request_hash, response_status AS status
           FROM idempotency_key WHERE organization_id = $1 AND key = $2`,
        [org, key],
      )
    ).rows;
  const expire = (org: string, key: string) =>
    admin.query(
      `UPDATE idempotency_key SET expires_at = now() - interval '1 minute'
        WHERE organization_id = $1 AND key = $2`,
      [org, key],
    );

  describe("store.putPending is an atomic claim", () => {
    it("N concurrent claimers on one key: exactly one wins", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => store.putPending(ORG_A, "race", `hash-${i}`)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await rowFor(ORG_A, "race")).toHaveLength(1);
    });

    it("a lost claim leaves the winner's row untouched", async () => {
      expect(await store.putPending(ORG_A, "keep", "winner")).toBe(true);
      await store.complete(ORG_A, "keep", { status: "201", body: { id: 1 } });
      expect(await store.putPending(ORG_A, "keep", "loser")).toBe(false);
      const [row] = await rowFor(ORG_A, "keep");
      expect(row).toMatchObject({ state: "complete", request_hash: "winner", status: "201" });
    });

    it("an expired key is reclaimed fresh: pending again, new hash, response cleared", async () => {
      await store.putPending(ORG_A, "expired", "old");
      await store.complete(ORG_A, "expired", { status: "201", body: { id: 1 } });
      await expire(ORG_A, "expired");
      expect(await store.load(ORG_A, "expired")).toBeNull();

      expect(await store.putPending(ORG_A, "expired", "new")).toBe(true);
      const rows = await rowFor(ORG_A, "expired");
      expect(rows).toEqual([{ state: "pending", request_hash: "new", status: null }]);
      // ...and the reclaimed key is live again: a second claimer loses.
      expect(await store.putPending(ORG_A, "expired", "new")).toBe(false);
    });

    it("racing claimers on an EXPIRED key: exactly one reclaims", async () => {
      await store.putPending(ORG_A, "expired-race", "old");
      await expire(ORG_A, "expired-race");
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => store.putPending(ORG_A, "expired-race", `h-${i}`)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("RLS: another tenant's claim on the same key string is independent", async () => {
      expect(await store.putPending(ORG_A, "tenant", "h")).toBe(true);
      expect(await store.putPending(ORG_B, "tenant", "h")).toBe(true);
    });
  });

  describe("applyIdempotency over the DB store", () => {
    let app: FastifyInstance;
    let handlerRuns = 0;
    let release: () => void = () => undefined;

    beforeAll(async () => {
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      app = Fastify();
      app.decorateRequest("context", undefined as never);
      app.addHook("onRequest", async (request) => {
        (request as unknown as { context: unknown }).context = { organizationId: ORG_A };
      });
      applyErrorHandler(app);
      applyIdempotency(app, store);
      app.post("/gated", async (_req, reply) => {
        handlerRuns += 1;
        await gate;
        return reply.code(201).send({ run: handlerRuns });
      });
      app.post("/open", async (_req, reply) => {
        handlerRuns += 1;
        return reply.code(201).send({ run: handlerRuns });
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
    });

    const post = (url: string, key: string) =>
      app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload: { a: 1 } });

    it("two concurrent POSTs with the same key run the handler ONCE; the loser is a 409", async () => {
      handlerRuns = 0;
      const first = post("/gated", "http-race");
      const second = post("/gated", "http-race");
      // Both reach the claim while the winner is parked in the handler.
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(handlerRuns).toBe(1);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    });

    it("reuse after the winner completes replays; reuse after expiry claims fresh, then replays", async () => {
      handlerRuns = 0;
      const first = await post("/open", "http-expiry");
      expect(first.statusCode).toBe(201);
      const replay = await post("/open", "http-expiry");
      expect(replay.json()).toEqual(first.json());
      expect(handlerRuns).toBe(1);

      await expire(ORG_A, "http-expiry");
      const fresh = await post("/open", "http-expiry");
      expect(fresh.statusCode).toBe(201);
      expect(handlerRuns).toBe(2);
      const replayFresh = await post("/open", "http-expiry");
      expect(replayFresh.json()).toEqual(fresh.json());
      expect(handlerRuns).toBe(2);
    });
  });
});
