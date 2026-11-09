/**
 * M1 `idempotency.cleanup` — the sweeper must purge expired `idempotency_key` rows in EVERY organization status.
 *
 * It enumerated only `active` orgs (the enumerator's default), so an org in `created` (the onboarding orgs, where
 * platform operators write onboarding data with an Idempotency-Key), `suspended` or `closed` kept its expired rows
 * forever. The 24 h replay window of the request fingerprint is only a window if the rows really go.
 *
 * LIVE by necessity: the table is RLS-forced (the delete runs per org under the NOBYPASSRLS `chartwarden_app` role),
 * and the org list is read through the separately-pooled platform login (a BYPASSRLS role with SELECT on `organization`).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:idempotency:cleanup:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  buildIdempotencyCleanupOrgs,
  runIdempotencyCleanup,
  wireIdempotencyCleanupTenancy,
} from "../src/bootstrap/jobs/idempotency-cleanup";
import { IDEMPOTENCY_CLEANUP_JOB_ID } from "../src/bootstrap/jobs/idempotency-cleanup";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_ROLE = "chartwarden_platform_live_test";
const PLATFORM_PASSWORD = "platform_live_test";

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
      // The platform login's stand-in: BYPASSRLS, SELECT on `organization` only (the real role is created out-of-band by ops).
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_ROLE}') THEN
         CREATE ROLE ${PLATFORM_ROLE} LOGIN BYPASSRLS PASSWORD '${PLATFORM_PASSWORD}'; END IF; END $$;`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${PLATFORM_ROLE}`);
      await admin.query(`GRANT SELECT ON organization TO ${PLATFORM_ROLE}`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const platformUrl = new URL(DB_URL as string);
      platformUrl.username = PLATFORM_ROLE;
      platformUrl.password = PLATFORM_PASSWORD;
      platformHandle = createDbClient({ connectionString: platformUrl.toString() });
      store = createDbIdempotencyStore(handle.db);
      wireIdempotencyCleanupTenancy();
    }, 180_000);

    afterAll(async () => {
      await platformHandle?.close();
      await handle?.close();
      await admin?.end();
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
    const enumerateAll = () =>
      buildIdempotencyCleanupOrgs({ platformDb: platformHandle.db, auditBypass: async () => {} });

    it("the ACTIVE-ONLY default leaves created, suspended and closed orgs' expired rows (the defect)", async () => {
      for (const status of STATUSES) await seed(ORGS[status], "defect-expired", true);
      const activeOnly = buildActiveOrgEnumerator({
        platformDb: platformHandle.db,
        auditBypass: async () => {},
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

      // 4 orgs x "live-expired" + the 3 "defect-expired" rows the active-only default left behind.
      expect(purged).toBe(7);
      for (const status of STATUSES) {
        const keys = await keysOf(ORGS[status]);
        expect(keys, status).toEqual(["live-unexpired"]);
      }
      // another org's unexpired row is untouched
      expect(await keysOf(ORGS.other)).toEqual(["other-unexpired"]);
    });

    it("a second pass is a no-op (reentrant): nothing live is ever deleted", async () => {
      const purged = await runIdempotencyCleanup({ db: handle.db, activeOrgs: enumerateAll() });
      expect(purged).toBe(0);
      for (const status of STATUSES) expect(await keysOf(ORGS[status])).toEqual(["live-unexpired"]);
      expect(await keysOf(ORGS.other)).toEqual(["other-unexpired"]);
    });
  },
);
