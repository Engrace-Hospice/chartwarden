/**
 * device_attestation RLS "empty GUC" regression — LIVE Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * `createDbSessionContextStore` (packages/auth/src/identity/db-session-store.ts) LEFT JOINs
 * `device_attestation` from a bare (non-`withOrgContext`) query, because it resolves the session
 * BEFORE the caller's org is known — every authenticated request runs this query, including the very
 * first one on a freshly reused pooled connection.
 *
 * `device_attestation`'s RLS policy cast `current_setting('app.org_id', true)::uuid` with no NULLIF
 * guard. On a connection that has NEVER touched the GUC, `current_setting(..., true)` returns NULL and
 * the cast is skipped (the join legitimately finds nothing — every browser session has no attestation).
 * But Postgres reverts a CUSTOM GUC to the empty string, not NULL, once ANY transaction on that same
 * physical connection has run `set_config('app.org_id', …, true)` and committed (`withOrgContext`'s own
 * mechanism, used by literally every other org-scoped read in the app) — so the exact same cast throws
 * `22P02 invalid input syntax for type uuid: ""` on a REUSED connection, for a perfectly valid session.
 * In production this made `GET /api/v1/auth/context` — the endpoint every page calls first — fail
 * nondeterministically, purely as a function of which pooled connection the driver handed back.
 *
 * This never surfaced in `auth.live.test.ts` (TEST-003) because that suite builds a brand-new pool
 * whose first-ever query IS the session lookup — never a reused, already-poisoned connection. Here the
 * pool is pinned to a single connection (`max: 1`) and deliberately poisoned with a real
 * `withOrgContext` call first, so the session read that follows is guaranteed to run on the exact
 * connection the bug depends on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbActorEnrichmentReader, createDbSessionContextStore } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-1111f0da0001";
const ORG_B = "22222222-2222-4222-8222-2222f0da0002";
const USER = "33333333-3333-4333-8333-3333f0da0003";
const SESSION_ID = "sess-f0da-0001";

describe.skipIf(!DB_URL)("device_attestation RLS — empty-GUC-after-reuse", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

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
         ($1,'f0da-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f0da-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'f0da@example.test','F0DA User')`,
      [USER],
    );
    await admin.query(
      `INSERT INTO session (id,user_id,active_organization_id,token,expires_at) VALUES
         ($1,$2,$3,'f0da-token',now() + interval '1 day')`,
      [SESSION_ID, USER, ORG_A],
    );

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    // max: 1 — pins the pool to ONE physical connection, so the poisoning transaction below and the
    // session read after it are guaranteed to run on the same connection (the bug's precondition).
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string), max: 1 });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("a session read after an unrelated withOrgContext transaction on the same connection does not throw", async () => {
    // Poison the pool's one connection exactly the way ordinary traffic does: any org-scoped read.
    await withOrgContext(handle.db, { organizationId: ORG_B, userId: USER }, async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });

    // The bare, pre-org session lookup every authenticated request makes. Before the fix this threw
    // DrizzleQueryError / 22P02 on this exact connection; it must now resolve the row cleanly.
    const store = createDbSessionContextStore(handle.db, createDbActorEnrichmentReader(handle.db));
    const row = await store.read({ orgId: ORG_A }, SESSION_ID);
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(USER);
    expect(row?.organizationId).toBe(ORG_A);
    expect(row?.deviceAttestation).toBeNull();
  });

  it("stays reproducible under repeated poison→read cycles on the pinned connection", async () => {
    const store = createDbSessionContextStore(handle.db, createDbActorEnrichmentReader(handle.db));
    for (let i = 0; i < 5; i++) {
      await withOrgContext(handle.db, { organizationId: ORG_B, userId: USER }, async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });
      const row = await store.read({ orgId: ORG_A }, SESSION_ID);
      expect(row?.userId).toBe(USER);
    }
  });
});
