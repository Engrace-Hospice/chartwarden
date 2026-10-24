/**
 * F-173 (#248, m1 group) — LIVE Postgres proof that `createDrizzleSystemStatusReader`
 * (`apps/backend/src/bootstrap/system-status-store.ts`) actually persists `POST /admin/system/status`
 * to the real `system_status` table, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * THE GAP THIS CLOSES (F-156, #248). No Drizzle-backed `SystemStatusReader` existed anywhere in the
 * repository; the composition root always fell back to `createInMemorySystemStatusReader()`, a
 * per-process `Map`. The admin route's own mutation had therefore never once persisted, in any
 * environment. This suite is LIVE by necessity: the claim under test is that `system_status` carries no
 * RLS at all (a plain GRANT is sufficient for the NOBYPASSRLS app role to read AND write it) and that
 * `ON CONFLICT (id)` upserts rather than duplicates — both are statements about Postgres an in-memory
 * double cannot be wrong about.
 *
 * Proves: an upsert persists across two independently-constructed reader instances (real durability, not
 * a shared in-process reference); a second upsert on the same `id` UPDATES in place (`ON CONFLICT`); two
 * different `orgId` arguments passed to `list`/`upsert` see and affect the EXACT SAME row (proving the
 * table is genuinely NON_ORG_SCOPED and the reader's `orgId` parameter is correctly ignored, not silently
 * dropping data); the NOBYPASSRLS `chartwarden_app` role can read and write the table directly with no
 * `withOrgContext` envelope.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m1:system-status-store:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleSystemStatusReader } from "../src/bootstrap/system-status-store";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-1111f1730001";
const ORG_B = "22222222-2222-4222-8222-2222f1730002";

describe.skipIf(!DB_URL)("F-173 (#248) — M1 Drizzle SystemStatusReader — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM system_status");
  });

  it("persists across independently-constructed reader instances (real durability)", async () => {
    const writer = createDrizzleSystemStatusReader(handle.db);
    await writer.upsert(ORG_A, {
      id: "api",
      status: "degraded",
      headline: "Elevated error rate",
      details: "5xx rate above threshold for 3 minutes.",
      updatedAt: "2026-09-29T10:00:00.000Z",
    });

    // A fresh instance, no shared in-process reference — proves the write reached Postgres, not a
    // closure variable the first instance happened to also read back.
    const reader = createDrizzleSystemStatusReader(handle.db);
    const components = await reader.list(ORG_A);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      id: "api",
      status: "degraded",
      headline: "Elevated error rate",
      details: "5xx rate above threshold for 3 minutes.",
    });
  });

  it("a second upsert on the same id UPDATES in place rather than duplicating (ON CONFLICT)", async () => {
    const store = createDrizzleSystemStatusReader(handle.db);
    await store.upsert(ORG_A, {
      id: "documents",
      status: "outage",
      headline: "Object store unreachable",
      details: null,
      updatedAt: "2026-09-29T09:00:00.000Z",
    });
    await store.upsert(ORG_A, {
      id: "documents",
      status: "operational",
      headline: null,
      details: "Recovered.",
      updatedAt: "2026-09-29T09:05:00.000Z",
    });

    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM system_status WHERE id = 'documents'",
    );
    expect(rows[0].n).toBe(1);
    const components = await store.list(ORG_A);
    const doc = components.find((c) => c.id === "documents");
    expect(doc?.status).toBe("operational");
    expect(doc?.headline).toBeNull();
    expect(doc?.details).toBe("Recovered.");
  });

  it("two different orgId arguments see and affect the SAME row — the table is genuinely NON_ORG_SCOPED", async () => {
    const store = createDrizzleSystemStatusReader(handle.db);
    await store.upsert(ORG_A, {
      id: "database_replication",
      status: "degraded",
      headline: "Lag above threshold",
      details: null,
      updatedAt: "2026-09-29T11:00:00.000Z",
    });

    // Org B's own reader call (a different orgId argument entirely) sees the SAME row Org A wrote — the
    // opposite of an org-scoped reader, and precisely the platform-global contract F-156 found broken.
    const fromOrgB = await store.list(ORG_B);
    expect(fromOrgB).toHaveLength(1);
    expect(fromOrgB[0]).toMatchObject({ id: "database_replication", status: "degraded" });

    // And a write under Org B's orgId argument updates the exact same row Org A's read just saw.
    await store.upsert(ORG_B, {
      id: "database_replication",
      status: "operational",
      headline: null,
      details: "Recovered.",
      updatedAt: "2026-09-29T11:10:00.000Z",
    });
    const fromOrgA = await store.list(ORG_A);
    expect(fromOrgA).toHaveLength(1);
    expect(fromOrgA[0]).toMatchObject({ id: "database_replication", status: "operational" });
  });

  it("an unrelated component written directly (e.g. by an outbox consumer) is visible through the reader too", async () => {
    // The same table the two existing outbox consumers (`buildM1LagProbeStatusConsumer`,
    // `buildM1MacPortalHealthConsumer`) already write via raw Drizzle — proving this reader and those
    // consumers genuinely share one table, not two divergent write paths.
    await admin.query(
      `INSERT INTO system_status (id, status, headline, details, updated_at)
       VALUES ('mac_portal:ngs-j6', 'degraded', 'MAC portal (ngs-j6) unreachable', null, now())`,
    );
    const store = createDrizzleSystemStatusReader(handle.db);
    const components = await store.list(ORG_A);
    const macPortal = components.find((c) => c.id === "mac_portal:ngs-j6");
    expect(macPortal?.status).toBe("degraded");
  });
});
