/**
 * M1 `idempotency.cleanup` — the sweeper must purge expired `idempotency_key` rows in EVERY organization status, and must never
 * delete a live claim.
 *
 * It enumerated only `active` orgs (the enumerator's default), so an org in `created` (the onboarding orgs, where platform
 * operators write onboarding data with an Idempotency-Key), `suspended` or `closed` kept its expired rows forever. The 24 h replay
 * window of the request fingerprint is only a window if the rows really go. And it SELECTs the expired ids and DELETEs them in a
 * second statement: `putPending` can reclaim an expired key in between (resetting the same row id to a fresh 24 h pending claim),
 * so the DELETE re-checks `expires_at`.
 *
 * LIVE by necessity: the table is RLS-forced (the delete runs per org under the NOBYPASSRLS `chartwarden_app` role), and the org
 * list is read through the REAL platform login (`chartwarden_platform_login`, built by scripts/db/provision-runtime-roles.ts) under
 * the real bypass auditor, whose `platform.bypass_invoked` audit row is asserted.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:idempotency:cleanup:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  IDEMPOTENCY_CLEANUP_JOB_ID,
  buildIdempotencyCleanupOrgs,
  runIdempotencyCleanup,
  wireIdempotencyCleanupTenancy,
} from "../src/bootstrap/jobs/idempotency-cleanup";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { m34PlatformBypassAuditor } from "../src/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-1334";

const ORGS = {
  created: "11111111-1111-4111-8111-111100130001",
  active: "22222222-2222-4222-8222-222200130002",
  suspended: "33333333-3333-4333-8333-333300130003",
  closed: "44444444-4444-4444-8444-444400130004",
  /** An active org that only holds an unexpired row: the sweep must leave it alone. */
  other: "55555555-5555-4555-8555-555500130005",
} as const;
type Status = "created" | "active" | "suspended" | "closed";
const STATUSES: readonly Status[] = ["created", "active", "suspended", "closed"];

