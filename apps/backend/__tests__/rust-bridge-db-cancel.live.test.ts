/**
 * CW-RUST-M02 P2 prerequisite 6 — abandoned database work is CANCELLED, not merely no longer waited for.
 * LIVE Postgres, as the NOBYPASSRLS `chartwarden_app` role (tenant paths) and a BYPASSRLS platform login (enumerator).
 *
 * The parity sweep's `bounded()` and the shadow recheck's `withTimeout()` give a hard REPORTING deadline, but a
 * JavaScript promise cannot cancel a running PostgreSQL statement: the backend keeps working, and keeps its pool
 * connection, until something on the server side ends it. This suite proves that something exists for each of the
 * four database paths the sweep and the recheck use:
 *
 *   1. the audited org enumerator   (`buildActiveOrgEnumerator`, platform pool)
 *   2. the member list              (`createSweepMembershipReader().listActiveMembers`)
 *   3. the member count             (`createSweepMembershipReader().countActiveMembers`)
 *   4. the uncached resolver        (`createDbEffectivePermissionStore().loadGrants`, used by the sweep AND the recheck)
 *
 * Method: hold an ACCESS EXCLUSIVE lock on the table the path reads (so the real production query blocks, exactly as a
 * stuck query would), run the path under the real abandon wrapper, let it be abandoned, then read `pg_stat_activity`
 * from a separate connection and assert (a) the query WAS still running after the abandon, (b) it is gone within the
 * stated bound, (c) it ended as `query_canceled` (57014), and (d) its pool connection went back to the pool.
 *
 * Connection ACQUISITION is bounded separately: `createDbClient` sets `connectionTimeoutMillis` (10 s), asserted below.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbEffectivePermissionStore, resolveEffectivePermissions } from "@chartwarden/auth";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  type DbClient,
  createDbClient,
  schema,
} from "@chartwarden/db";
import { registerPlatformJob, resetPlatformJobRegistry } from "@chartwarden/tenancy";
import { getTableName, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  SHADOW_FRESH_TIMEOUT_MS,
  SWEEP_OP_TIMEOUT_MS,
  SWEEP_STATEMENT_TIMEOUT_MS,
  bounded,
  createMePermissionsBridge,
  createSweepMembershipReader,
  parseRustBridgeConfig,
} from "../src/bootstrap/rust-bridge";
import {
  FRESH_RECHECK_STATEMENT_TIMEOUT_MS,
  createFreshRecheckStore,
} from "../src/modules/03-authorization";
import { appRoleUrl, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG = "11111111-1111-4111-8111-1111c0de0001";
const USER = "33333333-3333-4333-8333-3333c0de0003";
const MEMBERSHIP = "44444444-4444-4444-8444-4444c0de0004";
const ROLE = "55555555-5555-4555-8555-5555c0de0005";
const PLATFORM_ROLE = "chartwarden_platform_live_test";
const PLATFORM_PASSWORD = "platform_live_test";
const JOB_ID = "p6-abandoned-db-work-test";

/** The sweep's per-operation limit / the recheck's `freshTimeoutMs`, shortened so the suite is quick. */
const ABANDON_MS = 300;
/** Server-side cap given to the opt-in paths (enumerator, uncached resolver) in this suite. */
const CAP_MS = 1_500;
/** Scheduling slack on top of a server-side cap before "gone" is called late. */
const SLACK_MS = 2_000;

const SIGNING_KEY = `k1=${Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 3)]).toString("base64url")}`;

