/**
 * GAP-007 — the Postgres IdempotencyStore must CLAIM atomically.
 *
 * `putPending` used to be `INSERT ... ON CONFLICT DO NOTHING` returning void, and the middleware never
 * checked whether it had won: two concurrent requests with one Idempotency-Key both ran the handler,
 * and because nothing ever removed an expired row, every retry of an expired key re-executed.
 * `putPending` now returns the claim (`ON CONFLICT DO UPDATE ... WHERE expires_at <= now() RETURNING id`).
 *
 * LIVE by necessity: the claim is decided by the unique index and row locking, which the in-memory
 * store only imitates. Runs as the NOBYPASSRLS `chartwarden_app` role.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:gap007:idempotency-claim:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { IdempotencyStore } from "@chartwarden/shared";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { applyIdempotency } from "../src/bootstrap/plugins/idempotency";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-111100070001";
const ORG_B = "22222222-2222-4222-8222-222200070002";

describe.skipIf(!DB_URL)("GAP-007 idempotency claim — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: IdempotencyStore;

  async function applyMigrations() {
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
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'gap007-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'gap007-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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

  describe("store.release frees only the claimant's own pending row", () => {
    it("deletes a pending row with the matching fingerprint, so the key can be claimed again", async () => {
      await store.putPending(ORG_A, "rel-own", "mine");
      await store.release(ORG_A, "rel-own", "mine");
      expect(await rowFor(ORG_A, "rel-own")).toEqual([]);
      expect(await store.putPending(ORG_A, "rel-own", "mine")).toBe(true);
    });

    it("leaves a pending row another fingerprint owns, and never deletes a completed response", async () => {
      await store.putPending(ORG_A, "rel-other", "owner");
      await store.release(ORG_A, "rel-other", "intruder");
      expect(await rowFor(ORG_A, "rel-other")).toHaveLength(1);

      await store.complete(ORG_A, "rel-other", { status: "201", body: { id: 1 } });
      await store.release(ORG_A, "rel-other", "owner");
      expect(await rowFor(ORG_A, "rel-other")).toEqual([
        { state: "complete", request_hash: "owner", status: "201" },
      ]);
    });

    it("RLS: another tenant's release on the same key string deletes nothing", async () => {
      await store.putPending(ORG_A, "rel-tenant", "h");
      await store.release(ORG_B, "rel-tenant", "h");
      expect(await rowFor(ORG_A, "rel-tenant")).toHaveLength(1);
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

    /** origin/main's request fingerprint (before the keyed hash), as its middleware called it: scope `${orgId}|${userId}` (this app's context has no user). */
    const mainsHash = (key: string, body: unknown): string =>
      createHash("sha256")
        .update(JSON.stringify({ organizationId: `${ORG_A}|`, key, body }))
        .digest("hex");

    it("a row written by origin/main's middleware (plain SHA-256) REPLAYS on the Postgres store; another body is a 409; the handler never runs", async () => {
      handlerRuns = 0;
      expect(await store.putPending(ORG_A, "pre-deploy", mainsHash("pre-deploy", { a: 1 }))).toBe(
        true,
      );
      await store.complete(ORG_A, "pre-deploy", {
        status: "201",
        body: { run: "before-the-deploy" },
      });

      const replay = await post("/open", "pre-deploy");
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual({ run: "before-the-deploy" });
      const otherBody = await app.inject({
        method: "POST",
        url: "/open",
        headers: { "idempotency-key": "pre-deploy" },
        payload: { a: 2 },
      });
      expect(otherBody.statusCode).toBe(409);
      expect(handlerRuns).toBe(0);
      // the legacy row is neither rewritten nor deleted by a replay
      const [row] = await rowFor(ORG_A, "pre-deploy");
      expect(row).toMatchObject({
        state: "complete",
        request_hash: mainsHash("pre-deploy", { a: 1 }),
      });
    });
  });

  // A retryable failure is released ONLY when the request committed nothing. Real pool (createDbClient's commit tracker),
  // real transactions (withOrgContext), real idempotency_key rows. The unit-level cases are in idempotency-commit-tracker.test.ts.
  describe("a retryable failure frees the key only if nothing committed (real transactions)", () => {
    let app: FastifyInstance;
    let runs = 0;
    let mode:
      | "commit-then-500"
      | "rollback-then-500"
      | "commit-then-deadlock"
      | "read-then-503"
      | "autocommit-then-500"
      | "writer-fn-autocommit-then-500"
      | "writer-fn-in-tx-then-500"
      | "open-write-then-500"
      | "refused-commit"
      | "blocked" = "commit-then-500";
    let releaseBlocked: () => void = () => undefined;
    // M3: a sibling transaction that has written but not committed when the response is built.
    let openTransaction: Promise<unknown> = Promise.resolve();
    let commitOpenTransaction: () => void = () => undefined;

    const probeRows = async () =>
      Number((await admin.query("SELECT count(*)::int AS n FROM idem_probe")).rows[0].n);
    const insertProbe = (tx: unknown, n: number) =>
      (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`INSERT INTO idem_probe (n) VALUES (${n})`,
      );

    beforeAll(async () => {
      await admin.query("CREATE TABLE idem_probe (id serial PRIMARY KEY, n int NOT NULL)");
      await admin.query("GRANT ALL ON idem_probe TO chartwarden_app");
      await admin.query("GRANT USAGE ON SEQUENCE idem_probe_id_seq TO chartwarden_app");
      // The platform-writer pattern: a SECURITY DEFINER function that writes, called as `SELECT fn(...)`. Nothing in the
      // statement's text says it writes, so the tracker must count every call that is not a known read-only builtin.
      await admin.query(
        `CREATE FUNCTION idem_probe_writer(p int) RETURNS void LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public AS $$ INSERT INTO idem_probe (n) VALUES (p) $$`,
      );
      await admin.query("GRANT EXECUTE ON FUNCTION idem_probe_writer(int) TO chartwarden_app");
      // L6: a COMMIT the server refuses (a deferred foreign key checked at COMMIT) applied nothing.
      await admin.query("CREATE TABLE idem_parent (id int PRIMARY KEY)");
      await admin.query(
        `CREATE TABLE idem_child (id serial PRIMARY KEY, parent_id int NOT NULL
           REFERENCES idem_parent (id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await admin.query("GRANT ALL ON idem_parent, idem_child TO chartwarden_app");
      await admin.query("GRANT USAGE ON SEQUENCE idem_child_id_seq TO chartwarden_app");
      app = Fastify();
      app.decorateRequest("context", undefined as never);
      app.addHook("onRequest", async (request) => {
        (request as unknown as { context: unknown }).context = { organizationId: ORG_A };
      });
      applyErrorHandler(app);
      applyIdempotency(app, store);
      app.post("/probe", async (_req, reply) => {
        runs += 1;
        const scope = { organizationId: ORG_A, userId: "" };
        if (mode === "read-then-503") {
          await withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1`),
          ); // a guard-style read transaction: it COMMITs, but writes nothing
          return reply.code(503).send({ error: { code: "DEGRADED" } });
        }
        if (mode === "blocked") {
          await new Promise<void>((resolve) => {
            releaseBlocked = resolve;
          });
          return reply.code(201).send({ saved: true });
        }
        if (mode === "open-write-then-500") {
          const gate = new Promise<void>((resolve) => {
            commitOpenTransaction = resolve;
          });
          let written: () => void = () => undefined;
          const insertIssued = new Promise<void>((resolve) => {
            written = resolve;
          });
          openTransaction = withOrgContext(handle.db, scope, async (tx) => {
            await insertProbe(tx, runs); // written, held open
            written();
            await gate;
          });
          await insertIssued; // the INSERT has reached the server; the sibling still holds its transaction open
          throw new Error("a sibling step failed");
        }
        if (mode === "refused-commit") {
          await withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
              // run 1: the parent row is missing, so the deferred foreign key fails when the transaction COMMITs
              sql`INSERT INTO idem_child (parent_id) VALUES (${runs === 1 ? 999 : 1})`,
            ),
          );
          return reply.code(201).send({ saved: true });
        }
        if (mode === "writer-fn-autocommit-then-500") {
          await handle.db.execute(sql`SELECT idem_probe_writer(${runs})`); // autocommit: durable once it returns
          throw new Error("failed after a writer-function call");
        }
        if (mode === "writer-fn-in-tx-then-500") {
          await withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
              sql`SELECT idem_probe_writer(${runs})`,
            ),
          ); // committed with the transaction
          throw new Error("failed after a writer-function call");
        }
        if (mode === "autocommit-then-500") {
          // No transaction block: drizzle sends this through pool.query (pg-pool's own checkout), the path whose callback may
          // resume in another async context. It is durable the moment it succeeds.
          await handle.db.execute(sql`INSERT INTO idem_probe (n) VALUES (${runs})`);
          throw new Error("failed after an autocommit write");
        }
        if (mode === "rollback-then-500") {
          await withOrgContext(handle.db, scope, async (tx) => {
            await insertProbe(tx, runs);
            throw new Error("failed inside the transaction"); // rolled back
          });
        }
        await withOrgContext(handle.db, scope, (tx) => insertProbe(tx, runs)); // COMMITS
        if (mode === "commit-then-deadlock") {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" });
        }
        throw new Error("post-commit step failed");
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
    });

    const post = (key: string) =>
      app.inject({
        method: "POST",
        url: "/probe",
        headers: { "idempotency-key": key },
        payload: { a: 1 },
      });

    it("a COMMITTED write followed by a 500: cached and replayed, the row is written once", async () => {
      mode = "commit-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-commit-500")).statusCode).toBe(500);
      expect((await post("live-commit-500")).statusCode).toBe(500);
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
      expect(await rowFor(ORG_A, "live-commit-500")).toMatchObject([
        { state: "complete", status: "500" },
      ]);
    });

    it("a COMMITTED write followed by a 409 CONCURRENT_UPDATE from a second transaction: cached", async () => {
      mode = "commit-then-deadlock";
      runs = 0;
      const before = await probeRows();
      const first = await post("live-commit-deadlock");
      expect(first.statusCode).toBe(409);
      expect(first.json().error.code).toBe("CONCURRENT_UPDATE");
      expect((await post("live-commit-deadlock")).statusCode).toBe(409);
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
    });

    it("an AUTOCOMMIT write (no transaction block, via pool.query) followed by a 500: cached, the row is written once", async () => {
      mode = "autocommit-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-autocommit-500")).statusCode).toBe(500);
      expect((await post("live-autocommit-500")).statusCode).toBe(500);
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
    });

    it.each(["writer-fn-autocommit-then-500", "writer-fn-in-tx-then-500"] as const)(
      "a SECURITY DEFINER writer called via SELECT (%s): cached, the retry does NOT write again",
      async (writerMode) => {
        mode = writerMode;
        runs = 0;
        const key = `live-${writerMode}`;
        const before = await probeRows();
        expect((await post(key)).statusCode).toBe(500);
        expect((await post(key)).statusCode).toBe(500);
        expect(runs).toBe(1);
        expect(await probeRows()).toBe(before + 1);
        expect(await rowFor(ORG_A, key)).toMatchObject([{ state: "complete", status: "500" }]);
      },
    );

    it("a write that ROLLED BACK, then a 500: the key is released and the retry runs", async () => {
      mode = "rollback-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-rollback-500")).statusCode).toBe(500);
      expect(await rowFor(ORG_A, "live-rollback-500")).toEqual([]); // released
      expect(await probeRows()).toBe(before); // nothing was durable
      expect((await post("live-rollback-500")).statusCode).toBe(500);
      expect(runs).toBe(2); // the retry ran (and rolled back again)
    });

    it("a write still OPEN in a sibling transaction when the 500 is built: cached, its late COMMIT cannot land under a freed key", async () => {
      mode = "open-write-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-open-write-500")).statusCode).toBe(500);
      commitOpenTransaction(); // the sibling now COMMITs, after the answer
      await openTransaction;
      expect(await probeRows()).toBe(before + 1);
      expect(await rowFor(ORG_A, "live-open-write-500")).toMatchObject([
        { state: "complete", status: "500" },
      ]);
      expect((await post("live-open-write-500")).statusCode).toBe(500); // the replay, not a second run
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
    });

    it("a COMMIT the server REFUSED (deferred foreign key, 23503) applied nothing: the key is released and the retry runs", async () => {
      mode = "refused-commit";
      runs = 0;
      await admin.query("INSERT INTO idem_parent (id) VALUES (1) ON CONFLICT DO NOTHING");
      const childRows = async () =>
        Number((await admin.query("SELECT count(*)::int AS n FROM idem_child")).rows[0].n);
      expect((await post("live-refused-commit")).statusCode).toBe(500);
      expect(await childRows()).toBe(0);
      expect(await rowFor(ORG_A, "live-refused-commit")).toEqual([]); // released
      const retry = await post("live-refused-commit");
      expect(retry.statusCode).toBe(201);
      expect(runs).toBe(2);
      expect(await childRows()).toBe(1);
    });

    it("a claim left pending past the bound answers IDEMPOTENCY_KEY_STUCK, and the row is never reclaimed or re-run", async () => {
      mode = "blocked";
      runs = 0;
      const first = post("live-stuck"); // claims the key and never answers (its process is as good as dead)
      for (let i = 0; i < 200 && (await rowFor(ORG_A, "live-stuck")).length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await rowFor(ORG_A, "live-stuck")).toMatchObject([{ state: "pending" }]);
      // young: still just in flight
      expect((await post("live-stuck")).json().error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
      // aged past the bound (created_at is what the store reads the age from)
      await admin.query(
        "UPDATE idempotency_key SET created_at = now() - interval '20 minutes' WHERE key = 'live-stuck'",
      );
      const stuck = await post("live-stuck");
      expect(stuck.statusCode).toBe(409);
      expect(stuck.json().error.code).toBe("IDEMPOTENCY_KEY_STUCK");
      expect(runs).toBe(1); // the second and third requests never ran the handler
      expect(await rowFor(ORG_A, "live-stuck")).toMatchObject([{ state: "pending" }]); // never reclaimed
      releaseBlocked();
      expect((await first).statusCode).toBe(201);
    });

    it("a read-only transaction (a guard's) followed by a 503: released, it never counted as a commit", async () => {
      mode = "read-then-503";
      runs = 0;
      expect((await post("live-read-503")).statusCode).toBe(503);
      expect(await rowFor(ORG_A, "live-read-503")).toEqual([]);
      expect((await post("live-read-503")).statusCode).toBe(503);
      expect(runs).toBe(2);
    });
  });

  // A retryable failure is released ONLY when the request committed nothing. Real pool (createDbClient's commit tracker),
  // real transactions (withOrgContext), real idempotency_key rows. The unit-level cases are in idempotency-commit-tracker.test.ts.
  describe("a retryable failure frees the key only if nothing committed (real transactions)", () => {
    let app: FastifyInstance;
    let runs = 0;
    let mode:
      | "commit-then-500"
      | "rollback-then-500"
      | "commit-then-deadlock"
      | "read-then-503"
      | "autocommit-then-500"
      | "writer-fn-autocommit-then-500"
      | "writer-fn-in-tx-then-500"
      | "open-write-then-500"
      | "refused-commit"
      | "blocked" = "commit-then-500";
    let releaseBlocked: () => void = () => undefined;
    // M3: a sibling transaction that has written but not committed when the response is built.
    let openTransaction: Promise<unknown> = Promise.resolve();
    let commitOpenTransaction: () => void = () => undefined;

    const probeRows = async () =>
      Number((await admin.query("SELECT count(*)::int AS n FROM idem_probe")).rows[0].n);
    const insertProbe = (tx: unknown, n: number) =>
      (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`INSERT INTO idem_probe (n) VALUES (${n})`,
      );

    beforeAll(async () => {
      await admin.query("CREATE TABLE idem_probe (id serial PRIMARY KEY, n int NOT NULL)");
      await admin.query("GRANT ALL ON idem_probe TO chartwarden_app");
      await admin.query("GRANT USAGE ON SEQUENCE idem_probe_id_seq TO chartwarden_app");
      // The platform-writer pattern: a SECURITY DEFINER function that writes, called as `SELECT fn(...)`. Nothing in the
      // statement's text says it writes, so the tracker must count every call that is not a known read-only builtin.
      await admin.query(
        `CREATE FUNCTION idem_probe_writer(p int) RETURNS void LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public AS $$ INSERT INTO idem_probe (n) VALUES (p) $$`,
      );
      await admin.query("GRANT EXECUTE ON FUNCTION idem_probe_writer(int) TO chartwarden_app");
      // L6: a COMMIT the server refuses (a deferred foreign key checked at COMMIT) applied nothing.
      await admin.query("CREATE TABLE idem_parent (id int PRIMARY KEY)");
      await admin.query(
        `CREATE TABLE idem_child (id serial PRIMARY KEY, parent_id int NOT NULL
           REFERENCES idem_parent (id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await admin.query("GRANT ALL ON idem_parent, idem_child TO chartwarden_app");
      await admin.query("GRANT USAGE ON SEQUENCE idem_child_id_seq TO chartwarden_app");
      app = Fastify();
      app.decorateRequest("context", undefined as never);
      app.addHook("onRequest", async (request) => {
        (request as unknown as { context: unknown }).context = { organizationId: ORG_A };
      });
      applyErrorHandler(app);
      applyIdempotency(app, store);
      app.post("/probe", async (_req, reply) => {
        runs += 1;
        const scope = { organizationId: ORG_A, userId: "" };
        if (mode === "read-then-503") {
          await withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1`),
          ); // a guard-style read transaction: it COMMITs, but writes nothing
          return reply.code(503).send({ error: { code: "DEGRADED" } });
        }
        if (mode === "blocked") {
          await new Promise<void>((resolve) => {
            releaseBlocked = resolve;
          });
          return reply.code(201).send({ saved: true });
        }
        if (mode === "open-write-then-500") {
          const gate = new Promise<void>((resolve) => {
            commitOpenTransaction = resolve;
          });
          let written: () => void = () => undefined;
          const insertIssued = new Promise<void>((resolve) => {
            written = resolve;
          });
          openTransaction = withOrgContext(handle.db, scope, async (tx) => {
            await insertProbe(tx, runs); // written, held open
            written();
            await gate;
          });
          await insertIssued; // the INSERT has reached the server; the sibling still holds its transaction open
          throw new Error("a sibling step failed");
        }
        if (mode === "refused-commit") {
          await withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
              // run 1: the parent row is missing, so the deferred foreign key fails when the transaction COMMITs
              sql`INSERT INTO idem_child (parent_id) VALUES (${runs === 1 ? 999 : 1})`,
            ),
          );
          return reply.code(201).send({ saved: true });
        }
        if (mode === "writer-fn-autocommit-then-500") {
          await handle.db.execute(sql`SELECT idem_probe_writer(${runs})`); // autocommit: durable once it returns
          throw new Error("failed after a writer-function call");
        }
        if (mode === "writer-fn-in-tx-then-500") {
          await withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
              sql`SELECT idem_probe_writer(${runs})`,
            ),
          ); // committed with the transaction
          throw new Error("failed after a writer-function call");
        }
        if (mode === "autocommit-then-500") {
          // No transaction block: drizzle sends this through pool.query (pg-pool's own checkout), the path whose callback may
          // resume in another async context. It is durable the moment it succeeds.
          await handle.db.execute(sql`INSERT INTO idem_probe (n) VALUES (${runs})`);
          throw new Error("failed after an autocommit write");
        }
        if (mode === "rollback-then-500") {
          await withOrgContext(handle.db, scope, async (tx) => {
            await insertProbe(tx, runs);
            throw new Error("failed inside the transaction"); // rolled back
          });
        }
        await withOrgContext(handle.db, scope, (tx) => insertProbe(tx, runs)); // COMMITS
        if (mode === "commit-then-deadlock") {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" });
        }
        throw new Error("post-commit step failed");
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
    });

    const post = (key: string) =>
      app.inject({
        method: "POST",
        url: "/probe",
        headers: { "idempotency-key": key },
        payload: { a: 1 },
      });

    it("a COMMITTED write followed by a 500: cached and replayed, the row is written once", async () => {
      mode = "commit-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-commit-500")).statusCode).toBe(500);
      expect((await post("live-commit-500")).statusCode).toBe(500);
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
      expect(await rowFor(ORG_A, "live-commit-500")).toMatchObject([
        { state: "complete", status: "500" },
      ]);
    });

    it("a COMMITTED write followed by a 409 CONCURRENT_UPDATE from a second transaction: cached", async () => {
      mode = "commit-then-deadlock";
      runs = 0;
      const before = await probeRows();
      const first = await post("live-commit-deadlock");
      expect(first.statusCode).toBe(409);
      expect(first.json().error.code).toBe("CONCURRENT_UPDATE");
      expect((await post("live-commit-deadlock")).statusCode).toBe(409);
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
    });

    it("an AUTOCOMMIT write (no transaction block, via pool.query) followed by a 500: cached, the row is written once", async () => {
      mode = "autocommit-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-autocommit-500")).statusCode).toBe(500);
      expect((await post("live-autocommit-500")).statusCode).toBe(500);
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
    });

    it.each(["writer-fn-autocommit-then-500", "writer-fn-in-tx-then-500"] as const)(
      "a SECURITY DEFINER writer called via SELECT (%s): cached, the retry does NOT write again",
      async (writerMode) => {
        mode = writerMode;
        runs = 0;
        const key = `live-${writerMode}`;
        const before = await probeRows();
        expect((await post(key)).statusCode).toBe(500);
        expect((await post(key)).statusCode).toBe(500);
        expect(runs).toBe(1);
        expect(await probeRows()).toBe(before + 1);
        expect(await rowFor(ORG_A, key)).toMatchObject([{ state: "complete", status: "500" }]);
      },
    );

    it("a write that ROLLED BACK, then a 500: the key is released and the retry runs", async () => {
      mode = "rollback-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-rollback-500")).statusCode).toBe(500);
      expect(await rowFor(ORG_A, "live-rollback-500")).toEqual([]); // released
      expect(await probeRows()).toBe(before); // nothing was durable
      expect((await post("live-rollback-500")).statusCode).toBe(500);
      expect(runs).toBe(2); // the retry ran (and rolled back again)
    });

    it("a write still OPEN in a sibling transaction when the 500 is built: cached, its late COMMIT cannot land under a freed key", async () => {
      mode = "open-write-then-500";
      runs = 0;
      const before = await probeRows();
      expect((await post("live-open-write-500")).statusCode).toBe(500);
      commitOpenTransaction(); // the sibling now COMMITs, after the answer
      await openTransaction;
      expect(await probeRows()).toBe(before + 1);
      expect(await rowFor(ORG_A, "live-open-write-500")).toMatchObject([
        { state: "complete", status: "500" },
      ]);
      expect((await post("live-open-write-500")).statusCode).toBe(500); // the replay, not a second run
      expect(runs).toBe(1);
      expect(await probeRows()).toBe(before + 1);
    });

    it("a COMMIT the server REFUSED (deferred foreign key, 23503) applied nothing: the key is released and the retry runs", async () => {
      mode = "refused-commit";
      runs = 0;
      await admin.query("INSERT INTO idem_parent (id) VALUES (1) ON CONFLICT DO NOTHING");
      const childRows = async () =>
        Number((await admin.query("SELECT count(*)::int AS n FROM idem_child")).rows[0].n);
      expect((await post("live-refused-commit")).statusCode).toBe(500);
      expect(await childRows()).toBe(0);
      expect(await rowFor(ORG_A, "live-refused-commit")).toEqual([]); // released
      const retry = await post("live-refused-commit");
      expect(retry.statusCode).toBe(201);
      expect(runs).toBe(2);
      expect(await childRows()).toBe(1);
    });

    it("a claim left pending past the bound answers IDEMPOTENCY_KEY_STUCK, and the row is never reclaimed or re-run", async () => {
      mode = "blocked";
      runs = 0;
      const first = post("live-stuck"); // claims the key and never answers (its process is as good as dead)
      for (let i = 0; i < 200 && (await rowFor(ORG_A, "live-stuck")).length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await rowFor(ORG_A, "live-stuck")).toMatchObject([{ state: "pending" }]);
      // young: still just in flight
      expect((await post("live-stuck")).json().error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
      // aged past the bound (created_at is what the store reads the age from)
      await admin.query(
        "UPDATE idempotency_key SET created_at = now() - interval '20 minutes' WHERE key = 'live-stuck'",
      );
      const stuck = await post("live-stuck");
      expect(stuck.statusCode).toBe(409);
      expect(stuck.json().error.code).toBe("IDEMPOTENCY_KEY_STUCK");
      expect(runs).toBe(1); // the second and third requests never ran the handler
      expect(await rowFor(ORG_A, "live-stuck")).toMatchObject([{ state: "pending" }]); // never reclaimed
      releaseBlocked();
      expect((await first).statusCode).toBe(201);
    });

    it("a read-only transaction (a guard's) followed by a 503: released, it never counted as a commit", async () => {
      mode = "read-then-503";
      runs = 0;
      expect((await post("live-read-503")).statusCode).toBe(503);
      expect(await rowFor(ORG_A, "live-read-503")).toEqual([]);
      expect((await post("live-read-503")).statusCode).toBe(503);
      expect(runs).toBe(2);
    });
  });
});