describe.skipIf(!DB_URL)(
  "idempotency.cleanup — every organization status — LIVE Postgres + RLS",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let platformHandle: ReturnType<typeof createDbClient>;
    let store: ReturnType<typeof createDbIdempotencyStore>;

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
      for (const r of LIVE_DROP_ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
      await applyMigrations();
      // The REAL provisioning script: the carrier role with its enumerated grants + the BYPASSRLS platform login.
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
      for (const [name, id] of Object.entries(ORGS)) {
        const status: Status = (STATUSES as readonly string[]).includes(name)
          ? (name as Status)
          : "active";
        await admin.query(
          "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$3,$3,$4)",
          [id, `idem-clean-${name}`, `Cleanup ${name}`, status],
        );
      }
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const platformUrl = new URL(DB_URL as string);
      platformUrl.username = "chartwarden_platform_login";
      platformUrl.password = PLATFORM_PASSWORD;
      platformHandle = createDbClient({ connectionString: platformUrl.toString() });
      store = createDbIdempotencyStore(handle.db);
      wireIdempotencyCleanupTenancy();
    }, 300_000);

    afterAll(async () => {
      await platformHandle?.close();
      await handle?.close();
      await admin?.end();
    });

    // Every test seeds its own rows over an empty table: none depends on what another left behind.
    beforeEach(async () => {
      await admin.query("DELETE FROM idempotency_key");
    });

    /** One key per org, through the real store; `expired` back-dates it past its TTL. */
    async function seed(org: string, key: string, expired: boolean): Promise<void> {
      expect(await store.putPending(org, key, `hash-${key}`)).toBe(true);
      if (expired) {
        await admin.query(
          `UPDATE idempotency_key SET expires_at = now() - interval '1 minute'
          WHERE organization_id = $1 AND key = $2`,
          [org, key],
        );
      }
    }
    const keysOf = async (org: string): Promise<string[]> =>
      (
        await admin.query<{ key: string }>(
          "SELECT key FROM idempotency_key WHERE organization_id = $1 ORDER BY key",
          [org],
        )
      ).rows.map((r) => r.key);
    const bypassRows = async (): Promise<number> =>
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND correlation_id LIKE $1",
          [`platform-bypass:${IDEMPOTENCY_CLEANUP_JOB_ID}:%`],
        )
      ).rows[0]?.n ?? 0;
    const enumerateAll = () =>
      buildIdempotencyCleanupOrgs({
        platformDb: platformHandle.db,
        auditBypass: m34PlatformBypassAuditor,
      });

    it("the ACTIVE-ONLY default leaves created, suspended and closed orgs' expired rows (the defect)", async () => {
      for (const status of STATUSES) await seed(ORGS[status], "defect-expired", true);
      const activeOnly = buildActiveOrgEnumerator({
        platformDb: platformHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: IDEMPOTENCY_CLEANUP_JOB_ID,
        reason: "live: the active-only default",
      });
      await runIdempotencyCleanup({ db: handle.db, activeOrgs: activeOnly });
      expect(await keysOf(ORGS.active)).toEqual([]);
      for (const status of ["created", "suspended", "closed"] as const) {
        expect(await keysOf(ORGS[status]), status).toEqual(["defect-expired"]);
      }
    });

    it("the cleanup's own enumeration purges the expired rows of a created, an active, a suspended and a closed org", async () => {
      for (const status of STATUSES) {
        await seed(ORGS[status], "live-unexpired", false);
        await seed(ORGS[status], "live-expired", true);
      }
      await seed(ORGS.other, "other-unexpired", false);

      const purged = await runIdempotencyCleanup({ db: handle.db, activeOrgs: enumerateAll() });

      expect(purged).toBe(4); // one expired row per status
      for (const status of STATUSES) {
        expect(await keysOf(ORGS[status]), status).toEqual(["live-unexpired"]);
      }
      // another org's unexpired row is untouched
      expect(await keysOf(ORGS.other)).toEqual(["other-unexpired"]);
    });

    it("the enumeration goes through the platform bypass auditor: a platform.bypass_invoked audit row names the cleanup job", async () => {
      const before = await bypassRows();
      await runIdempotencyCleanup({ db: handle.db, activeOrgs: enumerateAll() });
      expect(await bypassRows()).toBe(before + 1);
    });

    it("a second pass is a no-op (reentrant): nothing live is ever deleted", async () => {
      for (const status of STATUSES) {
        await seed(ORGS[status], "re-unexpired", false);
        await seed(ORGS[status], "re-expired", true);
      }
      expect(await runIdempotencyCleanup({ db: handle.db, activeOrgs: enumerateAll() })).toBe(4);
      expect(await runIdempotencyCleanup({ db: handle.db, activeOrgs: enumerateAll() })).toBe(0);
      for (const status of STATUSES) expect(await keysOf(ORGS[status])).toEqual(["re-unexpired"]);
    });

    /** `db` with a hook that runs once, right after the sweeper's SELECT of the expired ids and before its DELETE. */
    function afterSweeperSelect(db: typeof handle.db, hook: () => Promise<void>): typeof handle.db {
      let fired = false;
      const hookSelect = (builder: unknown): unknown =>
        new Proxy(builder as object, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop === "limit") {
              return (n: number) =>
                Promise.resolve((value as (n: number) => unknown).call(target, n)).then(
                  async (rows) => {
                    if (!fired) {
                      fired = true;
                      await hook();
                    }
                    return rows;
                  },
                );
            }
            if (typeof value !== "function") return value;
            return (...args: unknown[]) =>
              hookSelect((value as (...a: unknown[]) => unknown).apply(target, args));
          },
        });
      const wrapTx = (tx: object): object =>
        new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== "function") return value;
            if (prop === "select") {
              return (...args: unknown[]) =>
                hookSelect((value as (...a: unknown[]) => unknown).apply(target, args));
            }
            return value.bind(target);
          },
        });
      return new Proxy(db as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") return value;
          if (prop === "transaction") {
            return (cb: (tx: object) => unknown, ...rest: unknown[]) =>
              (value as (...a: unknown[]) => unknown).call(
                target,
                (tx: object) => cb(wrapTx(tx)),
                ...rest,
              );
          }
          return value.bind(target);
        },
      }) as typeof handle.db;
    }

    it("a key reclaimed between the sweeper's SELECT and its DELETE is a live claim and survives; the sweeper never re-runs a handler", async () => {
      await seed(ORGS.active, "reclaimed", true);
      await seed(ORGS.active, "still-expired", true);
      const hooked = afterSweeperSelect(handle.db, async () => {
        // exactly what putPending does for an expired key: the SAME row id, a fresh 24 h pending claim
        expect(await store.putPending(ORGS.active, "reclaimed", "claimed-again")).toBe(true);
      });
      const purged = await runIdempotencyCleanup({
        db: hooked,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORGS.active }] },
      });
      expect(purged).toBe(1); // only the row that was still expired; the reclaimed claim is not counted as purged
      expect(await keysOf(ORGS.active)).toEqual(["reclaimed"]);
      const row = (
        await admin.query<{ state: string; request_hash: string }>(
          "SELECT state::text AS state, request_hash FROM idempotency_key WHERE organization_id = $1 AND key = 'reclaimed'",
          [ORGS.active],
        )
      ).rows[0];
      expect(row).toEqual({ state: "pending", request_hash: "claimed-again" });
    });
  },
);
