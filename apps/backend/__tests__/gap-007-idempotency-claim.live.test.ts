/**
 * GAP-007 — the Postgres IdempotencyStore must CLAIM atomically.
 *
 * `putPending` used to be `INSERT ... ON CONFLICT DO NOTHING` returning void, and the middleware never
 * checked whether it had won: two concurrent requests with one Idempotency-Key both ran the handler,
 * and because nothing ever removed an expired row, every retry of an expired key re-executed.
 * `putPending` now returns a generation id (`ON CONFLICT DO UPDATE ... WHERE state = 'complete'
 * AND expires_at <= now() RETURNING id`); expired pending claims are never reclaimed automatically.
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
      const claimId = (await store.putPending(ORG_A, "keep", "winner")) as string;
      await store.complete(ORG_A, "keep", claimId, { status: "201", body: { id: 1 } });
      expect(await store.putPending(ORG_A, "keep", "loser")).toBeNull();
      const [row] = await rowFor(ORG_A, "keep");
      expect(row).toMatchObject({ state: "complete", request_hash: "winner", status: "201" });
    });

    it("an expired key is reclaimed fresh: pending again, new hash, response cleared", async () => {
      const oldClaim = (await store.putPending(ORG_A, "expired", "old")) as string;
      await store.complete(ORG_A, "expired", oldClaim, { status: "201", body: { id: 1 } });
      await expire(ORG_A, "expired");
      expect(await store.load(ORG_A, "expired")).toBeNull();

      const newClaim = await store.putPending(ORG_A, "expired", "new");
      expect(newClaim).toBeTruthy();
      expect(newClaim).not.toBe(oldClaim);
      const rows = await rowFor(ORG_A, "expired");
      expect(rows).toEqual([{ state: "pending", request_hash: "new", status: null }]);
      // ...and the reclaimed key is live again: a second claimer loses.
      expect(await store.putPending(ORG_A, "expired", "new")).toBeNull();
    });

    it("racing claimers on an EXPIRED key: exactly one reclaims", async () => {
      const oldClaim = (await store.putPending(ORG_A, "expired-race", "old")) as string;
      await store.complete(ORG_A, "expired-race", oldClaim, { status: "201", body: { old: true } });
      await expire(ORG_A, "expired-race");
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => store.putPending(ORG_A, "expired-race", `h-${i}`)),
      );
      expect(results.filter((result): result is string => result !== null)).toHaveLength(1);
    });

    it("an expired PENDING claim stays visible and cannot be re-claimed", async () => {
      const claimId = await store.putPending(ORG_A, "pending-expired", "same-hash");
      expect(claimId).toBeTruthy();
      await expire(ORG_A, "pending-expired");
      expect(await store.load(ORG_A, "pending-expired")).toMatchObject({
        state: "pending",
        requestHash: "same-hash",
      });
      expect(await store.putPending(ORG_A, "pending-expired", "same-hash")).toBeNull();
    });

    it("RLS: another tenant's claim on the same key string is independent", async () => {
      expect(await store.putPending(ORG_A, "tenant", "h")).toBeTruthy();
      expect(await store.putPending(ORG_B, "tenant", "h")).toBeTruthy();
    });
  });

  describe("store.release frees only the claimant's own pending row", () => {
    it("deletes a pending row with the matching fingerprint, so the key can be claimed again", async () => {
      const claimId = (await store.putPending(ORG_A, "rel-own", "mine")) as string;
      await store.release(ORG_A, "rel-own", claimId, "mine");
      expect(await rowFor(ORG_A, "rel-own")).toEqual([]);
      expect(await store.putPending(ORG_A, "rel-own", "mine")).toBeTruthy();
    });

    it("leaves a pending row another fingerprint owns, and never deletes a completed response", async () => {
      const claimId = (await store.putPending(ORG_A, "rel-other", "owner")) as string;
      await store.release(ORG_A, "rel-other", claimId, "intruder");
      expect(await rowFor(ORG_A, "rel-other")).toHaveLength(1);

      await store.complete(ORG_A, "rel-other", claimId, { status: "201", body: { id: 1 } });
      await store.release(ORG_A, "rel-other", claimId, "owner");
      expect(await rowFor(ORG_A, "rel-other")).toEqual([
        { state: "complete", request_hash: "owner", status: "201" },
      ]);
    });

    it("RLS: another tenant's release on the same key string deletes nothing", async () => {
      const claimId = (await store.putPending(ORG_A, "rel-tenant", "h")) as string;
      await store.release(ORG_B, "rel-tenant", claimId, "h");
      expect(await rowFor(ORG_A, "rel-tenant")).toHaveLength(1);
    });

    it("a stale generation cannot complete or release a newer claim with the same hash", async () => {
      const oldClaim = (await store.putPending(ORG_A, "same-generation-hash", "same-hash")) as string;
      await store.complete(ORG_A, "same-generation-hash", oldClaim, {
        status: "201",
        body: { generation: 1 },
      });
      await expire(ORG_A, "same-generation-hash");
      const newClaim = await store.putPending(ORG_A, "same-generation-hash", "same-hash");
      expect(newClaim).toBeTruthy();
      expect(newClaim).not.toBe(oldClaim);

      await store.complete(ORG_A, "same-generation-hash", oldClaim, {
        status: "201",
        body: { generation: "stale" },
      });
      await store.release(ORG_A, "same-generation-hash", oldClaim, "same-hash");
      expect(await rowFor(ORG_A, "same-generation-hash")).toEqual([
        { state: "pending", request_hash: "same-hash", status: null },
      ]);

      await store.complete(ORG_A, "same-generation-hash", newClaim as string, {
        status: "201",
        body: { generation: 2 },
      });
      expect(await rowFor(ORG_A, "same-generation-hash")).toEqual([
        { state: "complete", request_hash: "same-hash", status: "201" },
      ]);
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

    /** The request fingerprint from before the keyed hash, as the earlier middleware called it: scope `${orgId}|${userId}` (this app's context has no user). */
    const mainsHash = (key: string, body: unknown): string =>
      createHash("sha256")
        .update(JSON.stringify({ organizationId: `${ORG_A}|`, key, body }))
        .digest("hex");

    it("a row written before the keyed hash (plain SHA-256) is a 409 on the Postgres store, never a replay: the handler never runs and the row is left alone", async () => {
      handlerRuns = 0;
      const claimId = await store.putPending(
        ORG_A,
        "pre-deploy",
        mainsHash("pre-deploy", { a: 1 }),
      );
      expect(claimId).toBeTruthy();
      await store.complete(ORG_A, "pre-deploy", claimId as string, {
        status: "201",
        body: { run: "before-the-deploy" },
      });

      const sameRequest = await post("/open", "pre-deploy");
      expect(sameRequest.statusCode).toBe(409);
      expect(sameRequest.json().error?.code).toBe("IDEMPOTENCY_CONFLICT");
      const otherBody = await app.inject({
        method: "POST",
        url: "/open",
        headers: { "idempotency-key": "pre-deploy" },
        payload: { a: 2 },
      });
      expect(otherBody.statusCode).toBe(409);
      expect(handlerRuns).toBe(0);
      // the plain row is neither rewritten nor deleted by the refusal; the idempotency.cleanup sweep removes it at its TTL
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
      | "blocked"
      | "expired-pending-race" = "commit-then-500";
    let releaseBlocked: () => void = () => undefined;
    let firstExpiredPendingHandlerStarted: () => void = () => undefined;
    let secondExpiredPendingHandlerStarted: () => void = () => undefined;
    let releaseFirstExpiredPendingHandler: () => void = () => undefined;
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
        if (mode === "expired-pending-race" && runs === 1) {
          firstExpiredPendingHandlerStarted();
          await new Promise<void>((resolve) => {
            releaseFirstExpiredPendingHandler = resolve;
          });
        } else if (mode === "expired-pending-race" && runs === 2) {
          secondExpiredPendingHandlerStarted();
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

    it("an expired pending claim cannot be reclaimed while its original handler can still write", async () => {
      mode = "expired-pending-race";
      runs = 0;
      let firstStarted!: () => void;
      let secondStarted!: () => void;
      const firstStartedSignal = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const secondStartedSignal = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      firstExpiredPendingHandlerStarted = firstStarted;
      secondExpiredPendingHandlerStarted = secondStarted;

      const key = "live-expired-pending-race";
      const before = await probeRows();
      const first = post(key);
      await firstStartedSignal;
      await expire(ORG_A, key);

      const second = post(key);
      const secondOutcome = await Promise.race([
        secondStartedSignal.then(() => ({ kind: "handler" as const })),
        second.then((response) => ({ kind: "response" as const, response })),
      ]);

      // Always release the first request so a failing regression does not leak a blocked handler.
      releaseFirstExpiredPendingHandler();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);

      expect({
        secondOutcome: secondOutcome.kind,
        firstStatus: firstResponse.statusCode,
        secondStatus: secondResponse.statusCode,
        secondError: secondResponse.statusCode === 409 ? secondResponse.json().error.code : undefined,
        handlerRuns: runs,
        businessRowsWritten: (await probeRows()) - before,
      }).toEqual({
        secondOutcome: "response",
        firstStatus: 500,
        secondStatus: 409,
        secondError: "IDEMPOTENCY_IN_FLIGHT",
        handlerRuns: 1,
        businessRowsWritten: 1,
      });
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

  // CW-AC-36 — the concurrency proof and the release fence, on the real store and the real pool as `chartwarden_app`.
  describe("parallel retries of one key write once; a released key fences its request's late writes (CW-AC-36)", () => {
    const PARALLEL = 20;
    type Mode = "write" | "hang-before-write" | "write-then-hang" | "late-tx" | "late-autocommit";
    let app: FastifyInstance;
    let runs = 0;
    let mode: Mode = "write";
    // `hold` parks a handler (a request whose process is as good as dead); `startLate` lets abandoned work reach its first write.
    let hold: Promise<void> = Promise.resolve();
    let openHold: () => void = () => undefined;
    let lateStart: Promise<void> = Promise.resolve();
    let startLate: () => void = () => undefined;
    let lateWrite: Promise<unknown> = Promise.resolve();

    const rewind = (): void => {
      hold = new Promise<void>((resolve) => {
        openHold = resolve;
      });
      lateStart = new Promise<void>((resolve) => {
        startLate = resolve;
      });
    };
    const raceRows = async (key: string): Promise<number> =>
      Number(
        (await admin.query("SELECT count(*)::int AS n FROM idem_race_probe WHERE k = $1", [key]))
          .rows[0].n,
      );
    const post = (key: string) =>
      app.inject({
        method: "POST",
        url: "/race",
        headers: { "idempotency-key": key },
        payload: { a: 1 },
      });
    const wave = (key: string) => Array.from({ length: PARALLEL }, () => post(key));
    const codeOf = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
    const poll = async (reached: () => boolean | Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 500 && !(await reached()); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await reached()).toBe(true);
    };

    beforeAll(async () => {
      await admin.query(
        "CREATE TABLE idem_race_probe (id serial PRIMARY KEY, k text NOT NULL, n int NOT NULL)",
      );
      await admin.query("GRANT ALL ON idem_race_probe TO chartwarden_app");
      await admin.query("GRANT USAGE ON SEQUENCE idem_race_probe_id_seq TO chartwarden_app");
      rewind();
      app = Fastify();
      app.decorateRequest("context", undefined as never);
      app.addHook("onRequest", async (request) => {
        (request as unknown as { context: unknown }).context = { organizationId: ORG_A };
      });
      applyErrorHandler(app);
      applyIdempotency(app, store);
      app.post("/race", async (request, reply) => {
        runs += 1;
        const run = runs;
        const key = String(request.headers["idempotency-key"]);
        const scope = { organizationId: ORG_A, userId: "" };
        const insert = () =>
          withOrgContext(handle.db, scope, (tx) =>
            (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
              sql`INSERT INTO idem_race_probe (k, n) VALUES (${key}, ${run})`,
            ),
          );
        if (mode === "hang-before-write") await hold; // claimed, never wrote
        if (mode === "late-tx" || mode === "late-autocommit") {
          // The deadline pattern: answer 503 and abandon the work, which has not issued its first write yet.
          const autocommit = mode === "late-autocommit";
          lateWrite = lateStart
            .then(() =>
              autocommit
                ? handle.db.execute(sql`INSERT INTO idem_race_probe (k, n) VALUES (${key}, ${run})`)
                : insert(),
            )
            .then(
              () => "done",
              (error: unknown) => error,
            );
          return reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } });
        }
        await insert();
        if (mode === "write-then-hang") await hold; // wrote, never answered
        return reply.code(201).send({ run });
      });
      await app.ready();
    });
    afterAll(async () => {
      openHold();
      startLate();
      await app?.close();
    });

    it("N parallel requests with one key: one handler run, one row, one 201; the others are IN_FLIGHT, then N parallel retries all replay that response", async () => {
      mode = "write-then-hang";
      runs = 0;
      rewind();
      const key = "cw-ac-36-parallel";
      const settled: number[] = [];
      const first = wave(key).map((p) =>
        p.then((res) => {
          settled.push(res.statusCode);
          return res;
        }),
      );
      await poll(() => settled.length === PARALLEL - 1); // every loser answers while the winner is parked
      expect(settled.every((status) => status === 409)).toBe(true);
      openHold();
      const responses = await Promise.all(first);
      const winners = responses.filter((res) => res.statusCode === 201);
      expect(winners).toHaveLength(1);
      for (const res of responses.filter((r) => r.statusCode === 409)) {
        expect(codeOf(res)).toBe("IDEMPOTENCY_IN_FLIGHT");
      }
      expect(runs).toBe(1);
      expect(await raceRows(key)).toBe(1);
      expect(await rowFor(ORG_A, key)).toMatchObject([{ state: "complete", status: "201" }]);

      // the retries: the same one response, never a second run
      const replays = await Promise.all(wave(key));
      for (const res of replays) {
        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual(winners[0]?.json());
      }
      expect(runs).toBe(1);
      expect(await raceRows(key)).toBe(1);
    });

    it("crash BETWEEN CLAIM AND WRITE: parallel retries never run the handler, in flight and then stuck, and the claim is never reclaimed", async () => {
      mode = "hang-before-write";
      runs = 0;
      rewind();
      const key = "cw-ac-36-crash-before-write";
      const holder = post(key); // claims the key and never writes: its process is gone
      await poll(() => runs === 1);
      expect((await Promise.all(wave(key))).map(codeOf)).toEqual(
        Array(PARALLEL).fill("IDEMPOTENCY_IN_FLIGHT"),
      );
      await admin.query(
        "UPDATE idempotency_key SET created_at = now() - interval '20 minutes' WHERE key = $1",
        [key],
      );
      expect((await Promise.all(wave(key))).map(codeOf)).toEqual(
        Array(PARALLEL).fill("IDEMPOTENCY_KEY_STUCK"),
      );
      expect(runs).toBe(1); // none of the 2 x N retries ran the handler
      expect(await raceRows(key)).toBe(0);
      expect(await rowFor(ORG_A, key)).toMatchObject([{ state: "pending" }]); // never reclaimed or released
      openHold();
      expect((await holder).statusCode).toBe(201);
    });

    it("crash BETWEEN WRITE AND ANSWER: the write is durable, parallel retries never repeat it", async () => {
      mode = "write-then-hang";
      runs = 0;
      rewind();
      const key = "cw-ac-36-crash-after-write";
      const holder = post(key); // wrote and committed, then its process is gone before it answered
      await poll(async () => (await raceRows(key)) === 1);
      expect((await Promise.all(wave(key))).map(codeOf)).toEqual(
        Array(PARALLEL).fill("IDEMPOTENCY_IN_FLIGHT"),
      );
      await admin.query(
        "UPDATE idempotency_key SET created_at = now() - interval '20 minutes' WHERE key = $1",
        [key],
      );
      expect((await Promise.all(wave(key))).map(codeOf)).toEqual(
        Array(PARALLEL).fill("IDEMPOTENCY_KEY_STUCK"),
      );
      expect(runs).toBe(1);
      expect(await raceRows(key)).toBe(1);
      openHold();
      expect((await holder).statusCode).toBe(201);
    });

    it.each(["late-tx", "late-autocommit"] as const)(
      "a 503 over work that writes AFTER the answer (%s): the key is released, the late write is refused, and N parallel retries write once",
      async (lateMode) => {
        mode = lateMode;
        runs = 0;
        rewind();
        const key = `cw-ac-36-fence-${lateMode}`;
        expect((await post(key)).statusCode).toBe(503);
        expect(await rowFor(ORG_A, key)).toEqual([]); // released: nothing of the request had committed
        startLate(); // the abandoned work now reaches its first write
        // drizzle wraps what the driver throws; the cause is the pool's refusal
        expect((await lateWrite) as { cause?: unknown }).toMatchObject({
          cause: { code: "IDEMPOTENCY_WRITE_FENCED" },
        });
        expect(await raceRows(key)).toBe(0); // refused before the server saw it

        mode = "write";
        const retries = await Promise.all(wave(key));
        const done = retries.filter((res) => res.statusCode === 201);
        expect(done.length).toBeGreaterThanOrEqual(1);
        for (const res of retries.filter((r) => r.statusCode !== 201)) {
          expect(codeOf(res)).toBe("IDEMPOTENCY_IN_FLIGHT");
        }
        for (const res of done) expect(res.json()).toEqual(done[0]?.json());
        expect(runs).toBe(2); // the 503 run and exactly one retry
        expect(await raceRows(key)).toBe(1); // one write in all
        expect((await post(key)).json()).toEqual(done[0]?.json()); // and from now on it replays
        expect(runs).toBe(2);
      },
    );
  });
});
