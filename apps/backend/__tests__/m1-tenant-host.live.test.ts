/**
 * ADR-0049 — the tenant-host guard over the REAL database adapter, as the real NOBYPASSRLS `chartwarden_app` role.
 *
 * The unit suite proves the guard's decisions against a fake resolver; this proves the other half: that
 * `createDbTenantHostResolver` reads `resolve_tenant_host` (migration 1145) correctly before any org is bound, and
 * that the guard built on it refuses a session on another tenant's host, redirects a retired alias, and refuses a
 * suspended or closed tenant.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… (SUPERUSER, THROWAWAY db) bun run test:m1:tenant-host:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { createCachingTenantHostResolver, createTenantHostGuard } from "../src/bootstrap/tenant-host";
import { createDbTenantHostResolver } from "../src/bootstrap/tenant-host-resolver-db";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const BASE = "chartwarden.com";

describe.skipIf(!DB_URL)("tenant-host guard — LIVE Postgres", () => {
  let admin: Client;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let sessionOrg: string | undefined;
  const orgs: Record<string, string> = {};

  const get = (host: string, url = "/api/v1/ping") => app.inject({ method: "GET", url, headers: { host } });
  const codeOf = (body: { error?: { code?: string }; code?: string }) => body.error?.code ?? body.code;

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
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [key, slug, status] of [
      ["sunrise", "sunrise", "active"],
      ["eagle", "eagle", "active"],
      ["paused", "paused", "suspended"],
      ["gone", "gone", "closed"],
    ] as const) {
      orgs[key] = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name,status) VALUES ($1,'L','D',$2) RETURNING id",
          [slug, status],
        )
      ).rows[0].id as string;
    }
    // Rename through the database, so the alias comes from the trigger and not from the test.
    await admin.query("UPDATE organization SET slug='sunrise-hospice' WHERE id=$1", [orgs.sunrise]);

    const { createDbClient } = await import("@chartwarden/db");
    const handle = createDbClient({ connectionString: await appRoleConnectionString(admin, DB_URL as string) });
    closeDb = async () => {
      await (handle as { close?: () => Promise<void> }).close?.();
    };

    app = Fastify();
    applyErrorHandler(app);
    app.decorateRequest("context", null as never);
    app.addHook("onRequest", async (request) => {
      (request as { context: unknown }).context = { attributes: {}, organizationId: sessionOrg };
    });
    const guard = createTenantHostGuard({
      baseDomain: BASE,
      resolver: createCachingTenantHostResolver(createDbTenantHostResolver(handle.db as never)),
    });
    if (guard) app.addHook("onRequest", guard);
    app.get("/api/v1/ping", async () => ({ ok: true }));
  }, 600_000);

  afterAll(async () => {
    await closeDb?.();
    await admin?.end();
  });

  it("serves a known tenant host and, with an org-bound session of the same org, passes", async () => {
    sessionOrg = undefined;
    expect((await get("sunrise-hospice.chartwarden.com")).statusCode).toBe(200);
    sessionOrg = orgs.sunrise;
    expect((await get("sunrise-hospice.chartwarden.com")).statusCode).toBe(200);
  });

  it("refuses a session bound to another org on this host: 403 TENANT_HOST_MISMATCH", async () => {
    sessionOrg = orgs.sunrise;
    const res = await get("eagle.chartwarden.com");
    expect([res.statusCode, codeOf(res.json())]).toEqual([403, "TENANT_HOST_MISMATCH"]);
  });

  it("redirects a retired alias to the current slug (308), keeping path and query", async () => {
    sessionOrg = undefined;
    const res = await get("sunrise.chartwarden.com", "/api/v1/ping?a=1");
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe("https://sunrise-hospice.chartwarden.com/api/v1/ping?a=1");
  });

  it("answers 404 for an unprovisioned host and refuses suspended and closed tenants", async () => {
    sessionOrg = undefined;
    const unknown = await get("nobody.chartwarden.com");
    expect([unknown.statusCode, codeOf(unknown.json())]).toEqual([404, "TENANT_HOST_UNKNOWN"]);
    const paused = await get("paused.chartwarden.com");
    expect([paused.statusCode, codeOf(paused.json())]).toEqual([403, "TENANT_SUSPENDED"]);
    const gone = await get("gone.chartwarden.com");
    expect([gone.statusCode, codeOf(gone.json())]).toEqual([410, "TENANT_CLOSED"]);
  });
});
