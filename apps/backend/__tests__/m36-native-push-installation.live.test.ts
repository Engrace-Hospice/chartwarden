/**
 * M36 ADR-0105 - native push installation identity on `delivery_endpoint`, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Proves the SQL the in-memory unit test cannot: a rotated token replaces the token in place (one row per phone, `rotated_at` set);
 * a legacy row already holding the new token is removed; two simultaneous registrations of the same install both succeed and leave
 * ONE row (no 23505 -> 500 that would log the token); an older client re-registering without an install id keeps the row's identity;
 * two phones stay two rows; the list is scoped to the caller and never carries the token.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:native-push-installation:live
 * For a local PG without pgvector also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const KEK = Buffer.alloc(32, 7);
const tokenOf = (c: string) => c.repeat(64);

describe.skipIf(!DB_URL)("M36 native push installation (ADR-0105) - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let org: string;
  let phoneUser: string;
  let otherUser: string;
  let n = 0;

  const rows = async (userId: string) =>
    (
      await admin.query(
        `SELECT id, provider, install_id, endpoint_value, rotated_at
           FROM delivery_endpoint WHERE user_id=$1 ORDER BY created_at, id`,
        [userId],
      )
    ).rows as Array<{
      id: string;
      provider: string;
      install_id: string | null;
      endpoint_value: string;
      rotated_at: Date | null;
    }>;
  const freshInstall = () => `install_live${String(++n).padStart(4, "0")}`;
  const apns = (target: string, installId?: string) => ({
    channel: "push" as const,
    provider: "apns" as const,
    target,
    ...(installId
      ? {
          installId,
          environment: "production" as const,
          appVersion: "1.0.0",
          appBuild: "1",
        }
      : {}),
  });
  const seedUser = async (name: string): Promise<string> => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `npi-${name}@x.test`,
        `NPI ${name}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, org],
    );
    return id;
  };

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
    org = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('npi-a','A','A') RETURNING id",
      )
    ).rows[0].id as string;
    phoneUser = await seedUser("phone");
    otherUser = await seedUser("other");
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      sendEndpointVerificationCode: async () => undefined,
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("replaces the token in place when the same install re-registers", async () => {
    const install = freshInstall();
    const first = await service.registerEndpoint(org, phoneUser, apns(tokenOf("a"), install));
    const second = await service.registerEndpoint(org, phoneUser, apns(tokenOf("b"), install));

    expect(second.endpointId).toBe(first.endpointId);
    const mine = (await rows(phoneUser)).filter((r) => r.install_id === install);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ endpoint_value: tokenOf("b") });
    expect(mine[0]?.rotated_at).not.toBeNull();
  });

  it("removes a legacy row that already holds the new token", async () => {
    const legacy = await service.registerEndpoint(org, phoneUser, apns(tokenOf("c")));
    const install = freshInstall();
    const bound = await service.registerEndpoint(org, phoneUser, apns(tokenOf("d"), install));
    const moved = await service.registerEndpoint(org, phoneUser, apns(tokenOf("c"), install));

    expect(moved.endpointId).toBe(bound.endpointId);
    const all = await rows(phoneUser);
    expect(all.find((r) => r.id === legacy.endpointId)).toBeUndefined();
    expect(all.filter((r) => r.endpoint_value === tokenOf("c"))).toHaveLength(1);
  });

  it("two simultaneous registrations of one install both succeed and leave one row", async () => {
    const install = freshInstall();
    const results = await Promise.allSettled([
      service.registerEndpoint(org, phoneUser, apns(tokenOf("e"), install)),
      service.registerEndpoint(org, phoneUser, apns(tokenOf("f"), install)),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await rows(phoneUser)).filter((r) => r.install_id === install)).toHaveLength(1);
  });

  it("an older client re-registering without an install id keeps the row's identity", async () => {
    const install = freshInstall();
    await service.registerEndpoint(org, phoneUser, apns(tokenOf("g"), install));
    await service.registerEndpoint(org, phoneUser, apns(tokenOf("g")));

    const mine = (await rows(phoneUser)).filter((r) => r.endpoint_value === tokenOf("g"));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.install_id).toBe(install);
  });

  it("keeps two phones as two rows", async () => {
    const before = (await rows(phoneUser)).length;
    await service.registerEndpoint(org, phoneUser, apns(tokenOf("h"), freshInstall()));
    await service.registerEndpoint(org, phoneUser, apns(tokenOf("i"), freshInstall()));
    expect((await rows(phoneUser)).length).toBe(before + 2);
  });

  it("scopes the list to the caller and never returns a token", async () => {
    await service.registerEndpoint(org, otherUser, apns(tokenOf("j"), freshInstall()));
    const mineList = JSON.stringify(await service.listEndpoints(org, phoneUser));
    const otherList = JSON.stringify(await service.listEndpoints(org, otherUser));

    expect(otherList).not.toContain(tokenOf("j"));
    expect(mineList).not.toContain(tokenOf("a"));
    expect(mineList).not.toContain(tokenOf("b"));
    expect((await service.listEndpoints(org, otherUser)).length).toBe(1);
  });
});