describe.skipIf(!DB_URL)("rust bridge — abandoned database work is cancelled (P2 prereq 6)", () => {
  let admin: Client;
  const closers: (() => Promise<void>)[] = [];

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        text = text.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(text);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    await applyMigrations();

    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status)
       VALUES ($1,'p6-a','P6 Hospice LLC','P6 Hospice','active')`,
      [ORG],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'p6@example.test','P6 User')`,
      [USER],
    );
    await admin.query(
      `INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')`,
      [MEMBERSHIP, USER, ORG],
    );
    await admin.query(
      `INSERT INTO role (id,organization_id,key,name,category) VALUES ($1,$2,'p6_reader','P6 reader','clinical_staff')`,
      [ROLE, ORG],
    );
    await admin.query(
      `INSERT INTO role_permission (organization_id,role_id,permission_key)
       VALUES ($1,$2,'orders.transmission.view_held')`,
      [ORG, ROLE],
    );
    await admin.query(
      `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)`,
      [ORG, MEMBERSHIP, ROLE],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD 'chartwarden_app_live_test'`);
    // A BYPASSRLS login with SELECT on `organization` only: the shape of `chartwarden_platform_login`.
    await admin.query(
      `CREATE ROLE ${PLATFORM_ROLE} LOGIN BYPASSRLS PASSWORD '${PLATFORM_PASSWORD}'`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${PLATFORM_ROLE}`);
    await admin.query(`GRANT SELECT ON organization TO ${PLATFORM_ROLE}`);
    registerPlatformJob(JOB_ID);
  }, 180_000);

  afterAll(async () => {
    resetPlatformJobRegistry();
    for (const close of closers.splice(0)) await close();
    await admin?.end();
  });

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

  interface Subject {
    readonly app: string;
    readonly db: DbClient;
    readonly pool: ReturnType<typeof createDbClient>["pool"];
  }

  /** A pool whose backends are findable in `pg_stat_activity` by `application_name`. */
  function subject(as: "app" | "platform", app: string): Subject {
    const url = new URL(DB_URL as string);
    if (as === "app") {
      const u = new URL(appRoleUrl(DB_URL as string));
      url.username = u.username;
      url.password = u.password;
    } else {
      url.username = PLATFORM_ROLE;
      url.password = PLATFORM_PASSWORD;
    }
    url.searchParams.set("application_name", app);
    const h = createDbClient({ connectionString: url.toString(), max: 2 });
    closers.push(() => h.close());
    return { app, db: h.db, pool: h.pool };
  }

  /** Holds ACCESS EXCLUSIVE on `table` from a separate session until released: every read of it blocks. */
  async function holdLock(table: string) {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
    return {
      release: async () => {
        try {
          await c.query("ROLLBACK");
        } finally {
          await c.end();
        }
      },
    };
  }

  /** Backends of this subject that are doing work (running, or holding an open transaction). */
  async function liveBackends(app: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid() AND state IN ('active','idle in transaction')`,
      [app],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Polls `pred` every 50 ms; resolves with the time it first held, or throws naming `what`. */
  async function until(pred: () => Promise<boolean>, withinMs: number, what: string) {
    const t0 = performance.now();
    while (performance.now() - t0 <= withinMs) {
      if (await pred()) return performance.now();
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${what} (not true within ${withinMs} ms)`);
  }

  /** The SQLSTATE of a driver error, however deeply the ORM wrapped it. */
  function sqlState(e: unknown): string | undefined {
    for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; i++) {
      if (typeof x.code === "string" && /^[0-9A-Z]{5}$/.test(x.code)) return x.code;
      x = x.cause as typeof x;
    }
    return undefined;
  }

  /**
   * Starts `run` under the sweep's own abandon wrapper, lets it be abandoned, then proves the server side cleaned up.
   * `capMs` is the stated bound: the abandoned backend must be gone within `capMs + SLACK_MS` of the call starting.
   */
  async function expectAbandonedWorkCancelled(
    s: Subject,
    capMs: number,
    run: () => Promise<unknown>,
  ): Promise<void> {
    const startedAt = performance.now();
    const call = run();
    const outcome = call.then(
      () => null,
      (e: unknown) => e,
    );
    let abandoned = 0;
    await expect(
      bounded(call, ABANDON_MS, undefined, () => {
        abandoned++;
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(abandoned).toBe(1);

    // The wrapper has stopped waiting. Guard against a vacuous pass: the query must still be running right now.
    await until(
      async () => (await liveBackends(s.app)) === 1,
      1_000,
      "the abandoned query never reached PostgreSQL",
    );

    // (b) …and PostgreSQL itself must end it, within the stated bound.
    const goneAt = await until(
      async () => (await liveBackends(s.app)) === 0,
      capMs + SLACK_MS - (performance.now() - startedAt),
      `abandoned query still running in PostgreSQL ${Math.round(performance.now() - startedAt)} ms after it started — nothing cancelled it`,
    );
    expect(goneAt - startedAt).toBeLessThanOrEqual(capMs + SLACK_MS);

    // (c) it ended because the server cancelled it, not because something else broke.
    expect(sqlState(await outcome)).toBe("57014"); // query_canceled (statement timeout)

    // (d) its pool connection went back to the pool and is usable.
    expect(s.pool.waitingCount).toBe(0);
    await until(
      async () => s.pool.idleCount === s.pool.totalCount,
      1_000,
      "the cancelled query's pool connection was not returned",
    );
    await s.db.execute(sql`SELECT 1`);
  }

  // ── the four paths ──────────────────────────────────────────────────────────────────────────────────────────

  it("pool connection acquisition is bounded (connectionTimeoutMillis), not infinite", () => {
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    const s = subject("app", "p6-pool-bound");
    expect(
      (s.pool as unknown as { options: { connectionTimeoutMillis: number } }).options
        .connectionTimeoutMillis,
    ).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
  });

  describe("1. audited org enumerator (platform pool)", () => {
    it("a blocked org read is cancelled by the statement cap", async () => {
      const s = subject("platform", "p6-enumerator-read");
      const lock = await holdLock(getTableName(schema.organizations));
      try {
        const enumerate = buildActiveOrgEnumerator({
          platformDb: s.db,
          auditBypass: async () => {},
          jobId: JOB_ID,
          statementTimeoutMs: CAP_MS,
        });
        await expectAbandonedWorkCancelled(s, CAP_MS, () => enumerate.listActiveOrgs());
      } finally {
        await lock.release();
      }
    }, 30_000);

    it("a stuck bypass-audit write is cancelled too (the cap is set before the audit statement)", async () => {
      const s = subject("platform", "p6-enumerator-audit");
      const enumerate = buildActiveOrgEnumerator({
        platformDb: s.db,
        // Stands in for the audit INSERT: a statement that would run for 30 s.
        auditBypass: async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(30)`);
        },
        jobId: JOB_ID,
        statementTimeoutMs: CAP_MS,
      });
      await expectAbandonedWorkCancelled(s, CAP_MS, () => enumerate.listActiveOrgs());
    }, 30_000);

    it("with the cap on, a healthy enumeration still returns the active orgs and runs the audit", async () => {
      const s = subject("platform", "p6-enumerator-ok");
      let audited = 0;
      const enumerate = buildActiveOrgEnumerator({
        platformDb: s.db,
        auditBypass: async () => {
          audited++;
        },
        jobId: JOB_ID,
        statementTimeoutMs: CAP_MS,
      });
      expect(await enumerate.listActiveOrgs()).toEqual([{ organizationId: ORG }]);
      expect(audited).toBe(1);
    });
  });

  describe("2 + 3. member list and member count (tenant pool, existing 10 s cap)", () => {
    it("a blocked member LIST is cancelled by SWEEP_STATEMENT_TIMEOUT_MS", async () => {
      const s = subject("app", "p6-member-list");
      const lock = await holdLock(getTableName(schema.memberships));
      try {
        const reader = createSweepMembershipReader(s.db);
        await expectAbandonedWorkCancelled(s, SWEEP_STATEMENT_TIMEOUT_MS, () =>
          reader.listActiveMembers(ORG),
        );
      } finally {
        await lock.release();
      }
    }, 40_000);

    it("a blocked member COUNT is cancelled by SWEEP_STATEMENT_TIMEOUT_MS", async () => {
      const s = subject("app", "p6-member-count");
      const lock = await holdLock(getTableName(schema.memberships));
      try {
        const reader = createSweepMembershipReader(s.db);
        await expectAbandonedWorkCancelled(s, SWEEP_STATEMENT_TIMEOUT_MS, () =>
          reader.countActiveMembers(ORG),
        );
      } finally {
        await lock.release();
      }
    }, 40_000);

    it("the cap sits below the sweep's per-operation limit, so PostgreSQL cancels before the wrapper abandons", () => {
      // The server-side cap must fire first so the normal outcome is a clean error, not an abandon.
      expect(SWEEP_STATEMENT_TIMEOUT_MS).toBeLessThan(SWEEP_OP_TIMEOUT_MS);
    });
  });

  describe("4. uncached permission resolver (tenant pool; sweep and shadow recheck)", () => {
    const resolveFresh =
      (store: ReturnType<typeof createDbEffectivePermissionStore>) => async () => [
        ...resolveEffectivePermissions(await store.loadGrants(ORG, USER), Date.now()).permissions,
      ];

    it("a blocked uncached resolution, abandoned by the SWEEP wrapper, is cancelled by the statement cap", async () => {
      const s = subject("app", "p6-resolver-sweep");
      const lock = await holdLock(getTableName(schema.memberships));
      try {
        const store = createDbEffectivePermissionStore(s.db, { statementTimeoutMs: CAP_MS });
        await expectAbandonedWorkCancelled(s, CAP_MS, resolveFresh(store));
      } finally {
        await lock.release();
      }
    }, 30_000);

    it("a blocked uncached resolution, abandoned by the SHADOW RECHECK (real bridge), is cancelled too", async () => {
      const s = subject("app", "p6-resolver-shadow");
      const lock = await holdLock(getTableName(schema.memberships));
      try {
        // The production wiring (3 s cap), not a test-local store: deleting the cap at the call site fails this test.
        const store = createFreshRecheckStore(s.db);
        const lines: string[] = [];
        const bridge = createMePermissionsBridge({
          config: parseRustBridgeConfig({
            RUST_ROUTES: "me-permissions",
            RUST_ROUTE_MODE: "shadow",
            CW_ACTOR_SIGNING_KEY: SIGNING_KEY,
          }),
          signer: { sign: () => "signed.token.value" },
          // Rust and Bun disagree, so the shadow path runs the uncached re-check.
          client: {
            get: async () => ({
              ok: true,
              status: 200,
              contentType: "application/json",
              body: { permissions: ["rust.only"] },
            }),
          },
          logger: {
            info: (o, m) => lines.push(JSON.stringify({ ...o, m })),
            warn: (o, m) => lines.push(JSON.stringify({ ...o, m })),
          },
          freshTimeoutMs: ABANDON_MS,
        });
        const startedAt = performance.now();
        await bridge.handle({
          actor: {
            userId: USER,
            organizationId: ORG,
            sessionId: "s-p6",
            sessionClass: "staff",
            requestId: "r-p6",
          },
          bun: async () => ({ permissions: ["bun.only"] }),
          fresh: async () => ({ permissions: await resolveFresh(store)() }),
          afterResponse: (cb) => cb(),
        });
        // The recheck's own deadline fires first and reports an error, never a classification…
        await until(
          async () => lines.some((l) => l.includes("fresh_timeout")),
          2_000,
          "the shadow recheck never reported fresh_timeout",
        );
        // …and the abandoned query is then cancelled by the server inside the stated bound.
        await until(
          async () => (await liveBackends(s.app)) === 1,
          1_000,
          "recheck never reached PostgreSQL",
        );
        const goneAt = await until(
          async () => (await liveBackends(s.app)) === 0,
          FRESH_RECHECK_STATEMENT_TIMEOUT_MS + SLACK_MS,
          "abandoned recheck query still running in PostgreSQL — nothing cancelled it",
        );
        expect(goneAt - startedAt).toBeLessThanOrEqual(
          FRESH_RECHECK_STATEMENT_TIMEOUT_MS + SLACK_MS,
        );
        expect(s.pool.waitingCount).toBe(0);
        await until(
          async () => s.pool.idleCount === s.pool.totalCount,
          1_000,
          "the cancelled recheck's pool connection was not returned",
        );
        bridge.close();
      } finally {
        await lock.release();
      }
    }, 30_000);

    it("the cap is one budget for the whole read: a blocked SECOND statement is cancelled within the cap, not 2 x the cap", async () => {
      const s = subject("app", "p6-resolver-second");
      // `role_permission` is read by the second statement only; the first (grants) passes at once and uses little budget.
      const lock = await holdLock(getTableName(schema.rolePermissions));
      try {
        const store = createDbEffectivePermissionStore(s.db, { statementTimeoutMs: CAP_MS });
        const startedAt = performance.now();
        const outcome = await store.loadGrants(ORG, USER).then(
          () => null,
          (e: unknown) => e,
        );
        expect(sqlState(outcome)).toBe("57014");
        expect(performance.now() - startedAt).toBeLessThanOrEqual(CAP_MS + 500);
      } finally {
        await lock.release();
      }
    }, 30_000);

    it("the recheck's production cap sits just above its own deadline (label unchanged; a stuck statement ends ≤ 1 s later)", () => {
      expect(FRESH_RECHECK_STATEMENT_TIMEOUT_MS).toBeGreaterThan(SHADOW_FRESH_TIMEOUT_MS);
      expect(FRESH_RECHECK_STATEMENT_TIMEOUT_MS - SHADOW_FRESH_TIMEOUT_MS).toBeLessThanOrEqual(
        1_000,
      );
    });

    it("with the cap on, a healthy resolution returns exactly what the uncapped store returns", async () => {
      const s = subject("app", "p6-resolver-ok");
      const capped = createDbEffectivePermissionStore(s.db, { statementTimeoutMs: CAP_MS });
      const plain = createDbEffectivePermissionStore(s.db);
      const a = await capped.loadGrants(ORG, USER);
      const b = await plain.loadGrants(ORG, USER);
      expect(a).toEqual(b);
      expect(a.flatMap((g) => g.permissionKeys)).toEqual(["orders.transmission.view_held"]);
    });
  });
});
